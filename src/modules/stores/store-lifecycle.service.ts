import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, StoreStatus, StoreType, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { SecurityAuditService } from '../security/security-audit.service';
import type { RequestMeta } from '../security/request-meta';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { loadPublicHost } from './storefront-hosts';
import { traderDetailsComplete, validateTraderDetails } from './trader-details';
import { isDisposableEmail } from '../../common/email/disposable-domains';
import { isKustomEnabledForStore, kustomCreatorSelect } from '../payments/kustom/kustom.eligibility';

/** Statuses a creator may request go-live from. */
const GOLIVE_FROM: ReadonlySet<StoreStatus> = new Set([
  StoreStatus.DRAFT,
  StoreStatus.CHANGES_REQUESTED,
]);

/** Statuses an admin may set through PUT /admin/stores/:id/status. */
export const ADMIN_SETTABLE_STATUSES = [
  StoreStatus.LIVE,
  StoreStatus.CHANGES_REQUESTED,
  StoreStatus.SUSPENDED,
  StoreStatus.PAUSED,
] as const;

export interface GoLiveChecklist {
  email_verified: boolean;
  trader_details_complete: boolean;
  has_published_product: boolean;
  has_published_theme: boolean;
  payments_ready: boolean;
  legal_pages_published: boolean;
  ready: boolean;
  blocking: string[];
}

/** Checklist items that block a go-live request (the rest is advisory). */
const BLOCKING_ITEMS: ReadonlyArray<keyof GoLiveChecklist> = [
  'email_verified',
  'trader_details_complete',
  'has_published_product',
];

/**
 * The ONLY place that derives `is_active` from a status change (SPEC §1):
 * every status write goes through this so the compat column never drifts.
 */
export function storeStatusData(
  status: StoreStatus,
  extra: Partial<
    Pick<
      Prisma.StoreUncheckedUpdateInput,
      'status_reason' | 'went_live_at' | 'golive_requested_at'
    >
  > = {},
): Prisma.StoreUncheckedUpdateInput {
  return { status, is_active: status === StoreStatus.LIVE, ...extra };
}

export const STORE_STATUS_TRANSITION = {
  code: 'STORE_STATUS_TRANSITION',
  message: 'This status change is not allowed from the current store status.',
} as const;

/**
 * Store lifecycle (plans/platform-onboarding SPEC §3): go-live checklist,
 * trader details, the creator's go-live request with the auto-approval
 * rule, the LIVE↔PAUSED toggle and the admin queue.
 */
@Injectable()
export class StoreLifecycleService {
  private readonly logger = new Logger(StoreLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly audit: SecurityAuditService,
    private readonly revalidation: RevalidationService,
    private readonly storeApps: StoreAppsService,
    private readonly config: ConfigService,
  ) {}

  private notFound(): NotFoundException {
    return new NotFoundException({
      code: 'STORE_NOT_FOUND',
      message: 'Store not found',
    });
  }

  /** The creator's own store (id + status + owner) or 404. */
  private async ownStore(userId: string) {
    const store = await this.prisma.store.findFirst({
      where: { creator: { user_id: userId } },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        store_type: true,
        trader_details: true,
        cod_enabled: true,
        currency: true,
        is_active: true,
        creator: {
          select: {
            id: true,
            display_name: true,
            user: {
              select: {
                id: true,
                email: true,
                email_verified_at: true,
                status: true,
              },
            },
          },
        },
        language_config: { select: { primary_locale: true } },
      },
    });
    if (!store) throw this.notFound();
    return store;
  }

  /** Go-live checklist of a store (GET /stores/my/store → golive_checklist). */
  async checklist(storeId: string): Promise<GoLiveChecklist> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        store_type: true,
        trader_details: true,
        cod_enabled: true,
        currency: true,
        is_active: true,
        theme_key: true,
        theme_customizations: true,
        theme_config: true,
        creator: {
          select: {
            id: true,
            stripe_account_type: true,
            stripe_charges_enabled: true,
            stripe_payouts_enabled: true,
            ...kustomCreatorSelect,
            user: { select: { email_verified_at: true } },
          },
        },
      },
    });
    if (!store) throw this.notFound();

    const [ownPublished, customPublished, homePublished, legalPages, legalStatic] =
      await Promise.all([
        this.prisma.product.count({
          where: { creator_id: store.creator.id, status: 'PUBLISHED' },
        }),
        store.store_type === StoreType.INDEPENDENT
          ? Promise.resolve(0)
          : this.prisma.customProduct.count({
              where: { creator_id: store.creator.id, status: 'PUBLISHED' },
            }),
        this.prisma.page.count({
          where: {
            store_id: store.id,
            type: 'HOME',
            published_version_id: { not: null },
          },
        }),
        this.prisma.legalPage.count(),
        this.prisma.staticPage.count({
          where: {
            store_id: store.id,
            status: 'PUBLISHED',
            type: { in: ['PRIVACY_POLICY', 'TERMS', 'RETURN_POLICY'] },
          },
        }),
      ]);

    const creator = store.creator;
    const cardReady =
      store.store_type === StoreType.INDEPENDENT
        ? creator.stripe_account_type === 'standard' &&
          creator.stripe_charges_enabled
        : creator.stripe_account_type !== 'standard' &&
          creator.stripe_payouts_enabled;
    const kustomReady = isKustomEnabledForStore({
      store_type: store.store_type,
      // Readiness, not the public gate: judge the setup as if LIVE.
      is_active: true,
      creator,
      currency: store.currency ?? undefined,
    });
    const themeChosen =
      homePublished > 0 ||
      Object.keys((store.theme_customizations as object) ?? {}).length > 0 ||
      Object.keys((store.theme_config as object) ?? {}).length > 0;

    const items = {
      email_verified: Boolean(creator.user.email_verified_at),
      trader_details_complete: traderDetailsComplete(store.trader_details),
      has_published_product: ownPublished + customPublished > 0,
      has_published_theme: themeChosen,
      payments_ready: cardReady || kustomReady || store.cod_enabled,
      legal_pages_published: legalPages > 0 || legalStatic >= 3,
    };
    const blocking = BLOCKING_ITEMS.filter((k) => !items[k]);
    return { ...items, ready: blocking.length === 0, blocking };
  }

  /** PUT /stores/my/trader-details: validated as SPEC §1, stores completed_at. */
  async updateTraderDetails(userId: string, body: Record<string, unknown>) {
    const store = await this.ownStore(userId);
    const details = validateTraderDetails(body);
    const updated = await this.prisma.store.update({
      where: { id: store.id },
      data: { trader_details: details as unknown as Prisma.InputJsonObject },
      select: { id: true, trader_details: true, status: true },
    });
    await this.revalidation.revalidateStoreById(store.id);
    return updated;
  }

  /**
   * POST /stores/my/golive. Needs the checklist ready (400
   * STORE_GOLIVE_NOT_READY + blocking); allowed from DRAFT and
   * CHANGES_REQUESTED only (409). Auto-approves when the platform does not
   * require creator approval and the D1 checks pass; otherwise queues for
   * review (PENDING_REVIEW) and notifies owner + admins.
   */
  async requestGoLive(userId: string) {
    const store = await this.ownStore(userId);
    if (!GOLIVE_FROM.has(store.status)) {
      throw new ConflictException(STORE_STATUS_TRANSITION);
    }
    const checklist = await this.checklist(store.id);
    if (!checklist.ready) {
      throw new BadRequestException({
        code: 'STORE_GOLIVE_NOT_READY',
        message: 'Complete the go-live checklist first',
        blocking: checklist.blocking,
      });
    }

    const cfg = await this.prisma.platformConfig.findFirst({
      select: { require_creator_approval: true, default_locale: true },
    });
    const owner = store.creator.user;
    const autoApprove =
      cfg?.require_creator_approval === false &&
      checklist.email_verified &&
      checklist.trader_details_complete &&
      checklist.has_published_product &&
      !isDisposableEmail(owner.email);

    const locale = store.language_config?.primary_locale ?? cfg?.default_locale;
    if (autoApprove) {
      const updated = await this.setStatus(store.id, StoreStatus.LIVE, {
        status_reason: null,
      });
      void this.sendStoreLive(store, locale).catch(() => undefined);
      return { ...updated, golive_checklist: checklist, auto_approved: true };
    }

    const now = new Date();
    const updated = await this.setStatus(store.id, StoreStatus.PENDING_REVIEW, {
      golive_requested_at: now,
      status_reason: null,
    });
    void this.mail
      .sendOnboarding(
        'golive_requested',
        owner.email,
        {
          name: store.creator.display_name,
          store_name: store.name,
          dashboard_url: this.dashboardUrl(),
        },
        locale,
      )
      .catch(() => undefined);
    void this.notifyAdminsGoLive(store, owner.email, checklist).catch(
      () => undefined,
    );
    return { ...updated, golive_checklist: checklist, auto_approved: false };
  }

  /**
   * The creator's "Store active" toggle (PUT /stores/my/store { is_active }):
   * LIVE→PAUSED and PAUSED→LIVE only; any other status → 409.
   */
  async toggleActive(storeId: string, active: boolean) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { status: true },
    });
    if (!store) throw this.notFound();
    const target = active ? StoreStatus.LIVE : StoreStatus.PAUSED;
    if (store.status === target) return;
    const allowed =
      (store.status === StoreStatus.LIVE && target === StoreStatus.PAUSED) ||
      (store.status === StoreStatus.PAUSED && target === StoreStatus.LIVE);
    if (!allowed) throw new ConflictException(STORE_STATUS_TRANSITION);
    await this.setStatus(storeId, target);
  }

  /**
   * Single writer of Store.status (and the derived is_active). `went_live_at`
   * is set the first time a store becomes LIVE.
   */
  async setStatus(
    storeId: string,
    status: StoreStatus,
    extra: { status_reason?: string | null; golive_requested_at?: Date | null } = {},
  ) {
    const current = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { went_live_at: true, slug: true },
    });
    if (!current) throw this.notFound();
    const data = storeStatusData(status, {
      ...extra,
      ...(status === StoreStatus.LIVE && !current.went_live_at
        ? { went_live_at: new Date() }
        : {}),
    });
    const updated = await this.prisma.store.update({
      where: { id: storeId },
      data,
      select: {
        id: true,
        slug: true,
        status: true,
        status_reason: true,
        is_active: true,
        went_live_at: true,
        golive_requested_at: true,
      },
    });
    await this.revalidation.revalidateStoreBySlug(updated.slug);
    return updated;
  }

  // ── Admin ────────────────────────────────────────────────────────────────

  /** GET /admin/stores?status=&q=&page=&limit= */
  async adminList(query: {
    status?: string;
    q?: string;
    page?: string | number;
    limit?: string | number;
  }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
    const status = (Object.values(StoreStatus) as string[]).includes(
      query.status ?? '',
    )
      ? (query.status as StoreStatus)
      : undefined;
    const q = query.q?.trim();
    const where: Prisma.StoreWhereInput = {
      ...(status ? { status } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { slug: { contains: q, mode: 'insensitive' } },
              {
                creator: {
                  user: { email: { contains: q, mode: 'insensitive' } },
                },
              },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.store.findMany({
        where,
        orderBy: [{ golive_requested_at: 'desc' }, { created_at: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          slug: true,
          name: true,
          store_type: true,
          status: true,
          status_reason: true,
          created_at: true,
          golive_requested_at: true,
          went_live_at: true,
          creator: {
            select: {
              id: true,
              display_name: true,
              user: { select: { id: true, email: true, email_verified_at: true } },
            },
          },
        },
      }),
      this.prisma.store.count({ where }),
    ]);
    const items = await Promise.all(
      rows.map(async (s) => {
        const checklist = await this.checklist(s.id);
        return {
          id: s.id,
          slug: s.slug,
          name: s.name,
          store_type: s.store_type,
          status: s.status,
          status_reason: s.status_reason,
          created_at: s.created_at,
          golive_requested_at: s.golive_requested_at,
          went_live_at: s.went_live_at,
          owner: {
            creator_id: s.creator.id,
            user_id: s.creator.user.id,
            email: s.creator.user.email,
            display_name: s.creator.display_name,
            email_verified: Boolean(s.creator.user.email_verified_at),
          },
          checklist,
        };
      }),
    );
    return { items, total, page, limit };
  }

  /**
   * PUT /admin/stores/:id/status { status, reason? }: writes status_reason,
   * audits `store.status_changed`, emails the owner (store_live /
   * store_changes_requested / store_suspended).
   */
  async adminSetStatus(
    storeId: string,
    status: (typeof ADMIN_SETTABLE_STATUSES)[number],
    reason: string | undefined,
    admin: { id: string; email: string; role: UserRole },
    meta?: RequestMeta,
  ) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        custom_domain: true,
        creator: {
          select: {
            display_name: true,
            user: { select: { email: true } },
          },
        },
        language_config: { select: { primary_locale: true } },
      },
    });
    if (!store) throw this.notFound();
    const trimmed = reason?.trim() || null;
    if (
      (status === StoreStatus.CHANGES_REQUESTED ||
        status === StoreStatus.SUSPENDED) &&
      !trimmed
    ) {
      throw new BadRequestException({
        code: 'STORE_STATUS_REASON_REQUIRED',
        message: 'A reason is required for this status',
      });
    }
    const updated = await this.setStatus(store.id, status, {
      status_reason:
        status === StoreStatus.LIVE || status === StoreStatus.PAUSED
          ? null
          : trimmed,
    });
    await this.audit.record({
      actor: { id: admin.id, email: admin.email, role: admin.role },
      action: 'store.status_changed',
      targetType: 'store',
      targetId: store.id,
      targetLabel: store.slug,
      fields: [`status: ${store.status} → ${status}`],
      meta,
    });

    const owner = store.creator.user.email;
    const locale = store.language_config?.primary_locale;
    const common = { name: store.creator.display_name, store_name: store.name };
    if (status === StoreStatus.LIVE && store.status !== StoreStatus.LIVE) {
      void this.sendStoreLive(store, locale).catch(() => undefined);
    } else if (status === StoreStatus.CHANGES_REQUESTED) {
      void this.mail
        .sendOnboarding(
          'store_changes_requested',
          owner,
          { ...common, reason: trimmed ?? '', dashboard_url: this.dashboardUrl() },
          locale,
        )
        .catch(() => undefined);
    } else if (status === StoreStatus.SUSPENDED) {
      const cfg = await this.prisma.platformConfig.findFirst({
        select: { support_email: true },
      });
      void this.mail
        .sendOnboarding(
          'store_suspended',
          owner,
          {
            ...common,
            reason: trimmed ?? '',
            support_email: cfg?.support_email ?? '',
          },
          locale,
        )
        .catch(() => undefined);
    }
    return updated;
  }

  // ── Links / emails ───────────────────────────────────────────────────────

  dashboardUrl(): string {
    return (
      this.config.get<string>('DASHBOARD_URL') || 'http://localhost:3002'
    ).replace(/\/$/, '');
  }

  /** Public URL of a store: its public host, else the slug subdomain. */
  async storeUrl(store: {
    id: string;
    slug: string;
    custom_domain?: string | null;
  }): Promise<string> {
    try {
      const host = await loadPublicHost(
        { prisma: this.prisma, storeApps: this.storeApps },
        { id: store.id, custom_domain: store.custom_domain ?? null },
      );
      if (host) return `https://${host}`;
    } catch (err) {
      this.logger.warn(
        `Public host lookup failed for store ${store.slug}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const base = (
      this.config.get<string>('STOREFRONT_URL') || 'http://localhost:3003'
    ).replace(/\/$/, '');
    try {
      const url = new URL(base);
      return `${url.protocol}//${store.slug}.${url.host}`;
    } catch {
      return `${base}/${store.slug}`;
    }
  }

  private async sendStoreLive(
    store: {
      id: string;
      slug: string;
      name: string;
      custom_domain?: string | null;
      creator: { display_name: string; user: { email: string } };
    },
    locale?: string | null,
  ) {
    const storeUrl = await this.storeUrl(store);
    await this.mail.sendOnboarding(
      'store_live',
      store.creator.user.email,
      {
        name: store.creator.display_name,
        store_name: store.name,
        store_url: storeUrl,
        dashboard_url: this.dashboardUrl(),
      },
      locale,
    );
  }

  private async notifyAdminsGoLive(
    store: { id: string; slug: string; name: string },
    ownerEmail: string,
    checklist: GoLiveChecklist,
  ) {
    const recipients = await this.mail.adminRecipients();
    const summary = (
      Object.keys(checklist) as Array<keyof GoLiveChecklist>
    )
      .filter((k) => k !== 'ready' && k !== 'blocking')
      .map((k) => `${k}: ${checklist[k] ? 'yes' : 'no'}`)
      .join(', ');
    const vars = {
      store_name: store.name,
      store_slug: store.slug,
      owner_email: ownerEmail,
      checklist: summary,
      review_url: `${this.dashboardUrl()}/admin/stores?status=PENDING_REVIEW`,
    };
    for (const to of recipients) {
      await this.mail.sendOnboarding('admin_golive_request', to, vars);
    }
  }
}
