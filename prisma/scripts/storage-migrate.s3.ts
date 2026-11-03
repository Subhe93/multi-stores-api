/**
 * Thin S3 wrapper for the ops scripts (`storage-migrate.ts`, `storage-verify.ts`).
 *
 * `@aws-sdk/client-s3` and `@aws-sdk/lib-storage` are loaded at runtime with
 * `require` so the scripts type-check and the pure planners unit-test whether
 * or not the SDK is installed yet (the storage-core work adds it to
 * package.json). Only the handful of calls the scripts need are exposed, with
 * local types. Credentials come from the SDK default chain (env / role) and
 * are never read or printed here.
 */
import { createHash } from 'crypto';
import type { Readable } from 'stream';

export interface S3Env {
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  kmsKeyId?: string;
}

export interface HeadResult {
  size: number;
  etag: string | null;
  sha256: string | null;
  contentType: string | null;
  cacheControl: string | null;
  sse: string | null;
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
  headBucket(bucket: string): Promise<void>;
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
    maxAttempts: 5,
    requestHandler: { requestTimeout: 120_000, connectionTimeout: 10_000 },
  });

  return {
    async headBucket(bucket) {
      await client.send(new s3.HeadBucketCommand({ Bucket: bucket }));
    },

    async head(bucket, key) {
      try {
        const out = await client.send(
          new s3.HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return toHead(out);
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async put(o) {
      const sse =
        o.sse === 'kms' && o.kmsKeyId
          ? {
              ServerSideEncryption: 'aws:kms',
              SSEKMSKeyId: o.kmsKeyId,
              BucketKeyEnabled: true,
            }
          : { ServerSideEncryption: 'AES256' };
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
