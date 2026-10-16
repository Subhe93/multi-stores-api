import { pickTranslation } from './pick-translation';

/**
 * Snapshot reader (M4.0 §6.2, contract C18): the label and display text of an
 * OrderCustomFieldValue row, read from the frozen snapshot first and from the
 * live field only for rows written before the snapshot existed. Copied to the
 * web and dashboard `lib/customFields.ts`; keep the fallback chain identical.
 */

/** The columns the reader needs; every one is optional so partial selects type-check. */
export interface SnapshotValueRow {
  value?: string | null;
  file_url?: string | null;
  field_name?: string | null;
  field_type?: string | null;
  field_label?: unknown;
  display_value?: unknown;
  custom_field?: {
    name?: string | null;
    type?: string | null;
    translations?: {
      locale: string;
      label?: string | null;
      option_labels?: unknown;
    }[];
  } | null;
}

export interface SnapshotLabel {
  label: string;
  /** Display text (translated option label or the raw value); null for file-only rows. */
  value: string | null;
}

/** Placeholder label when neither the snapshot nor the live field has one. */
export const SNAPSHOT_LABEL_FALLBACK = '—';

/** Field types whose rows carry a file (`file_url`). */
const FILE_TYPES = new Set(['IMAGE', 'FILE', 'MULTI_IMAGE']);

function asLocaleMap(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * `map[locale]` → `map[primary]` → `map.en` → first non-empty entry; null
 * when the map has no usable string.
 */
export function pickLocaleText(
  map: unknown,
  locale?: string | null,
  primary?: string | null,
): string | null {
  const m = asLocaleMap(map);
  if (!m) return null;
  const ok = (v: unknown): v is string => typeof v === 'string' && v !== '';
  for (const key of [locale, primary, 'en']) {
    if (key && ok(m[key])) return m[key];
  }
  for (const v of Object.values(m)) if (ok(v)) return v;
  return null;
}

/**
 * Label: `field_label[locale]` → `[primary]` → `.en` → first → live
 * translation → `field_name` → live name → '—'.
 * Value: `display_value` by the same chain → the raw `value` (null when the
 * row only carries a file).
 */
export function snapshotLabel(
  row: SnapshotValueRow,
  locale?: string | null,
  primary?: string | null,
): SnapshotLabel {
  const live = row.custom_field ?? null;
  const liveTr =
    pickTranslation(live?.translations, locale) ??
    (primary ? pickTranslation(live?.translations, primary) : undefined);
  const label =
    pickLocaleText(row.field_label, locale, primary) ||
    liveTr?.label ||
    row.field_name ||
    live?.name ||
    SNAPSHOT_LABEL_FALLBACK;

  const raw = row.value ?? null;
  let value = pickLocaleText(row.display_value, locale, primary);
  if (value === null && raw !== null && raw !== '' && !row.display_value) {
    // Pre-snapshot rows of option fields: the live option label, if any.
    const labels = asLocaleMap(liveTr?.option_labels);
    const opt = labels?.[raw];
    if (typeof opt === 'string' && opt !== '') value = opt;
  }
  if (value === null) value = raw !== '' ? raw : null;
  return { label, value };
}

/** True when the row is a file value (by snapshot type, else by `file_url`). */
export function isSnapshotFileRow(row: SnapshotValueRow): boolean {
  const type = row.field_type ?? row.custom_field?.type ?? null;
  if (type && FILE_TYPES.has(type)) return true;
  return !!row.file_url && !row.value;
}

/**
 * Orders value rows for display: `sort_order` ascending (null last), then
 * their original position (stable).
 */
export function sortSnapshotRows<T extends { sort_order?: number | null }>(
  rows: readonly T[],
): T[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const sa = a.row.sort_order ?? Number.POSITIVE_INFINITY;
      const sb = b.row.sort_order ?? Number.POSITIVE_INFINITY;
      if (sa !== sb) return sa < sb ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.row);
}
