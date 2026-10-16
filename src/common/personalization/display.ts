/* eslint-disable */
// MIRROR (M4.1 C12): below this 3-line header, a byte copy of multi-stores-shared/src/personalization/display.ts.
// Never edit here: edit the shared file and run multi-stores-shared/scripts/sync-personalization-evaluator.mjs.
/**
 * Grouped personalization display (M4.1 §3.5, contracts C1/C18/C24).
 * Mirrored with types.ts (see the KEEP IN SYNC note there); the dashboard
 * copies this file alone, so it imports nothing. Pure code only.
 *
 * Input rows are evaluator lines, cart display entries or order snapshot
 * rows already resolved to text (`snapshotLabel` gives `label`/`value`,
 * `snapshotGroupLabel` gives `group_label`).
 */

export interface PDisplayRow {
  label: string;
  value: string | null;
  group_key?: string | null;
  group_index?: number | null;
  /** Resolved text, or a `{locale: text}` map (read with `locale`/`primary`). */
  group_label?: string | Record<string, unknown> | null;
  /** 'FIELD' (default) | 'OPTION' | 'DESIGN'. */
  source?: string | null;
  hex?: string | null;
  meta?: { hex?: unknown } | null;
  sort_order?: number | null;
}

export interface PDisplayEntry {
  label: string;
  value: string | null;
  hex?: string;
  source: string;
}

export interface PDisplayGroup {
  key: string;
  index: number;
  label: string;
  entries: PDisplayEntry[];
}

export interface PDisplayGroups {
  groups: PDisplayGroup[];
  flat: { label: string; value: string | null; hex?: string }[];
}

export interface BuildGroupsOptions {
  locale?: string | null;
  primary?: string | null;
  /** Label when a row has no group label (e.g. the i18n `personalization.itemN`). */
  defaultGroupLabel?: (index: number, key: string) => string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** `map[locale]` → `[primary]` → `.en` → first non-empty; null when none. */
export function pickLocaleLabel(map: unknown, locale?: string | null, primary?: string | null): string | null {
  if (typeof map === 'string') return map !== '' ? map : null;
  if (!isRecord(map)) return null;
  const ok = (v: unknown): v is string => typeof v === 'string' && v !== '';
  for (const key of [locale, primary, 'en']) if (key && ok(map[key])) return map[key] as string;
  for (const v of Object.values(map)) if (ok(v)) return v;
  return null;
}

/**
 * Group label of a snapshot row (C18): `group_label` by locale → primary →
 * en → first; null when the row is not grouped or has no label.
 */
export function snapshotGroupLabel(
  row: { group_index?: number | null; group_label?: unknown },
  locale?: string | null,
  primary?: string | null,
): string | null {
  if (typeof row.group_index !== 'number') return null;
  return pickLocaleLabel(row.group_label, locale, primary);
}

function hexOf(row: PDisplayRow): string | undefined {
  if (typeof row.hex === 'string' && row.hex !== '') return row.hex;
  const h = row.meta?.hex;
  return typeof h === 'string' && h !== '' ? h : undefined;
}

/** True when any row belongs to a repeater item (the trigger for grouped rendering). */
export function hasPersonalizationGroups(rows: readonly { group_index?: number | null }[] | null | undefined): boolean {
  return Array.isArray(rows) && rows.some((r) => typeof r?.group_index === 'number');
}

/**
 * Splits rows into repeater groups (sorted by index, then key in first-seen
 * order) and flat rows. Rows keep their order (`sort_order`, then input
 * position). `source='OPTION'` rows outside a group are skipped: the variant
 * line already shows the option.
 */
export function buildPersonalizationGroups(
  rows: readonly PDisplayRow[] | null | undefined,
  opts: BuildGroupsOptions = {},
): PDisplayGroups {
  const list = (Array.isArray(rows) ? rows : [])
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const sa = a.row.sort_order ?? Number.POSITIVE_INFINITY;
      const sb = b.row.sort_order ?? Number.POSITIVE_INFINITY;
      if (sa !== sb) return sa < sb ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.row);

  const groups: PDisplayGroup[] = [];
  const flat: PDisplayGroups['flat'] = [];
  const keyOrder: string[] = [];
  for (const row of list) {
    const source = row.source || 'FIELD';
    const hex = hexOf(row);
    if (typeof row.group_index !== 'number') {
      if (source === 'OPTION') continue;
      flat.push(hex ? { label: row.label, value: row.value, hex } : { label: row.label, value: row.value });
      continue;
    }
    const key = row.group_key ?? '';
    if (!keyOrder.includes(key)) keyOrder.push(key);
    let group = groups.find((g) => g.key === key && g.index === row.group_index);
    if (!group) {
      const label =
        pickLocaleLabel(row.group_label, opts.locale, opts.primary) ??
        (opts.defaultGroupLabel ? opts.defaultGroupLabel(row.group_index, key) : String(row.group_index));
      group = { key, index: row.group_index, label, entries: [] };
      groups.push(group);
    }
    const entry: PDisplayEntry = { label: row.label, value: row.value, source };
    if (hex) entry.hex = hex;
    group.entries.push(entry);
  }
  groups.sort((a, b) => keyOrder.indexOf(a.key) - keyOrder.indexOf(b.key) || a.index - b.index);
  return { groups, flat };
}

/** One-line text of a group ("KARIN, Röd"): entry values joined by `sep`. */
export function groupValueText(group: PDisplayGroup, sep = ', '): string {
  return group.entries
    .map((e) => e.value)
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .join(sep);
}
