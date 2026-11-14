/**
 * Video orphan + temp sweep (plans/product-video/CONTRACT.md §4.6).
 *
 * Product saves never delete video files (rows may share a file after
 * `duplicate()`, and a removed video may come back before the save). This
 * job deletes uploads older than 24 h that are referenced nowhere (product
 * videos, images, descriptions, page JSON, ...), then their `UploadedFile`
 * row: `video/mp4` files and the images of the `video-posters` folder (the
 * posters of removed, replaced or abandoned videos). It runs 10 minutes after
 * boot and every 6 hours and never throws. On boot it also removes stale
 * temp files (> 1 h) left in the video temp dir by interrupted uploads.
 *
 * Concurrency: candidates are listed outside any transaction; each one is
 * then claimed in its own short transaction with `FOR UPDATE SKIP LOCKED` on
 * its `UploadedFile` row. A product save locks the rows of the files and
 * posters it references `FOR SHARE` (products.service syncVideos), so a save
 * and a sweep never interleave, and two API instances never delete the same
 * file twice. The pass is skipped while a backup runs (its tar would fail on
 * a file deleted under it).
 *
 * Disabled when `NODE_ENV === 'test'` or `PRODUCT_VIDEO_SWEEP=0`.
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadsService } from './uploads.service';
import {
  VIDEO_CONTENT_TYPE,
  VIDEO_POSTER_FOLDER,
  VIDEO_TMP_MAX_AGE_MS,
  videoUploadConfig,
} from './video-upload.config';

export const VIDEO_SWEEP_FIRST_DELAY_MS = 10 * 60 * 1000;
export const VIDEO_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const VIDEO_ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const VIDEO_SWEEP_BATCH = 50;
/** Per-candidate transaction budget (row claim, reference check, delete). */
const CANDIDATE_TIMEOUT_MS = 30_000;
/** A RUNNING backup older than this is treated as crashed (not blocking). */
export const BACKUP_RUNNING_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export interface VideoSweepOutcome {
  acquired: boolean;
  scanned: number;
  deleted: number;
  kept: number;
  failed: number;
}

@Injectable()
export class VideoOrphanSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoOrphanSweepService.name);
  private firstTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadsService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    if (!videoUploadConfig().sweepEnabled) {
      this.logger.log('Video orphan sweep disabled (PRODUCT_VIDEO_SWEEP=0)');
      return;
    }
    void this.sweepTemp();
    this.firstTimer = setTimeout(
      () => void this.tick(),
      VIDEO_SWEEP_FIRST_DELAY_MS,
    );
    this.firstTimer.unref();
    this.timer = setInterval(() => void this.tick(), VIDEO_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.timer) clearInterval(this.timer);
    this.firstTimer = null;
    this.timer = null;
  }

  /** One scheduled pass: temp files, then orphans. Never throws. */
  async tick(now: Date = new Date()): Promise<void> {
    await this.sweepTemp(now);
    await this.sweepOrphans(now);
  }

  /** Deletes files in the video temp dir older than 1 h. Returns the count. */
  async sweepTemp(now: Date = new Date()): Promise<number> {
    const dir = videoUploadConfig().tmpDir;
    let removed = 0;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = path.join(dir, entry.name);
        try {
          const st = await fs.stat(full);
          if (now.getTime() - st.mtime.getTime() > VIDEO_TMP_MAX_AGE_MS) {
            await fs.unlink(full);
            removed++;
          }
        } catch {
          // Raced with a finishing upload; nothing to do.
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`Video temp sweep failed: ${(e as Error).message}`);
      }
    }
    if (removed > 0)
      this.logger.log(`Video temp sweep removed ${removed} file(s)`);
    return removed;
  }

  /** True while a backup started recently is still RUNNING (any instance). */
  private async backupRunning(now: Date): Promise<boolean> {
    const since = new Date(now.getTime() - BACKUP_RUNNING_MAX_AGE_MS);
    const rows = await this.prisma.$queryRaw<{ running: number }[]>`
      SELECT 1 AS running FROM "Backup" b
      WHERE b."status" = 'RUNNING' AND b."started_at" > ${since}
      LIMIT 1`;
    return rows.length > 0;
  }

  /**
   * Deletes unreferenced video and video-poster uploads older than 24 h (at
   * most `VIDEO_SWEEP_BATCH` per run). Rows whose key a `ProductVideo` or a
   * `ProductStory` uses are excluded in SQL; every remaining candidate is claimed and checked
   * against all reference sources in its own short transaction before its
   * file and row are deleted. A refused storage delete keeps the row so the
   * next run retries.
   */
  async sweepOrphans(now: Date = new Date()): Promise<VideoSweepOutcome> {
    const outcome: VideoSweepOutcome = {
      acquired: false,
      scanned: 0,
      deleted: 0,
      kept: 0,
      failed: 0,
    };
    if (this.running) return outcome;
    this.running = true;
    try {
      if (await this.backupRunning(now)) {
        this.logger.log('Video orphan sweep skipped: a backup is running');
        return outcome;
      }
      outcome.acquired = true;
      const cutoff = new Date(now.getTime() - VIDEO_ORPHAN_MIN_AGE_MS);
      const candidates = await this.prisma.$queryRaw<{ key: string }[]>`
        SELECT uf."key" AS key FROM "UploadedFile" uf
        WHERE (uf."content_type" = ${VIDEO_CONTENT_TYPE} OR uf."folder" = ${VIDEO_POSTER_FOLDER})
          AND uf."created_at" < ${cutoff}
          AND NOT EXISTS (SELECT 1 FROM "ProductVideo" pv
                          WHERE pv."url" = uf."key" OR pv."poster_url" = uf."key")
          AND NOT EXISTS (SELECT 1 FROM "ProductStory" ps
                          WHERE ps."url" = uf."key" OR ps."poster_url" = uf."key")
        ORDER BY uf."created_at" ASC
        LIMIT ${VIDEO_SWEEP_BATCH}`;
      for (const { key } of candidates) {
        if (await this.backupRunning(now)) break;
        outcome.scanned++;
        try {
          const result = await this.prisma.$transaction(
            async (tx) => {
              // Claim the row; a save holding it FOR SHARE (or another
              // sweeper) makes us skip it this run.
              const claimed = await tx.$queryRaw<{ key: string }[]>`
                SELECT uf."key" AS key FROM "UploadedFile" uf
                WHERE uf."key" = ${key}
                FOR UPDATE SKIP LOCKED`;
              if (!claimed.length) return 'kept' as const;
              if (await this.uploads.isReferencedAnywhere(key, tx)) {
                return 'kept' as const;
              }
              const res = await this.uploads.deleteStoredObject(key);
              if (res.deleted || res.reason === 'missing') {
                await tx.uploadedFile.deleteMany({ where: { key } });
                return 'deleted' as const;
              }
              return 'kept' as const;
            },
            { maxWait: 10_000, timeout: CANDIDATE_TIMEOUT_MS },
          );
          outcome[result]++;
        } catch (e) {
          outcome.failed++;
          this.logger.warn(
            `Video sweep could not remove ${key}: ${(e as Error).message}`,
          );
        }
      }
      this.logger.log(
        `Video orphan sweep: scanned ${outcome.scanned}, deleted ${outcome.deleted}, kept ${outcome.kept}, failed ${outcome.failed}`,
      );
    } catch (e) {
      this.logger.error(`Video orphan sweep failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
    return outcome;
  }
}
