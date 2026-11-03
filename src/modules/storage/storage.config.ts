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
 *   S3_KMS_KEY_ID                  optional; SSE-KMS for private + backup
 *   S3_ENDPOINT / S3_FORCE_PATH_STYLE   optional (minio / tests)
 *   MEDIA_LOCAL_FALLBACK=true|false default true (dual-read in s3 mode)
 *   MEDIA_BASE_URL                 optional; default PUBLIC_API_URL
 *   STORAGE_STRICT_STARTUP=true|false default true (refuse to start when a
 *                                  media/private HeadBucket fails in s3 mode;
 *                                  the backup bucket only warns)
 *   BACKUP_AWS_ACCESS_KEY_ID / BACKUP_AWS_SECRET_ACCESS_KEY
 *                                  optional (+ BACKUP_AWS_SESSION_TOKEN): the
 *                                  `ms-backup-writer` key used for the backup
 *                                  bucket only (INFRA.md §5.2: the API key has
 *                                  no access to that bucket). Unset = the SDK
 *                                  default chain.
 */
import * as path from 'path';
import { defaultPrivateStorageDir } from '../../common/storage/private-file-storage';
import { defaultInvoiceStorageDir } from '../../modules/invoices/storage/invoice-storage';

export type StorageDriver = 'local' | 's3';

export interface StorageConfig {
  driver: StorageDriver;
  region: string | null;
  endpoint: string | null;
  forcePathStyle: boolean | null;
  kmsKeyId: string | null;
  mediaBucket: string | null;
  privateBucket: string | null;
  backupBucket: string | null;
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

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function bucket(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = str(env, name);
  if (v !== null && !BUCKET_RE.test(v)) {
    throw new StorageConfigError(`${name} is not a valid bucket name`);
  }
  return v;
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

/** Log-safe view: booleans and bucket names only. */
export function describeStorageConfig(
  cfg: StorageConfig,
): Record<string, unknown> {
  return {
    driver: cfg.driver,
    region: cfg.region,
    media_bucket: cfg.mediaBucket,
    private_bucket: cfg.privateBucket,
    backup_bucket: cfg.backupBucket,
    backup_driver: cfg.backupDriver,
    kms: !!cfg.kmsKeyId,
    endpoint: !!cfg.endpoint,
    media_local_fallback: cfg.mediaLocalFallback,
    strict_startup: cfg.strictStartup,
    credentials_in_env: cfg.credentialsInEnv,
    backup_credentials_in_env: cfg.backupCredentials !== null,
  };
}
