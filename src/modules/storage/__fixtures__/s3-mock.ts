/**
 * In-memory S3 for unit tests (aws-sdk-client-mock): PutObject, HeadObject,
 * GetObject, DeleteObject, ListObjectsV2, HeadBucket and the multipart
 * commands lib-storage's `Upload` sends. Objects keep their headers so the
 * S3 driver can be checked against the same contract as the local one.
 *
 * `deny` holds command names the mocked IAM key may not call: they answer
 * 403 AccessDenied (e.g. `DeleteObject`, `HeadBucket` for the production
 * key that only has ListBucket + GetObject + PutObject). Every command
 * without a handler (GetBucketLocation, PutObjectTagging, …) is recorded in
 * `calls` and refused the same way, so a test can assert it was never sent.
 */
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { mockClient, type AwsStub } from 'aws-sdk-client-mock';
import type { ServiceInputTypes, ServiceOutputTypes } from '@aws-sdk/client-s3';

export interface MockObject {
  body: Buffer;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata: Record<string, string>;
  sse?: string;
  kmsKeyId?: string;
  tagging?: string;
  objectLockMode?: string;
  objectLockRetainUntilDate?: Date;
  etag: string;
  lastModified: Date;
}

export interface MockS3 {
  client: S3Client;
  stub: AwsStub<ServiceInputTypes, ServiceOutputTypes, unknown>;
  objects: Map<string, MockObject>;
  /** Buckets that answer HeadBucket; others throw NotFound. */
  buckets: Set<string>;
  /** Command names in the order they were sent. */
  calls: string[];
  /** Command names the key may not call (403 AccessDenied). */
  deny: Set<string>;
}

class NotFound extends Error {
  $metadata = { httpStatusCode: 404 };
  constructor(name = 'NotFound') {
    super(name);
    this.name = name;
  }
}

class InvalidRange extends Error {
  $metadata = { httpStatusCode: 416 };
  Code = 'InvalidRange';
  constructor() {
    super('The requested range is not satisfiable');
    this.name = 'InvalidRange';
  }
}

export class AccessDenied extends Error {
  $metadata = { httpStatusCode: 403 };
  Code = 'AccessDenied';
  constructor(command: string) {
    super(`Access Denied (${command})`);
    this.name = 'AccessDenied';
  }
}

async function toBuffer(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function mockS3(
  buckets: string[] = ['media', 'private', 'backup'],
  denied: string[] = [],
): MockS3 {
  const objects = new Map<string, MockObject>();
  const parts = new Map<string, Map<number, Buffer>>();
  const uploads = new Map<string, PutObjectCommandInput>();
  const calls: string[] = [];
  const deny = new Set(denied);
  const client = new S3Client({ region: 'eu-north-1' });
  const stub = mockClient(client) as unknown as AwsStub<
    ServiceInputTypes,
    ServiceOutputTypes,
    unknown
  >;
  const bucketSet = new Set(buckets);
  const k = (b?: string, key?: string) => `${b}/${key}`;
  const guard = (name: string) => {
    calls.push(name);
    if (deny.has(name)) throw new AccessDenied(name);
  };

  const store = async (input: PutObjectCommandInput, body: Buffer) => {
    const etag = `"${createHash('md5').update(body).digest('hex')}"`;
    objects.set(k(input.Bucket, input.Key), {
      body,
      contentType: input.ContentType,
      cacheControl: input.CacheControl,
      contentDisposition: input.ContentDisposition,
      metadata: { ...(input.Metadata ?? {}) },
      sse: input.ServerSideEncryption,
      kmsKeyId: input.SSEKMSKeyId,
      tagging: input.Tagging,
      objectLockMode: input.ObjectLockMode,
      objectLockRetainUntilDate: input.ObjectLockRetainUntilDate,
      etag,
      lastModified: new Date('2026-11-03T10:00:00.000Z'),
    });
    return etag;
  };

  // Anything without a handler below is a command the production key does
  // not have (GetBucketLocation, PutObjectTagging, PutObjectRetention, …).
  stub.onAnyCommand().callsFake((input: unknown, getClient: unknown) => {
    void input;
    void getClient;
    throw new AccessDenied('unhandled');
  });
  stub.on(HeadBucketCommand).callsFake((input: { Bucket: string }) => {
    guard('HeadBucket');
    if (!bucketSet.has(input.Bucket)) throw new NotFound();
    return {};
  });
  stub.on(PutObjectCommand).callsFake(async (input: PutObjectCommandInput) => {
    guard('PutObject');
    const body = await toBuffer(input.Body);
    return { ETag: await store(input, body) };
  });
  stub
    .on(CreateMultipartUploadCommand)
    .callsFake((input: PutObjectCommandInput) => {
      guard('CreateMultipartUpload');
      const id = `mpu-${uploads.size + 1}`;
      uploads.set(id, input);
      parts.set(id, new Map());
      return { UploadId: id };
    });
  stub
    .on(UploadPartCommand)
    .callsFake(
      async (input: {
        UploadId: string;
        PartNumber: number;
        Body: unknown;
      }) => {
        guard('UploadPart');
        const body = await toBuffer(input.Body);
        parts.get(input.UploadId)!.set(input.PartNumber, body);
        return { ETag: `"part-${input.PartNumber}"` };
      },
    );
  stub
    .on(CompleteMultipartUploadCommand)
    .callsFake(async (input: { UploadId: string }) => {
      guard('CompleteMultipartUpload');
      const init = uploads.get(input.UploadId)!;
      const ordered = [...parts.get(input.UploadId)!.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, b]) => b);
      const etag = await store(init, Buffer.concat(ordered));
      return { ETag: etag, Key: init.Key, Bucket: init.Bucket };
    });
  stub
    .on(HeadObjectCommand)
    .callsFake((input: { Bucket: string; Key: string }) => {
      guard('HeadObject');
      const o = objects.get(k(input.Bucket, input.Key));
      if (!o) throw new NotFound();
      return {
        ContentLength: o.body.length,
        ContentType: o.contentType,
        ETag: o.etag,
        LastModified: o.lastModified,
        Metadata: o.metadata,
        CacheControl: o.cacheControl,
        ContentDisposition: o.contentDisposition,
        ServerSideEncryption: o.sse,
      };
    });
  stub
    .on(GetObjectCommand)
    .callsFake((input: { Bucket: string; Key: string; Range?: string }) => {
      guard('GetObject');
      const o = objects.get(k(input.Bucket, input.Key));
      if (!o) throw new NotFound('NoSuchKey');
      if (input.Range) {
        // Single-range semantics of real S3: end clamped, suffix longer
        // than the object = whole object, start past the end = 416.
        const m = /^bytes=(\d*)-(\d*)$/.exec(input.Range);
        const size = o.body.length;
        if (m && (m[1] !== '' || m[2] !== '')) {
          let start: number;
          let end: number;
          if (m[1] === '') {
            start = Math.max(0, size - Number(m[2]));
            end = size - 1;
          } else {
            start = Number(m[1]);
            end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
          }
          if (start >= size || end < start) throw new InvalidRange();
          const slice = o.body.subarray(start, end + 1);
          return {
            Body: Readable.from([slice]) as never,
            ContentLength: slice.length,
            ContentRange: `bytes ${start}-${end}/${size}`,
            ContentType: o.contentType,
            ETag: o.etag,
            LastModified: o.lastModified,
            Metadata: o.metadata,
            ServerSideEncryption: o.sse,
          };
        }
      }
      return {
        Body: Readable.from([o.body]) as never,
        ContentLength: o.body.length,
        ContentType: o.contentType,
        ETag: o.etag,
        LastModified: o.lastModified,
        Metadata: o.metadata,
        ServerSideEncryption: o.sse,
      };
    });
  stub
    .on(DeleteObjectCommand)
    .callsFake((input: { Bucket: string; Key: string }) => {
      guard('DeleteObject');
      objects.delete(k(input.Bucket, input.Key));
      return {};
    });
  stub
    .on(ListObjectsV2Command)
    .callsFake(
      (input: {
        Bucket: string;
        Prefix?: string;
        MaxKeys?: number;
        ContinuationToken?: string;
      }) => {
        guard('ListObjectsV2');
        if (!bucketSet.has(input.Bucket)) throw new NotFound('NoSuchBucket');
        const prefix = `${input.Bucket}/${input.Prefix ?? ''}`;
        const all = [...objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, o]) => ({
            Key: key.slice(input.Bucket.length + 1),
            Size: o.body.length,
            ETag: o.etag,
            LastModified: o.lastModified,
          }))
          .sort((a, b) => (a.Key < b.Key ? -1 : 1));
        const start = input.ContinuationToken
          ? Number(input.ContinuationToken)
          : 0;
        const max = input.MaxKeys ?? 1000;
        const page = all.slice(start, start + max);
        const truncated = start + max < all.length;
        return {
          Contents: page,
          IsTruncated: truncated,
          NextContinuationToken: truncated ? String(start + max) : undefined,
        };
      },
    );

  return { client, stub, objects, buckets: bucketSet, calls, deny };
}
