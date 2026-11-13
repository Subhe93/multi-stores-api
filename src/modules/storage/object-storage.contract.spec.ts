import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { LocalObjectStorage } from './local-object-storage';
import {
  InvalidObjectKeyError,
  RangeNotSatisfiableError,
  type ByteRangeSpec,
  type ObjectStorage,
} from './object-storage';
import {
  resetDeniedDeleteWarnings,
  S3ObjectStorage,
  S3_MULTIPART_THRESHOLD,
} from './s3-object-storage';
import { Logger } from '@nestjs/common';
import { collect } from './s3-private-storage';
import { mockS3, type MockS3 } from './__fixtures__/s3-mock';
import { ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';

/**
 * The same contract against both drivers: put/get/head/exists/delete/list,
 * key validation and streaming bodies.
 */
function contract(
  name: string,
  make: () => Promise<{ storage: ObjectStorage; cleanup: () => Promise<void> }>,
) {
  describe(`ObjectStorage contract: ${name}`, () => {
    let storage: ObjectStorage;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      ({ storage, cleanup } = await make());
    });
    afterEach(() => cleanup());

    it('put + head + get + exists round-trip with headers', async () => {
      const body = Buffer.from('hello world');
      const res = await storage.put('uploads/products/a.webp', body, {
        contentType: 'image/webp',
        cacheControl: 'public, max-age=31536000, immutable',
      });
      expect(res.size).toBe(body.length);
      expect(res.etag).toBeTruthy();

      const head = await storage.head('uploads/products/a.webp');
      expect(head).toMatchObject({
        size: body.length,
        contentType: 'image/webp',
      });
      expect(head!.etag).toBe(res.etag);
      expect(head!.lastModified!.getTime()).toBeGreaterThan(0);
      expect(await storage.exists('uploads/products/a.webp')).toBe(true);

      const got = await storage.get('uploads/products/a.webp');
      expect(got!.size).toBe(body.length);
      expect(got!.contentType).toBe('image/webp');
      expect((await collect(got!.stream)).equals(body)).toBe(true);
    });

    it('answers null / false for a missing key and deletes idempotently', async () => {
      expect(await storage.get('uploads/products/missing.webp')).toBeNull();
      expect(await storage.head('uploads/products/missing.webp')).toBeNull();
      expect(await storage.exists('uploads/products/missing.webp')).toBe(false);
      expect(await storage.delete('uploads/products/missing.webp')).toEqual({
        deleted: false,
        reason: 'missing',
      });

      await storage.put('uploads/products/b.webp', Buffer.from('x'), {
        contentType: 'image/webp',
      });
      expect(await storage.delete('uploads/products/b.webp')).toEqual({
        deleted: true,
      });
      expect(await storage.exists('uploads/products/b.webp')).toBe(false);
      expect(await storage.delete('uploads/products/b.webp')).toEqual({
        deleted: false,
        reason: 'missing',
      });
    });

    it('accepts a stream body and reports the byte count', async () => {
      const chunks = [Buffer.alloc(1000, 'a'), Buffer.alloc(500, 'b')];
      const res = await storage.put(
        'customer-uploads/2026/11/f.jpg',
        Readable.from(chunks),
        { contentType: 'image/jpeg' },
      );
      expect(res.size).toBe(1500);
      const got = await storage.get('customer-uploads/2026/11/f.jpg');
      expect((await collect(got!.stream)).equals(Buffer.concat(chunks))).toBe(
        true,
      );
    });

    it('reads byte ranges (closed, open, suffix, clamped) and refuses one past the end', async () => {
      const body = Buffer.from('0123456789');
      await storage.put('uploads/products/v.mp4', body, {
        contentType: 'video/mp4',
      });
      const read = async (range: ByteRangeSpec) => {
        const got = await storage.get('uploads/products/v.mp4', { range });
        return {
          range: got!.range,
          size: got!.size,
          text: (await collect(got!.stream)).toString(),
        };
      };
      expect(await read({ start: 2, end: 4 })).toEqual({
        range: { start: 2, end: 4 },
        size: 10,
        text: '234',
      });
      expect(await read({ start: 7 })).toEqual({
        range: { start: 7, end: 9 },
        size: 10,
        text: '789',
      });
      expect(await read({ suffix: 3 })).toEqual({
        range: { start: 7, end: 9 },
        size: 10,
        text: '789',
      });
      expect(await read({ suffix: 50 })).toMatchObject({
        range: { start: 0, end: 9 },
        text: '0123456789',
      });
      expect(await read({ start: 8, end: 999 })).toMatchObject({
        range: { start: 8, end: 9 },
        text: '89',
      });
      for (const range of [{ start: 10 }, { suffix: 0 }] as ByteRangeSpec[]) {
        const err = await storage.get('uploads/products/v.mp4', { range }).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(RangeNotSatisfiableError);
        expect((err as RangeNotSatisfiableError).head.size).toBe(10);
      }
      expect(
        await storage.get('uploads/products/missing.mp4', {
          range: { start: 0 },
        }),
      ).toBeNull();
      // Without a range nothing changes.
      const whole = await storage.get('uploads/products/v.mp4');
      expect(whole!.range).toBeUndefined();
      expect((await collect(whole!.stream)).equals(body)).toBe(true);
    });

    it('overwrites in place', async () => {
      await storage.put('k/one.txt', Buffer.from('first'), {
        contentType: 'text/plain',
      });
      await storage.put('k/one.txt', Buffer.from('second!'), {
        contentType: 'text/plain',
      });
      const got = await storage.get('k/one.txt');
      expect((await collect(got!.stream)).toString()).toBe('second!');
      expect(got!.size).toBe(7);
    });

    it('lists by prefix, sorted, with pagination', async () => {
      for (const k of [
        'uploads/b/2.txt',
        'uploads/a/1.txt',
        'uploads/a/0.txt',
        'other/x.txt',
      ]) {
        await storage.put(k, Buffer.from(k), { contentType: 'text/plain' });
      }
      const all = await storage.list('uploads/');
      expect(all.objects.map((o) => o.key)).toEqual([
        'uploads/a/0.txt',
        'uploads/a/1.txt',
        'uploads/b/2.txt',
      ]);
      expect(all.objects[0]).toMatchObject({ size: 'uploads/a/0.txt'.length });
      expect(all.nextContinuationToken).toBeUndefined();

      const page1 = await storage.list('uploads/', { maxKeys: 2 });
      expect(page1.objects.map((o) => o.key)).toEqual([
        'uploads/a/0.txt',
        'uploads/a/1.txt',
      ]);
      expect(page1.nextContinuationToken).toBeTruthy();
      const page2 = await storage.list('uploads/', {
        maxKeys: 2,
        continuationToken: page1.nextContinuationToken,
      });
      expect(page2.objects.map((o) => o.key)).toEqual(['uploads/b/2.txt']);
      expect(page2.nextContinuationToken).toBeUndefined();
      expect((await storage.list('uploads/a/')).objects).toHaveLength(2);
      expect((await storage.list('nothing/')).objects).toEqual([]);
    });

    it('rejects traversal and malformed keys on every operation', async () => {
      const bad = [
        '../etc/passwd',
        'uploads/../x.txt',
        '/uploads/a.txt',
        'uploads//a.txt',
        'uploads/a\\b.txt',
        'uploads/./a.txt',
        '',
        'uploads/a\u0000.txt',
      ];
      for (const key of bad) {
        await expect(
          storage.put(key, Buffer.from('x'), { contentType: 'text/plain' }),
        ).rejects.toBeInstanceOf(InvalidObjectKeyError);
        await expect(storage.get(key)).rejects.toBeInstanceOf(
          InvalidObjectKeyError,
        );
        await expect(storage.head(key)).rejects.toBeInstanceOf(
          InvalidObjectKeyError,
        );
        await expect(storage.delete(key)).rejects.toBeInstanceOf(
          InvalidObjectKeyError,
        );
        await expect(storage.exists(key)).rejects.toBeInstanceOf(
          InvalidObjectKeyError,
        );
      }
      await expect(storage.list('../')).rejects.toBeInstanceOf(
        InvalidObjectKeyError,
      );
    });
  });
}

contract('LocalObjectStorage', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'objstore-'));
  return {
    storage: new LocalObjectStorage({ root }),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
});

contract('S3ObjectStorage (aws-sdk-client-mock)', async () => {
  const s3 = mockS3(['media']);
  return {
    storage: new S3ObjectStorage({
      client: s3.client,
      bucket: 'media',
      role: 'media',
    }),
    cleanup: async () => s3.stub.restore(),
  };
});

describe('LocalObjectStorage specifics', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'objstore-local-'));
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it('maps `uploads/<folder>/<file>` onto the uploads root with keyPrefix', async () => {
    const media = new LocalObjectStorage({ root, keyPrefix: 'uploads/' });
    await media.put('uploads/products/a.webp', Buffer.from('img'), {
      contentType: 'image/webp',
    });
    expect(
      (await fs.readFile(path.join(root, 'products', 'a.webp'))).toString(),
    ).toBe('img');
    await expect(media.get('products/a.webp')).rejects.toBeInstanceOf(
      InvalidObjectKeyError,
    );
    await expect(media.get('uploads/')).rejects.toBeInstanceOf(
      InvalidObjectKeyError,
    );
    const listed = await media.list('uploads/products/');
    expect(listed.objects.map((o) => o.key)).toEqual([
      'uploads/products/a.webp',
    ]);
  });

  it('never lists temp files of in-flight writes and never leaves them behind', async () => {
    const s = new LocalObjectStorage({ root });
    await s.put('a/b.txt', Buffer.from('x'), { contentType: 'text/plain' });
    await fs.writeFile(path.join(root, 'a', '.b.txt.123.deadbeef.tmp'), 'tmp');
    expect((await s.list('a/')).objects.map((o) => o.key)).toEqual(['a/b.txt']);
    const broken = new Readable({
      read() {
        this.destroy(new Error('boom'));
      },
    });
    await expect(
      s.put('a/c.txt', broken, { contentType: 'text/plain' }),
    ).rejects.toThrow('boom');
    expect((await fs.readdir(path.join(root, 'a'))).sort()).toEqual([
      '.b.txt.123.deadbeef.tmp',
      'b.txt',
    ]);
  });

  it('uses the private file mode when asked', async () => {
    const s = new LocalObjectStorage({ root, fileMode: 0o600 });
    await s.put('p/q.bin', Buffer.from('x'), {
      contentType: 'application/octet-stream',
    });
    if (process.platform !== 'win32') {
      const st = await fs.stat(path.join(root, 'p', 'q.bin'));
      expect(st.mode & 0o777).toBe(0o600);
    }
  });
});

describe('S3ObjectStorage specifics', () => {
  let s3: MockS3;
  beforeEach(() => {
    s3 = mockS3(['media', 'private', 'backup']);
  });
  afterEach(() => s3.stub.restore());

  it('sets Content-Type, Cache-Control, Content-Disposition and sha256 metadata on put', async () => {
    const media = new S3ObjectStorage({
      client: s3.client,
      bucket: 'media',
      role: 'media',
    });
    const body = Buffer.from('<svg/>');
    await media.put('uploads/logos/l.svg', body, {
      contentType: 'image/svg+xml',
      cacheControl: 'public, max-age=31536000, immutable',
      contentDisposition: 'attachment',
      metadata: { origin: 'test' },
    });
    const o = s3.objects.get('media/uploads/logos/l.svg')!;
    expect(o).toMatchObject({
      contentType: 'image/svg+xml',
      cacheControl: 'public, max-age=31536000, immutable',
      contentDisposition: 'attachment',
    });
    expect(o.sse).toBeUndefined();
    expect(o.metadata.origin).toBe('test');
    expect(o.metadata.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await media.head('uploads/logos/l.svg'))!.metadata.sha256).toBe(
      o.metadata.sha256,
    );
  });

  it('encrypts private/backup writes with SSE-KMS when the key is set, else sends no encryption header', async () => {
    const withKey = new S3ObjectStorage({
      client: s3.client,
      bucket: 'private',
      role: 'private',
      kmsKeyId: 'arn:aws:kms:eu-north-1:1:key/abc',
    });
    await withKey.put('customer-uploads/2026/11/a.jpg', Buffer.from('j'), {
      contentType: 'image/jpeg',
    });
    expect(
      s3.objects.get('private/customer-uploads/2026/11/a.jpg'),
    ).toMatchObject({
      sse: 'aws:kms',
      kmsKeyId: 'arn:aws:kms:eu-north-1:1:key/abc',
    });

    const noKey = new S3ObjectStorage({
      client: s3.client,
      bucket: 'backup',
      role: 'backup',
    });
    await noKey.put('db/2026-11-03/x.dump', Buffer.from('d'), {
      contentType: 'application/octet-stream',
    });
    // No key: the bucket default applies; not even AES256 is sent.
    const stored = s3.objects.get('backup/db/2026-11-03/x.dump')!;
    expect(stored.sse).toBeUndefined();
    expect(stored.kmsKeyId).toBeUndefined();
    const putInput = s3.stub
      .commandCalls(PutObjectCommand)
      .map((c) => c.args[0].input)
      .find((i) => i.Key === 'db/2026-11-03/x.dump')!;
    expect(putInput).not.toHaveProperty('ServerSideEncryption');
    expect(putInput).not.toHaveProperty('SSEKMSKeyId');

    // Media never asks for KMS even when a key exists (public, bucket default).
    const media = new S3ObjectStorage({
      client: s3.client,
      bucket: 'media',
      role: 'media',
      kmsKeyId: 'k',
    });
    await media.put('uploads/p/a.webp', Buffer.from('m'), {
      contentType: 'image/webp',
    });
    expect(s3.objects.get('media/uploads/p/a.webp')!.sse).toBeUndefined();
    // An explicit `sse: 'kms'` on media uses the key when present.
    await media.put('uploads/p/b.webp', Buffer.from('m'), {
      contentType: 'image/webp',
      sse: 'kms',
    });
    expect(s3.objects.get('media/uploads/p/b.webp')!.sse).toBe('aws:kms');
  });

  it('uploads large buffers multipart and streams through lib-storage', async () => {
    const media = new S3ObjectStorage({
      client: s3.client,
      bucket: 'media',
      role: 'media',
    });
    const big = Buffer.alloc(S3_MULTIPART_THRESHOLD + 1, 7);
    const res = await media.put('uploads/big/b.bin', big, {
      contentType: 'application/octet-stream',
    });
    expect(res.size).toBe(big.length);
    const stored = s3.objects.get('media/uploads/big/b.bin')!;
    expect(stored.body.length).toBe(big.length);
    expect(stored.contentType).toBe('application/octet-stream');
    expect(stored.metadata.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s3.calls).toContain('PutObject');
  });

  it('applies the role key prefix to every operation and answers role-relative keys', async () => {
    const shared = mockS3(['one']);
    const media = new S3ObjectStorage({
      client: shared.client,
      bucket: 'one',
      role: 'media',
      keyPrefix: 'media',
    });
    const priv = new S3ObjectStorage({
      client: shared.client,
      bucket: 'one',
      role: 'private',
      keyPrefix: '/private/',
    });
    expect(media.keyPrefix).toBe('media/');
    expect(priv.keyPrefix).toBe('private/');
    expect(media.location).toBe('one/media/');
    await media.put('uploads/products/a.webp', Buffer.from('m'), {
      contentType: 'image/webp',
    });
    await priv.put('customer-uploads/2026/11/x.jpg', Buffer.from('p'), {
      contentType: 'image/jpeg',
    });
    expect([...shared.objects.keys()].sort()).toEqual([
      'one/media/uploads/products/a.webp',
      'one/private/customer-uploads/2026/11/x.jpg',
    ]);
    expect((await media.head('uploads/products/a.webp'))!.size).toBe(1);
    expect(await media.exists('uploads/products/a.webp')).toBe(true);
    expect(
      (
        await collect((await media.get('uploads/products/a.webp'))!.stream)
      ).toString(),
    ).toBe('m');
    // A role never sees another role's objects, even inside one bucket.
    expect(await priv.exists('uploads/products/a.webp')).toBe(false);
    expect((await media.list('uploads/')).objects.map((o) => o.key)).toEqual([
      'uploads/products/a.webp',
    ]);
    expect((await media.list('')).objects.map((o) => o.key)).toEqual([
      'uploads/products/a.webp',
    ]);
    expect((await priv.list('')).objects.map((o) => o.key)).toEqual([
      'customer-uploads/2026/11/x.jpg',
    ]);
    expect(await media.delete('uploads/products/a.webp')).toEqual({
      deleted: true,
    });
    expect(
      shared.objects.has('one/private/customer-uploads/2026/11/x.jpg'),
    ).toBe(true);
    expect(shared.calls).not.toContain('GetBucketLocation');
    shared.stub.restore();
  });

  it('STORAGE_DELETE_MODE=try: a refused DeleteObject is `denied`, warned once per bucket/prefix, never thrown', async () => {
    resetDeniedDeleteWarnings();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const denied = mockS3(['one'], ['DeleteObject']);
    const media = new S3ObjectStorage({
      client: denied.client,
      bucket: 'one',
      role: 'media',
      keyPrefix: 'media/',
      deleteMode: 'try',
    });
    const priv = new S3ObjectStorage({
      client: denied.client,
      bucket: 'one',
      role: 'private',
      keyPrefix: 'private/',
    });
    for (const k of ['uploads/p/a.webp', 'uploads/p/b.webp']) {
      await media.put(k, Buffer.from('x'), { contentType: 'image/webp' });
    }
    await priv.put('designer/s/2026/proof/x.png', Buffer.from('x'), {
      contentType: 'image/png',
    });
    expect(await media.delete('uploads/p/a.webp')).toEqual({
      deleted: false,
      reason: 'denied',
    });
    expect(await media.delete('uploads/p/b.webp')).toEqual({
      deleted: false,
      reason: 'denied',
    });
    expect(await priv.delete('designer/s/2026/proof/x.png')).toEqual({
      deleted: false,
      reason: 'denied',
    });
    // Objects stay; a missing key is still `missing` (no DeleteObject sent).
    expect(denied.objects.size).toBe(3);
    expect(await media.delete('uploads/p/none.webp')).toEqual({
      deleted: false,
      reason: 'missing',
    });
    expect(denied.calls.filter((c) => c === 'DeleteObject')).toHaveLength(3);
    // One warning per bucket/prefix, not per file.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain('s3://one/media/');
    expect(String(warn.mock.calls[1][0])).toContain('s3://one/private/');
    warn.mockRestore();
    denied.stub.restore();
  });

  it('STORAGE_DELETE_MODE=skip never calls DeleteObject', async () => {
    const skip = new S3ObjectStorage({
      client: s3.client,
      bucket: 'media',
      role: 'media',
      deleteMode: 'skip',
    });
    await skip.put('uploads/p/a.webp', Buffer.from('x'), {
      contentType: 'image/webp',
    });
    expect(await skip.delete('uploads/p/a.webp')).toEqual({
      deleted: false,
      reason: 'skipped',
    });
    expect(await skip.delete('uploads/p/none.webp')).toEqual({
      deleted: false,
      reason: 'skipped',
    });
    expect(s3.calls).not.toContain('DeleteObject');
    expect(s3.objects.has('media/uploads/p/a.webp')).toBe(true);
  });

  it('probe: HeadBucket, else ListObjectsV2 on the role prefix when HeadBucket is refused; never GetBucketLocation', async () => {
    const ok = new S3ObjectStorage({
      client: s3.client,
      bucket: 'media',
      role: 'media',
    });
    expect(await ok.probe()).toBe('head');

    const noHead = mockS3(['one'], ['HeadBucket']);
    const listed = new S3ObjectStorage({
      client: noHead.client,
      bucket: 'one',
      role: 'private',
      keyPrefix: 'private/',
    });
    expect(await listed.probe()).toBe('list');
    expect(noHead.calls).toEqual(['HeadBucket', 'ListObjectsV2']);
    const list =
      noHead.stub.commandCalls(ListObjectsV2Command)[0].args[0].input;
    expect(list).toMatchObject({
      Bucket: 'one',
      Prefix: 'private/',
      MaxKeys: 1,
    });
    // A missing bucket (404) and a refused list are failures.
    const missing = new S3ObjectStorage({
      client: noHead.client,
      bucket: 'nope',
      role: 'media',
    });
    await expect(missing.probe()).rejects.toThrow();
    noHead.deny.add('ListObjectsV2');
    await expect(listed.probe()).rejects.toThrow(/Access Denied/);
    expect(noHead.calls).not.toContain('GetBucketLocation');
    noHead.stub.restore();
  });

  it('headBucket reports a missing bucket', async () => {
    const ok = new S3ObjectStorage({
      client: s3.client,
      bucket: 'media',
      role: 'media',
    });
    const missing = new S3ObjectStorage({
      client: s3.client,
      bucket: 'nope',
      role: 'media',
    });
    expect(await ok.headBucket()).toBe(true);
    await expect(missing.headBucket()).rejects.toThrow();
  });
});
