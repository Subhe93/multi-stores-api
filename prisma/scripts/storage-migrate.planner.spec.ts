import {
  aggregate,
  cacheControlFor,
  classify,
  contentDispositionFor,
  contentTypeFor,
  diffOrphans,
  fingerprint,
  folderOf,
  formatBytes,
  isActionable,
  isSkippedFileName,
  keyFor,
  parseArgs,
  renderAggregate,
  renderOrphans,
  sseFor,
  verifyUploaded,
  type PlanEntry,
} from './storage-migrate.planner';

const entry = (over: Partial<PlanEntry>): PlanEntry => ({
  scope: 'media',
  key: 'uploads/products/a.webp',
  folder: 'products',
  size: 10,
  sha256: 'aa',
  md5: 'bb',
  action: 'copy',
  remote: null,
  ...over,
});

describe('keys and folders', () => {
  it('maps paths to keys per scope', () => {
    expect(keyFor('media', 'products\\a.webp')).toBe('uploads/products/a.webp');
    expect(keyFor('media', 'template-imports/st/x.png')).toBe(
      'uploads/template-imports/st/x.png',
    );
    expect(keyFor('private', 'customer-uploads/2026/11/x.jpg')).toBe(
      'customer-uploads/2026/11/x.jpg',
    );
    expect(keyFor('invoices', 'store/2026/inv.pdf')).toBe(
      'invoices/store/2026/inv.pdf',
    );
  });

  it('aggregates by folder, never by file', () => {
    expect(folderOf('media', 'uploads/products/a.webp')).toBe('products');
    expect(folderOf('media', 'uploads/template-imports/st/x.png')).toBe(
      'template-imports',
    );
    expect(folderOf('private', 'designer/st/2026/thumb/a.png')).toBe(
      'designer',
    );
    expect(folderOf('invoices', 'invoices/st/2026/a.pdf')).toBe('invoices');
  });

  it('skips temp and hidden files', () => {
    expect(isSkippedFileName('.a.webp.123.abc.tmp')).toBe(true);
    expect(isSkippedFileName('x.tmp')).toBe(true);
    expect(isSkippedFileName('Thumbs.db')).toBe(true);
    expect(isSkippedFileName('a.webp')).toBe(false);
  });
});

describe('object metadata', () => {
  it('matches the API serving rules', () => {
    expect(contentTypeFor('uploads/products/a.webp')).toBe('image/webp');
    expect(contentTypeFor('uploads/products/v.mp4')).toBe('video/mp4');
    expect(contentTypeFor('uploads/logos/L.SVG')).toBe('image/svg+xml');
    expect(contentTypeFor('x/no-ext')).toBe('application/octet-stream');
    expect(cacheControlFor('media', 'uploads/products/a.webp')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(cacheControlFor('media', 'uploads/customer-previews/a.webp')).toBe(
      'public, max-age=86400',
    );
    expect(
      cacheControlFor('private', 'customer-uploads/a.jpg'),
    ).toBeUndefined();
    expect(contentDispositionFor('media', 'uploads/logos/l.svg')).toBe(
      'attachment',
    );
    expect(
      contentDispositionFor('media', 'uploads/logos/l.webp'),
    ).toBeUndefined();
    expect(contentDispositionFor('private', 'designer/x.svg')).toBeUndefined();
  });

  it('chooses SSE per scope', () => {
    expect(sseFor('media', 'key-1')).toBe('s3');
    expect(sseFor('private', 'key-1')).toBe('kms');
    expect(sseFor('invoices', 'key-1')).toBe('kms');
    expect(sseFor('private', undefined)).toBe('s3');
  });
});

describe('classify', () => {
  it('copy / identical / mismatch', () => {
    expect(classify({ size: 10, sha256: 'aa' }, null)).toBe('copy');
    expect(
      classify(
        { size: 10, sha256: 'aa' },
        { size: 10, sha256: 'aa', etag: 'e' },
      ),
    ).toBe('identical');
    expect(
      classify(
        { size: 10, sha256: 'aa' },
        { size: 11, sha256: 'aa', etag: 'e' },
      ),
    ).toBe('mismatch');
    expect(
      classify(
        { size: 10, sha256: 'aa' },
        { size: 10, sha256: 'zz', etag: 'e' },
      ),
    ).toBe('mismatch');
    expect(
      classify(
        { size: 10, sha256: 'aa' },
        { size: 10, sha256: null, etag: 'e' },
      ),
    ).toBe('mismatch');
  });

  it('--resume fast path trusts a size match with sha256 metadata', () => {
    expect(
      classify(
        { size: 10, sha256: null },
        { size: 10, sha256: 'aa', etag: 'e' },
      ),
    ).toBe('identical');
    expect(
      classify(
        { size: 10, sha256: null },
        { size: 10, sha256: null, etag: 'e' },
      ),
    ).toBe('mismatch');
  });

  it('isActionable honours --overwrite', () => {
    expect(isActionable(entry({ action: 'copy' }), false)).toBe(true);
    expect(isActionable(entry({ action: 'identical' }), true)).toBe(false);
    expect(isActionable(entry({ action: 'mismatch' }), false)).toBe(false);
    expect(isActionable(entry({ action: 'mismatch' }), true)).toBe(true);
  });
});

describe('verifyUploaded', () => {
  const local = {
    size: 10,
    sha256: 'aa',
    md5: 'd41d8cd98f00b204e9800998ecf8427e',
  };
  it('passes on size + sha256 (+ md5 etag for single-part SSE-S3)', () => {
    expect(
      verifyUploaded(local, {
        size: 10,
        sha256: 'aa',
        etag: local.md5,
        sse: 'AES256',
      }),
    ).toBeNull();
    expect(
      verifyUploaded(local, {
        size: 10,
        sha256: 'aa',
        etag: 'abc-3',
        sse: 'AES256',
      }),
    ).toBeNull();
    expect(
      verifyUploaded(local, {
        size: 10,
        sha256: 'aa',
        etag: 'ffff',
        sse: 'aws:kms',
      }),
    ).toBeNull();
  });
  it('fails on size, sha256 or md5 mismatch', () => {
    expect(
      verifyUploaded(local, { size: 9, sha256: 'aa', etag: null, sse: null }),
    ).toMatch(/size/);
    expect(
      verifyUploaded(local, { size: 10, sha256: null, etag: null, sse: null }),
    ).toMatch(/sha256/);
    expect(
      verifyUploaded(local, {
        size: 10,
        sha256: 'aa',
        etag: 'ffff',
        sse: 'AES256',
      }),
    ).toMatch(/etag/);
  });
});

describe('fingerprint', () => {
  it('covers only actionable entries, order-independent', () => {
    const a = entry({ key: 'uploads/a/1', action: 'copy' });
    const b = entry({ key: 'uploads/b/2', action: 'copy', sha256: 'cc' });
    const ident = entry({ key: 'uploads/c/3', action: 'identical' });
    const mis = entry({ key: 'uploads/d/4', action: 'mismatch' });
    expect(fingerprint([a, b], false)).toBe(fingerprint([b, a], false));
    expect(fingerprint([a, b, ident], false)).toBe(fingerprint([a, b], false));
    expect(fingerprint([a, b, mis], false)).toBe(fingerprint([a, b], false));
    expect(fingerprint([a, b, mis], true)).not.toBe(fingerprint([a, b], true));
    expect(fingerprint([a], false)).not.toBe(fingerprint([a], true));
    expect(fingerprint([a, entry({ ...b, sha256: 'dd' })], false)).not.toBe(
      fingerprint([a, b], false),
    );
    expect(fingerprint([a], false)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('aggregate + render', () => {
  it('sums files and bytes per scope/folder/action and prints no file names', () => {
    const agg = aggregate([
      entry({ key: 'uploads/products/secret-1.webp', size: 100 }),
      entry({
        key: 'uploads/products/secret-2.webp',
        size: 50,
        action: 'identical',
      }),
      entry({
        key: 'uploads/logos/l.svg',
        folder: 'logos',
        size: 7,
        action: 'mismatch',
      }),
      entry({
        scope: 'invoices',
        key: 'invoices/s/2026/i.pdf',
        folder: 'invoices',
        size: 2048,
      }),
    ]);
    expect(agg.media.products.copy).toEqual({ files: 1, bytes: 100 });
    expect(agg.media.products.identical).toEqual({ files: 1, bytes: 50 });
    expect(agg.media.logos.mismatch).toEqual({ files: 1, bytes: 7 });
    expect(agg.invoices.invoices.copy).toEqual({ files: 1, bytes: 2048 });
    const txt = renderAggregate(agg);
    expect(txt).toContain('[media]');
    expect(txt).toContain('products');
    expect(txt).not.toContain('secret-1');
    expect(txt).toContain('TOTAL');
  });

  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB');
  });
});

describe('diffOrphans', () => {
  it('lists referenced-missing keys and tallies unreferenced per folder', () => {
    const local = [
      { key: 'uploads/products/a.webp', size: 10 },
      { key: 'uploads/products/b.webp', size: 20 },
      { key: 'uploads/customer-previews/c.webp', size: 5 },
    ];
    const referenced = new Set([
      'uploads/products/a.webp',
      'uploads/products/gone.webp',
    ]);
    const o = diffOrphans('media', local, referenced);
    expect(o.referenced_missing).toEqual(['uploads/products/gone.webp']);
    expect(o.unreferenced).toEqual({
      products: { files: 1, bytes: 20 },
      'customer-previews': { files: 1, bytes: 5 },
    });
    expect(o.unreferenced_total).toEqual({ files: 2, bytes: 25 });
    const txt = renderOrphans('media', o);
    expect(txt).toContain('uploads/products/gone.webp');
    expect(txt).not.toContain('c.webp');
    expect(txt).toContain('customer-previews');
  });
});

describe('parseArgs', () => {
  it('defaults and validation', () => {
    expect(parseArgs([])).toMatchObject({
      scopes: ['media', 'private', 'invoices'],
      mode: 'dry-run',
      concurrency: 8,
      resume: false,
      overwrite: false,
    });
    expect(
      parseArgs(['--scope=media,private', '--concurrency', '4', '--resume'])
        .scopes,
    ).toEqual(['media', 'private']);
    expect(parseArgs(['--scope', 'all']).scopes).toEqual([
      'media',
      'private',
      'invoices',
    ]);
    expect(() => parseArgs(['--scope=bogus'])).toThrow(/unknown scope/);
    expect(() => parseArgs(['--apply'])).toThrow(/--fingerprint/);
    expect(() =>
      parseArgs(['--apply', '--fingerprint=x', '--skip-head']),
    ).toThrow(/dry runs/);
    expect(() => parseArgs(['--concurrency=0'])).toThrow(/>= 1/);
    expect(
      parseArgs(['--apply', '--fingerprint=ABC', '--overwrite']),
    ).toMatchObject({
      mode: 'apply',
      fingerprint: 'abc',
      overwrite: true,
    });
  });
});

describe('listing-only remote (HeadObject refused)', () => {
  it('classify: a matching size is identical, a different one a mismatch', () => {
    const local = { size: 10, sha256: 'a'.repeat(64) };
    expect(
      classify(local, { size: 10, sha256: null, etag: 'e', sizeOnly: true }),
    ).toBe('identical');
    expect(
      classify(local, { size: 11, sha256: null, etag: 'e', sizeOnly: true }),
    ).toBe('mismatch');
    // Without the flag a missing sha256 metadata is still a mismatch.
    expect(classify(local, { size: 10, sha256: null, etag: 'e' })).toBe(
      'mismatch',
    );
  });

  it('verifyUploaded: size (+ ETag) only', () => {
    const md5 = 'b'.repeat(32);
    const local = { size: 3, sha256: 'a'.repeat(64), md5 };
    expect(
      verifyUploaded(local, {
        size: 3,
        sha256: null,
        etag: md5,
        sse: null,
        sizeOnly: true,
      }),
    ).toBeNull();
    expect(
      verifyUploaded(local, {
        size: 3,
        sha256: null,
        etag: 'c'.repeat(32),
        sse: null,
        sizeOnly: true,
      }),
    ).toMatch(/etag/);
    expect(
      verifyUploaded(local, {
        size: 4,
        sha256: null,
        etag: md5,
        sse: null,
        sizeOnly: true,
      }),
    ).toMatch(/size 4 != 3/);
  });
});
