import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';

/**
 * Upload byte budgets in Postgres (M5 W1-C, F11): the per-IP / per-store
 * daily counters of the customer upload and designer photo routes, shared by
 * every API instance. One row per (scope, key, UTC day) in
 * `UploadQuotaWindow`:
 *
 * - check before the body is buffered: one primary-key lookup (O(1));
 * - charge after a stored upload: one atomic
 *   `INSERT … ON CONFLICT DO UPDATE SET bytes = bytes + n RETURNING bytes`.
 *
 * The window is the UTC calendar day ("try again tomorrow"); rows older than
 * two days are purged by the `ops.quota-windows` retention task. Keys are
 * hashed (sha256) so no raw client IP is stored.
 *
 * Nothing here throws: a failing query answers `null` and the caller falls
 * back to its in-memory counter (warned once per `DEGRADED_MS`), so a DB
 * hiccup never blocks uploads. A store built without `$queryRaw` (unit test
 * fakes) is simply unavailable.
 */

export type UploadQuotaScope = 'customer.ip' | 'designer.ip' | 'designer.store';

export interface UploadQuotaStore {
  /** True when the store can be asked right now (cheap, no I/O). */
  available(): boolean;
  /** Bytes charged to `key` in the current window; null = unavailable. */
  used(
    scope: UploadQuotaScope,
    key: string,
    now?: number,
  ): Promise<number | null>;
  /** Adds `bytes` and returns the new window total; null = unavailable. */
  add(
    scope: UploadQuotaScope,
    key: string,
    bytes: number,
    now?: number,
  ): Promise<number | null>;
}

/** After a failure the store answers null without querying for this long. */
export const QUOTA_STORE_DEGRADED_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

type RawQuery = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown>;

interface PrismaLike {
  $queryRaw?: RawQuery;
}

/** Start of the UTC day containing `nowMs`. */
export function quotaWindowStart(nowMs: number): Date {
  return new Date(Math.floor(nowMs / DAY_MS) * DAY_MS);
}

export function quotaKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export class PgUploadQuotaStore implements UploadQuotaStore {
  private readonly logger = new Logger(PgUploadQuotaStore.name);
  private readonly query: RawQuery | null;
  private degradedUntil = 0;

  constructor(
    prisma: PrismaLike | undefined,
    private readonly now: () => number = Date.now,
  ) {
    const q = prisma?.$queryRaw;
    this.query = typeof q === 'function' ? (q.bind(prisma) as RawQuery) : null;
  }

  available(): boolean {
    return this.query !== null && this.now() >= this.degradedUntil;
  }

  async used(
    scope: UploadQuotaScope,
    key: string,
    now: number = this.now(),
  ): Promise<number | null> {
    if (!this.available()) return null;
    const window = quotaWindowStart(now);
    const hashed = quotaKey(key);
    try {
      const rows = (await (this.query as RawQuery)`
        SELECT "bytes" FROM "UploadQuotaWindow"
        WHERE "scope" = ${scope} AND "key" = ${hashed} AND "window_start" = ${window}`) as {
        bytes: bigint | number | string;
      }[];
      return rows.length ? Number(rows[0].bytes) : 0;
    } catch (err) {
      this.degrade('read', err);
      return null;
    }
  }

  async add(
    scope: UploadQuotaScope,
    key: string,
    bytes: number,
    now: number = this.now(),
  ): Promise<number | null> {
    if (!this.available()) return null;
    if (!(bytes > 0)) return this.used(scope, key, now);
    const window = quotaWindowStart(now);
    const hashed = quotaKey(key);
    const n = Math.floor(bytes);
    try {
      const rows = (await (this.query as RawQuery)`
        INSERT INTO "UploadQuotaWindow" ("scope", "key", "window_start", "bytes", "updated_at")
        VALUES (${scope}, ${hashed}, ${window}, ${n}::bigint, ${new Date(now)})
        ON CONFLICT ("scope", "key", "window_start")
        DO UPDATE SET "bytes" = "UploadQuotaWindow"."bytes" + EXCLUDED."bytes",
                      "updated_at" = EXCLUDED."updated_at"
        RETURNING "bytes"`) as { bytes: bigint | number | string }[];
      return rows.length ? Number(rows[0].bytes) : null;
    } catch (err) {
      this.degrade('write', err);
      return null;
    }
  }

  private degrade(op: string, err: unknown): void {
    this.degradedUntil = this.now() + QUOTA_STORE_DEGRADED_MS;
    this.logger.warn(
      `Upload quota ${op} failed, using the in-memory counter for ${QUOTA_STORE_DEGRADED_MS / 1000} s: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
