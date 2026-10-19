// Settings of the `designer` store app (M4.2 §4.3, retention §9 / U12),
// kept in StoreApp.settings. Two readers, like the other apps: a lenient
// parse for the runtime (odd values fall back to the default of that key,
// never throws) and a strict validation for the dashboard write
// (PUT /stores/my/apps/designer → STORE_APP_SETTINGS_INVALID).

export interface DesignerSettings {
  /** Customer photo originals are deleted this many days after the order (U12). */
  retention_days: number;
  /** Unordered drafts (and their photos) expire after this many days; ≤ retention_days. */
  draft_retention_days: number;
  /** Print and proof files are deleted this many days after shipping. */
  print_keep_days_after_shipped: number;
  /** Max customer photo upload in MB (public). */
  max_upload_mb: number;
  /** Photos below this effective DPI get a warning, never a block (public). */
  min_effective_dpi_warning: number;
  /** Print resolution in px/mm; only 6 (NPP parity, U10) in M4.2. */
  print_px_per_mm: number;
  /**
   * Print output formats: 'png' is always rendered (and listed first);
   * 'pdf' adds a print-ready PDF with bleed (off by default).
   */
  print_formats: DesignerPrintFormat[];
  /** Crop marks in the print PDF (outside the bleed; default off). */
  print_crop_marks: boolean;
  /** Storefront "design your sign" button text per locale (public). */
  shop_button_text: Record<string, string>;
}

export const DESIGNER_SETTINGS_LIMITS = {
  retention_days: [7, 730],
  draft_retention_days: [1, 730],
  print_keep_days_after_shipped: [0, 365],
  max_upload_mb: [1, 40],
  min_effective_dpi_warning: [30, 300],
  shop_button_text_length: 40,
} as const;

/** Values accepted for print_px_per_mm in M4.2 (11.811 = 300 DPI comes later). */
export const DESIGNER_PRINT_PX_PER_MM = [6] as const;
/** Formats accepted for print_formats ('png' is mandatory). */
export const DESIGNER_PRINT_FORMATS = ['png', 'pdf'] as const;
export type DesignerPrintFormat = (typeof DESIGNER_PRINT_FORMATS)[number];

export const DEFAULT_DESIGNER_SETTINGS: Readonly<DesignerSettings> =
  Object.freeze<DesignerSettings>({
    retention_days: 60,
    draft_retention_days: 30,
    print_keep_days_after_shipped: 30,
    max_upload_mb: 25,
    min_effective_dpi_warning: 100,
    print_px_per_mm: 6,
    print_formats: ['png'],
    print_crop_marks: false,
    shop_button_text: { sv: 'Designa din skylt' },
  });

const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isIntIn(
  value: unknown,
  [min, max]: readonly [number, number],
): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function cleanI18n(value: unknown, maxLen: number): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    if (!LOCALE_RE.test(k) || typeof v !== 'string') continue;
    const s = v.trim();
    if (s && s.length <= maxLen) out[k] = s;
  }
  return out;
}

/** Lenient read: defaults merged, invalid keys replaced by their default. */
export function normalizeDesignerSettings(raw: unknown): DesignerSettings {
  const d = DEFAULT_DESIGNER_SETTINGS;
  const L = DESIGNER_SETTINGS_LIMITS;
  const r = isRecord(raw) ? raw : {};
  const int = (key: keyof typeof L, def: number): number => {
    const v = r[key];
    return isIntIn(v, L[key] as readonly [number, number]) ? v : def;
  };
  const retention = int('retention_days', d.retention_days);
  let drafts = int('draft_retention_days', d.draft_retention_days);
  // Drafts never outlive the photo retention (§4.3 1..retention_days).
  if (drafts > retention) drafts = retention;
  const text = cleanI18n(r.shop_button_text, L.shop_button_text_length);
  return {
    retention_days: retention,
    draft_retention_days: drafts,
    print_keep_days_after_shipped: int(
      'print_keep_days_after_shipped',
      d.print_keep_days_after_shipped,
    ),
    max_upload_mb: int('max_upload_mb', d.max_upload_mb),
    min_effective_dpi_warning: int(
      'min_effective_dpi_warning',
      d.min_effective_dpi_warning,
    ),
    print_px_per_mm: (DESIGNER_PRINT_PX_PER_MM as readonly number[]).includes(
      r.print_px_per_mm as number,
    )
      ? (r.print_px_per_mm as number)
      : d.print_px_per_mm,
    print_formats:
      Array.isArray(r.print_formats) && r.print_formats.includes('pdf')
        ? ['png', 'pdf']
        : [...d.print_formats],
    print_crop_marks:
      typeof r.print_crop_marks === 'boolean'
        ? r.print_crop_marks
        : d.print_crop_marks,
    shop_button_text: Object.keys(text).length
      ? text
      : { ...d.shop_button_text },
  };
}

/**
 * Strict write validation. Every key is optional (defaults apply) and
 * unknown keys are ignored, but a present known key must be valid.
 */
export function validateDesignerSettings(raw: unknown): {
  ok: boolean;
  errors: string[];
} {
  if (!isRecord(raw)) {
    return { ok: false, errors: ['settings must be an object.'] };
  }
  const errors: string[] = [];
  const L = DESIGNER_SETTINGS_LIMITS;
  for (const key of [
    'retention_days',
    'draft_retention_days',
    'print_keep_days_after_shipped',
    'max_upload_mb',
    'min_effective_dpi_warning',
  ] as const) {
    if (!(key in raw)) continue;
    const [min, max] = L[key];
    if (!isIntIn(raw[key], [min, max])) {
      errors.push(`${key} must be a whole number from ${min} to ${max}.`);
    }
  }
  if (
    errors.length === 0 &&
    'draft_retention_days' in raw &&
    (raw.draft_retention_days as number) >
      ((raw.retention_days as number | undefined) ??
        DEFAULT_DESIGNER_SETTINGS.retention_days)
  ) {
    errors.push('draft_retention_days cannot be longer than retention_days.');
  }
  if (
    'print_px_per_mm' in raw &&
    !(DESIGNER_PRINT_PX_PER_MM as readonly unknown[]).includes(
      raw.print_px_per_mm,
    )
  ) {
    errors.push(
      `print_px_per_mm must be ${DESIGNER_PRINT_PX_PER_MM.join(' or ')} (6 px/mm = 3000×4200 for 500×700 mm).`,
    );
  }
  if ('print_formats' in raw) {
    const f = raw.print_formats;
    if (
      !Array.isArray(f) ||
      !f.includes('png') ||
      f.some(
        (x) => !(DESIGNER_PRINT_FORMATS as readonly unknown[]).includes(x),
      ) ||
      new Set(f).size !== f.length
    ) {
      errors.push(
        `print_formats must list 'png' and optionally 'pdf' (no duplicates); allowed: ${DESIGNER_PRINT_FORMATS.join(', ')}.`,
      );
    }
  }
  if ('print_crop_marks' in raw && typeof raw.print_crop_marks !== 'boolean') {
    errors.push('print_crop_marks must be true or false.');
  }
  if ('shop_button_text' in raw) {
    const v = raw.shop_button_text;
    if (
      !isRecord(v) ||
      Object.entries(v).some(
        ([k, s]) =>
          !LOCALE_RE.test(k) ||
          typeof s !== 'string' ||
          s.trim().length > L.shop_button_text_length,
      )
    ) {
      errors.push(
        `shop_button_text must map locale codes to texts of at most ${L.shop_button_text_length} characters.`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}
