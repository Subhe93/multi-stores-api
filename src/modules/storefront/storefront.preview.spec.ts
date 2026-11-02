import { NotFoundException } from '@nestjs/common';
import { StoreStatus, StoreType, UserRole } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { StorefrontService } from './storefront.service';
import {
  StorefrontGateService,
  StorefrontViewerGuard,
} from './storefront-gate.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import type { MarketPricingService } from '../markets/market-pricing.service';
import type { TaxService } from '../taxes/tax.service';

// SPEC §3 owner preview, applied to every public storefront read: a
// non-LIVE store is served in full to its owner / an admin (valid bearer
// token) and closed to anonymous callers and other creators. LIVE stays
// byte-identical (no gate query at all).

const USERS: Record<string, { id: string; role: UserRole; status: string; store_id: null; tokens_valid_after: null }> = {
  owner: { id: 'owner', role: UserRole.CREATOR, status: 'ACTIVE', store_id: null, tokens_valid_after: null },
  other: { id: 'other', role: UserRole.CREATOR, status: 'PENDING', store_id: null, tokens_valid_after: null },
  admin: { id: 'admin', role: UserRole.ADMIN, status: 'ACTIVE', store_id: null, tokens_valid_after: null },
  banned: { id: 'banned', role: UserRole.CREATOR, status: 'BANNED', store_id: null, tokens_valid_after: null },
};

function build(status: StoreStatus) {
  const store = {
    id: 's1',
    slug: 'namez',
    name: 'Namez',
    logo_url: null,
    creator_id: 'c1',
    store_type: StoreType.INDEPENDENT,
    currency: 'EUR',
    status,
    is_active: status === StoreStatus.LIVE,
    theme_key: 'minimal',
    theme_customizations: {},
    theme_config: {},
    tax_pricing_mode: 'INCLUSIVE',
    tax_basis: 'SHIPPING',
    tax_country: 'SE',
    oss_registered: false,
    use_platform_tax_rates: true,
    shipping_tax_class_id: null,
    display_prices_incl_tax: true,
    consent_required: true,
    checkout_settings: null,
    language_config: { primary_locale: 'sv', secondary_locales: [], auto_translate: false, fallback_locale: 'en' },
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
  const ownerLookups = jest.fn(({ where }: { where: { id: string; creator: { user_id: string } } }) =>
    Promise.resolve(where.creator.user_id === 'owner' ? { id: 's1' } : null),
  );
  const prisma = {
    store: { findUnique: jest.fn(() => Promise.resolve(store)), findFirst: ownerLookups },
    user: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(USERS[where.id] ?? null),
      ),
    },
    platformConfig: { findFirst: jest.fn(() => Promise.resolve({ default_currency: 'EUR' })) },
    creator: {
      findUnique: jest.fn(() =>
        Promise.resolve({ kustom_enabled: false, kustom_merchant_id: null, kustom_shared_secret: null }),
      ),
    },
    page: {
      findMany: jest.fn(() => Promise.resolve([])),
      findFirst: jest.fn(() => Promise.resolve({ id: 'pg', published_version: { sections: [] } })),
    },
    staticPage: {
      findFirst: jest.fn(() =>
        Promise.resolve({ id: 'sp', slug: 'about', status: 'PUBLISHED', translations: [] }),
      ),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    promotion: { findMany: jest.fn(() => Promise.resolve([])) },
    productCreatorCategory: { findMany: jest.fn(() => Promise.resolve([])) },
    customProductCreatorCategory: { findMany: jest.fn(() => Promise.resolve([])) },
    product: {
      findMany: jest.fn(() => Promise.resolve([])),
      count: jest.fn(() => Promise.resolve(0)),
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
    customProduct: {
      findMany: jest.fn(() => Promise.resolve([])),
      count: jest.fn(() => Promise.resolve(0)),
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
    category: { findMany: jest.fn(() => Promise.resolve([])) },
    creatorCategory: { findMany: jest.fn(() => Promise.resolve([])) },
    menu: { findMany: jest.fn(() => Promise.resolve([{ id: 'm1', key: 'main', items: [] }])) },
    legalPage: { findMany: jest.fn(() => Promise.resolve([])) },
  };
  // Tokens are "<userId>" verified by a stub JwtService; "bad" fails.
  const jwt = {
    verify: jest.fn((token: string) => {
      if (token === 'bad') throw new Error('invalid');
      return { sub: token, role: USERS[token]?.role, store_id: null, iat: 1 };
    }),
  };
  const config = { get: (k: string) => (k === 'JWT_SECRET' ? 's' : undefined) };
  const gate = new StorefrontGateService(
    prisma as unknown as PrismaService,
    jwt as unknown as JwtService,
    config as unknown as ConfigService,
  );
  const service = new StorefrontService(
    prisma as unknown as PrismaService,
    {
      storefrontApps: jest.fn(() => Promise.resolve({})),
      isEnabled: jest.fn(() => Promise.resolve(false)),
    } as unknown as StoreAppsService,
    { resolve: jest.fn(() => Promise.resolve(null)), listLive: jest.fn(() => Promise.resolve(null)) } as unknown as MarketsContextService,
    {} as MarketPricingService,
    {} as TaxService,
    undefined,
    undefined,
    gate,
  );
  return { service, gate, prisma, ownerLookups };
}

const viewer = (id: string) => ({ id, role: USERS[id].role });

describe('StorefrontGateService.viewerFromRequest (never throws)', () => {
  it('resolves a valid bearer token; anonymous / bad / revoked → null', async () => {
    const { gate } = build(StoreStatus.DRAFT);
    const req = (auth?: string) => ({ headers: auth ? { authorization: auth } : {} });
    expect(await gate.viewerFromRequest(req())).toBeNull();
    expect(await gate.viewerFromRequest(req('Bearer bad'))).toBeNull();
    expect(await gate.viewerFromRequest(req('Basic abc'))).toBeNull();
    expect(await gate.viewerFromRequest(req('Bearer banned'))).toBeNull();
    expect(await gate.viewerFromRequest(req('Bearer nobody'))).toBeNull();
    expect(await gate.viewerFromRequest(req('Bearer owner'))).toEqual({ id: 'owner', role: 'CREATOR' });
    // A PENDING (unverified) creator still counts as a viewer.
    expect(await gate.viewerFromRequest(req('Bearer other'))).toEqual({ id: 'other', role: 'CREATOR' });
    expect(await gate.viewerFromRequest(undefined)).toBeNull();
  });

  it('the guard attaches the viewer and always lets the request through', async () => {
    const { gate } = build(StoreStatus.DRAFT);
    const guard = new StorefrontViewerGuard(gate);
    const req: { headers: Record<string, string>; storefrontViewer?: unknown } = {
      headers: { authorization: 'Bearer admin' },
    };
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as never;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.storefrontViewer).toEqual({ id: 'admin', role: 'ADMIN' });
  });
});

describe('StorefrontGateService.allows', () => {
  it('LIVE (or no status) is open to everyone without a lookup', async () => {
    const { gate, ownerLookups } = build(StoreStatus.LIVE);
    expect(await gate.allows({ id: 's1', status: StoreStatus.LIVE }, null)).toBe(true);
    expect(await gate.allows({ id: 's1' }, null)).toBe(true);
    expect(ownerLookups).not.toHaveBeenCalled();
  });

  it('non-LIVE: owner and admin preview, anonymous and other creators do not', async () => {
    const { gate } = build(StoreStatus.DRAFT);
    for (const status of [StoreStatus.DRAFT, StoreStatus.PENDING_REVIEW, StoreStatus.CHANGES_REQUESTED, StoreStatus.PAUSED]) {
      const s = { id: 's1', status };
      expect(await gate.allows(s, null)).toBe(false);
      expect(await gate.allows(s, viewer('other'))).toBe(false);
      expect(await gate.allows(s, viewer('owner'))).toBe(true);
      expect(await gate.allows(s, viewer('admin'))).toBe(true);
    }
    // SUSPENDED: admins only.
    expect(await gate.allows({ id: 's1', status: StoreStatus.SUSPENDED }, viewer('owner'))).toBe(false);
    expect(await gate.allows({ id: 's1', status: StoreStatus.SUSPENDED }, viewer('admin'))).toBe(true);
  });
});

describe('every public storefront read honours the owner preview', () => {
  type Case = {
    name: string;
    call: (s: StorefrontService, v: ReturnType<typeof viewer> | null) => Promise<unknown>;
    closed: (res: unknown) => void;
    open: (res: unknown) => void;
  };
  const notFound = async (p: Promise<unknown>) => {
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
  };
  const cases: Case[] = [
    {
      name: 'GET /storefront/:slug',
      call: (s, v) => s.getStore('namez', undefined, undefined, v),
      closed: (r) => {
        const shell = r as { coming_soon: boolean; paused: boolean };
        expect(shell.coming_soon || shell.paused).toBe(true);
        expect(r).not.toHaveProperty('card_payments_enabled');
      },
      open: (r) => {
        expect(r).toHaveProperty('card_payments_enabled');
        expect(r).toMatchObject({ preview: true });
      },
    },
    {
      name: 'GET /storefront/:slug/products',
      call: (s, v) => s.getProducts('namez', { page: 1, limit: 12 }, undefined, undefined, v),
      closed: (r) => {
        expect(r).toEqual([]);
        expect(prismaOf(lastBuild).product.findMany).not.toHaveBeenCalled();
      },
      open: () => expect(prismaOf(lastBuild).product.findMany).toHaveBeenCalled(),
    },
    {
      name: 'GET /storefront/:slug/categories',
      call: (s, v) => s.getCategories('namez', v),
      closed: (r) => expect(r).toEqual([]),
      open: (r) => expect(Array.isArray(r)).toBe(true),
    },
    {
      name: 'GET /storefront/:slug/creator-categories',
      call: (s, v) => s.getCreatorCategories('namez', v),
      closed: (r) => expect(r).toEqual([]),
      open: (r) => expect(Array.isArray(r)).toBe(true),
    },
    {
      name: 'GET /storefront/:slug/menus',
      call: (s, v) => s.getMenus('namez', v),
      closed: (r) => expect(r).toEqual([]),
      open: (r) => expect(r).toHaveLength(1),
    },
    {
      name: 'GET /storefront/:slug/v2/home (published pages)',
      call: (s, v) => s.getPublishedPage('namez', { type: 'HOME' }, v),
      closed: (r) => expect(r).toBeNull(),
      open: (r) => expect(r).not.toBeNull(),
    },
    {
      name: 'GET /storefront/:slug/v2/sample-product',
      call: (s, v) => s.getSampleProduct('namez', v),
      closed: (r) => expect(r).toBeNull(),
      // No published product in the fixture: null either way, but the
      // catalog query must only run for the preview.
      open: () => undefined,
    },
    {
      name: 'GET /storefront/:slug/sitemap-data',
      call: (s, v) => s.getSitemapData('namez', undefined, undefined, v),
      closed: (r) => expect(r).toMatchObject({ indexing: 'noindex', products: [] }),
      open: (r) => expect(r).not.toHaveProperty('indexing'),
    },
  ];

  let lastBuild: ReturnType<typeof build>;
  const prismaOf = (b: ReturnType<typeof build>) => b.prisma;
  const fresh = (status: StoreStatus) => (lastBuild = build(status)).service;

  for (const c of cases) {
    it(`${c.name}: anonymous and another creator → closed; owner and admin → full`, async () => {
      for (const status of [StoreStatus.DRAFT, StoreStatus.PAUSED]) {
        c.closed(await c.call(fresh(status), null));
        c.closed(await c.call(fresh(status), viewer('other')));
        c.open(await c.call(fresh(status), viewer('owner')));
        c.open(await c.call(fresh(status), viewer('admin')));
      }
    });
  }

  it('product detail and legacy page: 404 when closed, served for the owner / admin', async () => {
    const closed = build(StoreStatus.DRAFT);
    await notFound(closed.service.getProduct('namez', 'mug', undefined, undefined, undefined, null));
    await notFound(closed.service.getProduct('namez', 'mug', undefined, undefined, undefined, viewer('other')));
    await notFound(closed.service.getPage('namez', 'about', null));
    const owner = build(StoreStatus.DRAFT);
    await expect(owner.service.getPage('namez', 'about', viewer('owner'))).resolves.toMatchObject({ slug: 'about' });
    await expect(owner.service.getPage('namez', 'about', viewer('admin'))).resolves.toMatchObject({ slug: 'about' });
    // Owner preview of an unknown product is the ordinary product 404, not
    // the store gate: the catalog was consulted.
    await notFound(owner.service.getProduct('namez', 'mug', undefined, undefined, undefined, viewer('owner')));
    expect(owner.prisma.product.findFirst).toHaveBeenCalled();
    expect(closed.prisma.product.findFirst).not.toHaveBeenCalled();
  });

  it('LIVE: identical payloads for anonymous and owner, no owner lookup', async () => {
    const { service, ownerLookups } = build(StoreStatus.LIVE);
    const anon = await service.getStore('namez', undefined, undefined, null);
    const own = await service.getStore('namez', undefined, undefined, viewer('owner'));
    expect(own).toEqual(anon);
    expect(anon).not.toHaveProperty('preview');
    expect(await service.getProducts('namez', {}, undefined, undefined, null)).toEqual(
      await service.getProducts('namez', {}, undefined, undefined, viewer('other')),
    );
    expect(ownerLookups).not.toHaveBeenCalled();
  });
});
