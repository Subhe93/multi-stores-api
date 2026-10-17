import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { hostname } from 'os';
import { join, resolve } from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { defaultPrivateStorageDir } from '../../common/storage/private-file-storage';
import { freeBytes } from '../customer-uploads/customer-upload-admission';
import { instanceId } from '../../common/ops/job-log';
import { workerFlags } from '../../common/ops/workers-env';
import { computeNextRunAt } from '../backups/backup-schedule';

/**
 * `GET /admin/ops/status` (M5 W1-C, F13): one read-only snapshot of the
 * schedulers and workers for the operator. Every query is cheap (indexed
 * counts, one row by primary key, `SELECT 1`), the answer is cached for
 * `STATUS_CACHE_MS` and sections never fail the whole answer: a failing
 * section reports `{ error }` and the rest is still returned.
 *
 * Instance-bound fields (`instance`, `workers`, `disk`) describe the API
 * process that answered; with a PM2 cluster the reverse proxy picks it.
 * Cross-instance facts (last ticks, paused print workers) come from the
 * `OpsJobTick` table every instance writes.
 */

export const STATUS_CACHE_MS = 15_000;
/** Importer heartbeat age after which a run is reported stale (ImportWorkerService.STALE_AFTER_MS). */
export const IMPORTER_STALE_MS = 120_000;

export interface DiskStatus {
  dir: string;
  free_bytes: number | null;
}

export interface OpsStatus {
  generated_at: string;
  cached: boolean;
  app: { version: string | null; commit: string | null; node: string };
  instance: {
    id: string;
    hostname: string;
    pid: number;
    uptime_s: number;
    runs_as_root: boolean;
    env: string;
  };
  workers: Record<string, boolean>;
  db: { ok: boolean; round_trip_ms: number | null; error?: string };
  disk: Record<string, DiskStatus>;
  retention: unknown;
  print_queue: unknown;
  importer: unknown;
  backup: unknown;
  jobs: unknown;
}

interface JobTickRow {
  job: string;
  instance: string;
  ticked_at: Date;
  outcome: string;
  payload: unknown;
  ran_at: Date | null;
  ran_payload: unknown;
}

@Injectable()
export class OpsStatusService {
  private readonly logger = new Logger(OpsStatusService.name);
  private cache: { at: number; value: OpsStatus } | null = null;
  private pending: Promise<OpsStatus> | null = null;
  private build: { version: string | null; commit: string | null } | null =
    null;

  constructor(private readonly prisma: PrismaService) {}

  async status(now: number = Date.now()): Promise<OpsStatus> {
    if (this.cache && now - this.cache.at < STATUS_CACHE_MS) {
      return { ...this.cache.value, cached: true };
    }
    if (!this.pending) {
      this.pending = this.collect(new Date(now)).finally(() => {
        this.pending = null;
      });
    }
    const value = await this.pending;
    this.cache = { at: now, value };
    return value;
  }

  private async collect(now: Date): Promise<OpsStatus> {
    const build = await this.buildInfo();
    const [db, disk, jobs, printQueue, importer, backup] = await Promise.all([
      this.dbRoundTrip(),
      this.disk(),
      this.section(() => this.jobTicks()),
      this.section(() => this.printQueue(now)),
      this.section(() => this.importer(now)),
      this.section(() => this.backup(now)),
    ]);
    const ticks = Array.isArray(jobs) ? jobs : [];
    return {
      generated_at: now.toISOString(),
      cached: false,
      app: { ...build, node: process.version },
      instance: {
        id: instanceId(),
        hostname: hostname(),
        pid: process.pid,
        uptime_s: Math.floor(process.uptime()),
        runs_as_root:
          typeof process.getuid === 'function' && process.getuid() === 0,
        env: process.env.NODE_ENV ?? 'development',
      },
      workers: workerFlags(),
      db,
      disk,
      retention: retentionFromTicks(ticks),
      print_queue: withPaused(printQueue, ticks, now),
      importer: withImporterTicks(importer, ticks),
      backup,
      jobs: Array.isArray(jobs) ? ticks.map(tickView) : jobs,
    };
  }

  /** Runs one section; its failure becomes `{ error }` instead of a 500. */
  private async section<T>(
    fn: () => Promise<T>,
  ): Promise<T | { error: string }> {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Ops status section failed: ${message}`);
      return { error: message };
    }
  }

  private async dbRoundTrip(): Promise<OpsStatus['db']> {
    const started = process.hrtime.bigint();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      return { ok: true, round_trip_ms: Math.round(ms * 10) / 10 };
    } catch (err) {
      return {
        ok: false,
        round_trip_ms: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async disk(): Promise<Record<string, DiskStatus>> {
    const dirs: Record<string, string> = {
      private_storage: defaultPrivateStorageDir(),
      invoices: process.env.INVOICE_STORAGE_DIR?.trim()
        ? resolve(process.env.INVOICE_STORAGE_DIR.trim())
        : join(process.cwd(), 'storage', 'invoices'),
      uploads: join(process.cwd(), 'uploads'),
      backups: process.env.BACKUP_DIR?.trim()
        ? resolve(process.env.BACKUP_DIR.trim())
        : join(process.cwd(), 'backups'),
    };
    const out: Record<string, DiskStatus> = {};
    for (const [name, dir] of Object.entries(dirs)) {
      out[name] = { dir, free_bytes: await freeBytes(dir) };
    }
    return out;
  }

  private async jobTicks(): Promise<JobTickRow[]> {
    return this.prisma.$queryRaw<JobTickRow[]>`
      SELECT "job", "instance", "ticked_at", "outcome", "payload", "ran_at", "ran_payload"
      FROM "OpsJobTick" ORDER BY "job", "instance"`;
  }

  private async printQueue(now: Date) {
    const counts = await this.prisma.$queryRaw<
      { print_status: string; n: bigint | number }[]
    >`
      SELECT "print_status", count(*) AS n FROM "OrderItemDesign"
      WHERE "print_requested_at" IS NOT NULL AND "files_purged_at" IS NULL AND "terminal_at" IS NULL
      GROUP BY "print_status"`;
    const oldest = await this.prisma.$queryRaw<{ at: Date | null }[]>`
      SELECT min("print_requested_at") AS at FROM "OrderItemDesign"
      WHERE "print_requested_at" IS NOT NULL AND "files_purged_at" IS NULL AND "terminal_at" IS NULL
        AND "print_status" = 'PENDING'`;
    const by: Record<string, number> = {};
    for (const row of counts) by[row.print_status] = Number(row.n);
    const oldestAt = oldest[0]?.at ?? null;
    return {
      counts: by,
      oldest_pending_at: oldestAt ? oldestAt.toISOString() : null,
      oldest_pending_age_s: oldestAt
        ? Math.max(0, Math.floor((now.getTime() - oldestAt.getTime()) / 1000))
        : null,
    };
  }

  private async importer(now: Date) {
    const active = await this.prisma.importRun.findMany({
      where: { status: { in: ['PLANNING', 'RUNNING', 'ROLLING_BACK'] } },
      select: {
        id: true,
        store_id: true,
        status: true,
        worker_id: true,
        heartbeat_at: true,
        started_at: true,
        attempt: true,
      },
      orderBy: { created_at: 'asc' },
      take: 50,
    });
    const queued = await this.prisma.importRun.count({
      where: { status: { in: ['QUEUED', 'ROLLBACK_QUEUED'] } },
    });
    const cutoff = now.getTime() - IMPORTER_STALE_MS;
    const runs = active.map((r) => ({
      ...r,
      heartbeat_age_s: r.heartbeat_at
        ? Math.floor((now.getTime() - r.heartbeat_at.getTime()) / 1000)
        : null,
      stale: !r.heartbeat_at || r.heartbeat_at.getTime() < cutoff,
    }));
    return {
      active_runs: runs,
      stale_heartbeats: runs.filter((r) => r.stale).length,
      queued,
    };
  }

  private async backup(now: Date) {
    const cfg = await this.prisma.platformConfig.findFirst({
      select: {
        backup_enabled: true,
        backup_frequency: true,
        backup_time: true,
        backup_weekday: true,
        backup_retention: true,
        backup_include_uploads: true,
        backup_last_run_at: true,
      },
    });
    const [last, running] = await Promise.all([
      this.prisma.backup.findFirst({
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          kind: true,
          status: true,
          created_at: true,
          finished_at: true,
          error: true,
          db_size_bytes: true,
          uploads_size_bytes: true,
        },
      }),
      this.prisma.backup.count({
        where: { status: { in: ['PENDING', 'RUNNING'] } },
      }),
    ]);
    const enabled = cfg?.backup_enabled ?? false;
    return {
      enabled,
      schedule: cfg
        ? {
            frequency: cfg.backup_frequency,
            time: cfg.backup_time,
            weekday: cfg.backup_weekday,
            retention: cfg.backup_retention,
            include_uploads: cfg.backup_include_uploads,
          }
        : null,
      last_run_at: cfg?.backup_last_run_at?.toISOString() ?? null,
      next_run_at:
        enabled && cfg
          ? computeNextRunAt(
              {
                frequency:
                  cfg.backup_frequency === 'WEEKLY' ? 'WEEKLY' : 'DAILY',
                time: cfg.backup_time,
                weekday: cfg.backup_weekday,
              },
              now,
            ).toISOString()
          : null,
      running: running > 0,
      last: last
        ? {
            ...last,
            db_size_bytes:
              last.db_size_bytes === null ? null : Number(last.db_size_bytes),
            uploads_size_bytes:
              last.uploads_size_bytes === null
                ? null
                : Number(last.uploads_size_bytes),
          }
        : null,
    };
  }

  /** package.json version and the git commit (GIT_COMMIT / APP_COMMIT, else .git/HEAD), read once. */
  private async buildInfo() {
    if (this.build) return this.build;
    let version: string | null = null;
    let commit: string | null =
      process.env.GIT_COMMIT?.trim() || process.env.APP_COMMIT?.trim() || null;
    try {
      const pkg = JSON.parse(
        await fs.readFile(join(process.cwd(), 'package.json'), 'utf8'),
      ) as { version?: string };
      version = pkg.version ?? null;
    } catch {
      version = null;
    }
    if (!commit) {
      try {
        const head = (
          await fs.readFile(join(process.cwd(), '.git', 'HEAD'), 'utf8')
        ).trim();
        const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
        commit = ref
          ? (await fs.readFile(join(process.cwd(), '.git', ref), 'utf8')).trim()
          : head;
      } catch {
        commit = null;
      }
    }
    this.build = { version, commit: commit ? commit.slice(0, 12) : null };
    return this.build;
  }
}

function tickView(t: JobTickRow) {
  return {
    job: t.job,
    instance: t.instance,
    ticked_at: t.ticked_at.toISOString(),
    outcome: t.outcome,
    payload: t.payload ?? null,
    ran_at: t.ran_at ? t.ran_at.toISOString() : null,
  };
}

/** Retention: the most recent completed run (any instance) with its per-task counts. */
function retentionFromTicks(ticks: JobTickRow[]) {
  const runs = ticks.filter((t) => t.job === 'retention');
  const last = runs
    .filter((t) => t.ran_at)
    .sort(
      (a, b) => (b.ran_at as Date).getTime() - (a.ran_at as Date).getTime(),
    )[0];
  const payload = (last?.ran_payload ?? null) as {
    results?: Record<string, unknown>;
    dry_run?: boolean;
  } | null;
  return {
    last_run_at: last?.ran_at ? last.ran_at.toISOString() : null,
    last_run_instance: last?.instance ?? null,
    dry_run: payload?.dry_run ?? null,
    tasks: payload?.results ?? null,
    instances: runs.map((t) => ({
      instance: t.instance,
      ticked_at: t.ticked_at.toISOString(),
      outcome: t.outcome,
    })),
  };
}

function withPaused(section: unknown, ticks: JobTickRow[], now: Date) {
  const workers = ticks
    .filter((t) => t.job === 'designer.print-queue')
    .map((t) => {
      const pausedUntil = Number(
        (t.payload as { paused_until?: unknown } | null)?.paused_until ?? 0,
      );
      return {
        instance: t.instance,
        ticked_at: t.ticked_at.toISOString(),
        paused_until:
          pausedUntil > now.getTime()
            ? new Date(pausedUntil).toISOString()
            : null,
      };
    });
  const base =
    section && typeof section === 'object'
      ? section
      : { error: String(section) };
  return {
    ...base,
    workers,
    paused_instances: workers
      .filter((w) => w.paused_until)
      .map((w) => w.instance),
  };
}

function withImporterTicks(section: unknown, ticks: JobTickRow[]) {
  const base =
    section && typeof section === 'object'
      ? section
      : { error: String(section) };
  return {
    ...base,
    workers: ticks
      .filter((t) => t.job === 'importer')
      .map((t) => ({
        instance: t.instance,
        ticked_at: t.ticked_at.toISOString(),
        outcome: t.outcome,
      })),
  };
}
