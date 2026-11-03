/**
 * Thin S3 wrapper for the ops scripts (`storage-migrate.ts`, `storage-verify.ts`).
 *
 * `@aws-sdk/client-s3` and `@aws-sdk/lib-storage` are loaded at runtime with
 * `require` so the scripts type-check and the pure planners unit-test whether
 * or not the SDK is installed yet (the storage-core work adds it to
 * package.json). Only the handful of calls the scripts need are exposed, with
 * local types. Credentials come from the SDK default chain (env / role) and
 * are never read or printed here.
 *
 * Works with a key that only has ListBucket + GetObject + PutObject: a
 * refused HeadBucket falls back to ListObjectsV2 (MaxKeys 1), a refused
 * HeadObject to a list-based existence/size check, no encryption header is
 * sent unless `S3_KMS_KEY_ID` is set, and GetBucketLocation is never called
 * (the client is built with `AWS_REGION` only). Keys passed in are bucket
 * keys: the caller prepends the role prefix (`rolePrefixes`).
 */
import { createHash } from 'crypto';
import type { Readable } from 'stream';
import { normalizeKeyPrefix } from '../../src/modules/storage/object-storage';

export interface S3Env {
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  kmsKeyId?: string;
}

/** Per-role key prefix inside the bucket (`S3_<ROLE>_PREFIX`, defaults `media/`, `private/`, `backups/`). */
export interface RolePrefixes {
  media: string;
  private: string;
  backup: string;
}

export interface HeadResult {
  size: number;
  etag: string | null;
  sha256: string | null;
  contentType: string | null;
  cacheControl: string | null;
  sse: string | null;
  /** True when HeadObject was refused and only the listing (size, etag) is known. */
  sizeOnly?: boolean;
}

export interface PutOptions {
  bucket: string;
  key: string;
  body: Readable;
  size: number;
  contentType: string;
  cacheControl?: string;
  contentDisposition?: string;
  sha256: string;
  sse: 'kms' | 's3';
  kmsKeyId?: string;
}

export interface S3Ops {
  /** HeadBucket, or ListObjectsV2 MaxKeys=1 under `prefix` when HeadBucket is refused. */
  probeBucket(bucket: string, prefix: string): Promise<'head' | 'list'>;
  head(bucket: string, key: string): Promise<HeadResult | null>;
  put(opts: PutOptions): Promise<{ etag: string | null }>;
  /** Streams the object and returns its size + sha256 (bytes are not kept). */
  getDigest(
    bucket: string,
    key: string,
  ): Promise<{ size: number; sha256: string; head: HeadResult } | null>;
}

/** Threshold above which lib-storage multipart Upload is used. */
export const MULTIPART_THRESHOLD = 5 * 1024 * 1024;

export function readS3Env(
  env: Record<string, string | undefined> = process.env,
): S3Env {
  const region = (env.AWS_REGION ?? '').trim();
  if (!region) throw new Error('AWS_REGION is not set');
  const out: S3Env = { region };
  if (env.S3_ENDPOINT?.trim()) out.endpoint = env.S3_ENDPOINT.trim();
  if (/^(1|true|yes)$/i.test(env.S3_FORCE_PATH_STYLE ?? ''))
    out.forcePathStyle = true;
  if (env.S3_KMS_KEY_ID?.trim()) out.kmsKeyId = env.S3_KMS_KEY_ID.trim();
  return out;
}

/** Same rule as the API's `keyPrefixFor`: unset = default, empty = no prefix, normalised to `<x>/`. */
export function rolePrefixes(
  env: Record<string, string | undefined> = process.env,
): RolePrefixes {
  const read = (name: string, fallback: string): string =>
    env[name] === undefined ? fallback : normalizeKeyPrefix(env[name]);
  return {
    media: read('S3_MEDIA_PREFIX', 'media/'),
    private: read('S3_PRIVATE_PREFIX', 'private/'),
    backup: read('S3_BACKUP_PREFIX', 'backups/'),
  };
}

function loadSdk(): { s3: any; lib: any } {
  let s3: any;
  let lib: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    s3 = require('@aws-sdk/client-s3');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    lib = require('@aws-sdk/lib-storage');
  } catch (err) {
    throw new Error(
      `@aws-sdk/client-s3 / @aws-sdk/lib-storage are not installed (${(err as Error).message}). Run npm install first.`,
    );
  }
  return { s3, lib };
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === 'NotFound' ||
    e?.name === 'NoSuchKey' ||
    e?.$metadata?.httpStatusCode === 404
  );
}

function isAccessDenied(err: unknown): boolean {
  const e = err as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e?.name === 'AccessDenied' ||
    e?.Code === 'AccessDenied' ||
    e?.name === 'Forbidden' ||
    e?.$metadata?.httpStatusCode === 403
  );
}

function toHead(out: any): HeadResult {
  return {
    size: Number(out.ContentLength ?? 0),
    etag: out.ETag ? String(out.ETag).replace(/"/g, '') : null,
    sha256: out.Metadata?.sha256 ?? null,
    contentType: out.ContentType ?? null,
    cacheControl: out.CacheControl ?? null,
    sse: out.ServerSideEncryption ?? null,
  };
}

export function createS3(env: S3Env): S3Ops {
  const { s3, lib } = loadSdk();
  const client = new s3.S3Client({
    region: env.region,
    ...(env.endpoint ? { endpoint: env.endpoint } : {}),
    ...(env.forcePathStyle ? { forcePathStyle: true } : {}),
    followRegionRedirects: false,
    maxAttempts: 5,
    requestHandler: { requestTimeout: 120_000, connectionTimeout: 10_000 },
  });
  let headDeniedWarned = false;

  /** Existence + size of an exact key through ListObjectsV2 (ListBucket only). */
  async function listOne(
    bucket: string,
    key: string,
  ): Promise<HeadResult | null> {
    let token: string | undefined;
    do {
      const out = await client.send(
        new s3.ListObjectsV2Command({
          Bucket: bucket,
          Prefix: key,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      const hit = (out.Contents ?? []).find((o: any) => o.Key === key);
      if (hit) {
        return {
          size: Number(hit.Size ?? 0),
          etag: hit.ETag ? String(hit.ETag).replace(/"/g, '') : null,
          sha256: null,
          contentType: null,
          cacheControl: null,
          sse: null,
          sizeOnly: true,
        };
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return null;
  }

  return {
    async probeBucket(bucket, prefix) {
      try {
        await client.send(new s3.HeadBucketCommand({ Bucket: bucket }));
        return 'head';
      } catch (err) {
        if (!isAccessDenied(err)) throw err;
      }
      await client.send(
        new s3.ListObjectsV2Command({
          Bucket: bucket,
          ...(prefix ? { Prefix: prefix } : {}),
          MaxKeys: 1,
        }),
      );
      return 'list';
    },

    async head(bucket, key) {
      try {
        const out = await client.send(
          new s3.HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return toHead(out);
      } catch (err) {
        if (isNotFound(err)) return null;
        if (!isAccessDenied(err)) throw err;
        if (!headDeniedWarned) {
          headDeniedWarned = true;
          console.error(
            '  ! HeadObject refused by the key; falling back to ListObjectsV2 (existence + size only, no sha256 metadata)',
          );
        }
        return listOne(bucket, key);
      }
    },

    async put(o) {
      // No encryption header without a KMS key: the bucket default applies
      // (AES256 is deliberately not sent; a bucket policy may be stricter).
      const sse =
        o.sse === 'kms' && o.kmsKeyId
          ? {
              ServerSideEncryption: 'aws:kms',
              SSEKMSKeyId: o.kmsKeyId,
              BucketKeyEnabled: true,
            }
          : {};
      const params = {
        Bucket: o.bucket,
        Key: o.key,
        Body: o.body,
        ContentType: o.contentType,
        ...(o.cacheControl ? { CacheControl: o.cacheControl } : {}),
        ...(o.contentDisposition
          ? { ContentDisposition: o.contentDisposition }
          : {}),
        Metadata: { sha256: o.sha256 },
        ...sse,
      };
      if (o.size >= MULTIPART_THRESHOLD) {
        const up = new lib.Upload({
          client,
          params,
          queueSize: 4,
          partSize: 8 * 1024 * 1024,
          leavePartsOnError: false,
        });
        const out = await up.done();
        return { etag: out?.ETag ? String(out.ETag).replace(/"/g, '') : null };
      }
      const out = await client.send(
        new s3.PutObjectCommand({ ...params, ContentLength: o.size }),
      );
      return { etag: out?.ETag ? String(out.ETag).replace(/"/g, '') : null };
    },

    async getDigest(bucket, key) {
      let out: any;
      try {
        out = await client.send(
          new s3.GetObjectCommand({ Bucket: bucket, Key: key }),
        );
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
      const hash = createHash('sha256');
      let size = 0;
      const body = out.Body as Readable;
      for await (const chunk of body) {
        hash.update(chunk as Buffer);
        size += (chunk as Buffer).length;
      }
      return { size, sha256: hash.digest('hex'), head: toHead(out) };
    },
  };
}
