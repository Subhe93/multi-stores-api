import {
  isRedirectStatusCode,
  normalizeRedirectPath,
  sanitizeRedirectTarget,
  targetHasQuery,
  targetKey,
} from './redirect-path.util';
import { resolveRedirectChain } from './redirect-chain';

// Pure planner of importer redirect writes (M4.4 §6.1). The importer's dry
// run and its apply step both call it, so PLAN == APPLY by construction;
// RedirectsService.bulkUpsertFromImport only executes the result.

export interface ExistingRedirectRow {
  id: string;
  from_path: string; // normalised
  to_path: string;
  status_code: number;
  source: 'IMPORT' | 'MANUAL';
  is_active: boolean;
}

export interface IncomingRedirect {
  from_path: string; // raw (normalised here)
  to_path: string;
  status_code?: number;
}

export type RedirectConflictCode =
  | 'REDIRECT_INVALID_PATH'
  | 'REDIRECT_CONFLICT' // a MANUAL row owns the from_path
  | 'REDIRECT_DUPLICATE' // the same from_path twice in one batch
  | 'REDIRECT_LOOP'
  | 'REDIRECT_LIMIT'; // past REDIRECT_MAX_ROWS_PER_STORE (importer batches)

export interface PlannedRedirect {
  action: 'CREATE' | 'UPDATE' | 'UNCHANGED';
  id: string | null; // existing row for UPDATE/UNCHANGED
  from_path: string;
  to_path: string; // final (chain-flattened) target
  status_code: number;
}

export interface RedirectConflict {
  from_path: string;
  to_path: string;
  code: RedirectConflictCode;
}

export interface RedirectRepoint {
  id: string;
  from_path: string;
  to_path: string; // new final target
}

export interface RedirectUpsertPlan {
  items: PlannedRedirect[];
  conflicts: RedirectConflict[];
  /** Existing IMPORT rows whose target became a redirect source (flattened). */
  repoints: RedirectRepoint[];
}

export function planRedirectUpserts(
  existing: readonly ExistingRedirectRow[],
  incoming: readonly IncomingRedirect[],
): RedirectUpsertPlan {
  const conflicts: RedirectConflict[] = [];
  const byFrom = new Map(existing.map((r) => [r.from_path, r]));

  // 1. Validate, dedupe within the batch, respect MANUAL rows.
  const accepted = new Map<string, { to: string; status: number }>();
  for (const row of incoming) {
    const from = normalizeRedirectPath(row.from_path);
    const to = sanitizeRedirectTarget(row.to_path);
    const status = row.status_code ?? 301;
    if (from === null || to === null || !isRedirectStatusCode(status)) {
      conflicts.push({
        from_path: row.from_path,
        to_path: row.to_path,
        code: 'REDIRECT_INVALID_PATH',
      });
      continue;
    }
    if (accepted.has(from)) {
      conflicts.push({
        from_path: from,
        to_path: to,
        code: 'REDIRECT_DUPLICATE',
      });
      continue;
    }
    if (byFrom.get(from)?.source === 'MANUAL') {
      conflicts.push({
        from_path: from,
        to_path: to,
        code: 'REDIRECT_CONFLICT',
      });
      continue;
    }
    accepted.set(from, { to, status });
  }

  // 2. Working map = active existing rows overlaid with the batch.
  const working = new Map<string, string>();
  for (const r of existing)
    if (r.is_active) working.set(r.from_path, r.to_path);
  for (const [from, v] of accepted) working.set(from, v.to);

  // 3. Drop rows that loop, in batch order (removing one row can break the
  //    cycle for the rows after it, which are then kept).
  for (const [from, v] of [...accepted]) {
    const res = resolveRedirectChain(working, from, v.to);
    if (!res.ok) {
      conflicts.push({ from_path: from, to_path: v.to, code: 'REDIRECT_LOOP' });
      accepted.delete(from);
      const prev = byFrom.get(from);
      if (prev?.is_active) working.set(from, prev.to_path);
      else working.delete(from);
    }
  }

  // 4. Final targets and actions.
  const items: PlannedRedirect[] = [];
  for (const [from, v] of accepted) {
    const res = resolveRedirectChain(working, from, v.to);
    const to = res.ok ? res.to : v.to;
    const prev = byFrom.get(from);
    let action: PlannedRedirect['action'] = 'CREATE';
    if (prev) {
      action =
        prev.to_path === to && prev.status_code === v.status && prev.is_active
          ? 'UNCHANGED'
          : 'UPDATE';
    }
    items.push({
      action,
      id: prev?.id ?? null,
      from_path: from,
      to_path: to,
      status_code: v.status,
    });
  }
  // Flattened targets must be visible to step 5.
  for (const it of items) working.set(it.from_path, it.to_path);

  // 5. Existing IMPORT rows not in the batch that now point at a source.
  const repoints: RedirectRepoint[] = [];
  for (const r of existing) {
    if (!r.is_active || r.source !== 'IMPORT' || accepted.has(r.from_path)) {
      continue;
    }
    if (targetHasQuery(r.to_path)) continue;
    const key = targetKey(r.to_path);
    if (key === null || !working.has(key)) continue;
    const res = resolveRedirectChain(working, r.from_path, r.to_path);
    if (res.ok && res.to !== r.to_path) {
      repoints.push({ id: r.id, from_path: r.from_path, to_path: res.to });
    }
  }

  return { items, conflicts, repoints };
}
