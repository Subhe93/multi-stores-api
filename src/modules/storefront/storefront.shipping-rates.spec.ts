import { ShippingMethodType, StoreType } from '@prisma/client';
import {
  MAX_RATE_COUNTRIES,
  parseRateCountries,
  StorefrontService,
} from './storefront.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import type { MarketPricingService } from '../markets/market-pricing.service';
import type { TaxService } from '../taxes/tax.service';
import type { ShippingService } from '../shipping/shipping.service';
import type { PersonalizationService } from '../personalization/personalization.service';
import type { DesignerTemplatesService } from '../designer/designer-templates.service';

// M161 B6: GET /storefront/:slug/products/:productSlug/shipping-rates.

type Quote = Awaited<ReturnType<ShippingService['estimate']>>;

function method(
  id: string,
  type: ShippingMethodType,
  cost: number,
  min = 2,
  max = 4,
) {
  return {
    id,
    name: id,
    type,
    cost,
    estimated_days: { min, max },
    free_shipping: cost === 0,
  };
}

function build(opts: {
  status?: string;
  market?: unknown;
  quotes?: Record<string, Partial<Quote>>;
  own?: unknown;
  /** M170 C: stored Store.merchant_policies (absent = column NULL). */
  policies?: unknown;
  /** M172: custom fields of the own product (detail read). */
  fields?: unknown[];
  /** M172: the slug resolves to this custom product (marketplace store). */
  custom?: unknown;
  /** M172: detail read of that custom product. */
  customDetail?: unknown;
  /** M172: designer link is live / personalization app is on. */
  designerLive?: boolean;
  personalizationApp?: boolean;
}) {
  const prisma = {
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 's1',
          slug: 'namez-se',
          status: opts.status ?? 'LIVE',
          store_type: opts.custom
            ? StoreType.MARKETPLACE
            : StoreType.INDEPENDENT,
          creator: { id: 'c1' },
          ...(opts.policies !== undefined
            ? { merchant_policies: opts.policies }
            : {}),
        }),
      ),
    },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'SEK' })),
    },
    product: {
      findFirst: jest.fn(() =>
        Promise.resolve(
          opts.own === undefined ? { id: 'p1', base_price: 390 } : opts.own,
        ),
      ),
      findUnique: jest.fn(() =>
        Promise.resolve({
          variant_option_config: null,
          custom_fields: opts.fields ?? [],
        }),
      ),
    },
    customProduct: {
      findFirst: jest.fn(() => Promise.resolve(opts.custom ?? null)),
      findUnique: jest.fn(() => Promise.resolve(opts.customDetail ?? null)),
    },
  };
  const personalization = {
    isEnabled: jest.fn(() => Promise.resolve(opts.personalizationApp === true)),
  };
  const designer = {
    storefrontLive: jest.fn(() => Promise.resolve(opts.designerLive === true)),
  };
  const markets = {
    resolve: jest.fn(() => Promise.resolve(opts.market ?? null)),
  };
  const marketPricing = {
    loadPrices: jest.fn(() => Promise.resolve(new Map())),
    priceProduct: jest.fn((_ctx: unknown, p: { base_price: number }) => ({
      hidden: false,
      base_price: p.base_price * 0.1,
      compare_at_price: null,
      variants: [],
    })),
    convertMoney: jest.fn((_ctx: unknown, a: number) => a * 0.1),
    toBaseMoney: jest.fn((_ctx: unknown, a: number) => a * 10),
  };
  const shipping = {
    estimate: jest.fn(
      (dto: { country_code: string }, _money: unknown): Promise<Quote> =>
        Promise.resolve(
          (opts.quotes?.[dto.country_code] ?? {
            available: false,
            message: 'n/a',
            methods: [],
          }) as Quote,
        ),
    ),
  };
  const service = new StorefrontService(
    prisma as unknown as PrismaService,
    {} as StoreAppsService,
    markets as unknown as MarketsContextService,
    marketPricing as unknown as MarketPricingService,
    {} as TaxService,
    personalization as unknown as PersonalizationService,
    designer as unknown as DesignerTemplatesService,
    undefined,
    shipping as unknown as ShippingService,
  );
  return { service, shipping, prisma, marketPricing, designer };
}

describe('parseRateCountries', () => {
  it('upper-cases, de-duplicates and drops invalid codes', () => {
    expect(parseRateCountries('de, at,XYZ,1A,,DE,se')).toEqual([
      'DE',
      'AT',
      'SE',
    ]);
    expect(parseRateCountries(undefined)).toEqual([]);
    expect(parseRateCountries(['DE'])).toEqual([]);
  });

  it('caps the list at MAX_RATE_COUNTRIES', () => {
    const codes = 'AA,AB,AC,AD,AE,AF,AG,AH,AI,AJ,AK,AL'.split(',');
    expect(parseRateCountries(codes.join(','))).toEqual(
      codes.slice(0, MAX_RATE_COUNTRIES),
    );
  });
});

describe('StorefrontService.getProductShippingRates', () => {
  it('closed store: no rates and no lookup', async () => {
    const { service, shipping, prisma } = build({ status: 'DRAFT' });
    const res = await service.getProductShippingRates('namez-se', 'x', 'SE');
    expect(res.rates).toEqual([]);
    expect(shipping.estimate).not.toHaveBeenCalled();
    expect(prisma.product.findFirst).not.toHaveBeenCalled();
  });

  it('cheapest DELIVERY per country, PICKUP ignored, unavailable omitted', async () => {
    const { service, shipping } = build({
      quotes: {
        SE: {
          available: true,
          methods: [
            method('pickup', ShippingMethodType.PICKUP, 0),
            method('express', ShippingMethodType.DELIVERY, 99, 1, 2),
            method('standard', ShippingMethodType.DELIVERY, 49, 2, 5),
          ],
        },
      },
    });
    const res = await service.getProductShippingRates(
      'namez-se',
      'studentskylt',
      'SE,NO',
    );
    expect(res).toEqual({
      requires_shipping: true,
      currency: 'SEK',
      rates: [{ country: 'SE', cost: 49, min_days: 2, max_days: 5 }],
    });
    expect(shipping.estimate).toHaveBeenCalledTimes(2);
    expect(shipping.estimate.mock.calls[0][0]).toMatchObject({
      product_ids: ['p1'],
      country_code: 'SE',
      item_count: 1,
      subtotal: 390,
      store_id: 's1',
    });
    // No market: no currency conversion.
    expect(shipping.estimate.mock.calls[0][1]).toBeNull();
  });

  it('pickup-only country is omitted', async () => {
    const { service } = build({
      quotes: {
        SE: {
          available: true,
          methods: [method('pickup', ShippingMethodType.PICKUP, 0)],
        },
      },
    });
    const res = await service.getProductShippingRates('namez-se', 'x', 'SE');
    expect(res.rates).toEqual([]);
  });

  it('market: market-priced subtotal and converted costs', async () => {
    const market = {
      id: 'm-eu',
      key: 'eu',
      currency: 'EUR',
      rate: 0.1,
      countries: ['DE', 'AT'],
    };
    const { service, shipping } = build({
      market,
      quotes: {
        DE: {
          available: true,
          methods: [method('dhl', ShippingMethodType.DELIVERY, 9.9)],
        },
      },
    });
    const res = await service.getProductShippingRates(
      'namez-se',
      'x',
      'DE',
      'eu',
    );
    expect(res.currency).toBe('EUR');
    expect(res.rates).toEqual([
      { country: 'DE', cost: 9.9, min_days: 2, max_days: 4 },
    ]);
    const [dto, money] = shipping.estimate.mock.calls[0] as unknown as [
      { subtotal: number; market_key?: string },
      { toBase(a: number): number; fromBase(a: number): number },
    ];
    expect(dto.subtotal).toBeCloseTo(39);
    expect(dto.market_key).toBe('eu');
    expect(money.fromBase(100)).toBeCloseTo(10);
    expect(money.toBase(10)).toBeCloseTo(100);
  });

  it('market without a rate: no rates', async () => {
    const { service, shipping } = build({
      market: { id: 'm', key: 'x', currency: 'EUR', rate: null },
    });
    const res = await service.getProductShippingRates(
      'namez-se',
      'x',
      'DE',
      'x',
    );
    expect(res.rates).toEqual([]);
    expect(shipping.estimate).not.toHaveBeenCalled();
  });

  it('requires_shipping false: no rates', async () => {
    const { service } = build({
      quotes: {
        SE: { available: true, methods: [], requires_shipping: false },
      },
    });
    const res = await service.getProductShippingRates('namez-se', 'x', 'SE');
    expect(res).toEqual({
      requires_shipping: false,
      currency: 'SEK',
      rates: [],
    });
  });

  it('unknown product: no rates', async () => {
    const { service, shipping } = build({ own: null });
    const res = await service.getProductShippingRates('namez-se', 'x', 'SE');
    expect(res.rates).toEqual([]);
    expect(shipping.estimate).not.toHaveBeenCalled();
  });
});

// M170 C: handling time + return policies ride on the same read.
describe('StorefrontService.getProductShippingRates: merchant policies', () => {
  const seQuote = {
    SE: {
      available: true,
      methods: [method('standard', ShippingMethodType.DELIVERY, 49, 2, 5)],
    },
  };
  const policies = {
    handling: { min_days: 1, max_days: 2 },
    returns: [
      {
        countries: ['SE', 'NO'],
        category: 'finite',
        days: 14,
        methods: ['mail'],
        fees: 'fixed',
        fee_amount: 49,
      },
      { countries: ['DE', 'AT'], category: 'unlimited', fees: 'free' },
    ],
  };

  it('not configured (NULL, absent or malformed): exactly the M161 response', async () => {
    const expected = {
      requires_shipping: true,
      currency: 'SEK',
      rates: [{ country: 'SE', cost: 49, min_days: 2, max_days: 5 }],
    };
    for (const stored of [
      undefined,
      null,
      {},
      'broken',
      { handling: { min_days: 9, max_days: 1 } },
      { returns: [{ countries: ['SE'], category: 'finite' }] },
    ]) {
      const { service } = build({ quotes: seQuote, policies: stored });
      const res = await service.getProductShippingRates('namez-se', 'x', 'SE');
      expect(res).toEqual(expected);
      expect(Object.keys(res)).toEqual([
        'requires_shipping',
        'currency',
        'rates',
      ]);
    }
  });

  it('handling only: handling_days, no return_policies key', async () => {
    const { service } = build({
      quotes: seQuote,
      policies: { handling: { min_days: 1, max_days: 2 } },
    });
    const res = await service.getProductShippingRates('namez-se', 'x', 'SE');
    expect(res).toEqual({
      requires_shipping: true,
      currency: 'SEK',
      rates: [{ country: 'SE', cost: 49, min_days: 2, max_days: 5 }],
      handling_days: { min: 1, max: 2 },
    });
    expect(res).not.toHaveProperty('return_policies');
  });

  it('return policies are narrowed to the requested countries', async () => {
    const { service } = build({ quotes: seQuote, policies });
    const res = await service.getProductShippingRates(
      'namez-se',
      'x',
      'AT,SE,US',
    );
    expect(res.return_policies).toEqual([
      {
        countries: ['SE'],
        category: 'finite',
        days: 14,
        methods: ['mail'],
        fees: 'fixed',
        fee_amount: 49,
      },
      { countries: ['AT'], category: 'unlimited', fees: 'free' },
    ]);
    // The rates themselves are computed as before.
    expect(res.rates).toEqual([
      { country: 'SE', cost: 49, min_days: 2, max_days: 5 },
    ]);
  });

  it('no policy covers the request: no return_policies key', async () => {
    const { service } = build({ quotes: seQuote, policies });
    const res = await service.getProductShippingRates('namez-se', 'x', 'US');
    expect(res).toEqual({
      requires_shipping: true,
      currency: 'SEK',
      rates: [],
      handling_days: { min: 1, max: 2 },
    });
    expect(res).not.toHaveProperty('return_policies');
  });

  it('market: the fixed return fee is converted like shipping costs', async () => {
    const { service, marketPricing } = build({
      market: { id: 'm-eu', key: 'eu', currency: 'EUR', rate: 0.1 },
      quotes: {
        AT: {
          available: true,
          methods: [method('dhl', ShippingMethodType.DELIVERY, 9.9)],
        },
      },
      policies: {
        returns: [
          {
            countries: ['AT'],
            category: 'finite',
            days: 30,
            fees: 'fixed',
            fee_amount: 49,
          },
        ],
      },
    });
    const res = await service.getProductShippingRates(
      'namez-se',
      'x',
      'AT',
      'eu',
    );
    expect(res.currency).toBe('EUR');
    expect(res.return_policies?.[0].fee_amount).toBeCloseTo(4.9);
    expect(marketPricing.convertMoney).toHaveBeenCalledWith(
      expect.anything(),
      49,
    );
  });

  it('every early return and requires_shipping false carry neither key', async () => {
    const cases: Array<{
      opts: Parameters<typeof build>[0];
      countries: string;
      market?: string;
    }> = [
      // Closed store.
      { opts: { status: 'DRAFT' }, countries: 'SE' },
      // No destination countries.
      { opts: {}, countries: '' },
      // Market without an FX rate.
      {
        opts: { market: { id: 'm', key: 'x', currency: 'EUR', rate: null } },
        countries: 'SE',
        market: 'x',
      },
      // Unknown product.
      { opts: { own: null }, countries: 'SE' },
      // Product that does not ship (service / digital).
      {
        opts: {
          quotes: {
            SE: { available: true, methods: [], requires_shipping: false },
          },
        },
        countries: 'SE',
      },
    ];
    for (const c of cases) {
      const { service } = build({ ...c.opts, policies });
      const res = await service.getProductShippingRates(
        'namez-se',
        'x',
        c.countries,
        c.market,
      );
      expect(res.rates).toEqual([]);
      expect(Object.keys(res)).toEqual([
        'requires_shipping',
        'currency',
        'rates',
      ]);
    }
  });

  it('hidden in the market: neither key', async () => {
    const { service, marketPricing } = build({
      market: { id: 'm-eu', key: 'eu', currency: 'EUR', rate: 0.1 },
      policies,
    });
    marketPricing.priceProduct.mockReturnValue({
      hidden: true,
      base_price: 0,
      compare_at_price: null,
      variants: [],
    });
    const res = await service.getProductShippingRates(
      'namez-se',
      'x',
      'SE',
      'eu',
    );
    expect(Object.keys(res)).toEqual([
      'requires_shipping',
      'currency',
      'rates',
    ]);
    expect(res.rates).toEqual([]);
  });
});

// M172: personalised products are published as not returnable when the
// store switched the exception on.
describe('StorefrontService.getProductShippingRates: personalised exception', () => {
  const quotes = {
    SE: {
      available: true,
      methods: [method('dhl', ShippingMethodType.DELIVERY, 49, 2, 5)],
    },
  };
  const returns = [
    {
      countries: ['SE', 'NO'],
      category: 'finite',
      days: 14,
      methods: ['mail'],
      fees: 'fixed',
      fee_amount: 49,
    },
    { countries: ['DE', 'AT'], category: 'unlimited', fees: 'free' },
  ];
  const off = { handling: { min_days: 1, max_days: 2 }, returns };
  const on = { ...off, personalized_no_returns: true };
  const field = (
    id: string,
    type: string,
    parent_id: string | null = null,
  ) => ({
    id,
    type,
    parent_id,
    name: id,
    is_required: false,
  });
  const nameField = field('f1', 'TEXT');
  const read = (opts: Parameters<typeof build>[0], countries = 'AT,SE,US') => {
    const built = build({ quotes, ...opts });
    return {
      ...built,
      res: built.service.getProductShippingRates('namez-se', 'x', countries),
    };
  };

  it('flag off (false, absent): unchanged and the product is never looked at', async () => {
    const plain = await read({ policies: off }).res;
    for (const policies of [off, { ...off, personalized_no_returns: false }]) {
      const r = read({ policies, fields: [nameField], designerLive: true });
      expect(JSON.stringify(await r.res)).toBe(JSON.stringify(plain));
      expect(r.prisma.product.findUnique).not.toHaveBeenCalled();
      expect(r.prisma.customProduct.findUnique).not.toHaveBeenCalled();
      expect(r.designer.storefrontLive).not.toHaveBeenCalled();
    }
  });

  it('flag on + personalised: "none" for the covered countries, rates and handling as before', async () => {
    const res = await read({ policies: on, fields: [nameField] }).res;
    expect(res).toEqual({
      requires_shipping: true,
      currency: 'SEK',
      rates: [{ country: 'SE', cost: 49, min_days: 2, max_days: 5 }],
      handling_days: { min: 1, max: 2 },
      return_policies: [{ countries: ['AT', 'SE'], category: 'none' }],
    });
  });

  it('flag on + plain product: the store policies, unchanged', async () => {
    const plain = await read({ policies: off }).res;
    for (const fields of [
      [],
      [field('f1', 'SELECT'), field('f2', 'NUMBER'), field('f3', 'DATE')],
    ]) {
      const res = await read({ policies: on, fields }).res;
      expect(JSON.stringify(res)).toBe(JSON.stringify(plain));
    }
  });

  it('flag on + personalised, no policy covers the request: no return_policies key', async () => {
    const res = await read({ policies: on, fields: [nameField] }, 'US').res;
    expect(res).not.toHaveProperty('return_policies');
  });

  it('a live designer link makes the product personalised', async () => {
    const r = read({ policies: on, designerLive: true });
    expect((await r.res).return_policies).toEqual([
      { countries: ['AT', 'SE'], category: 'none' },
    ]);
    expect(r.designer.storefrontLive).toHaveBeenCalledWith('s1', 'p1');
  });

  it('a personnummer text field is not buyer content: the store policies stay', async () => {
    const idField = {
      ...field('f1', 'TEXT'),
      validation_rules: { format: 'personnummer' },
    };
    const plain = await read({ policies: off }).res;
    for (const personalizationApp of [false, true]) {
      const res = await read({
        policies: on,
        fields: [idField],
        personalizationApp,
      }).res;
      expect(res.return_policies).toEqual(plain.return_policies);
    }
    // With a real name field next to it the product is personalised again.
    const both = await read({ policies: on, fields: [idField, nameField] }).res;
    expect(both.return_policies?.[0].category).toBe('none');
  });

  it('repeater children count only while the personalization app is on', async () => {
    const fields = [field('rep', 'REPEATER'), field('c1', 'TEXT', 'rep')];
    const appOn = await read({ policies: on, fields, personalizationApp: true })
      .res;
    expect(appOn.return_policies?.[0].category).toBe('none');
    // App off: the storefront does not publish the repeater at all.
    const appOff = await read({ policies: on, fields }).res;
    expect(appOff.return_policies?.[0].category).toBe('finite');
  });

  it('custom product: only fields its creator left open for the buyer count', async () => {
    const custom = { id: 'cp1', final_price: 300 };
    const detail = (prefilled: string[]) => ({
      field_values: prefilled.map((id) => ({ custom_field_id: id })),
      product: { custom_fields: [nameField] },
    });
    const open = read({
      policies: on,
      own: null,
      custom,
      customDetail: detail([]),
      designerLive: true,
    });
    expect((await open.res).return_policies).toEqual([
      { countries: ['AT', 'SE'], category: 'none' },
    ]);
    expect(open.prisma.customProduct.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cp1' } }),
    );
    // The creator filled the text in: a finished design, not buyer content.
    // The designer is never consulted for a custom product.
    const filled = read({
      policies: on,
      own: null,
      custom,
      customDetail: detail(['f1']),
      designerLive: true,
    });
    expect((await filled.res).return_policies?.[0].category).toBe('finite');
    expect(filled.designer.storefrontLive).not.toHaveBeenCalled();
  });
});
