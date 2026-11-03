import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import { Backup } from '@prisma/client';
import { createHash } from 'crypto';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import { hostname } from 'os';
import { basename, join } from 'path';
import { pipeline } from 'stream/promises';
import { PrismaService } from '../../../prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { RetentionService } from '../../retention/retention.service';
import type {
  RetentionRunOptions,
  RetentionTaskResult,
} from '../../retention/retention.types';
import type { BackupObjectSink, BackupSinkObject } from './backup-object-sink';
import {
  appManifestKey,
  BACKUP_OBJECT_SINK,
  dbObjectKey,
  filesObjectKey,
  MANIFEST_PREFIX,
  NoopBackupObjectSink,
  offsiteDate,
  SHA256_METADATA_KEY,
  tierOptions,
} from './backup-object-sink';

/** Retention task key (`POST /admin/retention/run?task=`). */
export const OFFSITE_WATCHDOG_TASK = 'backups.offsite-watchdog';
/** EmailLog / template event of the alert. */
export const OFFSITE_MISSING_EVENT = 'backup_offsite_missing';
/** A success marker younger than this means offsite backups are healthy. */
export const OFFSITE_WINDOW_MS = 26 * 60 * 60 * 1000;
/** One alert per day: an EmailLog row of the event inside this window dedupes. */
const ALERT_DEDUPE_MS = 24 * 60 * 60 * 1000;
/** `BACKUP_OFFSITE_UPLOAD=off` keeps the sink but skips the in-app upload. */
const UPLOAD_ENV = 'BACKUP_OFFSITE_UPLOAD';
/** Longest `offsite_error` stored on a row. */
const ERROR_MAX = 1024;

export type BackupFileSide = 'db' | 'uploads';

interface OffsiteFileReport {
  key: string;
  file: string;
  bytes: number;
  sha256: string;
  etag: string | null;
}

/**
 * Offsite copy of in-app backups (plans/s3-storage Phase 1): after a local
 * backup completes, the dump and the files archive are uploaded to the
 * backup sink under `db/<date>/` and `files/<date>/` (tagged with their
 * retention tier, weekly/monthly objects locked), verified by S3's
 * server-side `ChecksumSHA256` on the PutObject plus a ListObjectsV2 size
 * check (the writer key has no GetObject/HeadObject) and recorded on the
 * Backup row. A restore or download whose local file was rotated out pulls
 * the object back (that needs the restore policy on the key). The
 * hourly watchdog task alerts the admins once a day when no success marker
 * (`manifests/<date>…json`, from the cron script or from here) is younger
 * than 26 h. Retention never deletes objects: S3 lifecycle does.
 */
@Injectable()
export class BackupOffsiteService implements OnModuleInit {
  private readonly logger = new Logger(BackupOffsiteService.name);
  readonly sink: BackupObjectSink;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(BACKUP_OBJECT_SINK) sink?: BackupObjectSink,
    @Optional() private readonly mail?: MailService,
    @Optional() private readonly retention?: RetentionService,
  ) {
    this.sink = sink ?? new NoopBackupObjectSink();
  }

  onModuleInit(): void {
    this.retention?.registerTask({
      key: OFFSITE_WATCHDOG_TASK,
      run: (now, opts) => this.watchdog(now, opts),
    });
  }

  /** True when a completed backup is copied offsite. */
  get uploadEnabled(): boolean {
    return (
      this.sink.enabled &&
      (process.env[UPLOAD_ENV] ?? '').toLowerCase() !== 'off'
    );
  }

  // ── Upload ─────────────────────────────────────────────────────────────────

  /**
   * Copies the row's files to the sink and records the result. Never
   * throws: a failure lands in `offsite_error` and the row is returned as
   * it is (the local backup stays COMPLETED).
   */
  async uploadAfterBackup(row: Backup, at: Date = new Date()): Promise<Backup> {
    if (!this.uploadEnabled || !row.db_file) return row;
    const started = Date.now();
    try {
      const tier = tierOptions(at);
      const db = await this.uploadFile(
        row.db_file,
        dbObjectKey(at, basename(row.db_file)),
        'application/octet-stream',
        tier,
      );
      const files = row.uploads_file
        ? await this.uploadFile(
            row.uploads_file,
            filesObjectKey(at, basename(row.uploads_file)),
            'application/gzip',
            tier,
          )
        : null;
      await this.writeManifest(row, at, db, files, tier);
      const updated = await this.prisma.backup.update({
        where: { id: row.id },
        data: {
          s3_key: db.key,
          s3_files_key: files?.key ?? null,
          s3_etag: db.etag,
          offsite_at: new Date(),
          offsite_error: null,
        },
      });
      this.logger.log(
        `Backup ${row.id} offsite → ${this.sink.target}/${db.key}${
          files ? ` + ${files.key}` : ''
        } in ${Math.round((Date.now() - started) / 1000)}s`,
      );
      return updated;
    } catch (err) {
      const error = describe(err);
      this.logger.error(`Backup ${row.id} offsite copy failed: ${error}`);
      try {
        return await this.prisma.backup.update({
          where: { id: row.id },
          data: { offsite_error: error },
        });
      } catch (dbErr) {
        this.logger.error(
          `Could not record offsite error for ${row.id}: ${describe(dbErr)}`,
        );
        return row;
      }
    }
  }

  /**
   * Upload + verify with the writer policy only: the sha256 travels as the
   * PutObject `ChecksumSHA256` (S3 fails the request on a mismatch), then
   * ListObjectsV2 on the key confirms the stored size. No HeadObject.
   */
  private async uploadFile(
    file: string,
    key: string,
    contentType: string,
    tier: ReturnType<typeof tierOptions>,
  ): Promise<OffsiteFileReport> {
    const bytes = (await fs.stat(file)).size;
    const sha256 = await sha256File(file);
    const put = await this.sink.put(key, createReadStream(file), {
      contentType,
      contentLength: bytes,
      sha256,
      ...tier,
    });
    const stored = await this.sink.sizeOf(key);
    if (stored === null) {
      throw new Error(`BACKUP_OFFSITE_VERIFY: ${key} missing after upload`);
    }
    if (stored !== bytes) {
      throw new Error(
        `BACKUP_OFFSITE_VERIFY: ${key} size ${stored} != local ${bytes}`,
      );
    }
    return { key, file: basename(file), bytes, sha256, etag: put.etag };
  }

  private async writeManifest(
    row: Backup,
    at: Date,
    db: OffsiteFileReport,
    files: OffsiteFileReport | null,
    tier: ReturnType<typeof tierOptions>,
  ): Promise<void> {
    const manifest = {
      version: 1,
      source: 'app',
      backup_id: row.id,
      kind: row.kind,
      host: hostname(),
      date: offsiteDate(at),
      tier: tier.tier,
      created_at: new Date().toISOString(),
      db_key: db.key,
      db_bytes: db.bytes,
      db_sha256: db.sha256,
      files_key: files?.key ?? null,
      files_bytes: files?.bytes ?? null,
      files_sha256: files?.sha256 ?? null,
    };
    const body = Buffer.from(JSON.stringify(manifest, null, 2));
    // Manifests are tagged like their dump (INFRA.md §3.5).
    await this.sink.put(appManifestKey(at, row.id), body, {
      contentType: 'application/json',
      sha256: createHash('sha256').update(body).digest('hex'),
      ...tier,
    });
  }

  // ── Fetch back ─────────────────────────────────────────────────────────────

  /**
   * Local path of the row's db / uploads file, downloading it from the sink
   * into `dir` when the local copy is gone. Returns null when neither the
   * file nor an object exists. The row is updated when the path changed.
   */
  async ensureLocalFile(
    row: Backup,
    which: BackupFileSide,
    dir: string,
  ): Promise<string | null> {
    const local = which === 'db' ? row.db_file : row.uploads_file;
    if (local && (await exists(local))) return local;
    const key = which === 'db' ? row.s3_key : row.s3_files_key;
    if (!key || !this.sink.enabled) return null;
    const target = join(dir, basename(key));
    this.logger.warn(
      `Backup ${row.id}: ${which} file missing locally, fetching ${this.sink.target}/${key}`,
    );
    const object = await this.sink.get(key);
    if (!object) return null;
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${target}.part`;
    try {
      await pipeline(object.stream, createWriteStream(tmp));
      const expected = object.metadata[SHA256_METADATA_KEY];
      if (expected) {
        const actual = await sha256File(tmp);
        if (actual !== expected) {
          throw new Error(
            `BACKUP_OFFSITE_VERIFY: ${key} sha256 mismatch after download`,
          );
        }
      }
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
    if (target !== local) {
      await this.prisma.backup.update({
        where: { id: row.id },
        data: which === 'db' ? { db_file: target } : { uploads_file: target },
      });
    }
    return target;
  }

  // ── Watchdog ───────────────────────────────────────────────────────────────

  /**
   * Hourly: is there a success marker younger than 26 h? When not (or when
   * the bucket cannot be listed), one alert per day goes to the admin
   * recipients. `purged` counts alerts sent, `skipped` quiet passes.
   */
  async watchdog(
    now: Date,
    opts: Partial<RetentionRunOptions> = {},
  ): Promise<RetentionTaskResult> {
    const result: RetentionTaskResult = {
      purged: 0,
      skipped: 0,
      errors: 0,
      details: {},
    };
    const bump = (key: string) => {
      result.details![key] = (result.details![key] ?? 0) + 1;
    };
    if (!this.sink.enabled) {
      bump('disabled');
      result.skipped++;
      return result;
    }
    let latest: Date | null = null;
    let reason = '';
    try {
      latest = latestMarker(await this.sink.list(MANIFEST_PREFIX), now);
    } catch (err) {
      reason = describe(err);
      result.errors++;
      this.logger.error(`Offsite watchdog: cannot list markers: ${reason}`);
    }
    if (latest && now.getTime() - latest.getTime() <= OFFSITE_WINDOW_MS) {
      bump('ok');
      result.skipped++;
      return result;
    }
    const already = await this.prisma.emailLog.findFirst({
      where: {
        event: OFFSITE_MISSING_EVENT,
        created_at: { gte: new Date(now.getTime() - ALERT_DEDUPE_MS) },
      },
      select: { id: true },
    });
    if (already) {
      bump('alreadyAlerted');
      result.skipped++;
      return result;
    }
    if (opts.dryRun) {
      bump('wouldAlert');
      result.purged++;
      return result;
    }
    const sent = await this.alert(now, latest, reason);
    if (sent > 0) {
      result.details!.sent = sent;
      result.purged++;
    } else {
      bump('noRecipient');
      result.errors++;
    }
    return result;
  }

  private async alert(
    now: Date,
    latest: Date | null,
    reason: string,
  ): Promise<number> {
    if (!this.mail) {
      this.logger.error('Offsite watchdog: no mail service, cannot alert');
      return 0;
    }
    const recipients = await this.mail.adminRecipients();
    if (!recipients.length) {
      this.logger.error('Offsite watchdog: no admin recipient configured');
      return 0;
    }
    const hours = latest
      ? Math.floor((now.getTime() - latest.getTime()) / 3_600_000)
      : null;
    const dashboard = (
      process.env.DASHBOARD_URL || 'http://localhost:3002'
    ).replace(/\/$/, '');
    const vars = {
      bucket: this.sink.target,
      last_success: latest ? latest.toISOString() : 'never',
      hours_since: hours === null ? '-' : String(hours),
      checked_at: now.toISOString(),
      reason:
        reason ||
        (latest
          ? 'no success marker in the last 26 hours'
          : 'no success marker found'),
      admin_url: `${dashboard}/admin/backups`,
    };
    this.logger.warn(
      `Offsite watchdog: no success marker since ${vars.last_success}; alerting ${recipients.length} admin(s)`,
    );
    let sent = 0;
    for (const to of recipients) {
      const out = await this.mail.sendOnboarding(
        OFFSITE_MISSING_EVENT,
        to,
        vars,
      );
      if (out.sent) sent++;
    }
    return sent;
  }
}

/**
 * Newest success marker: by `lastModified` when the listing carries it,
 * else by the `yyyy-mm-dd` the key starts with (taken as the end of that
 * UTC day, so a date-only key never looks older than it is).
 */
export function latestMarker(
  objects: BackupSinkObject[],
  now: Date,
): Date | null {
  let best: Date | null = null;
  for (const o of objects) {
    const name = o.key.slice(MANIFEST_PREFIX.length);
    if (!/\.json$/i.test(name)) continue;
    let at: Date | null = o.lastModified;
    if (!at) {
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(name);
      if (!m) continue;
      const parsed = new Date(`${m[1]}T23:59:59.999Z`);
      if (Number.isNaN(parsed.getTime())) continue;
      at = parsed.getTime() > now.getTime() ? now : parsed;
    }
    if (!best || at.getTime() > best.getTime()) best = at;
  }
  return best;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, ERROR_MAX);
}
