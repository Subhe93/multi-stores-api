import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { StoreStatus, StoreType, UserRole } from '@prisma/client';
import { StorefrontService, storeClosedPayload } from './storefront.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import type { MarketPricingService } from '../markets/market-pricing.service';
import type { TaxService } from '../taxes/tax.service';
import { storeClosed, storeNotLive } from '../../common/stores/store-gate';

// SPEC §3 public gates: a non-LIVE store answers the coming-soon / paused
// shell (no catalog), SUSPENDED is 404, search and sitemap are empty, the
// owner preview returns the full payload, and the commerce paths refuse
// with 409 STORE_NOT_LIVE.

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
    theme_customizations: { palette: 'x' },
    theme_config: { primaryColor: '#123456' },
    tax_pricing_mode: 'INCLUSIVE',
    tax_basis: 'SHIPPING',
    tax_country: 'SE',
    oss_registered: false,
    use_platform_tax_rates: true,
    shipping_tax_class_id: null,
    display_prices_incl_tax: true,
    clarity_project_id: 'sxtuobatm6',
    consent_required: true,
    checkout_settings: null,
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
      findFirst: jest.fn(({ where }: { where: { creator: { user_id: string } } }) =>
        Promise.resolve(where.creator.user_id === 'owner' ? { id: 's1' } : null),
      ),
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
    product: { findMany: jest.fn(() => Promise.resolve([])), count: jest.fn(() => Promise.resolve(0)) },
    customProduct: { findMany: jest.fn(() => Promise.resolve([])), count: jest.fn(() => Promise.resolve(0)) },
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
  return { service, prisma };
}

describe('GET /storefront/:slug gate', () => {
  it('DRAFT / PENDING_REVIEW / CHANGES_REQUESTED → coming_soon shell without a catalog', async () => {
    for (const status of [
      StoreStatus.DRAFT,
      StoreStatus.PENDING_REVIEW,
      StoreStatus.CHANGES_REQUESTED,
    ]) {
      const { service, prisma } = build(status);
      const res = (await service.getStore('namez')) as Record<string, unknown>;
      expect(res).toMatchObject({
        status,
        coming_soon: true,
        paused: false,
        name: 'Namez',
        logo_url: '/logo.png',
        theme_key: 'bold',
        theme_customizations: { palette: 'x' },
        theme: { primaryColor: '#123456' },
        indexing: 'noindex',
        pages: [],
      });
      expect(res).not.toHaveProperty('card_payments_enabled');
      expect(res).not.toHaveProperty('tax');
      // No tracker (Clarity included) is loaded on the closed shell.
      expect(res).not.toHaveProperty('tracking');
      // No catalog queries were made.
      expect(prisma.page.findMany).not.toHaveBeenCalled();
    }
  });

  it('PAUSED → the same shell with paused: true', async () => {
    const { service } = build(StoreStatus.PAUSED);
    expect(await service.getStore('namez')).toMatchObject({
      status: 'PAUSED',
      coming_soon: false,
      paused: true,
    });
  });

  it('SUSPENDED → 404 like an unknown slug', async () => {
    const { service } = build(StoreStatus.SUSPENDED);
    await expect(service.getStore('namez')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('LIVE → the full payload', async () => {
    const { service } = build(StoreStatus.LIVE);
    const res = (await service.getStore('namez')) as Record<string, unknown>;
    expect(res).toHaveProperty('card_payments_enabled');
    expect(res).toHaveProperty('tax');
    expect(res).not.toHaveProperty('coming_soon');
    expect(res).toMatchObject({
      tracking: { clarity_project_id: 'sxtuobatm6', consent_required: true },
    });
  });

  it('owner preview: full payload for the owner or an admin, 403 for others', async () => {
    const { service } = build(StoreStatus.DRAFT);
    const owner = (await service.ownerPreview('namez', {
      id: 'owner',
      role: UserRole.CREATOR,
    })) as Record<string, unknown>;
    expect(owner).toMatchObject({ preview: true, status: 'DRAFT' });
    expect(owner).toHaveProperty('card_payments_enabled');
    await expect(
      service.ownerPreview('namez', { id: 'admin', role: UserRole.ADMIN }),
    ).resolves.toMatchObject({ preview: true });
    await expect(
      service.ownerPreview('namez', { id: 'stranger', role: UserRole.CREATOR }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('search and sitemap of a non-LIVE store are empty', async () => {
    const { service, prisma } = build(StoreStatus.DRAFT);
    await expect(
      service.getProducts('namez', { search: 'mug', page: 2, limit: 5 }),
    ).resolves.toEqual([]);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    await expect(service.getSitemapData('namez')).resolves.toMatchObject({
      indexing: 'noindex',
      products: [],
      collections: [],
      static_pages: [],
      locales: ['sv', 'en'],
    });
  });

  it('storeClosedPayload tolerates a store without theme or languages', () => {
    const out = storeClosedPayload('x', {
      status: StoreStatus.DRAFT,
      name: 'X',
      logo_url: null,
      theme_key: '',
      theme_customizations: null,
      theme_config: null,
      language_config: null,
    });
    expect(out).toMatchObject({ theme_key: 'minimal', language_config: null });
  });
});

describe('commerce gate helpers (cart / checkout / orders)', () => {
  it('storeNotLive is 409 STORE_NOT_LIVE', () => {
    const err = storeNotLive();
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'STORE_NOT_LIVE' });
  });

  it('storeClosed judges by status, else by the derived is_active', () => {
    expect(storeClosed({ status: 'LIVE', is_active: true })).toBe(false);
    expect(storeClosed({ status: 'DRAFT', is_active: false })).toBe(true);
    expect(storeClosed({ is_active: false })).toBe(true);
    expect(storeClosed({ is_active: true })).toBe(false);
    expect(storeClosed(null)).toBe(false);
  });
});
