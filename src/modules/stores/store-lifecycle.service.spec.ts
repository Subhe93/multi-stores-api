import {
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { StoreStatus, StoreType, UserRole } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import {
  StoreLifecycleService,
  storeStatusData,
} from './store-lifecycle.service';
import { StoresService } from './stores.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MailService } from '../mail/mail.service';
import type { SecurityAuditService } from '../security/security-audit.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { OrdersService } from '../orders/orders.service';
import type { MarketsService } from '../markets/markets.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import type { RedirectsService } from '../redirects/redirects.service';

// SPEC §3: go-live checklist, the go-live request (auto-approval vs the
// review queue), the LIVE↔PAUSED toggle, admin status changes with audit +
// emails, reserved slugs and DRAFT creation.

const VALID_TRADER = {
  legal_name: 'Namez AB',
  business_type: 'company',
  org_number: '5560160680',
  address_line1: 'Storgatan 1',
  postal_code: '11122',
  city: 'Stockholm',
  country: 'SE',
  phone: '+46701234567',
  support_email: 'support@namez.se',
  completed_at: '2026-11-12T10:00:00.000Z',
};

interface Fixture {
  status?: StoreStatus;
  trader?: Record<string, unknown> | null;
  verified?: boolean;
  products?: number;
  requireApproval?: boolean;
  email?: string;
  wentLiveAt?: Date | null;
}

function build(f: Fixture = {}) {
  const store = {
    id: 's1',
    slug: 'namez',
    name: 'Namez',
    status: f.status ?? StoreStatus.DRAFT,
    store_type: StoreType.INDEPENDENT,
    trader_details: f.trader === undefined ? VALID_TRADER : f.trader,
    cod_enabled: false,
    currency: 'SEK',
    is_active: (f.status ?? StoreStatus.DRAFT) === StoreStatus.LIVE,
    custom_domain: null,
    went_live_at: f.wentLiveAt ?? null,
    theme_key: 'minimal',
    theme_customizations: {},
    theme_config: {},
    creator: {
      id: 'c1',
      display_name: 'Anna',
      stripe_account_type: 'standard',
      stripe_charges_enabled: true,
      stripe_payouts_enabled: false,
      kustom_enabled: false,
      kustom_merchant_id: null,
      kustom_shared_secret: null,
      user: {
        id: 'u1',
        email: f.email ?? 'anna@example.com',
        email_verified_at: f.verified === false ? null : new Date(),
        status: 'ACTIVE',
      },
    },
    language_config: { primary_locale: 'sv', secondary_locales: [] },
  };
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    store: {
      findFirst: jest.fn(() => Promise.resolve(store)),
      findUnique: jest.fn(() => Promise.resolve(store)),
      findMany: jest.fn(() => Promise.resolve([store])),
      count: jest.fn(() => Promise.resolve(1)),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return Promise.resolve({ ...store, ...data });
      }),
    },
    product: { count: jest.fn(() => Promise.resolve(f.products ?? 1)) },
    customProduct: { count: jest.fn(() => Promise.resolve(0)) },
    page: { count: jest.fn(() => Promise.resolve(1)) },
    legalPage: { count: jest.fn(() => Promise.resolve(3)) },
    staticPage: { count: jest.fn(() => Promise.resolve(0)) },
    platformConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve({
          require_creator_approval: f.requireApproval ?? true,
          default_locale: 'en',
          support_email: 'help@x.se',
        }),
      ),
    },
    storeDomain: { findFirst: jest.fn(() => Promise.resolve(null)) },
  };
  const mail = {
    sendOnboarding: jest.fn(() => Promise.resolve({ sent: true })),
    adminRecipients: jest.fn(() => Promise.resolve(['admin@x.se'])),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const revalidation = {
    revalidateStoreBySlug: jest.fn(() => Promise.resolve()),
    revalidateStoreById: jest.fn(() => Promise.resolve()),
  };
  const storeApps = { isEnabled: jest.fn(() => Promise.resolve(false)) };
  const config = {
    get: (k: string) =>
      ({ DASHBOARD_URL: 'https://dash.x', STOREFRONT_URL: 'https://stores.x' })[k],
  };
  const service = new StoreLifecycleService(
    prisma as unknown as PrismaService,
    mail as unknown as MailService,
    audit as unknown as SecurityAuditService,
    revalidation as unknown as RevalidationService,
    storeApps as unknown as StoreAppsService,
    config as unknown as ConfigService,
  );
  return { service, prisma, mail, audit, store, updates };
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(check()).toBe(true);
}

describe('storeStatusData (derived is_active)', () => {
  it('writes is_active = (status = LIVE) with every status', () => {
    expect(storeStatusData(StoreStatus.LIVE)).toEqual({
      status: 'LIVE',
      is_active: true,
    });
    for (const s of ['DRAFT', 'PENDING_REVIEW', 'CHANGES_REQUESTED', 'PAUSED', 'SUSPENDED'] as StoreStatus[]) {
      expect(storeStatusData(s).is_active).toBe(false);
    }
  });
});

describe('StoreLifecycleService.checklist', () => {
  it('ready when email verified, trader details complete and a product is published', async () => {
    const { service } = build();
    const c = await service.checklist('s1');
    expect(c).toMatchObject({
      email_verified: true,
      trader_details_complete: true,
      has_published_product: true,
      has_published_theme: true,
      payments_ready: true,
      legal_pages_published: true,
      ready: true,
      blocking: [],
    });
  });

  it('names the blocking items', async () => {
    const { service } = build({ verified: false, trader: null, products: 0 });
    const c = await service.checklist('s1');
    expect(c.ready).toBe(false);
    expect(c.blocking).toEqual([
      'email_verified',
      'trader_details_complete',
      'has_published_product',
    ]);
  });
});

describe('StoreLifecycleService.requestGoLive', () => {
  it('not ready → 400 STORE_GOLIVE_NOT_READY with blocking', async () => {
    const { service, prisma } = build({ products: 0 });
    const err = await service.requestGoLive('u1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'STORE_GOLIVE_NOT_READY',
      blocking: ['has_published_product'],
    });
    expect(prisma.store.update).not.toHaveBeenCalled();
  });

  it('approval required → PENDING_REVIEW, golive_requested_at, owner + admin emails', async () => {
    const { service, updates, mail } = build({ requireApproval: true });
    const res = await service.requestGoLive('u1');
    expect(updates[0]).toMatchObject({
      status: StoreStatus.PENDING_REVIEW,
      is_active: false,
      golive_requested_at: expect.any(Date),
    });
    expect(res.auto_approved).toBe(false);
    await waitFor(() => mail.sendOnboarding.mock.calls.length === 2);
    const events = mail.sendOnboarding.mock.calls.map((c) => (c as unknown as [string, string])[0]);
    expect(events.sort()).toEqual(['admin_golive_request', 'golive_requested']);
    const admin = mail.sendOnboarding.mock.calls.find(
      (c) => (c as unknown as [string])[0] === 'admin_golive_request',
    ) as unknown as [string, string, Record<string, string>];
    expect(admin[1]).toBe('admin@x.se');
    expect(admin[2].checklist).toContain('email_verified: yes');
  });

  it('auto-approval: no approval required + D1 checks → LIVE, went_live_at, store_live email', async () => {
    const { service, updates, mail } = build({ requireApproval: false });
    const res = await service.requestGoLive('u1');
    expect(updates[0]).toMatchObject({
      status: StoreStatus.LIVE,
      is_active: true,
      went_live_at: expect.any(Date),
    });
    expect(res.auto_approved).toBe(true);
    await waitFor(() => mail.sendOnboarding.mock.calls.length === 1);
    expect(mail.sendOnboarding).toHaveBeenCalledWith(
      'store_live',
      'anna@example.com',
      expect.objectContaining({
        store_name: 'Namez',
        store_url: 'https://namez.stores.x',
      }),
      'sv',
    );
  });

  it('a disposable owner email never auto-approves', async () => {
    const { service, updates } = build({
      requireApproval: false,
      email: 'x@mailinator.com',
    });
    await service.requestGoLive('u1');
    expect(updates[0]).toMatchObject({ status: StoreStatus.PENDING_REVIEW });
  });

  it('allowed from DRAFT and CHANGES_REQUESTED only (409 otherwise)', async () => {
    for (const status of [StoreStatus.LIVE, StoreStatus.PENDING_REVIEW, StoreStatus.PAUSED, StoreStatus.SUSPENDED]) {
      const { service } = build({ status });
      const err = await service.requestGoLive('u1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: 'STORE_STATUS_TRANSITION',
      });
    }
    const ok = build({ status: StoreStatus.CHANGES_REQUESTED });
    await expect(ok.service.requestGoLive('u1')).resolves.toBeDefined();
  });
});

describe('StoreLifecycleService.toggleActive (creator "Store active")', () => {
  it('LIVE→PAUSED and PAUSED→LIVE, nothing else', async () => {
    const live = build({ status: StoreStatus.LIVE, wentLiveAt: new Date() });
    await live.service.toggleActive('s1', false);
    expect(live.updates[0]).toMatchObject({ status: 'PAUSED', is_active: false });

    const paused = build({ status: StoreStatus.PAUSED, wentLiveAt: new Date() });
    await paused.service.toggleActive('s1', true);
    expect(paused.updates[0]).toMatchObject({ status: 'LIVE', is_active: true });
    expect(paused.updates[0]).not.toHaveProperty('went_live_at');

    const draft = build({ status: StoreStatus.DRAFT });
    await expect(draft.service.toggleActive('s1', true)).rejects.toMatchObject({
      response: { code: 'STORE_STATUS_TRANSITION' },
    });
    expect(draft.updates).toHaveLength(0);
  });
});

describe('StoreLifecycleService.adminSetStatus', () => {
  const admin = { id: 'a1', email: 'admin@x.se', role: UserRole.ADMIN };

  it('CHANGES_REQUESTED needs a reason, stores it, audits and emails', async () => {
    const { service, updates, audit, mail } = build({
      status: StoreStatus.PENDING_REVIEW,
    });
    await expect(
      service.adminSetStatus('s1', StoreStatus.CHANGES_REQUESTED, '', admin),
    ).rejects.toMatchObject({ response: { code: 'STORE_STATUS_REASON_REQUIRED' } });

    await service.adminSetStatus('s1', StoreStatus.CHANGES_REQUESTED, 'Add a logo', admin);
    expect(updates[0]).toMatchObject({
      status: 'CHANGES_REQUESTED',
      status_reason: 'Add a logo',
      is_active: false,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'store.status_changed',
        targetType: 'store',
        targetId: 's1',
        fields: ['status: PENDING_REVIEW → CHANGES_REQUESTED'],
      }),
    );
    await waitFor(() => mail.sendOnboarding.mock.calls.length === 1);
    expect(mail.sendOnboarding).toHaveBeenCalledWith(
      'store_changes_requested',
      'anna@example.com',
      expect.objectContaining({ reason: 'Add a logo' }),
      'sv',
    );
  });

  it('LIVE clears the reason, sets went_live_at once and emails store_live', async () => {
    const { service, updates, mail } = build({ status: StoreStatus.PENDING_REVIEW });
    await service.adminSetStatus('s1', StoreStatus.LIVE, undefined, admin);
    expect(updates[0]).toMatchObject({
      status: 'LIVE',
      is_active: true,
      status_reason: null,
      went_live_at: expect.any(Date),
    });
    await waitFor(() => mail.sendOnboarding.mock.calls.length === 1);
    expect((mail.sendOnboarding.mock.calls[0] as unknown as [string])[0]).toBe('store_live');
  });

  it('SUSPENDED emails store_suspended with the reason and support address', async () => {
    const { service, mail } = build({ status: StoreStatus.LIVE });
    await service.adminSetStatus('s1', StoreStatus.SUSPENDED, 'Fraud', admin);
    await waitFor(() => mail.sendOnboarding.mock.calls.length === 1);
    expect(mail.sendOnboarding).toHaveBeenCalledWith(
      'store_suspended',
      'anna@example.com',
      expect.objectContaining({ reason: 'Fraud', support_email: 'help@x.se' }),
      'sv',
    );
  });

  it('adminList returns owner, status and the checklist summary', async () => {
    const { service } = build({ status: StoreStatus.PENDING_REVIEW });
    const res = await service.adminList({ status: 'PENDING_REVIEW', q: 'nam' });
    expect(res.total).toBe(1);
    expect(res.items[0]).toMatchObject({
      slug: 'namez',
      status: 'PENDING_REVIEW',
      owner: { email: 'anna@example.com', email_verified: true },
      checklist: { ready: true },
    });
  });
});

describe('StoresService.create (SPEC §3)', () => {
  function stores(profile: Record<string, unknown> | null) {
    const created: Array<Record<string, unknown>> = [];
    const prisma = {
      creator: {
        findUnique: jest.fn(() =>
          Promise.resolve({ id: 'c1', onboarding_profile: profile }),
        ),
      },
      store: {
        findUnique: jest.fn(() => Promise.resolve(null)),
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return Promise.resolve({ id: 's1', ...data });
        }),
      },
    };
    const markets = { ensureDefaultMarket: jest.fn(() => Promise.resolve()) };
    const service = new StoresService(
      prisma as unknown as PrismaService,
      {} as RevalidationService,
      {} as OrdersService,
      {} as StoreAppsService,
      markets as unknown as MarketsService,
      {} as MarketsContextService,
      {} as RedirectsService,
    );
    return { service, created };
  }

  it('a reserved slug is 400 STORE_SLUG_RESERVED', async () => {
    const { service, created } = stores(null);
    await expect(
      service.create('u1', { slug: 'admin', name: 'X' }),
    ).rejects.toMatchObject({ response: { code: 'STORE_SLUG_RESERVED' } });
    expect(created).toHaveLength(0);
  });

  it('new stores start DRAFT / inactive; the type follows the sign-up card', async () => {
    const mp = stores({ account_kind: 'marketplace' });
    await mp.service.create('u1', { slug: 'my-shop', name: 'X' });
    expect(mp.created[0]).toMatchObject({
      status: StoreStatus.DRAFT,
      is_active: false,
      store_type: StoreType.MARKETPLACE,
    });
    const ind = stores({ account_kind: 'independent' });
    await ind.service.create('u1', { slug: 'my-shop', name: 'X' });
    expect(ind.created[0]).toMatchObject({ store_type: StoreType.INDEPENDENT });
    const explicit = stores({ account_kind: 'independent' });
    await explicit.service.create('u1', {
      slug: 'my-shop',
      name: 'X',
      store_type: StoreType.MARKETPLACE,
    });
    expect(explicit.created[0]).toMatchObject({ store_type: StoreType.MARKETPLACE });
  });
});
