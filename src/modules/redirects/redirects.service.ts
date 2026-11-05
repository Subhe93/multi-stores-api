import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PageType,
  Prisma,
  RedirectSource,
  StoreRedirect,
  StoreType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  REDIRECT_MAP_MAX_ENTRIES,
  fallbackRedirectPath,
  isRedirectStatusCode,
  normalizeRedirectPath,
  sanitizeRedirectTarget,
} from './redirect-path.util';
import {
  resolveRedirectChain,
  rowsPointingAt,
  type ChainFailureCode,
} from './redirect-chain';
import {
  IncomingRedirect,
  RedirectDeactivation,
  RedirectUpsertPlan,
  planRedirectDeactivations,
  planRedirectUpserts,
  withoutDeactivated,
} from './redirect-plan';
import {
  planSlugChangeRedirects,
  type SlugMove,
  type SlugRedirectPlan,
} from './slug-redirects';
import {
  collectionChainIsLive,
  livePathCandidate,
  slugForms,
  slugKey,
  type LiveContentKind,
} from './redirect-live-content';
import {
  productPath,
  withLocalePrefixes,
  type LocaleSlug,
} from '../../common/slug/slug-moves';
import { SUPPORTED_LOCALES } from '../markets/market.types';
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

/** Rows per bulk CSV upload (`POST redirects/my/bulk`). */
export const BULK_REDIRECT_MAX_ROWS = 5000;

/** One parsed CSV line of a bulk upload (`from_path,to_path,status`). */
export interface BulkRedirectRow {
  /** 1-based line number in the upload (for the conflict report). */
  line: number;
  from_path: string;
  to_path: string;
  status_code?: number;
}

export type BulkCreateConflictCode =
  | 'REDIRECT_INVALID_PATH'
  | 'REDIRECT_DUPLICATE'
  | 'REDIRECT_LIMIT'
  | 'REDIRECT_SHADOWS_LIVE'
  | ChainFailureCode;

export interface BulkCreateResult {
  created: {
    line: number;
    id: string;
    from_path: string;
    to_path: string;
    status_code: number;
  }[];
  conflicts: {
    line: number;
    from_path: string;
    to_path: string;
    code: BulkCreateConflictCode;
  }[];
}

/**
 * Parses the text of a bulk upload: one redirect per line as
 * `from_path,to_path[,status]` (`;` or a tab also separate the fields,
 * quotes around a field are removed). Blank lines, `#` comments and a
 * header line starting with `from_path` are skipped. Line numbers are
 * 1-based positions in the text.
 */
export function parseBulkRedirectCsv(text: string): BulkRedirectRow[] {
  const out: BulkRedirectRow[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith('#')) continue;
    const cells = raw.split(/[,;\t]/).map((c) =>
      c
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .trim(),
    );
    if (i === 0 && /^from(_path)?$/i.test(cells[0] ?? '')) continue;
    const [from_path = '', to_path = '', status = ''] = cells;
    const row: BulkRedirectRow = { line: i + 1, from_path, to_path };
    if (status !== '') row.status_code = Number(status);
    out.push(row);
  }
  return out;
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

/** `GET redirects/my/locale-prefixes`. */
export interface StoreLocales {
  primary_locale: string;
  prefixes: string[];
}

export type ProductPathKind = 'product' | 'custom-product';

export interface ProductPathRef {
  kind: ProductPathKind;
  id: string;
}

export function productPathKey(kind: ProductPathKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Public paths of one product (pure): `/products/<slug>` per translation
 * slug, then `/<prefix>/products/<slug of that locale>` per served prefix,
 * falling back to the primary-locale slug (else the first slug) like
 * productSlugMoves. Locales compare case-insensitively. Deduplicated.
 */
export function productPublicPaths(
  translations: readonly LocaleSlug[],
  primaryLocale: string,
  prefixes: readonly string[],
): string[] {
  const withSlug = translations.filter((t) => !!t.slug);
  if (!withSlug.length) return [];
  const byLocale = new Map<string, string>();
  for (const t of withSlug) {
    const k = t.locale.toLowerCase();
    if (!byLocale.has(k)) byLocale.set(k, t.slug);
  }
  const primarySlug =
    byLocale.get(primaryLocale.toLowerCase()) ?? withSlug[0].slug;
  const out = new Set<string>();
  for (const t of withSlug) out.add(productPath(t.slug));
  for (const l of prefixes) {
    const k = l.toLowerCase();
    out.add(productPath(byLocale.get(k) ?? primarySlug, k));
  }
  return [...out];
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
    if (isActive) await this.assertNotLive(storeId, from);
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
      // Only a new source or a switch-on is checked: a row that already
      // shadows a page (an older MANUAL row) can still get a new target.
      if (isActive && (from !== current.from_path || !current.is_active)) {
        await this.assertNotLive(storeId, from, tx);
      }
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
    const [row, live] = await Promise.all([
      this.findMatch(storeId, path),
      this.liveContentAt(storeId, [normalized]),
    ]);
    return {
      path: normalized,
      // Published content served at this path (a redirect from it is refused
      // with REDIRECT_SHADOWS_LIVE until it is deleted or unpublished).
      live: live.get(normalized) ?? null,
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

  /** 409 REDIRECT_SHADOWS_LIVE when `from` serves published content. */
  private async assertNotLive(
    storeId: string,
    from: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const kind = (await this.liveContentAt(storeId, [from], db)).get(from);
    if (kind) throw shadowsLive(kind);
  }

  /**
   * Normalised paths among `paths` that serve published content of the store
   * right now, with its kind (redirect-live-content.ts): a published own
   * product (or custom product on a non-INDEPENDENT store) with that
   * translation slug, a reachable collection chain, a published legacy page
   * or a published builder STATIC/LANDING page. Deleted, draft or archived
   * content is not live, so a redirect from its old URL is accepted. Same
   * rules for MARKETPLACE and INDEPENDENT stores. Slugs match like the
   * storefront's tolerant lookup: exact first, then case-insensitively for
   * the misses (legacy capitalised slugs). Reads through `db` when given
   * (the caller's transaction).
   */
  async liveContentAt(
    storeId: string,
    paths: readonly string[],
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<Map<string, LiveContentKind>> {
    const out = new Map<string, LiveContentKind>();
    const products = new Map<string, string[]>();
    const pages = new Map<string, string[]>();
    const collections: { path: string; segments: string[] }[] = [];
    const add = (m: Map<string, string[]>, k: string, p: string) =>
      m.set(k, [...(m.get(k) ?? []), p]);
    for (const p of new Set(paths)) {
      const c = livePathCandidate(p);
      if (!c) continue;
      if (c.kind === 'product') add(products, c.slug, p);
      else if (c.kind === 'page') add(pages, c.slug, p);
      else collections.push({ path: p, segments: c.segments });
    }
    if (!products.size && !pages.size && !collections.length) return out;
    const store = await db.store.findUnique({
      where: { id: storeId },
      select: { creator_id: true, store_type: true },
    });
    if (!store) return out;
    type SlugRow = { slug: string | null };
    type SlugWhere =
      | { slug: { in: string[] } }
      | { OR: { slug: { equals: string; mode: 'insensitive' } }[] };
    // Exact `in` lookup, then a case-insensitive pass for the slugs still
    // missing. Matches are compared again in memory (slugKey), so only an
    // exact lower-case NFC match marks a path. Lists are chunked under the
    // Postgres bind-parameter limit.
    const findLive = async (
      by: Map<string, string[]>,
      kind: LiveContentKind,
      queries: ((where: SlugWhere) => Promise<SlugRow[]>)[],
    ) => {
      const mark = (found: readonly SlugRow[]) => {
        const hit = new Set(
          found.flatMap((f) => (f.slug ? [slugKey(f.slug)] : [])),
        );
        for (const [slug, ps] of by)
          if (hit.has(slug)) for (const p of ps) out.set(p, kind);
      };
      const run = async (
        keys: string[],
        size: number,
        where: (part: string[]) => SlugWhere,
      ) => {
        const all: SlugRow[] = [];
        for (const q of queries)
          for (let i = 0; i < keys.length; i += size)
            all.push(...(await q(where(keys.slice(i, i + size)))));
        return all;
      };
      mark(
        await run(slugForms(by.keys()), 5000, (part) => ({
          slug: { in: part },
        })),
      );
      const misses = [...by.entries()]
        .filter(([, ps]) => !out.has(ps[0]))
        .map(([slug]) => slug);
      if (!misses.length) return;
      mark(
        await run(slugForms(misses), 500, (part) => ({
          OR: part.map((s) => ({
            slug: { equals: s, mode: 'insensitive' as const },
          })),
        })),
      );
    };
    if (products.size) {
      await findLive(products, 'product', [
        (where) =>
          db.productTranslation.findMany({
            where: {
              ...where,
              product: { creator_id: store.creator_id, status: 'PUBLISHED' },
            },
            select: { slug: true },
          }),
        ...(store.store_type === StoreType.INDEPENDENT
          ? []
          : [
              (where: SlugWhere) =>
                db.customProductTranslation.findMany({
                  where: {
                    ...where,
                    custom_product: {
                      creator_id: store.creator_id,
                      status: 'PUBLISHED',
                    },
                  },
                  select: { slug: true },
                }),
            ]),
      ]);
    }
    if (pages.size) {
      await findLive(pages, 'page', [
        (where) =>
          db.staticPage.findMany({
            where: { ...where, store_id: storeId, status: 'PUBLISHED' },
            select: { slug: true },
          }),
        (where) =>
          db.page.findMany({
            where: {
              ...where,
              store_id: storeId,
              type: { in: [PageType.STATIC, PageType.LANDING] },
              published_version_id: { not: null },
            },
            select: { slug: true },
          }),
      ]);
    }
    if (collections.length) {
      const rows = await db.creatorCategory.findMany({
        where: { creator_id: store.creator_id },
        select: {
          id: true,
          slug: true,
          parent_id: true,
          is_active: true,
          visibility: true,
        },
      });
      for (const c of collections)
        if (collectionChainIsLive(rows, c.segments))
          out.set(c.path, 'collection');
    }
    return out;
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
    if (!res.ok) throw chainError(res.code);
    // A merchant write re-points every row (MANUAL included) that targeted
    // `from`; an import never touches MANUAL rows (redirect-plan step 5).
    for (const source of rowsPointingAt(map, from, res.to)) {
      await tx.storeRedirect.update({
        where: { id: idByFrom.get(source)! },
        data: { to_path: res.to },
      });
    }
    return res.to;
  }

  /**
   * Bulk creation of MANUAL rows from a CSV upload (M5 B17): one transaction,
   * every row validated and chain-flattened like `create`, nothing updated.
   * A row that cannot be created is reported with its line number and code;
   * the others are still written. At most BULK_REDIRECT_MAX_ROWS rows.
   */
  async bulkCreate(
    storeId: string,
    rows: readonly BulkRedirectRow[],
  ): Promise<BulkCreateResult> {
    if (rows.length > BULK_REDIRECT_MAX_ROWS) {
      throw new BadRequestException({
        code: 'REDIRECT_BULK_TOO_MANY',
        message: `At most ${BULK_REDIRECT_MAX_ROWS} redirects per upload.`,
        limit: BULK_REDIRECT_MAX_ROWS,
      });
    }
    // An empty upload (or a probe) writes nothing: no transaction, no scan.
    if (!rows.length) return { created: [], conflicts: [] };
    const candidates: string[] = [];
    for (const row of rows) {
      const from = normalizeRedirectPath(row.from_path);
      if (from !== null) candidates.push(from);
    }
    const live = await this.liveContentAt(storeId, candidates);
    const result = await this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.storeRedirect.findMany({
          where: { store_id: storeId },
          select: {
            id: true,
            from_path: true,
            to_path: true,
            is_active: true,
          },
        });
        const working = new Map<string, string>();
        const idByFrom = new Map<string, string>();
        const taken = new Set<string>();
        for (const r of existing) {
          taken.add(r.from_path);
          if (r.is_active) {
            working.set(r.from_path, r.to_path);
            idByFrom.set(r.from_path, r.id);
          }
        }
        let room = Math.max(0, REDIRECT_MAX_ROWS_PER_STORE - existing.length);
        const conflicts: BulkCreateResult['conflicts'] = [];
        const created: BulkCreateResult['created'] = [];
        const reject = (row: BulkRedirectRow, code: BulkCreateConflictCode) => {
          conflicts.push({
            line: row.line,
            from_path: row.from_path,
            to_path: row.to_path,
            code,
          });
        };
        for (const row of rows) {
          const from = normalizeRedirectPath(row.from_path);
          const to = sanitizeRedirectTarget(row.to_path);
          const status = row.status_code ?? 301;
          if (from === null || to === null || !isRedirectStatusCode(status)) {
            reject(row, 'REDIRECT_INVALID_PATH');
            continue;
          }
          if (taken.has(from)) {
            reject(row, 'REDIRECT_DUPLICATE');
            continue;
          }
          if (live.has(from)) {
            reject(row, 'REDIRECT_SHADOWS_LIVE');
            continue;
          }
          if (room <= 0) {
            reject(row, 'REDIRECT_LIMIT');
            continue;
          }
          const res = resolveRedirectChain(working, from, to);
          if (!res.ok) {
            reject(row, res.code);
            continue;
          }
          for (const source of rowsPointingAt(working, from, res.to)) {
            const id = idByFrom.get(source);
            if (!id) continue;
            await tx.storeRedirect.update({
              where: { id },
              data: { to_path: res.to },
            });
            working.set(source, res.to);
          }
          const row_ = await tx.storeRedirect.create({
            data: {
              store_id: storeId,
              from_path: from,
              to_path: res.to,
              status_code: status,
              source: RedirectSource.MANUAL,
              is_active: true,
            },
            select: { id: true },
          });
          taken.add(from);
          working.set(from, res.to);
          idByFrom.set(from, row_.id);
          room--;
          created.push({
            line: row.line,
            id: row_.id,
            from_path: from,
            to_path: res.to,
            status_code: status,
          });
        }
        return { created, conflicts };
      },
      { timeout: 120_000 },
    );
    if (result.created.length) this.invalidate(storeId);
    return result;
  }

  // ── Old-slug redirects ───────────────────────────────────────────────────

  /**
   * Writes the 301s of a slug change (WP `_wp_old_slug`): `old → new` per
   * move, chains flattened, rows targeting an old path re-pointed, rows that
   * would shadow a new path switched off; MANUAL rows on an old path are left
   * alone and reported (planSlugChangeRedirects). Runs in `tx` when given
   * (then the caller's transaction owns the commit) and invalidates the
   * store's cached map. Callers pass only moves whose old path is no longer
   * served by anything. Never throws on a conflict: a failed redirect must
   * not undo the merchant's edit.
   */
  async applySlugChangeRedirects(
    storeId: string,
    moves: readonly SlugMove[],
    tx?: Prisma.TransactionClient,
    opts: { localePrefixes?: boolean } = {},
  ): Promise<SlugRedirectPlan | null> {
    if (!moves.length) return null;
    const run = async (db: Prisma.TransactionClient) => {
      const existing = await this.existingForPlan(storeId, db);
      // Collections and root pages have one slug for every locale, so the
      // `/<locale>/…` URLs of the secondary locales moved too.
      const all = opts.localePrefixes
        ? withLocalePrefixes(moves, await this.storeLocalePrefixes(storeId, db))
        : moves;
      const plan = planSlugChangeRedirects(existing, all);
      const room = Math.max(0, REDIRECT_MAX_ROWS_PER_STORE - existing.length);
      if (plan.creates.length > room) {
        this.logger.warn(
          `slug redirects of store ${storeId}: ${plan.creates.length - room} over the row limit, not written`,
        );
        plan.creates = plan.creates.slice(0, room);
      }
      for (const d of plan.deactivations)
        await db.storeRedirect.update({
          where: { id: d.id },
          data: { is_active: false },
        });
      if (plan.creates.length)
        await db.storeRedirect.createMany({
          data: plan.creates.map((c) => ({
            store_id: storeId,
            from_path: c.from_path,
            to_path: c.to_path,
            status_code: 301,
            source: RedirectSource.SLUG_CHANGE,
            is_active: true,
          })),
          skipDuplicates: true,
        });
      for (const u of plan.updates)
        await db.storeRedirect.update({
          where: { id: u.id },
          data: {
            to_path: u.to_path,
            status_code: 301,
            is_active: true,
            source: RedirectSource.SLUG_CHANGE,
          },
        });
      for (const r of plan.repoints)
        await db.storeRedirect.update({
          where: { id: r.id },
          data: { to_path: r.to_path },
        });
      return plan;
    };
    try {
      const plan = tx ? await run(tx) : await this.prisma.$transaction(run);
      for (const c of plan.conflicts)
        this.logger.warn(
          `slug redirect ${c.from_path} -> ${c.to_path} of store ${storeId} not written: ${c.code}`,
        );
      this.invalidate(storeId);
      return plan;
    } catch (err) {
      if (tx) throw err;
      this.logger.error(
        `slug redirects of store ${storeId} failed: ${String(err)}`,
      );
      return null;
    }
  }

  /**
   * Locale prefixes the storefront serves for a store (`/<locale>/…`): its
   * secondary content locales and its market locales, lower-cased, limited to
   * the locales the web proxy recognizes, the primary locale excluded.
   */
  async storeLocalePrefixes(
    storeId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<string[]> {
    return (await this.storeLocales(storeId, db)).prefixes;
  }

  /**
   * The store's primary content locale (lower case, 'en' when unset) and the
   * prefixes of storeLocalePrefixes. `GET redirects/my/locale-prefixes`.
   */
  async storeLocales(
    storeId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<StoreLocales> {
    const [cfg, markets] = await Promise.all([
      db.storeLanguageConfig.findUnique({
        where: { store_id: storeId },
        select: { primary_locale: true, secondary_locales: true },
      }),
      db.market.findMany({
        where: { store_id: storeId },
        select: { locales: true },
      }),
    ]);
    const primary = (cfg?.primary_locale || 'en').toLowerCase();
    const known = new Set<string>(SUPPORTED_LOCALES);
    const out = new Set<string>();
    for (const l of [
      ...(cfg?.secondary_locales ?? []),
      ...markets.flatMap((m) => m.locales ?? []),
    ]) {
      const k = String(l).toLowerCase();
      if (known.has(k) && k !== primary) out.add(k);
    }
    return { primary_locale: primary, prefixes: [...out] };
  }

  /**
   * Every public path of the store's own products / custom products (the
   * dashboard collects them BEFORE a delete, as redirect sources):
   * `/products/<slug>` for each translation slug, plus
   * `/<locale>/products/<slug>` for each served locale prefix with that
   * locale's slug (the primary-locale slug when it has none), as
   * productSlugMoves builds them. Deduplicated, percent-encoded like the
   * slug moves. An item of another store (or unknown) gets no entry; a
   * custom product of an INDEPENDENT store gets an empty list (not served). Status is not
   * checked: an archived item's old URLs may still be indexed.
   */
  async productPaths(
    storeId: string,
    items: readonly ProductPathRef[],
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!items.length) return out;
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { creator_id: true, store_type: true },
    });
    if (!store) return out;
    const ids = (kind: ProductPathKind) => [
      ...new Set(items.filter((i) => i.kind === kind).map((i) => i.id)),
    ];
    const productIds = ids('product');
    const customIds = ids('custom-product');
    const [own, custom, locales] = await Promise.all([
      productIds.length
        ? this.prisma.product.findMany({
            where: { id: { in: productIds }, creator_id: store.creator_id },
            select: {
              id: true,
              translations: { select: { locale: true, slug: true } },
            },
          })
        : [],
      customIds.length
        ? this.prisma.customProduct.findMany({
            where: { id: { in: customIds }, creator_id: store.creator_id },
            select: {
              id: true,
              translations: { select: { locale: true, slug: true } },
            },
          })
        : [],
      this.storeLocales(storeId),
    ]);
    const build = (translations: readonly LocaleSlug[]) =>
      productPublicPaths(
        translations,
        locales.primary_locale,
        locales.prefixes,
      );
    for (const p of own)
      out.set(productPathKey('product', p.id), build(p.translations));
    // INDEPENDENT stores do not serve custom products: owned, no paths.
    const servesCustom = store.store_type !== StoreType.INDEPENDENT;
    for (const p of custom)
      out.set(
        productPathKey('custom-product', p.id),
        servesCustom ? build(p.translations) : [],
      );
    return out;
  }

  /**
   * Switches off active IMPORT / SLUG_CHANGE rows whose source is a path the
   * store serves again (a new or re-published product, collection or page
   * that took an old slug). The proxy matches redirects before routing, so
   * such a row would shadow the live page; WP's old-slug redirect only runs
   * on a 404. MANUAL rows are the merchant's and are left alone. With
   * `localePrefixes` the `/<locale>/…` forms are released too. Never throws:
   * a failure must not undo the merchant's edit.
   */
  async releaseLivePaths(
    storeId: string,
    paths: readonly string[],
    opts: { localePrefixes?: boolean } = {},
  ): Promise<number> {
    if (!paths.length) return 0;
    try {
      const prefixes = opts.localePrefixes
        ? await this.storeLocalePrefixes(storeId)
        : [];
      const keys = new Set<string>();
      for (const p of paths) {
        for (const q of [p, ...prefixes.map((l) => `/${l}${p}`)]) {
          const k = normalizeRedirectPath(q);
          if (k) keys.add(k);
        }
      }
      const all = [...keys];
      let total = 0;
      for (let i = 0; i < all.length; i += 5000) {
        const { count } = await this.prisma.storeRedirect.updateMany({
          where: {
            store_id: storeId,
            is_active: true,
            source: { not: RedirectSource.MANUAL },
            from_path: { in: all.slice(i, i + 5000) },
          },
          data: { is_active: false },
        });
        total += count;
      }
      if (total) this.invalidate(storeId);
      return total;
    } catch (err) {
      this.logger.error(
        `releasing live paths of store ${storeId} failed: ${String(err)}`,
      );
      return 0;
    }
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

function chainError(code: ChainFailureCode) {
  return new ConflictException({
    code,
    message:
      code === 'REDIRECT_LOOP'
        ? 'This redirect would create a loop.'
        : 'This redirect would chain through too many other redirects.',
  });
}

function shadowsLive(kind: LiveContentKind) {
  return new ConflictException({
    code: 'REDIRECT_SHADOWS_LIVE',
    message:
      'This address still shows a published ' +
      kind +
      '. Delete, unpublish or rename it first, then add the redirect.',
    kind,
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
