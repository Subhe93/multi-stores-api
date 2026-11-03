import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type PutObjectCommandInput,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { Readable } from 'stream';
import { createS3Client } from '../../storage/s3-object-storage';
import {
  parseStorageConfig,
  StorageConfigError,
  type BackupCredentials,
} from '../../storage/storage.config';
import {
  BackupObjectSink,
  BackupSinkGet,
  BackupSinkHead,
  BackupSinkObject,
  BackupSinkPutOptions,
  BackupSinkPutResult,
  SHA256_METADATA_KEY,
  TIER_TAG_KEY,
} from './backup-object-sink';

/**
 * Configuration of the S3 sink. It is derived from the storage core's
 * `parseStorageConfig` so the backups module reads `S3_BACKUP_BUCKET`,
 * `AWS_REGION`, `S3_KMS_KEY_ID`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` and
 * the optional `BACKUP_AWS_*` writer credentials exactly like the storage
 * module (same validation, same defaults).
 */
export interface S3BackupSinkConfig {
  bucket: string;
  region?: string;
  kmsKeyId?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  /** `ms-backup-writer` key (INFRA.md §5.2); unset = SDK default chain. */
  credentials?: BackupCredentials;
}

/**
 * Socket inactivity timeout of the backup client: a multi-GB single
 * PutObject may idle while S3 finalises the object, so it is longer than
 * the storage default.
 */
export const BACKUP_S3_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export function s3BackupSinkConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): S3BackupSinkConfig | null {
  let cfg: ReturnType<typeof parseStorageConfig>;
  try {
    cfg = parseStorageConfig(env);
  } catch (err) {
    // No backup bucket: the sink is off whatever else is wrong with the
    // storage env (the storage module reports that at boot).
    if (err instanceof StorageConfigError && !env.S3_BACKUP_BUCKET?.trim()) {
      return null;
    }
    throw err;
  }
  if (!cfg.backupBucket) return null;
  return {
    bucket: cfg.backupBucket,
    region: cfg.region ?? undefined,
    kmsKeyId: cfg.kmsKeyId ?? undefined,
    endpoint: cfg.endpoint ?? undefined,
    forcePathStyle: cfg.forcePathStyle ?? undefined,
    ...(cfg.backupCredentials ? { credentials: cfg.backupCredentials } : {}),
  };
}

/**
 * Backup sink on the backup bucket. Upload path (writer policy only):
 * `PutObject` with `ChecksumSHA256` (S3 rejects a body that does not hash
 * to it), `x-amz-meta-sha256`, `Tagging: tier=<tier>` and, for weekly /
 * monthly objects, a per-object GOVERNANCE lock; then one `ListObjectsV2`
 * on the exact key to confirm the stored size. `head`/`get` (restore and
 * download) need `s3:GetObject`, i.e. the restore policy or a writer key
 * extended with it; without it they fail with a clear error.
 */
export class S3BackupObjectSink implements BackupObjectSink {
  readonly enabled = true;
  readonly target: string;
  private client: S3Client | null;

  constructor(
    private readonly config: S3BackupSinkConfig,
    client?: S3Client,
  ) {
    this.target = `s3://${config.bucket}`;
    this.client = client ?? null;
  }

  /** Lazy: no client (and no credential resolution) until the first call. */
  private s3(): S3Client {
    if (!this.client) {
      this.client = createS3Client({
        // The SDK resolves the region from its own chain when unset.
        region: this.config.region ?? '',
        endpoint: this.config.endpoint,
        forcePathStyle: this.config.forcePathStyle,
        credentials: this.config.credentials,
        requestTimeoutMs: BACKUP_S3_REQUEST_TIMEOUT_MS,
      });
    }
    return this.client;
  }

  private encryption(
    sse: BackupSinkPutOptions['sse'],
  ): Pick<PutObjectCommandInput, 'ServerSideEncryption' | 'SSEKMSKeyId'> {
    const wantKms =
      sse === 'kms' || (sse === undefined && !!this.config.kmsKeyId);
    if (wantKms && this.config.kmsKeyId) {
      return {
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: this.config.kmsKeyId,
      };
    }
    return { ServerSideEncryption: 'AES256' };
  }

  async put(
    key: string,
    body: Readable | Buffer,
    options: BackupSinkPutOptions,
  ): Promise<BackupSinkPutResult> {
    const size = Buffer.isBuffer(body) ? body.length : options.contentLength;
    if (size === undefined) {
      throw new Error(
        'BACKUP_OFFSITE_LENGTH: contentLength is required for streams',
      );
    }
    const metadata: Record<string, string> = { ...(options.metadata ?? {}) };
    if (options.sha256) metadata[SHA256_METADATA_KEY] = options.sha256;
    const input: PutObjectCommandInput = {
      Bucket: this.config.bucket,
      Key: key,
      Body: body,
      ContentLength: size,
      ContentType: options.contentType,
      Metadata: metadata,
      ...this.encryption(options.sse),
    };
    if (options.sha256) {
      // End-to-end integrity: S3 rejects the upload when the body does not
      // hash to this value (precomputed, so streams need no trailer).
      input.ChecksumSHA256 = Buffer.from(options.sha256, 'hex').toString(
        'base64',
      );
    }
    if (options.tier) {
      input.Tagging = `${TIER_TAG_KEY}=${options.tier}`;
    }
    if (options.retainUntil) {
      input.ObjectLockMode = 'GOVERNANCE';
      input.ObjectLockRetainUntilDate = options.retainUntil;
    }
    const out = await this.s3().send(new PutObjectCommand(input));
    return { etag: stripQuotes(out.ETag), size };
  }

  /** `ListObjectsV2` with the key as prefix (needs `s3:ListBucket` only). */
  async sizeOf(key: string): Promise<number | null> {
    let token: string | undefined;
    do {
      const out = await this.s3().send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: key,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      const hit = (out.Contents ?? []).find((o) => o.Key === key);
      if (hit) return Number(hit.Size ?? 0);
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return null;
  }

  async head(key: string): Promise<BackupSinkHead | null> {
    try {
      const out = await this.s3().send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return {
        size: Number(out.ContentLength ?? 0),
        etag: stripQuotes(out.ETag),
        lastModified:
          out.LastModified instanceof Date ? out.LastModified : null,
        metadata: lowerKeys(out.Metadata),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw restoreAccessError(err, 'HeadObject');
    }
  }

  async list(prefix: string): Promise<BackupSinkObject[]> {
    const items: BackupSinkObject[] = [];
    let token: string | undefined;
    do {
      const out = await this.s3().send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const o of out.Contents ?? []) {
        if (!o.Key) continue;
        items.push({
          key: String(o.Key),
          size: Number(o.Size ?? 0),
          lastModified: o.LastModified instanceof Date ? o.LastModified : null,
        });
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return items;
  }

  async get(key: string): Promise<BackupSinkGet | null> {
    try {
      const out = await this.s3().send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      if (!out.Body) return null;
      return {
        stream: out.Body as Readable,
        size: Number(out.ContentLength ?? 0),
        metadata: lowerKeys(out.Metadata),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw restoreAccessError(err, 'GetObject');
    }
  }
}

function stripQuotes(etag: unknown): string | null {
  if (typeof etag !== 'string' || !etag) return null;
  return etag.replace(/^"|"$/g, '');
}

function lowerKeys(meta: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (meta && typeof meta === 'object') {
    for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
      if (typeof v === 'string') out[k.toLowerCase()] = v;
    }
  }
  return out;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === 'NotFound' ||
    e?.name === 'NoSuchKey' ||
    e?.$metadata?.httpStatusCode === 404
  );
}

/**
 * The writer key cannot read objects back (by design). A 403 on a read is
 * reported as such so the operator knows to use the restore credentials.
 */
function restoreAccessError(err: unknown, op: string): unknown {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (e?.name === 'AccessDenied' || e?.$metadata?.httpStatusCode === 403) {
    return new Error(
      `BACKUP_OFFSITE_READ_DENIED: ${op} refused — the configured key is write-only (ms-backup-writer); restoring from S3 needs the ms-backup-restore policy (scripts/ops/README.md)`,
    );
  }
  return err;
}
