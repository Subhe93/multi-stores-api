import type { NMechanism } from '../../../model/normalized';
import { maybeUnserialize } from '../php-unserialize';
import type { MetaBag, WpPpomRow } from '../wp-tables';

/**
 * PPOM (`wp_nm_personalized`, Discovery C §6). A product links PPOM rows via
 * `_product_meta_id` (serialized int array, or a bare id). Only `checkbox`
 * fields are supported (→ `checkbox_group`); anything else is reported as
 * `broken` so it is never applied silently. Option ids are mangled by PPOM
 * (`_studentmssa`), so labels are used, not ids.
 */

export const PPOM_META_KEYS = ['_product_meta_id'] as const;

export function ppomIdsOf(meta: MetaBag): number[] {
  const raw = meta.first('_product_meta_id');
  if (raw === undefined || raw === null || raw.trim() === '') return [];
  const parsed = maybeUnserialize(raw);
  const v = parsed.ok ? parsed.value : raw;
  const list = Array.isArray(v)
    ? v
    : typeof v === 'object' && v !== null
      ? Object.values(v)
      : [v];
  return list
    .map((x) => Number.parseInt(String(x), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function str(v: unknown): string {
  return typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : '';
}

export function detectPpom(meta: MetaBag, rows: WpPpomRow[]): NMechanism[] {
  const out: NMechanism[] = [];
  for (const id of ppomIdsOf(meta)) {
    const row = rows.find((r) => r.id === id);
    if (!row) {
      out.push({
        kind: 'broken',
        detector: 'ppom',
        reason: `PPOM field group ${id} is not in the bundle`,
      });
      continue;
    }
    if (!row.fields) {
      out.push({
        kind: 'broken',
        detector: 'ppom',
        reason: `PPOM field group ${id} could not be read`,
      });
      continue;
    }
    for (const field of Object.values(row.fields)) {
      if (!field || typeof field !== 'object') continue;
      if (str(field.status) === 'off') continue;
      const type = str(field.type);
      if (type !== 'checkbox') {
        out.push({
          kind: 'broken',
          detector: 'ppom',
          reason: `PPOM field type "${type}" is not supported`,
        });
        continue;
      }
      const checked = new Set(
        str(field.checked)
          .split(/\r?\n|\r/)
          .map((s) => s.trim())
          .filter(Boolean),
      );
      const options = (Array.isArray(field.options) ? field.options : [])
        .map((o) => str((o as Record<string, unknown>)?.option).trim())
        .filter(Boolean)
        .map((label) => ({ label, checked: checked.has(label) }));
      if (!options.length) {
        out.push({
          kind: 'broken',
          detector: 'ppom',
          reason: `PPOM checkbox "${str(field.title)}" has no options`,
        });
        continue;
      }
      out.push({
        kind: 'checkbox_group',
        detector: 'ppom',
        label: str(field.title) || row.name,
        options,
      });
    }
  }
  return out;
}
