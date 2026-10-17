import { BadRequestException } from '@nestjs/common';
import { isAdvancedField } from '../../common/personalization/evaluator';
import { isPlainObject } from '../../common/personalization/rules';
import {
  APP_ONLY_TYPES,
  type PError,
  type PFieldDef,
  type PLine,
  type POptionConfig,
} from '../../common/personalization/types';
import { PERSONALIZATION_INVALID } from './personalization.errors';

/**
 * Pure helpers of the personalization app's runtime flows (M4.1 WP-C): the
 * gate predicates, the storefront payload shaping, the cart display lines
 * and the 400 envelope. Everything here is a no-op for products without
 * M4.1 config, which is what keeps stores without the app byte-identical.
 */

/** The ProductCustomField columns added by M4.1 (C5). */
export const FIELD_EXTRA_KEYS = [
  'parent_id',
  'conditions',
  'pricing',
  'repeat',
  'ui',
  'preset_key',
  'preset_ref',
] as const;

/** The CustomFieldTranslation columns added by M4.1 (C6). */
export const TRANSLATION_EXTRA_COLUMNS = [
  'display_label',
  'sublabel',
  'note',
  'help_text',
  'help_image_url',
  'messages',
] as const;

/** Keys the storefront never needs (importer / preset bookkeeping). */
const STOREFRONT_PRIVATE_KEYS = ['preset_key', 'preset_ref'] as const;

/**
 * True when any field (or child) uses an M4.1 feature (app-only type,
 * parent, conditions, pricing, repeat, ui). Same rule as the web form
 * (`hasAdvancedFields`): without one, the M4.0 path is used everywhere.
 */
export function usesAdvancedFields(
  defs: readonly PFieldDef[] | null | undefined,
): boolean {
  if (!defs) return false;
  return defs.some(
    (d: PFieldDef | null | undefined) =>
      !!d && (isAdvancedField(d) || usesAdvancedFields(d.children)),
  );
}

/** True when an option uses the app's variation cards (`style:'card'` or `valueMeta`). */
export function usesAdvancedOptionConfig(config: unknown): boolean {
  if (!Array.isArray(config)) return false;
  return config.some(
    (o) =>
      isPlainObject(o) &&
      (o.style === 'card' ||
        (isPlainObject(o.valueMeta) && Object.keys(o.valueMeta).length > 0)),
  );
}

/** `Product.variant_option_config` as the evaluator reads it. */
export function readOptionConfig(config: unknown): POptionConfig[] {
  if (!Array.isArray(config)) return [];
  return config.filter(
    (o): o is POptionConfig => isPlainObject(o) && typeof o.name === 'string',
  );
}

/** `ProductVariant.options` as `{option: value}` (strings only). */
export function readVariantOptions(options: unknown): Record<string, string> {
  if (!isPlainObject(options)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(options)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = String(v);
  }
  return out;
}

/** Values per option present on active variants (palette restriction, §3.2). */
export function activeOptionValuesOf(
  variants: readonly { options: unknown }[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const v of variants) {
    for (const [k, val] of Object.entries(readVariantOptions(v.options))) {
      const list = (out[k] ??= []);
      if (!list.includes(val)) list.push(val);
    }
  }
  return out;
}

function omitKeys<T extends object>(row: T, keys: readonly string[]): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!keys.includes(k)) out[k] = v;
  }
  return out as T;
}

interface FieldRowLike {
  id: string;
  type: string;
  parent_id?: string | null;
  translations?: object[] | null;
}

/** A field row without the M4.1 columns (field and translations). */
export function legacyRow<T extends FieldRowLike>(row: T): T {
  const out = omitKeys(row, FIELD_EXTRA_KEYS);
  if (Array.isArray(row.translations)) {
    (out as FieldRowLike).translations = row.translations.map((t) =>
      omitKeys(t, TRANSLATION_EXTRA_COLUMNS),
    );
  }
  return out;
}

/**
 * Storefront `custom_fields` (D10, C36):
 * - off: the M4.0 payload — top-level fields of M4.0 types only, without
 *   the M4.1 columns (byte-identical to the pre-M4.1 rows);
 * - on: a tree (`children` on every top-level row), every column kept
 *   except the preset bookkeeping keys.
 */
export function shapeFieldsForStorefront<T extends FieldRowLike>(
  fields: readonly T[],
  appOn: boolean,
): (T & { children?: T[] })[] {
  if (!appOn) {
    return fields
      .filter((f) => !f.parent_id && !APP_ONLY_TYPES.has(f.type))
      .map((f) => legacyRow(f));
  }
  const childrenOf = new Map<string, T[]>();
  for (const f of fields) {
    if (!f.parent_id) continue;
    const list = childrenOf.get(f.parent_id) ?? [];
    list.push(omitKeys(f, STOREFRONT_PRIVATE_KEYS));
    childrenOf.set(f.parent_id, list);
  }
  return fields
    .filter((f) => !f.parent_id)
    .map((f) => ({
      ...omitKeys(f, STOREFRONT_PRIVATE_KEYS),
      children: childrenOf.get(f.id) ?? [],
    }));
}

/**
 * Storefront `variant_option_config` (D9/D10, C36/C38): with the app off,
 * `valueMeta` is removed and `style:'card'` shows as `'text'`; `swatchMap`
 * is never touched. The same array is returned when there is nothing to
 * strip (byte-identical payload).
 */
export function shapeOptionConfigForStorefront(
  config: unknown,
  appOn: boolean,
): unknown {
  if (appOn || !Array.isArray(config)) return config;
  const list = config as unknown[];
  const touched = list.some(
    (o) => isPlainObject(o) && ('valueMeta' in o || o.style === 'card'),
  );
  if (!touched) return config;
  return list.map((o): unknown => {
    if (!isPlainObject(o)) return o;
    const rest = omitKeys(o, ['valueMeta']);
    return rest.style === 'card' ? { ...rest, style: 'text' } : rest;
  });
}

/** One cart display line (`customFieldDisplay`, contract §5); group keys only in app mode. */
export interface PersonalizationDisplayLine {
  id: string;
  label: string;
  value: unknown;
  display: string | null;
  group_key?: string;
  group_index?: number;
  group_label?: string;
  hex?: string;
  source?: 'FIELD' | 'OPTION';
}

/**
 * Evaluator lines → cart display lines. Same mapping as the web's
 * `linesToDisplay` (guest cart), so a guest and a logged-in cart show the
 * same entries: id = field id (or `option:<name>`), `#<index>` in a group.
 */
export function linesToDisplay(
  lines: readonly PLine[],
): PersonalizationDisplayLine[] {
  return lines.map((l) => {
    const base = l.field_id ?? `option:${l.field_name}`;
    const out: PersonalizationDisplayLine = {
      id: l.group_index !== null ? `${base}#${l.group_index}` : base,
      label: l.label,
      value: l.value,
      display: l.display_value !== l.value ? l.display_value : null,
    };
    if (l.group_key !== null) out.group_key = l.group_key;
    if (l.group_index !== null) out.group_index = l.group_index;
    if (l.group_label !== null) out.group_label = l.group_label;
    if (l.meta?.hex) out.hex = l.meta.hex;
    out.source = l.source;
    return out;
  });
}

/** 400 `PERSONALIZATION_INVALID {errors}` (C34); the filter forwards `errors`. */
export function personalizationInvalid(
  errors: readonly PError[],
  ref: { line_id?: string; line_index?: number } = {},
): BadRequestException {
  return new BadRequestException({
    code: PERSONALIZATION_INVALID,
    message: 'Please check your personalization',
    errors,
    // Quote / order: which line failed (same keys as the M4.0 envelope).
    ...(ref.line_id !== undefined ? { line_id: ref.line_id } : {}),
    ...(ref.line_index !== undefined ? { line_index: ref.line_index } : {}),
  });
}
