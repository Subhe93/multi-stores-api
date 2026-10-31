import { resolveRedirectChain } from './redirect-chain';
import {
  normalizeRedirectPath,
  sanitizeRedirectTarget,
  targetHasQuery,
  targetKey,
} from './redirect-path.util';
import type { ExistingRedirectRow } from './redirect-plan';

// Old-slug redirects (WP `_wp_old_slug`, plans/slug-wp-rules PLAN §6): when
// the public path of a published product, collection or root page changes,
// the old path 301s to the new one in one hop. Pure planner; the writes run in
// RedirectsService.applySlugChangeRedirects.

/** One public path that moved (both on the same store host). */
export interface SlugMove {
  from: string;
  to: string;
}

export type SlugRedirectConflictCode =
  | 'REDIRECT_INVALID_PATH'
  | 'REDIRECT_CONFLICT' // a MANUAL row owns the old path: left alone
  | 'REDIRECT_SHADOWS_TARGET' // a MANUAL row redirects away from the new path
  | 'REDIRECT_LOOP'
  | 'REDIRECT_CHAIN_TOO_LONG';

export interface SlugRedirectConflict {
  from_path: string;
  to_path: string;
  code: SlugRedirectConflictCode;
}

export interface SlugRedirectPlan {
  /** New rows (`from_path` normalised, `to_path` final). */
  creates: { from_path: string; to_path: string }[];
  /** Existing non-MANUAL rows of an old path, rewritten to the new target. */
  updates: { id: string; from_path: string; to_path: string }[];
  /** Active non-MANUAL rows whose source is a new (now live) path. */
  deactivations: { id: string; from_path: string }[];
  /** Active rows whose target was an old path, re-pointed (no chain). */
  repoints: { id: string; from_path: string; to_path: string }[];
  conflicts: SlugRedirectConflict[];
}

/**
 * Plans the rows for a batch of path moves against the store's current rows:
 *
 * 1. The new paths are live now: an active IMPORT / SLUG_CHANGE row whose
 *    source is a new path would shadow the entity and is switched off (a
 *    rename back, a→b then b→a). A MANUAL one is the merchant's: reported.
 * 2. `old → new` is written (created, or an existing non-MANUAL row of the
 *    old path is rewritten). A MANUAL row on the old path is never touched.
 * 3. Chains are flattened and loops dropped (resolveRedirectChain).
 * 4. Every active row (MANUAL included, like a merchant write) whose target
 *    was an old path is re-pointed to the final target in one hop, unless
 *    that would make it point at itself.
 */
export function planSlugChangeRedirects(
  existing: readonly ExistingRedirectRow[],
  moves: readonly SlugMove[],
): SlugRedirectPlan {
  const plan: SlugRedirectPlan = {
    creates: [],
    updates: [],
    deactivations: [],
    repoints: [],
    conflicts: [],
  };
  const byFrom = new Map(existing.map((r) => [r.from_path, r]));

  // Valid, de-duplicated moves (the last move of a path wins).
  const accepted = new Map<string, string>();
  for (const m of moves) {
    const from = normalizeRedirectPath(m.from);
    const to = sanitizeRedirectTarget(m.to);
    const toKey = to === null ? null : targetKey(to);
    if (from === null || to === null || toKey === null) {
      plan.conflicts.push({
        from_path: m.from,
        to_path: m.to,
        code: 'REDIRECT_INVALID_PATH',
      });
      continue;
    }
    if (from === toKey) continue; // same public path: nothing moved
    accepted.set(from, to);
  }
  const newKeys = new Set([...accepted.values()].map((t) => targetKey(t)!));
  // A path that is a new target and an old source in the same batch (a
  // swap) stays a source: the move decides it.
  for (const k of [...newKeys]) if (accepted.has(k)) newKeys.delete(k);

  // 1. Switch off rows that would shadow a new path.
  const deactivated = new Set<string>();
  for (const r of existing) {
    if (!r.is_active || !newKeys.has(r.from_path)) continue;
    if (r.source === 'MANUAL') {
      plan.conflicts.push({
        from_path: r.from_path,
        to_path: r.to_path,
        code: 'REDIRECT_SHADOWS_TARGET',
      });
      continue;
    }
    deactivated.add(r.id);
    plan.deactivations.push({ id: r.id, from_path: r.from_path });
  }

  // 2. Respect MANUAL rows on an old path.
  for (const [from, to] of [...accepted]) {
    if (byFrom.get(from)?.source === 'MANUAL') {
      plan.conflicts.push({
        from_path: from,
        to_path: to,
        code: 'REDIRECT_CONFLICT',
      });
      accepted.delete(from);
    }
  }

  // 3. Working map = active rows (minus the switched-off ones) + the moves.
  const working = new Map<string, string>();
  for (const r of existing)
    if (r.is_active && !deactivated.has(r.id))
      working.set(r.from_path, r.to_path);
  for (const [from, to] of accepted) working.set(from, to);
  for (const [from, to] of [...accepted]) {
    const res = resolveRedirectChain(working, from, to);
    if (!res.ok) {
      plan.conflicts.push({ from_path: from, to_path: to, code: res.code });
      accepted.delete(from);
      const prev = byFrom.get(from);
      if (prev?.is_active && !deactivated.has(prev.id))
        working.set(from, prev.to_path);
      else working.delete(from);
    }
  }
  const finals = new Map<string, string>();
  for (const [from, to] of accepted) {
    const res = resolveRedirectChain(working, from, to);
    finals.set(from, res.ok ? res.to : to);
  }
  for (const [from, to] of finals) {
    working.set(from, to);
    const prev = byFrom.get(from);
    if (prev) plan.updates.push({ id: prev.id, from_path: from, to_path: to });
    else plan.creates.push({ from_path: from, to_path: to });
  }

  // 4. Re-point rows that targeted an old path.
  for (const r of existing) {
    if (!r.is_active || deactivated.has(r.id) || finals.has(r.from_path))
      continue;
    if (targetHasQuery(r.to_path)) continue;
    const key = targetKey(r.to_path);
    if (key === null || !finals.has(key)) continue;
    const res = resolveRedirectChain(working, r.from_path, r.to_path);
    if (!res.ok) continue;
    if (targetKey(res.to) === r.from_path || res.to === r.to_path) continue;
    plan.repoints.push({ id: r.id, from_path: r.from_path, to_path: res.to });
  }
  return plan;
}
