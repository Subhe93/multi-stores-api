/**
 * Platform private file storage (M4.5 contract C10).
 *
 * One storage for every private file of the store apps: customer upload
 * originals (M4.0), designer assets (M4.2) and importer bundles (M4.4).
 * Files live under PRIVATE_STORAGE_DIR (default `<cwd>/storage`), never under
 * the public `uploads/` tree. Keys are namespaced and every namespace has its
 * own key pattern, checked by write/read/delete/stat/exists.
 *
 * `PrivateFileStorage` below is a copy of `LocalDiskInvoiceStorage` (atomic
 * temp+rename writes, `resolve` guard) plus `delete` and `stat`; the global
 * `PrivateStorageModule` binds it to `PRIVATE_STORAGE`. Invoice storage (`invoices/storage/invoice-storage.ts`) stays untouched (M3
 * is frozen).
 */
import { randomBytes } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import * as path from 'path';
import type { Readable } from 'stream';

/** Nest injection token for the `PrivateStorage` implementation. */
export const PRIVATE_STORAGE = Symbol('PRIVATE_STORAGE');

/** Environment variable that overrides the storage root. */
export const PRIVATE_STORAGE_DIR_ENV = 'PRIVATE_STORAGE_DIR';

export interface PrivateFileStat {
  bytes: number;
  modified_at: Date;
}

/** A file opened for streaming: its size and a readable of its bytes. */
export interface PrivateFileRead {
  bytes: number;
  stream: Readable;
}

export interface PrivateStorage {
  /** Absolute root directory. */
  readonly root: string;
  /** True when the file exists and is not empty. Throws on an invalid key. */
  exists(key: string): Promise<boolean>;
  /** File contents, or null when the file does not exist. */
  read(key: string): Promise<Buffer | null>;
  /** Atomically writes (or replaces) the file. */
  write(key: string, data: Buffer): Promise<void>;
  /** Deletes the file; false when it did not exist (ENOENT is not an error). */
  delete(key: string): Promise<boolean>;
  /** Size and mtime, or null when the file does not exist. */
  stat(key: string): Promise<PrivateFileStat | null>;
  /**
   * The file as a stream (size from `stat`), or null when it does not
   * exist; large originals are served without buffering them (M5 A5).
   * Optional so test doubles and other backends may implement `read` only.
   */
  openRead?(key: string): Promise<PrivateFileRead | null>;
}

export class InvalidPrivateStorageKeyError extends Error {
  constructor(key: string) {
    super(`Invalid private storage key: ${JSON.stringify(key)}`);
    this.name = 'InvalidPrivateStorageKeyError';
  }
}

/**
 * Key pattern per namespace (the first path segment). A key is valid only
 * when its namespace is listed here and the whole key matches.
 * M4.2 adds `designer` (`designer/<storeId>/<yyyy>/<kind>/<id>.<ext>`) and
 * M4.4 adds `importer` (`importer/<storeId>/{bundles,snapshots,media}/<name>.<ext>`)
 * in their own step 0.
 */
export const PRIVATE_STORAGE_KEY_PATTERNS: Readonly<Record<string, RegExp>> = {
  'customer-uploads':
    /^customer-uploads\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf|ai)$/,
  // M4.4 importer: uploaded bundle files (allowlisted names), the parsed
  // catalog snapshot of a run and private template media (by sha256).
  // M4.2 designer: `designer/<storeId>/<yyyy>/<kind>/<id>[-<surface>].<ext>`
  // (customer photos + previews, template backgrounds/decorations/thumbnails,
  // fonts, proofs and print files; built by modules/designer/designer-assets.keys.ts).
  designer:
    /^designer\/[0-9a-f-]{36}\/\d{4}\/(photo|photo-preview|bg-web|bg-print|deco|thumb|font|proof|print)\/[0-9a-f-]{36}(-[a-z]{1,16})?\.(jpg|png|webp|woff2|ttf|otf)$/,
  importer:
    /^importer\/[0-9a-f-]{36}\/(bundles\/[0-9a-f-]{36}\/[a-z_]{1,40}\.(tsv|json|csv|txt)|snapshots\/[0-9a-f-]{36}\.json\.gz|media\/[0-9a-f]{64}\.(jpg|png|webp|gif))$/,
};

export type PrivateStorageNamespace = keyof typeof PRIVATE_STORAGE_KEY_PATTERNS;

/** True when the key belongs to a known namespace and matches its pattern. */
export function isValidPrivateStorageKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  const ns = key.split('/', 1)[0];
  const re = Object.prototype.hasOwnProperty.call(
    PRIVATE_STORAGE_KEY_PATTERNS,
    ns,
  )
    ? PRIVATE_STORAGE_KEY_PATTERNS[ns]
    : undefined;
  return !!re && re.test(key);
}

/** `<cwd>/storage`, or PRIVATE_STORAGE_DIR when set. */
export function defaultPrivateStorageDir(): string {
  const fromEnv = process.env[PRIVATE_STORAGE_DIR_ENV];
  return fromEnv && fromEnv.trim()
    ? path.resolve(fromEnv.trim())
    : path.join(process.cwd(), 'storage');
}

/**
 * Local-disk implementation of `PrivateStorage`. Every key is validated
 * against its namespace pattern and then resolved inside `root`, so a crafted
 * key can never reach a file outside the storage tree. Writes go to a temp
 * file in the target directory and are renamed into place, so a crash never
 * leaves a truncated file under a valid key.
 */
export class PrivateFileStorage implements PrivateStorage {
  readonly root: string;

  constructor(root?: string | null) {
    this.root = path.resolve(
      root && root.trim() ? root.trim() : defaultPrivateStorageDir(),
    );
  }

  /** Validates the key and resolves it to an absolute path inside root. */
  resolve(key: string): string {
    if (!isValidPrivateStorageKey(key)) {
      throw new InvalidPrivateStorageKeyError(String(key));
    }
    const full = path.resolve(this.root, ...key.split('/'));
    const rel = path.relative(this.root, full);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new InvalidPrivateStorageKeyError(key);
    }
    return full;
  }

  async exists(key: string): Promise<boolean> {
    const file = this.resolve(key);
    try {
      const st = await fs.stat(file);
      return st.isFile() && st.size > 0;
    } catch {
      return false;
    }
  }

  async read(key: string): Promise<Buffer | null> {
    const file = this.resolve(key);
    try {
      return await fs.readFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async write(key: string, data: Buffer): Promise<void> {
    const file = this.resolve(key);
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
    );
    const handle = await fs.open(tmp, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, file);
    } catch (e) {
      // A failed write (ENOSPC, EIO, ...) or rename never leaves a temp file.
      await fs.unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  async delete(key: string): Promise<boolean> {
    const file = this.resolve(key);
    try {
      await fs.unlink(file);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
  }

  async stat(key: string): Promise<PrivateFileStat | null> {
    const file = this.resolve(key);
    try {
      const st = await fs.stat(file);
      if (!st.isFile()) return null;
      return { bytes: st.size, modified_at: st.mtime };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async openRead(key: string): Promise<PrivateFileRead | null> {
    const st = await this.stat(key);
    if (!st) return null;
    return { bytes: st.bytes, stream: createReadStream(this.resolve(key)) };
  }
}
