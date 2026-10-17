import { createHash } from 'node:crypto';
import { FulfillerType, ProductionCheckSource } from '@prisma/client';
import {
  isSnapshotFileRow,
  pickLocaleText,
  snapshotLabel,
  sortSnapshotRows,
  type SnapshotValueRow,
} from '../../common/personalization/snapshot-label';
import { nameKey, type ProductionSettings } from './production-settings';
import type { SourceCheck } from './production.types';

// Pure check generation (M4.3 §3.2, C24): one check per order value row
// (`fv:<id>`), variant attributes as `opt:<name>` (minus excluded and
// OPTION-row-covered ones), and the store's default custom items. Values
// and variant options come from the order-time snapshot columns
// (OrderCustomFieldValue rows, OrderItem.variant_options_snapshot), so a
// field or variant edited / deleted after the order never changes a check.
// The one exception is a line placed before the variant snapshot existed:
// its live `variant.options` seed the `opt:` checks once (insert-only, see
// `SourceCheck.insert_only`) and are never compared again.

/** A value row as loaded for generation (snapshot columns + live fallback). */
export interface ProductionValueRow extends SnapshotValueRow {
  id: string;
  sort_order?: number | null;
  group_index?: number | null;
  group_label?: unknown;
  source?: string | null;
  meta?: unknown;
}

/** An order line as loaded for generation. */
export interface ProductionSourceLine {
  id: string;
  /** FulfillerType (CREATOR | PROVIDER). */
  fulfiller_type: string;
  fulfiller_id: string | null;
  /** Order-time copy of the variant options (`{name: value}`); null before the column existed. */
  variant_options_snapshot?: unknown;
  /** Live variant, read only when the line has no snapshot (insert-only seed). */
  variant?: { options?: unknown } | null;
  custom_field_values?: ProductionValueRow[] | null;
}

/** Order of checks inside a line: options, values, providers, defaults. */
export const SORT_BASE = {
  option: 0,
  value: 100,
  provider: 5000,
  defaults: 9000,
  custom: 10000,
} as const;

const KEY_MAX = 160;
/** Value types that are containers, never a thing to produce. */
const CONTAINER_TYPES = new Set(['REPEATER']);

function clampKey(key: string): string {
  return key.length > KEY_MAX ? key.slice(0, KEY_MAX) : key;
}

/**
 * sha256(value|file_url): detects an in-place edit of what is produced. The
 * label is deliberately not part of it: a renamed field or a store-locale
 * switch relabels the check without resetting `done`.
 */
export function sourceHash(
  value: string | null,
  fileUrl: string | null,
): string {
  return createHash('sha256')
    .update(`${value ?? ''}\u0000${fileUrl ?? ''}`)
    .digest('hex');
}

/** The option map of a line: the snapshot, else (pre-snapshot lines) the live variant. */
export function variantOptionsOf(
  line: Pick<ProductionSourceLine, 'variant_options_snapshot' | 'variant'>,
): { options: Record<string, unknown> | null; snapshot: boolean } {
  const snap = line.variant_options_snapshot;
  if (snap && typeof snap === 'object' && !Array.isArray(snap)) {
    return { options: snap as Record<string, unknown>, snapshot: true };
  }
  const live = line.variant?.options;
  if (live && typeof live === 'object' && !Array.isArray(live)) {
    return { options: live as Record<string, unknown>, snapshot: false };
  }
  return { options: null, snapshot: snap !== null && snap !== undefined };
}

/** URL-safe slug of a default item label (key `custom:default:<slug>`). */
export function itemSlug(label: string): string {
  const slug = nameKey(label)
    .replace(/[^a-z0-9\u0080-￿]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug || 'item').slice(0, 64);
}

/**
 * The single snapshot adapter (§3.2): label/value in the store's primary
 * locale through M4.0's snapshotLabel (live field translations only for
 * pre-snapshot rows), with the repeater group label as a prefix.
 */
export function readValueSnapshot(
  row: ProductionValueRow,
  primary: string | null,
): { label: string; value: string | null; file_url: string | null } {
  const { label, value } = snapshotLabel(row, primary, primary);
  let fullLabel = label;
  if (row.group_index !== null && row.group_index !== undefined) {
    const group =
      pickLocaleText(row.group_label, primary, primary) ??
      `#${row.group_index}`;
    fullLabel = `${group} – ${label}`;
  }
  const isFile = isSnapshotFileRow(row);
  const fileUrl = row.file_url || null;
  return {
    label: fullLabel,
    // A file row shows its thumbnail; its raw value is the same URL.
    value: isFile && (value === null || value === fileUrl) ? null : value,
    file_url: fileUrl,
  };
}

/** Option name covered by an M4.1 OPTION value row (`meta.option_name`, else its field name). */
function optionNameOf(row: ProductionValueRow): string | null {
  const meta = row.meta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const n = (meta as Record<string, unknown>).option_name;
    if (typeof n === 'string' && n) return n;
  }
  return row.field_name ?? null;
}

/** Whether the line is produced by the store's creator (provider lines are not). */
export function isOwnLine(
  line: Pick<ProductionSourceLine, 'fulfiller_type' | 'fulfiller_id'>,
  creatorId: string | null,
): boolean {
  return (
    !!creatorId &&
    line.fulfiller_type === FulfillerType.CREATOR &&
    line.fulfiller_id === creatorId
  );
}

/** Every check a line should have under these settings (deterministic). */
export function buildLineSources(
  line: ProductionSourceLine,
  settings: ProductionSettings,
  primary: string | null,
): SourceCheck[] {
  const out: SourceCheck[] = [];
  const rows = sortSnapshotRows(line.custom_field_values ?? []);
  const excludedTypes = new Set<string>(settings.exclude_field_types);
  const excludedNames = new Set(settings.exclude_field_names.map(nameKey));
  const excludedOptions = new Set(settings.exclude_option_names.map(nameKey));
  const coveredOptions = new Set<string>();

  rows.forEach((row, i) => {
    if (row.source === 'OPTION') {
      const opt = optionNameOf(row);
      if (opt) coveredOptions.add(nameKey(opt));
    }
    const hasValue =
      row.value !== null && row.value !== undefined && row.value !== '';
    if (!hasValue && !row.file_url) return;
    const type = row.field_type ?? row.custom_field?.type ?? null;
    if (type && (excludedTypes.has(type) || CONTAINER_TYPES.has(type))) return;
    const snap = readValueSnapshot(row, primary);
    const plainLabel = snapshotLabel(row, primary, primary).label;
    const name = row.field_name ?? row.custom_field?.name ?? null;
    if (
      (name && excludedNames.has(nameKey(name))) ||
      excludedNames.has(nameKey(plainLabel))
    ) {
      return;
    }
    out.push({
      order_item_id: line.id,
      source: ProductionCheckSource.FIELD_VALUE,
      source_key: clampKey(`fv:${row.id}`),
      label: snap.label,
      value: snap.value,
      group_index: row.group_index ?? null,
      file_url: snap.file_url,
      sort_order: SORT_BASE.value + i,
    });
  });

  if (settings.include_variant_options) {
    const { options, snapshot } = variantOptionsOf(line);
    if (options) {
      let i = 0;
      for (const [name, raw] of Object.entries(options)) {
        if (raw === null || raw === undefined || typeof raw === 'object') {
          continue;
        }
        const value = String(raw as string | number | boolean).trim();
        if (!value) continue;
        const key = nameKey(name);
        if (excludedOptions.has(key) || coveredOptions.has(key)) continue;
        out.push({
          order_item_id: line.id,
          source: ProductionCheckSource.VARIANT_OPTION,
          source_key: clampKey(`opt:${name}`),
          label: name,
          value,
          group_index: null,
          file_url: null,
          sort_order: SORT_BASE.option + i++,
          // No snapshot (older order): seed once, never compare again.
          ...(snapshot ? {} : { insert_only: true }),
        });
      }
    }
  }

  const seen = new Set<string>();
  settings.default_custom_items.forEach((label, i) => {
    const key = clampKey(`custom:default:${itemSlug(label)}`);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      order_item_id: line.id,
      source: ProductionCheckSource.CUSTOM,
      source_key: key,
      label,
      value: null,
      group_index: null,
      file_url: null,
      sort_order: SORT_BASE.defaults + i,
    });
  });

  return out;
}
