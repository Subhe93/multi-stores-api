import { Prisma } from '@prisma/client';
import { isPlainObject } from '../../common/personalization/rules';

/**
 * JSON with object keys sorted (jsonb does not keep key order, so a value
 * read back from Postgres must be compared by content, not by text).
 */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(',')}}`;
  }
  return v === undefined ? 'null' : JSON.stringify(v);
}

/** Deep equality of two JSON values (key order ignored, undefined = null). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a ?? null) === stableStringify(b ?? null);
}

/**
 * Field-name references in a top-level field's `conditions` (field-source
 * rules) and `repeat.lead.fields`, renamed `oldName` → `newName`. Returns
 * only the columns that changed.
 */
export function renameFieldReferences(
  row: { conditions: unknown; repeat: unknown },
  oldName: string,
  newName: string,
): { conditions?: Prisma.InputJsonValue; repeat?: Prisma.InputJsonValue } {
  const out: {
    conditions?: Prisma.InputJsonValue;
    repeat?: Prisma.InputJsonValue;
  } = {};
  const c = row.conditions;
  if (isPlainObject(c) && Array.isArray(c.rules)) {
    let changed = false;
    const rules = c.rules.map((r: unknown) => {
      if (isPlainObject(r) && r.source === 'field' && r.key === oldName) {
        changed = true;
        return { ...r, key: newName };
      }
      return r;
    });
    if (changed) out.conditions = { ...c, rules } as Prisma.InputJsonValue;
  }
  const rep = row.repeat;
  if (
    isPlainObject(rep) &&
    isPlainObject(rep.lead) &&
    Array.isArray(rep.lead.fields) &&
    rep.lead.fields.includes(oldName)
  ) {
    out.repeat = {
      ...rep,
      lead: {
        ...rep.lead,
        fields: rep.lead.fields.map((f: unknown) =>
          f === oldName ? newName : f,
        ),
      },
    } as Prisma.InputJsonValue;
  }
  return out;
}

/** A field row as the reference checks read it. */
export interface FieldRefRow {
  id: string;
  name: string;
  parent_id: string | null;
  linked_validation?: unknown;
  conditions?: unknown;
  repeat?: unknown;
}

/**
 * Names of the fields that reference `target` by name (or a legacy link by
 * id, or a legacy `target_field_id` that holds the name — the pre-K3
 * dashboard wrote names there, M5 A4): sibling `linked_validation.target`,
 * and for a top-level target the field-source conditions and
 * `repeat.lead.fields` of the other top-level fields. The target's own
 * children are ignored (deleted with it).
 */
export function fieldReferencesTo(
  target: { id: string; name: string; parent_id: string | null },
  rows: readonly FieldRefRow[],
): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.id === target.id || r.parent_id === target.id) continue;
    const sameSet = (r.parent_id ?? null) === target.parent_id;
    const link = r.linked_validation;
    if (sameSet && isPlainObject(link)) {
      const t = typeof link.target === 'string' ? link.target.trim() : '';
      const legacy =
        typeof link.target_field_id === 'string'
          ? link.target_field_id.trim()
          : '';
      if (
        t === target.name ||
        t === target.id ||
        legacy === target.id ||
        legacy === target.name
      ) {
        out.add(r.name);
      }
    }
    if (target.parent_id !== null || r.parent_id) continue;
    const c = r.conditions;
    if (
      isPlainObject(c) &&
      Array.isArray(c.rules) &&
      c.rules.some(
        (rule: unknown) =>
          isPlainObject(rule) &&
          rule.source === 'field' &&
          rule.key === target.name,
      )
    ) {
      out.add(r.name);
    }
    const rep = r.repeat;
    if (
      isPlainObject(rep) &&
      isPlainObject(rep.lead) &&
      Array.isArray(rep.lead.fields) &&
      rep.lead.fields.includes(target.name)
    ) {
      out.add(r.name);
    }
  }
  return [...out];
}
