import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
  StreamableFile,
} from '@nestjs/common';
import { Backup, BackupKind, BackupStatus, Prisma } from '@prisma/client';
import { createReadStream, promises as fs } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import {
  fileTimestamp,
  formatBytes,
  freeDiskBytes,
  parseDatabaseUrl,
  pgDump,
  pgRestore,
  isTolerableTarWarning,
  runTool,
  tarExtract,
  toolAvailable,
  ToolError,
  ToolMissingError,
} from './backup-runner';
import {
  BackupFileKind,
  RESTORE_CONFIRM_PHRASE,
  RestoreBackupDto,
  UpdateBackupSettingsDto,
} from './dto/backups.dto';
import { computeNextRunAt, SlotConfig } from './backup-schedule';
import { defaultPrivateStorageDir } from '../../common/storage/private-file-storage';
import { BackupOffsiteService } from './offsite/backup-offsite.service';

/** Name of the folder (relative to cwd) archived with a backup. */
const UPLOADS_DIR = 'uploads';
/** Free space required before a backup starts: 2 × last size + this margin. */
const DISK_MARGIN_BYTES = 200 * 1024 * 1024;
/** pg_restore hard limit; the HTTP request stays open for as long. */
export const RESTORE_TIMEOUT_MS = 10 * 60 * 1000;
/** pg_dump / tar hard limit for one backup run. */
const BACKUP_TIMEOUT_MS = 60 * 60 * 1000;
/** How long a `tools` availability probe is reused. */
const TOOLS_CACHE_MS = 60 * 1000;

export type BackupTools = {
  pg_dump: boolean;
  pg_restore: boolean;
  tar: boolean;
};

/** A Backup row as returned to clients: BigInt sizes become numbers. */
export type BackupView = Omit<
  Backup,
  'db_size_bytes' | 'uploads_size_bytes'
> & {
  db_size_bytes: number | null;
  uploads_size_bytes: number | null;
};

export interface CreateBackupOptions {
  includeUploads?: boolean;
  note?: string | null;
  createdBy?: string | null;
}

const ACTIVE_STATUSES: BackupStatus[] = [
  BackupStatus.PENDING,
  BackupStatus.RUNNING,
];

const SETTINGS_SELECT = {
  backup_enabled: true,
  backup_frequency: true,
  backup_time: true,
  backup_weekday: true,
  backup_retention: true,
  backup_include_uploads: true,
  backup_last_run_at: true,
} satisfies Prisma.PlatformConfigSelect;

export type BackupSettingsRow = Prisma.PlatformConfigGetPayload<{
  select: typeof SETTINGS_SELECT;
}>;

const SETTINGS_DEFAULTS: BackupSettingsRow = {
  backup_enabled: false,
  backup_frequency: 'DAILY',
  backup_time: '03:00',
  backup_weekday: 0,
  backup_retention: 14,
  backup_include_uploads: true,
  backup_last_run_at: null,
};

/**
 * Backup engine (plans/backups/API-CONTRACT.md): runs pg_dump / tar into
 * BACKUP_DIR, tracks each run as a Backup row, serves the files back and
 * replays a dump with pg_restore. At most one backup (or restore) runs per
 * process; the in-memory flags are the fast guard and the RUNNING rows the
 * durable one.
 */
@Injectable()
export class BackupsService implements OnModuleInit {
  private readonly logger = new Logger(BackupsService.name);

  /** Absolute directory holding the backup files. */
  readonly dir = resolve(
    process.env.BACKUP_DIR || join(process.cwd(), 'backups'),
  );

  /** A backup run is in flight in this process. */
  private running = false;
  /**
   * `start()` is between its busy check and `running = true` (awaits on the
   * row count, the disk guard and the insert). A second call in that window
   * would pass the same checks and start a parallel dump; it is refused.
   */
  private starting = false;
  /** A restore is in flight in this process. */
  private restoring = false;
  private toolsCache: { at: number; tools: BackupTools } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly offsite?: BackupOffsiteService,
  ) {}

  /**
   * A row still PENDING/RUNNING at boot belongs to a process that died
   * mid-backup; left alone it would block every later backup with 409.
   */
  async onModuleInit() {
    try {
      const stale = await this.prisma.backup.updateMany({
        where: { status: { in: ACTIVE_STATUSES } },
        data: {
          status: BackupStatus.FAILED,
          error:
            'BACKUP_INTERRUPTED: the API restarted while this backup was running',
          finished_at: new Date(),
        },
      });
      if (stale.count > 0) {
        this.logger.warn(
          `Marked ${stale.count} interrupted backup(s) as FAILED at startup`,
        );
      }
    } catch (err) {
      // The table may not exist yet on a fresh DB before `prisma migrate`.
      this.logger.warn(
        `Could not clean up interrupted backups: ${String(err)}`,
      );
    }
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  async list() {
    const [rows, active] = await Promise.all([
      this.prisma.backup.findMany({ orderBy: { created_at: 'desc' } }),
      this.prisma.backup.count({ where: { status: { in: ACTIVE_STATUSES } } }),
    ]);
    let free_bytes: number | null = null;
    try {
      await fs.mkdir(this.dir, { recursive: true });
      free_bytes = await freeDiskBytes(this.dir);
    } catch (err) {
      this.logger.warn(`Cannot stat backup dir ${this.dir}: ${String(err)}`);
    }
    return {
      items: rows.map((row) => this.serialize(row)),
      running: active > 0 || this.running || this.restoring,
      disk: { free_bytes, dir: this.dir },
    };
  }

  async get(id: string): Promise<BackupView> {
    return this.serialize(await this.findOrThrow(id));
  }

  /**
   * Is any backup or restore busy (DB rows or this process)? The restore
   * flow passes `ignoreRestoring` for its own pre-restore backup.
   */
  async isBusy(ignoreRestoring = false): Promise<boolean> {
    if (this.running) return true;
    if (this.restoring && !ignoreRestoring) return true;
    const active = await this.prisma.backup.count({
      where: { status: { in: ACTIVE_STATUSES } },
    });
    return active > 0;
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  /**
   * Insert a PENDING row and start the run in the background. Resolves with
   * the row as soon as it exists; the run's outcome lands on the row.
   */
  async create(
    kind: BackupKind,
    options: CreateBackupOptions = {},
  ): Promise<BackupView> {
    const { row, done } = await this.start(kind, options);
    done.catch((err: unknown) =>
      this.logger.error(`Backup ${row.id} crashed: ${String(err)}`),
    );
    return row;
  }

  /** Like `create` but waits for the run and returns the final row. */
  async createAndWait(
    kind: BackupKind,
    options: CreateBackupOptions = {},
    fromRestore = false,
  ): Promise<BackupView> {
    const { done } = await this.start(kind, options, fromRestore);
    return done;
  }

  private async start(
    kind: BackupKind,
    options: CreateBackupOptions,
    fromRestore = false,
  ) {
    const busy = () =>
      new ConflictException({
        code: 'BACKUP_ALREADY_RUNNING',
        message: 'Another backup or restore is already running',
      });
    // Synchronous claim: no await before it, so two concurrent calls cannot
    // both pass the checks below (the row count sees neither insert yet).
    if (this.starting) throw busy();
    this.starting = true;
    let created: Backup;
    let includeUploads: boolean;
    try {
      if (await this.isBusy(fromRestore)) throw busy();
      await this.assertDiskSpace();

      includeUploads = options.includeUploads ?? false;
      created = await this.prisma.backup.create({
        data: {
          kind,
          status: BackupStatus.PENDING,
          includes_uploads: includeUploads,
          note: options.note ?? null,
          created_by: options.createdBy ?? null,
        },
      });
      // Claim the process-level slot before returning so a second request
      // that arrives before the row flips to RUNNING is still refused.
      this.running = true;
    } finally {
      this.starting = false;
    }
    const done = this.run(created, includeUploads);
    return { row: this.serialize(created), done };
  }

  /**
   * Disk guard: refuse when the free space on BACKUP_DIR is below
   * 2 × (size of the last completed backup) + 200 MB.
   */
  private async assertDiskSpace() {
    await fs.mkdir(this.dir, { recursive: true });
    const last = await this.prisma.backup.findFirst({
      where: { status: BackupStatus.COMPLETED },
      orderBy: { created_at: 'desc' },
      select: { db_size_bytes: true, uploads_size_bytes: true },
    });
    const lastSize =
      Number(last?.db_size_bytes ?? 0) + Number(last?.uploads_size_bytes ?? 0);
    const required = 2 * lastSize + DISK_MARGIN_BYTES;
    let free: number;
    try {
      free = await freeDiskBytes(this.dir);
    } catch (err) {
      this.logger.warn(
        `Cannot measure free space on ${this.dir}: ${String(err)}`,
      );
      return;
    }
    if (free < required) {
      throw new HttpException(
        {
          code: 'BACKUP_DISK_FULL',
          message: `Not enough free space in ${this.dir}: ${formatBytes(free)} free, ${formatBytes(required)} required`,
        },
        HttpStatus.INSUFFICIENT_STORAGE,
      );
    }
  }

  /** The actual run: RUNNING → pg_dump → (tar) → COMPLETED | FAILED. */
  private async run(row: Backup, includeUploads: boolean): Promise<BackupView> {
    const stamp = `${fileTimestamp(new Date())}-${row.id.slice(0, 8)}`;
    const dbFile = join(this.dir, `db-${stamp}.dump`);
    const uploadsFile = includeUploads
      ? join(this.dir, `uploads-${stamp}.tar.gz`)
      : null;
    this.logger.log(
      `Backup ${row.id} (${row.kind}) started → ${basename(dbFile)}${uploadsFile ? ` + ${basename(uploadsFile)}` : ''}`,
    );

    try {
      await this.prisma.backup.update({
        where: { id: row.id },
        data: { status: BackupStatus.RUNNING, started_at: new Date() },
      });

      const missing = await this.missingTools(
        includeUploads ? ['pg_dump', 'tar'] : ['pg_dump'],
      );
      if (missing.length) {
        throw new ToolMissingError(missing.join(', '));
      }

      const url = parseDatabaseUrl(process.env.DATABASE_URL ?? '');
      await pgDump(url, dbFile, { timeoutMs: BACKUP_TIMEOUT_MS });
      const dbSize = (await fs.stat(dbFile)).size;

      let uploadsSize: number | null = null;
      if (uploadsFile) {
        // Public uploads (while they are still on local disk), private files
        // (customer upload originals, designer assets, importer bundles) and
        // invoice PDFs travel in one archive, each directory entered with
        // its own `-C` so the configured dirs may live outside the working
        // directory. Restore still extracts `uploads/` only.
        const members = await archiveMembers();
        const privateDirs = members
          .filter((m) => m.kind === 'private')
          .map((m) => m.name);
        // `--exclude`: in-flight atomic-write temp files of private storage.
        const args = ['-czf', uploadsFile, '--exclude=.*.tmp'];
        for (const m of members) args.push('-C', m.cwd, m.name);
        try {
          await runTool('tar', args, { timeoutMs: BACKUP_TIMEOUT_MS });
        } catch (err) {
          // Files purged or replaced in private storage during the run do
          // not invalidate the archive (see isTolerableTarWarning).
          if (
            !(err instanceof ToolError) ||
            !isTolerableTarWarning(err.result, privateDirs)
          ) {
            throw err;
          }
          this.logger.warn(
            `Backup ${row.id}: tar reported private files changing during the archive (tolerated): ${err.result.stderrTail}`,
          );
        }
        uploadsSize = (await fs.stat(uploadsFile)).size;
      }

      const finished = await this.prisma.backup.update({
        where: { id: row.id },
        data: {
          status: BackupStatus.COMPLETED,
          db_file: dbFile,
          db_size_bytes: BigInt(dbSize),
          uploads_file: uploadsFile,
          uploads_size_bytes: uploadsSize === null ? null : BigInt(uploadsSize),
          finished_at: new Date(),
        },
      });
      this.logger.log(
        `Backup ${row.id} completed: db ${formatBytes(dbSize)}${uploadsSize === null ? '' : `, uploads ${formatBytes(uploadsSize)}`}`,
      );
      return this.serialize(await this.copyOffsite(finished));
    } catch (err) {
      const error = this.describeError(err);
      this.logger.error(`Backup ${row.id} failed: ${error}`);
      await Promise.all([
        removeIfExists(dbFile),
        uploadsFile ? removeIfExists(uploadsFile) : Promise.resolve(),
      ]);
      const failed = await this.prisma.backup.update({
        where: { id: row.id },
        data: {
          status: BackupStatus.FAILED,
          error,
          finished_at: new Date(),
        },
      });
      return this.serialize(failed);
    } finally {
      this.running = false;
    }
  }

  /**
   * Offsite copy of a completed backup (never fails the backup). A
   * PRE_RESTORE backup is copied in the background so the restore it
   * protects does not wait for the upload.
   */
  private async copyOffsite(row: Backup): Promise<Backup> {
    if (!this.offsite?.uploadEnabled) return row;
    if (row.kind === BackupKind.PRE_RESTORE) {
      this.offsite
        .uploadAfterBackup(row)
        .catch((err: unknown) =>
          this.logger.error(
            `Offsite copy of ${row.id} crashed: ${String(err)}`,
          ),
        );
      return row;
    }
    return this.offsite.uploadAfterBackup(row);
  }

  /**
   * Local path of a backup file, fetched back from the offsite copy when
   * it was rotated off the disk; 404 BACKUP_FILE_MISSING when neither
   * exists.
   */
  private async localFile(row: Backup, which: BackupFileKind): Promise<string> {
    const current = which === 'db' ? row.db_file : row.uploads_file;
    if (!current && !(which === 'db' ? row.s3_key : row.s3_files_key)) {
      throw new NotFoundException({
        code: 'BACKUP_FILE_MISSING',
        message: `This backup has no ${which} file`,
      });
    }
    let file: string | null = null;
    try {
      file = this.offsite
        ? await this.offsite.ensureLocalFile(row, which, this.dir)
        : current && (await fileExists(current))
          ? current
          : null;
    } catch (err) {
      this.logger.error(
        `Backup ${row.id}: fetching the ${which} file offsite failed: ${String(err)}`,
      );
      throw new InternalServerErrorException({
        code: 'BACKUP_OFFSITE_FETCH_FAILED',
        message: `The ${which} file is not on disk and could not be fetched from the offsite copy`,
      });
    }
    if (!file) {
      throw new NotFoundException({
        code: 'BACKUP_FILE_MISSING',
        message: `The ${which} file is no longer on disk`,
      });
    }
    return file;
  }

  /** Error text stored on a FAILED row: a code prefix + a bounded detail. */
  private describeError(err: unknown): string {
    if (err instanceof ToolMissingError) {
      return `BACKUP_TOOL_MISSING: ${err.tool}`;
    }
    if (err instanceof ToolError) return err.message.slice(0, 2048);
    const message = err instanceof Error ? err.message : String(err);
    return message.slice(0, 2048);
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  /** Removes the files first, then the row (a running backup is refused). */
  async delete(id: string) {
    const row = await this.findOrThrow(id);
    if (ACTIVE_STATUSES.includes(row.status)) {
      throw new ConflictException({
        code: 'BACKUP_RUNNING',
        message: 'A running backup cannot be deleted',
      });
    }
    await this.deleteRow(row);
    return { deleted: true as const };
  }

  private async deleteRow(row: Backup) {
    await removeIfExists(row.db_file);
    await removeIfExists(row.uploads_file);
    await this.prisma.backup
      .delete({ where: { id: row.id } })
      .catch((err: unknown) => {
        // Already gone (e.g. a concurrent delete) — nothing left to do.
        if (!isNotFound(err)) throw err;
      });
  }

  /**
   * Retention for the scheduler: keep the `keep` most recent SCHEDULED
   * backups (files and rows), delete the rest. Running rows are untouched.
   */
  async applyRetention(keep: number): Promise<number> {
    const rows = await this.prisma.backup.findMany({
      where: {
        kind: BackupKind.SCHEDULED,
        status: { notIn: ACTIVE_STATUSES },
      },
      orderBy: { created_at: 'desc' },
      skip: Math.max(1, keep),
    });
    for (const row of rows) {
      try {
        await this.deleteRow(row);
        this.logger.log(`Retention removed scheduled backup ${row.id}`);
      } catch (err) {
        this.logger.error(`Retention failed for ${row.id}: ${String(err)}`);
      }
    }
    return rows.length;
  }

  // ── Download ───────────────────────────────────────────────────────────────

  async download(id: string, which: BackupFileKind): Promise<StreamableFile> {
    const row = await this.findOrThrow(id);
    const file = await this.localFile(row, which);
    let size: number;
    try {
      size = (await fs.stat(file)).size;
    } catch {
      throw new NotFoundException({
        code: 'BACKUP_FILE_MISSING',
        message: `The ${which} file is no longer on disk`,
      });
    }
    return new StreamableFile(createReadStream(file), {
      type: which === 'db' ? 'application/octet-stream' : 'application/gzip',
      disposition: `attachment; filename="${basename(file)}"`,
      length: size,
    });
  }

  // ── Restore ────────────────────────────────────────────────────────────────

  /**
   * Replace the database (and optionally `uploads/`) with a backup. Takes a
   * PRE_RESTORE backup first, then runs pg_restore synchronously. The API
   * keeps running throughout: a `pm2 reload` is recommended afterwards so
   * every worker drops cached state; nothing here restarts the process.
   */
  async restore(id: string, dto: RestoreBackupDto, createdBy?: string | null) {
    if (dto.confirm !== RESTORE_CONFIRM_PHRASE) {
      throw new BadRequestException({
        code: 'BACKUP_CONFIRM_MISMATCH',
        message: `Type ${RESTORE_CONFIRM_PHRASE} to confirm the restore`,
      });
    }
    const row = await this.findOrThrow(id);
    if (row.status !== BackupStatus.COMPLETED || !(row.db_file || row.s3_key)) {
      throw new BadRequestException({
        code: 'BACKUP_NOT_RESTORABLE',
        message: 'Only a completed backup can be restored',
      });
    }
    const restoreUploads = dto.restore_uploads === true;
    if (restoreUploads && !(row.uploads_file || row.s3_files_key)) {
      throw new BadRequestException({
        code: 'BACKUP_NO_UPLOADS',
        message: 'This backup does not include an uploads archive',
      });
    }
    // Local copies, fetched back from the offsite bucket when rotated out.
    const dbFile = await this.localFile(row, 'db');
    const uploadsFile = restoreUploads
      ? await this.localFile(row, 'uploads')
      : null;

    if (await this.isBusy()) {
      throw new ConflictException({
        code: 'BACKUP_ALREADY_RUNNING',
        message: 'Another backup or restore is already running',
      });
    }
    const missing = await this.missingTools(
      restoreUploads
        ? ['pg_dump', 'pg_restore', 'tar']
        : ['pg_dump', 'pg_restore'],
    );
    if (missing.length) {
      throw new BadRequestException({
        code: 'BACKUP_TOOL_MISSING',
        message: `Missing on the server: ${missing.join(', ')}`,
      });
    }

    this.restoring = true;
    this.logger.warn(
      `RESTORE requested for backup ${id} by ${createdBy ?? 'unknown'} (uploads: ${restoreUploads})`,
    );
    try {
      // 1. Safety net: a backup of the current state, taken synchronously.
      //    `restoring` stays set so manual creates are refused meanwhile.
      const pre = await this.createAndWait(
        BackupKind.PRE_RESTORE,
        {
          includeUploads: restoreUploads,
          note: `Automatic backup before restoring ${basename(dbFile)}`,
          createdBy,
        },
        true,
      );
      if (pre.status !== BackupStatus.COMPLETED) {
        throw new InternalServerErrorException({
          code: 'BACKUP_PRE_RESTORE_FAILED',
          message: `The pre-restore backup failed: ${pre.error ?? 'unknown error'}`,
        });
      }

      // 2. The dump replaces the Backup table too, so remember the rows that
      //    describe files on disk and put them back afterwards.
      const snapshot = await this.prisma.backup.findMany();

      // 3. Replay the dump.
      const url = parseDatabaseUrl(process.env.DATABASE_URL ?? '');
      this.logger.warn(`RESTORE: pg_restore ${basename(dbFile)} → database`);
      try {
        await pgRestore(url, dbFile, { timeoutMs: RESTORE_TIMEOUT_MS });
      } catch (err) {
        const detail = this.describeError(err);
        this.logger.error(`RESTORE FAILED for ${id}: ${detail}`);
        await this.resyncRows(snapshot);
        throw new InternalServerErrorException({
          code: 'BACKUP_RESTORE_FAILED',
          message: detail,
        });
      }
      await this.resyncRows(snapshot);

      // 4. Uploads, only on explicit request: entries are extracted under
      //    `uploads/` only; files that exist today and are not in the archive
      //    stay in place.
      //    MANUAL STEP for private storage (customer upload originals,
      //    invoice PDFs): the same archive also holds `storage/` (or the
      //    PRIVATE_STORAGE_DIR / INVOICE_STORAGE_DIR folders under the working
      //    directory) but it is never extracted automatically. To restore it,
      //    stop the API and run from the API working directory:
      //      tar -xzf <uploads-…tar.gz> -C . storage
      //    (list the folders first with `tar -tzf <file> | cut -d/ -f1 | sort -u`).
      //    Files purged by retention after the backup come back as files, but
      //    their CustomerUpload rows keep `purged_at`, so they stay unserved.
      if (restoreUploads && uploadsFile) {
        this.logger.warn(
          `RESTORE: extracting ${basename(uploadsFile)} over ${UPLOADS_DIR}/`,
        );
        try {
          await tarExtract(uploadsFile, process.cwd(), UPLOADS_DIR, {
            timeoutMs: RESTORE_TIMEOUT_MS,
          });
        } catch (err) {
          const detail = this.describeError(err);
          this.logger.error(`RESTORE: uploads extraction failed: ${detail}`);
          throw new InternalServerErrorException({
            code: 'BACKUP_RESTORE_UPLOADS_FAILED',
            message: `Database restored, but the uploads archive failed: ${detail}`,
          });
        }
      }

      this.logger.warn(
        `RESTORE COMPLETED from backup ${id}; pre-restore backup ${pre.id}. A process reload (pm2 reload) is recommended.`,
      );
      return { restored: true as const, pre_restore_backup_id: pre.id };
    } finally {
      this.restoring = false;
    }
  }

  /**
   * After pg_restore the Backup table reflects the dump's moment in time;
   * re-insert the rows we knew about so every file on disk stays listed.
   */
  private async resyncRows(snapshot: Backup[]) {
    if (!snapshot.length) return;
    try {
      await this.prisma.backup.createMany({
        data: snapshot,
        skipDuplicates: true,
      });
    } catch (err) {
      this.logger.error(
        `Could not re-sync backup rows after restore: ${String(err)}`,
      );
    }
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  async getSettings() {
    const config = await this.prisma.platformConfig.findFirst({
      select: SETTINGS_SELECT,
    });
    return this.settingsView(config ?? SETTINGS_DEFAULTS);
  }

  async updateSettings(dto: UpdateBackupSettingsDto) {
    const data: Prisma.PlatformConfigUpdateInput = {};
    if (dto.backup_enabled !== undefined)
      data.backup_enabled = dto.backup_enabled;
    if (dto.backup_frequency !== undefined) {
      data.backup_frequency = dto.backup_frequency;
    }
    if (dto.backup_time !== undefined) data.backup_time = dto.backup_time;
    if (dto.backup_weekday !== undefined)
      data.backup_weekday = dto.backup_weekday;
    if (dto.backup_retention !== undefined) {
      data.backup_retention = dto.backup_retention;
    }
    if (dto.backup_include_uploads !== undefined) {
      data.backup_include_uploads = dto.backup_include_uploads;
    }
    const existing = await this.prisma.platformConfig.findFirst({
      select: { id: true },
    });
    if (existing) {
      await this.prisma.platformConfig.update({
        where: { id: existing.id },
        data,
      });
    } else {
      await this.prisma.platformConfig.create({
        data: data as Prisma.PlatformConfigCreateInput,
      });
    }
    return this.getSettings();
  }

  /** The scheduler's read: raw fields, no tool probing. */
  async readSchedule(): Promise<BackupSettingsRow> {
    const config = await this.prisma.platformConfig.findFirst({
      select: SETTINGS_SELECT,
    });
    return config ?? SETTINGS_DEFAULTS;
  }

  async markScheduledRun(at: Date) {
    const existing = await this.prisma.platformConfig.findFirst({
      select: { id: true },
    });
    if (!existing) return;
    await this.prisma.platformConfig.update({
      where: { id: existing.id },
      data: { backup_last_run_at: at },
    });
  }

  private async settingsView(config: BackupSettingsRow) {
    const slot: SlotConfig = {
      frequency: config.backup_frequency === 'WEEKLY' ? 'WEEKLY' : 'DAILY',
      time: config.backup_time,
      weekday: config.backup_weekday,
    };
    return {
      ...config,
      next_run_at: config.backup_enabled
        ? computeNextRunAt(slot, new Date())
        : null,
      tools: await this.tools(),
    };
  }

  /** Availability of the three external tools, probed at most once a minute. */
  async tools(): Promise<BackupTools> {
    const now = Date.now();
    if (this.toolsCache && now - this.toolsCache.at < TOOLS_CACHE_MS) {
      return this.toolsCache.tools;
    }
    const [pg_dump, pg_restore, tar] = await Promise.all([
      toolAvailable('pg_dump'),
      toolAvailable('pg_restore'),
      toolAvailable('tar'),
    ]);
    const tools = { pg_dump, pg_restore, tar };
    this.toolsCache = { at: now, tools };
    return tools;
  }

  private async missingTools(names: (keyof BackupTools)[]) {
    const tools = await this.tools();
    return names.filter((name) => !tools[name]);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async findOrThrow(id: string): Promise<Backup> {
    const row = await this.prisma.backup.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException({
        code: 'BACKUP_NOT_FOUND',
        message: 'Backup not found',
      });
    }
    return row;
  }

  /** BigInt columns → numbers so the JSON envelope can serialise the row. */
  serialize(row: Backup): BackupView {
    return {
      ...row,
      db_size_bytes:
        row.db_size_bytes === null ? null : Number(row.db_size_bytes),
      uploads_size_bytes:
        row.uploads_size_bytes === null ? null : Number(row.uploads_size_bytes),
    };
  }
}

async function removeIfExists(file: string | null | undefined) {
  if (!file) return;
  try {
    await fs.unlink(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function isNotFound(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025'
  );
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** One `-C <cwd> <name>` pair of the files archive. */
export interface ArchiveMember {
  kind: 'uploads' | 'private';
  /** Directory tar enters before adding `name`. */
  cwd: string;
  /** Entry name inside the archive (the directory's base name). */
  name: string;
  abs: string;
}

/**
 * Directories of the files archive: the public `uploads/` folder while
 * `STORAGE_DRIVER` is not `s3` (afterwards the media already lives in S3),
 * then `PRIVATE_STORAGE_DIR` (default `<cwd>/storage`, which also holds the
 * default invoice storage) and `INVOICE_STORAGE_DIR`, wherever they live.
 * Each existing directory becomes `-C <parent> <basename>`; a root nested
 * in another member is covered by it. Two roots with the same base name
 * are both appended (tar merges them on extraction).
 */
export async function archiveMembers(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ArchiveMember[]> {
  const cwd = process.cwd();
  const members: ArchiveMember[] = [];
  const addUploads = async () => {
    // An empty uploads folder still yields a valid (tiny) archive.
    const uploads = join(cwd, UPLOADS_DIR);
    await fs.mkdir(uploads, { recursive: true });
    members.push({ kind: 'uploads', cwd, name: UPLOADS_DIR, abs: uploads });
  };
  if ((env.STORAGE_DRIVER ?? 'local').trim().toLowerCase() !== 's3') {
    await addUploads();
  }
  const candidates = [defaultPrivateStorageDir()];
  const invoiceDir = env.INVOICE_STORAGE_DIR?.trim();
  if (invoiceDir) candidates.push(resolve(invoiceDir));
  const roots: string[] = [];
  for (const abs of candidates) {
    try {
      if (!(await fs.stat(abs)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!roots.includes(abs)) roots.push(abs);
  }
  roots.sort((a, b) => a.length - b.length);
  for (const abs of roots) {
    const covered = [...members.map((m) => m.abs), ...roots].some(
      (p) => p !== abs && isInside(abs, p),
    );
    if (covered) continue;
    members.push({
      kind: 'private',
      cwd: dirname(abs),
      name: basename(abs),
      abs,
    });
  }
  // Nothing to archive (s3 driver, no private dirs yet): keep tar happy.
  if (!members.length) await addUploads();
  return members;
}

function isInside(child: string, parent: string): boolean {
  const c = child.replace(/\\/g, '/').replace(/\/+$/, '');
  const p = parent.replace(/\\/g, '/').replace(/\/+$/, '');
  return c === p || c.startsWith(`${p}/`);
}
