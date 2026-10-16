import { createHash } from 'crypto';
import type { Prisma } from '@prisma/client';
import { inspectRaster } from '../../../common/uploads/raster-inspect';
import type { PrivateStorage } from '../../../common/storage/private-file-storage';
import {
  SafeFetchError,
  type SafeFetchOptions,
  type SafeFetchResponse,
} from './safe-fetch';
import { SNIFFED_EXT, SNIFFED_MIME, sniffImage } from './sniff';

/**
 * Media download for one run (M4.4 §7, D8, D9): candidates in D9 order
 * (original → de-`-scaled` → as given; a 404 moves on), magic-byte sniffing,
 * sha256 dedupe per store, raster limits, then the public uploads pipeline
 * (WebP ≤ 2000 px, `uploads/imports/`) or private storage
 * (`importer/<store>/media/<sha>.<ext>`, template originals). The
 * `ImportMedia` ledger is unique on `(store_id, source_url)`.
 * A failed image never fails a run: it is reported and left out.
 */

export const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
export const MEDIA_MAX_PIXELS = 40_000_000;
export const MEDIA_CONCURRENCY = 4;
export const MEDIA_RUN_MAX_BYTES = 5 * 1024 * 1024 * 1024;

/** Env: per-store media byte quota over a rolling 24 h window (all runs). */
export const MEDIA_QUOTA_ENV = 'IMPORT_MEDIA_QUOTA_BYTES';
export const MEDIA_QUOTA_DEFAULT_BYTES = 2 * 1024 * 1024 * 1024;
const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Quota from `IMPORT_MEDIA_QUOTA_BYTES` (positive integer), else 2 GB. */
export function mediaQuotaBytes(
  env: Record<string, string | undefined> = process.env,
): number {
  const n = Number(env[MEDIA_QUOTA_ENV]);
  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : MEDIA_QUOTA_DEFAULT_BYTES;
}

/**
 * Decoder options for imported rasters: first frame only and an explicit
 * pixel cap, so an animated or oversized image cannot blow up sharp.
 */
export const IMPORT_DECODE_OPTS = {
  animated: false,
  limitInputPixels: MEDIA_MAX_PIXELS,
} as const;

export type MediaTarget = 'public' | 'private';

export interface MediaNeed {
  /** Normalized source URL (after alias rewrite); the ledger key. */
  source_url: string;
  /** Download candidates in D9 order. */
  candidates: string[];
  target: MediaTarget;
}

export interface StoredMedia {
  source_url: string;
  public_url: string | null;
  private_key: string | null;
  sha256: string;
  mime: string;
  width: number | null;
  height: number | null;
  /** True when this run downloaded it (false = reused). */
  created: boolean;
}

export interface MediaFetcher {
  get(url: string, opts: SafeFetchOptions): Promise<SafeFetchResponse>;
}

export interface PublicMediaWriter {
  storeBuffer(
    buffer: Buffer,
    ext: string,
    folder?: string,
    opts?: { animated?: boolean; limitInputPixels?: number },
  ): Promise<{ url: string }>;
}

export interface MediaImporterDeps {
  db: Prisma.TransactionClient;
  fetcher: MediaFetcher;
  uploads: PublicMediaWriter;
  storage: PrivateStorage;
  storeId: string;
  runId: string;
  /** Per-store media bytes per rolling 24 h; default `mediaQuotaBytes()`. */
  quotaBytes?: number;
}

export type MediaResult =
  | { ok: true; media: StoredMedia }
  | { ok: false; source_url: string; code: string; message: string };

export function privateMediaKey(
  storeId: string,
  sha: string,
  ext: string,
): string {
  return `importer/${storeId}/media/${sha}.${ext}`;
}

async function pool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

export class MediaImporter {
  private totalBytes = 0;
  /** Bytes the store downloaded in the last 24 h before this importer started. */
  private quotaBaseline: Promise<number> | null = null;

  constructor(private readonly deps: MediaImporterDeps) {}

  private quotaUsedBefore(): Promise<number> {
    this.quotaBaseline ??= this.deps.db.importMedia
      .aggregate({
        where: {
          store_id: this.deps.storeId,
          created_at: { gte: new Date(Date.now() - QUOTA_WINDOW_MS) },
        },
        _sum: { bytes: true },
      })
      .then((r) => r._sum.bytes ?? 0);
    return this.quotaBaseline;
  }

  /** True when the store's media quota (rolling 24 h) is used up. */
  private async overQuota(extra = 0): Promise<boolean> {
    const quota = this.deps.quotaBytes ?? mediaQuotaBytes();
    return (await this.quotaUsedBefore()) + this.totalBytes + extra > quota;
  }

  private quotaFailure(sourceUrl: string): MediaResult {
    return {
      ok: false,
      source_url: sourceUrl,
      code: 'IMPORT_MEDIA_QUOTA',
      message: 'Media quota of the store for the last 24 hours is used up',
    };
  }

  /** Downloads/reuses every need (4 at a time). Results keep the input order. */
  ensureAll(
    needs: MediaNeed[],
    concurrency = MEDIA_CONCURRENCY,
  ): Promise<MediaResult[]> {
    return pool(needs, concurrency, (n) => this.ensure(n));
  }

  /** Dry-run check (`verify_media`): the first 16 bytes of a candidate must be an allowed image. */
  async verifyAll(
    needs: MediaNeed[],
    concurrency = MEDIA_CONCURRENCY,
  ): Promise<{ source_url: string; ok: boolean; message?: string }[]> {
    return pool(needs, concurrency, async (need) => {
      let last = 'no candidate';
      for (const url of uniq(need.candidates)) {
        try {
          const res = await this.deps.fetcher.get(url, {
            maxBytes: 64 * 1024,
            accept: 'image/*',
            purpose: 'media',
            range: 'bytes=0-15',
          });
          if (res.status !== 200 && res.status !== 206) {
            last = `HTTP ${res.status}`;
            continue;
          }
          if (!sniffImage(res.body)) {
            last = 'not an allowed image type';
            continue;
          }
          return { source_url: need.source_url, ok: true };
        } catch (e) {
          last = (e as Error).message;
        }
      }
      return { source_url: need.source_url, ok: false, message: last };
    });
  }

  async ensure(need: MediaNeed): Promise<MediaResult> {
    const { db, storeId } = this.deps;
    const existing = await db.importMedia.findUnique({
      where: {
        store_id_source_url: { store_id: storeId, source_url: need.source_url },
      },
    });
    if (existing && hasTarget(existing, need.target)) {
      return { ok: true, media: toStored(existing, false) };
    }

    if (await this.overQuota()) return this.quotaFailure(need.source_url);

    let fetched: { body: Buffer; url: string } | null = null;
    let lastCode = 'IMPORT_MEDIA_FETCH_FAILED';
    let lastMessage = 'No candidate URL';
    for (const url of uniq(need.candidates)) {
      try {
        const res = await this.deps.fetcher.get(url, {
          maxBytes: MEDIA_MAX_BYTES,
          accept: 'image/*',
          purpose: 'media',
        });
        if (res.status !== 200) {
          lastCode = 'IMPORT_MEDIA_FETCH_FAILED';
          lastMessage = `HTTP ${res.status} for ${url}`;
          continue;
        }
        fetched = { body: res.body, url: res.url };
        break;
      } catch (e) {
        lastCode =
          e instanceof SafeFetchError ? e.code : 'IMPORT_MEDIA_FETCH_FAILED';
        lastMessage = (e as Error).message;
      }
    }
    if (!fetched) {
      return {
        ok: false,
        source_url: need.source_url,
        code: lastCode,
        message: lastMessage,
      };
    }

    const kind = sniffImage(fetched.body);
    if (!kind) {
      return {
        ok: false,
        source_url: need.source_url,
        code: 'IMPORT_MEDIA_TYPE',
        message: 'Not a JPEG, PNG, GIF or WebP image',
      };
    }
    if (await this.overQuota(fetched.body.length)) {
      return this.quotaFailure(need.source_url);
    }
    this.totalBytes += fetched.body.length;
    if (this.totalBytes > MEDIA_RUN_MAX_BYTES) {
      return {
        ok: false,
        source_url: need.source_url,
        code: 'IMPORT_MEDIA_TOO_LARGE',
        message: 'Media budget of the run exceeded (5 GB)',
      };
    }
    let info: { width: number; height: number };
    try {
      const r = await inspectRaster(fetched.body, {
        maxPixels: MEDIA_MAX_PIXELS,
        formats: ['jpeg', 'png', 'gif', 'webp'],
        allowAnimated: true,
      });
      // Animated bomb: the per-frame check above is not enough, every frame
      // counts (frames x width x height must stay under the cap).
      if (Math.max(1, r.pages) * r.width * r.height > MEDIA_MAX_PIXELS) {
        return {
          ok: false,
          source_url: need.source_url,
          code: 'IMPORT_MEDIA_TOO_LARGE',
          message: `Image has too many pixels over all frames (${r.pages} frames of ${r.width}x${r.height})`,
        };
      }
      info = r;
    } catch (e) {
      return {
        ok: false,
        source_url: need.source_url,
        code: 'IMPORT_MEDIA_TYPE',
        message: (e as Error).message,
      };
    }
    const sha = createHash('sha256').update(fetched.body).digest('hex');
    const mime = SNIFFED_MIME[kind];

    // Dedupe by content: another source URL may already hold these bytes.
    const twins = await db.importMedia.findMany({
      where: { store_id: storeId, sha256: sha },
    });
    let publicUrl = existing?.public_url ?? null;
    let privateKey = existing?.private_key ?? null;
    if (need.target === 'public' && !publicUrl) {
      publicUrl = twins.find((t) => t.public_url)?.public_url ?? null;
      if (!publicUrl) {
        // Raster input is re-encoded to WebP by the uploads pipeline (sharp
        // detects the real format, so GIF is passed with a raster extension).
        const ext = kind === 'gif' ? '.png' : `.${SNIFFED_EXT[kind]}`;
        publicUrl = (
          await this.deps.uploads.storeBuffer(
            fetched.body,
            ext,
            'imports',
            IMPORT_DECODE_OPTS,
          )
        ).url;
      }
    }
    if (need.target === 'private' && !privateKey) {
      privateKey = twins.find((t) => t.private_key)?.private_key ?? null;
      if (!privateKey) {
        privateKey = privateMediaKey(storeId, sha, SNIFFED_EXT[kind]);
        await this.deps.storage.write(privateKey, fetched.body);
      }
    }
    const data = {
      fetched_url: fetched.url.slice(0, 1024),
      sha256: sha,
      mime,
      bytes: fetched.body.length,
      width: info.width,
      height: info.height,
      public_url: publicUrl,
      private_key: privateKey,
    };
    const row = existing
      ? await db.importMedia.update({ where: { id: existing.id }, data })
      : await db.importMedia.create({
          data: {
            ...data,
            store_id: storeId,
            source_url: need.source_url,
            first_run_id: this.deps.runId,
          },
        });
    return { ok: true, media: toStored(row, true) };
  }
}

function uniq(list: string[]): string[] {
  return [...new Set(list.filter(Boolean))];
}

function hasTarget(
  row: { public_url: string | null; private_key: string | null },
  target: MediaTarget,
): boolean {
  return target === 'public' ? !!row.public_url : !!row.private_key;
}

function toStored(
  row: {
    source_url: string;
    public_url: string | null;
    private_key: string | null;
    sha256: string;
    mime: string;
    width: number | null;
    height: number | null;
  },
  created: boolean,
): StoredMedia {
  return {
    source_url: row.source_url,
    public_url: row.public_url,
    private_key: row.private_key,
    sha256: row.sha256,
    mime: row.mime,
    width: row.width,
    height: row.height,
    created,
  };
}
