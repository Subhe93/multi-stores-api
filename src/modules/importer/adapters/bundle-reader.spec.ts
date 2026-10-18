import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DirectoryBundleReader, MemoryBundleReader } from './bundle-reader';
import { openArchiveBundle } from './archive-bundle';

describe('bundle readers', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'importer-bundle-'));
    writeFileSync(join(dir, 'posts.tsv'), '\uFEFF1\t2\n');
    writeFileSync(join(dir, 'notes.txt'), 'not allowed');
    writeFileSync(join(dir, 'options.tsv'), 'x'.repeat(100));
    mkdirSync(join(dir, 'terms.tsv'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('lists only allowlisted regular files', async () => {
    const r = new DirectoryBundleReader(dir);
    expect(await r.list()).toEqual(['options.tsv', 'posts.tsv']);
    expect(await r.has('terms.tsv')).toBe(false);
    expect(await r.has('notes.txt')).toBe(false);
  });

  it('reads text without the BOM and enforces limits and names', async () => {
    const r = new DirectoryBundleReader(dir);
    expect(await r.readText('posts.tsv')).toBe('1\t2\n');
    await expect(
      r.readText('options.tsv', { maxBytes: 10 }),
    ).rejects.toMatchObject({ code: 'IMPORT_BUNDLE_TOO_LARGE' });
    await expect(r.readText('../posts.tsv')).rejects.toMatchObject({
      code: 'IMPORT_BUNDLE_UNEXPECTED_FILE',
    });
    await expect(r.readText('notes.txt')).rejects.toMatchObject({
      code: 'IMPORT_BUNDLE_UNEXPECTED_FILE',
    });
    await expect(r.readText('postmeta.tsv')).rejects.toMatchObject({
      code: 'IMPORT_BUNDLE_MISSING_FILE',
    });
    await expect(r.readText('terms.tsv')).rejects.toMatchObject({
      code: 'IMPORT_BUNDLE_UNEXPECTED_FILE',
    });
  });

  it('memory reader behaves the same', async () => {
    const r = new MemoryBundleReader({ 'posts.tsv': 'a', 'x.sh': 'b' });
    expect(await r.list()).toEqual(['posts.tsv']);
    expect(await r.has('x.sh')).toBe(false);
    await expect(r.readText('x.sh')).rejects.toMatchObject({
      code: 'IMPORT_BUNDLE_UNEXPECTED_FILE',
    });
  });

  it('garbage archives are refused (the readers themselves are specified in archive-bundle.spec)', async () => {
    await expect(
      openArchiveBundle(Buffer.from('PK'), 'b.zip'),
    ).rejects.toMatchObject({ code: 'IMPORT_BUNDLE_INVALID_ARCHIVE' });
    await expect(
      openArchiveBundle(Buffer.from('not gzip'), 'b.tgz'),
    ).rejects.toMatchObject({ code: 'IMPORT_BUNDLE_INVALID_ARCHIVE' });
    await expect(
      openArchiveBundle(Buffer.alloc(0), 'b.rar'),
    ).rejects.toMatchObject({ code: 'IMPORT_BUNDLE_INVALID_ARCHIVE' });
  });
});
