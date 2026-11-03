/**
 * In-memory S3 for unit tests (aws-sdk-client-mock): PutObject, HeadObject,
 * GetObject, DeleteObject, ListObjectsV2, HeadBucket and the multipart
 * commands lib-storage's `Upload` sends. Objects keep their headers so the
 * S3 driver can be checked against the same contract as the local one.
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
}

class NotFound extends Error {
  $metadata = { httpStatusCode: 404 };
  constructor(name = 'NotFound') {
    super(name);
    this.name = name;
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
): MockS3 {
  const objects = new Map<string, MockObject>();
  const parts = new Map<string, Map<number, Buffer>>();
  const uploads = new Map<string, PutObjectCommandInput>();
  const calls: string[] = [];
  const client = new S3Client({ region: 'eu-north-1' });
  const stub = mockClient(client) as unknown as AwsStub<
    ServiceInputTypes,
    ServiceOutputTypes,
    unknown
  >;
  const bucketSet = new Set(buckets);
  const k = (b?: string, key?: string) => `${b}/${key}`;

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
      etag,
      lastModified: new Date('2026-11-03T10:00:00.000Z'),
    });
    return etag;
  };

  stub.on(HeadBucketCommand).callsFake((input: { Bucket: string }) => {
    calls.push('HeadBucket');
    if (!bucketSet.has(input.Bucket)) throw new NotFound();
    return {};
  });
  stub.on(PutObjectCommand).callsFake(async (input: PutObjectCommandInput) => {
    calls.push('PutObject');
    const body = await toBuffer(input.Body);
    return { ETag: await store(input, body) };
  });
  stub
    .on(CreateMultipartUploadCommand)
    .callsFake((input: PutObjectCommandInput) => {
      calls.push('CreateMultipartUpload');
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
        calls.push('UploadPart');
        const body = await toBuffer(input.Body);
        parts.get(input.UploadId)!.set(input.PartNumber, body);
        return { ETag: `"part-${input.PartNumber}"` };
      },
    );
  stub
    .on(CompleteMultipartUploadCommand)
    .callsFake(async (input: { UploadId: string }) => {
      calls.push('CompleteMultipartUpload');
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
      calls.push('HeadObject');
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
      };
    });
  stub
    .on(GetObjectCommand)
    .callsFake((input: { Bucket: string; Key: string }) => {
      calls.push('GetObject');
      const o = objects.get(k(input.Bucket, input.Key));
      if (!o) throw new NotFound('NoSuchKey');
      return {
        Body: Readable.from([o.body]) as never,
        ContentLength: o.body.length,
        ContentType: o.contentType,
        ETag: o.etag,
        LastModified: o.lastModified,
        Metadata: o.metadata,
      };
    });
  stub
    .on(DeleteObjectCommand)
    .callsFake((input: { Bucket: string; Key: string }) => {
      calls.push('DeleteObject');
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
        calls.push('ListObjectsV2');
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

  return { client, stub, objects, buckets: bucketSet, calls };
}
