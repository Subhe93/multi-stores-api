import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StoreType } from '@prisma/client';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PromotionsService } from '../promotions/promotions.service';
import { ShippingService } from '../shipping/shipping.service';
import { MailService } from '../mail/mail.service';
import { TaxService } from '../taxes/tax.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { B2bService } from '../b2b/b2b.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import type { CreateOrderDto } from './dto/order.dto';
import { PersonalizationCoreService } from '../../common/personalization/personalization-core.service';
import { CustomerUploadsService } from '../customer-uploads/customer-uploads.service';

// M4.0 personalization in quote / order create: field rules are enforced
// with coded errors, the snapshot rows are created nested inside
// order.create (no createMany after the insert), the field type decides
// value vs file_url, and uploads are attached in the same transaction.

const STORE_ID = 's1';
const F_NAME = '11111111-1111-4111-8111-111111111111';
const F_NAME2 = '22222222-2222-4222-8222-222222222222';
const F_SITE = '33333333-3333-4333-8333-333333333333';
const F_PHOTOS = '44444444-4444-4444-8444-444444444444';
const F_SIZE = '55555555-5555-4555-8555-555555555555';
const UPLOAD_ID = '0b8f2c1e-1111-4222-8333-944445555666';
const PREVIEW = `/uploads/customer-previews/${UPLOAD_ID}.webp`;

const FIELDS = [
  {
    id: F_NAME,
    product_id: 'p1',
    name: 'name_1',
    type: 'TEXT',
    is_required: true,
    options: null,
    validation_rules: { max_length: 11, allowed_chars: 'A-Za-z❤' },
    linked_validation: null,
    sort_order: 0,
    translations: [
      { locale: 'sv', label: 'Första namnet' },
      { locale: 'en', label: 'First name' },
    ],
  },
  {
    id: F_NAME2,
    product_id: 'p1',
    name: 'name_2',
    type: 'TEXT',
    is_required: false,
    options: null,
    validation_rules: null,
    linked_validation: { type: 'equal_length', target_field_id: 'name_1' },
    sort_order: 1,
    translations: [{ locale: 'sv', label: 'Andra namnet' }],
  },
  {
    id: F_SITE,
    product_id: 'p1',
    name: 'site',
    type: 'TEXT',
    is_required: false,
    options: null,
    validation_rules: null,
    linked_validation: null,
    sort_order: 2,
    translations: [],
  },
  {
    id: F_PHOTOS,
    product_id: 'p1',
    name: 'photos',
    type: 'MULTI_IMAGE',
    is_required: false,
    options: null,
    validation_rules: null,
    linked_validation: null,
    sort_order: 3,
    translations: [{ locale: 'en', label: 'Photos' }],
  },
  {
    id: F_SIZE,
    product_id: 'p1',
    name: 'size',
    type: 'SELECT',
    is_required: false,
    options: ['S', 'M'],
    validation_rules: null,
    linked_validation: null,
    sort_order: 4,
    translations: [
      { locale: 'sv', label: 'Storlek', option_labels: { S: 'Liten' } },
      { locale: 'en', label: 'Size', option_labels: { S: 'Small' } },
    ],
  },
];

function makePrisma(fields: unknown[] = FIELDS) {
  const product = {
    id: 'p1',
    creator_id: 'c1',
    provider_id: null,
    status: 'PUBLISHED',
    base_price: 299,
    tax_class_id: null,
    tax_exempt: false,
    track_inventory: false,
    stock_quantity: null,
  };
  const prisma = {
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: STORE_ID,
          slug: 'namez',
          store_type: StoreType.INDEPENDENT,
          creator_id: 'c1',
          currency: 'SEK',
          cod_enabled: true,
          is_active: true,
          language_config: { primary_locale: 'sv' },
          creator: {
            kustom_enabled: false,
            kustom_merchant_id: null,
            kustom_shared_secret: null,
          },
        }),
      ),
    },
    product: { findUnique: jest.fn(() => Promise.resolve(product)) },
    productVariant: { findUnique: jest.fn(() => Promise.resolve(null)) },
    productMarketPrice: { findMany: jest.fn(() => Promise.resolve([])) },
    platformConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve({ default_currency: 'EUR', commission_value: 15 }),
      ),
    },
    customer: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'cust1', user_id: 'u1' }),
      ),
    },
    cart: {
      findUnique: jest.fn((): Promise<unknown> => Promise.resolve(null)),
    },
    cartItem: { deleteMany: jest.fn(() => Promise.resolve({ count: 1 })) },
    address: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'a1',
          country_code: 'SE',
          state: null,
          postal_code: '11123',
        }),
      ),
    },
    order: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'o1',
          ...data,
          items: [],
          timeline: [],
          address: {},
        }),
      ),
    },
    orderCustomFieldValue: { createMany: jest.fn() },
    orderCommission: { create: jest.fn(() => Promise.resolve({})) },
    productCustomField: { findMany: jest.fn(() => Promise.resolve(fields)) },
    customProduct: { findMany: jest.fn(() => Promise.resolve([])) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  );
  return prisma;
}

function build(
  opts: { fields?: unknown[]; uploads?: Map<string, unknown> } = {},
) {
  const prisma = makePrisma(opts.fields);
  const marketPricing = new MarketPricingService(
    prisma as unknown as PrismaService,
  );
  const shipping = {
    quoteForItems: jest.fn(() =>
      Promise.resolve({
        available: true,
        methods: [
          {
            id: 'std',
            name: 'Standard',
            type: 'STANDARD',
            cost: 49,
            estimated_days: { min: 2, max: 5 },
            free_shipping: false,
          },
        ],
      }),
    ),
  };
  const tax = {
    contextFor: jest.fn(() => Promise.resolve({ pricingMode: 'INCLUSIVE' })),
    loadTaxData: jest.fn(() => Promise.resolve({})),
    computeTaxes: jest.fn(
      (input: { lines: { amount: number }[]; shipping_cost: number }) => {
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
    ),
  };
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(false)),
    getSettings: jest.fn(() => Promise.resolve(null)),
  };
  const uploads = new CustomerUploadsService(
    prisma as unknown as PrismaService,
  );
  jest
    .spyOn(uploads, 'resolveForOrder')
    .mockResolvedValue((opts.uploads ?? new Map()) as never);
  const markAttached = jest.spyOn(uploads, 'markAttached').mockResolvedValue(1);
  const core = new PersonalizationCoreService(
    prisma as unknown as PrismaService,
    uploads,
  );
  const service = new OrdersService(
    prisma as unknown as PrismaService,
    { validateCoupon: jest.fn() } as unknown as PromotionsService,
    shipping as unknown as ShippingService,
    {
      dispatchOrderEmail: jest.fn(() => Promise.resolve()),
    } as unknown as MailService,
    tax as unknown as TaxService,
    {
      resolve: jest.fn(() => Promise.resolve(null)),
    } as unknown as MarketsContextService,
    marketPricing,
    { get: () => undefined } as unknown as ConfigService,
    new B2bService(storeApps as unknown as StoreAppsService),
    undefined,
    undefined,
    core,
    uploads,
  );
  return { service, prisma, markAttached, uploads };
}

const DTO = {
  address_id: 'a1',
  store_id: STORE_ID,
  payment_method: 'COD',
} as CreateOrderDto;

async function caught(p: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse() as Record<
      string,
      unknown
    >;
  }
  throw new Error('expected a BadRequestException');
}

type CreateArg = {
  data: { items: { create: Record<string, unknown>[] } };
};

function createdItems(prisma: ReturnType<typeof makePrisma>) {
  const arg = prisma.order.create.mock.calls[0][0] as unknown as CreateArg;
  return arg.data.items.create;
}

describe('OrdersService personalization (M4.0)', () => {
  const quote = (service: OrdersService, custom_fields: unknown) =>
    service.quoteLines(
      STORE_ID,
      [{ product_id: 'p1', quantity: 1, custom_fields }],
      { countryCode: 'SE', locale: 'sv' },
    );

  it('quote: a missing required field is a coded 400 with line_index and the localized label', async () => {
    const { service } = build();
    const body = await caught(quote(service, {}));
    expect(body).toMatchObject({
      code: 'CUSTOM_FIELD_REQUIRED',
      message: 'Required field "Första namnet" is missing',
      params: { label: 'Första namnet' },
      field_id: F_NAME,
      field_name: 'name_1',
      line_index: 0,
    });
  });

  it('quote: equal_length by legacy target_field_id (a name) is enforced', async () => {
    const { service } = build();
    const body = await caught(
      quote(service, { [F_NAME]: 'ANNA', [F_NAME2]: 'KARIN' }),
    );
    expect(body).toMatchObject({
      code: 'CUSTOM_FIELD_LENGTH_MISMATCH',
      params: { length: 4, target: 'name_1', label: 'Andra namnet' },
    });
  });

  it('quote: allowed_chars enforced; a heart with VS16 is accepted', async () => {
    const { service } = build();
    const bad = await caught(quote(service, { [F_NAME]: 'ANNA!' }));
    expect(bad.code).toBe('CUSTOM_FIELD_INVALID_CHARS');
    await expect(quote(service, { [F_NAME]: 'EVA❤️' })).resolves.toBeDefined();
  });

  it('create: values are nested in order.create with the snapshot; no createMany', async () => {
    const { service, prisma, markAttached } = build();
    await service.create('u1', { ...DTO, locale: 'sv' } as CreateOrderDto, {
      lines: [
        {
          product_id: 'p1',
          quantity: 1,
          custom_fields: {
            [F_SIZE]: 'S',
            [F_NAME]: ' ANNA ',
            [F_NAME2]: 'OLLE',
            [F_SITE]: 'http://my-site',
            'stale-field-id': 'x',
          },
        },
      ],
    });
    expect(prisma.orderCustomFieldValue.createMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(markAttached).not.toHaveBeenCalled();
    const rows = createdItems(prisma)[0].custom_field_values as {
      create: Record<string, unknown>[];
    };
    expect(rows.create).toEqual([
      {
        custom_field_id: F_NAME,
        value: 'ANNA',
        field_name: 'name_1',
        field_type: 'TEXT',
        sort_order: 0,
        field_label: { sv: 'Första namnet', en: 'First name' },
      },
      {
        custom_field_id: F_NAME2,
        value: 'OLLE',
        field_name: 'name_2',
        field_type: 'TEXT',
        sort_order: 1,
        field_label: { sv: 'Andra namnet' },
      },
      // Bug 5: text starting with http stays a value.
      {
        custom_field_id: F_SITE,
        value: 'http://my-site',
        field_name: 'site',
        field_type: 'TEXT',
        sort_order: 2,
      },
      {
        custom_field_id: F_SIZE,
        value: 'S',
        field_name: 'size',
        field_type: 'SELECT',
        sort_order: 4,
        field_label: { sv: 'Storlek', en: 'Size' },
        display_value: { sv: 'Liten', en: 'Small' },
      },
    ]);
  });

  it('create: MULTI_IMAGE gives one row per file; preview uploads are attached in the order transaction', async () => {
    const legacy = '/uploads/custom-fields/a.webp';
    const { service, prisma, markAttached } = build({
      uploads: new Map([[PREVIEW, { id: UPLOAD_ID, purged: false }]]),
    });
    await service.create('u1', DTO, {
      lines: [
        {
          product_id: 'p1',
          quantity: 1,
          custom_fields: { [F_NAME]: 'ANNA', [F_PHOTOS]: [PREVIEW, legacy] },
        },
      ],
    });
    const rows = (
      createdItems(prisma)[0].custom_field_values as {
        create: Record<string, unknown>[];
      }
    ).create.filter((r) => r.custom_field_id === F_PHOTOS);
    expect(rows).toEqual([
      expect.objectContaining({ file_url: PREVIEW, upload_id: UPLOAD_ID }),
      expect.objectContaining({ file_url: legacy }),
    ]);
    expect(rows[1]).not.toHaveProperty('upload_id');
    expect(rows[0]).not.toHaveProperty('value');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(markAttached).toHaveBeenCalledWith([UPLOAD_ID], STORE_ID, prisma);
  });

  it('create: a preview URL without a live upload is CUSTOMER_UPLOAD_EXPIRED and nothing is inserted', async () => {
    const { service, prisma } = build({
      uploads: new Map([[PREVIEW, { id: UPLOAD_ID, purged: true }]]),
    });
    const body = await caught(
      service.create('u1', DTO, {
        lines: [
          {
            product_id: 'p1',
            quantity: 1,
            custom_fields: { [F_NAME]: 'ANNA', [F_PHOTOS]: [PREVIEW] },
          },
        ],
      }),
    );
    expect(body).toMatchObject({
      code: 'CUSTOMER_UPLOAD_EXPIRED',
      field_id: F_PHOTOS,
      line_index: 0,
    });
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('logged-in quote over the cart: errors carry line_id (cart row) and line_index', async () => {
    const { service, prisma } = build();
    (prisma.customer.findUnique as jest.Mock).mockResolvedValueOnce({
      cart: {
        items: [
          {
            id: 'ci7',
            product_id: 'p1',
            variant_id: null,
            custom_product_id: null,
            bundle_offer_id: null,
            quantity: 1,
            custom_fields: {},
          },
        ],
      },
    });
    const body = await caught(
      service.quote('u1', { store_id: STORE_ID, country_code: 'SE' }),
    );
    expect(body).toMatchObject({
      code: 'CUSTOM_FIELD_REQUIRED',
      line_id: 'ci7',
      line_index: 0,
    });
  });

  it('quote: a purged or foreign upload is CUSTOMER_UPLOAD_EXPIRED (same check as create)', async () => {
    const { service, uploads } = build({
      uploads: new Map([[PREVIEW, { id: UPLOAD_ID, purged: true }]]),
    });
    const body = await caught(
      quote(service, { [F_NAME]: 'ANNA', [F_PHOTOS]: [PREVIEW] }),
    );
    expect(body).toMatchObject({
      code: 'CUSTOMER_UPLOAD_EXPIRED',
      field_id: F_PHOTOS,
      line_index: 0,
    });
    // Resolution is scoped to the order's store (IDOR guard).
    expect(jest.spyOn(uploads, 'resolveForOrder')).toHaveBeenCalledWith(
      [PREVIEW],
      STORE_ID,
    );
  });

  it('create: a coded error from markAttached (lost race) keeps its code', async () => {
    const { service, markAttached } = build({
      uploads: new Map([[PREVIEW, { id: UPLOAD_ID, purged: false }]]),
    });
    markAttached.mockRejectedValueOnce(
      new BadRequestException({ code: 'CUSTOMER_UPLOAD_EXPIRED' }),
    );
    const body = await caught(
      service.create('u1', DTO, {
        lines: [
          {
            product_id: 'p1',
            quantity: 1,
            custom_fields: { [F_NAME]: 'ANNA', [F_PHOTOS]: [PREVIEW] },
          },
        ],
      }),
    );
    expect(body).toMatchObject({ code: 'CUSTOMER_UPLOAD_EXPIRED' });
  });

  it('create from the cart: errors carry line_id; item_customizations is validated too', async () => {
    const { service, prisma } = build();
    prisma.cart.findUnique.mockResolvedValue({
      id: 'cart1',
      items: [
        {
          id: 'ci1',
          product_id: 'p1',
          variant_id: null,
          custom_product_id: null,
          bundle_offer_id: null,
          quantity: 1,
          custom_fields: { [F_NAME]: 'ANNA' },
        },
      ],
    });
    const body = await caught(
      service.create('u1', {
        ...DTO,
        item_customizations: {
          ci1: {
            custom_field_values: [
              { custom_field_id: F_NAME, value: 'TOOLONGNAME12' },
            ],
          },
        },
      } as CreateOrderDto),
    );
    expect(body).toMatchObject({
      code: 'CUSTOM_FIELD_TOO_LONG',
      params: { max: 11 },
      line_id: 'ci1',
    });
  });

  it('G0: a product without fields creates exactly the pre-M4.0 item rows', async () => {
    const { service, prisma } = build({ fields: [] });
    await service.create('u1', DTO, {
      lines: [{ product_id: 'p1', quantity: 2, custom_fields: {} }],
    });
    const item = createdItems(prisma)[0];
    expect(item).not.toHaveProperty('custom_field_values');
    expect(Object.keys(item).sort()).toEqual(
      [
        'bundle_offer_id',
        'custom_product_id',
        'customer_design_url',
        'design_notes',
        'fulfiller_id',
        'fulfiller_type',
        'original_unit_price',
        'product_id',
        'provider_base_amount',
        'quantity',
        'tax_amount',
        'tax_class_key',
        'tax_rate_bp',
        'total_price',
        'unit_price',
        'variant_id',
      ].sort(),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.customProduct.findMany).not.toHaveBeenCalled();
    expect(prisma.productCustomField.findMany).toHaveBeenCalledTimes(1);
  });
});
