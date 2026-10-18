import { Gunzip, Unzip, UnzipInflate } from 'fflate';
import * as path from 'path';
import { BundleReadError, MemoryBundleReader } from './bundle-reader';
import { isAllowedBundleFile } from './wp-bundle/bundle-schema';

/**
 * Archive bundles (M4.4 D12, §9.3): `.zip` through fflate's streaming
 * `Unzip`, `.tgz` / `.tar.gz` through fflate's streaming `Gunzip` plus the
 * minimal ustar/pax/GNU tar reader below (fflate has no tar). Everything
 * runs in process on an in-memory buffer that the upload layer already
 * capped (50 MB compressed); the system `tar` is never used on untrusted
 * input.
 *
 * Guards, all checked WHILE decompressing so a bomb is refused before it
 * is held in memory:
 * - entries ≤ `maxEntries` (64), counted for every header seen;
 * - running uncompressed total ≤ `maxTotalBytes` (50 MB) → IMPORT_BUNDLE_TOO_LARGE;
 * - uncompressed total ≤ `maxRatio` (100) × archive size → IMPORT_BUNDLE_BOMB;
 * - entry names: absolute, drive-letter, `..` segments, NUL → IMPORT_BUNDLE_UNEXPECTED_FILE;
 *   symlinks, hard links, devices, fifos → IMPORT_BUNDLE_UNEXPECTED_FILE;
 * - nested directories are flattened to base names; an entry whose base
 *   name is not an allowlisted bundle file is ignored (reported in
 *   `ignored`, e.g. `__MACOSX/._posts.tsv`), a duplicate base name is refused.
 */

export const ARCHIVE_MAX_ENTRIES = 64;
export const ARCHIVE_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const ARCHIVE_MAX_RATIO = 100;
/** File names the upload / directory paths treat as an archive. */
export const ARCHIVE_NAME_RE = /\.(zip|tgz|tar\.gz)$/i;

export interface ArchiveLimits {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxRatio?: number;
}

export interface ArchiveEntry {
  /** Base name (allowlisted bundle file). */
  name: string;
  buffer: Buffer;
}

export interface ExtractedArchive {
  kind: 'zip' | 'tgz';
  entries: ArchiveEntry[];
  /** Entry names that were skipped (not allowlisted); directories excluded. */
  ignored: string[];
  /** Uncompressed bytes seen (tar: including headers and padding). */
  total_bytes: number;
  /** Compressed archive size. */
  archive_bytes: number;
}

export function isArchiveName(name: string): boolean {
  return ARCHIVE_NAME_RE.test(name ?? '');
}

function unexpected(message: string): BundleReadError {
  return new BundleReadError('IMPORT_BUNDLE_UNEXPECTED_FILE', message);
}

function invalid(message: string): BundleReadError {
  return new BundleReadError('IMPORT_BUNDLE_INVALID_ARCHIVE', message);
}

/**
 * Entry name → `{ base }` (kept), `{ dir: true }` (directory entry, skipped)
 * or throws for unsafe names. Backslashes count as separators (Windows zips).
 */
function classifyEntryName(
  raw: string,
): { dir: true } | { dir: false; base: string; keep: boolean } {
  const name = (raw ?? '').replace(/\\/g, '/');
  if (!name || name.includes('\u0000'))
    throw unexpected('Archive entry with an empty or invalid name');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name))
    throw unexpected(`Absolute path in archive: ${name}`);
  const segments = name.split('/');
  if (segments.some((s) => s === '..'))
    throw unexpected(`Parent path segment in archive: ${name}`);
  if (name.endsWith('/')) return { dir: true };
  const base = path.posix.basename(name);
  if (!base || base === '.') return { dir: true };
  return { dir: false, base, keep: isAllowedBundleFile(base) };
}

/** Byte accounting shared by both formats. */
class ExtractionBudget {
  private entries = 0;
  total = 0;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly maxRatio: number;

  constructor(
    private readonly archiveBytes: number,
    limits: ArchiveLimits,
  ) {
    this.maxEntries = limits.maxEntries ?? ARCHIVE_MAX_ENTRIES;
    this.maxTotalBytes = limits.maxTotalBytes ?? ARCHIVE_MAX_TOTAL_BYTES;
    this.maxRatio = limits.maxRatio ?? ARCHIVE_MAX_RATIO;
  }

  entry(): void {
    if (++this.entries > this.maxEntries)
      throw unexpected(`More than ${this.maxEntries} entries in the archive`);
  }

  bytes(n: number): void {
    this.total += n;
    if (this.total > this.maxTotalBytes)
      throw new BundleReadError(
        'IMPORT_BUNDLE_TOO_LARGE',
        `The archive expands to more than ${Math.round(this.maxTotalBytes / (1024 * 1024))} MB`,
      );
    // Legit TSV exports compress ~5–10×; past 100× it is a bomb.
    if (this.total > this.maxRatio * Math.max(this.archiveBytes, 1024))
      throw new BundleReadError(
        'IMPORT_BUNDLE_BOMB',
        `Compression ratio above ${this.maxRatio}: archive refused`,
      );
  }
}

/** Collects kept entries by base name; refuses duplicates. */
class EntryCollector {
  readonly entries: ArchiveEntry[] = [];
  readonly ignored: string[] = [];
  private readonly seen = new Set<string>();

  add(name: string, chunks: Uint8Array[]): void {
    const c = classifyEntryName(name);
    if (c.dir) return;
    if (!c.keep) {
      this.ignored.push(name);
      return;
    }
    if (this.seen.has(c.base))
      throw unexpected(`Duplicate file in archive: ${c.base}`);
    this.seen.add(c.base);
    this.entries.push({ name: c.base, buffer: Buffer.concat(chunks) });
  }
}

// ── zip ───────────────────────────────────────────────────────────────────

function extractZip(archive: Buffer, budget: ExtractionBudget): EntryCollector {
  // Local file header signature (an empty zip starts with the end record).
  if (
    !(
      archive[0] === 0x50 &&
      archive[1] === 0x4b &&
      archive[2] === 3 &&
      archive[3] === 4
    )
  )
    throw invalid('Not a zip archive');
  const out = new EntryCollector();
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    budget.entry();
    // Names are validated up front so a bad entry is refused before inflating.
    const c = classifyEntryName(file.name);
    const chunks: Uint8Array[] = [];
    file.ondata = (err, data, final) => {
      if (err) throw err;
      budget.bytes(data.length);
      if (!c.dir && c.keep) chunks.push(data);
      if (final) out.add(file.name, chunks);
    };
    file.start();
  };
  // Synchronous decoders: every callback above runs inside this call, so a
  // thrown guard error aborts the extraction right here.
  unzip.push(
    new Uint8Array(archive.buffer, archive.byteOffset, archive.length),
    true,
  );
  return out;
}

// ── tar ───────────────────────────────────────────────────────────────────

const BLOCK = 512;

function octal(buf: Uint8Array, off: number, len: number): number {
  if (buf[off] & 0x80)
    throw invalid('Base-256 tar size field (entry too large)');
  const s = Buffer.from(buf.subarray(off, off + len))
    .toString('latin1')
    .split('\u0000')[0]
    .trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw invalid('Malformed tar header');
  return parseInt(s, 8);
}

function cstr(buf: Uint8Array, off: number, len: number): string {
  const slice = buf.subarray(off, off + len);
  const end = slice.indexOf(0);
  return Buffer.from(end === -1 ? slice : slice.subarray(0, end)).toString(
    'utf8',
  );
}

/**
 * Minimal streaming ustar / pax / GNU reader. Regular files are collected,
 * directories skipped, `L` long names and `x` pax `path` records honoured,
 * everything else (links, devices, fifos, unknown types) refused.
 */
class TarStream {
  private buf: Buffer = Buffer.alloc(0);
  private remaining = 0;
  private padding = 0;
  private current: {
    name: string;
    chunks: Uint8Array[];
    keep: boolean;
  } | null = null;
  private longName: string | null = null;
  private paxPath: string | null = null;
  private meta: 'L' | 'x' | 'g' | 'K' | null = null;
  private metaChunks: Uint8Array[] = [];
  private zeroBlocks = 0;
  private done = false;
  entriesSeen = 0;

  constructor(
    private readonly budget: ExtractionBudget,
    private readonly out: EntryCollector,
  ) {}

  push(chunk: Uint8Array, final: boolean): void {
    if (this.done) return;
    this.buf = this.buf.length
      ? Buffer.concat([this.buf, chunk])
      : Buffer.from(chunk);
    let off = 0;
    for (;;) {
      if (this.remaining > 0 || this.padding > 0) {
        const take = Math.min(this.remaining, this.buf.length - off);
        if (take > 0) {
          const data = this.buf.subarray(off, off + take);
          if (this.current?.keep) this.current.chunks.push(data);
          else if (this.meta) this.metaChunks.push(data);
          off += take;
          this.remaining -= take;
        }
        if (this.remaining > 0) break;
        const pad = Math.min(this.padding, this.buf.length - off);
        off += pad;
        this.padding -= pad;
        if (this.padding > 0) break;
        this.finishEntry();
        continue;
      }
      if (this.buf.length - off < BLOCK) break;
      const header = this.buf.subarray(off, off + BLOCK);
      off += BLOCK;
      if (header.every((b) => b === 0)) {
        if (++this.zeroBlocks >= 2) {
          this.done = true;
          break;
        }
        continue;
      }
      if (this.zeroBlocks) throw invalid('Data after the tar end marker');
      this.readHeader(header);
    }
    this.buf =
      off >= this.buf.length ? Buffer.alloc(0) : this.buf.subarray(off);
    if (final && !this.done) {
      if (this.remaining > 0 || this.current || this.meta)
        throw invalid('Truncated tar archive');
      if (this.buf.some((b) => b !== 0)) throw invalid('Trailing data in tar');
    }
  }

  private readHeader(h: Uint8Array): void {
    // Checksum: header bytes summed with the checksum field as spaces.
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== octal(h, 148, 8)) throw invalid('Bad tar header checksum');
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const magic = cstr(h, 257, 6);
    const prefix = magic === 'ustar' ? cstr(h, 345, 155) : '';
    const rawName = cstr(h, 0, 100);
    const name =
      this.paxPath ??
      this.longName ??
      (prefix ? `${prefix}/${rawName}` : rawName);
    this.remaining = size;
    this.padding = (BLOCK - (size % BLOCK)) % BLOCK;
    this.meta = null;
    this.metaChunks = [];
    switch (type) {
      case 'L':
      case 'K':
      case 'x':
      case 'g':
        if (size > 64 * 1024) throw invalid('Oversized tar extension header');
        this.meta = type;
        break;
      case '0':
      case '\u0000':
      case '7': {
        this.budget.entry();
        this.entriesSeen++;
        const c = classifyEntryName(name);
        this.current = { name, chunks: [], keep: !c.dir && c.keep };
        break;
      }
      case '5':
        this.budget.entry();
        this.entriesSeen++;
        classifyEntryName(name);
        // Directory: no data to keep (a size, if any, is skipped).
        this.current = { name: `${name}/`, chunks: [], keep: false };
        break;
      case '1':
        throw unexpected(`Hard link in archive: ${name}`);
      case '2':
        throw unexpected(`Symbolic link in archive: ${name}`);
      case '3':
      case '4':
        throw unexpected(`Device entry in archive: ${name}`);
      case '6':
        throw unexpected(`FIFO entry in archive: ${name}`);
      default:
        throw unexpected(`Unsupported tar entry type '${type}': ${name}`);
    }
    if (this.remaining === 0 && this.padding === 0) this.finishEntry();
  }

  private finishEntry(): void {
    if (this.meta) {
      const text = Buffer.concat(this.metaChunks).toString('utf8');
      if (this.meta === 'L') this.longName = text.split('\u0000')[0];
      else if (this.meta === 'x') {
        // pax: "<len> key=value\n" records; only `path` matters here.
        for (const m of text.matchAll(/^\d+ ([^=\n]+)=([^\n]*)\n?/gm))
          if (m[1] === 'path') this.paxPath = m[2];
      }
      this.meta = null;
      this.metaChunks = [];
      return;
    }
    if (this.current) {
      this.out.add(this.current.name, this.current.chunks);
      this.current = null;
    }
    this.longName = null;
    this.paxPath = null;
  }
}

function extractTgz(archive: Buffer, budget: ExtractionBudget): EntryCollector {
  if (!(archive[0] === 0x1f && archive[1] === 0x8b))
    throw invalid('Not a gzip archive');
  const out = new EntryCollector();
  const tar = new TarStream(budget, out);
  const gunzip = new Gunzip((data, final) => {
    budget.bytes(data.length);
    tar.push(data, final);
  });
  // The input is fed in slices so the running counters are checked between
  // them (one 64 KB deflate slice inflates to ≤ ~66 MB in the worst case).
  const SLICE = 64 * 1024;
  for (let off = 0; off < archive.length; off += SLICE) {
    const end = Math.min(off + SLICE, archive.length);
    gunzip.push(
      new Uint8Array(archive.buffer, archive.byteOffset + off, end - off),
      end === archive.length,
    );
  }
  if (archive.length === 0) throw invalid('Empty archive');
  return out;
}

// ── entry points ──────────────────────────────────────────────────────────

/** Extracts an archive buffer under the §9.3 limits (synchronous, in memory). */
export function extractArchive(
  archive: Buffer,
  fileName: string,
  limits: ArchiveLimits = {},
): ExtractedArchive {
  const lower = (fileName ?? '').toLowerCase();
  const kind: 'zip' | 'tgz' | null = lower.endsWith('.zip')
    ? 'zip'
    : lower.endsWith('.tgz') || lower.endsWith('.tar.gz')
      ? 'tgz'
      : null;
  if (!kind) throw invalid(`Not a supported archive: ${fileName}`);
  const budget = new ExtractionBudget(archive.length, limits);
  let out: EntryCollector;
  try {
    out =
      kind === 'zip'
        ? extractZip(archive, budget)
        : extractTgz(archive, budget);
  } catch (e) {
    if (e instanceof BundleReadError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw invalid(`Cannot read the archive: ${msg}`);
  }
  if (!out.entries.length)
    throw new BundleReadError(
      'IMPORT_BUNDLE_MISSING_FILE',
      'The archive holds no bundle files (posts.tsv, postmeta.tsv, …)',
    );
  return {
    kind,
    entries: out.entries,
    ignored: out.ignored,
    total_bytes: budget.total,
    archive_bytes: archive.length,
  };
}

/** In-memory `BundleReader` over the allowlisted entries of an archive. */
export class ArchiveBundleReader extends MemoryBundleReader {
  constructor(readonly archive: ExtractedArchive) {
    super(Object.fromEntries(archive.entries.map((e) => [e.name, e.buffer])));
  }
}

/** Archive entry point used by the upload and directory paths. */
export function openArchiveBundle(
  archive: Buffer,
  fileName: string,
  limits: ArchiveLimits = {},
): Promise<ArchiveBundleReader> {
  try {
    return Promise.resolve(
      new ArchiveBundleReader(extractArchive(archive, fileName, limits)),
    );
  } catch (e) {
    return Promise.reject(e as Error);
  }
}
