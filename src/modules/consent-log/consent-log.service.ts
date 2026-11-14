import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RetentionService } from '../retention/retention.service';
import type {
  RetentionRunOptions,
  RetentionTaskResult,
} from '../retention/retention.types';
import { csvHeader, csvLine } from './csv';
import type {
  ExportConsentLogQueryDto,
  ListConsentLogQueryDto,
  LogConsentDto,
} from './dto/consent-log.dto';
import { ipPrefix } from './ip-prefix';

/** Consent-log rows older than this are purged (`consent-log` retention task, 24 months). */
export const CONSENT_LOG_KEEP_MS = 730 * 24 * 60 * 60 * 1000;
export const CONSENT_LOG_RETENTION_KEY = 'consent-log';
/** The user agent is cut to this length before hashing. */
export const CONSENT_UA_MAX = 512;
export const CONSENT_LIST_DEFAULT_LIMIT = 50;
export const CONSENT_SUMMARY_DEFAULT_DAYS = 30;
export const CONSENT_EXPORT_MAX_ROWS = 100_000;
export const CONSENT_EXPORT_PAGE = 1_000;
export const CONSENT_EXPORT_MAX_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Only the id: the slug resolves to the store the decision belongs to. */
export const consentStoreSelect = {
  id: true,
} satisfies Prisma.StoreSelect;

/** Slug of the owner's store, for the export file name. */
export const consentStoreSlugSelect = {
  slug: true,
} satisfies Prisma.StoreSelect;

/** Owner list / export columns. `ip_prefix` and `ua_hash` are never returned. */
export const consentLogOwnerSelect = {
  id: true,
  created_at: true,
  consent_id: true,
  action: true,
  source: true,
  analytics: true,
  marketing: true,
  external_media: true,
  consent_version: true,
  vendors: true,
  locale: true,
  text_hash: true,
} satisfies Prisma.ConsentLogSelect;

export type ConsentLogOwnerRow = Prisma.ConsentLogGetPayload<{
  select: typeof consentLogOwnerSelect;
}>;

export interface ConsentRequestMeta {
  ip: string | null;
  userAgent: string | null | undefined;
}

export interface ConsentLogSummary {
  days: number;
  total: number;
  accept_all: number;
  reject_all: number;
  save: number;
  analytics_granted: number;
  marketing_granted: number;
  external_media_granted: number;
}

export interface CreatedAtRange {
  gte?: Date;
  lt?: Date;
  lte?: Date;
}

/** sha256 hex of the user agent (cut to 512 chars), or null without one. */
export function uaHash(ua: string | null | undefined): string | null {
  if (typeof ua !== 'string' || ua.trim() === '') return null;
  return createHash('sha256')
    .update(ua.slice(0, CONSENT_UA_MAX), 'utf8')
    .digest('hex');
}

/** A date-only value ("2026-11-14") means a whole day; anything else is an instant. */
function isDateOnly(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function parseDate(v: string, field: string): Date {
  const d = new Date(isDateOnly(v) ? `${v}T00:00:00.000Z` : v);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException({
      code: 'CONSENT_LOG_BAD_DATE',
      message: `Invalid ${field}`,
    });
  }
  return d;
}

/**
 * `created_at` filter of `from` / `to`: `from` is inclusive; a date-only
 * `to` covers that whole day (exclusive next midnight UTC), a timestamp
 * `to` is inclusive.
 */
export function createdAtRange(from?: string, to?: string): CreatedAtRange {
  const range: CreatedAtRange = {};
  if (from) range.gte = parseDate(from, 'from');
  if (to) {
    const d = parseDate(to, 'to');
    if (isDateOnly(to)) range.lt = new Date(d.getTime() + DAY_MS);
    else range.lte = d;
  }
  return range;
}

/**
 * Consent v2 consent log (plans/consent-v2/CONTRACT.md §5): one row per
 * visitor decision as proof of consent (GDPR art. 7(1)), no raw IP or user
 * agent, purged after 24 months; owner list / summary / CSV export.
 */
@Injectable()
export class ConsentLogService implements OnModuleInit {
  private readonly logger = new Logger(ConsentLogService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly retention?: RetentionService,
  ) {}

  onModuleInit(): void {
    this.retention?.registerTask({
      key: CONSENT_LOG_RETENTION_KEY,
      run: (now, opts) => this.purge(now, opts),
    });
  }

  /**
   * Stores one decision. A repeated `event_id` of the same store is a no-op
   * (ON CONFLICT DO NOTHING). 404 for an unknown slug.
   */
  async record(
    slug: string,
    dto: LogConsentDto,
    meta: ConsentRequestMeta,
  ): Promise<void> {
    const store = await this.prisma.store.findUnique({
      where: { slug },
      select: consentStoreSelect,
    });
    if (!store) {
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    }
    const row: Prisma.ConsentLogCreateManyInput = {
      store_id: store.id,
      event_id: dto.event_id,
      consent_id: dto.consent_id,
      action: dto.action,
      source: dto.source,
      analytics: dto.analytics ?? null,
      marketing: dto.marketing ?? null,
      external_media: dto.external_media ?? null,
      consent_version: dto.consent_version,
      vendors: [...dto.vendors].sort(),
      text_hash: dto.text_hash,
      locale: dto.locale,
      ua_hash: uaHash(meta.userAgent),
      ip_prefix: ipPrefix(meta.ip),
    };
    await this.prisma.consentLog.createMany({
      data: [row],
      skipDuplicates: true,
    });
  }

  /** Newest first, keyset cursor on `created_at` (`next_before`). */
  async list(
    storeId: string,
    q: ListConsentLogQueryDto,
  ): Promise<{ items: ConsentLogOwnerRow[]; next_before: string | null }> {
    const limit = q.limit ?? CONSENT_LIST_DEFAULT_LIMIT;
    const created_at: CreatedAtRange = createdAtRange(q.from, q.to);
    if (q.before) {
      const before = parseDate(q.before, 'before');
      created_at.lt =
        created_at.lt && created_at.lt < before ? created_at.lt : before;
    }
    const where: Prisma.ConsentLogWhereInput = {
      store_id: storeId,
      ...(q.consent_id ? { consent_id: q.consent_id } : {}),
      ...(Object.keys(created_at).length ? { created_at } : {}),
    };
    const rows = await this.prisma.consentLog.findMany({
      where,
      select: consentLogOwnerSelect,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const items = rows.slice(0, limit);
    const next_before =
      rows.length > limit && items.length
        ? items[items.length - 1].created_at.toISOString()
        : null;
    return { items, next_before };
  }

  /** Decision counts of the last `days` days. */
  async summary(storeId: string, days: number): Promise<ConsentLogSummary> {
    const since = new Date(Date.now() - days * DAY_MS);
    const where: Prisma.ConsentLogWhereInput = {
      store_id: storeId,
      created_at: { gte: since },
    };
    const [byAction, analytics, marketing, external] = await Promise.all([
      this.prisma.consentLog.groupBy({
        by: ['action'],
        where,
        _count: { _all: true },
      }),
      this.prisma.consentLog.count({ where: { ...where, analytics: true } }),
      this.prisma.consentLog.count({ where: { ...where, marketing: true } }),
      this.prisma.consentLog.count({
        where: { ...where, external_media: true },
      }),
    ]);
    const counts = new Map<string, number>();
    for (const g of byAction) counts.set(g.action, g._count._all);
    let total = 0;
    for (const n of counts.values()) total += n;
    return {
      days,
      total,
      accept_all: counts.get('accept_all') ?? 0,
      reject_all: counts.get('reject_all') ?? 0,
      save: counts.get('save') ?? 0,
      analytics_granted: analytics,
      marketing_granted: marketing,
      external_media_granted: external,
    };
  }

  /** Validates the export window: both bounds, from <= to, at most 366 days. */
  exportRange(q: ExportConsentLogQueryDto): CreatedAtRange {
    const range = createdAtRange(q.from, q.to);
    const start = range.gte!.getTime();
    const end = (range.lt ?? range.lte)!.getTime();
    if (end < start) {
      throw new BadRequestException({
        code: 'CONSENT_LOG_BAD_RANGE',
        message: '`to` is before `from`',
      });
    }
    // A date-only `to` ends at the next midnight (exclusive), so allow that day.
    const maxMs = (CONSENT_EXPORT_MAX_DAYS + (range.lt ? 1 : 0)) * DAY_MS;
    if (end - start > maxMs) {
      throw new BadRequestException({
        code: 'CONSENT_LOG_RANGE_TOO_LONG',
        message: `At most ${CONSENT_EXPORT_MAX_DAYS} days per export`,
      });
    }
    return range;
  }

  /**
   * CSV chunks (header first) of the window, oldest first, read in pages of
   * 1,000 with a keyset cursor, at most 100,000 rows.
   */
  async *exportCsv(
    storeId: string,
    range: CreatedAtRange,
  ): AsyncGenerator<string> {
    yield csvHeader();
    let cursor: string | null = null;
    let sent = 0;
    while (sent < CONSENT_EXPORT_MAX_ROWS) {
      const take = Math.min(
        CONSENT_EXPORT_PAGE,
        CONSENT_EXPORT_MAX_ROWS - sent,
      );
      const rows: ConsentLogOwnerRow[] = await this.prisma.consentLog.findMany({
        where: { store_id: storeId, created_at: range },
        select: consentLogOwnerSelect,
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!rows.length) return;
      yield rows.map(csvLine).join('');
      sent += rows.length;
      if (rows.length < take) return;
      cursor = rows[rows.length - 1].id;
    }
  }

  /** Slug of the owner's store (export file name). */
  async storeSlug(storeId: string): Promise<string> {
    const s = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: consentStoreSlugSelect,
    });
    return s?.slug ?? 'store';
  }

  /**
   * Retention task `consent-log`: deletes rows older than 24 months in
   * batches of `opts.limit` until a batch comes back short or the run
   * deadline is reached. A dry run only counts.
   */
  async purge(
    now: Date,
    opts: RetentionRunOptions,
  ): Promise<RetentionTaskResult> {
    const cutoff = new Date(now.getTime() - CONSENT_LOG_KEEP_MS);
    if (opts.dryRun) {
      const rows = await this.prisma.$queryRaw<{ n: bigint | number }[]>`
        SELECT count(*) AS n FROM "ConsentLog" WHERE "created_at" < ${cutoff}`;
      return { purged: Number(rows[0]?.n ?? 0), skipped: 0, errors: 0 };
    }
    let purged = 0;
    for (;;) {
      if (opts.deadline !== undefined && Date.now() >= opts.deadline) break;
      const n = await this.prisma.$executeRaw`
        DELETE FROM "ConsentLog" WHERE "id" IN (
          SELECT "id" FROM "ConsentLog" WHERE "created_at" < ${cutoff}
          ORDER BY "created_at" LIMIT ${opts.limit})`;
      purged += n;
      if (n < opts.limit) break;
    }
    if (purged) this.logger.log(`Consent log: purged ${purged} rows`);
    return { purged, skipped: 0, errors: 0 };
  }
}
