import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, StoreType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { PgNotifyListener } from '../../common/ops/pg-listener';
import {
  STORE_APPS,
  STORE_APP_KEYS,
  StoreAppKey,
  isStoreAppKey,
  storeAppDependents,
} from '../../common/store-apps/store-apps.registry';
import {
  StorefrontApps,
  buildStorefrontApps,
  isStoreAppRowActive,
} from './storefront-apps';
import {
  AdminStoreAppsQueryDto,
  UpdateMyStoreAppDto,
} from './dto/store-app.dto';
import { validateStoreAppSettings } from '../../common/store-apps/settings-validators';

/**
 * Per-store apps (feature add-ons). A StoreApp row is the allowlist of one
 * app for one store: `available` is the admin's switch, `enabled` the
 * creator's, and the app is in effect only when both are true. A store with
 * no rows has no apps and behaves exactly as before the apps system existed.
 *
 * Reads go through an in-memory cache (one entry per store) because
 * isEnabled() sits on hot storefront/checkout paths; every mutation drops the
 * store's entry and asks the storefront to revalidate. The cache is
 * per-process; across instances (M5 W1-C, item 4) every mutation also runs
 * `pg_notify('store_apps', storeId)` and each instance holds a dedicated
 * `LISTEN store_apps` connection (PgNotifyListener) that drops the store's
 * entry at once. When that connection is down (or
 * `STORE_APPS_LISTEN=off`), a stale instance still catches up within
 * CACHE_TTL_MS.
 */

/** One store's rows are kept this long before being re-read. */
const CACHE_TTL_MS = 60 * 1000;
/** Postgres NOTIFY channel; payload = store id. */
export const STORE_APPS_CHANNEL = 'store_apps';
/** Bound on cached stores so a scan over random ids cannot grow memory. */
const CACHE_MAX_ENTRIES = 5000;

/** Why a creator cannot enable an app right now (null = they can). */
export type StoreAppBlockedReason =
  | 'NOT_AVAILABLE'
  | 'REQUIRES_INDEPENDENT'
  | 'DEPENDENCY_MISSING';

export interface MyStoreAppView {
  key: StoreAppKey;
  name_key: string;
  description_key: string;
  available: boolean;
  enabled: boolean;
  settings: Record<string, unknown>;
  enabled_at: Date | null;
  requires_independent: boolean;
  depends_on: StoreAppKey[];
  can_enable: boolean;
  blocked_reason: StoreAppBlockedReason | null;
}

export interface AdminStoreAppView {
  key: StoreAppKey;
  name_key: string;
  description_key: string;
  available: boolean;
  enabled: boolean;
  requires_independent: boolean;
  depends_on: StoreAppKey[];
}

/** One row of the admin "store apps" overview. */
export interface AdminStoreAppsRow {
  store_id: string;
  store_name: string;
  store_slug: string;
  store_type: StoreType;
  creator_id: string;
  creator_name: string;
  apps: AdminStoreAppView[];
}

export interface AdminStoreAppsPage {
  items: AdminStoreAppsRow[];
  total: number;
  page: number;
  limit: number;
}

const storeAppSelect = {
  app_key: true,
  available: true,
  enabled: true,
  settings: true,
  enabled_at: true,
} as const;

type StoreAppRow = Prisma.StoreAppGetPayload<{ select: typeof storeAppSelect }>;

interface CacheEntry {
  rows: Map<string, StoreAppRow>;
  expiresAt: number;
}

const STORE_NOT_FOUND = {
  code: 'STORE_NOT_FOUND',
  message: 'Store not found',
};
const STORE_APP_NOT_AVAILABLE = {
  code: 'STORE_APP_NOT_AVAILABLE',
  message: 'This app has not been made available for your store.',
};

@Injectable()
export class StoreAppsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StoreAppsService.name);
  private readonly cache = new Map<string, CacheEntry>();
  /** Dedicated LISTEN connection; null when disabled. */
  private listener: PgNotifyListener | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly revalidation: RevalidationService,
  ) {}

  onModuleInit(): void {
    if ((process.env.STORE_APPS_LISTEN ?? '').toLowerCase() === 'off') {
      this.logger.log('StoreApp LISTEN disabled (STORE_APPS_LISTEN=off)');
      return;
    }
    this.listener = new PgNotifyListener(STORE_APPS_CHANNEL, (storeId) =>
      this.invalidate(storeId),
    );
    this.listener.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.listener?.stop();
    this.listener = null;
  }

  /** Tells every other instance to drop the store's cached rows (best effort). */
  private async notifyInstances(storeId: string): Promise<void> {
    try {
      await this.prisma
        .$executeRaw`SELECT pg_notify(${STORE_APPS_CHANNEL}, ${storeId})`;
    } catch (err) {
      this.logger.warn(
        `pg_notify(${STORE_APPS_CHANNEL}) failed for store ${storeId}; other instances fall back to the ${CACHE_TTL_MS / 1000} s TTL: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ── Hot-path reads ────────────────────────────────────────────────────────

  /** Whether `key` is in effect (available AND enabled) for the store. */
  async isEnabled(storeId: string, key: StoreAppKey): Promise<boolean> {
    const rows = await this.rowsOf(storeId);
    const row = rows?.get(key);
    return row ? isStoreAppRowActive(row) : false;
  }

  /**
   * Like isEnabled, but null when the app rows could not be read (DB
   * failure on a cache miss) instead of "off": for callers that must fail
   * closed rather than fall back to the app-off behaviour.
   */
  async enabledOrUnknown(
    storeId: string,
    key: StoreAppKey,
  ): Promise<boolean | null> {
    const rows = await this.rowsOf(storeId);
    if (!rows) return null;
    const row = rows.get(key);
    return row ? isStoreAppRowActive(row) : false;
  }

  /** The app's settings object, or null when the app is not in effect. */
  async getSettings(
    storeId: string,
    key: StoreAppKey,
  ): Promise<Record<string, unknown> | null> {
    const rows = await this.rowsOf(storeId);
    const row = rows?.get(key);
    if (!row || !isStoreAppRowActive(row)) return null;
    return settingsOf(row);
  }

  /** The `apps` object of the public storefront payload (`{}` when none). */
  async storefrontApps(storeId: string): Promise<StorefrontApps> {
    const rows = await this.rowsOf(storeId);
    return buildStorefrontApps(rows ? [...rows.values()] : []);
  }

  /**
   * Cached rows of a store, keyed by app_key. A DB failure on a cache miss is
   * logged and answered as "no rows" for this call only — never cached — so
   * a hiccup degrades to "apps off" instead of a stuck answer.
   */
  private async rowsOf(
    storeId: string,
  ): Promise<Map<string, StoreAppRow> | null> {
    const now = Date.now();
    const cached = this.cache.get(storeId);
    if (cached && cached.expiresAt > now) return cached.rows;

    let rows: StoreAppRow[];
    try {
      rows = await this.prisma.storeApp.findMany({
        where: { store_id: storeId },
        select: storeAppSelect,
      });
    } catch (err) {
      this.logger.warn(
        `StoreApp lookup failed for store ${storeId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
    const map = new Map(rows.map((r) => [r.app_key, r]));
    this.remember(storeId, map, now);
    return map;
  }

  private remember(
    storeId: string,
    rows: Map<string, StoreAppRow>,
    now: number,
  ): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      // Drop expired entries first; if still full, evict the oldest inserted.
      for (const [key, entry] of this.cache) {
        if (entry.expiresAt <= now) this.cache.delete(key);
      }
      if (this.cache.size >= CACHE_MAX_ENTRIES) {
        for (const key of this.cache.keys()) {
          this.cache.delete(key);
          break;
        }
      }
    }
    this.cache.set(storeId, { rows, expiresAt: now + CACHE_TTL_MS });
  }

  private invalidate(storeId: string): void {
    this.cache.delete(storeId);
  }

  // ── Store resolution (controller and RequireAppGuard) ─────────────────────

  /** The store owned by a creator user, or 404. */
  async storeOfCreator(userId: string) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    const store = creator
      ? await this.prisma.store.findUnique({
          where: { creator_id: creator.id },
          select: { id: true, store_type: true },
        })
      : null;
    if (!store) throw new NotFoundException(STORE_NOT_FOUND);
    return store;
  }

  /** The store of a Creator.id (admin routes), or 404. */
  private async storeOfCreatorId(creatorId: string) {
    const store = await this.prisma.store.findUnique({
      where: { creator_id: creatorId },
      select: { id: true, store_type: true },
    });
    if (!store) throw new NotFoundException(STORE_NOT_FOUND);
    return store;
  }

  /** Store id for a public slug, or null (inactive stores serve nothing). */
  async storeIdBySlug(slug: string): Promise<string | null> {
    const store = await this.prisma.store.findFirst({
      where: { slug, is_active: true },
      select: { id: true },
    });
    return store?.id ?? null;
  }

  /** Store id of a creator user, or null (no 404: the guard answers 403). */
  async storeIdByUser(userId: string): Promise<string | null> {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { store: { select: { id: true } } },
    });
    return creator?.store?.id ?? null;
  }

  // ── Creator view ──────────────────────────────────────────────────────────

  /** Every registry app as the creator sees it for their store. */
  async list(userId: string): Promise<MyStoreAppView[]> {
    const store = await this.storeOfCreator(userId);
    const rows = await this.loadRows(store.id);
    return STORE_APP_KEYS.map((key) => this.toMyView(key, rows, store));
  }

  /**
   * PUT my/apps/:appKey — settings first, then the toggle. Returns the full
   * refreshed list: toggling one app changes the siblings' can_enable /
   * blocked_reason. The cache drop + storefront revalidation happen once.
   */
  async updateMine(
    userId: string,
    appKey: string,
    dto: UpdateMyStoreAppDto,
  ): Promise<MyStoreAppView[]> {
    const key = this.assertKey(appKey);
    const store = await this.storeOfCreator(userId);
    let dirty = false;
    if (dto.settings !== undefined) {
      dirty = (await this.updateSettings(store.id, key, dto.settings)) || dirty;
    }
    if (dto.enabled === true) {
      dirty = (await this.enable(store, key, userId)) || dirty;
    } else if (dto.enabled === false) {
      dirty = (await this.disable(store.id, key)) || dirty;
    }
    if (dirty) await this.afterMutation(store.id);
    const rows = await this.loadRows(store.id);
    return STORE_APP_KEYS.map((k) => this.toMyView(k, rows, store));
  }

  /**
   * Switch an app on for a store. Refused when the admin has not made it
   * available, when it needs an INDEPENDENT store, or when one of the apps it
   * depends on is not in effect. Returns whether a row changed; the caller
   * (updateMine) drops the cache and revalidates.
   */
  async enable(
    store: { id: string; store_type: StoreType },
    key: StoreAppKey,
    userId: string,
  ): Promise<boolean> {
    const rows = await this.loadRows(store.id);
    const reason = this.blockedReason(key, rows, store);
    if (reason === 'NOT_AVAILABLE') {
      throw new ForbiddenException(STORE_APP_NOT_AVAILABLE);
    }
    if (reason === 'REQUIRES_INDEPENDENT') {
      throw new BadRequestException({
        code: 'STORE_APP_REQUIRES_INDEPENDENT',
        message: 'This app can only be enabled on an independent store.',
      });
    }
    if (reason === 'DEPENDENCY_MISSING') {
      throw new BadRequestException({
        code: 'STORE_APP_DEPENDENCY_MISSING',
        message: `Enable ${STORE_APPS[key].depends_on.join(', ')} first.`,
      });
    }
    await this.prisma.storeApp.update({
      where: { store_id_app_key: { store_id: store.id, app_key: key } },
      data: { enabled: true, enabled_at: new Date(), enabled_by: userId },
    });
    return true;
  }

  /**
   * Switch an app off. Refused while an enabled app still depends on it.
   * Returns whether a row changed (false for an app that is already off).
   */
  async disable(storeId: string, key: StoreAppKey): Promise<boolean> {
    const rows = await this.loadRows(storeId);
    const row = rows.get(key);
    if (!row || !row.enabled) return false;
    const inUse = storeAppDependents(key).filter(
      (dep) => rows.get(dep)?.enabled === true,
    );
    if (inUse.length) {
      throw new BadRequestException({
        code: 'STORE_APP_DEPENDENCY_IN_USE',
        message: `Disable ${inUse.join(', ')} first.`,
      });
    }
    await this.prisma.storeApp.update({
      where: { store_id_app_key: { store_id: storeId, app_key: key } },
      // enabled_by is kept as a trace of who last switched it on.
      data: { enabled: false, enabled_at: null },
    });
    return true;
  }

  /**
   * Replace the settings object. Needs the app to be available. Apps with a
   * settings validator (settings-validators.ts) reject a malformed object
   * with STORE_APP_SETTINGS_INVALID; every other app accepts any object.
   */
  async updateSettings(
    storeId: string,
    key: StoreAppKey,
    settings: Record<string, unknown>,
  ): Promise<boolean> {
    // Availability first: an app the store may not use answers 403 even
    // when the body is malformed (nothing about it is validated).
    const rows = await this.loadRows(storeId);
    const row = rows.get(key);
    if (!row || !row.available) {
      throw new ForbiddenException(STORE_APP_NOT_AVAILABLE);
    }
    const problems = validateStoreAppSettings(key, settings);
    if (problems.length) {
      throw new BadRequestException({
        code: 'STORE_APP_SETTINGS_INVALID',
        message: problems.join(' '),
      });
    }
    await this.prisma.storeApp.update({
      where: { store_id_app_key: { store_id: storeId, app_key: key } },
      data: { settings: settings as Prisma.InputJsonObject },
    });
    return true;
  }

  // ── Admin ─────────────────────────────────────────────────────────────────

  /** Every registry app with its availability for the creator's store. */
  async adminList(creatorId: string): Promise<AdminStoreAppView[]> {
    const store = await this.storeOfCreatorId(creatorId);
    const rows = await this.loadRows(store.id);
    return STORE_APP_KEYS.map((key) => toAdminView(key, rows.get(key)));
  }

  /**
   * Admin overview: a page of stores, each with every registry app merged
   * with its row (defaults when the store has none). Two queries for the
   * stores (page + count) and one for all of their app rows — no N+1.
   */
  async adminOverview(
    query: AdminStoreAppsQueryDto,
  ): Promise<AdminStoreAppsPage> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const q = query.q?.trim();
    const where: Prisma.StoreWhereInput = {
      ...(query.type ? { store_type: query.type } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { slug: { contains: q, mode: 'insensitive' } },
              {
                creator: {
                  display_name: { contains: q, mode: 'insensitive' },
                },
              },
            ],
          }
        : {}),
    };
    const [stores, total] = await Promise.all([
      this.prisma.store.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          name: true,
          slug: true,
          store_type: true,
          creator_id: true,
          creator: { select: { display_name: true } },
        },
      }),
      this.prisma.store.count({ where }),
    ]);
    const appRows = stores.length
      ? await this.prisma.storeApp.findMany({
          where: { store_id: { in: stores.map((s) => s.id) } },
          select: { store_id: true, ...storeAppSelect },
        })
      : [];
    const byStore = new Map<string, Map<string, StoreAppRow>>();
    for (const row of appRows) {
      let rows = byStore.get(row.store_id);
      if (!rows) {
        rows = new Map();
        byStore.set(row.store_id, rows);
      }
      rows.set(row.app_key, row);
    }
    const items = stores.map((store) => {
      const rows = byStore.get(store.id);
      return {
        store_id: store.id,
        store_name: store.name,
        store_slug: store.slug,
        store_type: store.store_type,
        creator_id: store.creator_id,
        creator_name: store.creator.display_name,
        apps: STORE_APP_KEYS.map((key) => toAdminView(key, rows?.get(key))),
      };
    });
    return { items, total, page, limit };
  }

  /**
   * Allow or withdraw an app for a store. Withdrawing also switches the
   * creator's toggle off — and the toggle of every app depending on it, so
   * no app can stay enabled on a dependency that is gone.
   */
  async setAvailable(
    creatorId: string,
    appKey: string,
    available: boolean,
  ): Promise<AdminStoreAppView[]> {
    const key = this.assertKey(appKey);
    const store = await this.storeOfCreatorId(creatorId);
    await this.prisma.$transaction(async (tx) => {
      await tx.storeApp.upsert({
        where: { store_id_app_key: { store_id: store.id, app_key: key } },
        create: { store_id: store.id, app_key: key, available },
        update: available ? { available } : { available, enabled: false },
      });
      const dependents = storeAppDependents(key);
      if (!available && dependents.length) {
        await tx.storeApp.updateMany({
          where: { store_id: store.id, app_key: { in: dependents } },
          data: { enabled: false },
        });
      }
    });
    await this.afterMutation(store.id);
    return this.adminList(creatorId);
  }

  /**
   * Called by StoresService when an admin switches the store type: apps that
   * need an INDEPENDENT store are switched off (their availability is kept,
   * so flipping back lets the creator re-enable them).
   */
  async onStoreTypeChanged(storeId: string, newType: StoreType): Promise<void> {
    if (newType === StoreType.INDEPENDENT) return;
    // Independent-only apps plus whatever depends on them, in one statement.
    const cleared = STORE_APP_KEYS.filter(
      (key) => STORE_APPS[key].requires_independent,
    );
    const keys = [
      ...new Set([...cleared, ...cleared.flatMap(storeAppDependents)]),
    ];
    const result = await this.prisma.storeApp.updateMany({
      where: { store_id: storeId, app_key: { in: keys }, enabled: true },
      data: { enabled: false },
    });
    // Nothing was switched off: the caller's own revalidation is enough.
    if (result.count === 0) {
      this.invalidate(storeId);
      return;
    }
    await this.afterMutation(storeId);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private assertKey(appKey: string): StoreAppKey {
    if (!isStoreAppKey(appKey)) {
      throw new NotFoundException({
        code: 'STORE_APP_UNKNOWN',
        message: `Unknown app "${appKey}".`,
      });
    }
    return appKey;
  }

  /** Uncached rows for the management paths (always fresh). */
  private async loadRows(storeId: string): Promise<Map<string, StoreAppRow>> {
    const rows = await this.prisma.storeApp.findMany({
      where: { store_id: storeId },
      select: storeAppSelect,
    });
    return new Map(rows.map((r) => [r.app_key, r]));
  }

  /**
   * Settings were changed outside updateSettings (e.g. the personalization
   * app renames a `url_prefill` target with a field): drop the cached rows
   * and revalidate the storefront.
   */
  async settingsChanged(storeId: string): Promise<void> {
    await this.afterMutation(storeId);
  }

  private async afterMutation(storeId: string): Promise<void> {
    this.invalidate(storeId);
    await this.notifyInstances(storeId);
    await this.revalidation.revalidateStoreById(storeId);
  }

  private blockedReason(
    key: StoreAppKey,
    rows: Map<string, StoreAppRow>,
    store: { store_type: StoreType },
  ): StoreAppBlockedReason | null {
    const def = STORE_APPS[key];
    const row = rows.get(key);
    if (!row || !row.available) return 'NOT_AVAILABLE';
    if (
      def.requires_independent &&
      store.store_type !== StoreType.INDEPENDENT
    ) {
      return 'REQUIRES_INDEPENDENT';
    }
    const depMissing = def.depends_on.some((dep) => {
      const depRow = rows.get(dep);
      return !depRow || !isStoreAppRowActive(depRow);
    });
    if (depMissing) return 'DEPENDENCY_MISSING';
    return null;
  }

  private toMyView(
    key: StoreAppKey,
    rows: Map<string, StoreAppRow>,
    store: { store_type: StoreType },
  ): MyStoreAppView {
    const def = STORE_APPS[key];
    const row = rows.get(key);
    const reason = this.blockedReason(key, rows, store);
    return {
      key,
      name_key: def.name_key,
      description_key: def.description_key,
      available: row?.available ?? false,
      enabled: row ? isStoreAppRowActive(row) : false,
      settings: row ? settingsOf(row) : {},
      enabled_at: row?.enabled_at ?? null,
      requires_independent: def.requires_independent,
      depends_on: def.depends_on,
      can_enable: reason === null,
      blocked_reason: reason,
    };
  }
}

function toAdminView(
  key: StoreAppKey,
  row: StoreAppRow | undefined,
): AdminStoreAppView {
  const def = STORE_APPS[key];
  return {
    key,
    name_key: def.name_key,
    description_key: def.description_key,
    available: row?.available ?? false,
    enabled: row?.enabled ?? false,
    requires_independent: def.requires_independent,
    depends_on: def.depends_on,
  };
}

function settingsOf(row: { settings: unknown }): Record<string, unknown> {
  return row.settings && typeof row.settings === 'object'
    ? (row.settings as Record<string, unknown>)
    : {};
}
