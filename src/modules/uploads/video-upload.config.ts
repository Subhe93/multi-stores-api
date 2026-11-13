/**
 * Product video upload settings (plans/product-video/CONTRACT.md §4.1).
 * Every value is read from the environment at call time, so a restart with
 * a changed env (kill switch `PRODUCT_VIDEO_UPLOADS=0`) takes effect without
 * a deploy, and tests can flip them per case.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Business limit of videos per product (files and links together). */
export const PRODUCT_VIDEO_MAX_PER_PRODUCT = 3;

/** The only stored video type. */
export const VIDEO_CONTENT_TYPE = 'video/mp4';

/**
 * Folder of video posters (the frame the dashboard captures, a replaced
 * cover image, YouTube / Vimeo thumbnails). Kept apart from product images
 * so the orphan sweep can reclaim the posters of removed or abandoned
 * videos without touching product images.
 */
export const VIDEO_POSTER_FOLDER = 'video-posters';

/** Folders a role may upload videos into (ADMIN included). */
export const VIDEO_FOLDERS_BY_ROLE: Readonly<
  Record<UserRole, readonly string[]>
> = {
  [UserRole.ADMIN]: ['products'],
  [UserRole.CREATOR]: ['products'],
  [UserRole.PROVIDER]: ['products'],
  [UserRole.CUSTOMER]: [],
};

/** True when `role` may upload a video into `folder` (already sanitized). */
export function videoFolderAllowedForRole(
  role: UserRole,
  folder: string,
): boolean {
  return (VIDEO_FOLDERS_BY_ROLE[role] ?? []).includes(folder);
}

/**
 * Multipart framing around the file part (boundaries, part headers, the
 * folder field). The Content-Length pre-check allows this much on top of
 * the file limit so a file of exactly the limit is not refused early.
 */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** Bitrate is only checked above this size (tiny clips may spike). */
export const BITRATE_CHECK_MIN_BYTES = 4 * 1024 * 1024;

/** Temp files older than this are removed by the temp sweep. */
export const VIDEO_TMP_MAX_AGE_MS = 60 * 60 * 1000;

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envOff(name: string): boolean {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  return v === '0' || v === 'off' || v === 'false';
}

export interface VideoUploadConfig {
  /** `PRODUCT_VIDEO_UPLOADS` (default on; `'0'` disables uploads). */
  uploadsEnabled: boolean;
  maxBytes: number;
  maxSeconds: number;
  maxKbps: number;
  minFreeBytes: number;
  storeQuotaBytes: number;
  tmpDir: string;
  sweepEnabled: boolean;
}

export function videoUploadConfig(): VideoUploadConfig {
  const tmpRaw = (process.env.UPLOAD_VIDEO_TMP_DIR ?? '').trim();
  return {
    uploadsEnabled: !envOff('PRODUCT_VIDEO_UPLOADS'),
    maxBytes: envInt('UPLOAD_VIDEO_MAX_BYTES', 52_428_800),
    maxSeconds: envInt('PRODUCT_VIDEO_MAX_SECONDS', 60),
    maxKbps: envInt('PRODUCT_VIDEO_MAX_KBPS', 8000),
    minFreeBytes: envInt('PRODUCT_VIDEO_MIN_FREE_BYTES', 1_610_612_736),
    storeQuotaBytes: envInt('PRODUCT_VIDEO_STORE_QUOTA_BYTES', 314_572_800),
    tmpDir: path.resolve(tmpRaw || path.join(os.tmpdir(), 'ms-video-uploads')),
    sweepEnabled: !envOff('PRODUCT_VIDEO_SWEEP'),
  };
}

export const bytesToMbRounded = (bytes: number): number =>
  Math.round((bytes / (1024 * 1024)) * 10) / 10;

// ── Coded errors shared by the interceptor and the service ─────────────────

export function videoUploadsDisabled(): HttpException {
  return new HttpException(
    {
      code: 'PRODUCT_VIDEO_UPLOADS_DISABLED',
      message: 'Video uploads are currently disabled',
    },
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}

export function videoTooLarge(maxBytes: number): HttpException {
  return new HttpException(
    {
      code: 'UPLOAD_VIDEO_TOO_LARGE',
      message: `Video too large (max ${bytesToMbRounded(maxBytes)} MB)`,
      maxBytes,
      params: { max_mb: bytesToMbRounded(maxBytes) },
    },
    HttpStatus.PAYLOAD_TOO_LARGE,
  );
}

export function videoDiskLow(): HttpException {
  return new HttpException(
    {
      code: 'UPLOAD_VIDEO_DISK_LOW',
      message: 'Video uploads are temporarily unavailable (storage is full)',
    },
    HttpStatus.INSUFFICIENT_STORAGE,
  );
}

export function videoQuotaExceeded(
  quotaBytes: number,
  usedBytes: number,
): HttpException {
  return new HttpException(
    {
      code: 'UPLOAD_VIDEO_QUOTA_EXCEEDED',
      message: 'The video storage quota of this store is used up',
      quotaBytes,
      usedBytes,
    },
    HttpStatus.FORBIDDEN,
  );
}

export function videoFolderForbidden(folder: string): HttpException {
  return new HttpException(
    {
      code: 'UPLOAD_FOLDER_FORBIDDEN',
      message: `Video uploads to "${folder}" are not allowed for your account`,
    },
    HttpStatus.FORBIDDEN,
  );
}

export function videoTypeError(
  reason: 'extension' | 'quicktime' | 'not_mp4',
): HttpException {
  return new HttpException(
    {
      code: 'UPLOAD_VIDEO_TYPE',
      message:
        reason === 'quicktime'
          ? 'QuickTime (.mov) files are not supported; export the video as MP4 (H.264)'
          : 'Only MP4 (H.264) videos are supported',
      reason,
    },
    HttpStatus.BAD_REQUEST,
  );
}

// ── Free-disk guard ─────────────────────────────────────────────────────────

/** `fs.promises.statfs` shape (injectable for tests). */
export type StatfsFn = (
  dir: string,
) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

/**
 * Free bytes (unprivileged) on the disk holding `dir`, walking up to the
 * nearest existing parent. Throws when the disk cannot be read (including a
 * Node without `fs.promises.statfs`): the caller fails closed.
 */
export async function videoFreeBytes(
  dir: string,
  statfs: StatfsFn | undefined = (fs as { statfs?: StatfsFn }).statfs,
): Promise<number> {
  if (typeof statfs !== 'function') {
    throw new Error('fs.promises.statfs is not available (Node >= 18.15)');
  }
  let current = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    try {
      const st = await statfs(current);
      return Number(st.bavail) * Number(st.bsize);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const parent = path.dirname(current);
      if (parent === current) throw e;
      current = parent;
    }
  }
  throw new Error(`No existing parent directory for ${dir}`);
}

/**
 * Refuses (507 `UPLOAD_VIDEO_DISK_LOW`) when any of `dirs` would keep less
 * than `minFreeBytes` after writing `incomingBytes`, or when its disk cannot
 * be read (fail closed).
 */
export async function assertVideoDiskSpace(
  dirs: readonly string[],
  incomingBytes: number,
  minFreeBytes: number,
  statfs?: StatfsFn,
): Promise<void> {
  for (const dir of dirs) {
    let free: number;
    try {
      free = await videoFreeBytes(dir, statfs);
    } catch {
      throw videoDiskLow();
    }
    if (free - Math.max(0, incomingBytes) < minFreeBytes) throw videoDiskLow();
  }
}
