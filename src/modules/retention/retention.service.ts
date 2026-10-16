import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  RETENTION_DEFAULT_LIMIT,
  RETENTION_LOCK_NAME,
  type RetentionRegistry,
  type RetentionRunOptions,
  type RetentionTask,
  type RetentionTaskResult,
} from './retention.types';

/**
 * Upper bound for one locked run. The advisory lock is transaction scoped
 * and the transaction stays open while the tasks run, so the lock is always
 * released (commit, rollback or a dropped connection), even on a crash.
 */
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
/** Tasks must be done this long before the transaction times out (commit time). */
const RUN_DEADLINE_MARGIN_MS = 60 * 1000;

export interface RetentionRunOutcome {
  /** False when another instance (DB lock) or another run in this process holds the job. */
  acquired: boolean;
  results: Record<string, RetentionTaskResult>;
}

export class UnknownRetentionTaskError extends Error {
  constructor(readonly task: string) {
    super(`Unknown retention task: ${task}`);
    this.name = 'UnknownRetentionTaskError';
  }
}

/**
 * Generic retention job (M4.5 C22): one registry of tasks, run hourly by
 * `RetentionScheduler` or on demand from the admin endpoint. Only one run at a
 * time: an in-memory guard inside the process and
 * `pg_try_advisory_xact_lock(hashtext('m4-retention'))` across API instances.
 */
@Injectable()
export class RetentionService implements RetentionRegistry {
  private readonly logger = new Logger(RetentionService.name);
  private readonly tasks = new Map<string, RetentionTask>();
  /** In-memory guard so the scheduler and the admin endpoint never overlap. */
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  registerTask(task: RetentionTask): void {
    if (this.tasks.has(task.key)) {
      this.logger.warn(`Retention task "${task.key}" replaced`);
    }
    this.tasks.set(task.key, task);
  }

  taskKeys(): string[] {
    return [...this.tasks.keys()].sort();
  }

  async runAll(
    now: Date = new Date(),
    opts: Partial<RetentionRunOptions> & { task?: string } = {},
  ): Promise<Record<string, RetentionTaskResult>> {
    return (await this.run(now, opts)).results;
  }

  /**
   * Runs the tasks under the lock. When the lock is held elsewhere nothing
   * runs and `acquired` is false. Throws `UnknownRetentionTaskError` for an
   * unknown `opts.task`.
   */
  async run(
    now: Date = new Date(),
    opts: Partial<RetentionRunOptions> & { task?: string } = {},
  ): Promise<RetentionRunOutcome> {
    const selected = this.select(opts.task);
    const runOpts: RetentionRunOptions = {
      dryRun: opts.dryRun === true,
      limit:
        opts.limit && opts.limit > 0
          ? Math.floor(opts.limit)
          : RETENTION_DEFAULT_LIMIT,
    };
    if (this.running) return { acquired: false, results: {} };
    this.running = true;
    try {
      let outcome: RetentionRunOutcome = { acquired: false, results: {} };
      const txStarted = Date.now();
      await this.prisma.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(hashtext(${RETENTION_LOCK_NAME})) AS locked`;
          if (!rows[0]?.locked) return;
          // Deadline from the moment the transaction (and its timeout) began.
          const deadline = txStarted + RUN_TIMEOUT_MS - RUN_DEADLINE_MARGIN_MS;
          outcome = {
            acquired: true,
            results: await this.runTasks(selected, now, {
              ...runOpts,
              deadline,
            }),
          };
        },
        { maxWait: 10_000, timeout: RUN_TIMEOUT_MS },
      );
      if (!outcome.acquired) {
        this.logger.log(
          'Retention run skipped: another instance holds the lock',
        );
      }
      return outcome;
    } finally {
      this.running = false;
    }
  }

  private select(task?: string): RetentionTask[] {
    if (task) {
      const t = this.tasks.get(task);
      if (!t) throw new UnknownRetentionTaskError(task);
      return [t];
    }
    return [...this.tasks.values()];
  }

  private async runTasks(
    tasks: RetentionTask[],
    now: Date,
    opts: RetentionRunOptions,
  ): Promise<Record<string, RetentionTaskResult>> {
    const results: Record<string, RetentionTaskResult> = {};
    for (const task of tasks) {
      if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
        this.logger.warn(
          `Retention ${task.key} skipped: run deadline reached (next run continues)`,
        );
        results[task.key] = { purged: 0, skipped: 0, errors: 0 };
        continue;
      }
      try {
        results[task.key] = await task.run(now, opts);
        const r = results[task.key];
        if (r.purged || r.errors) {
          this.logger.log(
            `Retention ${task.key}${opts.dryRun ? ' (dry run)' : ''}: purged ${r.purged}, skipped ${r.skipped}, errors ${r.errors}`,
          );
        }
      } catch (err) {
        this.logger.error(
          `Retention task ${task.key} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        results[task.key] = { purged: 0, skipped: 0, errors: 1 };
      }
    }
    return results;
  }
}
