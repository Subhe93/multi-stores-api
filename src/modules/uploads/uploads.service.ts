import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { PrismaService } from '../../prisma/prisma.service';
import type { RequestUser } from '../../common/decorators/current-user.decorator';
import {
  InvalidPublicUrlError,
  PublicStorage,
  publicMediaKeyFromUrl,
  sanitizeFolder,
} from '../storage/public-storage';
import type { DeleteObjectResult } from '../storage/object-storage';
import { sniffUploadType } from './upload-sniff';
import { Mp4ProbeError, probeMp4, type Mp4ProbeResult } from './mp4-probe';
import {
  assertVideoDiskSpace,
  BITRATE_CHECK_MIN_BYTES,
  MULTIPART_OVERHEAD_BYTES,
  PRODUCT_VIDEO_MAX_PER_PRODUCT,
  type StatfsFn,
  VIDEO_CONTENT_TYPE,
  VIDEO_POSTER_FOLDER,
  videoFolderAllowedForRole,
  videoFolderForbidden,
  videoQuotaExceeded,
  videoTooLarge,
  videoTypeError,
  videoUploadConfig,
  videoUploadsDisabled,
} from './video-upload.config';

// Raster formats we re-encode to WebP. Vector/document types are stored as-is.
const RASTER_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
const PASSTHROUGH_EXTS = ['.svg', '.pdf', '.ai'];

// Downscale anything larger than this on the longest edge — storefront images
// never need more, and next/image generates smaller responsive variants on top.
const MAX_DIMENSION = 2000;
const WEBP_QUALITY = 80;
/**
 * Decode cap for the generic upload route (about 4 bytes of RAM per pixel
 * while resizing). 60 MP covers any camera photo; larger inputs are refused
 * instead of letting a few parallel uploads exhaust memory.
 */
export const GENERIC_UPLOAD_MAX_PIXELS = 60_000_000;
/** Generic upload route: multer and the service both enforce it. */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Folders a role may write with `POST /uploads?folder=` (SPEC "Security
 * fixes"). CUSTOMER accounts have no generic upload at all (the storefront
 * uses `POST /uploads/customer`); ADMIN may use any folder.
 */
export const UPLOAD_FOLDERS_BY_ROLE: Readonly<
  Record<UserRole, readonly string[]>
> = {
  [UserRole.ADMIN]: ['*'],
  [UserRole.CREATOR]: [
    'products',
    'custom-products',
    'avatars',
    'logos',
    'favicons',
    'page-blocks',
    'page-seo',
    'store-hero',
    'creator-categories',
    'custom-fields',
    'general',
    VIDEO_POSTER_FOLDER,
  ],
  [UserRole.PROVIDER]: ['products', 'logos', 'avatars', VIDEO_POSTER_FOLDER],
  [UserRole.CUSTOMER]: [],
};

/** True when `role` may upload into `folder` (already sanitized). */
export function folderAllowedForRole(role: UserRole, folder: string): boolean {
  const allowed = UPLOAD_FOLDERS_BY_ROLE[role] ?? [];
  return allowed.includes('*') || allowed.includes(folder);
}

type OwnerUser = Pick<RequestUser, 'id' | 'role'>;

/** Content type recorded for a stored extension (the output extension). */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.ai': 'application/postscript',
  '.mp4': 'video/mp4',
};

/** Response of `POST /uploads/video` (CONTRACT §4.3). */
export interface VideoUploadResult {
  url: string;
  content_type: 'video/mp4';
  size_bytes: number;
  duration_s: number;
  width: number | null;
  height: number | null;
  faststart_fixed: boolean;
}

/** Response of `GET /uploads/video/config` (CONTRACT §4.2). */
export interface VideoUploadConfigResponse {
  uploads_enabled: boolean;
  max_bytes: number;
  max_duration_s: number;
  max_kbps: number;
  max_videos_per_product: number;
  accept: string[];
  quota_bytes: number | null;
  used_bytes: number;
  /**
   * Save-payload features this API accepts (CONTRACT-AUTOPLAY 2): the
   * dashboard sends `position: 0`, `autoplay` and `loop` only when present.
   */
  features: { featured_video: boolean; autoplay: boolean };
}

/** Whose videos share one quota: a creator's store, or a provider/user. */
type VideoQuotaScope = { store_id: string } | { user_id: string } | null;

function videoScopeKey(scope: VideoQuotaScope): string | null {
  if (!scope) return null;
  return 'store_id' in scope ? `s:${scope.store_id}` : `u:${scope.user_id}`;
}

/**
 * Bytes of video uploads in progress in this process (critic: parallel
 * uploads must not all pass a nearly full quota or disk). Each upload
 * reserves its size per quota scope and globally once its file is on disk
 * and releases it when it ends; the guards add the others' reservations.
 * Per process: several API instances each count their own uploads.
 */
export class VideoInflight {
  private total = 0;
  private readonly byScope = new Map<string, number>();

  reserve(scopeKey: string | null, bytes: number): () => void {
    const n = Math.max(0, bytes);
    this.total += n;
    if (scopeKey)
      this.byScope.set(scopeKey, (this.byScope.get(scopeKey) ?? 0) + n);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= n;
      if (scopeKey) {
        const left = (this.byScope.get(scopeKey) ?? 0) - n;
        if (left > 0) this.byScope.set(scopeKey, left);
        else this.byScope.delete(scopeKey);
      }
    };
  }

  /** Reserved bytes, globally or for one scope. */
  bytes(scopeKey?: string | null): number {
    if (scopeKey === undefined) return this.total;
    return scopeKey ? (this.byScope.get(scopeKey) ?? 0) : 0;
  }
}

/** Minimal raw-query client (PrismaService or a transaction client). */
export interface RawQueryClient {
  $queryRaw: PrismaService['$queryRaw'];
}

export interface StoreBufferOptions {
  id?: string;
  animated?: boolean;
  limitInputPixels?: number;
  /**
   * The account the file is stored for. When set, an `UploadedFile` row
   * records the uploader (and a creator's store) so `DELETE /uploads/:url`
   * can decide ownership by who uploaded the file (audit M1).
   */
  uploader?: OwnerUser;
}

@Injectable()
export class UploadsService {
  private readonly storage: PublicStorage;
  private readonly logger = new Logger(UploadsService.name);

  /**
   * Both dependencies are optional so the service can be built bare in unit
   * tests (`new UploadsService()` → local disk at `<cwd>/uploads`, no
   * ownership lookups).
   */
  constructor(
    @Optional() @Inject(PublicStorage) storage?: PublicStorage,
    @Optional() private readonly prisma?: PrismaService,
  ) {
    this.storage = storage ?? PublicStorage.localDefault();
  }

  /** `local` or `s3`. */
  get driver(): 'local' | 's3' {
    return this.storage.driver;
  }

  /** Disk directory of a folder in local mode; null on S3 (no disk guard). */
  localDir(folder: string): string | null {
    return this.storage.localDir(folder);
  }

  async uploadFile(
    file: Express.Multer.File,
    folder: string = 'general',
    uploader?: OwnerUser,
  ): Promise<{ url: string; file_type: string; file_size: number }> {
    if (!file) {
      throw new BadRequestException({
        code: 'UPLOAD_NO_FILE',
        message: 'No file provided',
      });
    }

    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = [...RASTER_EXTS, ...PASSTHROUGH_EXTS];
    if (!allowedExts.includes(ext)) {
      throw new BadRequestException(`File type ${ext} not allowed`);
    }

    if (file.size > UPLOAD_MAX_BYTES || file.buffer.length > UPLOAD_MAX_BYTES) {
      throw new BadRequestException({
        code: 'UPLOAD_FILE_TOO_LARGE',
        message: 'File too large (max 50MB)',
      });
    }

    // The bytes must be what the extension claims (magic bytes); a renamed
    // executable or an HTML file named .svg is refused before it is stored.
    if (!sniffUploadType(file.buffer, ext)) {
      throw new BadRequestException({
        code: 'UPLOAD_TYPE_MISMATCH',
        message: `File content does not match ${ext}`,
      });
    }

    return this.storeBuffer(file.buffer, ext, folder, { uploader });
  }

  /**
   * Writes a buffer under `uploads/<folder>/` exactly like `uploadFile` does
   * (M4.5 C21): raster input (`.png/.jpg/.jpeg/.webp`) is resized and
   * re-encoded to WebP, anything else is written through untouched. The
   * caller has already validated the type and size. `opts.id` fixes the file
   * name (`<id><ext>`) instead of a random uuid; it must be a uuid.
   * `opts.animated` / `opts.limitInputPixels` override the decoder options of
   * the raster path (customer uploads: first frame only, explicit pixel cap);
   * without them the output is exactly what `uploadFile` always produced.
   * `opts.uploader` records who stored the file (see `recordUpload`).
   */
  async storeBuffer(
    buffer: Buffer,
    ext: string,
    folder: string = 'general',
    opts: StoreBufferOptions = {},
  ): Promise<{ url: string; file_type: string; file_size: number }> {
    const inExt = (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase();
    const id = opts.id ?? randomUUID();
    if (!UUID_RE.test(id)) {
      throw new BadRequestException({
        code: 'UPLOAD_INVALID_PATH',
        message: 'Invalid file name',
      });
    }

    const safeFolder = sanitizeFolder(folder);

    // Raster images are resized + re-encoded to WebP to shrink payloads
    // (often 70–90% smaller). Other types are written through untouched.
    const isRaster = RASTER_EXTS.includes(inExt);
    const outExt = isRaster ? '.webp' : inExt;
    const filename = `${id}${outExt}`;

    const out = isRaster
      ? await this.processImage(buffer, inExt, opts)
      : buffer;
    const stored = await this.storage.put(safeFolder, filename, out);
    if (opts.uploader) {
      await this.recordUpload(
        `/${stored.key}`,
        safeFolder,
        out.length,
        outExt,
        opts.uploader,
      );
    }

    return {
      url: stored.url,
      file_type: outExt.replace('.', ''),
      file_size: out.length,
    };
  }

  // ── Product videos (plans/product-video/CONTRACT.md §4) ──────────────────

  /** Free-disk reader; tests replace it (default: `fs.promises.statfs`). */
  videoStatfs?: StatfsFn;

  /** In-progress video uploads of this process (shared by every instance of the service). */
  static readonly videoInflight = new VideoInflight();

  /** Directories whose disk must keep the free-space reserve. */
  private videoDiskDirs(folder: string): string[] {
    const cfg = videoUploadConfig();
    const dirs = [cfg.tmpDir];
    const local = this.localDir(folder);
    if (local) dirs.push(local);
    return dirs;
  }

  /** Quota scope of `user`: the creator's store, the provider/user, or null (ADMIN). */
  private async videoQuotaScope(user: OwnerUser): Promise<VideoQuotaScope> {
    if (user.role === UserRole.ADMIN) return null;
    if (user.role === UserRole.CREATOR && this.prisma) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: user.id },
        select: { store: { select: { id: true } } },
      });
      if (creator?.store?.id) return { store_id: creator.store.id };
    }
    return { user_id: user.id };
  }

  /**
   * Bytes of video counted against `scope`: files a product still uses, plus
   * files younger than 24 h (an upload not saved yet). An unreferenced older
   * file no longer counts, so replacing a video frees its space before the
   * orphan sweep removes the file. Gallery videos and customer-story videos
   * share the quota. `"ProductVideo"` / `"ProductStory"` are read through raw
   * SQL only (no dependency on the generated client).
   */
  private async videoUsedBytes(scope: VideoQuotaScope): Promise<number> {
    const prisma = this.prisma;
    if (!prisma || !scope) return 0;
    const rows =
      'store_id' in scope
        ? await prisma.$queryRaw<{ used: bigint | number | null }[]>`
            SELECT COALESCE(SUM(uf."size"), 0)::bigint AS used
            FROM "UploadedFile" uf
            WHERE uf."content_type" = ${VIDEO_CONTENT_TYPE}
              AND uf."store_id" = ${scope.store_id}
              AND (EXISTS (SELECT 1 FROM "ProductVideo" pv WHERE pv."url" = uf."key")
                   OR EXISTS (SELECT 1 FROM "ProductStory" ps WHERE ps."url" = uf."key")
                   OR uf."created_at" > now() - interval '24 hours')`
        : await prisma.$queryRaw<{ used: bigint | number | null }[]>`
            SELECT COALESCE(SUM(uf."size"), 0)::bigint AS used
            FROM "UploadedFile" uf
            WHERE uf."content_type" = ${VIDEO_CONTENT_TYPE}
              AND uf."user_id" = ${scope.user_id}
              AND (EXISTS (SELECT 1 FROM "ProductVideo" pv WHERE pv."url" = uf."key")
                   OR EXISTS (SELECT 1 FROM "ProductStory" ps WHERE ps."url" = uf."key")
                   OR uf."created_at" > now() - interval '24 hours')`;
    return Number(rows[0]?.used ?? 0);
  }

  /**
   * 403 `UPLOAD_VIDEO_QUOTA_EXCEEDED` when `incomingBytes` would exceed the
   * quota. Uploads of the same scope still in progress count as used
   * (`ownReserved`: the caller's own reservation, not counted twice).
   */
  async assertVideoQuota(
    user: OwnerUser,
    incomingBytes: number,
    ownReserved = 0,
  ): Promise<void> {
    const scope = await this.videoQuotaScope(user);
    if (!scope) return;
    const quota = videoUploadConfig().storeQuotaBytes;
    const inflight = Math.max(
      0,
      UploadsService.videoInflight.bytes(videoScopeKey(scope)) - ownReserved,
    );
    const used = (await this.videoUsedBytes(scope)) + inflight;
    if (used + Math.max(0, incomingBytes) > quota) {
      throw videoQuotaExceeded(quota, used);
    }
  }

  /**
   * 507 `UPLOAD_VIDEO_DISK_LOW` when the temp or uploads disk runs low.
   * Other uploads in progress count as incoming too (`ownReserved` excluded).
   */
  async assertVideoDisk(
    folder: string,
    incomingBytes: number,
    ownReserved = 0,
  ): Promise<void> {
    const others = Math.max(
      0,
      UploadsService.videoInflight.bytes() - ownReserved,
    );
    await assertVideoDiskSpace(
      this.videoDiskDirs(folder),
      Math.max(0, incomingBytes) + others,
      videoUploadConfig().minFreeBytes,
      this.videoStatfs,
    );
  }

  /**
   * Checks that run before the request body is read (CONTRACT §4.3 steps
   * 1–3): feature flag, role/folder, declared size, free disk, quota.
   * `contentLength` is the request's Content-Length (null when chunked).
   */
  async assertVideoPrecheck(
    user: OwnerUser | undefined,
    folder: string,
    contentLength: number | null,
  ): Promise<void> {
    const cfg = videoUploadConfig();
    if (!cfg.uploadsEnabled) throw videoUploadsDisabled();
    if (!user || !videoFolderAllowedForRole(user.role, folder)) {
      throw videoFolderForbidden(folder);
    }
    const incoming = contentLength ?? 0;
    if (incoming > cfg.maxBytes + MULTIPART_OVERHEAD_BYTES) {
      throw videoTooLarge(cfg.maxBytes);
    }
    await this.assertVideoDisk(folder, incoming);
    await this.assertVideoQuota(user, incoming);
  }

  /** `GET /uploads/video/config`. */
  async videoConfig(user: OwnerUser): Promise<VideoUploadConfigResponse> {
    const cfg = videoUploadConfig();
    const scope = await this.videoQuotaScope(user);
    let used = 0;
    try {
      used = await this.videoUsedBytes(scope);
    } catch (e) {
      this.logger.warn(`Video quota lookup failed: ${(e as Error).message}`);
    }
    return {
      uploads_enabled: cfg.uploadsEnabled,
      max_bytes: cfg.maxBytes,
      max_duration_s: cfg.maxSeconds,
      max_kbps: cfg.maxKbps,
      max_videos_per_product: PRODUCT_VIDEO_MAX_PER_PRODUCT,
      accept: [VIDEO_CONTENT_TYPE],
      quota_bytes: scope ? cfg.storeQuotaBytes : null,
      used_bytes: used,
      features: { featured_video: true, autoplay: true },
    };
  }

  /**
   * `POST /uploads/video`: the multipart file is already on disk in the
   * video temp dir (diskStorage). Validates it (extension, size, magic
   * bytes, MP4 probe), re-checks quota and disk with the real size, moves it
   * to `uploads/<folder>/<uuid>.mp4`, records the uploader, and always
   * removes the temp file(s).
   */
  async uploadVideo(
    file: Express.Multer.File | undefined,
    folder: string,
    uploader: OwnerUser,
  ): Promise<VideoUploadResult> {
    const tempPaths: string[] = [];
    if (file?.path) tempPaths.push(file.path);
    let release: () => void = () => undefined;
    try {
      const cfg = videoUploadConfig();
      if (!cfg.uploadsEnabled) throw videoUploadsDisabled();
      const safeFolder = sanitizeFolder(folder);
      if (!videoFolderAllowedForRole(uploader.role, safeFolder)) {
        throw videoFolderForbidden(safeFolder);
      }
      if (!file || !file.path) {
        throw new BadRequestException({
          code: 'UPLOAD_NO_FILE',
          message: 'No file provided',
        });
      }
      if (path.extname(file.originalname || '').toLowerCase() !== '.mp4') {
        throw videoTypeError('extension');
      }
      const size = (await fs.stat(file.path)).size;
      if (size > cfg.maxBytes) throw videoTooLarge(cfg.maxBytes);

      // Reserve this upload's bytes until it ends, so parallel uploads see
      // each other in the quota and disk guards.
      const scopeKey = videoScopeKey(await this.videoQuotaScope(uploader));
      release = UploadsService.videoInflight.reserve(scopeKey, size);
      // The probe may write a full faststart copy, and the move may copy
      // once more: room for two copies before anything is written.
      await this.assertVideoDisk(safeFolder, 2 * size, size);
      await this.assertVideoQuota(uploader, size, size);

      const fh = await fs.open(file.path, 'r');
      const head = Buffer.alloc(12);
      try {
        await fh.read(head, 0, 12, 0);
      } finally {
        await fh.close();
      }
      if (!sniffUploadType(head, '.mp4')) throw videoTypeError('not_mp4');

      const relocated = `${file.path}.faststart`;
      tempPaths.push(relocated);
      let probe: Mp4ProbeResult;
      try {
        probe = await probeMp4(file.path, {
          maxSeconds: cfg.maxSeconds,
          maxKbps: cfg.maxKbps,
          bitrateMinBytes: BITRATE_CHECK_MIN_BYTES,
          relocatedPath: relocated,
        });
      } catch (e) {
        if (e instanceof Mp4ProbeError) {
          throw new BadRequestException({
            code: e.code,
            message: e.message,
            ...e.details,
          });
        }
        throw new BadRequestException({
          code: 'UPLOAD_VIDEO_UNREADABLE',
          message: 'The video file could not be read',
        });
      }

      const finalSize = (await fs.stat(probe.outputPath)).size;
      await this.assertVideoDisk(safeFolder, finalSize, size);
      await this.assertVideoQuota(uploader, finalSize, size);

      const stored = await this.storage.putFile(
        safeFolder,
        `${randomUUID()}.mp4`,
        probe.outputPath,
        VIDEO_CONTENT_TYPE,
      );
      try {
        await this.recordUpload(
          `/${stored.key}`,
          safeFolder,
          stored.size,
          '.mp4',
          uploader,
          { strict: true },
        );
      } catch (e) {
        // A video without its row escapes the quota and the orphan sweep:
        // remove it and fail instead.
        await this.storage.delete(stored.url).catch(() => undefined);
        throw e;
      }

      return {
        url: stored.url,
        content_type: VIDEO_CONTENT_TYPE,
        size_bytes: stored.size,
        duration_s: probe.durationS,
        width: probe.width,
        height: probe.height,
        faststart_fixed: probe.faststartFixed,
      };
    } finally {
      release();
      for (const p of tempPaths) {
        await fs.unlink(p).catch(() => undefined);
      }
    }
  }

  /**
   * Deletes a stored object by key/URL for the orphan sweep (no ownership
   * check; the caller proved the file is unreferenced).
   */
  async deleteStoredObject(url: string): Promise<DeleteObjectResult> {
    return this.storage.delete(url);
  }

  /**
   * True when ANY record references `rel`: product videos and customer
   * stories (url / poster), every source `isReferencedByOthers` checks, and page versions. Used by
   * the video orphan sweep; absolute URLs match by suffix, text and JSON by
   * substring.
   */
  async isReferencedAnywhere(
    rel: string,
    client?: RawQueryClient,
  ): Promise<boolean> {
    const db = client ?? this.prisma;
    if (!db) return true;
    const esc = rel.replace(/[%_\\]/g, (c) => `\\${c}`);
    const suffix = `%${esc}`;
    const inside = `%${esc}%`;
    const rows = await db.$queryRaw<{ found: number }[]>`
      SELECT 1 AS found WHERE
        EXISTS (SELECT 1 FROM "ProductVideo" v WHERE v."url" LIKE ${suffix} OR v."poster_url" LIKE ${suffix})
        OR EXISTS (SELECT 1 FROM "ProductStory" st WHERE st."url" LIKE ${suffix} OR st."poster_url" LIKE ${suffix})
        OR EXISTS (SELECT 1 FROM "User" u WHERE u."avatar_url" LIKE ${suffix})
        OR EXISTS (SELECT 1 FROM "Creator" c WHERE c."avatar_url" LIKE ${suffix} OR c."cover_url" LIKE ${suffix})
        OR EXISTS (SELECT 1 FROM "Provider" p WHERE p."logo_url" LIKE ${suffix} OR p."description" LIKE ${inside})
        OR EXISTS (SELECT 1 FROM "Store" s WHERE s."logo_url" LIKE ${suffix} OR s."favicon_url" LIKE ${suffix} OR s."description" LIKE ${inside})
        OR EXISTS (SELECT 1 FROM "ProductImage" i WHERE i."url" LIKE ${suffix})
        OR EXISTS (SELECT 1 FROM "ProductTranslation" t WHERE t."description" LIKE ${inside} OR t."short_description" LIKE ${inside})
        OR EXISTS (SELECT 1 FROM "CustomProductImage" i WHERE i."url" LIKE ${suffix})
        OR EXISTS (SELECT 1 FROM "CustomProductTranslation" t WHERE t."description" LIKE ${inside})
        OR EXISTS (SELECT 1 FROM "CreatorCategory" cc WHERE cc."thumbnail_url" LIKE ${suffix})
        OR EXISTS (SELECT 1 FROM "StoreLegalProfile" l WHERE l."logo_url" LIKE ${suffix})
        OR EXISTS (SELECT 1 FROM "ImportMedia" m WHERE m."public_url" LIKE ${suffix})
        OR EXISTS (SELECT 1 FROM "Page" pg WHERE pg."seo"::text LIKE ${inside})
        OR EXISTS (SELECT 1 FROM "PageSection" ps WHERE ps."settings"::text LIKE ${inside})
        OR EXISTS (SELECT 1 FROM "PageSectionTranslation" pt WHERE pt."content"::text LIKE ${inside})
        OR EXISTS (SELECT 1 FROM "PageVersion" pv WHERE pv."snapshot"::text LIKE ${inside})
      LIMIT 1`;
    return rows.length > 0;
  }

  /**
   * Upserts the `UploadedFile` row of a freshly stored key. A failure is
   * logged and swallowed: the file is already stored, and a key without a row
   * falls back to the reference-based delete check (never more permissive
   * than before this table existed). `strict` (videos) rethrows instead: a
   * video must have its row for the quota and the orphan sweep.
   */
  private async recordUpload(
    key: string,
    folder: string,
    size: number,
    ext: string,
    uploader: OwnerUser,
    opts: { strict?: boolean } = {},
  ): Promise<void> {
    const prisma = this.prisma;
    if (!prisma) return;
    try {
      let storeId: string | null = null;
      if (uploader.role === UserRole.CREATOR) {
        const creator = await prisma.creator.findUnique({
          where: { user_id: uploader.id },
          select: { store: { select: { id: true } } },
        });
        storeId = creator?.store?.id ?? null;
      }
      const data = {
        user_id: uploader.id,
        store_id: storeId,
        folder,
        size,
        content_type: CONTENT_TYPES[ext] ?? 'application/octet-stream',
      };
      await prisma.uploadedFile.upsert({
        where: { key },
        create: { key, ...data },
        update: data,
      });
    } catch (e) {
      this.logger.warn(
        `Could not record uploader of ${key}: ${(e as Error).message}`,
      );
      if (opts.strict) throw e;
    }
  }

  /**
   * Resize (without enlarging) to fit within MAX_DIMENSION and encode as WebP.
   * Animated WebP frames are preserved. Rejects undecodable input rather than
   * storing it under a mismatched .webp name.
   */
  private async processImage(
    buffer: Buffer,
    ext: string,
    decode: { animated?: boolean; limitInputPixels?: number } = {},
  ): Promise<Buffer> {
    const input: sharp.SharpOptions = {
      animated: decode.animated ?? ext === '.webp',
    };
    input.limitInputPixels =
      decode.limitInputPixels ?? GENERIC_UPLOAD_MAX_PIXELS;
    try {
      return await sharp(buffer, input)
        .rotate() // honour EXIF orientation before stripping metadata
        .resize(MAX_DIMENSION, MAX_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
    } catch {
      throw new BadRequestException({
        code: 'UPLOAD_IMAGE_PROCESS_FAILED',
        message: 'Could not process image — file may be corrupt',
      });
    }
  }

  /**
   * Delete an uploaded file by its public URL (`/uploads/<folder>/<file>`,
   * relative or absolute). The URL arrives from the client: anything outside
   * the public key shape (`..`, other paths) is refused, so nothing outside
   * the uploads tree can ever be unlinked. A missing file is not an error.
   */
  async deleteFile(fileUrl: string): Promise<void> {
    try {
      await this.storage.delete(fileUrl);
    } catch (e) {
      if (e instanceof InvalidPublicUrlError) {
        throw new BadRequestException({
          code: 'UPLOAD_INVALID_PATH',
          message: 'Invalid file path',
        });
      }
      throw e;
    }
  }

  /**
   * `DELETE /uploads/:fileUrl` with ownership: an ADMIN may delete any public
   * file. For anyone else:
   * - a file with an `UploadedFile` row may be deleted only by its uploader,
   *   or by a CREATOR of the store it was uploaded for;
   * - a file without a row (stored before uploads were recorded) may be
   *   deleted when a record the caller owns references it (store
   *   logo/favicon, legal-profile logo, avatar/cover, provider logo, product /
   *   custom-product / collection images, imported media, page builder JSON)
   *   or it lies in their store's `template-imports/<storeId>/` folder;
   * - in both cases a file another account still references is refused.
   * Anything else → 403 UPLOAD_NOT_OWNED (the file is not revealed as
   * existing or not). The row is removed after the storage delete.
   */
  async deleteOwnedFile(fileUrl: string, user: OwnerUser): Promise<void> {
    const key = publicMediaKeyFromUrl(fileUrl);
    if (!key) {
      throw new BadRequestException({
        code: 'UPLOAD_INVALID_PATH',
        message: 'Invalid file path',
      });
    }
    if (user.role !== UserRole.ADMIN) {
      // Owning a reference is not enough: anyone can paste another store's
      // URL into their own record. A file another account still uses is
      // never deleted by a non-admin.
      const record = await this.findUploadRecord(`/${key}`);
      const owned =
        (record
          ? await this.isUploader(record, user)
          : await this.isOwnedBy(`/${key}`, user)) &&
        !(await this.isReferencedByOthers(`/${key}`, user));
      if (!owned) {
        throw new ForbiddenException({
          code: 'UPLOAD_NOT_OWNED',
          message: 'You can only delete files you uploaded',
        });
      }
    }
    await this.storage.delete(`/${key}`);
    await this.prisma?.uploadedFile.deleteMany({ where: { key: `/${key}` } });
  }

  /** The `UploadedFile` row of `rel`, or null (legacy file / no database). */
  private async findUploadRecord(
    rel: string,
  ): Promise<{ user_id: string | null; store_id: string | null } | null> {
    if (!this.prisma) return null;
    return this.prisma.uploadedFile.findUnique({
      where: { key: rel },
      select: { user_id: true, store_id: true },
    });
  }

  /**
   * True when the caller uploaded the recorded file, or is a CREATOR whose
   * store the file was uploaded for. CUSTOMER accounts never qualify.
   */
  private async isUploader(
    record: { user_id: string | null; store_id: string | null },
    user: OwnerUser,
  ): Promise<boolean> {
    if (user.role === UserRole.CUSTOMER) return false;
    if (record.user_id !== null && record.user_id === user.id) return true;
    if (user.role !== UserRole.CREATOR || record.store_id === null) {
      return false;
    }
    const creator = await this.prisma?.creator.findUnique({
      where: { user_id: user.id },
      select: { store: { select: { id: true } } },
    });
    return creator?.store?.id === record.store_id;
  }

  /**
   * True when `rel` (`/uploads/<folder>/<file>`) is referenced by a record of
   * the caller. Column values may be absolute (`https://host/uploads/...`),
   * so every string column is matched with `endsWith`; JSON page-builder
   * blobs are matched as text.
   */
  async isOwnedBy(rel: string, user: OwnerUser): Promise<boolean> {
    const prisma = this.prisma;
    if (!prisma) return false;
    if (user.role === UserRole.CUSTOMER) return false;
    const ends = { endsWith: rel };

    const me = await prisma.user.findUnique({
      where: { id: user.id },
      select: { avatar_url: true },
    });
    if (me?.avatar_url?.endsWith(rel)) return true;

    if (user.role === UserRole.PROVIDER) {
      const provider = await prisma.provider.findUnique({
        where: { user_id: user.id },
        select: { id: true, logo_url: true },
      });
      if (!provider) return false;
      if (provider.logo_url?.endsWith(rel)) return true;
      const image = await prisma.productImage.findFirst({
        where: { url: ends, product: { provider_id: provider.id } },
        select: { id: true },
      });
      if (image !== null) return true;
      return this.referencedByOwnVideo(rel, { providerId: provider.id });
    }

    if (user.role !== UserRole.CREATOR) return false;
    const creator = await prisma.creator.findUnique({
      where: { user_id: user.id },
      select: {
        id: true,
        avatar_url: true,
        cover_url: true,
        store: { select: { id: true, logo_url: true, favicon_url: true } },
      },
    });
    if (!creator) return false;
    if (creator.avatar_url?.endsWith(rel) || creator.cover_url?.endsWith(rel)) {
      return true;
    }
    const store = creator.store;
    if (store) {
      if (store.logo_url?.endsWith(rel) || store.favicon_url?.endsWith(rel)) {
        return true;
      }
      // The kit assets of this store (`/uploads/template-imports/<storeId>/...`).
      if (rel.startsWith(`/uploads/template-imports/${store.id}/`)) return true;
    }

    const checks: Array<() => Promise<boolean>> = [
      async () =>
        (await prisma.productImage.findFirst({
          where: { url: ends, product: { creator_id: creator.id } },
          select: { id: true },
        })) !== null,
      async () =>
        (await prisma.customProductImage.findFirst({
          where: { url: ends, custom_product: { creator_id: creator.id } },
          select: { id: true },
        })) !== null,
      async () =>
        (await prisma.creatorCategory.findFirst({
          where: { thumbnail_url: ends, creator_id: creator.id },
          select: { id: true },
        })) !== null,
    ];
    if (store) {
      checks.push(
        async () =>
          (await prisma.storeLegalProfile.findFirst({
            where: { logo_url: ends, store_id: store.id },
            select: { id: true },
          })) !== null,
        async () =>
          (await prisma.importMedia.findFirst({
            where: { public_url: ends, store_id: store.id },
            select: { id: true },
          })) !== null,
        async () => this.referencedInPageJson(rel, store.id),
      );
    }
    checks.push(() =>
      this.referencedByOwnVideo(rel, { creatorId: creator.id }),
    );
    for (const check of checks) {
      if (await check()) return true;
    }
    return false;
  }

  /**
   * True when a product video or a customer story (media or poster) of the
   * caller's products references `rel`. Raw SQL so this module does not
   * depend on the generated `ProductVideo` / `ProductStory` client.
   */
  private async referencedByOwnVideo(
    rel: string,
    owner: { creatorId: string } | { providerId: string },
  ): Promise<boolean> {
    const prisma = this.prisma;
    if (!prisma) return false;
    const suffix = `%${rel.replace(/[%_\\]/g, (c) => `\\${c}`)}`;
    const rows =
      'creatorId' in owner
        ? await prisma.$queryRaw<{ found: number }[]>`
            SELECT 1 AS found WHERE
              EXISTS (SELECT 1 FROM "ProductVideo" v JOIN "Product" pr ON pr."id" = v."product_id"
                      WHERE (v."url" LIKE ${suffix} OR v."poster_url" LIKE ${suffix})
                        AND pr."creator_id" = ${owner.creatorId})
              OR EXISTS (SELECT 1 FROM "ProductStory" st JOIN "Product" pr ON pr."id" = st."product_id"
                         WHERE (st."url" LIKE ${suffix} OR st."poster_url" LIKE ${suffix})
                           AND pr."creator_id" = ${owner.creatorId})`
        : await prisma.$queryRaw<{ found: number }[]>`
            SELECT 1 AS found WHERE
              EXISTS (SELECT 1 FROM "ProductVideo" v JOIN "Product" pr ON pr."id" = v."product_id"
                      WHERE (v."url" LIKE ${suffix} OR v."poster_url" LIKE ${suffix})
                        AND pr."provider_id" = ${owner.providerId})
              OR EXISTS (SELECT 1 FROM "ProductStory" st JOIN "Product" pr ON pr."id" = st."product_id"
                         WHERE (st."url" LIKE ${suffix} OR st."poster_url" LIKE ${suffix})
                           AND pr."provider_id" = ${owner.providerId})`;
    return rows.length > 0;
  }

  /**
   * True when `rel` is referenced by a record that does NOT belong to the
   * caller: another user's avatar, another provider/creator profile, another
   * store's logo / description / legal logo / imports / pages, or a product,
   * custom product or collection of someone else (images and description
   * HTML). Absolute URLs match by suffix, HTML and JSON by substring.
   */
  async isReferencedByOthers(rel: string, user: OwnerUser): Promise<boolean> {
    const prisma = this.prisma;
    if (!prisma) return true;
    const [creator, provider] = await Promise.all([
      prisma.creator.findUnique({
        where: { user_id: user.id },
        select: { id: true, store: { select: { id: true } } },
      }),
      prisma.provider.findUnique({
        where: { user_id: user.id },
        select: { id: true },
      }),
    ]);
    const creatorId = creator?.id ?? null;
    const storeId = creator?.store?.id ?? null;
    const providerId = provider?.id ?? null;
    const esc = rel.replace(/[%_\\]/g, (c) => `\\${c}`);
    const suffix = `%${esc}`;
    const inside = `%${esc}%`;
    const rows = await prisma.$queryRaw<{ found: number }[]>`
      SELECT 1 AS found WHERE
        EXISTS (SELECT 1 FROM "User" u WHERE u."id" <> ${user.id} AND u."avatar_url" LIKE ${suffix})
        OR EXISTS (SELECT 1 FROM "Creator" c WHERE c."user_id" <> ${user.id}
                   AND (c."avatar_url" LIKE ${suffix} OR c."cover_url" LIKE ${suffix}))
        OR EXISTS (SELECT 1 FROM "Provider" p WHERE p."user_id" <> ${user.id}
                   AND (p."logo_url" LIKE ${suffix} OR p."description" LIKE ${inside}))
        OR EXISTS (SELECT 1 FROM "Store" s WHERE s."creator_id" IS DISTINCT FROM ${creatorId}
                   AND (s."logo_url" LIKE ${suffix} OR s."favicon_url" LIKE ${suffix} OR s."description" LIKE ${inside}))
        OR EXISTS (SELECT 1 FROM "ProductImage" i JOIN "Product" pr ON pr."id" = i."product_id"
                   WHERE i."url" LIKE ${suffix}
                     AND pr."creator_id" IS DISTINCT FROM ${creatorId}
                     AND pr."provider_id" IS DISTINCT FROM ${providerId})
        OR EXISTS (SELECT 1 FROM "ProductVideo" v JOIN "Product" pr ON pr."id" = v."product_id"
                   WHERE (v."url" LIKE ${suffix} OR v."poster_url" LIKE ${suffix})
                     AND pr."creator_id" IS DISTINCT FROM ${creatorId}
                     AND pr."provider_id" IS DISTINCT FROM ${providerId})
        OR EXISTS (SELECT 1 FROM "ProductStory" st JOIN "Product" pr ON pr."id" = st."product_id"
                   WHERE (st."url" LIKE ${suffix} OR st."poster_url" LIKE ${suffix})
                     AND pr."creator_id" IS DISTINCT FROM ${creatorId}
                     AND pr."provider_id" IS DISTINCT FROM ${providerId})
        OR EXISTS (SELECT 1 FROM "ProductTranslation" t JOIN "Product" pr ON pr."id" = t."product_id"
                   WHERE (t."description" LIKE ${inside} OR t."short_description" LIKE ${inside})
                     AND pr."creator_id" IS DISTINCT FROM ${creatorId}
                     AND pr."provider_id" IS DISTINCT FROM ${providerId})
        OR EXISTS (SELECT 1 FROM "CustomProductImage" i JOIN "CustomProduct" cp ON cp."id" = i."custom_product_id"
                   WHERE i."url" LIKE ${suffix} AND cp."creator_id" IS DISTINCT FROM ${creatorId})
        OR EXISTS (SELECT 1 FROM "CustomProductTranslation" t JOIN "CustomProduct" cp ON cp."id" = t."custom_product_id"
                   WHERE t."description" LIKE ${inside} AND cp."creator_id" IS DISTINCT FROM ${creatorId})
        OR EXISTS (SELECT 1 FROM "CreatorCategory" cc WHERE cc."creator_id" IS DISTINCT FROM ${creatorId}
                   AND cc."thumbnail_url" LIKE ${suffix})
        OR EXISTS (SELECT 1 FROM "StoreLegalProfile" l WHERE l."store_id" IS DISTINCT FROM ${storeId}
                   AND l."logo_url" LIKE ${suffix})
        OR EXISTS (SELECT 1 FROM "ImportMedia" m WHERE m."store_id" IS DISTINCT FROM ${storeId}
                   AND m."public_url" LIKE ${suffix})
        OR EXISTS (SELECT 1 FROM "Page" pg WHERE pg."store_id" IS DISTINCT FROM ${storeId}
                   AND (pg."seo"::text LIKE ${inside}
                     OR EXISTS (SELECT 1 FROM "PageSection" ps WHERE ps."page_id" = pg."id" AND ps."settings"::text LIKE ${inside})
                     OR EXISTS (SELECT 1 FROM "PageSection" ps JOIN "PageSectionTranslation" pt ON pt."section_id" = ps."id"
                                WHERE ps."page_id" = pg."id" AND pt."content"::text LIKE ${inside})))
      LIMIT 1`;
    return rows.length > 0;
  }

  /** Page-builder JSON of the store (sections, blocks, translations, versions, SEO) mentioning `rel`. */
  private async referencedInPageJson(
    rel: string,
    storeId: string,
  ): Promise<boolean> {
    const prisma = this.prisma;
    if (!prisma) return false;
    const needle = `%${rel.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const rows = await prisma.$queryRaw<{ found: number }[]>`
      SELECT 1 AS found FROM "Page" p
      WHERE p."store_id" = ${storeId}
        AND (
          p."seo"::text LIKE ${needle}
          OR EXISTS (SELECT 1 FROM "PageSection" s WHERE s."page_id" = p."id" AND s."settings"::text LIKE ${needle})
          OR EXISTS (SELECT 1 FROM "PageSection" s JOIN "PageSectionTranslation" t ON t."section_id" = s."id"
                     WHERE s."page_id" = p."id" AND t."content"::text LIKE ${needle})
          OR EXISTS (SELECT 1 FROM "PageVersion" v WHERE v."page_id" = p."id" AND v."snapshot"::text LIKE ${needle})
        )
      LIMIT 1`;
    return rows.length > 0;
  }
}
