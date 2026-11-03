/**
 * Object storage contract (S3 project, SPEC.md "Module layout").
 *
 * One interface for the three bucket roles (media, private, backup) with a
 * local-disk and an S3 implementation. Keys are `/`-separated relative paths
 * (`uploads/<folder>/<file>`, `customer-uploads/<yyyy>/<mm>/<id>.<ext>`,
 * `invoices/<store>/<yyyy>/<id>.pdf`, `db/<date>/...`) and keep their meaning
 * across drivers, so the migration script can copy the local tree 1:1.
 */
import type { Readable } from 'stream';

export type BucketRole = 'media' | 'private' | 'backup';

export interface PutObjectOptions {
  contentType: string;
  /** e.g. `public, max-age=31536000, immutable` (media). */
  cacheControl?: string;
  /** e.g. `attachment` for SVG media. */
  contentDisposition?: string;
  /** User metadata (`x-amz-meta-*` on S3). `sha256` is added for buffers. */
  metadata?: Record<string, string>;
  /** Encryption hint; the S3 driver maps it to SSE-KMS / SSE-S3. */
  sse?: 'kms' | 's3';
  /** Byte length of a stream body when known (lets the driver skip buffering). */
  contentLength?: number;
}

export interface PutObjectResult {
  etag: string | null;
  size: number;
}

export interface ObjectHead {
  size: number;
  etag: string | null;
  lastModified: Date | null;
  contentType: string | null;
  metadata: Record<string, string>;
}

export interface ObjectBody extends ObjectHead {
  stream: Readable;
}

export interface ListObjectsOptions {
  maxKeys?: number;
  continuationToken?: string;
}

export interface ListedObject {
  key: string;
  size: number;
  etag: string | null;
  lastModified: Date | null;
}

export interface ListObjectsResult {
  objects: ListedObject[];
  nextContinuationToken?: string;
}

export interface ObjectStorage {
  /** Where the objects live: `local` or `s3`. */
  readonly driver: 'local' | 's3';
  /** Bucket name (s3) or absolute root directory (local). */
  readonly location: string;
  put(
    key: string,
    body: Buffer | Readable,
    opts: PutObjectOptions,
  ): Promise<PutObjectResult>;
  /** The object as a stream with its headers, or null when it does not exist. */
  get(key: string): Promise<ObjectBody | null>;
  head(key: string): Promise<ObjectHead | null>;
  /** True when something was deleted; false when the key did not exist. */
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
  list(prefix: string, opts?: ListObjectsOptions): Promise<ListObjectsResult>;
}

export class InvalidObjectKeyError extends Error {
  constructor(key: unknown) {
    super(`Invalid object key: ${JSON.stringify(key)}`);
    this.name = 'InvalidObjectKeyError';
  }
}

const KEY_SEGMENT = /^[A-Za-z0-9._@-]{1,255}$/;

/**
 * A key is one or more safe segments joined by `/`: no empty, `.` or `..`
 * segments, no leading slash, no backslash, no control characters, at most
 * 1024 bytes (the S3 limit).
 */
export function isValidObjectKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1024) {
    return false;
  }
  const parts = key.split('/');
  return parts.every((p) => KEY_SEGMENT.test(p) && !/^\.+$/.test(p));
}

export function assertValidObjectKey(key: unknown): asserts key is string {
  if (!isValidObjectKey(key)) throw new InvalidObjectKeyError(key);
}

/** A list prefix: empty, or a valid key optionally ending with `/`. */
export function isValidObjectPrefix(prefix: unknown): prefix is string {
  if (typeof prefix !== 'string') return false;
  if (prefix === '') return true;
  const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return isValidObjectKey(trimmed);
}
