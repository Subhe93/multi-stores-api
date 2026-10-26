import { NotFoundException } from '@nestjs/common';
import { StoreType, TaxBasis, TaxPricingMode } from '@prisma/client';
import { FeedsService, collectionPath, optionsOf } from './feeds.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import type { MarketContext } from '../markets/market-context';
import { generateFeedToken } from './feeds-settings';

// ── Fixtures ────────────────────────────────────────────────────────────────

const STORE_ID = 'store-1';
const CREATOR_ID = 'creator-1';
const USER_ID = 'user-1';
const TOKEN = generateFeedToken();

function store(overrides: Record<string, unknown> = {}) {
  return {
    id: STORE_ID,
    slug: 'namz',
    name: 'Namz & Co',
    custom_domain: null,
    currency: 'SEK',
    is_active: true,
    creator_id: CREATOR_ID,
    store_type: StoreType.INDEPENDENT,
    tax_pricing_mode: TaxPricingMode.INCLUSIVE,
    tax_basis: TaxBasis.SHIPPING,
    tax_country: 'SE',
    oss_registered: false,
    use_platform_tax_rates: true,
    shipping_tax_class_id: null,
    display_prices_incl_tax: true,
    language_config: { primary_locale: 'sv' },
    ...overrides,
  };
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    product_type: 'TRADITIONAL',
    base_price: 100,
    compare_at_price: null,
    track_inventory: false,
    stock_quantity: null,
    tax_class_id: null,
    tax_exempt: false,
    gtin: '4006381333931',
    mpn: null,
    brand: 'Namz',
    google_product_category: null,
    condition: null,
    feed_excluded: false,
    translations: [
      {
        locale: 'sv',
        title: 'Tröja & Co',
        description: '<p>Mjuk</p>',
        slug: 'troja',
      },
      { locale: 'en', title: 'Tee', description: 'Soft', slug: 'tee' },
    ],
    images: [
      {
        url: 'https://cdn/a.jpg',
        variant_id: null,
        is_featured: false,
        sort_order: 0,
      },
      {
        url: 'https://cdn/b.jpg',
        variant_id: null,
        is_featured: true,
        sort_order: 1,
      },
    ],
    variants: [],
    creator_categories: [{ creator_category_id: 'cc-child' }],
    ...overrides,
  };
}

const SE_MARKET: MarketContext = {
  id: 'm-se',
  key: 'se',
  name: 'Sweden',
  countries: ['SE'],
  defaultLocale: 'sv',
  locales: ['en'],
  currency: 'SEK',
  storeCurrency: 'SEK',
  rate: 1,
  priceRule: { mode: 'convert' },
  isDefault: true,
  indexing: 'AUTO',
  status: 'LIVE',
  primaryHostname: 'namz.se',
  hostnames: ['namz.se'],
};

const EU_MARKET: MarketContext = {
  ...SE_MARKET,
  id: 'm-eu',
  key: 'eu',
  name: 'Europe',
  countries: ['DE', 'FR'],
  defaultLocale: 'en',
  locales: [],
  currency: 'EUR',
  rate: 0.1,
  isDefault: false,
  indexing: 'AUTO',
  primaryHostname: 'namz.shop',
  hostnames: ['namz.shop'],
};

interface World {
  store: ReturnType<typeof store> | null;
  settings: Record<string, unknown> | null;
  products: ReturnType<typeof product>[];
  priceRows: Record<string, unknown>[];
  markets: MarketContext[] | null;
  taxRates: Record<string, unknown>[];
}

function build(w: Partial<World> = {}) {
  const world: World = {
    store: store(),
    settings: { token: TOKEN, google: true, facebook: true },
    products: [product()],
    priceRows: [],
    markets: null,
    taxRates: [],
    ...w,
  };
  const calls = { productFindMany: 0, updateSettings: [] as unknown[] };
  const prisma = {
    store: {
      findUnique: jest.fn(
        async ({ where }: { where: { slug?: string; id?: string } }) => {
          if (!world.store) return null;
          if (where.slug && where.slug !== world.store.slug) return null;
          if (where.id && where.id !== world.store.id) return null;
          return world.store;
        },
      ),
    },
    storeApp: {
      findUnique: jest.fn(async () =>
        world.settings ? { settings: world.settings } : null,
      ),
    },
    product: {
      findMany: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          calls.productFindMany++;
          if (where.feed_excluded === true) {
            return world.products.filter((p) => p.feed_excluded);
          }
          return world.products.filter((p) => !p.feed_excluded);
        },
      ),
      count: jest.fn(
        async () => world.products.filter((p) => p.feed_excluded).length,
      ),
    },
    productMarketPrice: {
      findMany: jest.fn(async ({ where }: { where: { market_id: string } }) =>
        world.priceRows.filter((r) => r.market_id === where.market_id),
      ),
    },
    creatorCategory: {
      findMany: jest.fn(async () => [
        {
          id: 'cc-root',
          parent_id: null,
          translations: [
            { locale: 'sv', name: 'Kläder' },
            { locale: 'en', name: 'Clothing' },
          ],
        },
        {
          id: 'cc-child',
          parent_id: 'cc-root',
          translations: [
            { locale: 'sv', name: 'Tröjor' },
            { locale: 'en', name: 'Tees' },
          ],
        },
      ]),
    },
    platformConfig: {
      findFirst: jest.fn(async () => ({
        default_currency: 'EUR',
        default_tax_pricing_mode: TaxPricingMode.INCLUSIVE,
        platform_tax_country: 'SE',
        platform_oss_registered: false,
      })),
    },
    taxRate: { findMany: jest.fn(async () => world.taxRates) },
    taxClass: { findMany: jest.fn(async () => []) },
  };
  const storeApps = {
    getSettings: jest.fn(async () => world.settings),
    storeOfCreator: jest.fn(async () => ({
      id: STORE_ID,
      store_type: StoreType.INDEPENDENT,
    })),
    updateSettings: jest.fn(
      async (_s: string, _k: string, settings: unknown) => {
        calls.updateSettings.push(settings);
        world.settings = settings as Record<string, unknown>;
        return true;
      },
    ),
    settingsChanged: jest.fn(async () => undefined),
  };
  const markets = {
    resolve: jest.fn(async (_storeId: string, key?: string) => {
      if (!world.markets) return null;
      if (key) {
        const m = world.markets.find((x) => x.key === key);
        if (!m) throw new NotFoundException({ code: 'MARKET_NOT_FOUND' });
        return m;
      }
      return world.markets.find((m) => m.isDefault) ?? null;
    }),
    listLive: jest.fn(async () =>
      world.markets
        ? world.markets.map((m) => ({
            key: m.key,
            name: m.name,
            currency: m.currency,
            is_default: m.isDefault,
          }))
        : null,
    ),
  };
  const config = {
    get: (key: string) =>
      ({
        PUBLIC_API_URL: 'https://api.example.com',
        STOREFRONT_URL: 'https://shop.example.com',
      })[key],
  };
  const taxService = {
    contextFor: jest.fn(async (s: ReturnType<typeof store>) => ({
      registrant: 'STORE',
      storeId: s.id,
      rateStoreId: s.id,
      taxCountry: s.tax_country,
      pricingMode: s.tax_pricing_mode,
      basis: s.tax_basis,
      ossRegistered: false,
      usePlatformRates: true,
      shippingTaxClassId: null,
      displayPricesInclTax: true,
    })),
    loadTaxData: jest.fn(async () => ({
      rates: world.taxRates,
      classes: [
        {
          id: 'tc-std',
          store_id: null,
          key: 'standard',
          name: null,
          is_default: true,
        },
      ],
    })),
  };
  const service = new FeedsService(
    prisma as never,
    config as never,
    storeApps as never,
    markets as never,
    new MarketPricingService(prisma as never),
    taxService as never,
  );
  return { service, world, calls, prisma, storeApps };
}

// ── Public feed ─────────────────────────────────────────────────────────────

describe('FeedsService.publicFeed (M5.6)', () => {
  it('404 for an unknown store, a wrong token, the app off, or a format switched off', async () => {
    const { service, world } = build();
    await expect(
      service.publicFeed('nope', TOKEN, 'google'),
    ).rejects.toMatchObject({
      response: { code: 'FEED_NOT_FOUND' },
    });
    await expect(
      service.publicFeed('namz', generateFeedToken(), 'google'),
    ).rejects.toMatchObject({
      response: { code: 'FEED_NOT_FOUND' },
    });
    await expect(
      service.publicFeed('namz', 'short', 'google'),
    ).rejects.toBeInstanceOf(NotFoundException);
    world.settings = { ...world.settings, facebook: false };
    await expect(
      service.publicFeed('namz', TOKEN, 'facebook'),
    ).rejects.toMatchObject({
      response: { code: 'FEED_NOT_FOUND' },
    });
    world.settings = null; // app off
    await expect(
      service.publicFeed('namz', TOKEN, 'google'),
    ).rejects.toMatchObject({
      response: { code: 'FEED_NOT_FOUND' },
    });
    world.settings = { token: TOKEN };
    world.store = store({ is_active: false });
    await expect(
      service.publicFeed('namz', TOKEN, 'google'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('builds the Google feed without the markets app (store currency, platform URL, primary locale)', async () => {
    const { service } = build();
    const feed = await service.publicFeed('namz', TOKEN, 'google');
    expect(feed.cached).toBe(false);
    expect(feed.items).toBe(1);
    expect(feed.contentType).toBe('application/rss+xml; charset=utf-8');
    expect(feed.etag).toMatch(/^"[a-f0-9]{40}"$/);
    const xml = feed.body;
    expect(xml).toContain('<title>Namz &amp; Co</title>');
    expect(xml).toContain('<g:id>p1</g:id>');
    expect(xml).toContain('<g:title>Tröja &amp; Co</g:title>');
    expect(xml).toContain('<g:description>Mjuk</g:description>');
    expect(xml).toContain(
      '<g:link>https://shop.example.com/store/namz/products/troja</g:link>',
    );
    // Featured image first, the rest as additional.
    expect(xml).toContain(
      '<g:image_link>https://cdn/b.jpg</g:image_link><g:additional_image_link>https://cdn/a.jpg</g:additional_image_link>',
    );
    expect(xml).toContain('<g:price>100.00 SEK</g:price>');
    expect(xml).toContain('<g:brand>Namz</g:brand>');
    expect(xml).toContain('<g:gtin>4006381333931</g:gtin>');
    expect(xml).toContain('<g:condition>new</g:condition>');
    expect(xml).toContain(
      '<g:product_type>Kläder &gt; Tröjor</g:product_type>',
    );
    expect(xml).toContain('<g:custom_label_0>Tröjor</g:custom_label_0>');
    expect(xml).not.toContain('g:shipping');
  });

  it('uses the default brand, shipping label and identifier_exists for bare products', async () => {
    const { service } = build({
      settings: {
        token: TOKEN,
        default_brand: 'House',
        shipping_label: 'Standard',
      },
      products: [product({ gtin: null, brand: null, condition: 'used' })],
    });
    const xml = (await service.publicFeed('namz', TOKEN, 'google')).body;
    expect(xml).toContain('<g:brand>House</g:brand>');
    expect(xml).toContain('<g:identifier_exists>no</g:identifier_exists>');
    expect(xml).toContain('<g:condition>used</g:condition>');
    // No market: the registration country.
    expect(xml).toContain(
      '<g:shipping><g:country>SE</g:country><g:service>Standard</g:service></g:shipping>',
    );
  });

  it('skips excluded products and reports them in the validation', async () => {
    const { service, prisma } = build({
      products: [product(), product({ id: 'p2', feed_excluded: true })],
    });
    const feed = await service.publicFeed('namz', TOKEN, 'google');
    expect(feed.items).toBe(1);
    expect(feed.body).not.toContain('<g:id>p2</g:id>');
    // Drafts never reach the query: status PUBLISHED is part of the where.
    const where = prisma.product.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      creator_id: CREATOR_ID,
      status: 'PUBLISHED',
      feed_excluded: false,
    });
    const report = await service.validate(USER_ID);
    expect(report).toMatchObject({
      products: 1,
      items: 1,
      skipped: { excluded: 1, hidden_in_market: 0 },
      missing_gtin: [],
      missing_brand: [],
      missing_identifier: 0,
    });
    expect(report.excluded).toEqual([{ id: 'p2', title: 'Tröja & Co' }]);
  });

  it('one item per active variant with item_group_id, color/size and variant stock', async () => {
    const { service } = build({
      products: [
        product({
          track_inventory: true,
          variants: [
            {
              id: 'v1',
              price_adjustment: 0,
              compare_at_price: null,
              stock_quantity: 3,
              options: { Color: 'Red', Size: 'L' },
              images: [{ url: 'https://cdn/red.jpg' }],
            },
            {
              id: 'v2',
              price_adjustment: 20,
              compare_at_price: 150,
              stock_quantity: 0,
              options: { Färg: 'Blå' },
              images: [],
            },
          ],
        }),
      ],
    });
    const csv = (await service.publicFeed('namz', TOKEN, 'facebook')).body;
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('v1,');
    expect(lines[1]).toContain(',in stock,new,100.00 SEK,');
    expect(lines[1]).toContain('https://cdn/red.jpg');
    expect(lines[1]).toContain(',p1,'); // item_group_id
    expect(lines[1]).toContain(',Red,L,');
    expect(lines[2]).toContain('v2,');
    expect(lines[2]).toContain(',out of stock,');
    // compare-at 150 > 120: regular 150, sale 120.
    expect(lines[2]).toContain(',150.00 SEK,');
    expect(lines[2]).toContain(',120.00 SEK,');
    expect(lines[2]).toContain(',Blå,,');
    // include_variants=false collapses to the product.
    const { service: s2 } = build({
      settings: { token: TOKEN, include_variants: false },
      products: [
        product({
          variants: [
            {
              id: 'v1',
              price_adjustment: 0,
              compare_at_price: null,
              stock_quantity: 3,
              options: {},
              images: [],
            },
          ],
        }),
      ],
    });
    expect(
      (await s2.publicFeed('namz', TOKEN, 'facebook')).body.trim().split('\n'),
    ).toHaveLength(2);
  });

  it('prices through the market helper, links the market domain, hides market-hidden products', async () => {
    const { service, prisma } = build({
      markets: [SE_MARKET, EU_MARKET],
      // The pricing helper applies a compare-at override only to a product
      // that has a base compare-at price (its existing rule).
      products: [
        product({ compare_at_price: 120 }),
        product({
          id: 'p2',
          translations: [
            { locale: 'en', title: 'Hidden', description: '', slug: 'hidden' },
          ],
        }),
      ],
      priceRows: [
        {
          product_id: 'p2',
          market_id: 'm-eu',
          variant_id: null,
          price: null,
          compare_at_price: null,
          available: false,
        },
        {
          product_id: 'p1',
          market_id: 'm-eu',
          variant_id: null,
          price: 9.5,
          compare_at_price: 12,
          available: true,
        },
      ],
    });
    const eu = await service.publicFeed('namz', TOKEN, 'google', 'eu');
    expect(eu.items).toBe(1);
    expect(eu.body).toContain(
      '<g:link>https://namz.shop/products/tee</g:link>',
    );
    expect(eu.body).toContain('<g:title>Tee</g:title>');
    // Override 9.5 EUR; compare-at override 12 is the regular price.
    expect(eu.body).toContain('<g:price>12.00 EUR</g:price>');
    expect(eu.body).toContain('<g:sale_price>9.50 EUR</g:sale_price>');
    expect(eu.body).not.toContain('Hidden');
    // The query also excludes products switched off in the market.
    const where = prisma.product.findMany.mock.calls[0][0].where;
    expect(where.NOT).toEqual({
      market_prices: {
        some: { market_id: 'm-eu', variant_id: null, available: false },
      },
    });
    // Default market without ?market=.
    const se = await service.publicFeed('namz', TOKEN, 'google');
    expect(se.body).toContain(
      '<g:link>https://namz.se/products/troja</g:link>',
    );
    expect(se.body).toContain(
      '<g:price>120.00 SEK</g:price><g:sale_price>100.00 SEK</g:sale_price>',
    );
    // Unknown market: the same opaque 404.
    await expect(
      service.publicFeed('namz', TOKEN, 'google', 'xx'),
    ).rejects.toMatchObject({
      response: { code: 'FEED_NOT_FOUND' },
    });
  });

  it('adds the market country rate on an EXCLUSIVE store', async () => {
    const { service } = build({
      store: store({ tax_pricing_mode: TaxPricingMode.EXCLUSIVE }),
      markets: [SE_MARKET],
      taxRates: [
        {
          id: 'r1',
          store_id: null,
          tax_class_id: 'tc-std',
          country: 'SE',
          region: null,
          postcode_pattern: null,
          rate_bp: 2500,
          label: null,
          priority: 0,
          applies_to_shipping: true,
          is_active: true,
        },
      ],
    });
    const xml = (await service.publicFeed('namz', TOKEN, 'google')).body;
    expect(xml).toContain('<g:price>125.00 SEK</g:price>');
  });

  it('caches a built body for 10 minutes per store + market + format', async () => {
    const { service, calls } = build();
    const first = await service.publicFeed('namz', TOKEN, 'google');
    const second = await service.publicFeed('namz', TOKEN, 'google');
    expect(second.cached).toBe(true);
    expect(second.body).toBe(first.body);
    expect(second.etag).toBe(first.etag);
    expect(calls.productFindMany).toBe(1);
    await service.publicFeed('namz', TOKEN, 'facebook');
    expect(calls.productFindMany).toBe(2);
    service.invalidate(STORE_ID);
    expect((await service.publicFeed('namz', TOKEN, 'google')).cached).toBe(
      false,
    );
  });
});

// ── Creator routes ──────────────────────────────────────────────────────────

describe('FeedsService creator routes', () => {
  it('mySettings generates and stores a token on first read, one URL set without markets', async () => {
    const { service, calls } = build({ settings: {} });
    const view = await service.mySettings(USER_ID);
    expect(view.store_slug).toBe('namz');
    expect(view.settings.token).toMatch(/^[a-f0-9]{32}$/);
    expect(calls.updateSettings).toHaveLength(1);
    expect(view.urls).toEqual([
      {
        market_key: null,
        market_name: null,
        currency: 'SEK',
        google: `https://api.example.com/api/feeds/namz/${view.settings.token}/google.xml`,
        facebook: `https://api.example.com/api/feeds/namz/${view.settings.token}/facebook.csv`,
      },
    ]);
    // Second read keeps the token.
    const again = await service.mySettings(USER_ID);
    expect(again.settings.token).toBe(view.settings.token);
    expect(calls.updateSettings).toHaveLength(1);
  });

  it('lists one URL pair per live market (?market= for non-default ones)', async () => {
    const { service } = build({ markets: [SE_MARKET, EU_MARKET] });
    const view = await service.mySettings(USER_ID);
    expect(view.urls.map((u) => [u.market_key, u.currency, u.google])).toEqual([
      [
        'se',
        'SEK',
        `https://api.example.com/api/feeds/namz/${TOKEN}/google.xml`,
      ],
      [
        'eu',
        'EUR',
        `https://api.example.com/api/feeds/namz/${TOKEN}/google.xml?market=eu`,
      ],
    ]);
  });

  it('rotateToken replaces the token, keeps the other settings and drops the cache', async () => {
    const { service, storeApps } = build({
      settings: { token: TOKEN, default_brand: 'House', facebook: false },
    });
    await service.publicFeed('namz', TOKEN, 'google');
    const view = await service.rotateToken(USER_ID);
    expect(view.settings.token).not.toBe(TOKEN);
    expect(view.settings).toMatchObject({
      default_brand: 'House',
      facebook: false,
      google: true,
    });
    expect(storeApps.settingsChanged).toHaveBeenCalledWith(STORE_ID);
    await expect(
      service.publicFeed('namz', TOKEN, 'google'),
    ).rejects.toBeInstanceOf(NotFoundException);
    const fresh = await service.publicFeed(
      'namz',
      view.settings.token as string,
      'google',
    );
    expect(fresh.cached).toBe(false);
  });

  it('validate reports products missing gtin / brand and bare identifiers', async () => {
    const { service } = build({
      products: [
        product(),
        product({ id: 'p2', gtin: null, mpn: null, brand: null }),
        product({ id: 'p3', gtin: null, mpn: 'M-3' }),
      ],
    });
    const report = await service.validate(USER_ID);
    expect(report.products).toBe(3);
    expect(report.missing_gtin.map((p) => p.id)).toEqual(['p2', 'p3']);
    expect(report.missing_brand.map((p) => p.id)).toEqual(['p2']);
    expect(report.missing_identifier).toBe(1);
    expect(report.currency).toBe('SEK');
    expect(report.market_key).toBeNull();
  });
});

describe('feed helpers', () => {
  it('optionsOf reads colour / size by option name in several languages', () => {
    expect(optionsOf({ Color: 'Red', size: 'M' })).toEqual({
      color: 'Red',
      size: 'M',
    });
    expect(optionsOf({ Storlek: 'L', Farbe: 'Rot' })).toEqual({
      color: 'Rot',
      size: 'L',
    });
    expect(optionsOf({ Material: 'Wool' })).toEqual({
      color: null,
      size: null,
    });
    expect(optionsOf(null)).toEqual({ color: null, size: null });
  });

  it('collectionPath walks parents and stops on cycles', () => {
    const map = new Map([
      ['a', { id: 'a', parent_id: 'b', names: new Map([['en', 'A']]) }],
      ['b', { id: 'b', parent_id: 'a', names: new Map([['en', 'B']]) }],
    ]);
    expect(collectionPath([{ creator_category_id: 'a' }], map, 'en')).toEqual({
      path: 'B > A',
      leaf: 'A',
    });
    expect(collectionPath([{ creator_category_id: 'zz' }], map, 'en')).toEqual({
      path: null,
      leaf: null,
    });
  });
});

describe('FeedsService in-flight de-duplication', () => {
  it('concurrent cache misses for the same feed share one catalogue load', async () => {
    const { service, calls } = build();
    const [a, b, c] = await Promise.all([
      service.publicFeed('namz', TOKEN, 'google'),
      service.publicFeed('namz', TOKEN, 'google'),
      service.publicFeed('namz', TOKEN, 'google'),
    ]);
    expect(calls.productFindMany).toBe(1);
    expect(a.body).toBe(b.body);
    expect(b.body).toBe(c.body);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    // A later request is served from the cache, still one load.
    expect((await service.publicFeed('namz', TOKEN, 'google')).cached).toBe(
      true,
    );
    expect(calls.productFindMany).toBe(1);
  });
});

// M6: the feed category path follows the primary collection.
describe('collectionPath primary collection (M6)', () => {
  const map = new Map([
    ['root', { id: 'root', parent_id: null, names: new Map([['en', 'Root']]) }],
    ['kid', { id: 'kid', parent_id: 'root', names: new Map([['en', 'Kid']]) }],
    [
      'other',
      { id: 'other', parent_id: null, names: new Map([['en', 'Other']]) },
    ],
  ]);
  const links = [
    { creator_category_id: 'other' },
    { creator_category_id: 'kid' },
  ];

  it('uses the primary when set', () => {
    expect(collectionPath(links, map, 'en', 'kid')).toEqual({
      path: 'Root > Kid',
      leaf: 'Kid',
    });
  });

  it('falls back to the first link when the primary is null or unknown', () => {
    expect(collectionPath(links, map, 'en', null)).toEqual({
      path: 'Other',
      leaf: 'Other',
    });
    expect(collectionPath(links, map, 'en', 'gone')).toEqual({
      path: 'Other',
      leaf: 'Other',
    });
  });
});
