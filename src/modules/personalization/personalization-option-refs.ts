import { isPlainObject } from '@multi-stores/core/personalization/rules';
import { jsonEqual } from './personalization-json';

/**
 * Pure checks of a product's `variant_option_config` write against the
 * personalization app (M4.1 fixes): which personalization fields an option
 * rename or delete would break, and whether the write introduces the app's
 * variation-card keys (`style:'card'`, `valueMeta`).
 */

/** A field row as the option reference check reads it. */
export interface OptionRefField {
  id: string;
  name: string;
  parent_id: string | null;
  type: string;
  conditions?: unknown;
  pricing?: unknown;
  repeat?: unknown;
  ui?: unknown;
}

interface OptionShape {
  name: string;
  values: Set<string>;
  style: unknown;
  valueMeta: unknown;
}

/** Option name → its values and M4.1 keys (entries without a name are skipped). */
function optionsOf(config: unknown): Map<string, OptionShape> {
  const out = new Map<string, OptionShape>();
  if (!Array.isArray(config)) return out;
  for (const o of config as unknown[]) {
    if (!isPlainObject(o) || typeof o.name !== 'string' || o.name === '') {
      continue;
    }
    const values = Array.isArray(o.values)
      ? o.values.filter((v): v is string => typeof v === 'string')
      : [];
    out.set(o.name, {
      name: o.name,
      values: new Set(values),
      style: o.style,
      valueMeta: o.valueMeta,
    });
  }
  return out;
}

/** One reference of a field to an option (and optionally to one of its values). */
interface OptionRef {
  option: string;
  value?: string;
}

const STRING_OPS = new Set(['eq', 'neq', 'in', 'nin']);

/** Every option (and option value) a field's M4.1 config reads. */
export function optionReferencesOf(field: OptionRefField): OptionRef[] {
  const refs: OptionRef[] = [];
  const add = (option: unknown, value?: unknown) => {
    if (typeof option !== 'string' || option === '') return;
    if (value === undefined) refs.push({ option });
    else if (typeof value === 'string' || typeof value === 'number') {
      refs.push({ option, value: String(value) });
    }
  };
  const c = field.conditions;
  if (isPlainObject(c) && Array.isArray(c.rules)) {
    for (const rule of c.rules as unknown[]) {
      if (!isPlainObject(rule) || rule.source !== 'option') continue;
      add(rule.key);
      if (typeof rule.op === 'string' && STRING_OPS.has(rule.op)) {
        const values = Array.isArray(rule.value) ? rule.value : [rule.value];
        for (const v of values as unknown[]) {
          if (v !== undefined && v !== null) add(rule.key, v);
        }
      }
    }
  }
  const rep = field.repeat;
  if (isPlainObject(rep)) {
    if (isPlainObject(rep.count)) {
      const option = rep.count.option;
      add(option);
      if (isPlainObject(rep.count.map)) {
        for (const value of Object.keys(rep.count.map)) add(option, value);
      }
    }
    if (isPlainObject(rep.lead) && Array.isArray(rep.lead.options)) {
      for (const option of rep.lead.options as unknown[]) add(option);
    }
  }
  const ui = field.ui;
  const palette =
    isPlainObject(ui) && typeof ui.palette_from_option === 'string'
      ? ui.palette_from_option
      : null;
  if (palette) {
    add(palette);
    // A palette read from an option prices that option's values.
    const p = field.pricing;
    if (isPlainObject(p) && isPlainObject(p.option_prices)) {
      for (const value of Object.keys(p.option_prices)) add(palette, value);
    }
  }
  return refs;
}

/**
 * The fields whose option references worked with `oldConfig` and break
 * with `newConfig` (an option renamed or removed, or a referenced value
 * removed), and the option names involved. References that were already
 * broken before the write are not reported.
 */
export function brokenOptionReferences(
  fields: readonly OptionRefField[],
  oldConfig: unknown,
  newConfig: unknown,
): { fields: string[]; options: string[] } {
  const before = optionsOf(oldConfig);
  const after = optionsOf(newConfig);
  const fieldNames = new Set<string>();
  const optionNames = new Set<string>();
  const byId = new Map(fields.map((f) => [f.id, f]));
  for (const f of fields) {
    for (const ref of optionReferencesOf(f)) {
      const was = before.get(ref.option);
      if (!was) continue;
      if (ref.value !== undefined && !was.values.has(ref.value)) continue;
      const now = after.get(ref.option);
      const broken =
        !now || (ref.value !== undefined && !now.values.has(ref.value));
      if (!broken) continue;
      const parent = f.parent_id ? byId.get(f.parent_id) : undefined;
      fieldNames.add(parent ? `${parent.name}.${f.name}` : f.name);
      optionNames.add(ref.option);
    }
  }
  return { fields: [...fieldNames], options: [...optionNames] };
}

/** True when an option uses the variation cards (`style:'card'` or a non-empty `valueMeta`). */
function usesCards(o: OptionShape): boolean {
  return (
    o.style === 'card' ||
    (isPlainObject(o.valueMeta) && Object.keys(o.valueMeta).length > 0)
  );
}

/**
 * True when `newConfig` sets variation-card keys that are not the stored
 * ones (the app gate, "unchanged values accepted" like the custom-field
 * gate): a new `style:'card'`, or a `valueMeta` that differs from the
 * stored one of the same option. Removing them is always allowed.
 */
export function introducesCardConfig(
  oldConfig: unknown,
  newConfig: unknown,
): boolean {
  const before = optionsOf(oldConfig);
  for (const o of optionsOf(newConfig).values()) {
    if (!usesCards(o)) continue;
    const was = before.get(o.name);
    if (o.style === 'card' && was?.style !== 'card') return true;
    const meta =
      isPlainObject(o.valueMeta) && Object.keys(o.valueMeta).length > 0
        ? o.valueMeta
        : null;
    if (meta && !jsonEqual(meta, was?.valueMeta ?? null)) return true;
  }
  return false;
}
