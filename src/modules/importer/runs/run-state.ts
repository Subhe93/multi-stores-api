import { ImportRunStatus } from '@prisma/client';

/**
 * Run lifecycle (M4.4 D3): UPLOADED → PLANNING → PLANNED (dry run) →
 * confirm → QUEUED → RUNNING → COMPLETED / COMPLETED_WITH_WARNINGS / FAILED /
 * CANCELLED; rollback: ROLLBACK_QUEUED → ROLLING_BACK → ROLLED_BACK /
 * ROLLBACK_FAILED. Every status change goes through `assertTransition`.
 */

const S = ImportRunStatus;

export const RUN_TRANSITIONS: Readonly<
  Record<ImportRunStatus, readonly ImportRunStatus[]>
> = {
  [S.UPLOADED]: [S.PLANNING, S.CANCELLED],
  // Stale heartbeat → UPLOADED again (worker restart).
  [S.PLANNING]: [S.PLANNED, S.PLAN_FAILED, S.UPLOADED, S.CANCELLED],
  // Options edit → UPLOADED (re-plan); confirm → QUEUED.
  [S.PLANNED]: [S.QUEUED, S.UPLOADED, S.CANCELLED],
  [S.PLAN_FAILED]: [S.UPLOADED, S.CANCELLED],
  [S.QUEUED]: [S.RUNNING, S.CANCELLED],
  // Stale heartbeat → QUEUED (resume, attempt + 1).
  [S.RUNNING]: [
    S.COMPLETED,
    S.COMPLETED_WITH_WARNINGS,
    S.FAILED,
    S.CANCELLED,
    S.QUEUED,
  ],
  [S.COMPLETED]: [S.ROLLBACK_QUEUED],
  [S.COMPLETED_WITH_WARNINGS]: [S.ROLLBACK_QUEUED],
  [S.FAILED]: [S.ROLLBACK_QUEUED],
  [S.CANCELLED]: [S.ROLLBACK_QUEUED],
  [S.ROLLBACK_QUEUED]: [S.ROLLING_BACK],
  [S.ROLLING_BACK]: [S.ROLLED_BACK, S.ROLLBACK_FAILED, S.ROLLBACK_QUEUED],
  // A failed rollback may be retried.
  [S.ROLLBACK_FAILED]: [S.ROLLBACK_QUEUED],
  [S.ROLLED_BACK]: [],
};

/** Statuses covered by the partial unique index `ImportRun_one_active_per_store`. */
export const ACTIVE_RUN_STATUSES: readonly ImportRunStatus[] = [
  S.PLANNING,
  S.QUEUED,
  S.RUNNING,
  S.ROLLBACK_QUEUED,
  S.ROLLING_BACK,
];

/** Statuses in which the run is busy (the API refuses deletes and new runs). */
export const BUSY_RUN_STATUSES: readonly ImportRunStatus[] =
  ACTIVE_RUN_STATUSES;

/** Terminal statuses of an apply run (rollback may start from these). */
export const ROLLBACKABLE_STATUSES: readonly ImportRunStatus[] = [
  S.COMPLETED,
  S.COMPLETED_WITH_WARNINGS,
  S.FAILED,
  S.CANCELLED,
  S.ROLLBACK_FAILED,
];

/** Statuses a run can be cancelled from directly (no worker involved). */
export const DIRECT_CANCEL_STATUSES: readonly ImportRunStatus[] = [
  S.UPLOADED,
  S.PLANNED,
  S.PLAN_FAILED,
  S.QUEUED,
];

/** Statuses where cancel is a request the worker honours between batches. */
export const REQUEST_CANCEL_STATUSES: readonly ImportRunStatus[] = [
  S.PLANNING,
  S.RUNNING,
];

/** Statuses where `finished_at` is set. */
export const FINISHED_STATUSES: readonly ImportRunStatus[] = [
  S.PLAN_FAILED,
  S.COMPLETED,
  S.COMPLETED_WITH_WARNINGS,
  S.FAILED,
  S.CANCELLED,
  S.ROLLED_BACK,
  S.ROLLBACK_FAILED,
];

export function canTransition(
  from: ImportRunStatus,
  to: ImportRunStatus,
): boolean {
  return RUN_TRANSITIONS[from]?.includes(to) ?? false;
}

export class InvalidRunTransitionError extends Error {
  readonly code = 'IMPORT_RUN_INVALID_STATE';
  constructor(
    readonly from: ImportRunStatus,
    readonly to: ImportRunStatus,
  ) {
    super(`Invalid run transition ${from} → ${to}`);
    this.name = 'InvalidRunTransitionError';
  }
}

export function assertTransition(
  from: ImportRunStatus,
  to: ImportRunStatus,
): void {
  if (!canTransition(from, to)) throw new InvalidRunTransitionError(from, to);
}

export function isActiveStatus(status: ImportRunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}
