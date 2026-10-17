import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient, UserRole } from '@prisma/client';
import { CartService } from '../src/modules/cart/cart.service';
import { OrdersService } from '../src/modules/orders/orders.service';
import type { CreateOrderDto } from '../src/modules/orders/dto/order.dto';
import { CustomFieldsService } from '../src/modules/custom-fields/custom-fields.service';
import { CustomerUploadsService } from '../src/modules/customer-uploads/customer-uploads.service';
import { PersonalizationCoreService } from '../src/common/personalization/personalization-core.service';
import { PrivateFileStorage } from '../src/common/storage/private-file-storage';
import { MarketPricingService } from '../src/modules/markets/market-pricing.service';
import { B2bService } from '../src/modules/b2b/b2b.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { StoreAppsService } from '../src/modules/store-apps/store-apps.service';
import type { TaxService } from '../src/modules/taxes/tax.service';
import type { ShippingService } from '../src/modules/shipping/shipping.service';
import type { MailService } from '../src/modules/mail/mail.service';
import type { MarketsContextService } from '../src/modules/markets/markets-context.service';
import type { PromotionsService } from '../src/modules/promotions/promotions.service';

// M5 A1: the personalization order path against a real PostgreSQL (the
// snapshot columns, the SET NULL on field delete, the backfill SQL and the
// raw-SQL claim of `claimAttached` cannot be proven with mocks). Opt-in:
// set PERSONALIZATION_E2E_DATABASE_URL to a throwaway schema, e.g.
//   PERSONALIZATION_E2E_DATABASE_URL="postgresql://postgres@localhost:5433/multi_stores?schema=personalization_e2e"
//   npm run test:e2e -- personalization
// Each run creates its own fresh schema (`<schema>_<timestamp>`) with
// `prisma db push`, creates its own store / product / customer, deletes them
// again and drops the schema afterwards (nothing existing is touched).

const BASE_URL = process.env.PERSONALIZATION_E2E_DATABASE_URL;
const d = BASE_URL ? describe : describe.skip;

function runUrl(base: string): { url: string; schema: string } {
  const u = new URL(base);
  const schema = `${u.searchParams.get('schema') || 'personalization_e2e'}_${Date.now()}`;
  u.searchParams.set('schema', schema);
  return { url: u.toString(), schema };
}

const ROOT = path.join(__dirname, '..');
const BACKFILL_SQL = 'prisma/sql/m4-0-backfill-order-field-snapshot.sql';
const DAY_MS = 24 * 60 * 60 * 1000;
const HEART = '❤';

/** The Prisma-side doubles the order path needs (same shapes as the unit specs). */
function doubles() {
  const tax = {
    contextFor: () => Promise.resolve({ pricingMode: 'INCLUSIVE' }),
    loadTaxData: () => Promise.resolve({}),
    computeTaxes: (input: {
      lines: { amount: number }[];
      shipping_cost: number;
    }) => {
      const total =
        input.lines.reduce((s, l) => s + l.amount, 0) + input.shipping_cost;
      return {
        items: input.lines.map(() => ({
          tax_rate_bp: 2500,
          tax_amount: 0,
          tax_class_key: 'standard',
        })),
        headline_rate_bp: 2500,
        tax_total: 0,
        tax_lines: [],
        tax_pricing_mode: 'INCLUSIVE',
        tax_basis_country: 'SE',
        shipping_tax_amount: 0,
        shipping_tax_rate_bp: 2500,
        total,
      };
    },
  };
  const shipping = {
    quoteForItems: () =>
      Promise.resolve({
        available: true,
        methods: [
          {
            id: 'std',
            name: 'Standard',
            type: 'DELIVERY',
            cost: 49,
            estimated_days: { min: 2, max: 5 },
            free_shipping: false,
          },
        ],
      }),
  };
  const storeApps = {
    isEnabled: () => Promise.resolve(false),
    getSettings: () => Promise.resolve(null),
  };
  const markets = { resolve: () => Promise.resolve(null) };
  const mail = { dispatchOrderEmail: () => Promise.resolve() };
  const promotions = { validateCoupon: () => Promise.resolve(null) };
  const config = { get: () => undefined };
  return { tax, shipping, storeApps, markets, mail, promotions, config };
}

async function caught(p: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    return (err as HttpException).getResponse() as Record<string, unknown>;
  }
  throw new Error('expected an HttpException');
}

d('personalization order path (real database)', () => {
  const run = BASE_URL ? runUrl(BASE_URL) : { url: '', schema: '' };
  const env = { ...process.env, DATABASE_URL: run.url };
  let prisma: PrismaClient;
  let storageRoot: string;
  let storage: PrivateFileStorage;
  let uploads: CustomerUploadsService;
  let cart: CartService;
  let orders: OrdersService;
  let customFields: CustomFieldsService;

  // Rows created by this run (deleted again in afterAll).
  let creatorUserId: string;
  let creatorId: string;
  let storeId: string;
  let customerUserId: string;
  let customerId: string;
  let addressId: string;
  let categoryId: string;
  let productId: string;
  const field: Record<string, string> = {};
  let orderId: string;

  beforeAll(async () => {
    execSync('npx prisma db push --skip-generate', {
      cwd: ROOT,
      env,
      stdio: 'pipe',
    });
    prisma = new PrismaClient({ datasourceUrl: run.url });
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'w1a-e2e-'));
    storage = new PrivateFileStorage(storageRoot);

    const stamp = Date.now();
    await prisma.platformConfig.create({ data: {} });
    const creatorUser = await prisma.user.create({
      data: {
        email: `creator-${stamp}@personalization.e2e`,
        password_hash: 'x',
        role: 'CREATOR',
      },
    });
    creatorUserId = creatorUser.id;
    const creator = await prisma.creator.create({
      data: { user_id: creatorUser.id, display_name: 'E2E creator' },
    });
    creatorId = creator.id;
    const store = await prisma.store.create({
      data: {
        creator_id: creator.id,
        slug: `personalization-e2e-${stamp}`,
        name: 'Personalization E2E',
        store_type: 'INDEPENDENT',
        currency: 'SEK',
        cod_enabled: true,
        language_config: {
          create: { primary_locale: 'sv', secondary_locales: ['en'] },
        },
      },
    });
    storeId = store.id;
    const category = await prisma.category.create({
      data: { slug: `personalization-e2e-${stamp}` },
    });
    categoryId = category.id;
    const product = await prisma.product.create({
      data: {
        creator_id: creator.id,
        category_id: category.id,
        product_type: 'TRADITIONAL',
        base_price: 100,
        status: 'PUBLISHED',
      },
    });
    productId = product.id;

    const rules = { max_length: 11, allowed_chars: `A-Za-z${HEART}` };
    const mk = async (
      name: string,
      type: 'TEXT' | 'SELECT' | 'IMAGE',
      sort: number,
      extra: Record<string, unknown>,
      translations: Record<string, unknown>[],
    ) => {
      const row = await prisma.productCustomField.create({
        data: {
          product_id: product.id,
          name,
          type,
          sort_order: sort,
          ...extra,
          translations: { create: translations },
        } as never,
      });
      field[name] = row.id;
    };
    await mk(
      'name_1',
      'TEXT',
      0,
      { is_required: true, validation_rules: rules },
      [
        { locale: 'sv', label: 'Första namnet' },
        { locale: 'en', label: 'First name' },
      ],
    );
    await mk(
      'name_2',
      'TEXT',
      1,
      {
        is_required: true,
        validation_rules: rules,
        linked_validation: {
          type: 'equal_length',
          target: 'name_1',
          fill_char: HEART,
        },
      },
      [
        { locale: 'sv', label: 'Andra namnet' },
        { locale: 'en', label: 'Second name' },
      ],
    );
    await mk('size', 'SELECT', 2, { options: ['S', 'M'] }, [
      { locale: 'sv', label: 'Storlek', option_labels: { S: 'Liten' } },
      { locale: 'en', label: 'Size', option_labels: { S: 'Small' } },
    ]);
    await mk('note', 'TEXT', 3, {}, [{ locale: 'sv', label: 'Anteckning' }]);
    await mk('photo', 'IMAGE', 4, {}, [{ locale: 'sv', label: 'Foto' }]);

    const customerUser = await prisma.user.create({
      data: {
        email: `customer-${stamp}@personalization.e2e`,
        password_hash: 'x',
        role: 'CUSTOMER',
      },
    });
    customerUserId = customerUser.id;
    const customer = await prisma.customer.create({
      data: { user_id: customerUser.id, first_name: 'Anna', last_name: 'S' },
    });
    customerId = customer.id;
    const address = await prisma.address.create({
      data: {
        customer_id: customer.id,
        full_name: 'Anna S',
        line1: 'Gatan 1',
        city: 'Stockholm',
        postal_code: '11122',
        country_code: 'SE',
      },
    });
    addressId = address.id;

    const p = prisma as unknown as PrismaService;
    const dbl = doubles();
    uploads = new CustomerUploadsService(p, undefined, storage);
    const core = new PersonalizationCoreService(p, uploads);
    const marketPricing = new MarketPricingService(p);
    const b2b = new B2bService(dbl.storeApps as unknown as StoreAppsService);
    cart = new CartService(
      p,
      dbl.tax as unknown as TaxService,
      dbl.markets as unknown as MarketsContextService,
      marketPricing,
      b2b,
      core,
    );
    orders = new OrdersService(
      p,
      dbl.promotions as unknown as PromotionsService,
      dbl.shipping as unknown as ShippingService,
      dbl.mail as unknown as MailService,
      dbl.tax as unknown as TaxService,
      dbl.markets as unknown as MarketsContextService,
      marketPricing,
      dbl.config as unknown as ConfigService,
      b2b,
      core,
      uploads,
    );
    customFields = new CustomFieldsService(
      p,
      dbl.storeApps as unknown as StoreAppsService,
    );
  }, 120_000);

  afterAll(async () => {
    if (!prisma) return;
    // Own rows first (the schema is dropped anyway; this is the contract).
    try {
      await prisma.orderCommission.deleteMany({});
      await prisma.order.deleteMany({ where: { customer_id: customerId } });
      await prisma.customerUpload.deleteMany({ where: { store_id: storeId } });
      await prisma.product.deleteMany({ where: { creator_id: creatorId } });
      await prisma.category.deleteMany({ where: { id: categoryId } });
      await prisma.user.deleteMany({
        where: { id: { in: [creatorUserId, customerUserId] } },
      });
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP SCHEMA IF EXISTS "${run.schema}" CASCADE`,
      );
      await prisma.$disconnect();
      await fs.rm(storageRoot, { recursive: true, force: true });
    }
  }, 60_000);

  const quote = (custom_fields: Record<string, unknown>) =>
    orders.quoteLines(
      storeId,
      [{ product_id: productId, quantity: 1, custom_fields }],
      { countryCode: 'SE', locale: 'sv' },
    );

  it('quote: an unequal pair is CUSTOM_FIELD_LENGTH_MISMATCH; the heart-filled pair prices', async () => {
    const body = await caught(
      quote({ [field.name_1]: 'ANNA', [field.name_2]: 'KARIN' }),
    );
    expect(body).toMatchObject({
      code: 'CUSTOM_FIELD_LENGTH_MISMATCH',
      field_id: field.name_2,
      field_name: 'name_2',
      line_index: 0,
      params: { length: 4, target: 'name_1' },
    });
    const ok = await quote({
      [field.name_1]: 'ANNA',
      [field.name_2]: `KA${HEART}${HEART}`,
      [field.size]: 'S',
    });
    expect(ok.items).toHaveLength(1);
    expect(ok.items[0].unit_price).toBe(100);
  });

  it('cart -> order: snapshot rows carry name, type, labels and option labels; a stale field id is dropped', async () => {
    await cart.addItem(
      customerUserId,
      {
        product_id: productId,
        quantity: 1,
        custom_fields: {
          [field.name_1]: 'ANNA',
          [field.name_2]: `KA${HEART}${HEART}`,
          [field.size]: 'S',
          [field.note]: 'wrap it',
        },
      },
      'sv',
    );
    // The field behind a stored cart value disappears before checkout: the
    // id is stale, the line still orders (the value is simply dropped).
    const staleId = field.note;
    await prisma.productCustomField.delete({ where: { id: staleId } });

    const order = await orders.create(customerUserId, {
      address_id: addressId,
      store_id: storeId,
      payment_method: 'COD',
      locale: 'sv',
    } as CreateOrderDto);
    orderId = order.id;

    const rows = await prisma.orderCustomFieldValue.findMany({
      where: { order_item: { order_id: orderId } },
      orderBy: { sort_order: 'asc' },
    });
    expect(rows.map((r) => r.custom_field_id)).toEqual([
      field.name_1,
      field.name_2,
      field.size,
    ]);
    expect(rows.map((r) => r.custom_field_id)).not.toContain(staleId);
    expect(rows[0]).toMatchObject({
      field_name: 'name_1',
      field_type: 'TEXT',
      sort_order: 0,
      value: 'ANNA',
      field_label: { sv: 'Första namnet', en: 'First name' },
    });
    expect(rows[1]).toMatchObject({
      field_name: 'name_2',
      field_type: 'TEXT',
      sort_order: 1,
      value: `KA${HEART}${HEART}`,
      field_label: { sv: 'Andra namnet', en: 'Second name' },
    });
    expect(rows[2]).toMatchObject({
      field_name: 'size',
      field_type: 'SELECT',
      value: 'S',
      display_value: { sv: 'Liten', en: 'Small' },
    });
    // The cart was consumed.
    const left = await prisma.cartItem.count({
      where: { cart: { customer_id: customerId } },
    });
    expect(left).toBe(0);
  });

  it('the M4.0 backfill SQL fills emptied snapshot columns and is idempotent when replayed', async () => {
    const [first, , third] = await prisma.orderCustomFieldValue.findMany({
      where: { order_item: { order_id: orderId } },
      orderBy: { sort_order: 'asc' },
    });
    await prisma.orderCustomFieldValue.update({
      where: { id: first.id },
      data: {
        field_name: null,
        field_type: null,
        sort_order: null,
        field_label: Prisma.DbNull,
      },
    });
    await prisma.orderCustomFieldValue.update({
      where: { id: third.id },
      data: { display_value: Prisma.DbNull },
    });
    const replay = () =>
      execSync(
        `npx prisma db execute --file ${BACKFILL_SQL} --schema prisma/schema.prisma`,
        { cwd: ROOT, env, stdio: 'pipe' },
      );
    const snapshot = () =>
      prisma.orderCustomFieldValue.findMany({
        where: { order_item: { order_id: orderId } },
        orderBy: { id: 'asc' },
      });

    replay();
    const once = await snapshot();
    expect(once.find((r) => r.id === first.id)).toMatchObject({
      field_name: 'name_1',
      field_type: 'TEXT',
      sort_order: 0,
      field_label: { sv: 'Första namnet', en: 'First name' },
    });
    expect(once.find((r) => r.id === third.id)).toMatchObject({
      display_value: { sv: 'Liten', en: 'Small' },
    });

    replay();
    const twice = await snapshot();
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  }, 60_000);

  it('deleting a field keeps the order snapshot (SET NULL); a linked target is protected (409)', async () => {
    // name_2 links to name_1 by name: the target cannot go first.
    const body = await caught(
      customFields.delete(field.name_1, creatorUserId, UserRole.CREATOR),
    );
    expect(body).toMatchObject({
      code: 'PERSONALIZATION_FIELD_IN_USE',
      params: { fields: ['name_2'] },
    });
    await customFields.delete(field.name_2, creatorUserId, UserRole.CREATOR);
    const row = await prisma.orderCustomFieldValue.findFirst({
      where: { order_item: { order_id: orderId }, field_name: 'name_2' },
    });
    expect(row).toMatchObject({
      custom_field_id: null,
      field_name: 'name_2',
      field_type: 'TEXT',
      value: `KA${HEART}${HEART}`,
      field_label: { sv: 'Andra namnet', en: 'Second name' },
    });
  });

  it('claimAttached (raw SQL): an expired upload of a closed order is purged, one of an open order is skipped', async () => {
    const now = new Date();
    const attachedAt = new Date(now.getTime() - 100 * DAY_MS);
    const mkUpload = async (key: string) => {
      await storage.write(key, Buffer.from('pdf'));
      const row = await prisma.customerUpload.create({
        data: {
          store_id: storeId,
          original_key: key,
          original_name: `${path.basename(key)}`,
          mime: 'application/pdf',
          bytes: 3,
          sha256: 'a'.repeat(64),
          preview_url: '/uploads/customer-previews/pending.webp',
          attached_at: attachedAt,
        },
      });
      return row.id;
    };
    // Keys follow the private storage namespace rule (`customer-uploads/<yyyy>/<mm>/<uuid>.<ext>`).
    const closedKey = `customer-uploads/2026/10/${randomUUID()}.pdf`;
    const openKey = `customer-uploads/2026/10/${randomUUID()}.pdf`;
    const closedUpload = await mkUpload(closedKey);
    const openUpload = await mkUpload(openKey);

    // The order placed above is closed (DELIVERED) and references the first
    // upload; a second, still open (PENDING) order references the other.
    await prisma.order.update({
      where: { id: orderId },
      data: { status: 'DELIVERED' },
    });
    const closedItem = await prisma.orderItem.findFirstOrThrow({
      where: { order_id: orderId },
    });
    await prisma.orderCustomFieldValue.create({
      data: {
        order_item_id: closedItem.id,
        custom_field_id: field.photo,
        file_url: '/uploads/customer-previews/pending.webp',
        field_name: 'photo',
        field_type: 'IMAGE',
        sort_order: 4,
        upload_id: closedUpload,
      },
    });
    await prisma.order.create({
      data: {
        order_number: `E2E-${Date.now()}`,
        customer_id: customerId,
        address_id: addressId,
        store_id: storeId,
        status: 'PENDING',
        subtotal: 100,
        total: 149,
        currency: 'SEK',
        items: {
          create: {
            product_id: productId,
            quantity: 1,
            unit_price: 100,
            total_price: 100,
            fulfiller_type: 'CREATOR',
            fulfiller_id: creatorId,
            custom_field_values: {
              create: {
                custom_field_id: field.photo,
                file_url: '/uploads/customer-previews/pending.webp',
                field_name: 'photo',
                field_type: 'IMAGE',
                sort_order: 4,
                upload_id: openUpload,
              },
            },
          },
        },
      },
    });

    uploads.registerRetentionPolicy({
      retentionDays: () => Promise.resolve(30),
    });
    const result = await uploads.runRetention(now);
    expect(result).toMatchObject({
      purgedAttached: 1,
      skippedOpenOrders: 1,
      errors: 0,
    });
    const closed = await prisma.customerUpload.findUniqueOrThrow({
      where: { id: closedUpload },
    });
    const open = await prisma.customerUpload.findUniqueOrThrow({
      where: { id: openUpload },
    });
    expect(closed.purged_at).not.toBeNull();
    expect(open.purged_at).toBeNull();
    expect(await storage.exists(closedKey)).toBe(false);
    expect(await storage.exists(openKey)).toBe(true);
    // The claimed row is already purged: a replay claims nothing more.
    const again = await uploads.runRetention(now);
    expect(again).toMatchObject({ purgedAttached: 0, skippedOpenOrders: 1 });
  });

  it('a stale field id sent at quote time is ignored (the known fields still price)', async () => {
    // name_2 is gone (deleted above): name_1 alone satisfies the product;
    // the unknown key is dropped, never a crash or a 400.
    const ok = await quote({
      [field.name_1]: 'ANNA',
      [field.name_2]: 'stale',
      'not-a-field': 'x',
    });
    expect(ok.items).toHaveLength(1);
  });
});
