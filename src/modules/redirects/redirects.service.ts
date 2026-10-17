import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, RedirectSource, StoreRedirect } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  REDIRECT_MAP_MAX_ENTRIES,
  fallbackRedirectPath,
  normalizeRedirectPath,
  sanitizeRedirectTarget,
} from './redirect-path.util';
import { resolveRedirectChain, rowsPointingAt } from './redirect-chain';
import {
  IncomingRedirect,
  RedirectDeactivation,
  RedirectUpsertPlan,
  planRedirectDeactivations,
  planRedirectUpserts,
  withoutDeactivated,
} from './redirect-plan';
import type {
  CreateRedirectDto,
  RedirectListQueryDto,
  UpdateRedirectDto,
} from './dto/redirect.dto';

/** Version cache lifetime (the M0 Map + TTL pattern), invalidated on write. */
const VERSION_TTL_MS = 60 * 1000;
const VERSION_CACHE_MAX = 5000;
/** Full maps kept in memory (the proxy refetches only on a new version). */
const MAP_TTL_MS = 60 * 1000;
const MAP_CACHE_MAX = 200;

/** Map mode is also capped by size: a larger JSON map switches to lookup mode. */
export const REDIRECT_MAP_MAX_BYTES = 2 * 1024 * 1024;

/** Rows per store (manual + imported, active or not); code REDIRECT_LIMIT. */
export const REDIRECT_MAX_ROWS_PER_STORE = 25_000;

/**
 * JSON size of `[["from","to",301],...]` without serializing it: per tuple
 * 2 brackets, 4 quotes, 2 commas, a 3-digit status, plus the separators.
 */
export function redirectMapBytes(items: readonly RedirectTuple[]): number {
  let n = 2 + Math.max(0, items.length - 1);
  for (const [from, to] of items) {
    n += Buffer.byteLength(from, 'utf8') + Buffer.byteLength(to, 'utf8') + 11;
  }
  return n;
}

/**
 * Per-store cap for importer batches: CREATE rows past
 * REDIRECT_MAX_ROWS_PER_STORE become REDIRECT_LIMIT conflicts instead of a
 * throw inside the importer's transaction. Pure (the dry run uses it too).
 */
export function capRedirectCreates(
  plan: RedirectUpsertPlan,
  existingRows: number,
): RedirectUpsertPlan {
  let room = Math.max(0, REDIRECT_MAX_ROWS_PER_STORE - existingRows);
  const items: RedirectUpsertPlan['items'] = [];
  const conflicts = [...plan.conflicts];
  for (const i of plan.items) {
    if (i.action !== 'CREATE') items.push(i);
    else if (room > 0) {
      room--;
      items.push(i);
    } else
      conflicts.push({
        from_path: i.from_path,
        to_path: i.to_path,
        code: 'REDIRECT_LIMIT',
      });
  }
  return { ...plan, items, conflicts };
}

export function redirectLimitError() {
  return new ConflictException({
    code: 'REDIRECT_LIMIT',
    message: `A store can have at most ${REDIRECT_MAX_ROWS_PER_STORE} redirects.`,
    limit: REDIRECT_MAX_ROWS_PER_STORE,
  });
}

export type RedirectTuple = [from: string, to: string, status: number];

/** `GET /stores/:slug/redirects` (proxy). */
export type RedirectMapResponse =
  | { version: string | null; mode: 'map'; items: RedirectTuple[] }
  | { version: string; mode: 'lookup' };

/** `GET /stores/:slug/redirects/resolve` (proxy, lookup mode). */
export interface RedirectResolveResponse {
  to: string;
  status: number;
}

export interface RedirectView {
  id: string;
  from_path: string;
  to_path: string;
  status_code: number;
  source: RedirectSource;
  import_run_id: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface BulkImportResult extends RedirectUpsertPlan {
  created: number;
  updated: number;
  unchanged: number;
  repointed: number;
  /** IMPORT rows switched off because their `from_path` is a live page now. */
  deactivated: RedirectDeactivation[];
  /**
   * Row id → what an UPDATE / repoint replaced, so the importer can store it
   * in the run item and its rollback can restore it (M4.4 fix 5).
   */
  before: Record<
    string,
    { to_path: string; status_code: number; is_active: boolean }
  >;
}

interface VersionEntry {
  version: string | null;
  count: number;
  expiresAt: number;
}

/**
 * Platform store redirects (M4.4 §6.3). Rows persist when the importer app
 * is switched off (SEO), so the public side never checks the app. Stores
 * without active rows answer `null` from `versionFor` and the proxy never
 * asks for their map.
 */
@Injectable()
export class RedirectsService {
  private readonly logger = new Logger(RedirectsService.name);
  private readonly versions = new Map<string, VersionEntry>();
  private readonly maps = new Map<
    string,
    // items null = the map is over REDIRECT_MAP_MAX_BYTES (lookup mode).
    { version: string; items: RedirectTuple[] | null; expiresAt: number }
  >();

  constructor(private readonly prisma: PrismaService) {}

  // ── Version (proxy hot path) ─────────────────────────────────────────────

  /**
   * Cache key of the store's active redirect set: count + newest
   * `updated_at`, or null when there is none. Cached 60 s per store
   * (negative results too). A DB error answers null for this call only
   * (fail open, never cached) so the host lookup is never blocked.
   */
  async versionFor(storeId: string): Promise<string | null> {
    return (await this.versionEntry(storeId))?.version ?? null;
  }

  private async versionEntry(storeId: string): Promise<VersionEntry | null> {
    const now = Date.now();
    const hit = this.versions.get(storeId);
    if (hit && hit.expiresAt > now) return hit;
    try {
      const agg = await this.prisma.storeRedirect.aggregate({
        where: { store_id: storeId, is_active: true },
        _count: { _all: true },
        _max: { updated_at: true },
      });
      const count = agg._count._all;
      const max = agg._max.updated_at;
      const entry: VersionEntry = {
        version:
          count > 0 && max ? `${count}-${max.getTime().toString(36)}` : null,
        count,
        expiresAt: now + VERSION_TTL_MS,
      };
      boundedSet(this.versions, storeId, entry, VERSION_CACHE_MAX, now);
      return entry;
    } catch (err) {
      this.logger.warn(
        `redirect version lookup failed for ${storeId}: ${String(err)}`,
      );
      return null;
    }
  }

  /** Drop the cached version/map of a store (after any write). */
  invalidate(storeId: string): void {
    this.versions.delete(storeId);
    this.maps.delete(storeId);
  }

  // ── Public reads ─────────────────────────────────────────────────────────

  /** Active store id for a public slug, or 404 STORE_NOT_FOUND. */
  async publicStoreId(slug: string): Promise<string> {
    const store = await this.prisma.store.findUnique({
      where: { slug },
      select: { id: true, is_active: true },
    });
    if (!store || !store.is_active) {
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    }
    return store.id;
  }

  /**
   * Map for the proxy. A DB error is reported as 503 REDIRECTS_UNAVAILABLE
   * (the proxy then retries after its short failure TTL) instead of an empty
   * map, which it would cache as "no redirects" for its full map TTL.
   */
  async mapFor(storeId: string): Promise<RedirectMapResponse> {
    const entry = await this.versionEntry(storeId);
    if (!entry) {
      throw new ServiceUnavailableException({
        code: 'REDIRECTS_UNAVAILABLE',
        message: 'Redirects are temporarily unavailable',
      });
    }
    if (!entry.version) return { version: null, mode: 'map', items: [] };
    if (entry.count > REDIRECT_MAP_MAX_ENTRIES) {
      return { version: entry.version, mode: 'lookup' };
    }
    const now = Date.now();
    const cached = this.maps.get(storeId);
    if (cached && cached.version === entry.version && cached.expiresAt > now) {
      return cached.items
        ? { version: entry.version, mode: 'map', items: cached.items }
        : { version: entry.version, mode: 'lookup' };
    }
    const rows = await this.prisma.storeRedirect.findMany({
      where: { store_id: storeId, is_active: true },
      select: { from_path: true, to_path: true, status_code: true },
      orderBy: { from_path: 'asc' },
    });
    const all: RedirectTuple[] = rows.map((r) => [
      r.from_path,
      r.to_path,
      r.status_code,
    ]);
    const items = redirectMapBytes(all) > REDIRECT_MAP_MAX_BYTES ? null : all;
    boundedSet(
      this.maps,
      storeId,
      { version: entry.version, items, expiresAt: now + MAP_TTL_MS },
      MAP_CACHE_MAX,
      now,
    );
    return items
      ? { version: entry.version, mode: 'map', items }
      : { version: entry.version, mode: 'lookup' };
  }

  /** Active redirect for a request path (exact key, then the fallback key). */
  async resolve(
    storeId: string,
    path: string,
  ): Promise<RedirectResolveResponse | null> {
    const row = await this.findMatch(storeId, path);
    return row ? { to: row.to_path, status: row.status_code } : null;
  }

  private async findMatch(
    storeId: string,
    path: string,
  ): Promise<StoreRedirect | null> {
    const key = normalizeRedirectPath(path);
    if (key === null) return null;
    const fallback = fallbackRedirectPath(key);
    const rows = await this.prisma.storeRedirect.findMany({
      where: {
        store_id: storeId,
        is_active: true,
        from_path: { in: fallback ? [key, fallback] : [key] },
      },
    });
    return (
      rows.find((r) => r.from_path === key) ??
      rows.find((r) => r.from_path === fallback) ??
      null
    );
  }

  // ── Creator CRUD ─────────────────────────────────────────────────────────

  async storeIdForCreator(userId: string): Promise<string> {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { store: { select: { id: true } } },
    });
    const storeId = creator?.store?.id;
    if (!storeId) {
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    }
    return storeId;
  }

  async list(storeId: string, query: RedirectListQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const q = query.q?.trim();
    const where: Prisma.StoreRedirectWhereInput = {
      store_id: storeId,
      ...(query.source ? { source: query.source } : {}),
      ...(q
        ? {
            OR: [
              { from_path: { contains: q, mode: 'insensitive' } },
              { to_path: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.storeRedirect.count({ where }),
      this.prisma.storeRedirect.findMany({
        where,
        orderBy: [{ updated_at: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return { items: rows.map(toView), total, page, limit };
  }

  async create(storeId: string, dto: CreateRedirectDto): Promise<RedirectView> {
    const from = requirePath(dto.from_path);
    const to = requireTarget(dto.to_path);
    const isActive = dto.is_active ?? true;
    const row = await this.prisma.$transaction(async (tx) => {
      const taken = await tx.storeRedirect.findUnique({
        where: { store_id_from_path: { store_id: storeId, from_path: from } },
        select: { id: true },
      });
      if (taken) throw duplicate();
      const total = await tx.storeRedirect.count({
        where: { store_id: storeId },
      });
      if (total >= REDIRECT_MAX_ROWS_PER_STORE) throw redirectLimitError();
      const finalTo = isActive
        ? await this.flatten(tx, storeId, from, to, null)
        : to;
      const created = await tx.storeRedirect.create({
        data: {
          store_id: storeId,
          from_path: from,
          to_path: finalTo,
          status_code: dto.status_code ?? 301,
          source: RedirectSource.MANUAL,
          is_active: isActive,
        },
      });
      return created;
    });
    this.invalidate(storeId);
    return toView(row);
  }

  /**
   * Merchant edit. The row becomes MANUAL, so a later import run never
   * overwrites it (§6.1).
   */
  async update(
    storeId: string,
    id: string,
    dto: UpdateRedirectDto,
  ): Promise<RedirectView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await tx.storeRedirect.findFirst({
        where: { id, store_id: storeId },
      });
      if (!current) throw notFound();
      const from =
        dto.from_path !== undefined
          ? requirePath(dto.from_path)
          : current.from_path;
      const to =
        dto.to_path !== undefined
          ? requireTarget(dto.to_path)
          : current.to_path;
      const isActive = dto.is_active ?? current.is_active;
      if (from !== current.from_path) {
        const taken = await tx.storeRedirect.findUnique({
          where: { store_id_from_path: { store_id: storeId, from_path: from } },
          select: { id: true },
        });
        if (taken) throw duplicate();
      }
      const finalTo = isActive
        ? await this.flatten(tx, storeId, from, to, current.id)
        : to;
      return tx.storeRedirect.update({
        where: { id: current.id },
        data: {
          from_path: from,
          to_path: finalTo,
          status_code: dto.status_code ?? current.status_code,
          is_active: isActive,
          source: RedirectSource.MANUAL,
        },
      });
    });
    this.invalidate(storeId);
    return toView(row);
  }

  async remove(storeId: string, id: string): Promise<{ deleted: true }> {
    const res = await this.prisma.storeRedirect.deleteMany({
      where: { id, store_id: storeId },
    });
    if (res.count === 0) throw notFound();
    this.invalidate(storeId);
    return { deleted: true };
  }

  /** "Test a URL": what the storefront would do with this path right now. */
  async test(storeId: string, path: string) {
    const normalized = normalizeRedirectPath(path);
    if (normalized === null) throw invalidPath();
    const row = await this.findMatch(storeId, path);
    return {
      path: normalized,
      match: row
        ? {
            id: row.id,
            from_path: row.from_path,
            to_path: row.to_path,
            status_code: row.status_code,
            source: row.source,
          }
        : null,
    };
  }

  /**
   * Final target of `from → to` against the other active rows (chain
   * flattening, 409 REDIRECT_LOOP), then re-points the rows whose target was
   * `from`. Runs inside the caller's transaction.
   */
  private async flatten(
    tx: Prisma.TransactionClient,
    storeId: string,
    from: string,
    to: string,
    selfId: string | null,
  ): Promise<string> {
    const rows = await tx.storeRedirect.findMany({
      where: { store_id: storeId, is_active: true },
      select: { id: true, from_path: true, to_path: true },
    });
    const map = new Map<string, string>();
    const idByFrom = new Map<string, string>();
    for (const r of rows) {
      if (r.id === selfId) continue;
      map.set(r.from_path, r.to_path);
      idByFrom.set(r.from_path, r.id);
    }
    const res = resolveRedirectChain(map, from, to);
    if (!res.ok) {
      throw new ConflictException({
        code: 'REDIRECT_LOOP',
        message: 'This redirect would create a loop.',
      });
    }
    for (const source of rowsPointingAt(map, from, res.to)) {
      await tx.storeRedirect.update({
        where: { id: idByFrom.get(source)! },
        data: { to_path: res.to },
      });
    }
    return res.to;
  }

  // ── Importer ─────────────────────────────────────────────────────────────

  /** Current rows of a store in the planner's shape (dry run + apply). */
  async existingForPlan(
    storeId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    return client.storeRedirect.findMany({
      where: { store_id: storeId },
      select: {
        id: true,
        from_path: true,
        to_path: true,
        status_code: true,
        source: true,
        is_active: true,
      },
    });
  }

  /**
   * Idempotent upsert of importer redirects (source=IMPORT) inside the
   * importer's transaction: MANUAL rows are never overwritten, chains are
   * flattened, loops dropped (see planRedirectUpserts). Active IMPORT rows
   * whose `from_path` is in `livePaths` (normalised live product/collection
   * paths of the store) are deactivated first so no live page is shadowed
   * (planRedirectDeactivations). The caller must call `invalidate(storeId)`
   * after its transaction commits.
   */
  async bulkUpsertFromImport(
    tx: Prisma.TransactionClient,
    storeId: string,
    runId: string,
    rows: readonly IncomingRedirect[],
    livePaths: readonly string[] = [],
  ): Promise<BulkImportResult> {
    const existing = await this.existingForPlan(storeId, tx);
    const deactivated = planRedirectDeactivations(existing, new Set(livePaths));
    const plan = capRedirectCreates(
      planRedirectUpserts(withoutDeactivated(existing, deactivated), rows),
      existing.length,
    );
    const byId = new Map(existing.map((r) => [r.id, r]));
    const before: BulkImportResult['before'] = {};
    const keep = (id: string) => {
      const r = byId.get(id);
      if (r)
        before[id] = {
          to_path: r.to_path,
          status_code: r.status_code,
          is_active: r.is_active,
        };
    };
    for (const d of deactivated) {
      keep(d.id);
      await tx.storeRedirect.update({
        where: { id: d.id },
        data: { is_active: false },
      });
    }
    const creates = plan.items.filter((i) => i.action === 'CREATE');
    if (creates.length) {
      await tx.storeRedirect.createMany({
        data: creates.map((i) => ({
          store_id: storeId,
          from_path: i.from_path,
          to_path: i.to_path,
          status_code: i.status_code,
          source: RedirectSource.IMPORT,
          import_run_id: runId,
          is_active: true,
        })),
      });
    }
    let updated = 0;
    for (const i of plan.items) {
      if (i.action !== 'UPDATE' || !i.id) continue;
      keep(i.id);
      // `import_run_id` stays the run that created the row: rolling back this
      // run restores `before` instead of deleting the row.
      await tx.storeRedirect.update({
        where: { id: i.id },
        data: {
          to_path: i.to_path,
          status_code: i.status_code,
          is_active: true,
        },
      });
      updated++;
    }
    for (const r of plan.repoints) {
      keep(r.id);
      await tx.storeRedirect.update({
        where: { id: r.id },
        data: { to_path: r.to_path },
      });
    }
    return {
      ...plan,
      created: creates.length,
      updated,
      unchanged: plan.items.filter((i) => i.action === 'UNCHANGED').length,
      repointed: plan.repoints.length,
      deactivated,
      before,
    };
  }
}

function toView(r: StoreRedirect): RedirectView {
  return {
    id: r.id,
    from_path: r.from_path,
    to_path: r.to_path,
    status_code: r.status_code,
    source: r.source,
    import_run_id: r.import_run_id,
    is_active: r.is_active,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function requirePath(input: string): string {
  const path = normalizeRedirectPath(input);
  if (path === null) throw invalidPath();
  return path;
}

function requireTarget(input: string): string {
  const to = sanitizeRedirectTarget(input);
  if (to === null) throw invalidPath();
  return to;
}

function invalidPath() {
  return new BadRequestException({
    code: 'REDIRECT_INVALID_PATH',
    message: 'Paths must start with "/" and stay on this store.',
  });
}

function duplicate() {
  return new ConflictException({
    code: 'REDIRECT_DUPLICATE',
    message: 'A redirect for this path already exists.',
  });
}

function notFound() {
  return new NotFoundException({
    code: 'REDIRECT_NOT_FOUND',
    message: 'Redirect not found',
  });
}

/** Map.set with a size bound: expired entries first, then the oldest. */
function boundedSet<V extends { expiresAt: number }>(
  map: Map<string, V>,
  key: string,
  value: V,
  max: number,
  now: number,
): void {
  if (!map.has(key) && map.size >= max) {
    for (const [k, v] of map) if (v.expiresAt <= now) map.delete(k);
    while (map.size >= max) {
      const first: IteratorResult<string> = map.keys().next();
      if (first.done) break;
      map.delete(first.value);
    }
  }
  map.delete(key);
  map.set(key, value);
}
