import type { Readable } from 'stream';

/**
 * Where offsite copies of backups go (plans/s3-storage/SPEC.md "Backups").
 *
 * Deliberately tiny and independent of the storage module (built in
 * parallel): the backups module only needs to put an object, read it back,
 * check it and list a prefix. Keys in the backup bucket:
 *   db/<yyyy-mm-dd>/<dump file>          pg_dump custom-format archive
 *   files/<yyyy-mm-dd>/<tar.gz file>     uploads + private + invoice dirs
 *   manifests/<yyyy-mm-dd>.json          success marker of the cron script
 *   manifests/<yyyy-mm-dd>-app-<id>.json success marker of an in-app backup
 */

/** Nest injection token of the sink implementation. */
export const BACKUP_OBJECT_SINK = Symbol('BACKUP_OBJECT_SINK');

/** Metadata key carrying the hex SHA-256 of the object body. */
export const SHA256_METADATA_KEY = 'sha256';

/**
 * Retention tier of an object (INFRA.md §3.5): the lifecycle expires
 * `daily` after 14 d, `weekly` after 56 d and `monthly` after 365 d, and
 * weekly/monthly objects additionally carry a per-object GOVERNANCE lock
 * until that date (the bucket default is 14 d).
 */
export type BackupTier = 'daily' | 'weekly' | 'monthly';

export const TIER_TAG_KEY = 'tier';
/** Days of per-object GOVERNANCE retention; daily uses the bucket default. */
export const TIER_RETENTION_DAYS: Readonly<Record<BackupTier, number | null>> =
  { daily: null, weekly: 56, monthly: 365 };

export interface BackupSinkPutOptions {
  contentType: string;
  /** `kms` = SSE-KMS with the configured key, `s3` = SSE-S3 (AES256). */
  sse?: 'kms' | 's3';
  /** Body length in bytes; required for streams (S3 needs Content-Length). */
  contentLength?: number;
  /**
   * Hex SHA-256 of the body; stored as `x-amz-meta-sha256` AND sent as the
   * `ChecksumSHA256` of the PutObject, so S3 refuses a body that does not
   * hash to it (the end-to-end integrity check; no read-back needed).
   */
  sha256?: string;
  metadata?: Record<string, string>;
  /**
   * Object tag `tier=<tier>` (lifecycle rules select on it). Sent only when
   * the sink runs with `S3_BACKUP_OBJECT_LOCK=true`; otherwise ignored.
   */
  tier?: BackupTier;
  /** Per-object Object Lock (GOVERNANCE) until this date; same gate as `tier`. */
  retainUntil?: Date;
}

export interface BackupSinkPutResult {
  etag: string | null;
  size: number;
}

export interface BackupSinkHead {
  size: number;
  etag: string | null;
  lastModified: Date | null;
  /** User metadata, lower-case keys (`sha256`, ...). */
  metadata: Record<string, string>;
}

export interface BackupSinkObject {
  key: string;
  size: number;
  lastModified: Date | null;
}

export interface BackupSinkGet {
  stream: Readable;
  size: number;
  metadata: Record<string, string>;
}

/**
 * The writer credentials (`ms-backup-writer`, INFRA.md §5.2) allow Put, tag,
 * retention and List only: the upload path must never need GetObject or
 * HeadObject. `sizeOf` (ListObjectsV2 on the exact key) is the only
 * read-back the upload does; `head`/`get` need the restore policy and are
 * used by the in-app restore/download only.
 */
export interface BackupObjectSink {
  /** False for the no-op sink: nothing is uploaded, lists are empty. */
  readonly enabled: boolean;
  /** Bucket name (or `local`) for log lines; never credentials. */
  readonly target: string;
  put(
    key: string,
    body: Readable | Buffer,
    options: BackupSinkPutOptions,
  ): Promise<BackupSinkPutResult>;
  /** Size of the object by listing its exact key (writer policy); null when absent. */
  sizeOf(key: string): Promise<number | null>;
  /** HeadObject: needs `s3:GetObject` (restore policy). */
  head(key: string): Promise<BackupSinkHead | null>;
  list(prefix: string): Promise<BackupSinkObject[]>;
  /** GetObject: needs `s3:GetObject` (restore policy). */
  get(key: string): Promise<BackupSinkGet | null>;
}

/**
 * The sink used when no backup bucket is configured: every put fails with
 * a clear error (callers check `enabled` first), heads and gets answer
 * "not found" and lists are empty.
 */
export class NoopBackupObjectSink implements BackupObjectSink {
  readonly enabled = false;
  readonly target = 'local';

  put(): Promise<BackupSinkPutResult> {
    return Promise.reject(
      new Error('BACKUP_OFFSITE_DISABLED: S3_BACKUP_BUCKET is not set'),
    );
  }

  sizeOf(): Promise<number | null> {
    return Promise.resolve(null);
  }

  head(): Promise<BackupSinkHead | null> {
    return Promise.resolve(null);
  }

  list(): Promise<BackupSinkObject[]> {
    return Promise.resolve([]);
  }

  get(): Promise<BackupSinkGet | null> {
    return Promise.resolve(null);
  }
}

/** `2026-11-03` (UTC) — the date folder of the offsite keys. */
export function offsiteDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Object key of a dump file copied on `at`. */
export function dbObjectKey(at: Date, fileName: string): string {
  return `db/${offsiteDate(at)}/${fileName}`;
}

/** Object key of a files archive copied on `at`. */
export function filesObjectKey(at: Date, fileName: string): string {
  return `files/${offsiteDate(at)}/${fileName}`;
}

/** Success marker written by the in-app upload (next to the cron's one). */
export function appManifestKey(at: Date, backupId: string): string {
  return `manifests/${offsiteDate(at)}-app-${backupId.slice(0, 8)}.json`;
}

/** Prefix every success marker (cron and in-app) lives under. */
export const MANIFEST_PREFIX = 'manifests/';

/**
 * Tier of a backup taken at `at` (UTC): the 1st of a month is `monthly`,
 * a Sunday `weekly`, anything else `daily` (INFRA.md §3.5: "weekly =
 * Sunday, monthly = 1st of month").
 */
export function backupTier(at: Date): BackupTier {
  if (at.getUTCDate() === 1) return 'monthly';
  if (at.getUTCDay() === 0) return 'weekly';
  return 'daily';
}

/** GOVERNANCE retain-until date of a tier, or null for the bucket default. */
export function retainUntilFor(tier: BackupTier, at: Date): Date | null {
  const days = TIER_RETENTION_DAYS[tier];
  if (days === null) return null;
  return new Date(at.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Tier + retention of every object of one backup run. */
export function tierOptions(at: Date): {
  tier: BackupTier;
  retainUntil?: Date;
} {
  const tier = backupTier(at);
  const retainUntil = retainUntilFor(tier, at);
  return retainUntil ? { tier, retainUntil } : { tier };
}
