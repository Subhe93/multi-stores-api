import { promises as fs, Stats } from 'fs';
import * as path from 'path';
import { isAllowedBundleFile } from './wp-bundle/bundle-schema';

/**
 * Read access to the files of an export bundle (M4.4 §5.1 / §9.3).
 *
 * Seam: the archive readers (`.zip` via `fflate`, `.tgz` via zlib + an
 * in-house ustar/pax reader, both with entry allowlists and bomb checks) are
 * pending dependency approval (M4-INTEGRATION B2). Until then the adapter
 * works on any `BundleReader`, and the importer can use the directory and
 * in-memory readers below (tests, local CLI runs).
 */
export interface BundleReader {
  /** File names (flat, allowlisted) present in the bundle. */
  list(): Promise<string[]>;
  has(name: string): Promise<boolean>;
  /** UTF-8 text of one file; throws `BundleReadError` when absent or too large. */
  readText(name: string, opts?: { maxBytes?: number }): Promise<string>;
}

export const BUNDLE_DEFAULT_MAX_FILE_BYTES = 200 * 1024 * 1024;

export class BundleReadError extends Error {
  constructor(
    readonly code:
      | 'IMPORT_BUNDLE_MISSING_FILE'
      | 'IMPORT_BUNDLE_TOO_LARGE'
      | 'IMPORT_BUNDLE_UNEXPECTED_FILE'
      | 'IMPORT_BUNDLE_INVALID_ARCHIVE',
    message: string,
  ) {
    super(message);
    this.name = 'BundleReadError';
  }
}

function assertSafeName(name: string): void {
  if (
    !isAllowedBundleFile(name) ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('..')
  ) {
    throw new BundleReadError(
      'IMPORT_BUNDLE_UNEXPECTED_FILE',
      `File not allowed in a bundle: ${name}`,
    );
  }
}

function decodeUtf8(buf: Buffer): string {
  // Strip a UTF-8 BOM; the TSV reader also tolerates one.
  const s = buf.toString('utf8');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** In-memory bundle (tests, already-extracted archives). Unknown names are ignored by `list()`. */
export class MemoryBundleReader implements BundleReader {
  private readonly files = new Map<string, Buffer>();

  constructor(files: Record<string, string | Buffer>) {
    for (const [name, content] of Object.entries(files)) {
      this.files.set(
        name,
        typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
      );
    }
  }

  list(): Promise<string[]> {
    return Promise.resolve(
      [...this.files.keys()].filter((n) => isAllowedBundleFile(n)).sort(),
    );
  }

  has(name: string): Promise<boolean> {
    return Promise.resolve(isAllowedBundleFile(name) && this.files.has(name));
  }

  readText(name: string, opts: { maxBytes?: number } = {}): Promise<string> {
    try {
      return Promise.resolve(this.readSync(name, opts));
    } catch (e) {
      return Promise.reject(e as Error);
    }
  }

  private readSync(name: string, opts: { maxBytes?: number }): string {
    assertSafeName(name);
    const buf = this.files.get(name);
    if (!buf)
      throw new BundleReadError(
        'IMPORT_BUNDLE_MISSING_FILE',
        `Missing bundle file: ${name}`,
      );
    if (buf.length > (opts.maxBytes ?? BUNDLE_DEFAULT_MAX_FILE_BYTES)) {
      throw new BundleReadError(
        'IMPORT_BUNDLE_TOO_LARGE',
        `Bundle file too large: ${name}`,
      );
    }
    return decodeUtf8(buf);
  }
}

/** A flat directory holding an extracted bundle (the legacy Namez export is one). */
export class DirectoryBundleReader implements BundleReader {
  private readonly root: string;

  constructor(dir: string) {
    this.root = path.resolve(dir);
  }

  async list(): Promise<string[]> {
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && isAllowedBundleFile(e.name))
      .map((e) => e.name)
      .sort();
  }

  async has(name: string): Promise<boolean> {
    if (!isAllowedBundleFile(name)) return false;
    try {
      const st = await fs.lstat(path.join(this.root, name));
      return st.isFile();
    } catch {
      return false;
    }
  }

  async readText(
    name: string,
    opts: { maxBytes?: number } = {},
  ): Promise<string> {
    assertSafeName(name);
    const file = path.join(this.root, name);
    let st: Stats;
    try {
      st = await fs.lstat(file);
    } catch {
      throw new BundleReadError(
        'IMPORT_BUNDLE_MISSING_FILE',
        `Missing bundle file: ${name}`,
      );
    }
    // Symlinks and devices are rejected like archive entries (§9.3).
    if (!st.isFile())
      throw new BundleReadError(
        'IMPORT_BUNDLE_UNEXPECTED_FILE',
        `Not a regular file: ${name}`,
      );
    if (st.size > (opts.maxBytes ?? BUNDLE_DEFAULT_MAX_FILE_BYTES)) {
      throw new BundleReadError(
        'IMPORT_BUNDLE_TOO_LARGE',
        `Bundle file too large: ${name}`,
      );
    }
    return decodeUtf8(await fs.readFile(file));
  }
}

/**
 * Archive entry point. TODO(M4.4 WP-B, after B2 approval): `.zip` with
 * `fflate`, `.tar.gz`/`.tgz` with zlib + ustar/pax; limits of §9.3
 * (≤64 entries, ≤300 MB uncompressed, ratio ≤100, no `..`/absolute/symlink/
 * device entries, flat or one top-level folder).
 */
export function openArchiveBundle(
  _archive: Buffer,
  _fileName: string,
): Promise<BundleReader> {
  return Promise.reject(
    new BundleReadError(
      'IMPORT_BUNDLE_INVALID_ARCHIVE',
      'Archive bundles are not supported yet (archive reader pending)',
    ),
  );
}
