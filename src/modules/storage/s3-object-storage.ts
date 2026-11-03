/**
 * S3 `ObjectStorage` (AWS SDK v3). One instance per bucket role.
 *
 * - put: buffers go through `PutObject` (ChecksumAlgorithm SHA256, user
 *   metadata `sha256`); streams and large bodies go through lib-storage's
 *   `Upload` (multipart, 8 MB parts). Content-Type, Cache-Control,
 *   Content-Disposition and the metadata are object headers, so a later CDN
 *   origin serves them without the API.
 * - encryption: private/backup roles use SSE-KMS with `S3_KMS_KEY_ID` when the
 *   key is set, else SSE-S3 (AES256); media uses SSE-S3.
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
  type ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createHash } from 'crypto';
import { PassThrough, Readable } from 'stream';
import {
  assertValidObjectKey,
  InvalidObjectKeyError,
  isValidObjectPrefix,
  type BucketRole,
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
 * chain unless given explicitly; they are never logged.
 */
export function createS3Client(opts: S3ClientOptions): S3Client {
  const config: S3ClientConfig = {
    region: opts.region,
    maxAttempts: S3_MAX_ATTEMPTS,
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
  /** KMS key for SSE-KMS on private/backup writes (unset = SSE-S3). */
  kmsKeyId?: string;
}

function isNotFound(e: unknown): boolean {
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

export class S3ObjectStorage implements ObjectStorage {
  readonly driver = 's3' as const;
  readonly bucket: string;
  readonly role: BucketRole;
  private readonly client: S3Client;
  private readonly kmsKeyId?: string;

  constructor(opts: S3ObjectStorageOptions) {
    this.client = opts.client;
    this.bucket = opts.bucket;
    this.role = opts.role;
    this.kmsKeyId = opts.kmsKeyId?.trim() || undefined;
  }

  get location(): string {
    return this.bucket;
  }

  /** The encryption headers for a write (role + key decide, SPEC "SSE"). */
  encryptionFor(sse?: 'kms' | 's3'): {
    ServerSideEncryption: ServerSideEncryption;
    SSEKMSKeyId?: string;
  } {
    const wantsKms =
      sse === 'kms' ||
      (sse === undefined &&
        (this.role === 'private' || this.role === 'backup'));
    if (wantsKms && this.kmsKeyId) {
      return { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.kmsKeyId };
    }
    return { ServerSideEncryption: 'AES256' };
  }

  /** `HeadBucket`: true when the bucket answers (health + startup check). */
  async headBucket(): Promise<boolean> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    return true;
  }

  private baseInput(
    key: string,
    opts: PutObjectOptions,
  ): PutObjectCommandInput {
    const input: PutObjectCommandInput = {
      Bucket: this.bucket,
      Key: key,
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
    assertValidObjectKey(key);
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
    assertValidObjectKey(key);
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
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
    assertValidObjectKey(key);
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
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

  async delete(key: string): Promise<boolean> {
    assertValidObjectKey(key);
    // S3 deletes are idempotent (204 either way); a HeadObject first keeps
    // the "false when it did not exist" contract of the local driver.
    const existed = (await this.head(key)) !== null;
    if (!existed) return false;
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return true;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  async list(
    prefix: string,
    opts: ListObjectsOptions = {},
  ): Promise<ListObjectsResult> {
    if (!isValidObjectPrefix(prefix)) throw new InvalidObjectKeyError(prefix);
    const out = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix || undefined,
        MaxKeys: opts.maxKeys && opts.maxKeys > 0 ? opts.maxKeys : undefined,
        ContinuationToken: opts.continuationToken,
      }),
    );
    return {
      objects: (out.Contents ?? [])
        .filter((c) => typeof c.Key === 'string')
        .map((c) => ({
          key: c.Key!,
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
