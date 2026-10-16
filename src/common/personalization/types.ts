/* eslint-disable */
// MIRROR (M4.1 C12): below this 3-line header, a byte copy of multi-stores-shared/src/personalization/types.ts.
// Never edit here: edit the shared file and run multi-stores-shared/scripts/sync-personalization-evaluator.mjs.
/**
 * Personalization app types (M4.1 §3.1, contracts C1/C12/C34).
 *
 * KEEP IN SYNC: types.ts, conditions.ts, evaluator.ts, display.ts and
 * personalization-cases.json are copied byte-for-byte to
 *   - multi-stores-api/src/common/personalization/ (with a 3-line mirror header)
 *   - multi-stores-web/src/lib/personalization/ (sha256 pinned in evaluator.hash.ts)
 * Pure code only: no Node, DOM, Nest or Prisma imports.
 */

import type { IssueCode, IssueParams, PatternTester } from './rules';

// ---------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------

/** Every custom field type, M4.0 types plus the app-only ones. */
export const P_FIELD_TYPES = [
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'IMAGE',
  'FILE',
  'SELECT',
  'COLOR',
  'FONT',
  'DATE',
  'MULTI_IMAGE',
  'CHECKBOX_GROUP',
  'COLOR_PALETTE',
  'REPEATER',
] as const;

export type PType = (typeof P_FIELD_TYPES)[number];

/** Types that exist only with the personalization app (dropped by the legacy branch). */
export const APP_ONLY_TYPES: ReadonlySet<string> = new Set([
  'CHECKBOX_GROUP',
  'COLOR_PALETTE',
  'REPEATER',
]);

/** Types a REPEATER child may have (D5). */
export const REPEATER_CHILD_TYPES: ReadonlySet<string> = new Set([
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'SELECT',
  'FONT',
  'COLOR',
  'DATE',
  'CHECKBOX_GROUP',
  'COLOR_PALETTE',
]);

/** Ops of a visibility rule (§3.3). */
export const P_CONDITION_OPS = [
  'eq',
  'neq',
  'in',
  'nin',
  'gt',
  'gte',
  'lt',
  'lte',
  'set',
  'unset',
] as const;

export type PConditionOp = (typeof P_CONDITION_OPS)[number];

export interface PConditionRule {
  /** 'option' = a product option (variant attribute) name; 'field' = an earlier top-level field name. */
  source: 'option' | 'field';
  key: string;
  op: PConditionOp;
  value?: string | number | string[];
}

export interface PConditions {
  match: 'all' | 'any';
  rules: PConditionRule[];
}

export const P_PRICING_MODES = ['fixed', 'per_option', 'per_char', 'per_item'] as const;

export type PPricingMode = (typeof P_PRICING_MODES)[number];

/** Price modifier, per unit, base currency, ≥ 0. Amounts are numbers or decimal strings. */
export interface PPricing {
  mode: PPricingMode;
  amount?: number | string;
  option_prices?: Record<string, number | string>;
}

export interface PRepeat {
  count: { option: string; map?: Record<string, number> };
  /** First instance index (≥ 1). Item `start_index - 1` is the lead item. */
  start_index: number;
  /** Maximum number of instances (≤ 20). */
  max: number;
  /** The lead item (namez "item 1 = variant colour + name"). */
  lead?: { fields?: string[]; options?: string[] };
}

export interface PUi {
  placement?: 'before_variants' | 'after_variants';
  transform?: 'uppercase' | 'none';
  counter?: boolean | 'linked';
  insert_char?: string;
  limit_to_target?: boolean;
  default_checked?: string[];
  palette_from_option?: string;
  palette_hex?: Record<string, string>;
  validation_summary?: boolean;
  font_family?: string;
}

/** `translation.messages` keys (C34) and the issue code each one overrides. */
export const P_MESSAGE_KEYS = {
  required: 'CUSTOM_FIELD_REQUIRED',
  pattern: 'CUSTOM_FIELD_INVALID_FORMAT',
  allowed_chars: 'CUSTOM_FIELD_INVALID_CHARS',
  equal_length: 'CUSTOM_FIELD_LENGTH_MISMATCH',
  max_length: 'CUSTOM_FIELD_TOO_LONG',
  min_checked: 'CUSTOM_FIELD_MIN_CHECKED',
  max_checked: 'CUSTOM_FIELD_MAX_CHECKED',
} as const;

export type PMessageKey = keyof typeof P_MESSAGE_KEYS;

export interface PTranslation {
  locale: string;
  label?: string | null;
  placeholder?: string | null;
  option_labels?: unknown;
  display_label?: string | null;
  sublabel?: string | null;
  note?: string | null;
  help_text?: string | null;
  help_image_url?: string | null;
  /** `{ required?, pattern?, ... }`; `{i}` is replaced by the item index. */
  messages?: unknown;
}

/**
 * A ProductCustomField row as the evaluator reads it. Accepts a flat list
 * (children carry `parent_id`) or a tree (`children`), or both. The JSON
 * columns are read leniently (`unknown` is fine: rows come from Prisma).
 */
export interface PFieldDef {
  id: string;
  name: string;
  type: PType | string;
  is_required: boolean;
  parent_id?: string | null;
  sort_order?: number | null;
  options?: unknown;
  /** `{max_length?, min_length?, pattern?, allowed_chars?, min_checked?, max_checked?}`; NUMBER bounds = min/max_length (C17). */
  validation_rules?: unknown;
  linked_validation?: unknown;
  conditions?: PConditions | unknown;
  pricing?: PPricing | unknown;
  repeat?: PRepeat | unknown;
  ui?: PUi | unknown;
  translations?: PTranslation[] | null;
  children?: PFieldDef[] | null;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** One `Product.variant_option_config` entry (only the keys the evaluator reads). */
export interface POptionConfig {
  name: string;
  style?: string;
  values?: string[];
  colorMap?: Record<string, string>;
  valueMeta?: Record<string, { count?: number; label?: string } | undefined>;
}

export interface PContext {
  /** `isEnabled(store,'personalization') && own product` (D2). False = legacy branch (D10). */
  appEnabled: boolean;
  /** Chosen option values (`ProductVariant.options` on the server, the partial picks on the client). */
  variantOptions: Record<string, string>;
  optionConfig?: POptionConfig[] | null;
  /** Option values present on active variants; an absent key means "no restriction". */
  activeOptionValues?: Record<string, string[]>;
  locale: string;
  primaryLocale: string;
  /** File reference check passed to `validatePersonalization` (server adds a host check). */
  isFileRef?: (url: string) => boolean;
  /** Pattern runner passed to `validatePersonalization` (server: ReDoS timeout). */
  patternTester?: PatternTester;
  /** Creator-filled values; used by the legacy branch only (custom products are always legacy, D2). */
  prefilled?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type PErrorCode =
  | IssueCode
  | 'CUSTOM_FIELD_MIN_CHECKED'
  | 'CUSTOM_FIELD_MAX_CHECKED'
  /** The price delta does not fit a Decimal(10,2) amount (payload-level, `field_id` ''). */
  | 'PERSONALIZATION_PRICE_TOO_HIGH';

export interface PError {
  code: PErrorCode;
  /** Top-level field id ('' for a payload issue). For a repeater child: the REPEATER's id. */
  field_id: string;
  field_name: string;
  /** Repeater child that failed (with `group_index`). */
  child_id?: string;
  child_name?: string;
  /** Repeater item index ("Artikel i"). */
  group_index?: number;
  params?: IssueParams;
  /** `translation.messages[key]` with `{i}` replaced; '' → the UI uses its i18n text. */
  message: string;
}

/** `{ "<locale>": text }` as stored in the snapshot JSON columns (C1). */
export type LocaleText = Record<string, string>;

export interface PLineMeta {
  hex?: string;
  option_name?: string;
}

/**
 * One display / snapshot line (one per visible leaf value; one per file for
 * file types). `label`, `display_value` and `group_label` are resolved for
 * `ctx.locale`; `i18n` holds the locale maps for the order snapshot (C1).
 */
export interface PLine {
  field_id: string | null;
  field_name: string;
  source: 'FIELD' | 'OPTION';
  /** Field type, or 'OPTION' for a variant option line. */
  type: string;
  label: string;
  /** Stored text: the value, or the file URL when `is_file`. */
  value: string;
  display_value: string;
  is_file: boolean;
  group_key: string | null;
  group_index: number | null;
  group_label: string | null;
  /** Per unit, base currency, two decimals ("0.00"). */
  price_delta: string;
  /** Same amount in integer minor units (cents). */
  price_delta_minor: number;
  meta: PLineMeta | null;
  sort_order: number;
  i18n: {
    /** Snapshot `field_label`; null when no translation has a label. */
    label: LocaleText | null;
    /** Snapshot `display_value`; null when the value is shown as-is. */
    display_value: LocaleText | null;
    /** Snapshot `group_label`; null outside a group or without a label template. */
    group_label: LocaleText | null;
  };
}

export interface PResult {
  ok: boolean;
  errors: PError[];
  /** Canonical values (keys sorted, repeater arrays dense, checkbox lists in option order). */
  values: Record<string, unknown>;
  /** Per-unit delta, base currency, two decimals ("0.00"); sum of the lines' deltas. */
  priceDelta: string;
  priceDeltaMinor: number;
  lines: PLine[];
  /** Visible top-level field ids plus the children of repeaters with ≥ 1 instance. */
  visibleIds: string[];
  legacy: boolean;
}
