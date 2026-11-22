/**
 * M159: display labels of variant option names / values per locale.
 *
 * Canonical keys (ProductVariant.options, carts, orders, image maps, facet
 * values, URLs) always stay the store primary-locale strings. This module is a
 * pure display layer on top: `ProductTranslation.variant_option_labels` maps a
 * name to its label and (name, value) to its label for one locale. A missing
 * label falls back to the canonical string, never to another locale.
 *
 * Pure (no Prisma / Nest). The storefront keeps a read-side mirror in
 * multi-stores-web/src/lib/variantOptionLabels.ts — keep in step.
 */

export interface VariantOptionLabels {
  names?: Record<string, string>;
  values?: Record<string, Record<string, string>>;
}

export interface OptionDisplayEntry {
  name: string;
  value: string;
  name_label: string;
  value_label: string;
}

export interface OptionsDisplaySnapshot {
  locale: string;
  entries: OptionDisplayEntry[];
}

export interface LabelRow {
  locale: string;
  variant_option_labels?: unknown;
}

export const OPTION_NAME_LABEL_MAX = 80;
export const OPTION_VALUE_LABEL_MAX = 120;
export const OPTION_NAME_LABELS_MAX_COUNT = 30;
export const OPTION_VALUE_LABELS_MAX_COUNT = 400;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const hasOwn = (o: object, k: string): boolean => Object.hasOwn(o, k);

/** Text of a stored option value (variant maps hold strings). */
const valueText = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'object'
      ? JSON.stringify(v)
      : String(v as number);

/** Defensive parse of the stored column: drops non-strings and empty maps. */
export function readVariantOptionLabels(
  raw: unknown,
): VariantOptionLabels | null {
  if (!isPlainObject(raw)) return null;
  const names: Record<string, string> = {};
  if (isPlainObject(raw.names)) {
    for (const [k, v] of Object.entries(raw.names)) {
      if (typeof v === 'string' && v !== '') names[k] = v;
    }
  }
  const values: Record<string, Record<string, string>> = {};
  if (isPlainObject(raw.values)) {
    for (const [name, map] of Object.entries(raw.values)) {
      if (!isPlainObject(map)) continue;
      const inner: Record<string, string> = {};
      for (const [k, v] of Object.entries(map)) {
        if (typeof v === 'string' && v !== '') inner[k] = v;
      }
      if (Object.keys(inner).length > 0) values[name] = inner;
    }
  }
  const out: VariantOptionLabels = {};
  if (Object.keys(names).length > 0) out.names = names;
  if (Object.keys(values).length > 0) out.values = values;
  return out.names || out.values ? out : null;
}

const baseLanguage = (locale: string) => locale.split(/[-_]/)[0].toLowerCase();

/**
 * Labels of `locale` from a product's translation rows: the row with exactly
 * that locale, else the row of its base language (`de-AT` -> `de`). Never an
 * `en` / first-row fallback (missing = canonical, no mixed languages).
 */
export function labelsForLocale(
  rows: readonly LabelRow[] | null | undefined,
  locale: string | null | undefined,
): VariantOptionLabels | null {
  if (!rows || !locale) return null;
  const exact = rows.find((r) => r.locale === locale);
  if (exact) {
    const parsed = readVariantOptionLabels(exact.variant_option_labels);
    if (parsed) return parsed;
  }
  const base = baseLanguage(locale);
  const baseRow = rows.find(
    (r) => r.locale !== locale && r.locale.toLowerCase() === base,
  );
  return baseRow
    ? readVariantOptionLabels(baseRow.variant_option_labels)
    : null;
}

export function optionNameLabel(
  labels: VariantOptionLabels | null | undefined,
  name: string,
): string {
  const l = labels?.names;
  return l && hasOwn(l, name) && l[name] ? l[name] : name;
}

export function optionValueLabel(
  labels: VariantOptionLabels | null | undefined,
  name: string,
  value: string,
): string {
  const map =
    labels?.values && hasOwn(labels.values, name) ? labels.values[name] : null;
  return map && hasOwn(map, value) && map[value] ? map[value] : value;
}

/** One entry per option of the map, in map order. Non-string values are skipped. */
export function optionDisplayEntries(
  options: unknown,
  labels: VariantOptionLabels | null | undefined,
): OptionDisplayEntry[] {
  if (!isPlainObject(options)) return [];
  const out: OptionDisplayEntry[] = [];
  for (const [name, raw] of Object.entries(options)) {
    if (raw === null || raw === undefined) continue;
    const value = valueText(raw);
    out.push({
      name,
      value,
      name_label: optionNameLabel(labels, name),
      value_label: optionValueLabel(labels, name, value),
    });
  }
  return out;
}

/** `"Farbe: Schwarz / Größe: M"` (the existing `k: v / k: v` format). */
export function formatOptionPairs(
  entries: readonly OptionDisplayEntry[],
): string {
  return entries.map((e) => `${e.name_label}: ${e.value_label}`).join(' / ');
}

/** `"Schwarz / M"` (the Kustom line-name format). */
export function formatOptionValues(
  entries: readonly OptionDisplayEntry[],
): string {
  return entries.map((e) => e.value_label).join(' / ');
}

/** Order-line display snapshot, or null when no label differs from canonical. */
export function buildOptionsDisplaySnapshot(
  options: unknown,
  labels: VariantOptionLabels | null | undefined,
  locale: string | null | undefined,
): OptionsDisplaySnapshot | null {
  if (!labels || !locale) return null;
  const entries = optionDisplayEntries(options, labels);
  if (entries.length === 0) return null;
  const differs = entries.some(
    (e) => e.name_label !== e.name || e.value_label !== e.value,
  );
  return differs ? { locale, entries } : null;
}

export function readOptionsDisplaySnapshot(
  raw: unknown,
): OptionsDisplaySnapshot | null {
  if (
    !isPlainObject(raw) ||
    typeof raw.locale !== 'string' ||
    !Array.isArray(raw.entries)
  )
    return null;
  const entries: OptionDisplayEntry[] = [];
  for (const e of raw.entries) {
    if (
      !isPlainObject(e) ||
      typeof e.name !== 'string' ||
      typeof e.value !== 'string'
    )
      continue;
    entries.push({
      name: e.name,
      value: e.value,
      name_label:
        typeof e.name_label === 'string' && e.name_label !== ''
          ? e.name_label
          : e.name,
      value_label:
        typeof e.value_label === 'string' && e.value_label !== ''
          ? e.value_label
          : e.value,
    });
  }
  return entries.length > 0 ? { locale: raw.locale, entries } : null;
}

/** Snapshot entries when the snapshot locale matches `locale` (base-language compare), else null. */
export function snapshotEntriesFor(
  raw: unknown,
  locale: string | null | undefined,
): OptionDisplayEntry[] | null {
  const snap = readOptionsDisplaySnapshot(raw);
  if (!snap || !locale) return null;
  return baseLanguage(snap.locale) === baseLanguage(locale)
    ? snap.entries
    : null;
}

/** Option name -> set of values, from every variant map plus the option config. */
export type OptionSet = Map<string, Set<string>>;

export function productOptionSet(
  variantOptionMaps: readonly unknown[],
  optionConfig: unknown,
): OptionSet {
  const set: OptionSet = new Map();
  const add = (name: string, value?: string) => {
    if (!name) return;
    let s = set.get(name);
    if (!s) {
      s = new Set();
      set.set(name, s);
    }
    if (value !== undefined && value !== '') s.add(value);
  };
  for (const m of variantOptionMaps) {
    if (!isPlainObject(m)) continue;
    for (const [k, v] of Object.entries(m)) {
      if (v === null || v === undefined) continue;
      add(k, valueText(v));
    }
  }
  if (Array.isArray(optionConfig)) {
    for (const c of optionConfig) {
      if (!isPlainObject(c) || typeof c.name !== 'string') continue;
      add(c.name);
      if (Array.isArray(c.values)) {
        for (const v of c.values) if (typeof v === 'string') add(c.name, v);
      }
    }
  }
  return set;
}

export interface LabelIssue {
  path: string;
  reason: 'shape' | 'too_long' | 'too_many' | 'unknown_option';
}

// Control characters (C0 + DEL + C1) are never meaningful in a label.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const cleanLabel = (s: string) =>
  s.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();

/**
 * Normalizes labels sent by a client: trims, strips control chars, drops
 * empty and equal-to-canonical labels, enforces limits and reports keys that
 * are not options of the product. `issues` non-empty = reject the save.
 */
export function normalizeVariantOptionLabels(
  input: unknown,
  optionSet: OptionSet,
): { labels: VariantOptionLabels | null; issues: LabelIssue[] } {
  const issues: LabelIssue[] = [];
  if (input === null || input === undefined) return { labels: null, issues };
  if (!isPlainObject(input))
    return { labels: null, issues: [{ path: '', reason: 'shape' }] };
  for (const k of Object.keys(input)) {
    if (k !== 'names' && k !== 'values')
      issues.push({ path: k, reason: 'shape' });
  }
  const names: Record<string, string> = {};
  const values: Record<string, Record<string, string>> = {};
  let valueCount = 0;

  if (input.names !== undefined && input.names !== null) {
    if (!isPlainObject(input.names))
      issues.push({ path: 'names', reason: 'shape' });
    else {
      for (const [name, raw] of Object.entries(input.names)) {
        const path = `names.${name}`;
        if (typeof raw !== 'string') {
          issues.push({ path, reason: 'shape' });
          continue;
        }
        if (!optionSet.has(name)) {
          issues.push({ path, reason: 'unknown_option' });
          continue;
        }
        const label = cleanLabel(raw);
        if (label.length > OPTION_NAME_LABEL_MAX) {
          issues.push({ path, reason: 'too_long' });
          continue;
        }
        if (label === '' || label === name) continue;
        names[name] = label;
      }
    }
  }

  if (input.values !== undefined && input.values !== null) {
    if (!isPlainObject(input.values))
      issues.push({ path: 'values', reason: 'shape' });
    else {
      for (const [name, map] of Object.entries(input.values)) {
        if (map === null) continue;
        if (!isPlainObject(map)) {
          issues.push({ path: `values.${name}`, reason: 'shape' });
          continue;
        }
        const known = optionSet.get(name);
        const inner: Record<string, string> = {};
        for (const [value, raw] of Object.entries(map)) {
          const path = `values.${name}.${value}`;
          if (typeof raw !== 'string') {
            issues.push({ path, reason: 'shape' });
            continue;
          }
          if (!known || !known.has(value)) {
            issues.push({ path, reason: 'unknown_option' });
            continue;
          }
          const label = cleanLabel(raw);
          if (label.length > OPTION_VALUE_LABEL_MAX) {
            issues.push({ path, reason: 'too_long' });
            continue;
          }
          if (label === '' || label === value) continue;
          inner[value] = label;
          valueCount += 1;
        }
        if (Object.keys(inner).length > 0) values[name] = inner;
      }
    }
  }

  if (Object.keys(names).length > OPTION_NAME_LABELS_MAX_COUNT)
    issues.push({ path: 'names', reason: 'too_many' });
  if (valueCount > OPTION_VALUE_LABELS_MAX_COUNT)
    issues.push({ path: 'values', reason: 'too_many' });

  const out: VariantOptionLabels = {};
  if (Object.keys(names).length > 0) out.names = names;
  if (Object.keys(values).length > 0) out.values = values;
  return { labels: out.names || out.values ? out : null, issues };
}

/** True when `rowLocale` is read by `labelsForLocale(rows, locale)`. */
function servesLocale(rowLocale: string, locale: string): boolean {
  return (
    rowLocale === locale || rowLocale.toLowerCase() === baseLanguage(locale)
  );
}

/**
 * Translation rows for a public list payload: `variant_option_labels` is
 * kept only on the rows `labelsForLocale(rows, locale)` reads (the request
 * locale and its base language) and dropped from the others, so a listing
 * does not ship every locale's labels for every product. Rows without the
 * column are returned as they are. No locale = labels dropped everywhere.
 */
export function trimLabelRows<T extends { locale: string }>(
  rows: readonly T[],
  locale: string | null | undefined,
): T[] {
  return rows.map((r) => {
    if (!('variant_option_labels' in r)) return r;
    if (locale && servesLocale(r.locale, locale)) return r;
    const { variant_option_labels: _drop, ...rest } = r as T & {
      variant_option_labels?: unknown;
    };
    return rest as T;
  });
}

/**
 * The label rows of a base product that `locale` reads, for a custom
 * product row (whose own translations never hold labels); empty when none.
 */
export function labelRowsForLocale(
  rows: readonly LabelRow[] | null | undefined,
  locale: string | null | undefined,
): LabelRow[] {
  if (!rows || !locale) return [];
  return rows
    .filter(
      (r) =>
        servesLocale(r.locale, locale) &&
        readVariantOptionLabels(r.variant_option_labels) !== null,
    )
    .map((r) => ({
      locale: r.locale,
      variant_option_labels: r.variant_option_labels,
    }));
}

/** Silently drops stored labels whose name / value is no longer an option. */
export function pruneVariantOptionLabels(
  stored: unknown,
  optionSet: OptionSet,
): VariantOptionLabels | null {
  const parsed = readVariantOptionLabels(stored);
  if (!parsed) return null;
  const names: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.names ?? {}))
    if (optionSet.has(k) && v !== k) names[k] = v;
  const values: Record<string, Record<string, string>> = {};
  for (const [name, map] of Object.entries(parsed.values ?? {})) {
    const known = optionSet.get(name);
    if (!known) continue;
    const inner: Record<string, string> = {};
    for (const [k, v] of Object.entries(map))
      if (known.has(k) && v !== k) inner[k] = v;
    if (Object.keys(inner).length > 0) values[name] = inner;
  }
  const out: VariantOptionLabels = {};
  if (Object.keys(names).length > 0) out.names = names;
  if (Object.keys(values).length > 0) out.values = values;
  return out.names || out.values ? out : null;
}

/** True when two label objects hold the same labels (key order ignored). */
export function sameVariantOptionLabels(a: unknown, b: unknown): boolean {
  const x = readVariantOptionLabels(a);
  const y = readVariantOptionLabels(b);
  if (!x || !y) return !x && !y;
  const flat = (l: VariantOptionLabels) => {
    const out: string[] = [];
    for (const [k, v] of Object.entries(l.names ?? {}))
      out.push(`n\u0000${k}\u0000${v}`);
    for (const [n, m] of Object.entries(l.values ?? {})) {
      for (const [k, v] of Object.entries(m))
        out.push(`v\u0000${n}\u0000${k}\u0000${v}`);
    }
    return out.sort().join('\u0001');
  };
  return flat(x) === flat(y);
}

/** Minimal structural shape of a personalization line (core `PLine`). */
export interface RelabelableLine {
  source: string;
  field_id?: string | null;
  label: string;
  value: string;
  display_value: string;
  field_name: string;
  meta?: { option_name?: string } | null;
  i18n?: {
    label: Record<string, string> | null;
    display_value: Record<string, string> | null;
    group_label?: unknown;
  };
}

/**
 * Relabels personalization `source: 'OPTION'` lines for `locale`: `label` /
 * `display_value` and the `locale` keys of `i18n.label` / `i18n.display_value`.
 * `value`, `field_name`, `meta.option_name` and the primary-locale i18n keys
 * (staff, production) stay canonical. No-op without labels or for the primary
 * locale. Returns new line objects; the input is not mutated.
 */
export function relabelOptionLines<T extends RelabelableLine>(
  lines: readonly T[],
  labels: VariantOptionLabels | null | undefined,
  locale: string | null | undefined,
  primaryLocale: string | null | undefined,
  /**
   * Field defs of the lines (flat or tree). With them, COLOR_PALETTE FIELD
   * lines whose palette is a product option are relabelled too.
   */
  defs?: readonly RelabelableFieldDef[] | null,
): T[] {
  if (!labels || !locale || (primaryLocale && locale === primaryLocale))
    return lines.slice();
  const fieldDefs = indexFieldDefs(defs);
  return lines.map((line) => {
    if (line.source === 'FIELD')
      return relabelPaletteLine(line, fieldDefs, labels, locale, primaryLocale);
    if (line.source !== 'OPTION') return line;
    const name = line.meta?.option_name ?? line.field_name;
    const nameLabel = optionNameLabel(labels, name);
    const valueLabel = optionValueLabel(labels, name, line.value);
    if (nameLabel === name && valueLabel === line.value) return line;
    const i18n = line.i18n
      ? {
          ...line.i18n,
          label: { ...(line.i18n.label ?? {}), [locale]: nameLabel },
          display_value: {
            ...(line.i18n.display_value ?? {}),
            [locale]: valueLabel,
          },
        }
      : line.i18n;
    return { ...line, label: nameLabel, display_value: valueLabel, i18n };
  });
}

/** Minimal structural shape of a personalization field def (core `PFieldDef`). */
export interface RelabelableFieldDef {
  id: string;
  type: string;
  ui?: unknown;
  translations?:
    | readonly ({ locale: string; option_labels?: unknown } | null)[]
    | null;
  children?: readonly RelabelableFieldDef[] | null;
}

/** The product option a COLOR_PALETTE field takes its palette from, else null. */
export function paletteSourceOption(def: RelabelableFieldDef): string | null {
  if (def.type !== 'COLOR_PALETTE' || !isPlainObject(def.ui)) return null;
  const option = def.ui.palette_from_option;
  return typeof option === 'string' && option !== '' ? option : null;
}

/**
 * Product option label of a palette value, for a COLOR_PALETTE field whose
 * palette is a product option (`ui.palette_from_option`) and which has no own
 * label of that value for `locale` (exact translation row, as the evaluator
 * reads it). Null = keep the field's own text.
 */
export function paletteValueLabel(
  def: RelabelableFieldDef,
  labels: VariantOptionLabels | null | undefined,
  locale: string | null | undefined,
  value: string,
): string | null {
  const option = paletteSourceOption(def);
  if (!option || !labels || !locale) return null;
  const own = (def.translations ?? []).find((t) => t && t.locale === locale);
  if (own && isPlainObject(own.option_labels)) {
    const l = own.option_labels[value];
    if (typeof l === 'string' && l !== '') return null;
  }
  const label = optionValueLabel(labels, option, value);
  return label === value ? null : label;
}

function indexFieldDefs(
  defs: readonly RelabelableFieldDef[] | null | undefined,
): Map<string, RelabelableFieldDef> {
  const out = new Map<string, RelabelableFieldDef>();
  const add = (list: readonly RelabelableFieldDef[] | null | undefined) => {
    for (const d of list ?? []) {
      if (!d || typeof d.id !== 'string' || out.has(d.id)) continue;
      out.set(d.id, d);
      add(d.children);
    }
  };
  add(defs);
  return out;
}

/**
 * A palette FIELD line with the product option's label of `locale`:
 * `display_value` and `i18n.display_value[locale]`. `value` stays canonical
 * and the primary-locale key keeps (or gets) the canonical text for staff.
 */
function relabelPaletteLine<T extends RelabelableLine>(
  line: T,
  fieldDefs: Map<string, RelabelableFieldDef>,
  labels: VariantOptionLabels,
  locale: string,
  primaryLocale: string | null | undefined,
): T {
  const def = line.field_id ? fieldDefs.get(line.field_id) : undefined;
  const valueLabel = def
    ? paletteValueLabel(def, labels, locale, line.value)
    : null;
  if (valueLabel === null) return line;
  const prev = line.i18n?.display_value ?? null;
  const display: Record<string, string> = { ...(prev ?? {}) };
  if (primaryLocale && !hasOwn(display, primaryLocale))
    display[primaryLocale] = line.value;
  display[locale] = valueLabel;
  const i18n = line.i18n ? { ...line.i18n, display_value: display } : line.i18n;
  return { ...line, display_value: valueLabel, i18n };
}
