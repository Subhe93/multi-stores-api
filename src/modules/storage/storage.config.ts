/**
 * Storage environment (SPEC.md "Decisions"). Parsed once at boot with clear
 * startup errors; nothing here is ever logged except booleans and bucket
 * names (credentials stay in the SDK default chain: AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY or an IAM role).
 *
 *   STORAGE_DRIVER=local|s3        default local
 *   AWS_REGION                     required when any bucket is used
 *   S3_MEDIA_BUCKET                required with driver s3
 *   S3_PRIVATE_BUCKET              required with driver s3
 *   S3_BACKUP_BUCKET               optional; when set, backups go offsite
 *                                  even with driver local (Phase 1)
 *   S3_MEDIA_PREFIX / S3_PRIVATE_PREFIX / S3_BACKUP_PREFIX
 *                                  key prefix of each role inside its bucket
 *                                  (defaults media/, private/, backups/;
 *                                  normalised to end with `/`; empty = none).
 *                                  The three roles may share ONE bucket as
 *                                  long as their prefixes differ. DB values
 *                                  stay role-relative, so moving a role to
 *                                  its own bucket later is an env change.
 *   S3_KMS_KEY_ID                  optional; SSE-KMS for private + backup;
 *                                  unset = no SSE header (bucket default)
 *   STORAGE_DELETE_MODE=try|skip   default try: DeleteObject, a refused
 *                                  permission is logged once and swallowed;
 *                                  skip: never call DeleteObject
 *   S3_BACKUP_OBJECT_LOCK=true|false default false: send the tier tag and
 *                                  the per-object GOVERNANCE lock on backup
 *                                  uploads (needs PutObjectTagging /
 *                                  PutObjectRetention on the key)
 *   S3_ENDPOINT / S3_FORCE_PATH_STYLE   optional (minio / tests)
 *   MEDIA_LOCAL_FALLBACK=true|false default true (dual-read in s3 mode)
 *   MEDIA_BASE_URL                 optional; default PUBLIC_API_URL
 *   STORAGE_STRICT_STARTUP=true|false default true (refuse to start when the
 *                                  media/private probe fails in s3 mode;
 *                                  the backup bucket only warns)
 *   BACKUP_AWS_ACCESS_KEY_ID / BACKUP_AWS_SECRET_ACCESS_KEY
 *                                  optional (+ BACKUP_AWS_SESSION_TOKEN): the
 *                                  `ms-backup-writer` key used for the backup
 *                                  bucket only (INFRA.md §5.2). Unset = the
 *                                  SDK default chain (the API key; fine when
 *                                  one bucket holds every role).
 */
import * as path from 'path';
import { defaultPrivateStorageDir } from '../../common/storage/private-file-storage';
import { defaultInvoiceStorageDir } from '../../modules/invoices/storage/invoice-storage';
import {
  InvalidObjectKeyError,
  normalizeKeyPrefix,
  type BucketRole,
} from './object-storage';

export type StorageDriver = 'local' | 's3';
export type StorageDeleteMode = 'try' | 'skip';

export const DEFAULT_KEY_PREFIXES: Readonly<Record<BucketRole, string>> = {
  media: 'media/',
  private: 'private/',
  backup: 'backups/',
};

export interface StorageConfig {
  driver: StorageDriver;
  region: string | null;
  endpoint: string | null;
  forcePathStyle: boolean | null;
  kmsKeyId: string | null;
  mediaBucket: string | null;
  privateBucket: string | null;
  backupBucket: string | null;
  /** Key prefix of each role inside its bucket ('' or `<x>/`). */
  mediaPrefix: string;
  privatePrefix: string;
  backupPrefix: string;
  /** `try` (default) or `skip` (never issue DeleteObject). */
  deleteMode: StorageDeleteMode;
  /** Send tier tags + per-object Object Lock on backup uploads (default false). */
  backupObjectLock: boolean;
  /** Backups go to S3 whenever the bucket is set (independent of the driver). */
  backupDriver: StorageDriver;
  mediaLocalFallback: boolean;
  strictStartup: boolean;
  /** Absolute base URL for public media (no trailing slash) or null. */
  mediaBaseUrl: string | null;
  /** Local roots (used by the local driver and by the dual-read fallback). */
  local: {
    uploadsDir: string;
    privateDir: string;
    invoicesDir: string;
    backupsDir: string;
  };
  /** Whether AWS credentials are present in the environment (boolean only). */
  credentialsInEnv: boolean;
  /**
   * Dedicated credentials of the backup bucket (`BACKUP_AWS_*`), or null to
   * use the SDK default chain. Never logged.
   */
  backupCredentials: BackupCredentials | null;
}

export interface BackupCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export class StorageConfigError extends Error {
  constructor(message: string) {
    super(`[storage] ${message}`);
    this.name = 'StorageConfigError';
  }
}

function str(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name];
  return v && v.trim() ? v.trim() : null;
}

export function envBool(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = str(env, name);
  if (raw === null) return fallback;
  const v = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new StorageConfigError(
    `${name} must be true or false (got ${JSON.stringify(raw)})`,
  );
}

/** `STORAGE_DRIVER` alone (cheap check for the disk guards). */
export function storageDriver(
  env: NodeJS.ProcessEnv = process.env,
): StorageDriver {
  const raw = str(env, 'STORAGE_DRIVER')?.toLowerCase() ?? 'local';
  if (raw === 'local' || raw === 's3') return raw;
  throw new StorageConfigError(
    `STORAGE_DRIVER must be "local" or "s3" (got ${JSON.stringify(raw)})`,
  );
}

/** True when media/private files live on S3 (free-disk guards are skipped). */
export function isS3Driver(env: NodeJS.ProcessEnv = process.env): boolean {
  return storageDriver(env) === 's3';
}

/** `STORAGE_DELETE_MODE` (default `try`). */
export function storageDeleteMode(
  env: NodeJS.ProcessEnv = process.env,
): StorageDeleteMode {
  const raw = str(env, 'STORAGE_DELETE_MODE')?.toLowerCase() ?? 'try';
  if (raw === 'try' || raw === 'skip') return raw;
  throw new StorageConfigError(
    `STORAGE_DELETE_MODE must be "try" or "skip" (got ${JSON.stringify(raw)})`,
  );
}

/**
 * Per-role key prefix from `S3_<ROLE>_PREFIX`: an unset variable means the
 * default (`media/`, `private/`, `backups/`); a set-but-empty one means no
 * prefix. Normalised to `<x>/`.
 */
export function keyPrefixFor(env: NodeJS.ProcessEnv, role: BucketRole): string {
  const name = `S3_${role.toUpperCase()}_PREFIX`;
  const raw = env[name];
  if (raw === undefined) return DEFAULT_KEY_PREFIXES[role];
  try {
    return normalizeKeyPrefix(raw);
  } catch (e) {
    if (e instanceof InvalidObjectKeyError) {
      throw new StorageConfigError(
        `${name} is not a valid key prefix (got ${JSON.stringify(raw)})`,
      );
    }
    throw e;
  }
}

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function bucket(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = str(env, name);
  if (v !== null && !BUCKET_RE.test(v)) {
    throw new StorageConfigError(`${name} is not a valid bucket name`);
  }
  return v;
}

/**
 * Two roles may share a bucket only under different prefixes: with the
 * same bucket AND the same prefix their keys would collide (`uploads/…`
 * of media next to private namespaces, backups next to both).
 */
function assertDistinctLocations(
  roles: { role: BucketRole; bucket: string | null; prefix: string }[],
): void {
  const seen = new Map<string, BucketRole>();
  for (const r of roles) {
    if (!r.bucket) continue;
    const loc = `${r.bucket}/${r.prefix}`;
    const other = seen.get(loc);
    if (other) {
      throw new StorageConfigError(
        `${other} and ${r.role} share bucket "${r.bucket}" with the same key prefix ${JSON.stringify(
          r.prefix,
        )}; give each role its own prefix (S3_${other.toUpperCase()}_PREFIX / S3_${r.role.toUpperCase()}_PREFIX) or its own bucket`,
      );
    }
    seen.set(loc, r.role);
  }
}

export function parseStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): StorageConfig {
  const driver = storageDriver(env);
  const region = str(env, 'AWS_REGION');
  const mediaBucket = bucket(env, 'S3_MEDIA_BUCKET');
  const privateBucket = bucket(env, 'S3_PRIVATE_BUCKET');
  const backupBucket = bucket(env, 'S3_BACKUP_BUCKET');
  const mediaPrefix = keyPrefixFor(env, 'media');
  const privatePrefix = keyPrefixFor(env, 'private');
  const backupPrefix = keyPrefixFor(env, 'backup');
  const endpoint = str(env, 'S3_ENDPOINT');
  if (endpoint && !/^https?:\/\//i.test(endpoint)) {
    throw new StorageConfigError('S3_ENDPOINT must be an http(s) URL');
  }
  const forcePathStyleRaw = str(env, 'S3_FORCE_PATH_STYLE');
  const forcePathStyle =
    forcePathStyleRaw === null
      ? null
      : envBool(env, 'S3_FORCE_PATH_STYLE', false);

  if (driver === 's3') {
    const missing = [
      ['S3_MEDIA_BUCKET', mediaBucket],
      ['S3_PRIVATE_BUCKET', privateBucket],
      ['AWS_REGION', region],
    ]
      .filter(([, v]) => !v)
      .map(([n]) => n);
    if (missing.length) {
      throw new StorageConfigError(
        `STORAGE_DRIVER=s3 needs ${missing.join(', ')}`,
      );
    }
  }
  const backupDriver: StorageDriver = backupBucket ? 's3' : 'local';
  if (backupDriver === 's3' && !region) {
    throw new StorageConfigError('S3_BACKUP_BUCKET needs AWS_REGION');
  }
  assertDistinctLocations([
    { role: 'media', bucket: mediaBucket, prefix: mediaPrefix },
    { role: 'private', bucket: privateBucket, prefix: privatePrefix },
    { role: 'backup', bucket: backupBucket, prefix: backupPrefix },
  ]);

  const mediaBase = str(env, 'MEDIA_BASE_URL') ?? str(env, 'PUBLIC_API_URL');
  const mediaBaseUrl = mediaBase ? mediaBase.replace(/\/+$/, '') : null;

  const backupsDir = str(env, 'BACKUP_DIR');
  const invoicesDir = str(env, 'INVOICE_STORAGE_DIR');

  const backupKeyId = str(env, 'BACKUP_AWS_ACCESS_KEY_ID');
  const backupSecret = str(env, 'BACKUP_AWS_SECRET_ACCESS_KEY');
  if (!!backupKeyId !== !!backupSecret) {
    throw new StorageConfigError(
      'BACKUP_AWS_ACCESS_KEY_ID and BACKUP_AWS_SECRET_ACCESS_KEY must be set together',
    );
  }
  const backupSession = str(env, 'BACKUP_AWS_SESSION_TOKEN');
  const backupCredentials: BackupCredentials | null =
    backupKeyId && backupSecret
      ? {
          accessKeyId: backupKeyId,
          secretAccessKey: backupSecret,
          ...(backupSession ? { sessionToken: backupSession } : {}),
        }
      : null;

  return {
    driver,
    region,
    endpoint,
    forcePathStyle,
    kmsKeyId: str(env, 'S3_KMS_KEY_ID'),
    mediaBucket,
    privateBucket,
    backupBucket,
    mediaPrefix,
    privatePrefix,
    backupPrefix,
    deleteMode: storageDeleteMode(env),
    backupObjectLock: envBool(env, 'S3_BACKUP_OBJECT_LOCK', false),
    backupDriver,
    mediaLocalFallback: envBool(env, 'MEDIA_LOCAL_FALLBACK', true),
    strictStartup: envBool(env, 'STORAGE_STRICT_STARTUP', true),
    mediaBaseUrl,
    local: {
      uploadsDir: path.join(cwd, 'uploads'),
      privateDir: defaultPrivateStorageDir(),
      invoicesDir: invoicesDir
        ? path.resolve(invoicesDir)
        : defaultInvoiceStorageDir(),
      backupsDir: backupsDir
        ? path.resolve(backupsDir)
        : path.join(cwd, 'backups'),
    },
    credentialsInEnv: !!(
      str(env, 'AWS_ACCESS_KEY_ID') && str(env, 'AWS_SECRET_ACCESS_KEY')
    ),
    backupCredentials,
  };
}

/** Log-safe view: booleans, bucket names and prefixes only. */
export function describeStorageConfig(
  cfg: StorageConfig,
): Record<string, unknown> {
  return {
    driver: cfg.driver,
    region: cfg.region,
    media_bucket: cfg.mediaBucket,
    private_bucket: cfg.privateBucket,
    backup_bucket: cfg.backupBucket,
    media_prefix: cfg.mediaPrefix,
    private_prefix: cfg.privatePrefix,
    backup_prefix: cfg.backupPrefix,
    backup_driver: cfg.backupDriver,
    kms: !!cfg.kmsKeyId,
    delete_mode: cfg.deleteMode,
    backup_object_lock: cfg.backupObjectLock,
    endpoint: !!cfg.endpoint,
    media_local_fallback: cfg.mediaLocalFallback,
    strict_startup: cfg.strictStartup,
    credentials_in_env: cfg.credentialsInEnv,
    backup_credentials_in_env: cfg.backupCredentials !== null,
  };
}
