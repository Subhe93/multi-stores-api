import { CustomFieldType } from '@prisma/client';

// Settings of the `production` store app (M4.3 §3.3), kept in
// StoreApp.settings. Two readers, like the b2b app: a lenient parse for the
// runtime (odd values fall back to the default of that key, never throws)
// and a strict validation for the dashboard write
// (PUT /stores/my/apps/production → STORE_APP_SETTINGS_INVALID).

export const PRODUCTION_ON_COMPLETE = ['none', 'suggest', 'auto'] as const;
export type ProductionOnComplete = (typeof PRODUCTION_ON_COMPLETE)[number];

export const PRODUCTION_COMPLETE_TARGETS = [
  'QUALITY_CHECK',
  'SHIPPED',
] as const;
export type ProductionCompleteTarget =
  (typeof PRODUCTION_COMPLETE_TARGETS)[number];

export interface ProductionSettings {
  /** Variant attributes (e.g. colour) become checks (WOPS parity). */
  include_variant_options: boolean;
  /** Variant attribute names never turned into checks (e.g. the quantity attribute). */
  exclude_option_names: string[];
  /** Field types whose values are never turned into checks. */
  exclude_field_types: CustomFieldType[];
  /** Field names or labels whose values are never turned into checks. */
  exclude_field_names: string[];
  /** Extra checks added to every line (e.g. "Packed"). */
  default_custom_items: string[];
  /** What happens when the checklist reaches 100 %. */
  on_complete: ProductionOnComplete;
  complete_target: ProductionCompleteTarget;
  /** The first check moves CONFIRMED / PROCESSING lines to MANUFACTURING. */
  start_on_first_check: boolean;
  /** Offer QUALITY_CHECK in the creator status dropdown (dashboard). */
  use_quality_check: boolean;
}

export const PRODUCTION_LIMITS = {
  exclude_option_names: 20,
  exclude_field_names: 50,
  default_custom_items: 10,
  name_length: 80,
  custom_item_length: 80,
} as const;

export const DEFAULT_PRODUCTION_SETTINGS: Readonly<ProductionSettings> =
  Object.freeze({
    include_variant_options: true,
    exclude_option_names: [],
    exclude_field_types: [],
    exclude_field_names: [],
    default_custom_items: [],
    on_complete: 'suggest',
    complete_target: 'QUALITY_CHECK',
    start_on_first_check: false,
    use_quality_check: true,
  });

/**
 * Named presets the dashboard can merge into the settings form (then saved
 * through the normal settings write). `namez` = Q16/Q15: suggest SHIPPED at
 * 100 %, no QC step, the quantity attribute is not a check.
 */
export const PRODUCTION_PRESETS: Record<string, Partial<ProductionSettings>> = {
  namez: {
    include_variant_options: true,
    exclude_option_names: [
      'Välj antal',
      'Räkna',
      'Välj antal 3D bokstav',
      'Namnskylt stor bokstav',
    ],
    on_complete: 'suggest',
    complete_target: 'SHIPPED',
    use_quality_check: false,
    start_on_first_check: false,
    default_custom_items: [],
  },
};

const FIELD_TYPES = Object.values(CustomFieldType) as string[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isOnComplete(value: unknown): value is ProductionOnComplete {
  return (
    typeof value === 'string' &&
    (PRODUCTION_ON_COMPLETE as readonly string[]).includes(value)
  );
}

function isTarget(value: unknown): value is ProductionCompleteTarget {
  return (
    typeof value === 'string' &&
    (PRODUCTION_COMPLETE_TARGETS as readonly string[]).includes(value)
  );
}

/** Trimmed, non-empty, de-duplicated strings, capped in count and length. */
function stringList(value: unknown, max: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const s = v.trim().slice(0, maxLen);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Comparison key for option / field names: case-insensitive, accents and a
 * WooCommerce `pa_` prefix ignored, `-`/`_` read as spaces. So "pa_rakna",
 * "Räkna" and "räkna" match each other.
 */
export function nameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/^pa_/, '')
    .replace(/[-_\s]+/g, ' ')
    .trim();
}

/** Lenient read: defaults merged, invalid keys replaced by their default. */
export function normalizeProductionSettings(raw: unknown): ProductionSettings {
  const d = DEFAULT_PRODUCTION_SETTINGS;
  const r = isRecord(raw) ? raw : {};
  const bool = (key: keyof ProductionSettings, def: boolean) =>
    typeof r[key] === 'boolean' ? r[key] : def;
  let onComplete = isOnComplete(r.on_complete) ? r.on_complete : d.on_complete;
  const target = isTarget(r.complete_target)
    ? r.complete_target
    : d.complete_target;
  // Never auto-ship (Kustom capture + shipped email without tracking).
  if (onComplete === 'auto' && target === 'SHIPPED') onComplete = 'suggest';
  return {
    include_variant_options: bool(
      'include_variant_options',
      d.include_variant_options,
    ),
    exclude_option_names: stringList(
      r.exclude_option_names,
      PRODUCTION_LIMITS.exclude_option_names,
      PRODUCTION_LIMITS.name_length,
    ),
    exclude_field_types: stringList(
      r.exclude_field_types,
      FIELD_TYPES.length,
      32,
    ).filter((t): t is CustomFieldType => FIELD_TYPES.includes(t)),
    exclude_field_names: stringList(
      r.exclude_field_names,
      PRODUCTION_LIMITS.exclude_field_names,
      PRODUCTION_LIMITS.name_length,
    ),
    default_custom_items: stringList(
      r.default_custom_items,
      PRODUCTION_LIMITS.default_custom_items,
      PRODUCTION_LIMITS.custom_item_length,
    ),
    on_complete: onComplete,
    complete_target: target,
    start_on_first_check: bool('start_on_first_check', d.start_on_first_check),
    use_quality_check: bool('use_quality_check', d.use_quality_check),
  };
}

function checkStringList(
  raw: Record<string, unknown>,
  key: string,
  max: number,
  maxLen: number,
  errors: string[],
): void {
  if (!(key in raw)) return;
  const list = raw[key];
  if (!Array.isArray(list)) {
    errors.push(`${key} must be a list of texts.`);
    return;
  }
  if (list.length > max) errors.push(`${key} can hold at most ${max} entries.`);
  if (
    list.some(
      (v) => typeof v !== 'string' || !v.trim() || v.trim().length > maxLen,
    )
  ) {
    errors.push(
      `${key} entries must be non-empty texts of at most ${maxLen} characters.`,
    );
  }
}

const KNOWN_KEYS: ReadonlySet<string> = new Set(
  Object.keys(DEFAULT_PRODUCTION_SETTINGS),
);

/**
 * Strict write validation. Every key is optional (defaults apply), a present
 * known key must be valid, an unknown key is an error (a typo would
 * otherwise be dropped silently), and the resulting combination must make
 * sense.
 */
export function validateProductionSettings(raw: unknown): {
  ok: boolean;
  errors: string[];
} {
  if (!isRecord(raw)) {
    return { ok: false, errors: ['settings must be an object.'] };
  }
  const errors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) errors.push(`Unknown setting "${key}".`);
  }
  for (const key of [
    'include_variant_options',
    'start_on_first_check',
    'use_quality_check',
  ]) {
    if (key in raw && typeof raw[key] !== 'boolean') {
      errors.push(`${key} must be true or false.`);
    }
  }
  checkStringList(
    raw,
    'exclude_option_names',
    PRODUCTION_LIMITS.exclude_option_names,
    PRODUCTION_LIMITS.name_length,
    errors,
  );
  checkStringList(
    raw,
    'exclude_field_names',
    PRODUCTION_LIMITS.exclude_field_names,
    PRODUCTION_LIMITS.name_length,
    errors,
  );
  checkStringList(
    raw,
    'default_custom_items',
    PRODUCTION_LIMITS.default_custom_items,
    PRODUCTION_LIMITS.custom_item_length,
    errors,
  );
  if ('exclude_field_types' in raw) {
    const list = raw.exclude_field_types;
    if (
      !Array.isArray(list) ||
      list.some((t) => typeof t !== 'string' || !FIELD_TYPES.includes(t))
    ) {
      errors.push(
        `exclude_field_types must be a list of: ${FIELD_TYPES.join(', ')}.`,
      );
    }
  }
  if ('on_complete' in raw && !isOnComplete(raw.on_complete)) {
    errors.push(
      `on_complete must be one of ${PRODUCTION_ON_COMPLETE.join(', ')}.`,
    );
  }
  if ('complete_target' in raw && !isTarget(raw.complete_target)) {
    errors.push(
      `complete_target must be one of ${PRODUCTION_COMPLETE_TARGETS.join(', ')}.`,
    );
  }
  if (errors.length === 0) {
    const s = normalizeProductionSettings(raw);
    if (raw.on_complete === 'auto' && s.complete_target === 'SHIPPED') {
      errors.push(
        'on_complete "auto" cannot target SHIPPED: shipping is always a manual step (it captures the payment and emails the customer).',
      );
    }
    if (
      s.on_complete !== 'none' &&
      s.complete_target === 'QUALITY_CHECK' &&
      !s.use_quality_check
    ) {
      errors.push(
        'complete_target QUALITY_CHECK needs use_quality_check to be on.',
      );
    }
  }
  return { ok: errors.length === 0, errors };
}
