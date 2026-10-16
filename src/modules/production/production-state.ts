import type { ProductionStateName } from './production.types';

/**
 * NONE when there is nothing to produce, NOT_STARTED when nothing is done,
 * IN_PROGRESS while some checks are open, READY when every check is done.
 */
export function stateOf(total: number, done: number): ProductionStateName {
  if (total <= 0) return 'NONE';
  if (done <= 0) return 'NOT_STARTED';
  return done >= total ? 'READY' : 'IN_PROGRESS';
}

/** Progress of a set of checks; stale checks are kept for audit but not counted. */
export function summarize(
  checks: readonly { done: boolean; stale: boolean }[],
): { total: number; done: number; state: ProductionStateName } {
  let total = 0;
  let done = 0;
  for (const c of checks) {
    if (c.stale) continue;
    total++;
    if (c.done) done++;
  }
  return { total, done, state: stateOf(total, done) };
}
