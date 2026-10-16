import { createHash } from 'crypto';

/**
 * Stable hashing for the importer ledger (M4.4 D6): `source_hash` of a mapped
 * entity and `applied_hash` of the managed target fields. Object keys are
 * sorted; Prisma `Decimal` values are compared by their string form.
 */

function isDecimalLike(v: object): boolean {
  const d = v as {
    toFixed?: unknown;
    d?: unknown;
    constructor?: { name?: string };
  };
  return (
    typeof d.toFixed === 'function' &&
    (Array.isArray(d.d) || d.constructor?.name === 'Decimal')
  );
}

export function canonical(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (isDecimalLike(value)) return (value as { toString(): string }).toString();
  if (Array.isArray(value)) return value.map(canonical);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) continue;
    out[k] = canonical(v);
  }
  return out;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hashOf(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

/** Money / decimal as a fixed 2-decimal string (`"350.00"`), null for empty. */
export function money(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const n =
    typeof value === 'number'
      ? value
      : Number((value as { toString(): string }).toString());
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}
