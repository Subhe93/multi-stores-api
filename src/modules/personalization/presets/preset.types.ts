/**
 * Personalization presets (M4.1 §4.6, D12): code constants, versioned,
 * applied server-side in one transaction (`PersonalizationPresetsService`).
 */

/** Locales every preset ships text for (sv = namez 1:1; others fall back to en). */
export const PRESET_LOCALES = ['en', 'sv', 'ar', 'de', 'fr', 'tr'] as const;
export type PresetLocale = (typeof PRESET_LOCALES)[number];

/**
 * Param types (dashboard contract 4.1-E):
 * - option: a product option name (`variant_option_config[].name`)
 * - number: integer in `min..max`
 * - boolean, string, enum (`values`)
 * - string_list: non-empty list of strings
 * - option_value_map: `{ <value of the option named by param ref>: integer }`
 * - checked_list: `'all'` or a subset of the list param named by `ref`
 * - image_map: `{ <one of keys>: image URL }`
 */
export type PresetParamType =
  | 'option'
  | 'number'
  | 'boolean'
  | 'string'
  | 'string_list'
  | 'enum'
  | 'option_value_map'
  | 'checked_list'
  | 'image_map';

export interface PresetParam {
  key: string;
  type: PresetParamType;
  required?: boolean;
  default?: unknown;
  values?: string[];
  min?: number;
  max?: number;
  /** option_value_map: the option param; checked_list: the list param. */
  ref?: string;
  /** image_map: the accepted keys. */
  keys?: string[];
}

/** The public description (GET personalization/my/presets). */
export interface PresetSummary {
  key: string;
  version: number;
  params: PresetParam[];
}

export interface DraftTranslation {
  locale: string;
  label: string;
  placeholder?: string | null;
  option_labels?: Record<string, string> | null;
  display_label?: string | null;
  sublabel?: string | null;
  note?: string | null;
  help_text?: string | null;
  help_image_url?: string | null;
  messages?: Record<string, string> | null;
}

/** A field to create (no ids). `children` only for a REPEATER. */
export interface FieldDraft {
  name: string;
  type: string;
  is_required: boolean;
  placeholder?: string | null;
  options?: string[] | null;
  validation_rules?: Record<string, unknown> | null;
  linked_validation?: Record<string, unknown> | null;
  conditions?: Record<string, unknown> | null;
  pricing?: Record<string, unknown> | null;
  repeat?: Record<string, unknown> | null;
  ui?: Record<string, unknown> | null;
  translations: DraftTranslation[];
  children?: FieldDraft[];
  /** Overrides the applied preset's key (P3 creates P2's field with `single_name`). */
  preset_key?: string;
}

export interface PresetBuildContext {
  /** Names of the product's existing top-level fields. */
  existingNames: ReadonlySet<string>;
  /** The store's primary locale (P5 label locale). */
  primaryLocale: string;
}

export interface PresetDefinition {
  key: string;
  version: number;
  params: PresetParam[];
  /** Option params actually used by these params (default: every `option` param). */
  optionParamsUsed?(params: Record<string, unknown>): string[];
  /** Params are already validated and defaulted. */
  build(params: Record<string, unknown>, ctx: PresetBuildContext): FieldDraft[];
}

/** Per-locale text table → one translation row per preset locale. */
export function localized(
  table: Partial<Record<PresetLocale, Omit<DraftTranslation, 'locale'>>> & {
    en: Omit<DraftTranslation, 'locale'>;
  },
  extra: Partial<DraftTranslation> = {},
): DraftTranslation[] {
  return PRESET_LOCALES.map((locale) => ({
    ...(table[locale] ?? table.en),
    ...extra,
    locale,
  }));
}
