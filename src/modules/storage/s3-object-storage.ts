/**
 * S3 `ObjectStorage` (AWS SDK v3). One instance per bucket role.
 *
 * - keys: every operation prepends the role's `keyPrefix` (`media/`,
 *   `private/`, `backups/` by default), so three roles can share one bucket
 *   while the keys stored in the DB stay role-relative; `list` answers
 *   role-relative keys (prefix stripped).
 * - put: buffers go through `PutObject` (ChecksumAlgorithm SHA256, user
 *   metadata `sha256`); streams and large bodies go through lib-storage's
 *   `Upload` (multipart, 8 MB parts). Content-Type, Cache-Control,
 *   Content-Disposition and the metadata are object headers, so a later CDN
 *   origin serves them without the API.
 * - encryption: with `S3_KMS_KEY_ID`, private/backup roles (or an explicit
 *   `sse: 'kms'`) send SSE-KMS with that key; without it NO encryption
 *   header is sent and the bucket default applies.
 * - delete: `STORAGE_DELETE_MODE=try` issues DeleteObject and turns a
 *   refused permission (403/AccessDenied) into `{ deleted: false, reason:
 *   'denied' }` with one warning per process and bucket/prefix; `skip`
 *   never calls DeleteObject.
 * - probe: HeadBucket, and when that is refused (403) a `ListObjectsV2
 *   MaxKeys=1` on the role prefix; never GetBucketLocation. The client is
 *   built with the configured region only.
 * - get streams the body (never buffered); a missing key answers null.
 * - the client retries 3 times and times out a request after 30 s.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PassThrough, Readable } from 'stream';
import {
  assertValidObjectKey,
  InvalidObjectKeyError,
  isValidObjectPrefix,
  normalizeKeyPrefix,
  type BucketRole,
  type DeleteObjectResult,
  type ListObjectsOptions,
  type ListObjectsResult,
  type ObjectBody,
  type ObjectHead,
  type ObjectStorage,
  type PutObjectOptions,
  type PutObjectResult,
} from './object-storage';

export const S3_REQUEST_TIMEOUT_MS = 30_000;
export const S3_CONNECTION_TIMEOUT_MS = 5_000;
export const S3_MAX_ATTEMPTS = 3;
/** Buffers at or above this size are uploaded multipart. */
export const S3_MULTIPART_THRESHOLD = 5 * 1024 * 1024;
const PART_SIZE = 8 * 1024 * 1024;

export type StorageDeleteMode = 'try' | 'skip';
/** Which reachability probe answered (health output). */
export type BucketProbe = 'head' | 'list';

export interface S3ClientOptions {
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  /** Explicit credentials (backup writer key); unset = SDK default chain. */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /** Socket inactivity timeout (default 30 s; backups use a longer one). */
  requestTimeoutMs?: number;
}

/**
 * One shared client per credential set (media + private share the API key;
 * the backup bucket may use its own). Credentials come from the SDK default
 * chain unless given explicitly; they are never logged. Only the configured
 * region is used (no GetBucketLocation, no region redirects).
 */
export function createS3Client(opts: S3ClientOptions): S3Client {
  const config: S3ClientConfig = {
    region: opts.region,
    maxAttempts: S3_MAX_ATTEMPTS,
    followRegionRedirects: false,
    requestHandler: {
      requestTimeout: opts.requestTimeoutMs ?? S3_REQUEST_TIMEOUT_MS,
      connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
    },
  };
  if (opts.endpoint) config.endpoint = opts.endpoint;
  if (opts.forcePathStyle !== undefined) {
    config.forcePathStyle = opts.forcePathStyle;
  }
  if (opts.credentials) config.credentials = { ...opts.credentials };
  return new S3Client(config);
}

export interface S3ObjectStorageOptions {
  client: S3Client;
  bucket: string;
  role: BucketRole;
  /** Key prefix of the role inside the bucket (`media/`; '' = none). */
  keyPrefix?: string;
  /** KMS key for SSE-KMS on private/backup writes (unset = bucket default). */
  kmsKeyId?: string;
  /** `try` (default) or `skip` (never call DeleteObject). */
  deleteMode?: StorageDeleteMode;
}

export function isNotFound(e: unknown): boolean {
  const err = e as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
    Code?: string;
  };
  return (
    err?.name === 'NoSuchKey' ||
    err?.name === 'NotFound' ||
    err?.Code === 'NoSuchKey' ||
    err?.$metadata?.httpStatusCode === 404
  );
}

/** 403 / AccessDenied (the IAM key lacks the action). */
export function isAccessDenied(e: unknown): boolean {
  const err = e as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    err?.name === 'AccessDenied' ||
    err?.Code === 'AccessDenied' ||
    err?.name === 'Forbidden' ||
    err?.$metadata?.httpStatusCode === 403
  );
}

/** Bucket/prefix pairs whose refused delete was already logged (one line per process). */
const deniedDeleteWarned = new Set<string>();

/** Test hook: forget which bucket/prefix pairs were already warned about. */
export function resetDeniedDeleteWarnings(): void {
  deniedDeleteWarned.clear();
}

export class S3ObjectStorage implements ObjectStorage {
  readonly driver = 's3' as const;
  readonly bucket: string;
  readonly role: BucketRole;
  readonly keyPrefix: string;
  readonly deleteMode: StorageDeleteMode;
  private readonly client: S3Client;
  private readonly kmsKeyId?: string;
  private readonly logger = new Logger(S3ObjectStorage.name);

  constructor(opts: S3ObjectStorageOptions) {
    this.client = opts.client;
    this.bucket = opts.bucket;
    this.role = opts.role;
    this.keyPrefix = normalizeKeyPrefix(opts.keyPrefix);
    this.kmsKeyId = opts.kmsKeyId?.trim() || undefined;
    this.deleteMode = opts.deleteMode ?? 'try';
  }

  /** `<bucket>/<prefix>` (log lines, health). */
  get location(): string {
    return this.keyPrefix ? `${this.bucket}/${this.keyPrefix}` : this.bucket;
  }

  /** The bucket key of a role-relative key (validated). */
  objectKey(key: string): string {
    assertValidObjectKey(key);
    return `${this.keyPrefix}${key}`;
  }

  /**
   * The encryption headers for a write: SSE-KMS when a key is configured
   * and the role (private/backup) or the caller (`sse: 'kms'`) asks for it;
   * otherwise nothing (the bucket's default encryption applies — AES256 is
   * deliberately not sent, a bucket policy may require another algorithm).
   */
  encryptionFor(
    sse?: 'kms' | 's3',
  ): Pick<PutObjectCommandInput, 'ServerSideEncryption' | 'SSEKMSKeyId'> {
    const wantsKms =
      sse === 'kms' ||
      (sse === undefined &&
        (this.role === 'private' || this.role === 'backup'));
    if (wantsKms && this.kmsKeyId) {
      return { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.kmsKeyId };
    }
    return {};
  }

  /** `HeadBucket`: true when the bucket answers. Throws on 403 too. */
  async headBucket(): Promise<boolean> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    return true;
  }

  /**
   * Reachability probe (startup + health): HeadBucket first; when the key
   * may not call it (403/AccessDenied) a `ListObjectsV2 MaxKeys=1` on the
   * role prefix (ListBucket is the minimum the key has). Anything else
   * (network, 404, a refused list) throws.
   */
  async probe(): Promise<BucketProbe> {
    try {
      await this.headBucket();
      return 'head';
    } catch (e) {
      if (!isAccessDenied(e)) throw e;
    }
    await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.keyPrefix || undefined,
        MaxKeys: 1,
      }),
    );
    return 'list';
  }

  private baseInput(
    key: string,
    opts: PutObjectOptions,
  ): PutObjectCommandInput {
    const input: PutObjectCommandInput = {
      Bucket: this.bucket,
      Key: this.objectKey(key),
      ContentType: opts.contentType,
      ...this.encryptionFor(opts.sse),
    };
    if (opts.cacheControl) input.CacheControl = opts.cacheControl;
    if (opts.contentDisposition) {
      input.ContentDisposition = opts.contentDisposition;
    }
    if (opts.metadata && Object.keys(opts.metadata).length > 0) {
      input.Metadata = { ...opts.metadata };
    }
    return input;
  }

  async put(
    key: string,
    body: Buffer | Readable,
    opts: PutObjectOptions,
  ): Promise<PutObjectResult> {
    const input = this.baseInput(key, opts);

    if (Buffer.isBuffer(body)) {
      const sha256 = createHash('sha256').update(body).digest('hex');
      input.Metadata = { ...(input.Metadata ?? {}), sha256 };
      if (body.length < S3_MULTIPART_THRESHOLD) {
        input.Body = body;
        input.ContentLength = body.length;
        input.ChecksumAlgorithm = 'SHA256';
        const out = await this.client.send(new PutObjectCommand(input));
        return { etag: out.ETag ?? null, size: body.length };
      }
      const upload = new Upload({
        client: this.client,
        params: { ...input, Body: body },
        partSize: PART_SIZE,
        queueSize: 4,
        leavePartsOnError: false,
      });
      const out = await upload.done();
      return { etag: out.ETag ?? null, size: body.length };
    }

    // Stream: multipart upload; the byte count is taken on the way through.
    let size = 0;
    const counter = new PassThrough();
    counter.on('data', (chunk: Buffer) => {
      size += chunk.length;
    });
    const upload = new Upload({
      client: this.client,
      params: { ...input, Body: body.pipe(counter) },
      partSize: PART_SIZE,
      queueSize: 4,
      leavePartsOnError: false,
    });
    body.on('error', (err) => counter.destroy(err));
    const out = await upload.done();
    return { etag: out.ETag ?? null, size };
  }

  async head(key: string): Promise<ObjectHead | null> {
    const Key = this.objectKey(key);
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key }),
      );
      return {
        size: out.ContentLength ?? 0,
        etag: out.ETag ?? null,
        lastModified: out.LastModified ?? null,
        contentType: out.ContentType ?? null,
        metadata: out.Metadata ?? {},
      };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async get(key: string): Promise<ObjectBody | null> {
    const Key = this.objectKey(key);
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key }),
      );
      const body = out.Body;
      if (!body) return null;
      const stream =
        body instanceof Readable
          ? body
          : typeof (body as { transformToWebStream?: unknown })
                .transformToWebStream === 'function'
            ? Readable.fromWeb(
                (
                  body as {
                    transformToWebStream: () => import('stream/web').ReadableStream;
                  }
                ).transformToWebStream(),
              )
            : Readable.from(body as AsyncIterable<Uint8Array>);
      return {
        stream,
        size: out.ContentLength ?? 0,
        etag: out.ETag ?? null,
        lastModified: out.LastModified ?? null,
        contentType: out.ContentType ?? null,
        metadata: out.Metadata ?? {},
      };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  /**
   * `skip` mode answers `skipped` without any request. `try` mode checks
   * the object first (S3 deletes are idempotent; the "missing" answer
   * keeps the local driver's contract), then issues DeleteObject; a
   * refused permission is `denied`, warned once per bucket/prefix.
   */
  async delete(key: string): Promise<DeleteObjectResult> {
    const Key = this.objectKey(key);
    if (this.deleteMode === 'skip') {
      return { deleted: false, reason: 'skipped' };
    }
    const existed = (await this.head(key)) !== null;
    if (!existed) return { deleted: false, reason: 'missing' };
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key }),
      );
      return { deleted: true };
    } catch (e) {
      if (!isAccessDenied(e)) throw e;
      this.warnDeniedDelete(e);
      return { deleted: false, reason: 'denied' };
    }
  }

  private warnDeniedDelete(e: unknown): void {
    const scope = `${this.bucket}/${this.keyPrefix}`;
    if (deniedDeleteWarned.has(scope)) return;
    deniedDeleteWarned.add(scope);
    this.logger.warn(
      `storage: DeleteObject refused on s3://${scope} (${
        e instanceof Error ? e.name : 'AccessDenied'
      }); the ${this.role} role keeps objects until the bucket lifecycle removes them (set STORAGE_DELETE_MODE=skip to stop trying). This is logged once.`,
    );
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  /** Lists under the role prefix; keys come back role-relative. */
  async list(
    prefix: string,
    opts: ListObjectsOptions = {},
  ): Promise<ListObjectsResult> {
    if (!isValidObjectPrefix(prefix)) throw new InvalidObjectKeyError(prefix);
    const full = `${this.keyPrefix}${prefix}`;
    const out = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: full || undefined,
        MaxKeys: opts.maxKeys && opts.maxKeys > 0 ? opts.maxKeys : undefined,
        ContinuationToken: opts.continuationToken,
      }),
    );
    const cut = this.keyPrefix.length;
    return {
      objects: (out.Contents ?? [])
        .filter(
          (c) =>
            typeof c.Key === 'string' &&
            c.Key.startsWith(this.keyPrefix) &&
            c.Key.length > cut,
        )
        .map((c) => ({
          key: c.Key!.slice(cut),
          size: c.Size ?? 0,
          etag: c.ETag ?? null,
          lastModified: c.LastModified ?? null,
        })),
      nextContinuationToken: out.IsTruncated
        ? out.NextContinuationToken
        : undefined,
    };
  }
}
