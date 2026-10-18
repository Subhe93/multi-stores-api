import { gzipSync, zipSync } from 'fflate';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SLICE_DIR } from './wp-bundle/__fixtures__/fixtures';
import { isAllowedBundleFile } from './wp-bundle/bundle-schema';
import { extractArchive, openArchiveBundle } from './archive-bundle';
import {
  BUNDLE_DIR_MAX_BYTES,
  BUNDLE_DIR_ROOT_ENV,
  readBundleDirectory,
  validateBundleFiles,
} from '../runs/bundle-store';

/** The Namez slice fixture (legacy bundle) as `{ name: bytes }`. */
function sliceFiles(): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const n of readdirSync(SLICE_DIR))
    if (isAllowedBundleFile(n)) out[n] = readFileSync(join(SLICE_DIR, n));
  return out;
}

const u8 = (b: Buffer | string) =>
  typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b);

function zip(files: Record<string, Buffer | string>, level = 6): Buffer {
  return Buffer.from(
    zipSync(
      Object.fromEntries(Object.entries(files).map(([k, v]) => [k, u8(v)])),
      { level: level as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 },
    ),
  );
}

// ── hand-made tar (ustar / GNU / pax) ─────────────────────────────────────

function octal(n: number, len: number): Buffer {
  return Buffer.from(n.toString(8).padStart(len - 1, '0') + '\0', 'latin1');
}

interface TarEntry {
  name: string;
  data?: Buffer | string;
  type?: string;
  linkname?: string;
  prefix?: string;
  breakChecksum?: boolean;
}

function tarHeader(e: TarEntry, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(e.name, 0, 100, 'utf8');
  octal(0o644, 8).copy(h, 100);
  octal(0, 8).copy(h, 108);
  octal(0, 8).copy(h, 116);
  octal(size, 12).copy(h, 124);
  octal(0, 12).copy(h, 136);
  h.write(e.type ?? '0', 156, 1, 'latin1');
  if (e.linkname) h.write(e.linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257, 6, 'latin1');
  h.write('00', 263, 2, 'latin1');
  if (e.prefix) h.write(e.prefix, 345, 155, 'utf8');
  Buffer.from('        ', 'latin1').copy(h, 148);
  let sum = 0;
  for (const b of h) sum += b;
  if (e.breakChecksum) sum += 1;
  Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'latin1').copy(h, 148);
  return h;
}

function tar(entries: TarEntry[], opts: { truncate?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data =
      e.data === undefined
        ? Buffer.alloc(0)
        : typeof e.data === 'string'
          ? Buffer.from(e.data, 'utf8')
          : e.data;
    parts.push(tarHeader(e, data.length));
    if (data.length) {
      parts.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  if (!opts.truncate) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function tgz(entries: TarEntry[], opts: { truncate?: boolean } = {}): Buffer {
  return Buffer.from(gzipSync(u8(tar(entries, opts))));
}

/** GNU `L` long name record followed by the real entry. */
function longName(name: string, data: string): TarEntry[] {
  return [
    { name: '././@LongLink', type: 'L', data: name + '\0' },
    { name: name.slice(0, 100), data },
  ];
}

/** pax `x` record with a `path` key followed by the real entry. */
function paxPath(name: string, data: string): TarEntry[] {
  const record = ` path=${name}\n`;
  const len = String(record.length + String(record.length + 2).length);
  return [
    { name: 'PaxHeader/x', type: 'x', data: `${len}${record}` },
    { name: 'x', data },
  ];
}

/** `toThrow` matcher on the BundleReadError code. */
const withCode = (code: string): Error =>
  expect.objectContaining({ code }) as unknown as Error;

describe('archive bundles (fflate zip, gunzip + in-house tar)', () => {
  const slice = sliceFiles();
  const names = Object.keys(slice).sort();

  it('zip of the Namez slice round-trips byte for byte and feeds validateBundleFiles', async () => {
    const archive = zip(slice);
    const ex = extractArchive(archive, 'namez-export.zip');
    expect(ex.kind).toBe('zip');
    expect(ex.entries.map((e) => e.name).sort()).toEqual(names);
    for (const e of ex.entries)
      expect(e.buffer.equals(slice[e.name])).toBe(true);
    expect(ex.ignored).toEqual([]);
    expect(ex.total_bytes).toBe(
      Object.values(slice).reduce((n, b) => n + b.length, 0),
    );

    const reader = await openArchiveBundle(archive, 'namez-export.zip');
    expect(await reader.list()).toEqual(names);
    expect(await reader.readText('posts.tsv')).toBe(
      slice['posts.tsv'].toString('utf8'),
    );

    const files = await validateBundleFiles([
      {
        originalname: 'namez-export.zip',
        buffer: archive,
        size: archive.length,
      },
    ]);
    expect(files.map((f) => f.originalname).sort()).toEqual(names);
  });

  it('tgz with a top-level folder and macOS junk: flattened, junk ignored', () => {
    const entries: TarEntry[] = [
      { name: 'namez-export-20261015/', type: '5' },
      ...names.map((n) => ({
        name: `namez-export-20261015/${n}`,
        data: slice[n],
      })),
      { name: '__MACOSX/._posts.tsv', data: 'Mac OS X resource fork' },
      { name: 'namez-export-20261015/.DS_Store', data: 'junk' },
      {
        name: 'namez-export-20261015/notes/readme.txt',
        data: 'not a bundle file',
      },
    ];
    const ex = extractArchive(tgz(entries), 'namez-export-20261015.tgz');
    expect(ex.kind).toBe('tgz');
    expect(ex.entries.map((e) => e.name).sort()).toEqual(names);
    for (const e of ex.entries)
      expect(e.buffer.equals(slice[e.name])).toBe(true);
    expect(ex.ignored.sort()).toEqual([
      '__MACOSX/._posts.tsv',
      'namez-export-20261015/.DS_Store',
      'namez-export-20261015/notes/readme.txt',
    ]);
    // `.tar.gz` is the same format.
    expect(extractArchive(tgz(entries), 'x.tar.gz').entries).toHaveLength(
      names.length,
    );
  });

  it('zip-slip and absolute names are refused before anything is inflated', () => {
    for (const bad of [
      '../posts.tsv',
      'a/../../posts.tsv',
      '/etc/posts.tsv',
      'C:\\posts.tsv',
      '..\\posts.tsv',
    ]) {
      expect(() =>
        extractArchive(zip({ [bad]: 'x', 'postmeta.tsv': 'y' }), 'b.zip'),
      ).toThrow(withCode('IMPORT_BUNDLE_UNEXPECTED_FILE'));
      expect(() =>
        extractArchive(tgz([{ name: bad, data: 'x' }]), 'b.tgz'),
      ).toThrow(withCode('IMPORT_BUNDLE_UNEXPECTED_FILE'));
    }
    // Windows-style separators inside a safe path are just separators.
    expect(
      extractArchive(zip({ 'export\\posts.tsv': 'x' }), 'b.zip').entries[0]
        .name,
    ).toBe('posts.tsv');
  });

  it('duplicate base names and more than 64 entries are refused', () => {
    expect(() =>
      extractArchive(zip({ 'a/posts.tsv': 'x', 'b/posts.tsv': 'y' }), 'b.zip'),
    ).toThrow(withCode('IMPORT_BUNDLE_UNEXPECTED_FILE'));
    const many: Record<string, string> = { 'posts.tsv': 'x' };
    for (let i = 0; i < 64; i++) many[`junk${i}.txt`] = 'j';
    expect(() => extractArchive(zip(many), 'b.zip')).toThrow(
      withCode('IMPORT_BUNDLE_UNEXPECTED_FILE'),
    );
  });

  it('zip bomb: a small zip inflating past the cap is refused mid-stream', () => {
    // 6 MB of zeros deflate to a few KB: ratio ≫ 100 and above a 1 MB cap.
    const zeros = Buffer.alloc(6 * 1024 * 1024);
    const bomb = zip({ 'posts.tsv': zeros, 'postmeta.tsv': 'x' }, 9);
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(() =>
      extractArchive(bomb, 'bomb.zip', { maxTotalBytes: 1024 * 1024 }),
    ).toThrow(withCode('IMPORT_BUNDLE_TOO_LARGE'));
    // Under the total cap but over the 100× ratio: still a bomb.
    expect(() => extractArchive(bomb, 'bomb.zip')).toThrow(
      withCode('IMPORT_BUNDLE_BOMB'),
    );
    // The same bytes in a tgz.
    const tbomb = tgz([
      { name: 'posts.tsv', data: zeros },
      { name: 'postmeta.tsv', data: 'x' },
    ]);
    expect(() =>
      extractArchive(tbomb, 'bomb.tgz', { maxTotalBytes: 1024 * 1024 }),
    ).toThrow(withCode('IMPORT_BUNDLE_TOO_LARGE'));
    expect(() => extractArchive(tbomb, 'bomb.tgz')).toThrow(
      withCode('IMPORT_BUNDLE_BOMB'),
    );
    // A legit archive of the same size stays under the ratio.
    const real = zip(slice, 9);
    expect(() => extractArchive(real, 'ok.zip')).not.toThrow();
  });

  it('tar: long names (GNU L and pax path) are accepted, links and devices refused', () => {
    const deep = `${'d'.repeat(60)}/${'e'.repeat(60)}/${'f'.repeat(30)}/posts.tsv`;
    expect(deep.length).toBeGreaterThan(100);
    let ex = extractArchive(
      tgz([...longName(deep, 'gnu long'), { name: 'postmeta.tsv', data: 'm' }]),
      'long.tgz',
    );
    expect(ex.entries.map((e) => [e.name, e.buffer.toString()])).toEqual([
      ['posts.tsv', 'gnu long'],
      ['postmeta.tsv', 'm'],
    ]);
    ex = extractArchive(tgz(paxPath(deep, 'pax long')), 'pax.tgz');
    expect(ex.entries).toEqual([
      { name: 'posts.tsv', buffer: Buffer.from('pax long') },
    ]);
    // ustar prefix + name.
    ex = extractArchive(
      tgz([{ name: 'posts.tsv', prefix: 'export/2026', data: 'p' }]),
      'p.tgz',
    );
    expect(ex.entries[0].name).toBe('posts.tsv');
    // A long name that traverses is still refused.
    expect(() =>
      extractArchive(
        tgz(longName(`${'x'.repeat(120)}/../../posts.tsv`, 'x')),
        'bad.tgz',
      ),
    ).toThrow(withCode('IMPORT_BUNDLE_UNEXPECTED_FILE'));

    for (const [type, linkname] of [
      ['2', '/etc/passwd'],
      ['1', 'posts.tsv'],
      ['3', undefined],
      ['4', undefined],
      ['6', undefined],
    ] as const) {
      expect(() =>
        extractArchive(
          tgz([
            { name: 'posts.tsv', data: 'ok' },
            { name: 'postmeta.tsv', type, linkname },
          ]),
          'link.tgz',
        ),
      ).toThrow(withCode('IMPORT_BUNDLE_UNEXPECTED_FILE'));
    }
  });

  it('tar: truncated data, bad checksums and non-archives are invalid', () => {
    // Cut in the middle of the entry's data (header + 100 of 1000 bytes).
    const whole = tar([{ name: 'posts.tsv', data: 'x'.repeat(1000) }], {
      truncate: true,
    });
    expect(() =>
      extractArchive(
        Buffer.from(gzipSync(u8(whole.subarray(0, 612)))),
        't.tgz',
      ),
    ).toThrow(withCode('IMPORT_BUNDLE_INVALID_ARCHIVE'));
    // A missing end-of-archive marker alone is tolerated (busybox-style tars).
    expect(
      extractArchive(Buffer.from(gzipSync(u8(whole))), 't.tgz').entries,
    ).toHaveLength(1);
    expect(() =>
      extractArchive(
        tgz([{ name: 'posts.tsv', data: 'x', breakChecksum: true }]),
        't.tgz',
      ),
    ).toThrow(withCode('IMPORT_BUNDLE_INVALID_ARCHIVE'));
    expect(() => extractArchive(Buffer.from('plain text'), 't.tgz')).toThrow(
      withCode('IMPORT_BUNDLE_INVALID_ARCHIVE'),
    );
    expect(() => extractArchive(Buffer.from('plain text'), 't.zip')).toThrow(
      withCode('IMPORT_BUNDLE_INVALID_ARCHIVE'),
    );
    expect(() => extractArchive(zip(slice), 't.rar')).toThrow(
      withCode('IMPORT_BUNDLE_INVALID_ARCHIVE'),
    );
    // Only junk inside → nothing to import.
    expect(() => extractArchive(zip({ 'readme.txt': 'x' }), 't.zip')).toThrow(
      withCode('IMPORT_BUNDLE_MISSING_FILE'),
    );
  });

  it('upload validation maps archive errors to API errors and keeps the one-or-the-other rule', async () => {
    const bomb = zip({ 'posts.tsv': Buffer.alloc(4 * 1024 * 1024) }, 9);
    await expect(
      validateBundleFiles([{ originalname: 'b.zip', buffer: bomb, size: 1 }]),
    ).rejects.toMatchObject({
      response: { code: 'IMPORT_BUNDLE_BOMB', file: 'b.zip' },
    });
    const ok = zip(slice);
    await expect(
      validateBundleFiles([
        { originalname: 'a.zip', buffer: ok, size: 1 },
        { originalname: 'b.zip', buffer: ok, size: 1 },
      ]),
    ).rejects.toMatchObject({
      response: { code: 'IMPORT_BUNDLE_UNEXPECTED_FILE' },
    });
    await expect(
      validateBundleFiles([{ originalname: 'a.7z', buffer: ok, size: 1 }]),
    ).rejects.toMatchObject({
      response: { code: 'IMPORT_BUNDLE_INVALID_ARCHIVE' },
    });
  });

  it('admin from-directory accepts a .tgz below IMPORTER_BUNDLE_DIR_ROOT', async () => {
    const root = mkdtempSync(join(tmpdir(), 'importer-root-'));
    const prev = process.env[BUNDLE_DIR_ROOT_ENV];
    process.env[BUNDLE_DIR_ROOT_ENV] = root;
    try {
      const entries: TarEntry[] = names.map((n) => ({
        name: `namez-export-20261015/${n}`,
        data: slice[n],
      }));
      writeFileSync(join(root, 'namez-export-20261015.tgz'), tgz(entries));
      writeFileSync(join(root, 'notes.txt'), 'x');
      const files = await readBundleDirectory('namez-export-20261015.tgz');
      expect(files.map((f) => f.originalname)).toEqual([
        'namez-export-20261015.tgz',
      ]);
      const expanded = await validateBundleFiles(files, {
        maxTotalBytes: BUNDLE_DIR_MAX_BYTES,
      });
      expect(expanded.map((f) => f.originalname).sort()).toEqual(names);
      await expect(readBundleDirectory('notes.txt')).rejects.toMatchObject({
        response: { code: 'IMPORT_BUNDLE_INVALID_ARCHIVE' },
      });
    } finally {
      if (prev === undefined) delete process.env[BUNDLE_DIR_ROOT_ENV];
      else process.env[BUNDLE_DIR_ROOT_ENV] = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
