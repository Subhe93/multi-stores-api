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
}) {
  const prisma = {
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 's1',
          slug: 'namez-se',
          status: opts.status ?? 'LIVE',
          store_type: StoreType.INDEPENDENT,
          creator: { id: 'c1' },
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
    },
    customProduct: { findFirst: jest.fn(() => Promise.resolve(null)) },
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
    undefined,
    undefined,
    undefined,
    shipping as unknown as ShippingService,
  );
  return { service, shipping, prisma, marketPricing };
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
