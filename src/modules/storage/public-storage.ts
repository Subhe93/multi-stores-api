/**
 * Public media (`/uploads/<folder>/<file>`) over `MEDIA_STORAGE`.
 *
 * The object key is exactly today's relative URL minus the leading slash
 * (`uploads/<folder>/<file>`; `template-imports` adds one `<storeId>`
 * segment). Writers (UploadsService, kit assets, email logo PNG) call `put`,
 * readers (invoice logo, email logo) `openRead`/`read`, deletes `delete`, and
 * the s3-mode serving handler `getForServing`. Every URL is checked against
 * the public key shape, so a crafted URL can never reach another object.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import * as path from 'path';
import type { Readable } from 'stream';
import { contentTypeFor, LocalObjectStorage } from './local-object-storage';
import type {
  DeleteObjectResult,
  ObjectBody,
  ObjectHead,
  ObjectStorage,
  PutObjectOptions,
} from './object-storage';
import { MEDIA_STORAGE, STORAGE_CONFIG } from './storage.tokens';
import type { StorageConfig } from './storage.config';

/** Folder of the customer upload previews (1-day cache, noindex). */
export const CUSTOMER_PREVIEWS_FOLDER = 'customer-previews';

export const MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const PREVIEW_CACHE_CONTROL = 'public, max-age=86400';

const SEGMENT = /^[A-Za-z0-9._-]{1,255}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.[A-Za-z0-9]{1,16}$/;

export interface PublicPutOptions {
  contentType?: string;
}

export interface PublicPutResult {
  url: string;
  key: string;
  size: number;
}

/** One public media object ready to be served (headers + stream). */
export type PublicObject = ObjectBody;

/**
 * `uploads/<folder>/<file>` or `uploads/<folder>/<sub>/<file>` (template
 * imports): 2 or 3 safe segments after `uploads/`, the last one with an
 * extension; never `.`/`..`.
 */
export function isPublicMediaKey(key: unknown): key is string {
  if (typeof key !== 'string' || !key.startsWith('uploads/')) return false;
  const parts = key.slice('uploads/'.length).split('/');
  if (parts.length < 2 || parts.length > 3) return false;
  const file = parts[parts.length - 1];
  if (!FILE.test(file)) return false;
  return parts.slice(0, -1).every((p) => SEGMENT.test(p) && !/^\.+$/.test(p));
}

/**
 * Object key of a public media URL: `/uploads/...` (relative, with or without
 * the leading slash) or an absolute URL whose path is `/uploads/...` (any
 * host; the DB holds absolute API-host URLs). Percent-encoding is decoded
 * once. Anything else, or a key outside the public shape, → null.
 */
export function publicMediaKeyFromUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  let pathname = url.trim();
  if (!pathname) return null;
  if (/^https?:\/\//i.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      return null;
    }
  }
  pathname = pathname.split(/[?#]/, 1)[0];
  if (pathname.includes('\\')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const key = decoded.replace(/^\/+/, '');
  return isPublicMediaKey(key) ? key : null;
}

/** Cache-Control + headers rule of a public key (same as today's static serving). */
export function publicObjectHeaders(key: string): {
  cacheControl: string;
  contentDisposition?: string;
  robots?: string;
} {
  const preview = key.startsWith(`uploads/${CUSTOMER_PREVIEWS_FOLDER}/`);
  const svg = key.toLowerCase().endsWith('.svg');
  return {
    cacheControl: preview ? PREVIEW_CACHE_CONTROL : MEDIA_CACHE_CONTROL,
    ...(svg ? { contentDisposition: 'attachment' } : {}),
    ...(preview ? { robots: 'noindex' } : {}),
  };
}

@Injectable()
export class PublicStorage {
  constructor(
    @Inject(MEDIA_STORAGE) readonly store: ObjectStorage,
    @Optional() @Inject(STORAGE_CONFIG) private readonly config?: StorageConfig,
  ) {}

  /** A local-disk instance rooted at `<uploadsDir>` (tests, lean wiring). */
  static local(uploadsDir: string): PublicStorage {
    return new PublicStorage(
      new LocalObjectStorage({ root: uploadsDir, keyPrefix: 'uploads/' }),
    );
  }

  /** Local-disk instance at `<cwd>/uploads` (the pre-S3 default). */
  static localDefault(): PublicStorage {
    return PublicStorage.local(path.join(process.cwd(), 'uploads'));
  }

  /** `local` when files are written to disk, `s3` otherwise. */
  get driver(): 'local' | 's3' {
    return this.store.driver;
  }

  /**
   * Absolute directory of a folder on disk in local mode, or null in s3
   * mode (callers skip free-disk checks then).
   */
  localDir(folder: string): string | null {
    if (!(this.store instanceof LocalObjectStorage)) return null;
    const safe = sanitizeFolder(folder);
    return path.join(this.store.root, safe);
  }

  keyFor(folder: string, file: string): string {
    const key = `uploads/${sanitizeFolderPath(folder)}/${file}`;
    if (!isPublicMediaKey(key)) {
      throw new Error(`Invalid public media name: ${JSON.stringify(file)}`);
    }
    return key;
  }

  urlFor(key: string): string {
    return `/${key}`;
  }

  /** Writes `uploads/<folder>/<file>` and returns its relative URL. */
  async put(
    folder: string,
    file: string,
    body: Buffer,
    opts: PublicPutOptions = {},
  ): Promise<PublicPutResult> {
    const key = this.keyFor(folder, file);
    const headers = publicObjectHeaders(key);
    const putOpts: PutObjectOptions = {
      contentType: opts.contentType ?? contentTypeFor(key),
      cacheControl: headers.cacheControl,
      sse: 's3',
    };
    if (headers.contentDisposition) {
      putOpts.contentDisposition = headers.contentDisposition;
    }
    const out = await this.store.put(key, body, putOpts);
    return { url: this.urlFor(key), key, size: out.size };
  }

  /**
   * Moves a finished temp file into `uploads/<folder>/<file>` without
   * loading it into memory (product videos). Local disk: `rename` (atomic),
   * falling back to copy + rename + unlink across file systems (`EXDEV`).
   * S3: a streamed multipart upload with one part in flight. The temp file
   * is gone after a local move; on S3 the caller still removes it.
   */
  async putFile(
    folder: string,
    file: string,
    tempPath: string,
    contentType: string,
  ): Promise<PublicPutResult> {
    const key = this.keyFor(folder, file);
    if (this.store instanceof LocalObjectStorage) {
      const target = this.store.resolve(key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      try {
        await fs.rename(tempPath, target);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
        // Different file system: copy next to the target, then rename so a
        // reader never sees a half-written file.
        const staging = path.join(
          path.dirname(target),
          `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
        );
        try {
          await fs.copyFile(tempPath, staging);
          await fs.rename(staging, target);
        } catch (err) {
          await fs.unlink(staging).catch(() => undefined);
          throw err;
        }
        await fs.unlink(tempPath).catch(() => undefined);
      }
      const st = await fs.stat(target);
      return { url: this.urlFor(key), key, size: st.size };
    }
    const headers = publicObjectHeaders(key);
    const size = (await fs.stat(tempPath)).size;
    const putOpts: PutObjectOptions = {
      contentType,
      cacheControl: headers.cacheControl,
      sse: 's3',
      contentLength: size,
      multipartQueueSize: 1,
    };
    if (headers.contentDisposition) {
      putOpts.contentDisposition = headers.contentDisposition;
    }
    const out = await this.store.put(key, createReadStream(tempPath), putOpts);
    return { url: this.urlFor(key), key, size: out.size };
  }

  /**
   * Deletes the object behind a public URL. `deleted: false` with a reason
   * when it did not exist or S3 refused (`denied`: logged once, never thrown).
   */
  async delete(url: string): Promise<DeleteObjectResult> {
    const key = publicMediaKeyFromUrl(url);
    if (!key) throw new InvalidPublicUrlError(url);
    return this.store.delete(key);
  }

  async exists(url: string): Promise<boolean> {
    const key = publicMediaKeyFromUrl(url);
    if (!key) return false;
    return this.store.exists(key);
  }

  async head(url: string): Promise<ObjectHead | null> {
    const key = publicMediaKeyFromUrl(url);
    if (!key) return null;
    return this.store.head(key);
  }

  /** The object behind a public URL as a stream, or null. */
  async openRead(url: string): Promise<PublicObject | null> {
    const key = publicMediaKeyFromUrl(url);
    if (!key) return null;
    return this.store.get(key);
  }

  /** Whole object in memory (small files: logos), or null. `maxBytes` guards memory. */
  async read(url: string, maxBytes?: number): Promise<Buffer | null> {
    const obj = await this.openRead(url);
    if (!obj) return null;
    if (maxBytes !== undefined && obj.size > maxBytes) {
      obj.stream.destroy();
      return null;
    }
    return readAll(obj.stream, maxBytes);
  }

  /** Serving path (s3 mode): the object of an already validated key, or null. */
  async getForServing(key: string): Promise<PublicObject | null> {
    if (!isPublicMediaKey(key)) return null;
    return this.store.get(key);
  }

  /** Absolute URL for emails/feeds when a base is configured, else the relative one. */
  absoluteUrl(url: string): string {
    const base = this.config?.mediaBaseUrl;
    if (!base || /^https?:\/\//i.test(url)) return url;
    return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
  }
}

export class InvalidPublicUrlError extends Error {
  constructor(url: unknown) {
    super(`Invalid public upload URL: ${JSON.stringify(url)}`);
    this.name = 'InvalidPublicUrlError';
  }
}

/** Same rule as `UploadsService.sanitizeFolder`: one safe segment, else `general`. */
export function sanitizeFolder(folder: string): string {
  const segment = (folder || '').trim().replace(/[^a-zA-Z0-9._-]/g, '');
  if (!segment || /^\.+$/.test(segment)) return 'general';
  return segment;
}

/** `folder` or `folder/sub` (kit assets: `template-imports/<storeId>`), each segment sanitized. */
export function sanitizeFolderPath(folder: string): string {
  const parts = (folder || '').split('/').filter((p) => p.trim() !== '');
  if (parts.length === 0) return 'general';
  return parts.slice(0, 2).map(sanitizeFolder).join('/');
}

async function readAll(
  stream: Readable,
  maxBytes?: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += b.length;
    if (maxBytes !== undefined && total > maxBytes) {
      stream.destroy();
      return null;
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
