import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { StoreType } from '@prisma/client';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { personalizationCoreArgs } from '../personalization/__fixtures__/personalization-service.factory';
import { PromotionsService } from '../promotions/promotions.service';
import { ShippingService } from '../shipping/shipping.service';
import { MailService } from '../mail/mail.service';
import { TaxService } from '../taxes/tax.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import type { MarketContext } from '../markets/market-context';
import { B2bService } from '../b2b/b2b.service';
import { resolveOrderCurrency } from '../../common/money/currency.util';

// The market hooks of order pricing, exercised through quoteLines() with a
// hand-rolled Prisma mock: the same lines price identically with the app
// off, and in the market currency (overrides, shipping, coupon, rate) with
// a market context. The tax engine is stubbed to "no tax" so the totals are
// plain money arithmetic.

const STORE_ID = 's1';
const CREATOR_ID = 'c1';

const euMarket: MarketContext = {
  id: 'm-eu',
  key: 'eu',
  name: 'Europe',
  countries: ['DE', 'FR'],
  defaultLocale: 'en',
  locales: ['de'],
  currency: 'EUR',
  storeCurrency: 'SEK',
  rate: 0.1,
  priceRule: { mode: 'convert', source: 'manual', rate: 0.1 },
  isDefault: false,
  noindex: false,
  status: 'LIVE',
  primaryHostname: 'namez.shop',
  hostnames: ['namez.shop', 'www.namez.shop'],
};

function makePrisma(
  overrides: {
    product_id: string;
    variant_id: string | null;
    price: number | null;
    available?: boolean;
  }[] = [],
) {
  const product = {
    id: 'p1',
    creator_id: CREATOR_ID,
    provider_id: null,
    status: 'PUBLISHED',
    base_price: 299,
    tax_class_id: null,
    tax_exempt: false,
    track_inventory: false,
    stock_quantity: null,
  };
  const variant = {
    id: 'v1',
    product_id: 'p1',
    price_adjustment: 50,
    is_active: true,
    stock_quantity: null,
    product,
  };
  return {
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: STORE_ID,
          slug: 'namez',
          store_type: StoreType.INDEPENDENT,
          creator_id: CREATOR_ID,
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
    // M4.0: the personalization check reads the fields of every line.
    productCustomField: { findMany: jest.fn(() => Promise.resolve([])) },
    productVariant: {
      findUnique: jest.fn(() => Promise.resolve(variant)),
      // M4.1 loadContexts: variant → product of every variant line.
      findMany: jest.fn(() =>
        Promise.resolve(
          variant ? [{ id: variant.id, product_id: variant.product_id }] : [],
        ),
      ),
    },
    productMarketPrice: {
      findMany: jest.fn(() =>
        Promise.resolve(
          overrides.map((o) => ({
            product_id: o.product_id,
            variant_id: o.variant_id,
            price: o.price,
            compare_at_price: null,
            available: o.available ?? true,
          })),
        ),
      ),
    },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'EUR' })),
    },
    // "Buy 2, 100 (base currency) off" on p1.
    bundleOffer: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'offer-fixed',
          quantity: 2,
          discount_type: 'FIXED',
          discount_value: 100,
          bundle: { status: 'ACTIVE', creator_id: CREATOR_ID },
        }),
      ),
    },
  };
}

function build(opts: {
  market: MarketContext | null;
  overrides?: {
    product_id: string;
    variant_id: string | null;
    price: number | null;
    available?: boolean;
  }[];
  shippingCost?: number;
  coupon?: { discount_amount: number; free_shipping?: boolean } | null;
}) {
  const prisma = makePrisma(opts.overrides);
  const markets = { resolve: jest.fn(() => Promise.resolve(opts.market)) };
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
            cost: opts.shippingCost ?? 49,
            estimated_days: { min: 2, max: 5 },
            free_shipping: false,
          },
        ],
      }),
    ),
  };
  const promotions = {
    validateCoupon: jest.fn(() =>
      Promise.resolve({
        promotion_id: 'promo',
        type: 'FIXED_AMOUNT',
        value: 100,
        discount_amount: opts.coupon?.discount_amount ?? 0,
        free_shipping: opts.coupon?.free_shipping ?? false,
      }),
    ),
  };
  // No-tax engine: the total is subtotal + shipping - discount.
  const tax = {
    contextFor: jest.fn(() => Promise.resolve({})),
    loadTaxData: jest.fn(() => Promise.resolve({})),
    computeTaxes: jest.fn(
      (input: {
        lines: { amount: number }[];
        shipping_cost: number;
        discount_amount: number;
        currency: string;
      }) => ({
        items: input.lines.map(() => ({
          tax_rate_bp: 0,
          tax_amount: 0,
          tax_class_key: null,
        })),
        headline_rate_bp: 0,
        tax_total: 0,
        tax_lines: [],
        tax_pricing_mode: 'INCLUSIVE',
        tax_basis_country: null,
        shipping_tax_amount: 0,
        shipping_tax_rate_bp: 0,
        total:
          input.lines.reduce((s, l) => s + l.amount, 0) +
          input.shipping_cost -
          input.discount_amount,
        currency: input.currency,
      }),
    ),
  };
  const config = { get: () => 'https://stores.platform.test' };
  // b2b app off: every path runs as a person.
  const b2b = {
    isEnabled: jest.fn(() => Promise.resolve(false)),
    resolveBuyerType: jest.fn(() => Promise.resolve('PERSON' as const)),
  };
  const service = new OrdersService(
    prisma as unknown as PrismaService,
    promotions as unknown as PromotionsService,
    shipping as unknown as ShippingService,
    {} as MailService,
    tax as unknown as TaxService,
    markets as unknown as MarketsContextService,
    marketPricing,
    config as unknown as ConfigService,
    b2b as unknown as B2bService,
    ...personalizationCoreArgs(prisma),
  );
  return { service, prisma, shipping, promotions, tax, markets };
}

const lines = [
  { product_id: 'p1', variant_id: null, quantity: 2 },
  { product_id: 'p1', variant_id: 'v1', quantity: 1 },
];

describe('resolveOrderCurrency', () => {
  it('is the market currency, else resolveStoreCurrency', () => {
    const store = { store_type: 'INDEPENDENT', currency: 'SEK' };
    expect(resolveOrderCurrency(store, 'EUR', { currency: 'dkk' })).toBe('DKK');
    expect(resolveOrderCurrency(store, 'EUR', null)).toBe('SEK');
    expect(resolveOrderCurrency(store, 'EUR')).toBe('SEK');
    expect(
      resolveOrderCurrency(
        { store_type: 'MARKETPLACE', currency: 'SEK' },
        'EUR',
      ),
    ).toBe('EUR');
  });
});

describe('OrdersService.quoteLines with and without a market', () => {
  it('app off: base prices, store currency, no market key in the quote', async () => {
    const { service, markets } = build({ market: null });
    const quote = await service.quoteLines(STORE_ID, lines, {
      countryCode: 'SE',
      marketKey: 'eu',
    });
    expect(markets.resolve).toHaveBeenCalledWith(STORE_ID, 'eu');
    expect(quote.items.map((i) => i.unit_price)).toEqual([299, 349]);
    expect(quote.subtotal).toBe(947);
    expect(quote.shipping_cost).toBe(49);
    expect(quote.total).toBe(996);
    expect(quote.currency).toBe('SEK');
    expect('market' in quote).toBe(false);
  });

  it('market: converted unit prices, shipping and currency, plus the market block', async () => {
    const { service, shipping, tax } = build({ market: euMarket });
    const quote = await service.quoteLines(STORE_ID, lines, {
      countryCode: 'DE',
      marketKey: 'eu',
    });
    expect(quote.items.map((i) => i.unit_price)).toEqual([29.9, 34.9]);
    expect(quote.subtotal).toBe(94.7);
    // The free-shipping threshold is compared in the base currency.
    expect(shipping.quoteForItems).toHaveBeenCalledWith(
      expect.objectContaining({ subtotal: 947 }),
    );
    expect(quote.shipping_cost).toBe(4.9);
    expect(quote.shipping?.available && quote.shipping.methods[0].cost).toBe(
      4.9,
    );
    expect(quote.total).toBe(99.6);
    expect(quote.currency).toBe('EUR');
    expect(tax.computeTaxes).toHaveBeenLastCalledWith(
      expect.objectContaining({ currency: 'EUR' }),
    );
    expect(quote.market).toEqual({ key: 'eu', currency: 'EUR', rate: 0.1 });
  });

  it('market: product and variant overrides win over conversion', async () => {
    const { service } = build({
      market: euMarket,
      overrides: [
        { product_id: 'p1', variant_id: null, price: 27.99 },
        { product_id: 'p1', variant_id: 'v1', price: 33 },
      ],
    });
    const quote = await service.quoteLines(STORE_ID, lines, {
      countryCode: 'DE',
    });
    expect(quote.items.map((i) => i.unit_price)).toEqual([27.99, 33]);
  });

  it('market: a product hidden there is rejected like a foreign item', async () => {
    const { service } = build({
      market: euMarket,
      overrides: [
        { product_id: 'p1', variant_id: null, price: null, available: false },
      ],
    });
    await expect(
      service.quoteLines(STORE_ID, lines, { countryCode: 'DE' }),
    ).rejects.toMatchObject({
      response: { code: 'ORDER_ITEM_NOT_SOLD_BY_STORE' },
    });
  });

  it('market: a fixed-amount coupon is validated in base and converted back', async () => {
    const { service, promotions } = build({
      market: euMarket,
      coupon: { discount_amount: 100 },
    });
    const quote = await service.quoteLines(STORE_ID, lines, {
      countryCode: 'DE',
      couponCode: 'TEN',
    });
    expect(promotions.validateCoupon).toHaveBeenCalledWith(
      expect.objectContaining({ subtotal: 947 }),
    );
    expect(quote.discount_amount).toBe(10);
    expect(quote.total).toBe(89.6);
  });

  it('market with a fixed rule and no rate: overrides price lines, shipping cannot convert', async () => {
    const { service } = build({
      market: { ...euMarket, rate: null, priceRule: { mode: 'fixed' } },
      overrides: [
        { product_id: 'p1', variant_id: null, price: 30 },
        { product_id: 'p1', variant_id: 'v1', price: 35 },
      ],
    });
    await expect(
      service.quoteLines(STORE_ID, lines, { countryCode: 'DE' }),
    ).rejects.toMatchObject({
      response: { code: 'MARKET_FX_RATE_MISSING' },
    });
    const quote = await service.quoteLines(STORE_ID, lines, {
      countryCode: null,
    });
    expect(quote.items.map((i) => i.unit_price)).toEqual([30, 35]);
    expect(quote.market?.rate).toBeNull();
  });
});

describe('OrdersService market preview (DRAFT market, reads only)', () => {
  // The context service is stubbed like the real one: the key resolves only
  // with { preview: true }, else MARKET_NOT_LIVE.
  function buildDraft() {
    const built = build({ market: euMarket });
    built.markets.resolve.mockImplementation((...args: unknown[]) =>
      (args[2] as { preview?: boolean } | undefined)?.preview
        ? Promise.resolve({ ...euMarket, status: 'DRAFT', preview: true })
        : Promise.reject(
            new NotFoundException({
              code: 'MARKET_NOT_LIVE',
              message: 'This market is not live',
            }),
          ),
    );
    return built;
  }

  it('quoteLines prices the draft market with preview, refuses it without', async () => {
    const { service, markets } = buildDraft();
    const quote = await service.quoteLines(STORE_ID, lines, {
      countryCode: 'DE',
      marketKey: 'eu',
      preview: true,
    });
    expect(markets.resolve).toHaveBeenCalledWith(STORE_ID, 'eu', {
      preview: true,
    });
    expect(quote.currency).toBe('EUR');
    await expect(
      service.quoteLines(STORE_ID, lines, {
        countryCode: 'DE',
        marketKey: 'eu',
      }),
    ).rejects.toMatchObject({ response: { code: 'MARKET_NOT_LIVE' } });
  });

  it('create never previews: an order in the draft market is MARKET_NOT_LIVE', async () => {
    const { service, prisma, markets } = buildDraft();
    (prisma as unknown as { customer: unknown }).customer = {
      findUnique: jest.fn(() => Promise.resolve({ id: 'cust1' })),
    };
    await expect(
      service.create(
        'u1',
        {
          store_id: STORE_ID,
          market_key: 'eu',
          hostname: 'namez-se--eu.stores.platform.test',
          // The DTO is otherwise irrelevant: the market gate runs first.
        } as unknown as Parameters<typeof service.create>[1],
        { lines },
      ),
    ).rejects.toMatchObject({ response: { code: 'MARKET_NOT_LIVE' } });
    expect(markets.resolve).toHaveBeenLastCalledWith(STORE_ID, 'eu');
  });
});

describe('OrdersService bundle discounts in a market (FIXED)', () => {
  const bundleLines = [
    {
      product_id: 'p1',
      variant_id: null,
      quantity: 2,
      bundle_offer_id: 'offer-fixed',
    },
  ];

  it('app off: the fixed amount applies in the base currency', async () => {
    const { service } = build({ market: null });
    const quote = await service.quoteLines(STORE_ID, bundleLines, {
      countryCode: null,
    });
    // (2 × 299 − 100) / 2
    expect(quote.items[0].unit_price).toBe(249);
    expect(quote.items[0].original_unit_price).toBe(299);
  });

  it('market: the fixed amount is converted with the market rate', async () => {
    const { service } = build({ market: euMarket });
    const quote = await service.quoteLines(STORE_ID, bundleLines, {
      countryCode: null,
    });
    // (2 × 29.9 − 10) / 2
    expect(quote.items[0].unit_price).toBe(24.9);
    expect(quote.items[0].original_unit_price).toBe(29.9);
    expect(quote.currency).toBe('EUR');
  });

  it('market with a fixed rule and no rate: a FIXED bundle cannot be priced', async () => {
    const { service } = build({
      market: { ...euMarket, rate: null, priceRule: { mode: 'fixed' } },
      overrides: [{ product_id: 'p1', variant_id: null, price: 30 }],
    });
    await expect(
      service.quoteLines(STORE_ID, bundleLines, { countryCode: null }),
    ).rejects.toMatchObject({ response: { code: 'MARKET_FX_RATE_MISSING' } });
  });
});

describe('OrdersService hostname snapshot (D1)', () => {
  const validated = (service: OrdersService, host?: string | null) =>
    (
      service as unknown as {
        validatedHostname: (
          m: MarketContext,
          slug: string,
          h?: string | null,
        ) => string | null;
      }
    ).validatedHostname(euMarket, 'namez', host);

  it('keeps a hostname of the market or the platform subdomain, else the primary', () => {
    const { service } = build({ market: euMarket });
    expect(validated(service, 'WWW.namez.shop:443')).toBe('www.namez.shop');
    expect(validated(service, 'namez.stores.platform.test')).toBe(
      'namez.stores.platform.test',
    );
    expect(validated(service, 'evil.example.com')).toBe('namez.shop');
    expect(validated(service, undefined)).toBe('namez.shop');
    expect(validated(service, null)).toBe('namez.shop');
  });

  it('falls back to null (platform subdomain) when the market has no hosts', () => {
    const { service } = build({ market: euMarket });
    const bare = { ...euMarket, primaryHostname: null, hostnames: [] };
    expect(
      (
        service as unknown as {
          validatedHostname: (
            m: MarketContext,
            slug: string,
            h?: string,
          ) => string | null;
        }
      ).validatedHostname(bare, 'namez', 'evil.example.com'),
    ).toBeNull();
  });
});

describe('marketOrderLocale', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { marketOrderLocale } = require('./orders.service') as typeof import('./orders.service');
  const eu = { defaultLocale: 'en', locales: ['sv', 'ar'] };

  it('keeps a locale the market serves', () => {
    expect(marketOrderLocale(eu, 'SV')).toBe('sv');
    expect(marketOrderLocale(eu, ' en ')).toBe('en');
  });

  it('falls back to the market default for anything else', () => {
    expect(marketOrderLocale(eu, 'de')).toBe('en');
    expect(marketOrderLocale(eu, null)).toBe('en');
    expect(marketOrderLocale(eu, '')).toBe('en');
  });
});
