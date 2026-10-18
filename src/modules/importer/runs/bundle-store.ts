import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import type { Request } from 'express';
import type { StorageEngine } from 'multer';
import * as path from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import type { PrivateStorage } from '../../../common/storage/private-file-storage';
import {
  BUNDLE_DEFAULT_MAX_FILE_BYTES,
  BundleReadError,
  DirectoryBundleReader,
  type BundleReader,
} from '../adapters/bundle-reader';
import { extractArchive, isArchiveName } from '../adapters/archive-bundle';
import { isAllowedBundleFile } from '../adapters/wp-bundle/bundle-schema';
import type { NormalizedCatalog } from '../model/normalized';
import { importError } from '../importer.errors';

/**
 * Bundle upload: the merchant uploads either ONE archive (`file`: the
 * `.tgz` the export script wrote, or a `.zip`) or the extracted bundle
 * files themselves (`files`, allowlisted names only, §2.1). An archive is
 * expanded in memory by `extractArchive` (§9.3 limits) inside
 * `validateBundleFiles`, so everything after it sees plain files: they are
 * kept in private storage under `importer/<storeId>/bundles/<runId>/<name>`
 * with an `index.json` listing them; `StorageBundleReader` serves them to
 * the WordPress adapter.
 */

/**
 * Upload cap, 50 MB in total. In practice that is a catalog of about 3 000
 * products (`postmeta.tsv` dominates: ~15 KB per product with its
 * variations, images and personalization meta). Larger catalogs — up to the
 * `CATALOG_LIMITS` of 20 000 products — go through the admin from-directory
 * run (`BUNDLE_DIR_MAX_BYTES`, 200 MB), which reads from the server disk
 * and never passes through nginx (M5 B14).
 */
export const BUNDLE_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
/** Per-file multipart limit (multer `fileSize`); the request total is capped separately. */
export const BUNDLE_UPLOAD_MAX_FILE_BYTES = 40 * 1024 * 1024;
/** Admin from-directory bundles: 200 MB in total, 160 MB per file (M5 B14). */
export const BUNDLE_DIR_MAX_BYTES = 200 * 1024 * 1024;
export const BUNDLE_DIR_MAX_FILE_BYTES = 160 * 1024 * 1024;
export const BUNDLE_MAX_FILES = 64;
const INDEX_NAME = 'index.json';
/** Anything archive-like; only `.zip` / `.tgz` / `.tar.gz` are then accepted. */
const ARCHIVE_LIKE_RE = /\.(zip|tgz|tar\.gz|gz|tar|rar|7z)$/i;

export interface BundleLimits {
  maxTotalBytes?: number;
  maxFileBytes?: number;
}

export interface UploadedBundleFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/** Per-request byte counter kept on the request by `boundedBundleStorage`. */
const TOTAL_KEY = Symbol('importerBundleUploadBytes');
type CountedRequest = Request & { [TOTAL_KEY]?: number };

/**
 * Multer storage engine that buffers files in memory like `memoryStorage()`
 * but enforces the bundle total WHILE streaming: as soon as the bytes of all
 * files of the request exceed `maxTotalBytes`, the file stream is discarded
 * and the upload aborts with 413 IMPORT_BUNDLE_TOO_LARGE (multer then drains
 * the rest of the body without keeping it). Never holds more than
 * `maxTotalBytes` (+ one chunk) per request.
 */
export function boundedBundleStorage(
  maxTotalBytes: number = BUNDLE_UPLOAD_MAX_BYTES,
): StorageEngine {
  return {
    _handleFile(req, file, cb) {
      const r = req as CountedRequest;
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      const stream = file.stream;
      const fail = (err: Error) => {
        if (failed) return;
        failed = true;
        chunks.length = 0;
        stream.removeAllListeners('data');
        stream.resume();
        cb(err);
      };
      stream.on('data', (chunk: Buffer) => {
        if (failed) return;
        const total = (r[TOTAL_KEY] ?? 0) + chunk.length;
        r[TOTAL_KEY] = total;
        if (total > maxTotalBytes) {
          fail(
            importError(
              'IMPORT_BUNDLE_TOO_LARGE',
              `The bundle is larger than ${Math.round(maxTotalBytes / (1024 * 1024))} MB`,
            ),
          );
          return;
        }
        size += chunk.length;
        chunks.push(chunk);
      });
      stream.on('error', (e: Error) => fail(e));
      stream.on('end', () => {
        if (failed) return;
        const buffer = Buffer.concat(chunks, size);
        cb(null, { buffer, size } as Partial<Express.Multer.File>);
      });
    },
    _removeFile(_req, file, cb) {
      (file as Partial<Express.Multer.File>).buffer = undefined;
      cb(null);
    },
  };
}

export interface StoredBundle {
  bundle_key: string;
  bundle_sha256: string;
  bundle_bytes: number;
  files: string[];
}

interface BundleIndex {
  files: { name: string; key: string; sha256: string; bytes: number }[];
}

export function bundleDir(storeId: string, runId: string): string {
  return `importer/${storeId}/bundles/${runId}`;
}

export function snapshotKey(storeId: string, runId: string): string {
  return `importer/${storeId}/snapshots/${runId}.json.gz`;
}

/** Name of an uploaded file as stored (base name, lower case). */
function baseName(name: string): string {
  return (name ?? '').split(/[\\/]/).pop()!.trim().toLowerCase();
}

/**
 * One archive (`.zip` / `.tgz` / `.tar.gz`) → its allowlisted entries as
 * plain bundle files. An archive next to other files, or two archives, is
 * refused: the client sends ONE archive or the extracted files.
 */
export function expandBundleArchives(
  files: UploadedBundleFile[],
  limits: BundleLimits = {},
): UploadedBundleFile[] {
  const archives = files.filter((f) =>
    ARCHIVE_LIKE_RE.test(f.originalname ?? ''),
  );
  if (!archives.length) return files;
  if (archives.length > 1 || files.length > 1) {
    throw importError(
      'IMPORT_BUNDLE_UNEXPECTED_FILE',
      'Upload one archive, or the extracted bundle files, not both',
      { file: baseName(archives[0].originalname) },
    );
  }
  const archive = archives[0];
  const name = baseName(archive.originalname);
  if (!isArchiveName(name)) {
    throw importError(
      'IMPORT_BUNDLE_INVALID_ARCHIVE',
      'Only .zip, .tgz and .tar.gz archives are accepted',
      { file: name },
    );
  }
  try {
    const extracted = extractArchive(archive.buffer, name, {
      maxTotalBytes: limits.maxTotalBytes ?? BUNDLE_UPLOAD_MAX_BYTES,
      maxEntries: BUNDLE_MAX_FILES,
    });
    return extracted.entries.map((e) => ({
      originalname: e.name,
      buffer: e.buffer,
      size: e.buffer.length,
    }));
  } catch (e) {
    if (e instanceof BundleReadError)
      throw importError(e.code, e.message, { file: name });
    throw e;
  }
}

/**
 * Upload checks: an archive is expanded first (`expandBundleArchives`),
 * then allowlisted names, no duplicates, ≤ 64 files, ≤ `maxFileBytes` per
 * file and ≤ `maxTotalBytes` in total (50 MB / 40 MB for uploads; 200 MB /
 * 160 MB for admin directory bundles). Returns the plain bundle files.
 */
export function validateBundleFiles(
  input: UploadedBundleFile[],
  limits: number | BundleLimits = {},
): Promise<UploadedBundleFile[]> {
  try {
    return Promise.resolve(validateBundleFilesSync(input, limits));
  } catch (e) {
    return Promise.reject(e as Error);
  }
}

function validateBundleFilesSync(
  input: UploadedBundleFile[],
  limits: number | BundleLimits,
): UploadedBundleFile[] {
  const l: BundleLimits =
    typeof limits === 'number' ? { maxTotalBytes: limits } : limits;
  const maxTotalBytes = l.maxTotalBytes ?? BUNDLE_UPLOAD_MAX_BYTES;
  const maxFileBytes =
    l.maxFileBytes ??
    (maxTotalBytes > BUNDLE_UPLOAD_MAX_BYTES
      ? BUNDLE_DIR_MAX_FILE_BYTES
      : BUNDLE_UPLOAD_MAX_FILE_BYTES);
  if (!input.length) {
    throw importError(
      'IMPORT_BUNDLE_MISSING_FILE',
      'Upload the files of the export bundle',
    );
  }
  const files = expandBundleArchives(input, { maxTotalBytes });
  if (files.length > BUNDLE_MAX_FILES) {
    throw importError(
      'IMPORT_BUNDLE_UNEXPECTED_FILE',
      `At most ${BUNDLE_MAX_FILES} files`,
    );
  }
  const seen = new Set<string>();
  let total = 0;
  for (const f of files) {
    const name = baseName(f.originalname);
    if (!isAllowedBundleFile(name)) {
      throw importError(
        'IMPORT_BUNDLE_UNEXPECTED_FILE',
        `File not allowed in a bundle: ${name}`,
        { file: name },
      );
    }
    if (seen.has(name)) {
      throw importError(
        'IMPORT_BUNDLE_UNEXPECTED_FILE',
        `Duplicate file: ${name}`,
        { file: name },
      );
    }
    seen.add(name);
    if (f.buffer.length > maxFileBytes) {
      throw importError(
        'IMPORT_BUNDLE_TOO_LARGE',
        `Bundle file larger than ${Math.round(maxFileBytes / (1024 * 1024))} MB: ${name}`,
        { file: name },
      );
    }
    total += f.buffer.length;
  }
  if (total > maxTotalBytes) {
    throw importError(
      'IMPORT_BUNDLE_TOO_LARGE',
      `The bundle is larger than ${Math.round(maxTotalBytes / (1024 * 1024))} MB`,
    );
  }
  if (!seen.has('posts.tsv') || !seen.has('postmeta.tsv')) {
    throw importError(
      'IMPORT_BUNDLE_MISSING_FILE',
      'posts.tsv and postmeta.tsv are required',
    );
  }
  return files;
}

export async function storeBundleFiles(
  storage: PrivateStorage,
  storeId: string,
  runId: string,
  files: UploadedBundleFile[],
): Promise<StoredBundle> {
  const dir = bundleDir(storeId, runId);
  const index: BundleIndex = { files: [] };
  for (const f of files) {
    const name = baseName(f.originalname);
    const key = `${dir}/${name}`;
    await storage.write(key, f.buffer);
    index.files.push({
      name,
      key,
      sha256: createHash('sha256').update(f.buffer).digest('hex'),
      bytes: f.buffer.length,
    });
  }
  index.files.sort((a, b) => (a.name < b.name ? -1 : 1));
  const indexKey = `${dir}/${INDEX_NAME}`;
  await storage.write(indexKey, Buffer.from(JSON.stringify(index)));
  return {
    bundle_key: indexKey,
    bundle_sha256: createHash('sha256')
      .update(index.files.map((f) => `${f.name}:${f.sha256}`).join('\n'))
      .digest('hex'),
    bundle_bytes: index.files.reduce((n, f) => n + f.bytes, 0),
    files: index.files.map((f) => f.name),
  };
}

async function readIndex(
  storage: PrivateStorage,
  indexKey: string,
): Promise<BundleIndex> {
  const buf = await storage.read(indexKey);
  if (!buf)
    throw new BundleReadError(
      'IMPORT_BUNDLE_MISSING_FILE',
      'The bundle files are gone',
    );
  return JSON.parse(buf.toString('utf8')) as BundleIndex;
}

/** BundleReader over the uploaded files in private storage. */
export class StorageBundleReader implements BundleReader {
  private index: BundleIndex | null = null;

  constructor(
    private readonly storage: PrivateStorage,
    private readonly indexKey: string,
  ) {}

  private async files(): Promise<BundleIndex['files']> {
    this.index ??= await readIndex(this.storage, this.indexKey);
    return this.index.files.filter((f) => isAllowedBundleFile(f.name));
  }

  async list(): Promise<string[]> {
    return (await this.files()).map((f) => f.name).sort();
  }

  async has(name: string): Promise<boolean> {
    return (await this.files()).some((f) => f.name === name);
  }

  async readText(
    name: string,
    opts: { maxBytes?: number } = {},
  ): Promise<string> {
    const entry = (await this.files()).find((f) => f.name === name);
    if (!entry)
      throw new BundleReadError(
        'IMPORT_BUNDLE_MISSING_FILE',
        `Missing bundle file: ${name}`,
      );
    if (entry.bytes > (opts.maxBytes ?? BUNDLE_DEFAULT_MAX_FILE_BYTES))
      throw new BundleReadError(
        'IMPORT_BUNDLE_TOO_LARGE',
        `Bundle file too large: ${name}`,
      );
    const buf = await this.storage.read(entry.key);
    if (!buf)
      throw new BundleReadError(
        'IMPORT_BUNDLE_MISSING_FILE',
        `Missing bundle file: ${name}`,
      );
    const s = buf.toString('utf8');
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  }
}

/** Deletes the uploaded files and the index (retention, run delete). */
export async function deleteBundle(
  storage: PrivateStorage,
  indexKey: string,
): Promise<number> {
  let n = 0;
  try {
    const index = await readIndex(storage, indexKey);
    for (const f of index.files) if (await storage.delete(f.key)) n++;
  } catch {
    // Index already gone: nothing else to remove.
  }
  if (await storage.delete(indexKey).catch(() => false)) n++;
  return n;
}

export async function saveCatalogSnapshot(
  storage: PrivateStorage,
  key: string,
  catalog: NormalizedCatalog,
): Promise<void> {
  await storage.write(
    key,
    gzipSync(Buffer.from(JSON.stringify(catalog), 'utf8')),
  );
}

export async function loadCatalogSnapshot(
  storage: PrivateStorage,
  key: string,
): Promise<NormalizedCatalog> {
  const buf = await storage.read(key);
  if (!buf)
    throw new BundleReadError(
      'IMPORT_BUNDLE_MISSING_FILE',
      'The catalog snapshot is gone',
    );
  return JSON.parse(gunzipSync(buf).toString('utf8')) as NormalizedCatalog;
}

export const BUNDLE_DIR_ROOT_ENV = 'IMPORTER_BUNDLE_DIR_ROOT';

/** Relative bundle directory names only: `[\w.\-/]`, no leading `/`, no `..` segment. */
export const BUNDLE_DIR_NAME_RE =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w.\-/]{1,500}$/;

/**
 * Checked BEFORE any path resolution: absolute, UNC (`\\host\share`),
 * drive-letter (`C:`) and parent-relative input is refused outright.
 */
export function isRelativeBundleDirName(directory: unknown): boolean {
  return typeof directory === 'string' && BUNDLE_DIR_NAME_RE.test(directory);
}

/**
 * Allowlisted files of an extracted bundle directory on the server, or the
 * one archive (`.tgz` / `.tar.gz` / `.zip`) given instead of a directory
 * (returned as a single file for `validateBundleFiles` to expand under the
 * same total). The path must resolve inside `IMPORTER_BUNDLE_DIR_ROOT`;
 * unset = refused. The directory limits (160 MB per file, 200 MB in total;
 * M5 B14) are checked from `lstat` sizes BEFORE any file is read into memory.
 */
export async function readBundleDirectory(
  directory: string,
  limits: { maxFileBytes?: number; maxTotalBytes?: number } = {},
): Promise<UploadedBundleFile[]> {
  const maxFileBytes = limits.maxFileBytes ?? BUNDLE_DIR_MAX_FILE_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? BUNDLE_DIR_MAX_BYTES;
  if (!isRelativeBundleDirName(directory)) {
    throw importError(
      'IMPORT_BUNDLE_MISSING_FILE',
      'Give the bundle directory as a relative name below the server bundle root',
    );
  }
  const rootEnv = process.env[BUNDLE_DIR_ROOT_ENV];
  if (!rootEnv) {
    throw importError(
      'IMPORT_BUNDLE_MISSING_FILE',
      `Server bundles are disabled (${BUNDLE_DIR_ROOT_ENV} is not set)`,
    );
  }
  const root = await fs.realpath(path.resolve(rootEnv)).catch(() => null);
  const dir = await fs
    .realpath(path.resolve(root ?? rootEnv, directory))
    .catch(() => null);
  const rel = root && dir ? path.relative(root, dir) : '..';
  if (!root || !dir || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw importError(
      'IMPORT_BUNDLE_MISSING_FILE',
      'Bundle directory not found below the server bundle root',
    );
  }
  const target = await fs.lstat(dir);
  if (target.isFile()) {
    const name = path.basename(dir);
    if (!isArchiveName(name)) {
      throw importError(
        'IMPORT_BUNDLE_INVALID_ARCHIVE',
        'Give a bundle directory or a .tgz / .tar.gz / .zip archive',
        { file: name },
      );
    }
    if (target.size > maxTotalBytes) {
      throw importError(
        'IMPORT_BUNDLE_TOO_LARGE',
        `The archive is larger than ${Math.round(maxTotalBytes / (1024 * 1024))} MB`,
        { file: name },
      );
    }
    const buffer = await fs.readFile(dir);
    return [{ originalname: name, buffer, size: buffer.length }];
  }
  const reader = new DirectoryBundleReader(dir);
  const names = await reader.list();
  let total = 0;
  for (const name of names) {
    const st = await fs.lstat(path.join(dir, name));
    if (st.size > maxFileBytes) {
      throw importError(
        'IMPORT_BUNDLE_TOO_LARGE',
        `Bundle file larger than ${Math.round(maxFileBytes / (1024 * 1024))} MB: ${name}`,
        { file: name },
      );
    }
    total += st.size;
    if (total > maxTotalBytes) {
      throw importError(
        'IMPORT_BUNDLE_TOO_LARGE',
        `The bundle is larger than ${Math.round(maxTotalBytes / (1024 * 1024))} MB`,
      );
    }
  }
  const out: UploadedBundleFile[] = [];
  for (const name of names) {
    const text = await reader.readText(name, { maxBytes: maxFileBytes });
    const buffer = Buffer.from(text, 'utf8');
    out.push({ originalname: name, buffer, size: buffer.length });
  }
  return out;
}
