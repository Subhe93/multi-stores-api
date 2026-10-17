import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  ImportLogLevel,
  ImportRunStatus,
  type ImportRun,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { StoreAppsService } from '../../store-apps/store-apps.service';
import {
  formatRunError,
  ImportRunError,
  isUniqueViolation,
} from '../importer.errors';
import {
  ImportEngineService,
  RunCancelledError,
} from './import-engine.service';
import { ACTIVE_RUN_STATUSES, assertTransition } from './run-state';
import { logJobTick } from '../../../common/ops/job-log';

/**
 * In-process importer worker (M4.4 D4, §9.2): a 5 s unref'd tick claims the
 * oldest UPLOADED (→ PLANNING), QUEUED (→ RUNNING) or ROLLBACK_QUEUED
 * (→ ROLLING_BACK) run with a conditional `updateMany` (count must be 1),
 * sends a heartbeat every 15 s and between batches, honours cancel requests
 * between batches and fails a run after 6 h. A RUNNING run with a heartbeat
 * older than 120 s is requeued (attempt + 1, FAILED after 3) — safe because
 * every write is idempotent. `IMPORTER_WORKER=off` disables the timers.
 * Global concurrency 1 per process.
 *
 * Attempt caps (fix 7): a stale PLANNING run goes back to UPLOADED and a
 * stale ROLLING_BACK run to ROLLBACK_QUEUED with attempt + 1, and ends
 * PLAN_FAILED / ROLLBACK_FAILED (`IMPORT_RUN_INTERRUPTED`) at the third.
 * A run claimed while the store's importer app is disabled is treated like a
 * cancel (`IMPORT_APP_DISABLED`); rollbacks still run (they only clean up).
 *
 * Multi-instance (fix 20): several API processes may run this worker. A run
 * belongs to one worker at a time — claims are a conditional `updateMany`
 * (count must be 1), every checkpoint verifies `worker_id` (a taken-over run
 * stops with IMPORT_RUN_INTERRUPTED) and every status write is guarded by
 * status + worker. The partial unique index `ImportRun_one_active_per_store`
 * keeps one active run per store, and every apply write is idempotent
 * (ledger + APPLY items) so a takeover resumes from the cursor. Shipping
 * profiles are additionally created under a per-creator advisory lock.
 * `IMPORTER_WORKER=off` on all but one instance is still the simplest setup.
 */

export const WORKER_TICK_MS = 5_000;
export const HEARTBEAT_MS = 15_000;
export const STALE_AFTER_MS = 120_000;
export const MAX_ATTEMPTS = 3;
export const RUN_WALL_CLOCK_MS = 6 * 60 * 60 * 1000;
export const PLANNING_LIMIT_MS = 10 * 60 * 1000;

const CLAIMS: readonly { from: ImportRunStatus; to: ImportRunStatus }[] = [
  { from: ImportRunStatus.ROLLBACK_QUEUED, to: ImportRunStatus.ROLLING_BACK },
  { from: ImportRunStatus.QUEUED, to: ImportRunStatus.RUNNING },
  { from: ImportRunStatus.UPLOADED, to: ImportRunStatus.PLANNING },
];

@Injectable()
export class ImportWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImportWorkerService.name);
  readonly workerId = `importer-${randomUUID()}`;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: ImportEngineService,
    @Optional() private readonly apps?: StoreAppsService,
  ) {}

  static enabled(): boolean {
    return (process.env.IMPORTER_WORKER ?? '').toLowerCase() !== 'off';
  }

  async onModuleInit(): Promise<void> {
    if (!ImportWorkerService.enabled()) return;
    await this.requeueStale().catch((e: unknown) =>
      this.logger.warn(`stale requeue failed: ${String(e)}`),
    );
    this.timer = setInterval(() => void this.tick(), WORKER_TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Stale runs (worker died), attempt + 1 each time, capped at MAX_ATTEMPTS:
   * RUNNING → QUEUED / FAILED; PLANNING → UPLOADED / PLAN_FAILED;
   * ROLLING_BACK → ROLLBACK_QUEUED / ROLLBACK_FAILED.
   */
  async requeueStale(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
    const stale = await this.prisma.importRun.findMany({
      where: {
        status: {
          in: [
            ImportRunStatus.RUNNING,
            ImportRunStatus.PLANNING,
            ImportRunStatus.ROLLING_BACK,
          ],
        },
        OR: [{ heartbeat_at: null }, { heartbeat_at: { lt: cutoff } }],
      },
    });
    let n = 0;
    for (const run of stale) {
      const exhausted = run.attempt + 1 >= MAX_ATTEMPTS;
      const failed = {
        error: 'IMPORT_RUN_INTERRUPTED: the worker stopped too many times',
        finished_at: now,
      };
      let data: Record<string, unknown>;
      if (run.status === ImportRunStatus.RUNNING) {
        data = exhausted
          ? { status: ImportRunStatus.FAILED, ...failed }
          : { status: ImportRunStatus.QUEUED, attempt: run.attempt + 1 };
      } else if (run.status === ImportRunStatus.PLANNING) {
        data = exhausted
          ? { status: ImportRunStatus.PLAN_FAILED, ...failed }
          : { status: ImportRunStatus.UPLOADED, attempt: run.attempt + 1 };
      } else {
        data = exhausted
          ? { status: ImportRunStatus.ROLLBACK_FAILED, ...failed }
          : {
              status: ImportRunStatus.ROLLBACK_QUEUED,
              attempt: run.attempt + 1,
            };
      }
      const res = await this.prisma.importRun.updateMany({
        where: {
          id: run.id,
          status: run.status,
          heartbeat_at: run.heartbeat_at,
        },
        data: { ...data, worker_id: null, heartbeat_at: null },
      });
      n += res.count;
    }
    return n;
  }

  /** One scheduler tick; never overlaps itself. Returns the run it worked on. */
  async tick(): Promise<string | null> {
    if (this.ticking || this.stopping) return null;
    this.ticking = true;
    try {
      await this.requeueStale();
      const run = await this.claimNext();
      logJobTick('importer', {
        outcome: run ? 'ran' : 'idle',
        run_id: run?.id ?? null,
        run_status: run?.status ?? null,
      });
      if (!run) return null;
      await this.process(run);
      return run.id;
    } catch (e) {
      this.logger.error(`importer tick failed: ${String(e)}`);
      return null;
    } finally {
      this.ticking = false;
    }
  }

  /** Atomic claim of the oldest claimable run (count == 1 wins). */
  async claimNext(): Promise<ImportRun | null> {
    for (const { from, to } of CLAIMS) {
      const candidates = await this.prisma.importRun.findMany({
        where: { status: from },
        orderBy: { created_at: 'asc' },
        take: 5,
      });
      for (const c of candidates) {
        assertTransition(from, to);
        try {
          const now = new Date();
          const res = await this.prisma.importRun.updateMany({
            where: { id: c.id, status: from },
            data: {
              status: to,
              worker_id: this.workerId,
              heartbeat_at: now,
              ...(to === ImportRunStatus.RUNNING && !c.started_at
                ? { started_at: now }
                : {}),
            },
          });
          if (res.count === 1)
            return {
              ...c,
              status: to,
              worker_id: this.workerId,
              heartbeat_at: now,
            };
        } catch (e) {
          // UPLOADED → PLANNING may hit the one-active-run index: wait for the other run.
          if (isUniqueViolation(e)) continue;
          throw e;
        }
      }
    }
    return null;
  }

  private async setStatus(
    run: ImportRun,
    to: ImportRunStatus,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    assertTransition(run.status, to);
    await this.prisma.importRun.updateMany({
      where: { id: run.id, status: run.status, worker_id: this.workerId },
      data: { status: to, worker_id: null, heartbeat_at: null, ...extra },
    });
  }

  /** False when the store's importer app was switched off (fix 7). */
  private async appEnabled(storeId: string): Promise<boolean> {
    if (!this.apps) return true;
    try {
      return await this.apps.isEnabled(storeId, 'importer');
    } catch {
      return true;
    }
  }

  /** Runs the claimed work with heartbeats; maps errors to the final status. */
  async process(run: ImportRun): Promise<void> {
    if (
      run.status !== ImportRunStatus.ROLLING_BACK &&
      !(await this.appEnabled(run.store_id))
    ) {
      await this.engine
        .log(
          run.id,
          ImportLogLevel.WARN,
          'IMPORT_APP_DISABLED',
          'The importer app is disabled for this store; the run was cancelled',
        )
        .catch(() => undefined);
      await this.setStatus(run, ImportRunStatus.CANCELLED, {
        finished_at: new Date(),
        error: 'IMPORT_APP_DISABLED: the importer app is disabled',
      });
      return;
    }
    const startedAt = run.started_at?.getTime() ?? Date.now();
    const limit =
      run.status === ImportRunStatus.PLANNING
        ? PLANNING_LIMIT_MS
        : RUN_WALL_CLOCK_MS;
    const claimStart =
      run.status === ImportRunStatus.PLANNING ? Date.now() : startedAt;
    const beat = async () => {
      await this.prisma.importRun.updateMany({
        where: { id: run.id, worker_id: this.workerId },
        data: { heartbeat_at: new Date() },
      });
    };
    const heartbeat = setInterval(
      () => void beat().catch(() => undefined),
      HEARTBEAT_MS,
    );
    heartbeat.unref();
    const checkpoint = async () => {
      await beat();
      const cur = await this.prisma.importRun.findUnique({
        where: { id: run.id },
        select: { cancel_requested_at: true, worker_id: true },
      });
      if (cur?.worker_id !== this.workerId)
        throw new ImportRunError(
          'IMPORT_RUN_INTERRUPTED',
          'The run was taken over',
        );
      if (
        cur?.cancel_requested_at &&
        run.status !== ImportRunStatus.ROLLING_BACK
      )
        throw new RunCancelledError();
      if (Date.now() - claimStart > limit)
        throw new ImportRunError('IMPORT_RUN_TIMEOUT', 'The run took too long');
    };
    try {
      if (run.status === ImportRunStatus.PLANNING) {
        try {
          // Writes PLANNED itself (guarded by status + worker) and releases the claim.
          await this.engine.executePlanning(run.id, {
            checkpoint,
            workerId: this.workerId,
          });
        } catch (e) {
          if (e instanceof RunCancelledError)
            await this.setStatus(run, ImportRunStatus.CANCELLED, {
              finished_at: new Date(),
              error: formatRunError(e),
            });
          else
            await this.setStatus(run, ImportRunStatus.PLAN_FAILED, {
              finished_at: new Date(),
              error: formatRunError(e),
            });
        }
      } else if (run.status === ImportRunStatus.RUNNING) {
        try {
          const status = await this.engine.executeApply(run.id, {
            checkpoint,
            workerId: this.workerId,
          });
          // A FAILED outcome keeps the error the engine wrote (fix 19).
          await this.setStatus(run, status, {
            finished_at: new Date(),
            ...(status === ImportRunStatus.FAILED ? {} : { error: null }),
          });
        } catch (e) {
          if (e instanceof RunCancelledError) {
            await this.engine.log(
              run.id,
              ImportLogLevel.WARN,
              'IMPORT_RUN_CANCELLED',
              'Cancelled between batches; finished work can be rolled back',
            );
            await this.setStatus(run, ImportRunStatus.CANCELLED, {
              finished_at: new Date(),
            });
          } else {
            await this.engine
              .log(
                run.id,
                ImportLogLevel.ERROR,
                (e as { code?: string }).code ?? 'IMPORT_RUN_FAILED',
                formatRunError(e),
              )
              .catch(() => undefined);
            await this.setStatus(run, ImportRunStatus.FAILED, {
              finished_at: new Date(),
              error: formatRunError(e),
            });
          }
        }
      } else if (run.status === ImportRunStatus.ROLLING_BACK) {
        try {
          await this.engine.executeRollback(run.id, {
            checkpoint,
            workerId: this.workerId,
          });
          await this.setStatus(run, ImportRunStatus.ROLLED_BACK, {
            finished_at: new Date(),
          });
        } catch (e) {
          await this.setStatus(run, ImportRunStatus.ROLLBACK_FAILED, {
            finished_at: new Date(),
            error: formatRunError(e),
          });
        }
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** True when the store has a run in an active status (API pre-check; the index is the real guard). */
  async hasActiveRun(storeId: string): Promise<boolean> {
    const n = await this.prisma.importRun.count({
      where: { store_id: storeId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    });
    return n > 0;
  }
}
