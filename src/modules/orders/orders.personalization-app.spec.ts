import { BadRequestException, HttpException } from '@nestjs/common';
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
import type { MarketContext } from '../markets/market-context';
import { B2bService } from '../b2b/b2b.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import type { CreateOrderDto } from './dto/order.dto';
import { PersonalizationCoreService } from '../../common/personalization/personalization-core.service';
import { CustomerUploadsService } from '../customer-uploads/customer-uploads.service';
import { buildKustomOrderLines } from '../payments/kustom/kustom.mapper';
import {
  C_COLOR,
  C_NAME,
  F_NAME,
  F_REP,
  OPTION_CONFIG,
  PRODUCT_ID,
  VARIANT,
  appFields,
  validValues,
} from '../personalization/__fixtures__/app-fields';
import { buildPersonalizationService } from '../personalization/__fixtures__/personalization-service.factory';

// M4.1 quote / order create (C19/C28/C29, D4/D11): app lines are evaluated
// in priceLine, the per-unit delta is added after the market price and
// before the bundle, the quote (Kustom) equals the order, and the snapshot
// rows carry the group / source / price / meta columns. App off: the M4.0
// rows and prices exactly.

const STORE_ID = 's1';

const MARKET: MarketContext = {
  id: 'm-eu',
  key: 'eu',
  name: 'EU',
  countries: ['DE'],
  defaultLocale: 'de',
  locales: [],
  currency: 'EUR',
  storeCurrency: 'SEK',
  rate: 0.1,
  priceRule: { mode: 'convert', source: 'manual', rate: 0.1 },
  isDefault: false,
  noindex: false,
  status: 'LIVE',
  primaryHostname: null,
  hostnames: [],
};

function build(
  opts: {
    appOn?: boolean;
    market?: MarketContext | null;
    bundle?: boolean;
    withService?: boolean;
  } = {},
) {
  const product = {
    id: PRODUCT_ID,
    creator_id: 'c1',
    provider_id: null,
    status: 'PUBLISHED',
    base_price: 299,
    tax_class_id: null,
    tax_exempt: false,
    track_inventory: false,
    stock_quantity: null,
    variant_option_config: OPTION_CONFIG,
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
    productVariant: {
      findUnique: jest.fn(() => Promise.resolve({ ...VARIANT, product })),
      findMany: jest.fn(() =>
        Promise.resolve([
          VARIANT,
          {
            ...VARIANT,
            id: 'v4',
            options: { 'Välj antal': '1 produkt', Färg: 'Blå' },
          },
        ]),
      ),
    },
    productMarketPrice: { findMany: jest.fn(() => Promise.resolve([])) },
    bundleOffer: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          opts.bundle
            ? {
                id: 'b1',
                quantity: 2,
                discount_type: 'PERCENTAGE',
                discount_value: 10,
                bundle: { status: 'ACTIVE', creator_id: 'c1' },
              }
            : null,
        ),
      ),
    },
    platformConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve({ default_currency: 'SEK', commission_value: 15 }),
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
      // Abandoned-payment sweep of a cart checkout: nothing to release.
      findMany: jest.fn(() => Promise.resolve([])),
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
    orderCommission: { create: jest.fn(() => Promise.resolve({})) },
    productCustomField: {
      findMany: jest.fn(() => Promise.resolve(appFields())),
    },
    customProduct: { findMany: jest.fn(() => Promise.resolve([])) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  );
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
    isEnabled: jest.fn((_s: string, key: string) =>
      Promise.resolve(key === 'personalization' ? (opts.appOn ?? true) : false),
    ),
    enabledOrUnknown: jest.fn((_s: string, key: string) =>
      Promise.resolve(key === 'personalization' ? (opts.appOn ?? true) : false),
    ),
    getSettings: jest.fn(() => Promise.resolve(null)),
  };
  const uploads = new CustomerUploadsService(
    prisma as unknown as PrismaService,
  );
  jest.spyOn(uploads, 'resolveForOrder').mockResolvedValue(new Map());
  const core = new PersonalizationCoreService(
    prisma as unknown as PrismaService,
    uploads,
  );
  const personalization = buildPersonalizationService({
    prisma,
    storeApps,
    core,
    marketPricing,
  });
  const evaluate = jest.spyOn(personalization, 'evaluateLine');
  const service = new OrdersService(
    prisma as unknown as PrismaService,
    { validateCoupon: jest.fn() } as unknown as PromotionsService,
    shipping as unknown as ShippingService,
    {
      dispatchOrderEmail: jest.fn(() => Promise.resolve()),
    } as unknown as MailService,
    tax as unknown as TaxService,
    {
      resolve: jest.fn(() => Promise.resolve(opts.market ?? null)),
    } as unknown as MarketsContextService,
    marketPricing,
    { get: () => undefined } as unknown as ConfigService,
    new B2bService(storeApps as unknown as StoreAppsService),
    core,
    uploads,
    undefined,
    undefined,
    opts.withService === false ? undefined : personalization,
  );
  return { service, prisma, evaluate, storeApps };
}

const DTO = {
  address_id: 'a1',
  store_id: STORE_ID,
  payment_method: 'COD',
} as CreateOrderDto;

const line = (custom_fields: unknown, quantity = 1, extra = {}) => ({
  product_id: PRODUCT_ID,
  variant_id: VARIANT.id,
  quantity,
  custom_fields,
  ...extra,
});

type CreateArg = {
  data: Record<string, unknown> & {
    items: { create: Record<string, unknown>[] };
  };
};

function created(prisma: ReturnType<typeof build>['prisma']) {
  return (prisma.order.create.mock.calls[0][0] as unknown as CreateArg).data;
}

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

describe('OrdersService personalization app (M4.1)', () => {
  it('quote: the per-unit delta is part of the unit price; quantity multiplies it', async () => {
    const { service } = build();
    const quote = await service.quoteLines(STORE_ID, [line(validValues(), 3)], {
      countryCode: 'SE',
      locale: 'sv',
    });
    // 299 + 200 + repeater per_item 25 × 2 items = 549 per unit.
    expect(quote.items[0].unit_price).toBe(549);
    expect(quote.items[0].total_price).toBe(1647);
    expect(quote.subtotal).toBe(1647);
  });

  it('quote == order: same unit price, totals and Kustom order lines', async () => {
    const { service, prisma } = build();
    const lines = [line(validValues(), 2)];
    const quote = await service.quoteLines(STORE_ID, lines, {
      countryCode: 'SE',
      locale: 'sv',
    });
    await service.create('u1', { ...DTO, locale: 'sv' } as CreateOrderDto, {
      lines,
    });
    const data = created(prisma);
    const item = data.items.create[0];
    expect(Number(item.unit_price)).toBe(quote.items[0].unit_price);
    expect(Number(item.total_price)).toBe(quote.items[0].total_price);
    expect(Number(data.subtotal)).toBe(quote.subtotal);
    expect(Number(data.total)).toBe(quote.total);
    // Kustom prices the session from the quote and validates against the
    // order: both give the same order lines.
    const kustomOf = (src: {
      items: Record<string, unknown>[];
      shipping_cost: unknown;
      discount_amount: unknown;
      total: unknown;
    }) =>
      buildKustomOrderLines(
        {
          currency: 'SEK',
          shipping_cost: src.shipping_cost,
          discount_amount: src.discount_amount,
          total: src.total,
          items: src.items.map((i, k) => ({
            id: `l${k}`,
            quantity: Number(i.quantity),
            unit_price: i.unit_price,
            total_price: i.total_price,
            tax_rate_bp: Number(i.tax_rate_bp ?? 0),
            tax_amount: i.tax_amount ?? 0,
          })),
        },
        'sv',
      );
    expect(
      kustomOf({ ...data, items: data.items.create } as never).map((l) => [
        l.unit_price,
        l.total_amount,
      ]),
    ).toEqual(
      kustomOf(quote as never).map((l) => [l.unit_price, l.total_amount]),
    );
    expect(kustomOf(quote as never)[0].unit_price).toBe(54900);
  });

  it('bundle: the discount applies to the personalized unit price', async () => {
    const { service } = build({ bundle: true });
    const quote = await service.quoteLines(
      STORE_ID,
      [line(validValues(), 2, { bundle_offer_id: 'b1' })],
      { countryCode: 'SE', locale: 'sv' },
    );
    expect(quote.items[0].original_unit_price).toBe(549);
    expect(quote.items[0].unit_price).toBe(494.1); // 549 − 10 %
  });

  it('create: grouped snapshot rows (lead item, OPTION row, per-item price) and personalization_amount', async () => {
    const { service, prisma } = build();
    await service.create('u1', { ...DTO, locale: 'sv' } as CreateOrderDto, {
      lines: [line(validValues())],
    });
    const item = created(prisma).items.create[0];
    expect(item.personalization_amount).toBe(50);
    const rows = (
      item.custom_field_values as { create: Record<string, unknown>[] }
    ).create;
    expect(rows).toEqual([
      {
        custom_field_id: F_NAME,
        value: 'Kristofer',
        field_name: 'custom_name_v3',
        field_type: 'TEXT',
        field_label: { sv: 'Namn', en: 'Name' },
        sort_order: 0,
        group_key: 'dnc_items',
        group_index: 1,
        group_label: { sv: 'Artikel 1', en: 'Item 1' },
        source: 'FIELD',
        price_delta: '0.00',
      },
      {
        custom_field_id: null,
        value: 'Röd',
        field_name: 'Färg',
        field_label: { sv: 'Färg' },
        display_value: { sv: 'Röd' },
        sort_order: 1,
        group_key: 'dnc_items',
        group_index: 1,
        group_label: { sv: 'Artikel 1', en: 'Item 1' },
        source: 'OPTION',
        price_delta: '0.00',
        meta: { hex: '#dd3333', option_name: 'Färg' },
      },
      {
        custom_field_id: C_COLOR,
        value: 'Blå',
        field_name: 'color',
        field_type: 'COLOR_PALETTE',
        field_label: { sv: 'Färg', en: 'Colour' },
        sort_order: 2,
        group_key: 'dnc_items',
        group_index: 2,
        group_label: { sv: 'Artikel 2', en: 'Item 2' },
        source: 'FIELD',
        price_delta: '25.00',
        meta: { hex: '#3333dd' },
      },
      expect.objectContaining({
        custom_field_id: C_NAME,
        value: 'karin',
        field_label: { sv: 'Namn', en: 'Name' },
        group_index: 2,
        price_delta: '0.00',
      }),
      expect.objectContaining({
        custom_field_id: C_COLOR,
        group_index: 3,
        price_delta: '25.00',
      }),
      expect.objectContaining({
        custom_field_id: C_NAME,
        value: 'Olle',
        group_index: 3,
      }),
    ]);
  });

  it('market: delta, row price_delta and personalization_amount in the market currency', async () => {
    const { service, prisma } = build({ market: MARKET });
    const lines = [line(validValues())];
    const quote = await service.quoteLines(STORE_ID, lines, {
      countryCode: 'DE',
      locale: 'de',
      marketKey: 'eu',
    });
    expect(quote.currency).toBe('EUR');
    expect(quote.items[0].unit_price).toBe(54.9); // 49.9 + 5
    await service.create('u1', { ...DTO, market_key: 'eu' } as CreateOrderDto, {
      lines,
    });
    const item = created(prisma).items.create[0];
    expect(Number(item.unit_price)).toBe(54.9);
    expect(item.personalization_amount).toBe(5);
    const rows = (
      item.custom_field_values as { create: Record<string, unknown>[] }
    ).create;
    expect(rows.map((r) => r.price_delta)).toEqual([
      '0.00',
      '0.00',
      '2.50',
      '0.00',
      '2.50',
      '0.00',
    ]);
  });

  it('invalid values: 400 PERSONALIZATION_INVALID naming the line (quote) / the cart row (create)', async () => {
    const { service, prisma } = build();
    const bad = { [F_NAME]: 'Kristofer', [F_REP]: [{ [C_NAME]: 'Karin' }] };
    const quoteBody = await caught(
      service.quoteLines(STORE_ID, [line(bad)], { countryCode: 'SE' }),
    );
    expect(quoteBody).toMatchObject({
      code: 'PERSONALIZATION_INVALID',
      line_index: 0,
      errors: [
        expect.objectContaining({
          field_id: F_REP,
          child_id: C_COLOR,
          group_index: 2,
        }),
        expect.objectContaining({
          field_id: F_REP,
          child_id: C_COLOR,
          group_index: 3,
        }),
        expect.objectContaining({
          field_id: F_REP,
          child_id: C_NAME,
          group_index: 3,
        }),
      ],
    });
    prisma.cart.findUnique.mockResolvedValue({
      id: 'cart1',
      items: [
        {
          id: 'ci1',
          ...line(validValues()),
          bundle_offer_id: null,
          custom_product_id: null,
        },
      ],
    });
    // item_customizations replaces the cart values and is evaluated too.
    const body = await caught(
      service.create('u1', {
        ...DTO,
        item_customizations: {
          ci1: {
            custom_field_values: [{ custom_field_id: F_NAME, value: 'A B' }],
          },
        },
      } as CreateOrderDto),
    );
    expect(body).toMatchObject({
      code: 'PERSONALIZATION_INVALID',
      line_id: 'ci1',
    });
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('app off: M4.0 price and rows exactly, no evaluator, no personalization_amount', async () => {
    for (const variant of [{ appOn: false }, { withService: false }]) {
      const { service, prisma, evaluate } = build(variant);
      await service.create('u1', { ...DTO, locale: 'sv' } as CreateOrderDto, {
        lines: [line(validValues())],
      });
      const item = created(prisma).items.create[0];
      expect(Number(item.unit_price)).toBe(499);
      expect(item).not.toHaveProperty('personalization_amount');
      expect(
        (item.custom_field_values as { create: Record<string, unknown>[] })
          .create,
      ).toEqual([
        {
          custom_field_id: F_NAME,
          value: 'Kristofer',
          field_name: 'custom_name_v3',
          field_type: 'TEXT',
          sort_order: 0,
          field_label: { sv: 'Skriv namn här:', en: 'Write the name here:' },
        },
      ]);
      expect(evaluate).not.toHaveBeenCalled();
    }
  });
});

describe('OrdersService personalization app (M4.1 fixes)', () => {
  async function failure(p: Promise<unknown>) {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const e = err as HttpException;
      return {
        status: e.getStatus(),
        body: e.getResponse() as Record<string, unknown>,
      };
    }
    throw new Error('expected an HttpException');
  }

  it('snapshot cents: converted row deltas sum exactly to personalization_amount', async () => {
    const rate = 0.0333;
    const market: MarketContext = {
      ...MARKET,
      rate,
      priceRule: { mode: 'convert', source: 'manual', rate },
    };
    const { service, prisma } = build({ market });
    await service.create('u1', { ...DTO, market_key: 'eu' } as CreateOrderDto, {
      lines: [line(validValues())],
    });
    const item = created(prisma).items.create[0];
    // 50.00 SEK × 0.0333 = 1.665 → 1.67; per row 25 × 0.0333 = 0.8325.
    expect(item.personalization_amount).toBe(1.67);
    const rows = (
      item.custom_field_values as { create: Record<string, unknown>[] }
    ).create;
    const cents = rows.map((r) => Math.round(Number(r.price_delta) * 100));
    expect(cents.reduce((a, b) => a + b, 0)).toBe(167);
    expect(rows.map((r) => r.price_delta)).toEqual([
      '0.00',
      '0.00',
      '0.84',
      '0.00',
      '0.83',
      '0.00',
    ]);
  });

  it('a variant-only line (no product_id) is evaluated and priced', async () => {
    const { service, evaluate } = build();
    const quote = await service.quoteLines(
      STORE_ID,
      [{ variant_id: VARIANT.id, quantity: 1, custom_fields: validValues() }],
      { countryCode: 'SE', locale: 'sv' },
    );
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(quote.items[0].unit_price).toBe(549);
  });

  it('a variant-only line with invalid values is refused, never priced without them', async () => {
    const { service } = build();
    const body = await caught(
      service.quoteLines(
        STORE_ID,
        [{ variant_id: VARIANT.id, quantity: 1, custom_fields: {} }],
        { countryCode: 'SE' },
      ),
    );
    expect(body).toMatchObject({ code: 'PERSONALIZATION_INVALID' });
  });

  it('a variant of another product is rejected like a foreign item', async () => {
    const { service } = build();
    const body = await caught(
      service.quoteLines(
        STORE_ID,
        [line(validValues(), 1, { product_id: 'p-other' })],
        { countryCode: 'SE' },
      ),
    );
    expect(body).toMatchObject({ code: 'ORDER_ITEM_NOT_SOLD_BY_STORE' });
  });

  it('fails closed: app state unreadable for a product with app config → 503', async () => {
    const { service, storeApps, evaluate } = build();
    storeApps.isEnabled.mockResolvedValue(false as never);
    storeApps.enabledOrUnknown.mockResolvedValue(null as never);
    const res = await failure(
      service.quoteLines(STORE_ID, [line(validValues())], {
        countryCode: 'SE',
      }),
    );
    expect(res).toMatchObject({
      status: 503,
      body: { code: 'PERSONALIZATION_UNAVAILABLE' },
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('a product with active variants ordered without one → 400 PERSONALIZATION_VARIANT_REQUIRED', async () => {
    const { service } = build();
    const body = await caught(
      service.quoteLines(
        STORE_ID,
        [line(validValues(), 1, { variant_id: null })],
        { countryCode: 'SE' },
      ),
    );
    expect(body).toMatchObject({ code: 'PERSONALIZATION_VARIANT_REQUIRED' });
  });

  it('a unit price over Decimal(10,2) → 400 PERSONALIZATION_PRICE_TOO_HIGH', async () => {
    const { service, prisma } = build();
    const product = (await prisma.product.findUnique()) as Record<
      string,
      unknown
    >;
    prisma.productVariant.findUnique.mockResolvedValue({
      ...VARIANT,
      product: { ...product, base_price: 99_999_900 },
    } as never);
    const body = await caught(
      service.quoteLines(STORE_ID, [line(validValues())], {
        countryCode: 'SE',
      }),
    );
    expect(body).toMatchObject({ code: 'PERSONALIZATION_PRICE_TOO_HIGH' });
  });
});
