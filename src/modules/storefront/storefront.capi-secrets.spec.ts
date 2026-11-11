import { StoreStatus, StoreType, UserRole } from '@prisma/client';
import { StorefrontService } from './storefront.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import type { MarketPricingService } from '../markets/market-pricing.service';
import type { TaxService } from '../taxes/tax.service';

// The public storefront payload (GET /storefront/:slug, its closed shell and
// the owner preview) never carries the Meta Conversions API token, whether
// one is set, or the test event code, even when the row was read with them.

const ENCRYPTED_TOKEN = 'v2:kms:ZW5jcnlwdGVkLW1ldGEtY2FwaS10b2tlbg==';
const TEST_CODE = 'TEST12345';

function build(status: StoreStatus) {
  const store = {
    id: 's1',
    slug: 'namez',
    name: 'Namez',
    logo_url: '/logo.png',
    creator_id: 'c1',
    store_type: StoreType.INDEPENDENT,
    currency: 'EUR',
    status,
    is_active: status === StoreStatus.LIVE,
    theme_key: 'bold',
    theme_customizations: {},
    theme_config: {},
    tax_pricing_mode: 'INCLUSIVE',
    tax_basis: 'SHIPPING',
    tax_country: 'SE',
    oss_registered: false,
    use_platform_tax_rates: true,
    shipping_tax_class_id: null,
    display_prices_incl_tax: true,
    checkout_settings: null,
    ga4_measurement_id: 'G-ABCD1234',
    meta_pixel_id: '123456789012345',
    tiktok_pixel_id: null,
    consent_required: true,
    // Worst case: the row carries the server-side columns.
    meta_capi_token: ENCRYPTED_TOKEN,
    meta_test_event_code: TEST_CODE,
    language_config: {
      primary_locale: 'sv',
      secondary_locales: ['en'],
      auto_translate: false,
      fallback_locale: 'en',
    },
    static_pages: [],
    creator: {
      id: 'c1',
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
    store: {
      findUnique: jest.fn(() => Promise.resolve(store)),
      findFirst: jest.fn(() => Promise.resolve({ id: 's1' })),
    },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'EUR' })),
    },
    creator: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          kustom_enabled: false,
          kustom_merchant_id: null,
          kustom_shared_secret: null,
        }),
      ),
    },
    page: { findMany: jest.fn(() => Promise.resolve([])) },
  };
  const storeApps = { storefrontApps: jest.fn(() => Promise.resolve({})) };
  const markets = {
    resolve: jest.fn(() => Promise.resolve(null)),
    listLive: jest.fn(() => Promise.resolve(null)),
  };
  const service = new StorefrontService(
    prisma as unknown as PrismaService,
    storeApps as unknown as StoreAppsService,
    markets as unknown as MarketsContextService,
    {} as MarketPricingService,
    {} as TaxService,
  );
  return { service };
}

function expectNoServerTracking(payload: unknown) {
  const json = JSON.stringify(payload);
  expect(json).not.toContain(ENCRYPTED_TOKEN);
  expect(json).not.toContain(TEST_CODE);
  expect(json).not.toContain('meta_capi_token');
  expect(json).not.toContain('meta_test_event_code');
}

describe('storefront payload: Meta Conversions API columns never travel', () => {
  it('LIVE store: only the public tracking ids are exposed', async () => {
    const { service } = build(StoreStatus.LIVE);
    const res = (await service.getStore('namez')) as Record<string, unknown>;
    expect(res.tracking).toEqual({
      ga4_measurement_id: 'G-ABCD1234',
      meta_pixel_id: '123456789012345',
      tiktok_pixel_id: null,
      consent_required: true,
    });
    expectNoServerTracking(res);
  });

  it('closed store shell (coming soon / paused)', async () => {
    for (const status of [StoreStatus.DRAFT, StoreStatus.PAUSED]) {
      const { service } = build(status);
      expectNoServerTracking(await service.getStore('namez'));
    }
  });

  it('owner / admin preview of the storefront payload', async () => {
    const { service } = build(StoreStatus.DRAFT);
    for (const viewer of [
      { id: 'owner', role: UserRole.CREATOR },
      { id: 'admin', role: UserRole.ADMIN },
    ]) {
      const res = await service.ownerPreview('namez', viewer);
      expect(res).toMatchObject({ preview: true });
      expectNoServerTracking(res);
    }
  });
});
