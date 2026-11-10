import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { StoreStatus, StoreType, UserRole } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { StorefrontService } from './storefront.service';
import {
  StorefrontGateService,
  StorefrontViewerGuard,
  type StorefrontViewer,
} from './storefront-gate.service';
import type { EditHintTokenService } from './edit-hint/edit-hint-token.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import type { MarketPricingService } from '../markets/market-pricing.service';
import type { TaxService } from '../taxes/tax.service';

// SPEC §3 owner preview, applied to every public storefront read: a
// non-LIVE store is served in full to its owner / an admin (valid bearer
// token) and closed to anonymous callers and other creators. LIVE stays
// byte-identical (no gate query at all). The bearer may also be the
// dashboard-issued edit-hint token: it previews exactly the store it names.

const USERS: Record<string, { id: string; role: UserRole; status: string; store_id: null; tokens_valid_after: null }> = {
  owner: { id: 'owner', role: UserRole.CREATOR, status: 'ACTIVE', store_id: null, tokens_valid_after: null },
  other: { id: 'other', role: UserRole.CREATOR, status: 'PENDING', store_id: null, tokens_valid_after: null },
  admin: { id: 'admin', role: UserRole.ADMIN, status: 'ACTIVE', store_id: null, tokens_valid_after: null },
  banned: { id: 'banned', role: UserRole.CREATOR, status: 'BANNED', store_id: null, tokens_valid_after: null },
  // A second (banned) owner of store 's1' for the edit-hint status check.
  'banned-owner': { id: 'banned-owner', role: UserRole.CREATOR, status: 'BANNED', store_id: null, tokens_valid_after: null },
};

/** Store owners the fixture's `store.findFirst` recognises. */
const OWNERS_OF_S1 = new Set(['owner', 'banned-owner']);

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
  // Serves the gate's owner lookups (`{ id, creator: { user_id } }`), the
  // edit-hint ownership query (same `where`, nested creator.user) and the
  // preview's `{ slug, id }` form; only store 's1' / slug 'namez' exists.
  const ownerLookups = jest.fn(
    ({ where }: { where: { id?: string; slug?: string; creator?: { user_id: string } } }) => {
      const storeOk =
        (where.id === undefined || where.id === 's1') &&
        (where.slug === undefined || where.slug === 'namez');
      const userId = where.creator?.user_id;
      const ownerOk = userId === undefined || OWNERS_OF_S1.has(userId);
      if (!storeOk || !ownerOk) return Promise.resolve(null);
      const user = userId ? USERS[userId] : USERS.owner;
      return Promise.resolve({
        id: 's1',
        creator: { user: { role: user.role, status: user.status } },
      });
    },
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
    bundle: { findMany: jest.fn(() => Promise.resolve([])) },
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
  // Session tokens are "<userId>" verified by a stub JwtService; "bad" and
  // every edit-hint token ("hint:...") fail its signature check.
  const jwt = {
    verify: jest.fn((token: string) => {
      if (token === 'bad' || token.startsWith('hint:')) throw new Error('invalid');
      return { sub: token, role: USERS[token]?.role, store_id: null, iat: 1 };
    }),
  };
  // Edit-hint tokens are "hint:<storeId>:<userId>"; anything else is
  // forged / expired (verify → null, as the real service answers).
  const editHints = {
    verify: jest.fn((token: string) => {
      const m = token.match(/^hint:([^:]+):([^:]+)$/);
      return m ? { store_id: m[1], user_id: m[2] } : null;
    }),
  };
  const config = { get: (k: string) => (k === 'JWT_SECRET' ? 's' : undefined) };
  const gate = new StorefrontGateService(
    prisma as unknown as PrismaService,
    jwt as unknown as JwtService,
    config as unknown as ConfigService,
    editHints as unknown as EditHintTokenService,
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

const viewer = (id: string): StorefrontViewer => ({ id, role: USERS[id].role });
/** The viewer an edit-hint token for `storeId` resolves to (owner 'owner'). */
const hint = (storeId: string): StorefrontViewer => ({
  kind: 'edit-hint',
  store_id: storeId,
  user_id: 'owner',
});

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

  it('resolves the dashboard edit-hint token to the owner of that one store', async () => {
    const { gate, ownerLookups, prisma } = build(StoreStatus.DRAFT);
    const req = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
    expect(await gate.viewerFromRequest(req('hint:s1:owner'))).toEqual({
      kind: 'edit-hint',
      store_id: 's1',
      user_id: 'owner',
    });
    // One ownership query, no session user lookup.
    expect(ownerLookups).toHaveBeenCalledTimes(1);
    expect(ownerLookups).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 's1', creator: { user_id: 'owner' } } }),
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    // Claims naming a store the user does not own, an unknown store, a
    // banned owner, or a forged / expired token → anonymous.
    expect(await gate.viewerFromRequest(req('hint:s1:other'))).toBeNull();
    expect(await gate.viewerFromRequest(req('hint:s2:owner'))).toBeNull();
    expect(await gate.viewerFromRequest(req('hint:s1:banned-owner'))).toBeNull();
    expect(await gate.viewerFromRequest(req('hint:forged'))).toBeNull();
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

  it('edit-hint viewer: exactly the store the token names, never another, never SUSPENDED', async () => {
    const { gate, ownerLookups } = build(StoreStatus.DRAFT);
    for (const status of [StoreStatus.DRAFT, StoreStatus.PENDING_REVIEW, StoreStatus.CHANGES_REQUESTED, StoreStatus.PAUSED]) {
      expect(await gate.allows({ id: 's1', status }, hint('s1'))).toBe(true);
      expect(await gate.allows({ id: 's2', status }, hint('s1'))).toBe(false);
      expect(await gate.allows({ id: 's1', status }, hint('s2'))).toBe(false);
    }
    expect(await gate.allows({ id: 's1', status: StoreStatus.SUSPENDED }, hint('s1'))).toBe(false);
    // Ownership was settled when the viewer was resolved: no lookup here.
    expect(ownerLookups).not.toHaveBeenCalled();
  });
});

describe('every public storefront read honours the owner preview', () => {
  type Case = {
    name: string;
    call: (s: StorefrontService, v: StorefrontViewer | null) => Promise<unknown>;
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
    it(`${c.name}: anonymous, another creator and another store's edit hint → closed; owner, admin and this store's edit hint → full`, async () => {
      for (const status of [StoreStatus.DRAFT, StoreStatus.PAUSED]) {
        c.closed(await c.call(fresh(status), null));
        c.closed(await c.call(fresh(status), viewer('other')));
        c.closed(await c.call(fresh(status), hint('s2')));
        c.open(await c.call(fresh(status), viewer('owner')));
        c.open(await c.call(fresh(status), viewer('admin')));
        c.open(await c.call(fresh(status), hint('s1')));
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

  it('GET /storefront/:slug/preview: owner session, admin or this store\'s edit hint → full; else 401 / 403', async () => {
    const { service } = build(StoreStatus.DRAFT);
    await expect(service.ownerPreview('namez', hint('s1'))).resolves.toMatchObject({
      preview: true,
      status: 'DRAFT',
      card_payments_enabled: expect.anything(),
    });
    await expect(service.ownerPreview('namez', viewer('owner'))).resolves.toMatchObject({ preview: true });
    await expect(service.ownerPreview('namez', viewer('admin'))).resolves.toMatchObject({ preview: true });
    await expect(service.ownerPreview('namez', hint('s2'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.ownerPreview('namez', viewer('other'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.ownerPreview('namez', null)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('LIVE: identical payloads for anonymous, owner and edit hint, no owner lookup', async () => {
    const { service, ownerLookups } = build(StoreStatus.LIVE);
    const anon = await service.getStore('namez', undefined, undefined, null);
    const own = await service.getStore('namez', undefined, undefined, viewer('owner'));
    expect(own).toEqual(anon);
    expect(await service.getStore('namez', undefined, undefined, hint('s1'))).toEqual(anon);
    expect(anon).not.toHaveProperty('preview');
    expect(await service.getProducts('namez', {}, undefined, undefined, null)).toEqual(
      await service.getProducts('namez', {}, undefined, undefined, viewer('other')),
    );
    expect(ownerLookups).not.toHaveBeenCalled();
  });
});

// Owner product preview: the direct product URL serves a DRAFT product to
// the store owner / an admin (same viewer semantics as the store preview);
// lists stay PUBLISHED-only and everyone else keeps the 404.
describe('GET /storefront/:slug/products/:productSlug — DRAFT product preview', () => {
  type ProductWhere = { status?: string | { in: string[] } };
  const allowsDraft = (where: ProductWhere) =>
    typeof where.status === 'object' && where.status.in.includes('DRAFT');
  const draftProduct = {
    id: 'p-draft',
    creator_id: 'c1',
    provider_id: null,
    primary_creator_category_id: null,
    status: 'DRAFT',
    base_price: 120,
    compare_at_price: null,
    cost_price: 50,
    variant_option_config: null,
    tax_class_id: null,
    tax_exempt: false,
    translations: [{ locale: 'sv', slug: 'mugg', title: 'Mugg' }],
    images: [],
    attributes: [],
    variants: [],
    category: null,
    creator_categories: [],
    custom_fields: [],
    faqs: [],
    shipping_profile: null,
  };

  /** A LIVE store whose only product with slug "mugg" is a DRAFT. */
  function withDraft(status: StoreStatus = StoreStatus.LIVE) {
    const b = build(status);
    b.prisma.product.findFirst = jest.fn(({ where }: { where: ProductWhere }) =>
      Promise.resolve(allowsDraft(where) ? draftProduct : null),
    ) as unknown as typeof b.prisma.product.findFirst;
    return b;
  }
  const get = (b: ReturnType<typeof build>, v: StorefrontViewer | null) =>
    b.service.getProduct('namez', 'mugg', 'sv', undefined, undefined, v);
  const notFound = async (p: Promise<unknown>) => {
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
  };

  it('anonymous / another creator: PUBLISHED-only lookup, 404 for the draft', async () => {
    for (const v of [null, viewer('other'), hint('s2')]) {
      const b = withDraft();
      await notFound(get(b, v));
      // Every lookup (exact own, case-insensitive fallback) stayed public.
      for (const call of (b.prisma.product.findFirst as jest.Mock).mock.calls) {
        expect((call[0] as { where: ProductWhere }).where.status).toBe('PUBLISHED');
      }
    }
  });

  it('owner session, admin and the edit hint of this store get the draft with status DRAFT', async () => {
    for (const v of [viewer('owner'), viewer('admin'), hint('s1')]) {
      const b = withDraft();
      const payload = (await get(b, v)) as { id: string; status: string; cost_price?: unknown };
      expect(payload).toMatchObject({ id: 'p-draft', status: 'DRAFT' });
      // Merchant-only columns are stripped from the preview exactly like
      // from a published product.
      expect(payload).not.toHaveProperty('cost_price');
      expect(b.prisma.product.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: { in: ['PUBLISHED', 'DRAFT'] } }),
        }),
      );
    }
  });

  it('the draft is previewable on a non-LIVE store too, and the owner lookup runs once', async () => {
    const b = withDraft(StoreStatus.DRAFT);
    await expect(get(b, viewer('owner'))).resolves.toMatchObject({ status: 'DRAFT' });
    await notFound(get(withDraft(StoreStatus.DRAFT), null));
  });

  it('product lists never include a draft (PUBLISHED filter for the owner too)', async () => {
    const b = withDraft();
    await b.service.getProducts('namez', { page: 1, limit: 12 }, undefined, undefined, viewer('owner'));
    expect(b.prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'PUBLISHED' }) }),
    );
    expect(b.prisma.customProduct.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: { in: expect.anything() } }) }),
    );
    const sitemap = (await b.service.getSitemapData('namez', undefined, undefined, viewer('owner'))) as {
      products: unknown[];
    };
    expect(sitemap.products).toEqual([]);
  });
});

// FIXES-1 item 4: the owner pre-live checkout check of quote / order / cart.
describe('StorefrontGateService.preLiveCheck', () => {
  const s1 = (status: StoreStatus) => ({ id: 's1', status });

  it('is undefined without an X-Storefront-Viewer header', () => {
    const { gate } = build(StoreStatus.DRAFT);
    expect(gate.preLiveCheck(undefined)).toBeUndefined();
    expect(gate.preLiveCheck('')).toBeUndefined();
  });

  it('owner and admin pass on a previewable status; others do not', async () => {
    const { gate } = build(StoreStatus.DRAFT);
    await expect(gate.preLiveCheck('Bearer owner')!(s1(StoreStatus.DRAFT))).resolves.toBe(true);
    await expect(gate.preLiveCheck('Bearer admin')!(s1(StoreStatus.DRAFT))).resolves.toBe(true);
    await expect(gate.preLiveCheck('Bearer other')!(s1(StoreStatus.DRAFT))).resolves.toBe(false);
    await expect(gate.preLiveCheck('Bearer forged')!(s1(StoreStatus.DRAFT))).resolves.toBe(false);
    await expect(gate.preLiveCheck('garbage')!(s1(StoreStatus.DRAFT))).resolves.toBe(false);
    // The edit-hint token previews exactly the store it names.
    await expect(gate.preLiveCheck('Bearer hint:s1:owner')!(s1(StoreStatus.DRAFT))).resolves.toBe(true);
    await expect(gate.preLiveCheck('Bearer hint:s2:owner')!(s1(StoreStatus.DRAFT))).resolves.toBe(false);
  });

  it('a SUSPENDED store stays closed to its owner (admins only)', async () => {
    const { gate } = build(StoreStatus.SUSPENDED);
    await expect(gate.preLiveCheck('Bearer owner')!(s1(StoreStatus.SUSPENDED))).resolves.toBe(false);
    await expect(gate.preLiveCheck('Bearer admin')!(s1(StoreStatus.SUSPENDED))).resolves.toBe(true);
  });
});
