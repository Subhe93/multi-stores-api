/**
 * Local-disk `ObjectStorage`: one root directory per bucket role. Keys are
 * resolved inside the root (validated first, then checked with
 * `path.relative`), writes are atomic (temp file + rename), headers live in
 * the file system (size, mtime) and the content type is derived from the
 * extension. User metadata is not persisted (the sha256 can always be
 * recomputed from the bytes).
 *
 * `keyPrefix` makes the storage answer only keys under that prefix and maps
 * them to the root without it: the media store is rooted at `<cwd>/uploads`
 * with prefix `uploads/`, so the key `uploads/products/a.webp` is the file
 * `<cwd>/uploads/products/a.webp` and today's URL stays the key.
 */
import { createHash, randomBytes } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import {
  assertValidObjectKey,
  InvalidObjectKeyError,
  isValidObjectPrefix,
  type ListObjectsOptions,
  type ListObjectsResult,
  type ListedObject,
  type ObjectBody,
  type ObjectHead,
  type ObjectStorage,
  type PutObjectOptions,
  type PutObjectResult,
} from './object-storage';

export interface LocalObjectStorageOptions {
  root: string;
  /** Required key prefix (with trailing slash), stripped before resolving. */
  keyPrefix?: string;
  /** File mode of written objects (default: process umask; private roles use 0o600). */
  fileMode?: number;
}

export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.ai': 'application/postscript',
  '.json': 'application/json',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.dump': 'application/octet-stream',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** MIME type from the key's extension; `application/octet-stream` otherwise. */
export function contentTypeFor(key: string): string {
  const ext = path.extname(key).toLowerCase();
  if (ext === '.gz' && key.toLowerCase().endsWith('.tar.gz')) {
    return 'application/gzip';
  }
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** Strong ETag of a local file: size + mtime (the same rule as `send`). */
export function localEtag(size: number, mtime: Date): string {
  return `"${size.toString(16)}-${mtime.getTime().toString(16)}"`;
}

export class LocalObjectStorage implements ObjectStorage {
  readonly driver = 'local' as const;
  readonly root: string;
  readonly keyPrefix: string;
  private readonly fileMode?: number;

  constructor(opts: LocalObjectStorageOptions) {
    this.root = path.resolve(opts.root);
    this.keyPrefix = opts.keyPrefix ?? '';
    if (this.keyPrefix && !this.keyPrefix.endsWith('/')) {
      throw new Error('LocalObjectStorage keyPrefix must end with "/"');
    }
    this.fileMode = opts.fileMode;
  }

  get location(): string {
    return this.root;
  }

  /** Validates the key (and prefix) and resolves it inside the root. */
  resolve(key: string): string {
    assertValidObjectKey(key);
    if (this.keyPrefix && !key.startsWith(this.keyPrefix)) {
      throw new InvalidObjectKeyError(key);
    }
    const rel = this.keyPrefix ? key.slice(this.keyPrefix.length) : key;
    if (!rel) throw new InvalidObjectKeyError(key);
    const full = path.resolve(this.root, ...rel.split('/'));
    const inside = path.relative(this.root, full);
    // Legacy folder names may start with dots (`....etc`); only a real
    // parent reference escapes the root.
    if (
      !inside ||
      inside === '..' ||
      inside.startsWith(`..${path.sep}`) ||
      path.isAbsolute(inside)
    ) {
      throw new InvalidObjectKeyError(key);
    }
    return full;
  }

  async put(
    key: string,
    body: Buffer | Readable,
    opts: PutObjectOptions,
  ): Promise<PutObjectResult> {
    void opts;
    const file = this.resolve(key);
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
    );
    const handle = await fs.open(tmp, 'wx', this.fileMode ?? 0o666);
    let size = 0;
    const hash = createHash('sha256');
    try {
      try {
        if (Buffer.isBuffer(body)) {
          await handle.writeFile(body);
          size = body.length;
          hash.update(body);
        } else {
          for await (const chunk of body) {
            const b = Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk as Uint8Array | string);
            await handle.write(b);
            size += b.length;
            hash.update(b);
          }
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, file);
    } catch (e) {
      await fs.unlink(tmp).catch(() => undefined);
      throw e;
    }
    const st = await fs.stat(file);
    return { etag: localEtag(st.size, st.mtime), size };
  }

  async head(key: string): Promise<ObjectHead | null> {
    const file = this.resolve(key);
    try {
      const st = await fs.stat(file);
      if (!st.isFile()) return null;
      return {
        size: st.size,
        etag: localEtag(st.size, st.mtime),
        lastModified: st.mtime,
        contentType: contentTypeFor(key),
        metadata: {},
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async get(key: string): Promise<ObjectBody | null> {
    const head = await this.head(key);
    if (!head) return null;
    return { ...head, stream: createReadStream(this.resolve(key)) };
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

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  /**
   * Walks the tree under `prefix` (sorted, depth first). Pagination is by
   * key: `continuationToken` is the last key of the previous page.
   */
  async list(
    prefix: string,
    opts: ListObjectsOptions = {},
  ): Promise<ListObjectsResult> {
    if (!isValidObjectPrefix(prefix)) throw new InvalidObjectKeyError(prefix);
    const max = opts.maxKeys && opts.maxKeys > 0 ? opts.maxKeys : 1000;
    const after = opts.continuationToken ?? '';
    const all: ListedObject[] = [];
    await this.walk(this.root, this.keyPrefix, async (key, st) => {
      if (!key.startsWith(prefix)) return;
      if (after && key <= after) return;
      all.push({
        key,
        size: st.size,
        etag: localEtag(st.size, st.mtime),
        lastModified: st.mtime,
      });
    });
    all.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const page = all.slice(0, max);
    return {
      objects: page,
      nextContinuationToken:
        all.length > max ? page[page.length - 1].key : undefined,
    };
  }

  private async walk(
    dir: string,
    keyBase: string,
    visit: (key: string, st: { size: number; mtime: Date }) => Promise<void>,
  ): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    for (const entry of entries) {
      // Temp files of in-flight writes are never listed.
      if (entry.name.startsWith('.') && entry.name.endsWith('.tmp')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(full, `${keyBase}${entry.name}/`, visit);
      } else if (entry.isFile()) {
        const st = await fs.stat(full);
        await visit(`${keyBase}${entry.name}`, st);
      }
    }
  }
}

/** A `Readable` over one buffer (for callers that need a stream body). */
export function bufferStream(buffer: Buffer): Readable {
  return Readable.from([buffer]);
}
