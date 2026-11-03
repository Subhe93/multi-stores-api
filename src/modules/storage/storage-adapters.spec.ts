import { InvalidPrivateStorageKeyError } from '../../common/storage/private-file-storage';
import { InvalidInvoiceStorageKeyError } from '../invoices/storage/invoice-storage';
import { S3InvoiceStorage } from './s3-invoice-storage';
import { S3ObjectStorage } from './s3-object-storage';
import { S3PrivateStorage } from './s3-private-storage';
import { StorageHealthService } from './storage-health.service';
import { parseStorageConfig } from './storage.config';
import { buildObjectStorages } from './storage.module';
import { mockS3, type MockS3 } from './__fixtures__/s3-mock';

describe('S3PrivateStorage', () => {
  let s3: MockS3;
  let storage: S3PrivateStorage;
  const KEY =
    'customer-uploads/2026/11/0f8fad5b-d9cb-469f-a165-70867728950e.jpg';

  beforeEach(() => {
    s3 = mockS3(['private']);
    storage = new S3PrivateStorage(
      new S3ObjectStorage({
        client: s3.client,
        bucket: 'private',
        role: 'private',
        kmsKeyId: 'kms-1',
      }),
    );
  });
  afterEach(() => s3.stub.restore());

  it('keeps the PrivateStorage contract (exists/read/write/delete/stat/openRead)', async () => {
    expect(storage.root).toBe('s3://private');
    expect(await storage.exists(KEY)).toBe(false);
    expect(await storage.read(KEY)).toBeNull();
    expect(await storage.stat(KEY)).toBeNull();
    expect(await storage.openRead(KEY)).toBeNull();

    await storage.write(KEY, Buffer.from('JPEGDATA'));
    expect(s3.objects.get(`private/${KEY}`)).toMatchObject({
      contentType: 'image/jpeg',
      sse: 'aws:kms',
      kmsKeyId: 'kms-1',
    });
    expect(await storage.exists(KEY)).toBe(true);
    expect((await storage.read(KEY))!.toString()).toBe('JPEGDATA');
    expect(await storage.stat(KEY)).toMatchObject({ bytes: 8 });
    const opened = await storage.openRead(KEY);
    expect(opened!.bytes).toBe(8);
    const chunks: Buffer[] = [];
    for await (const c of opened!.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('JPEGDATA');
    expect(await storage.delete(KEY)).toBe(true);
    expect(await storage.delete(KEY)).toBe(false);
  });

  it('validates namespaced keys like the disk implementation', async () => {
    for (const bad of [
      '../x.jpg',
      'uploads/a.webp',
      'customer-uploads/x.jpg',
      '',
    ]) {
      await expect(storage.read(bad)).rejects.toBeInstanceOf(
        InvalidPrivateStorageKeyError,
      );
      await expect(storage.write(bad, Buffer.from('x'))).rejects.toBeInstanceOf(
        InvalidPrivateStorageKeyError,
      );
    }
    expect(s3.objects.size).toBe(0);
  });
});

describe('S3InvoiceStorage', () => {
  let s3: MockS3;
  let storage: S3InvoiceStorage;
  const STORE = '7d0b6c1e-1f1a-4c39-9a52-2b1d2f3c4d5e';
  const INV = 'a1b2c3d4-0000-4000-8000-000000000001';

  beforeEach(() => {
    s3 = mockS3(['private']);
    storage = new S3InvoiceStorage(
      new S3ObjectStorage({
        client: s3.client,
        bucket: 'private',
        role: 'private',
      }),
    );
  });
  afterEach(() => s3.stub.restore());

  it("stores today's keys under invoices/ in the private bucket", async () => {
    const key = storage.keyFor(STORE, '2026-10-14', INV);
    expect(key).toBe(`${STORE}/2026/${INV}.pdf`);
    expect(await storage.exists(key)).toBe(false);
    expect(await storage.read(key)).toBeNull();
    await storage.write(key, Buffer.from('%PDF-1.7'));
    expect(s3.objects.has(`private/invoices/${key}`)).toBe(true);
    expect(s3.objects.get(`private/invoices/${key}`)!.contentType).toBe(
      'application/pdf',
    );
    expect(await storage.exists(key)).toBe(true);
    expect((await storage.read(key))!.toString()).toBe('%PDF-1.7');
  });

  it('rejects malformed keys', async () => {
    await expect(storage.read('../x.pdf')).rejects.toBeInstanceOf(
      InvalidInvoiceStorageKeyError,
    );
    await expect(
      storage.write(`${STORE}/26/${INV}.pdf`, Buffer.from('x')),
    ).rejects.toBeInstanceOf(InvalidInvoiceStorageKeyError);
    expect(() => storage.keyFor('a/b', '2026-01-01', INV)).toThrow(
      InvalidInvoiceStorageKeyError,
    );
  });
});

describe('StorageHealthService', () => {
  const env = {
    STORAGE_DRIVER: 's3',
    AWS_REGION: 'eu-north-1',
    S3_MEDIA_BUCKET: 'media',
    S3_PRIVATE_BUCKET: 'private',
    S3_BACKUP_BUCKET: 'backup',
  };

  function build(buckets: string[], extra: Record<string, string> = {}) {
    const s3 = mockS3(buckets);
    const cfg = parseStorageConfig({ ...env, ...extra }, process.cwd());
    const s = buildObjectStorages(cfg, s3.client);
    const svc = new StorageHealthService(cfg, s.media, s.priv, s.backup);
    return { s3, svc };
  }

  it('reports ok/fail per bucket and caches for 60 s', async () => {
    const { s3, svc } = build(['media', 'backup']);
    let t = 1_000_000;
    svc.now = () => t;
    expect(await svc.check()).toEqual({
      driver: 's3',
      media: 'ok',
      private: 'fail',
      backup: 'ok',
    });
    const calls = s3.calls.filter((c) => c === 'HeadBucket').length;
    expect(calls).toBe(3);
    await svc.check();
    expect(s3.calls.filter((c) => c === 'HeadBucket').length).toBe(3);
    t += 61_000;
    await svc.check();
    expect(s3.calls.filter((c) => c === 'HeadBucket').length).toBe(6);
    s3.stub.restore();
  });

  it('refuses to start on a failed HeadBucket unless strict startup is off', async () => {
    const strict = build(['media']);
    await expect(strict.svc.onModuleInit()).rejects.toThrow(
      /HeadBucket failed for private/,
    );
    strict.s3.stub.restore();
    // The backup bucket is best-effort (the API key may lack access to it).
    const backupOnly = build(['media', 'private']);
    await expect(backupOnly.svc.onModuleInit()).resolves.toBeUndefined();
    expect((await backupOnly.svc.check()).backup).toBe('fail');
    backupOnly.s3.stub.restore();
    const lax = build(['media'], { STORAGE_STRICT_STARTUP: 'false' });
    await expect(lax.svc.onModuleInit()).resolves.toBeUndefined();
    lax.s3.stub.restore();
    const ok = build(['media', 'private', 'backup']);
    await expect(ok.svc.onModuleInit()).resolves.toBeUndefined();
    ok.s3.stub.restore();
  });

  it('local driver: always ok without touching anything', async () => {
    const cfg = parseStorageConfig({}, process.cwd());
    const s = buildObjectStorages(cfg);
    const svc = new StorageHealthService(cfg, s.media, s.priv, s.backup);
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(await svc.check()).toEqual({
      driver: 'local',
      media: 'ok',
      private: 'ok',
    });
  });
});
