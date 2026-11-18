import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { StoreStatus, StoreType, UserRole } from '@prisma/client';
import {
  PRIVATE_STORE_KEYS,
  StorefrontService,
  type StoreClosedPayload,
} from './storefront.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import type { MarketPricingService } from '../markets/market-pricing.service';
import type { TaxService } from '../taxes/tax.service';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';

// Public storefront contract (plans/headless-booking D2, docs/storefront-api.md).
// External sites (the Prima Trafikskola custom site) read these payloads
// server-side. This spec fails when a documented key disappears or when a
// blocklisted (private) key appears. Adding a NEW nullable key is allowed
// (additive policy) and must be documented in docs/storefront-api.md.

/** Keys the docs promise on GET /storefront/:slug (LIVE store). */
const STORE_DOCUMENTED_KEYS = [
  'id',
  'slug',
  'name',
  'description',
  'logo_url',
  'favicon_url',
  'custom_domain',
  'status',
  'is_active',
  'store_type',
  'currency',
  'language_config',
  'tax',
  'seller_details',
  'card_payments_enabled',
  'kustom_enabled',
  'apps',
  'tracking',
  'pages',
  'cookie_page_slug',
  'theme_key',
  'theme_customizations',
  'theme',
] as const;

/** Keys that must never be in the public store payload. */
const STORE_BLOCKLIST = [
  ...PRIVATE_STORE_KEYS,
  'meta_capi_token',
  'meta_test_event_code',
  'checkout_settings',
  'ga4_measurement_id',
  'meta_pixel_id',
  'tiktok_pixel_id',
  'clarity_project_id',
  'consent_required',
] as const;

/** Keys the docs promise on every own product (list and detail). */
const PRODUCT_DOCUMENTED_KEYS = [
  'id',
  'status',
  'product_type',
  'base_price',
  'track_inventory',
  'stock_quantity',
  'translations',
  'images',
  'variants',
  'promotions',
  'created_at',
  'updated_at',
] as const;

/** Merchant-only product columns that never travel. */
const PRODUCT_BLOCKLIST = [
  'cost_price',
  'external_ref',
  'gtin',
  'mpn',
  'google_product_category',
  'condition',
  'feed_excluded',
  'tags',
] as const;

/**
 * Documented additive product keys: they pass through when the column has a
 * value (own-product scalars are spread). `max_per_order` is added by
 * headless-booking B2a, `requires_shipping` by the no-shipping products
 * feature; the spec pins that the read path carries them.
 */
const PRODUCT_ADDITIVE_KEYS = {
  max_per_order: 2,
  // "Physical product" setting (always present on own products).
  requires_shipping: true,
} as const;

const PRIVATE_VALUES = {
  notification_email: 'owner-private@example.com',
  status_reason: 'Internal admin note',
  golive_requested_at: new Date('2026-11-01T10:00:00Z'),
  stripe_key_lock_until: new Date('2026-11-15T10:00:00Z'),
  cache_enabled: false,
  oss_registered: true,
  shipping_tax_class_id: 'tax-class-private',
};

function storeRow(status: StoreStatus) {
  return {
    id: 's1',
    slug: 'prima',
    custom_domain: 'boka.example.se',
    name: 'Prima',
    description: 'Driving school',
    logo_url: '/uploads/logo.webp',
    favicon_url: null,
    creator_id: 'c1',
    store_type: StoreType.INDEPENDENT,
    currency: 'SEK',
    status,
    went_live_at: null,
    trader_details: null,
    is_active: status === StoreStatus.LIVE,
    cod_enabled: false,
    show_vendor_name: false,
    tax_rate_bp: null,
    theme_key: 'minimal',
    theme_customizations: {},
    theme_config: {},
    tax_pricing_mode: 'INCLUSIVE',
    tax_basis: 'SHIPPING',
    tax_country: 'SE',
    use_platform_tax_rates: true,
    display_prices_incl_tax: true,
    checkout_settings: null,
    ga4_measurement_id: null,
    meta_pixel_id: null,
    tiktok_pixel_id: null,
    clarity_project_id: null,
    consent_required: true,
    meta_capi_token: null,
    meta_test_event_code: null,
    created_at: new Date('2026-10-01T10:00:00Z'),
    updated_at: new Date('2026-11-01T10:00:00Z'),
    // Worst case: every private column is set.
    ...PRIVATE_VALUES,
    language_config: {
      id: 'lc1',
      store_id: 's1',
      primary_locale: 'sv',
      secondary_locales: ['en'],
      auto_translate: false,
      fallback_locale: 'en',
    },
    static_pages: [],
    creator: {
      display_name: 'Prima',
      avatar_url: null,
      bio: null,
      cover_url: null,
      stripe_payouts_enabled: false,
      stripe_charges_enabled: false,
      stripe_account_type: null,
    },
    stripe_keys: null,
  };
}

function buildStore(status: StoreStatus) {
  const store = storeRow(status);
  const prisma = {
    store: {
      findUnique: jest.fn(() => Promise.resolve(store)),
      findFirst: jest.fn(() => Promise.resolve({ id: 's1' })),
    },
    platformConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve({ default_currency: 'SEK', tax_country: 'SE' }),
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
  const service = new StorefrontService(
    prisma as unknown as PrismaService,
    {
      storefrontApps: jest.fn(() => Promise.resolve({})),
    } as unknown as StoreAppsService,
    {
      resolve: jest.fn(() => Promise.resolve(null)),
      listLive: jest.fn(() => Promise.resolve(null)),
    } as unknown as MarketsContextService,
    {} as MarketPricingService,
    {} as TaxService,
  );
  return { service };
}

function expectNoPrivateStoreData(payload: unknown) {
  const obj = payload as Record<string, unknown>;
  for (const key of STORE_BLOCKLIST) expect(obj).not.toHaveProperty(key);
  const json = JSON.stringify(payload);
  expect(json).not.toContain(PRIVATE_VALUES.notification_email);
  expect(json).not.toContain(PRIVATE_VALUES.status_reason);
  expect(json).not.toContain(PRIVATE_VALUES.shipping_tax_class_id);
}

describe('public contract: GET /storefront/:slug', () => {
  it('the blocklist names exactly the D3 private columns', () => {
    expect([...PRIVATE_STORE_KEYS].sort()).toEqual(
      Object.keys(PRIVATE_VALUES).sort(),
    );
  });

  it('LIVE store: documented keys present, private columns absent', async () => {
    const { service } = buildStore(StoreStatus.LIVE);
    const payload = (await service.getStore('prima')) as Exclude<
      Awaited<ReturnType<StorefrontService['getStore']>>,
      StoreClosedPayload
    >;
    for (const key of STORE_DOCUMENTED_KEYS)
      expect(payload).toHaveProperty(key);
    expect(payload).toMatchObject({
      slug: 'prima',
      currency: 'SEK',
      store_type: StoreType.INDEPENDENT,
      language_config: { primary_locale: 'sv', secondary_locales: ['en'] },
      tax: {
        pricing_mode: 'INCLUSIVE',
        display_prices_incl_tax: true,
        country: 'SE',
      },
      kustom_enabled: true,
      apps: {},
      tracking: {
        ga4_measurement_id: null,
        meta_pixel_id: null,
        tiktok_pixel_id: null,
        clarity_project_id: null,
        consent_required: true,
      },
      pages: [],
      cookie_page_slug: null,
    });
    expectNoPrivateStoreData(payload);
  });

  it('owner preview (non-LIVE) never carries the private columns either', async () => {
    const { service } = buildStore(StoreStatus.PENDING_REVIEW);
    const res = await service.ownerPreview('prima', {
      id: 'admin',
      role: UserRole.ADMIN,
    });
    expect(res).toMatchObject({ preview: true, slug: 'prima' });
    expectNoPrivateStoreData(res);
  });

  it('closed shell: no catalog, no private data', async () => {
    const { service } = buildStore(StoreStatus.DRAFT);
    const res = await service.getStore('prima');
    expect(res).toMatchObject({ coming_soon: true, is_active: false });
    expectNoPrivateStoreData(res);
  });
});

function ownProductRow() {
  return {
    id: 'p1',
    provider_id: null,
    creator_id: 'c1',
    category_id: 'cat1',
    product_type: 'TRADITIONAL',
    customization_type: null,
    base_price: 4500,
    compare_at_price: null,
    cost_price: 1200,
    sku: 'RISK1-2026-12-01',
    track_inventory: true,
    stock_quantity: 3,
    weight: null,
    weight_unit: 'kg',
    variant_option_config: null,
    shipping_profile_id: null,
    tax_class_id: null,
    tax_exempt: false,
    status: 'PUBLISHED',
    is_featured: false,
    external_ref: 'wc-123',
    gtin: '4006381333931',
    mpn: 'M-1',
    brand: null,
    google_product_category: '1604',
    condition: 'new',
    feed_excluded: false,
    primary_creator_category_id: null,
    created_at: new Date('2026-11-01T10:00:00Z'),
    updated_at: new Date('2026-11-02T10:00:00Z'),
    ...PRODUCT_ADDITIVE_KEYS,
    translations: [
      {
        id: 't1',
        product_id: 'p1',
        locale: 'sv',
        title: 'Riskettan 2026-12-01 17:00',
        description: '<p>Kurs</p>',
        slug: 'riskettan-2026-12-01',
        meta_title: null,
        meta_desc: null,
        short_description: null,
      },
    ],
    images: [
      {
        id: 'i1',
        product_id: 'p1',
        variant_id: null,
        url: '/uploads/products/risk1.webp',
        alt_text: null,
        sort_order: 0,
        is_featured: true,
      },
    ],
    variants: [
      {
        id: 'v1',
        product_id: 'p1',
        sku: null,
        price_adjustment: 500,
        compare_at_price: null,
        stock_quantity: null,
        is_active: true,
        options: { language: 'English' },
        external_ref: 'wc-var-1',
        images: [],
      },
    ],
    category: null,
    attributes: [],
    creator_categories: [],
    custom_fields: [],
    faqs: [],
    shipping_profile: null,
  };
}

function buildCatalog() {
  const store = {
    id: 's1',
    slug: 'prima',
    creator_id: 'c1',
    store_type: StoreType.INDEPENDENT,
    status: StoreStatus.LIVE,
    show_vendor_name: false,
    currency: 'SEK',
    tax_country: 'SE',
    creator: { id: 'c1' },
  };
  const prisma = {
    store: { findUnique: jest.fn(() => Promise.resolve(store)) },
    product: {
      findMany: jest.fn(() => Promise.resolve([ownProductRow()])),
      findFirst: jest.fn(() => Promise.resolve(ownProductRow())),
    },
    customProduct: {
      findMany: jest.fn(() => Promise.resolve([])),
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
    promotion: { findMany: jest.fn(() => Promise.resolve([])) },
    bundle: { findMany: jest.fn(() => Promise.resolve([])) },
    creatorCategory: {
      findMany: jest.fn(() =>
        Promise.resolve([
          {
            id: 'cc1',
            creator_id: 'c1',
            parent_id: null,
            slug: 'riskettan',
            thumbnail_url: null,
            match_rule: 'MANUAL',
            match_tags: [],
            sort_order: 0,
            is_active: true,
            external_ref: 'wc-cat-1',
            noindex_when_empty: false,
            visibility: 'PUBLIC',
            created_at: new Date('2026-10-01T10:00:00Z'),
            updated_at: new Date('2026-10-01T10:00:00Z'),
            translations: [
              {
                id: 'cct1',
                creator_category_id: 'cc1',
                locale: 'sv',
                name: 'Riskettan',
                description: null,
                long_description: null,
                meta_title: null,
                meta_desc: null,
              },
            ],
          },
        ]),
      ),
    },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'SEK' })),
    },
  };
  const service = new StorefrontService(
    prisma as unknown as PrismaService,
    {
      isEnabled: jest.fn(() => Promise.resolve(false)),
      getSettings: jest.fn(() => Promise.resolve({})),
    } as unknown as StoreAppsService,
    {
      resolve: jest.fn(() => Promise.resolve(null)),
    } as unknown as MarketsContextService,
    {} as MarketPricingService,
    {} as TaxService,
  );
  return { service, prisma };
}

function expectProductContract(p: Record<string, unknown>) {
  for (const key of PRODUCT_DOCUMENTED_KEYS) expect(p).toHaveProperty(key);
  for (const key of PRODUCT_BLOCKLIST) expect(p).not.toHaveProperty(key);
  expect(p).toMatchObject({
    id: 'p1',
    status: 'PUBLISHED',
    // Decimal columns arrive as numbers; base_price is in the store
    // currency and includes tax when tax.pricing_mode is INCLUSIVE.
    base_price: 4500,
    track_inventory: true,
    stock_quantity: 3,
    translations: [
      {
        locale: 'sv',
        title: 'Riskettan 2026-12-01 17:00',
        slug: 'riskettan-2026-12-01',
      },
    ],
    images: [{ url: '/uploads/products/risk1.webp', sort_order: 0 }],
    promotions: [],
    ...PRODUCT_ADDITIVE_KEYS,
  });
  const variants = p.variants as Record<string, unknown>[];
  expect(variants).toHaveLength(1);
  // price = base_price + price_adjustment; an untracked variant stock
  // (null) is served as 999.
  expect(variants[0]).toMatchObject({
    id: 'v1',
    price: 5000,
    stock: 999,
    options: { language: 'English' },
  });
  expect(variants[0]).not.toHaveProperty('external_ref');
  expect(JSON.stringify(p)).not.toContain('wc-');
}

describe('public contract: products', () => {
  it('GET /storefront/:slug/products is a plain (unpaginated) array of the documented shape', async () => {
    const { service } = buildCatalog();
    const list = (await service.getProducts('prima', {
      page: 2,
      limit: 1,
    })) as Record<string, unknown>[];
    expect(Array.isArray(list)).toBe(true);
    // page / limit are accepted and ignored.
    expect(list).toHaveLength(1);
    expectProductContract(list[0]);
  });

  it('GET /storefront/:slug/products/:productSlug carries the same core keys', async () => {
    const { service } = buildCatalog();
    const p = (await service.getProduct(
      'prima',
      'riskettan-2026-12-01',
    )) as Record<string, unknown>;
    expectProductContract(p);
    expect(p).toHaveProperty('custom_fields');
    expect(p).toHaveProperty('bundles');
    // Empty video / story relations are omitted entirely.
    expect(p).not.toHaveProperty('videos');
    expect(p).not.toHaveProperty('stories');
  });

  it('email_note (headless booking E2) is never requested nor served', async () => {
    // PrismaService omits ProductTranslation.email_note globally; a read only
    // gets it by naming the column. The storefront never does.
    const { service, prisma } = buildCatalog();
    const list = await service.getProducts('prima', {});
    const one = await service.getProduct('prima', 'riskettan-2026-12-01');
    expect(JSON.stringify([list, one])).not.toContain('email_note');
    const args = [
      ...prisma.product.findMany.mock.calls,
      ...prisma.product.findFirst.mock.calls,
    ];
    expect(args.length).toBeGreaterThan(0);
    expect(JSON.stringify(args)).not.toContain('email_note');
  });

  it('GET /storefront/:slug/creator-categories hides importer and rule internals', async () => {
    const { service } = buildCatalog();
    const tree = (await service.getCreatorCategories('prima')) as Record<
      string,
      unknown
    >[];
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      id: 'cc1',
      slug: 'riskettan',
      parent_id: null,
      path: ['riskettan'],
      children: [],
      translations: [{ locale: 'sv', name: 'Riskettan' }],
    });
    for (const key of [
      'external_ref',
      'creator_id',
      'match_rule',
      'match_tags',
    ]) {
      expect(tree[0]).not.toHaveProperty(key);
    }
  });
});

// Imported (custom) products of a MARKETPLACE store: the SELLING price only
// (never the provider's cost price) and, since the imported-stock fix, the
// provider's stock of the base product with the own-product semantics.

/** Keys the docs promise on every imported product (list and detail). */
const CUSTOM_PRODUCT_DOCUMENTED_KEYS = [
  'id',
  'status',
  'base_price',
  'track_inventory',
  'stock_quantity',
  'translations',
  'images',
  'variants',
  'pricing_type',
  '_type',
] as const;

function baseProviderRow() {
  return {
    ...ownProductRow(),
    id: 'base1',
    provider_id: 'prov1',
    creator_id: null,
    base_price: 45,
    cost_price: 12,
    compare_at_price: null,
    track_inventory: true,
    stock_quantity: 7,
    external_ref: 'wc-base',
    variants: [],
    provider: { id: 'prov1', company_name: 'Newroj', logo_url: null },
    videos: [],
    stories: [],
  };
}

function customProductRow() {
  return {
    id: 'cp1',
    creator_id: 'c1',
    product_id: 'base1',
    status: 'PUBLISHED',
    pricing_type: 'SINGLE',
    final_price: 150,
    margin_amount: null,
    primary_creator_category_id: null,
    created_at: new Date('2026-11-01T10:00:00Z'),
    updated_at: new Date('2026-11-02T10:00:00Z'),
    translations: [
      { id: 'ct1', locale: 'sv', title: 'Hoodie', slug: 'hoodie' },
    ],
    mockup_images: [{ id: 'm1', url: '/uploads/mockup.webp', sort_order: 0 }],
    selected_variants: [],
    field_values: [],
    faqs: [],
    creator_categories: [],
    product: baseProviderRow(),
  };
}

function buildCustomCatalog() {
  const store = {
    id: 's1',
    slug: 'shop',
    creator_id: 'c1',
    store_type: StoreType.MARKETPLACE,
    status: StoreStatus.LIVE,
    show_vendor_name: false,
    currency: 'SEK',
    tax_country: 'SE',
    creator: { id: 'c1' },
  };
  const prisma = {
    store: { findUnique: jest.fn(() => Promise.resolve(store)) },
    product: {
      findMany: jest.fn(() => Promise.resolve([])),
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
    customProduct: {
      findMany: jest.fn(() => Promise.resolve([customProductRow()])),
      findFirst: jest.fn(() => Promise.resolve(customProductRow())),
    },
    shippingProfile: { findFirst: jest.fn(() => Promise.resolve(null)) },
    promotion: { findMany: jest.fn(() => Promise.resolve([])) },
    bundle: { findMany: jest.fn(() => Promise.resolve([])) },
    creatorCategory: { findMany: jest.fn(() => Promise.resolve([])) },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'SEK' })),
    },
  };
  const service = new StorefrontService(
    prisma as unknown as PrismaService,
    {
      isEnabled: jest.fn(() => Promise.resolve(false)),
      getSettings: jest.fn(() => Promise.resolve({})),
    } as unknown as StoreAppsService,
    {
      resolve: jest.fn(() => Promise.resolve(null)),
    } as unknown as MarketsContextService,
    {} as MarketPricingService,
    {} as TaxService,
  );
  return { service, prisma };
}

function expectCustomProductContract(p: Record<string, unknown>) {
  for (const key of CUSTOM_PRODUCT_DOCUMENTED_KEYS) {
    expect(p).toHaveProperty(key);
  }
  expect(p).toMatchObject({
    id: 'cp1',
    _type: 'custom_product',
    // The creator's selling price, never the provider's 45.
    base_price: 150,
    // The provider's stock of the base product.
    track_inventory: true,
    stock_quantity: 7,
  });
  const json = JSON.stringify(p);
  expect(p).not.toHaveProperty('cost_price');
  expect(json).not.toContain('cost_price');
  expect(json).not.toContain('"base_price":45');
  expect(json).not.toContain('wc-');
}

describe('public contract: imported (custom) products', () => {
  it('the list row carries the selling price and the base product stock', async () => {
    const { service } = buildCustomCatalog();
    const list = (await service.getProducts('shop', {})) as Record<
      string,
      unknown
    >[];
    expect(list).toHaveLength(1);
    expectCustomProductContract(list[0]);
  });

  it('the detail carries the same keys', async () => {
    const { service } = buildCustomCatalog();
    const p = (await service.getProduct('shop', 'hoodie')) as Record<
      string,
      unknown
    >;
    expectCustomProductContract(p);
  });

  it('an untracked base product reads as untracked', async () => {
    const { service, prisma } = buildCustomCatalog();
    const row = customProductRow();
    row.product = {
      ...row.product,
      track_inventory: false,
      stock_quantity: null as unknown as number,
    };
    prisma.customProduct.findMany.mockResolvedValueOnce([row]);
    const [p] = (await service.getProducts('shop', {})) as Record<
      string,
      unknown
    >[];
    expect(p).toMatchObject({ track_inventory: false, stock_quantity: null });
  });
});

describe('public contract: envelope', () => {
  it('every success is wrapped as { success: true, data, timestamp }', async () => {
    const out = await lastValueFrom(
      new TransformInterceptor().intercept(
        {} as ExecutionContext,
        { handle: () => of([{ id: 'p1' }]) } as CallHandler,
      ),
    );
    expect(out).toMatchObject({ success: true, data: [{ id: 'p1' }] });
    expect(Object.keys(out).sort()).toEqual(['data', 'success', 'timestamp']);
    expect(typeof (out as { timestamp: unknown }).timestamp).toBe('string');
  });
});

// "Store without customer accounts" and the return button label: additive
// keys of the `checkout` block, served only when true / set. The strict
// cases above cover the stores without them.
describe('public contract: checkout block additive keys', () => {
  const base = {
    after_add_to_cart: 'stay',
    phone_required: false,
    pay_button_label: null,
    coupon_param: ['coupon'],
    coupon_autoapply: false,
  };
  const site = {
    ...base,
    external_site_url: 'https://example.se/',
    return_url: null,
    return_mode: 'button',
    back_label: null,
  };

  async function checkoutOf(settings: unknown) {
    const { service } = buildStore(StoreStatus.LIVE);
    const prisma = (
      service as unknown as {
        prisma: {
          store: { findUnique: () => Promise<{ checkout_settings: unknown }> };
        };
      }
    ).prisma;
    (await prisma.store.findUnique()).checkout_settings = settings;
    const payload = (await service.getStore('prima')) as unknown as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty('checkout_settings');
    return payload;
  }

  it('no_customer_accounts: true only while on', async () => {
    expect(
      (await checkoutOf({ no_customer_accounts: true })).checkout,
    ).toStrictEqual({ ...base, no_customer_accounts: true });
    for (const off of [
      null,
      {},
      { no_customer_accounts: false },
      { no_customer_accounts: 'true' },
    ])
      expect(await checkoutOf(off)).not.toHaveProperty('checkout');
  });

  it('return_label: only when set next to a valid external site', async () => {
    expect(
      (
        await checkoutOf({
          external_site_url: 'https://example.se/',
          return_label: { sv: 'Till bokningen' },
          no_customer_accounts: true,
        })
      ).checkout,
    ).toStrictEqual({
      ...site,
      return_label: { sv: 'Till bokningen' },
      no_customer_accounts: true,
    });
    expect(
      await checkoutOf({ return_label: { sv: 'Till bokningen' } }),
    ).not.toHaveProperty('checkout');
  });

  it('a store with a site but without the new keys keeps its exact block', async () => {
    for (const settings of [
      { external_site_url: 'https://example.se/' },
      { external_site_url: 'https://example.se/', return_label: {} },
      { external_site_url: 'https://example.se/', return_label: null },
    ])
      expect((await checkoutOf(settings)).checkout).toStrictEqual(site);
  });
});
