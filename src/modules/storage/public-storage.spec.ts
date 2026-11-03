import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  InvalidPublicUrlError,
  isPublicMediaKey,
  publicMediaKeyFromUrl,
  publicObjectHeaders,
  PublicStorage,
  sanitizeFolderPath,
} from './public-storage';
import { buildObjectStorages } from './storage.module';
import { parseStorageConfig } from './storage.config';
import { S3ObjectStorage } from './s3-object-storage';
import { DualReadObjectStorage } from './dual-read-object-storage';
import { LocalObjectStorage } from './local-object-storage';
import { mockS3 } from './__fixtures__/s3-mock';

describe('public media keys', () => {
  it('accepts uploads/<folder>/<file> and one extra segment only', () => {
    expect(isPublicMediaKey('uploads/products/a.webp')).toBe(true);
    expect(isPublicMediaKey('uploads/template-imports/store/a.svg')).toBe(true);
    expect(isPublicMediaKey('uploads/....etc/a.pdf')).toBe(true);
    expect(isPublicMediaKey('uploads/a.webp')).toBe(false);
    expect(isPublicMediaKey('uploads/a/b/c/d.webp')).toBe(false);
    expect(isPublicMediaKey('uploads/../a.webp')).toBe(false);
    expect(isPublicMediaKey('uploads/products/noext')).toBe(false);
    expect(isPublicMediaKey('storage/x/y.pdf')).toBe(false);
    expect(isPublicMediaKey('uploads/products/.webp')).toBe(false);
  });

  it('maps relative and absolute URLs (any host) to keys', () => {
    expect(publicMediaKeyFromUrl('/uploads/products/a.webp')).toBe(
      'uploads/products/a.webp',
    );
    expect(publicMediaKeyFromUrl('uploads/products/a.webp')).toBe(
      'uploads/products/a.webp',
    );
    expect(
      publicMediaKeyFromUrl(
        'https://api.example.com/uploads/products/a.webp?v=2',
      ),
    ).toBe('uploads/products/a.webp');
    // A decoded space is not a safe segment character.
    expect(publicMediaKeyFromUrl('/uploads/products/a%20b.webp')).toBeNull();
    expect(publicMediaKeyFromUrl('/uploads/../package.json')).toBeNull();
    expect(publicMediaKeyFromUrl('/uploads/%2e%2e/package.json')).toBeNull();
    expect(publicMediaKeyFromUrl('/storage/a/b.pdf')).toBeNull();
    expect(publicMediaKeyFromUrl('https://x/other/a.webp')).toBeNull();
    expect(publicMediaKeyFromUrl('/uploads/a\\b/c.webp')).toBeNull();
    expect(publicMediaKeyFromUrl('')).toBeNull();
    expect(publicMediaKeyFromUrl(null)).toBeNull();
    expect(publicMediaKeyFromUrl('/uploads/%zz/a.webp')).toBeNull();
  });

  it('derives the serving headers', () => {
    expect(publicObjectHeaders('uploads/products/a.webp')).toEqual({
      cacheControl: 'public, max-age=31536000, immutable',
    });
    expect(publicObjectHeaders('uploads/logos/a.SVG')).toEqual({
      cacheControl: 'public, max-age=31536000, immutable',
      contentDisposition: 'attachment',
    });
    expect(publicObjectHeaders('uploads/customer-previews/a.webp')).toEqual({
      cacheControl: 'public, max-age=86400',
      robots: 'noindex',
    });
  });

  it('sanitizes folder paths to at most two safe segments', () => {
    expect(sanitizeFolderPath('products')).toBe('products');
    expect(sanitizeFolderPath('template-imports/store-1')).toBe(
      'template-imports/store-1',
    );
    expect(sanitizeFolderPath('a/../b')).toBe('a/general');
    expect(sanitizeFolderPath('')).toBe('general');
    expect(sanitizeFolderPath('a/b/c')).toBe('a/b');
  });
});

describe('PublicStorage (local)', () => {
  let root: string;
  let storage: PublicStorage;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pubstore-'));
    storage = PublicStorage.local(root);
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it('put returns the relative URL and writes under <root>/<folder>/<file>', async () => {
    const res = await storage.put('products', 'a.webp', Buffer.from('img'));
    expect(res).toEqual({
      url: '/uploads/products/a.webp',
      key: 'uploads/products/a.webp',
      size: 3,
    });
    expect(
      (await fs.readFile(path.join(root, 'products', 'a.webp'))).toString(),
    ).toBe('img');
    expect(storage.driver).toBe('local');
    expect(storage.localDir('products')).toBe(path.join(root, 'products'));
    expect(await storage.exists(res.url)).toBe(true);
    expect(await storage.exists('https://host/uploads/products/a.webp')).toBe(
      true,
    );
    expect((await storage.read(res.url))!.toString()).toBe('img');
    expect(await storage.read(res.url, 2)).toBeNull();
    expect((await storage.openRead(res.url))!.contentType).toBe('image/webp');
    expect((await storage.getForServing('uploads/products/a.webp'))!.size).toBe(
      3,
    );
    expect(await storage.getForServing('products/a.webp')).toBeNull();
  });

  it('delete accepts public URLs only', async () => {
    await storage.put('products', 'a.webp', Buffer.from('img'));
    expect(await storage.delete('/uploads/products/a.webp')).toBe(true);
    expect(await storage.delete('/uploads/products/a.webp')).toBe(false);
    await expect(
      storage.delete('/uploads/../package.json'),
    ).rejects.toBeInstanceOf(InvalidPublicUrlError);
    await expect(storage.delete('/etc/passwd')).rejects.toBeInstanceOf(
      InvalidPublicUrlError,
    );
  });

  it('refuses unsafe file names', async () => {
    await expect(
      storage.put('products', '../x.webp', Buffer.from('x')),
    ).rejects.toThrow(/Invalid public media name/);
    await expect(
      storage.put('products', 'noext', Buffer.from('x')),
    ).rejects.toThrow();
  });

  it('absoluteUrl uses MEDIA_BASE_URL when configured', () => {
    const withBase = new PublicStorage(
      new LocalObjectStorage({ root, keyPrefix: 'uploads/' }),
      parseStorageConfig({ MEDIA_BASE_URL: 'https://cdn.example.com' }, root),
    );
    expect(withBase.absoluteUrl('/uploads/p/a.webp')).toBe(
      'https://cdn.example.com/uploads/p/a.webp',
    );
    expect(withBase.absoluteUrl('https://x/uploads/p/a.webp')).toBe(
      'https://x/uploads/p/a.webp',
    );
    expect(storage.absoluteUrl('/uploads/p/a.webp')).toBe('/uploads/p/a.webp');
  });
});

describe('buildObjectStorages', () => {
  it('local driver: three LocalObjectStorage roots', () => {
    const cfg = parseStorageConfig({}, process.cwd());
    const s = buildObjectStorages(cfg);
    expect(s.media).toBeInstanceOf(LocalObjectStorage);
    expect(s.priv).toBeInstanceOf(LocalObjectStorage);
    expect(s.backup).toBeInstanceOf(LocalObjectStorage);
    expect((s.media as LocalObjectStorage).keyPrefix).toBe('uploads/');
  });

  it('s3 driver: S3 private, dual-read media while the fallback is on, S3 backup', () => {
    const s3 = mockS3();
    const env = {
      STORAGE_DRIVER: 's3',
      AWS_REGION: 'eu-north-1',
      S3_MEDIA_BUCKET: 'media',
      S3_PRIVATE_BUCKET: 'private',
      S3_BACKUP_BUCKET: 'backup',
    };
    const dual = buildObjectStorages(
      parseStorageConfig(env, process.cwd()),
      s3.client,
    );
    expect(dual.media).toBeInstanceOf(DualReadObjectStorage);
    expect(dual.priv).toBeInstanceOf(S3ObjectStorage);
    expect(dual.backup).toBeInstanceOf(S3ObjectStorage);
    const direct = buildObjectStorages(
      parseStorageConfig(
        { ...env, MEDIA_LOCAL_FALLBACK: 'false' },
        process.cwd(),
      ),
      s3.client,
    );
    expect(direct.media).toBeInstanceOf(S3ObjectStorage);
    const pub = new PublicStorage(direct.media);
    expect(pub.driver).toBe('s3');
    expect(pub.localDir('products')).toBeNull();
    s3.stub.restore();
  });
});
