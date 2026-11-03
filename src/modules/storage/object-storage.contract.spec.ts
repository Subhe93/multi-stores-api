import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { LocalObjectStorage } from './local-object-storage';
import { InvalidObjectKeyError, type ObjectStorage } from './object-storage';
import { S3ObjectStorage, S3_MULTIPART_THRESHOLD } from './s3-object-storage';
import { collect } from './s3-private-storage';
import { mockS3, type MockS3 } from './__fixtures__/s3-mock';

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
      expect(await storage.delete('uploads/products/missing.webp')).toBe(false);

      await storage.put('uploads/products/b.webp', Buffer.from('x'), {
        contentType: 'image/webp',
      });
      expect(await storage.delete('uploads/products/b.webp')).toBe(true);
      expect(await storage.exists('uploads/products/b.webp')).toBe(false);
      expect(await storage.delete('uploads/products/b.webp')).toBe(false);
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
      sse: 'AES256',
    });
    expect(o.metadata.origin).toBe('test');
    expect(o.metadata.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await media.head('uploads/logos/l.svg'))!.metadata.sha256).toBe(
      o.metadata.sha256,
    );
  });

  it('encrypts private/backup writes with SSE-KMS when the key is set, else AES256', async () => {
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
    expect(s3.objects.get('backup/db/2026-11-03/x.dump')).toMatchObject({
      sse: 'AES256',
    });

    // Media never asks for KMS even when a key exists (public, SSE-S3).
    const media = new S3ObjectStorage({
      client: s3.client,
      bucket: 'media',
      role: 'media',
      kmsKeyId: 'k',
    });
    await media.put('uploads/p/a.webp', Buffer.from('m'), {
      contentType: 'image/webp',
    });
    expect(s3.objects.get('media/uploads/p/a.webp')!.sse).toBe('AES256');
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
