import {
  fallbackRedirectPath,
  targetHasQuery,
  targetKey,
} from './redirect-path.util';

// Chain flattening and loop detection for store redirects (M4.4 §6.1):
// with A→B and B→C, A is stored as →C; a chain that comes back to its own
// source is a loop and is rejected. Pure, operates on an in-memory map.

/** Longest chain followed before giving up (REDIRECT_CHAIN_TOO_LONG, M5 B22). */
export const REDIRECT_MAX_HOPS = 20;

export type ChainFailureCode = 'REDIRECT_LOOP' | 'REDIRECT_CHAIN_TOO_LONG';

export type ChainResult =
  | { ok: true; to: string }
  | { ok: false; code: ChainFailureCode };

/**
 * Final target of `from → to` given the other active redirects
 * (`map`: normalised from_path → raw to_path).
 *
 * Flattening stops at a target with a query string or fragment (kept
 * verbatim) and at a target that only matches another row through its
 * fallback key (`/x/feed` → `/x`). The walk itself goes on as the browser
 * would follow it (the proxy matches on the path key, then the fallback key),
 * so a loop is still found through a query target or a fallback hop.
 */
export function resolveRedirectChain(
  map: ReadonlyMap<string, string>,
  from: string,
  to: string,
  maxHops = REDIRECT_MAX_HOPS,
): ChainResult {
  const seen = new Set<string>([from]);
  let current = to;
  // Set once flattening has to stop; the walk continues for loop detection.
  let final: string | null = null;
  for (let hop = 0; hop <= maxHops; hop++) {
    const key = targetKey(current);
    if (key === null) return { ok: true, to: final ?? current };
    const fallback = fallbackRedirectPath(key);
    if (seen.has(key)) return { ok: false, code: 'REDIRECT_LOOP' };
    const exact = map.get(key);
    // The proxy only tries the fallback key when there is no exact row.
    if (exact === undefined && fallback !== null && seen.has(fallback)) {
      return { ok: false, code: 'REDIRECT_LOOP' };
    }
    const next = exact ?? (fallback !== null ? map.get(fallback) : undefined);
    if (next === undefined) return { ok: true, to: final ?? current };
    if (targetHasQuery(current) || exact === undefined) final ??= current;
    seen.add(key);
    if (exact === undefined && fallback !== null) seen.add(fallback);
    current = next;
  }
  // More than `maxHops` rows without coming back to the source: not a loop,
  // but a chain the browser would give up on as well.
  return { ok: false, code: 'REDIRECT_CHAIN_TOO_LONG' };
}

/**
 * Sources whose target is exactly `from` (no query), i.e. the rows that must
 * be re-pointed to `finalTo` once `from → finalTo` is written. A row that
 * would then point at itself is left out.
 */
export function rowsPointingAt(
  map: ReadonlyMap<string, string>,
  from: string,
  finalTo: string,
): string[] {
  const finalKey = targetKey(finalTo);
  const out: string[] = [];
  for (const [source, to] of map) {
    if (source === from || source === finalKey) continue;
    if (targetHasQuery(to)) continue;
    if (targetKey(to) === from) out.push(source);
  }
  return out;
}
