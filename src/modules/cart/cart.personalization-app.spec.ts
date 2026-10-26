import { BadRequestException, HttpException, Logger } from '@nestjs/common';
import { CartService } from './cart.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TaxService } from '../taxes/tax.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import type { MarketContext } from '../markets/market-context';
import { B2bService } from '../b2b/b2b.service';
import {
  C_COLOR,
  C_NAME,
  F_NAME,
  F_PLAIN,
  F_REP,
  OPTION_CONFIG,
  VARIANT,
  appFields,
  plainFields,
  validValues,
} from '../personalization/__fixtures__/app-fields';
import {
  buildPersonalizationCore,
  buildPersonalizationService,
} from '../personalization/__fixtures__/personalization-service.factory';

// M4.1 cart (C29 step 3): with the personalization app on for a product
// with M4.1 config, add/update run the evaluator (400
// PERSONALIZATION_INVALID {errors}), store canonical values (line key merge),
// and the cart read adds the converted per-unit delta before bundles and
// grouped display lines. App off / no M4.1 config: the M4.0 path exactly.

type Row = {
  id: string;
  cart_id: string;
  product_id: string | null;
  variant_id: string | null;
  custom_product_id: string | null;
  bundle_offer_id: string | null;
  quantity: number;
  custom_fields: unknown;
};

const KEYS = [
  'cart_id',
  'product_id',
  'variant_id',
  'custom_product_id',
  'bundle_offer_id',
] as const;

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

function build(opts: { fields: unknown[]; appOn: boolean; seed?: Row[] }) {
  const rows: Row[] = (opts.seed ?? []).map((r) => ({ ...r }));
  let n = rows.length;
  const matches = (r: Row, where: Record<string, unknown>) =>
    KEYS.every((k) => !(k in where) || r[k] === where[k]) &&
    (!where.id ||
      (typeof where.id === 'string'
        ? r.id === where.id
        : r.id !== (where.id as { not: string }).not));
  const product = {
    id: 'p1',
    creator_id: 'c1',
    base_price: 299,
    variant_option_config: OPTION_CONFIG,
    translations: [{ locale: 'sv', title: 'Halsband' }],
    images: [],
    custom_fields: opts.fields,
  };
  const prisma = {
    rows,
    customer: { findUnique: jest.fn(() => Promise.resolve({ id: 'cust1' })) },
    cart: { findUnique: jest.fn(() => Promise.resolve({ id: 'cart1' })) },
    productCustomField: {
      findMany: jest.fn(() => Promise.resolve(opts.fields)),
    },
    customProduct: { findMany: jest.fn(() => Promise.resolve([])) },
    product: { findUnique: jest.fn(() => Promise.resolve(product)) },
    productImage: { findFirst: jest.fn(() => Promise.resolve(null)) },
    productVariant: {
      findUnique: jest.fn(() => Promise.resolve({ ...VARIANT, images: [] })),
      // Active variants: both colours exist (the palette's source).
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
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 's1',
          creator_id: 'c1',
          language_config: { primary_locale: 'sv' },
        }),
      ),
    },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'SEK' })),
    },
    bundleOffer: { findUnique: jest.fn(() => Promise.resolve(null)) },
    cartItem: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(rows.find((r) => matches(r, where)) ?? null),
      ),
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(rows.filter((r) => matches(r, where))),
      ),
      create: jest.fn(({ data }: { data: Partial<Row> }) => {
        const row: Row = {
          id: `r${++n}`,
          cart_id: 'cart1',
          product_id: null,
          variant_id: null,
          custom_product_id: null,
          bundle_offer_id: null,
          quantity: 1,
          custom_fields: null,
          ...data,
        };
        rows.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          const row = rows.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return Promise.resolve(row);
        },
      ),
    },
  };
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(opts.appOn)),
    enabledOrUnknown: jest.fn(() => Promise.resolve(opts.appOn)),
    getSettings: jest.fn(() => Promise.resolve({})),
  };
  const marketPricing = new MarketPricingService(
    prisma as unknown as PrismaService,
  );
  const personalization = buildPersonalizationService({
    prisma,
    storeApps,
    marketPricing,
  });
  const evaluate = jest.spyOn(personalization, 'evaluateLine');
  const service = new CartService(
    prisma as unknown as PrismaService,
    {} as TaxService,
    {
      resolve: jest.fn(() => Promise.resolve(null)),
    } as unknown as MarketsContextService,
    marketPricing,
    {} as B2bService,
    buildPersonalizationCore(prisma).core,
    personalization,
  );
  const internals = service as unknown as Record<string, jest.Mock> & {
    enrichCartItems: (
      items: Row[],
      locale?: string,
      market?: MarketContext | null,
    ) => Promise<Record<string, unknown>[]>;
  };
  jest.spyOn(service, 'getCart').mockResolvedValue({} as never);
  internals.assertAvailableInMarket = jest.fn(() => Promise.resolve());
  return { service, prisma, internals, evaluate, storeApps };
}

const add = (service: CartService, custom_fields: unknown) =>
  service.addItem(
    'u1',
    {
      product_id: 'p1',
      variant_id: VARIANT.id,
      quantity: 1,
      custom_fields,
    } as never,
    'sv',
  );

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

const row = (custom_fields: unknown, quantity = 1): Row => ({
  id: 'r0',
  cart_id: 'cart1',
  product_id: 'p1',
  variant_id: VARIANT.id,
  custom_product_id: null,
  bundle_offer_id: null,
  quantity,
  custom_fields,
});

describe('CartService personalization app (M4.1)', () => {
  it('add stores canonical values; an equivalent add merges, a different one splits', async () => {
    const { service, prisma } = build({ fields: appFields(), appOn: true });
    await add(service, validValues());
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].custom_fields).toEqual({
      [F_NAME]: 'Kristofer',
      [F_REP]: [
        { [C_COLOR]: 'Blå', [C_NAME]: 'karin' },
        { [C_COLOR]: 'Röd', [C_NAME]: 'Olle' },
      ],
    });
    // Same values written differently (spaces, key order): same line key.
    await add(service, {
      [F_REP]: [
        { [C_NAME]: ' karin', [C_COLOR]: 'Blå' },
        { [C_NAME]: 'Olle', [C_COLOR]: 'Röd' },
      ],
      [F_NAME]: ' Kristofer ',
    });
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].quantity).toBe(2);
    // Another name for item 3: a new line.
    const other = validValues();
    (other[F_REP] as Record<string, string>[])[1][C_NAME] = 'Emil';
    await add(service, other);
    expect(prisma.rows).toHaveLength(2);
  });

  it('invalid values: 400 PERSONALIZATION_INVALID with the contract errors', async () => {
    const { service, prisma } = build({ fields: appFields(), appOn: true });
    const body = await caught(
      add(service, {
        [F_REP]: [
          { [C_COLOR]: 'Blå', [C_NAME]: 'Karin' },
          { [C_NAME]: 'Olle' },
        ],
      }),
    );
    expect(body).toEqual({
      code: 'PERSONALIZATION_INVALID',
      message: 'Please check your personalization',
      errors: [
        {
          code: 'CUSTOM_FIELD_REQUIRED',
          field_id: F_NAME,
          field_name: 'custom_name_v3',
          message: 'Vänligen skriv ett namn.',
        },
        {
          code: 'CUSTOM_FIELD_REQUIRED',
          field_id: F_REP,
          field_name: 'dnc_items',
          child_id: C_COLOR,
          child_name: 'color',
          group_index: 3,
          message: 'Artikel 3: Färg måste väljas',
        },
      ],
    });
    expect(prisma.rows).toHaveLength(0);
  });

  it('update with new values validates and re-keys the line like an add', async () => {
    const { service, prisma } = build({
      fields: appFields(),
      appOn: true,
      seed: [row({ [F_NAME]: 'Anna' })],
    });
    await caught(
      service.updateItem(
        'u1',
        'r0',
        { custom_fields: { [F_NAME]: 'A-B' } } as never,
        'sv',
      ),
    );
    await service.updateItem(
      'u1',
      'r0',
      { custom_fields: validValues() } as never,
      'sv',
    );
    expect(prisma.rows[0].custom_fields).toMatchObject({
      [F_NAME]: 'Kristofer',
    });
  });

  it('app off: the M4.0 rules and envelope, the evaluator never runs', async () => {
    const { service, evaluate, prisma } = build({
      fields: appFields(),
      appOn: false,
    });
    // Legacy branch: only the top-level M4.0 field counts; the repeater
    // value is dropped (unknown to M4.0) and not required.
    const body = await caught(add(service, {}));
    expect(body).toMatchObject({
      code: 'CUSTOM_FIELD_REQUIRED',
      field_id: F_NAME,
    });
    expect(body).not.toHaveProperty('errors');
    await add(service, validValues());
    expect(prisma.rows[0].custom_fields).toEqual({ [F_NAME]: 'Kristofer' });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('app on, product without M4.1 config: the M4.0 path, no extra query', async () => {
    const { service, evaluate, prisma, storeApps } = build({
      fields: plainFields(),
      appOn: true,
    });
    const body = await caught(add(service, {}));
    expect(body).toMatchObject({
      code: 'CUSTOM_FIELD_REQUIRED',
      field_id: F_PLAIN,
    });
    await add(service, { [F_PLAIN]: ' Anna ' });
    expect(prisma.rows[0].custom_fields).toEqual({ [F_PLAIN]: 'Anna' });
    expect(evaluate).not.toHaveBeenCalled();
    expect(storeApps.isEnabled).not.toHaveBeenCalled();
    expect(prisma.store.findUnique).not.toHaveBeenCalled();
  });

  describe('cart read (enrichCartItems)', () => {
    it('adds the per-unit delta and grouped display lines', async () => {
      const { internals } = build({ fields: appFields(), appOn: true });
      const [item] = await internals.enrichCartItems(
        [row(validValues(), 2)],
        'sv',
      );
      expect(item.price).toBe(549); // 299 + 200 + 2 items × 25
      expect(item).not.toHaveProperty('personalization_invalid');
      const display = item.customFieldDisplay as Record<string, unknown>[];
      expect(display.map((d) => [d.id, d.group_index, d.value])).toEqual([
        [`${F_NAME}#1`, 1, 'Kristofer'],
        ['option:Färg#1', 1, 'Röd'],
        [`${C_COLOR}#2`, 2, 'Blå'],
        [`${C_NAME}#2`, 2, 'karin'],
        [`${C_COLOR}#3`, 3, 'Röd'],
        [`${C_NAME}#3`, 3, 'Olle'],
      ]);
      expect(display[0]).toMatchObject({
        label: 'Namn',
        group_label: 'Artikel 1',
        source: 'FIELD',
      });
      expect(display[1]).toMatchObject({ source: 'OPTION', hex: '#dd3333' });
    });

    it('market: the delta is converted with the market rate (like the variant price)', async () => {
      const { internals } = build({ fields: appFields(), appOn: true });
      const [item] = await internals.enrichCartItems(
        [row(validValues())],
        'de',
        MARKET,
      );
      expect(item.currency).toBe('EUR');
      expect(item.price).toBe(54.9); // 499 × 0.1 + 50 × 0.1
    });

    it('stored values that no longer pass are flagged, never thrown', async () => {
      const { internals } = build({ fields: appFields(), appOn: true });
      const [item] = await internals.enrichCartItems(
        [row({ [F_NAME]: 'Kristofer' })],
        'sv',
      );
      expect(item.personalization_invalid).toBe(true);
      expect(item.price).toBe(499);
    });

    it('app off: M4.0 price and display, no new keys', async () => {
      const { internals, evaluate } = build({
        fields: appFields(),
        appOn: false,
      });
      const [item] = await internals.enrichCartItems(
        [row({ [F_NAME]: 'Kristofer' })],
        'sv',
      );
      expect(item.price).toBe(499);
      expect(item.customFieldDisplay).toEqual([
        {
          id: F_NAME,
          label: 'Skriv namn här:',
          value: 'Kristofer',
          display: null,
        },
      ]);
      expect(item).not.toHaveProperty('personalization_invalid');
      expect(evaluate).not.toHaveBeenCalled();
    });
  });
});

describe('CartService personalization app (M4.1 fixes)', () => {
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

  it('a variant-only add resolves the product from the variant and is evaluated', async () => {
    const { service, prisma, evaluate } = build({
      fields: appFields(),
      appOn: true,
    });
    await service.addItem(
      'u1',
      {
        variant_id: VARIANT.id,
        quantity: 1,
        custom_fields: validValues(),
      } as never,
      'sv',
    );
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(prisma.rows[0].product_id).toBe('p1');
    expect(prisma.rows[0].custom_fields).toMatchObject({
      [F_NAME]: 'Kristofer',
    });
  });

  it('a variant of another product is refused (400 PRODUCT_VARIANT_MISMATCH)', async () => {
    const { service, prisma } = build({ fields: appFields(), appOn: true });
    const res = await failure(
      service.addItem(
        'u1',
        {
          product_id: 'p-other',
          variant_id: VARIANT.id,
          quantity: 1,
          custom_fields: validValues(),
        } as never,
        'sv',
      ),
    );
    expect(res).toMatchObject({
      status: 400,
      body: { code: 'PRODUCT_VARIANT_MISMATCH' },
    });
    expect(prisma.rows).toHaveLength(0);
  });

  it('a stored variant-only row is priced with its personalization on read', async () => {
    const { internals } = build({ fields: appFields(), appOn: true });
    const [item] = await internals.enrichCartItems(
      [{ ...row(validValues()), product_id: null }],
      'sv',
    );
    expect(item.price).toBe(549);
  });

  it('fails closed: app state unreadable → 503 PERSONALIZATION_UNAVAILABLE', async () => {
    const { service, storeApps, prisma } = build({
      fields: appFields(),
      appOn: true,
    });
    storeApps.enabledOrUnknown.mockResolvedValue(null as never);
    const res = await failure(add(service, validValues()));
    expect(res).toMatchObject({
      status: 503,
      body: { code: 'PERSONALIZATION_UNAVAILABLE' },
    });
    expect(prisma.rows).toHaveLength(0);
  });

  it('fails closed on read too: the line is flagged, never priced as app-off', async () => {
    const { internals, storeApps } = build({
      fields: appFields(),
      appOn: true,
    });
    storeApps.enabledOrUnknown.mockResolvedValue(null as never);
    const [item] = await internals.enrichCartItems([row(validValues())], 'sv');
    expect(item.personalization_invalid).toBe(true);
  });

  it('M5 A9: a swallowed app-state error on read is logged with the cart item id', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const { internals, storeApps } = build({
        fields: appFields(),
        appOn: true,
      });
      storeApps.enabledOrUnknown.mockResolvedValue(null as never);
      const stored = row(validValues());
      await internals.enrichCartItems([stored], 'sv');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`Cart item ${stored.id}`),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('a product with active variants needs the variant (400 PERSONALIZATION_VARIANT_REQUIRED)', async () => {
    const { service } = build({ fields: appFields(), appOn: true });
    const res = await failure(
      service.addItem(
        'u1',
        {
          product_id: 'p1',
          quantity: 1,
          custom_fields: validValues(),
        } as never,
        'sv',
      ),
    );
    expect(res).toMatchObject({
      status: 400,
      body: { code: 'PERSONALIZATION_VARIANT_REQUIRED' },
    });
  });

  it('a price over Decimal(10,2) is 400 PERSONALIZATION_PRICE_TOO_HIGH', async () => {
    const fields = [
      {
        id: 'f-long',
        product_id: 'p1',
        name: 'long_text',
        type: 'TEXT',
        is_required: false,
        sort_order: 0,
        parent_id: null,
        options: null,
        validation_rules: null,
        linked_validation: null,
        conditions: null,
        pricing: { mode: 'per_char', amount: 1000000 },
        repeat: null,
        ui: null,
        translations: [],
      },
    ];
    const { service } = build({ fields, appOn: true });
    const res = await failure(add(service, { 'f-long': 'A'.repeat(100) }));
    expect(res).toMatchObject({
      status: 400,
      body: { code: 'PERSONALIZATION_PRICE_TOO_HIGH' },
    });
  });

  it('active option values are read once per product for the whole cart', async () => {
    const { internals, prisma } = build({ fields: appFields(), appOn: true });
    await internals.enrichCartItems(
      [row(validValues()), { ...row(validValues()), id: 'r9' }],
      'sv',
    );
    const activeReads = prisma.productVariant.findMany.mock.calls.filter(
      (c) =>
        ((c as unknown[])[0] as { where?: { is_active?: boolean } })?.where
          ?.is_active === true,
    );
    expect(activeReads).toHaveLength(1);
  });
});
