/**
 * Generic retention job (M4.5 contracts C22/C23).
 *
 * One scheduler, many tasks: `RetentionModule` (`@Global`), `RetentionService`
 * (implements `RetentionRegistry`) and the hourly `RetentionScheduler` (copy
 * of the backup scheduler pattern: `setInterval` + `unref()`, an in-memory
 * `ticking` guard). Only one API instance runs at a time:
 * `pg_try_advisory_xact_lock(hashtext(RETENTION_LOCK_NAME))` taken in a
 * transaction that stays open for the run (transaction scoped, so it is safe
 * with a connection pool and is released even on a crash). Tasks:
 *   - `customer-uploads`           (M4.0, CustomerUploadsService.runRetention)
 *   - `designer.drafts|orphans|originals|files` (M4.2)
 *   - `importer.bundles`           (M4.4)
 * Admin: `POST /admin/retention/run?dry_run=1&task=<key>` (ADMIN).
 */

/** Advisory lock name: `SELECT pg_try_advisory_xact_lock(hashtext('m4-retention'))`. */
export const RETENTION_LOCK_NAME = 'm4-retention';

/** `RETENTION_SCHEDULER=off` disables the hourly scheduler (the admin endpoint still works). */
export const RETENTION_SCHEDULER_ENV = 'RETENTION_SCHEDULER';

export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/** Default batch size per task run. */
export const RETENTION_DEFAULT_LIMIT = 500;

export interface RetentionRunOptions {
  dryRun: boolean;
  limit: number;
  /**
   * Epoch ms by which the task must return: the locked run's transaction
   * times out then. Tasks stop early and leave the rest for the next run.
   */
  deadline?: number;
}

export interface RetentionTaskResult {
  purged: number;
  skipped: number;
  errors: number;
  /** Task-specific counters, e.g. `{ purgedAttached, purgedOrphans, skippedOpenOrders }`. */
  details?: Record<string, number>;
}

export interface RetentionTask {
  /** Unique key, e.g. `customer-uploads`, `designer.drafts`, `importer.bundles`. */
  key: string;
  run(now: Date, opts: RetentionRunOptions): Promise<RetentionTaskResult>;
}

/** What other modules depend on (implemented by WP-B's `RetentionService`). */
export interface RetentionRegistry {
  /** Registers a task; a second task with the same key replaces the first. */
  registerTask(task: RetentionTask): void;
  /**
   * Runs every registered task (or only `opts.task`). A task that throws is
   * reported as `{ purged: 0, skipped: 0, errors: 1 }` and never stops the others.
   */
  runAll(
    now?: Date,
    opts?: Partial<RetentionRunOptions> & { task?: string },
  ): Promise<Record<string, RetentionTaskResult>>;
}
