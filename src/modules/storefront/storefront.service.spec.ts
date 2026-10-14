import { StoreType } from '@prisma/client';
import { StorefrontService } from './storefront.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import type { MarketContext } from '../markets/market-context';
import { TaxService } from '../taxes/tax.service';

// GET /storefront/:slug feeds every storefront page. With the markets app
// off the payload must be exactly what it was before the app existed: no
// `market`/`markets` keys, language_config and currency untouched (§9.3).
// With a market, D3 overrides them.

const seMarket: MarketContext = {
  id: 'm-se',
  key: 'se',
  name: 'Sweden',
  countries: ['SE'],
  defaultLocale: 'sv',
  locales: ['en', 'ar'],
  currency: 'SEK',
  storeCurrency: 'EUR',
  rate: 11,
  priceRule: { mode: 'convert', source: 'manual', rate: 11 },
  isDefault: true,
  status: 'LIVE',
  primaryHostname: 'namez.se',
  hostnames: ['namez.se'],
};

function build(market: MarketContext | null) {
  const store = {
    id: 's1',
    slug: 'namez',
    name: 'Namez',
    creator_id: 'c1',
    store_type: StoreType.INDEPENDENT,
    currency: 'EUR',
    is_active: true,
    theme_config: {},
    theme_key: 'minimal',
    theme_customizations: {},
    tax_pricing_mode: 'INCLUSIVE',
    tax_basis: 'SHIPPING',
    tax_country: 'SE',
    oss_registered: false,
    use_platform_tax_rates: true,
    shipping_tax_class_id: null,
    display_prices_incl_tax: true,
    language_config: {
      id: 'lc1',
      store_id: 's1',
      primary_locale: 'en',
      secondary_locales: ['de'],
      auto_translate: false,
      fallback_locale: 'en',
    },
    static_pages: [],
    creator: {
      display_name: 'N',
      avatar_url: null,
      bio: null,
      cover_url: null,
      stripe_payouts_enabled: false,
      stripe_charges_enabled: true,
      stripe_account_type: 'standard',
    },
  };
  const prisma = {
    store: { findUnique: jest.fn(() => Promise.resolve(store)) },
    platformConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve({ default_currency: 'EUR', tax_country: 'SE' }),
      ),
    },
    creator: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          kustom_enabled: true,
          kustom_merchant_id: 'K1',
          kustom_shared_secret: 'secret',
        }),
      ),
    },
    page: { findMany: jest.fn(() => Promise.resolve([])) },
  };
  const storeApps = {
    storefrontApps: jest.fn(() =>
      Promise.resolve(market ? { markets: { enabled: true } } : {}),
    ),
  };
  const markets = {
    resolve: jest.fn(() => Promise.resolve(market)),
    listLive: jest.fn(() =>
      Promise.resolve(
        market
          ? [
              {
                key: 'se',
                name: 'Sweden',
                default_locale: 'sv',
                locales: ['en', 'ar'],
                countries: ['SE'],
                currency: 'SEK',
                is_default: true,
                primary_hostname: 'namez.se',
                status: 'LIVE' as const,
              },
            ]
          : null,
      ),
    ),
  };
  const service = new StorefrontService(
    prisma as unknown as PrismaService,
    storeApps as unknown as StoreAppsService,
    markets as unknown as MarketsContextService,
    {} as MarketPricingService,
    {} as TaxService,
  );
  return { service, markets };
}

describe('StorefrontService.getStore payload', () => {
  it('app off: no market keys, language_config and currency exactly as stored', async () => {
    const { service, markets } = build(null);
    const payload = await service.getStore('namez', 'se');
    expect(markets.resolve).toHaveBeenCalledWith('s1', 'se');
    expect(Object.keys(payload)).not.toContain('market');
    expect(Object.keys(payload)).not.toContain('markets');
    expect(payload.currency).toBe('EUR');
    expect(payload.language_config).toEqual({
      id: 'lc1',
      store_id: 's1',
      primary_locale: 'en',
      secondary_locales: ['de'],
      auto_translate: false,
      fallback_locale: 'en',
    });
    expect(payload.apps).toEqual({});
    expect(payload.kustom_enabled).toBe(true);
  });

  it('app off: the payload is identical with and without ?market=', async () => {
    const { service } = build(null);
    expect(await service.getStore('namez')).toEqual(
      await service.getStore('namez', 'se'),
    );
  });

  it('with a market: D3 overrides currency and locales and adds the routes', async () => {
    const { service } = build(seMarket);
    const payload = await service.getStore('namez', 'se');
    expect(payload.currency).toBe('SEK');
    expect(payload.language_config).toMatchObject({
      id: 'lc1',
      primary_locale: 'sv',
      secondary_locales: ['en', 'ar'],
      fallback_locale: 'en',
    });
    expect(payload.market).toEqual({
      key: 'se',
      name: 'Sweden',
      default_locale: 'sv',
      locales: ['en', 'ar'],
      countries: ['SE'],
      currency: 'SEK',
      is_default: true,
      primary_hostname: 'namez.se',
      status: 'LIVE',
    });
    expect(payload.markets).toHaveLength(1);
    // Kustom availability is judged against the market currency.
    expect(payload.kustom_enabled).toBe(true);
  });
});

// b2b app (D2, watch list 2): products carry `tax_rate_bp` only when the
// app is enabled; the catalog payload of any other store is unchanged.
describe('StorefrontService.getProducts tax_rate_bp', () => {
  function buildProducts(enabled: boolean) {
    const store = {
      id: 's1',
      slug: 'namez',
      creator_id: 'c1',
      store_type: StoreType.INDEPENDENT,
      show_vendor_name: false,
      tax_pricing_mode: 'INCLUSIVE',
      tax_basis: 'SHIPPING',
      tax_country: 'SE',
      oss_registered: false,
      use_platform_tax_rates: true,
      shipping_tax_class_id: null,
      display_prices_incl_tax: true,
      creator: { id: 'c1' },
    };
    const products = [
      {
        id: 'p1',
        creator_id: 'c1',
        base_price: 125,
        compare_at_price: null,
        tax_class_id: null,
        tax_exempt: false,
        translations: [],
        images: [],
        variants: [{ id: 'v1', price_adjustment: 10, stock_quantity: null }],
        category: null,
      },
      {
        id: 'p2',
        creator_id: 'c1',
        base_price: 80,
        compare_at_price: null,
        tax_class_id: null,
        tax_exempt: true,
        translations: [],
        images: [],
        variants: [],
        category: null,
      },
    ];
    const prisma = {
      store: { findUnique: jest.fn(() => Promise.resolve(store)) },
      product: { findMany: jest.fn(() => Promise.resolve(products)) },
      customProduct: { findMany: jest.fn(() => Promise.resolve([])) },
      promotion: { findMany: jest.fn(() => Promise.resolve([])) },
    };
    const storeApps = {
      isEnabled: jest.fn(() => Promise.resolve(enabled)),
    };
    const markets = { resolve: jest.fn(() => Promise.resolve(null)) };
    const ctx = {
      registrant: 'STORE',
      storeId: 's1',
      rateStoreId: 's1',
      taxCountry: 'SE',
      pricingMode: 'INCLUSIVE',
      basis: 'SHIPPING',
      ossRegistered: false,
      usePlatformRates: true,
      shippingTaxClassId: null,
      displayPricesInclTax: true,
    };
    const data = {
      classes: [
        {
          id: 'std',
          store_id: null,
          key: 'standard',
          name: {},
          is_default: true,
        },
      ],
      rates: [
        {
          id: 'r1',
          store_id: null,
          tax_class_id: 'std',
          country: 'SE',
          region: null,
          postcode_pattern: null,
          rate_bp: 2500,
          label: 'VAT',
          priority: 0,
          applies_to_shipping: true,
          is_active: true,
        },
      ],
    };
    const taxService = {
      contextFor: jest.fn(() => Promise.resolve(ctx)),
      loadTaxData: jest.fn(() => Promise.resolve(data)),
    };
    const service = new StorefrontService(
      prisma as unknown as PrismaService,
      storeApps as unknown as StoreAppsService,
      markets as unknown as MarketsContextService,
      {} as MarketPricingService,
      taxService as unknown as TaxService,
    );
    return { service, taxService };
  }

  it('app off: no tax_rate_bp key and no rate-table query', async () => {
    const { service, taxService } = buildProducts(false);
    const list = (await service.getProducts('namez', {})) as Record<
      string,
      unknown
    >[];
    expect(list).toHaveLength(2);
    for (const p of list) expect('tax_rate_bp' in p).toBe(false);
    expect(taxService.loadTaxData).not.toHaveBeenCalled();
  });

  it('app on: each product carries its registration-country estimate', async () => {
    const off = (await buildProducts(false).service.getProducts(
      'namez',
      {},
    )) as Record<string, unknown>[];
    const { service, taxService } = buildProducts(true);
    const list = (await service.getProducts('namez', {})) as Record<
      string,
      unknown
    >[];
    expect(list.map((p) => p.tax_rate_bp)).toEqual([2500, 0]);
    expect(taxService.loadTaxData).toHaveBeenCalledTimes(1);
    // Everything else is identical to the app-off payload.
    expect(list.map(({ tax_rate_bp: _r, ...rest }) => rest)).toEqual(off);
  });
});
