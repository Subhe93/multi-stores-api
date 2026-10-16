import {
  APP_ONLY_TYPES,
  P_CONDITION_OPS,
  P_FIELD_TYPES,
  P_MESSAGE_KEYS,
  P_PRICING_MODES,
  REPEATER_CHILD_TYPES,
} from '../../common/personalization/types';
import {
  MAX_REPEAT_INSTANCES,
  optionValues,
} from '../../common/personalization/evaluator';
import { charCount, isPlainObject } from '../../common/personalization/rules';
import type { ConfigIssue } from './personalization.errors';

/**
 * Save-time check of a field's personalization config (M4.1 §4.1). Pure:
 * the caller passes the product's other fields and its
 * `variant_option_config`. M4.0's checks of `validation_rules` (pattern
 * without `u`, allowed_chars class body with `u`, bounds) run separately in
 * `custom-field-definition.ts`; this validator covers the app-only keys.
 *
 * Issue codes (the `errors[].code` of PERSONALIZATION_CONFIG_INVALID):
 * INVALID_SHAPE, UNKNOWN_KEY, INVALID_TYPE, OUT_OF_RANGE, INVALID_VALUE,
 * UNKNOWN_OPTION, UNKNOWN_FIELD, FORWARD_REFERENCE, NOT_TOP_LEVEL,
 * PARENT_NOT_FOUND, PARENT_NOT_REPEATER, CHILD_TYPE_NOT_ALLOWED,
 * CHILD_NO_CONDITIONS, REPEATER_TOP_LEVEL_ONLY, REPEAT_REQUIRED,
 * REPEAT_ONLY_REPEATER, REPEATER_HAS_CHILDREN, NEGATIVE_PRICE,
 * INVALID_PRICE, PRICING_NOT_ALLOWED, NOT_IN_OPTIONS, INVALID_HEX,
 * LINK_TARGET_NOT_SIBLING, INVALID_URL, TOO_LONG.
 */

export interface ConfigDraft {
  id?: string | null;
  name: string;
  type: string;
  parent_id?: string | null;
  sort_order?: number | null;
  options?: unknown;
  linked_validation?: unknown;
  conditions?: unknown;
  pricing?: unknown;
  repeat?: unknown;
  ui?: unknown;
}

/** Another field of the same product (children included). */
export interface ConfigSibling {
  id: string;
  name: string;
  type: string;
  parent_id: string | null;
  sort_order: number | null;
}

export interface ValidateFieldConfigOptions {
  /** The field already has children (a REPEATER must stay a REPEATER). */
  hasChildren?: boolean;
}

export const CONFIG_LIMITS = {
  conditionRules: 20,
  conditionValues: 50,
  keyLength: 120,
  countMapEntries: 100,
  countMax: 100,
  maxPriceMajor: 1_000_000,
  optionPrices: 100,
  paletteHex: 100,
  defaultChecked: 50,
  fontFamily: 100,
  translationText: 2000,
  messageText: 500,
  urlLength: 2000,
  valueMetaText: 200,
  valueMetaLocales: 20,
  localeLength: 10,
} as const;

/** A translation locale key (`sv`, `en-US`, `zh-Hant`). */
export const LOCALE_KEY = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
/** A CSS font-family list: letters, digits, spaces, quotes, commas, `-`, `_`, `.`. */
const FONT_FAMILY = /^[\p{L}\p{N} ,'"\-_.]*$/u;

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const PRICE_TEXT = /^\d{1,9}(?:[.,]\d{1,2})?$/;

const CONDITION_KEYS = new Set(['match', 'rules']);
const RULE_KEYS = new Set(['source', 'key', 'op', 'value']);
const PRICING_KEYS = new Set(['mode', 'amount', 'option_prices']);
const REPEAT_KEYS = new Set(['count', 'start_index', 'max', 'lead']);
const COUNT_KEYS = new Set(['option', 'map']);
const LEAD_KEYS = new Set(['fields', 'options']);
const UI_KEYS = new Set([
  'placement',
  'transform',
  'counter',
  'insert_char',
  'limit_to_target',
  'default_checked',
  'palette_from_option',
  'palette_hex',
  'validation_summary',
  'font_family',
]);
const VALUE_META_KEYS = new Set([
  'label',
  'sublabel',
  'badge',
  'badge_color',
  'count',
  'i18n',
]);

/** Types whose value is one or more option strings (per_option pricing). */
const OPTION_PRICED_TYPES = new Set([
  'SELECT',
  'FONT',
  'COLOR_PALETTE',
  'CHECKBOX_GROUP',
]);

/** The option names (and values) of a product's `variant_option_config`. */
export function readOptionNames(optionConfig: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!Array.isArray(optionConfig)) return out;
  for (const o of optionConfig) {
    if (!isPlainObject(o) || typeof o.name !== 'string' || o.name === '') {
      continue;
    }
    const values = Array.isArray(o.values)
      ? o.values.filter((v): v is string => typeof v === 'string')
      : [];
    out.set(o.name, values);
  }
  return out;
}

/** A non-negative amount (number or decimal text) up to 1 000 000. */
function priceIssue(v: unknown): 'NEGATIVE_PRICE' | 'INVALID_PRICE' | null {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'INVALID_PRICE';
    if (v < 0) return 'NEGATIVE_PRICE';
    if (v > CONFIG_LIMITS.maxPriceMajor) return 'INVALID_PRICE';
    return Math.round(v * 100) / 100 === v ? null : 'INVALID_PRICE';
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('-')) return 'NEGATIVE_PRICE';
    if (!PRICE_TEXT.test(s)) return 'INVALID_PRICE';
    return Number(s.replace(',', '.')) > CONFIG_LIMITS.maxPriceMajor
      ? 'INVALID_PRICE'
      : null;
  }
  return 'INVALID_PRICE';
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function unknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  out: ConfigIssue[],
): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k))
      out.push({ path: `${path}.${k}`, code: 'UNKNOWN_KEY' });
  }
}

/** True when `sib` is evaluated before `draft` (top level, sort_order then id). */
function isEarlier(sib: ConfigSibling, draft: ConfigDraft): boolean {
  const ds =
    typeof draft.sort_order === 'number'
      ? draft.sort_order
      : Number.POSITIVE_INFINITY;
  const ss = typeof sib.sort_order === 'number' ? sib.sort_order : 0;
  if (ss !== ds) return ss < ds;
  return !!draft.id && sib.id < draft.id;
}

/**
 * Problems of `draft`'s personalization config; empty = valid. `siblings`
 * are the product's other fields (the draft itself is ignored by id).
 */
export function validateFieldConfig(
  draft: ConfigDraft,
  siblings: readonly ConfigSibling[],
  optionConfig: unknown,
  opts: ValidateFieldConfigOptions = {},
): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  const others = siblings.filter((s) => !draft.id || s.id !== draft.id);
  const options = readOptionNames(optionConfig);
  const parentId =
    typeof draft.parent_id === 'string' && draft.parent_id !== ''
      ? draft.parent_id
      : null;
  const isChild = parentId !== null;
  const type = draft.type;

  if (!(P_FIELD_TYPES as readonly string[]).includes(type)) {
    out.push({ path: 'type', code: 'INVALID_TYPE' });
  }

  // Tree rules (D5): a child is never a REPEATER and has no conditions; a
  // REPEATER is top level only and owns the `repeat` config.
  if (isChild) {
    const parent = others.find((s) => s.id === parentId);
    if (!parent) {
      out.push({ path: 'parent_id', code: 'PARENT_NOT_FOUND' });
    } else if (parent.type !== 'REPEATER' || parent.parent_id) {
      out.push({ path: 'parent_id', code: 'PARENT_NOT_REPEATER' });
    }
    if (!REPEATER_CHILD_TYPES.has(type)) {
      out.push({ path: 'type', code: 'CHILD_TYPE_NOT_ALLOWED' });
    }
    if (draft.conditions !== undefined && draft.conditions !== null) {
      out.push({ path: 'conditions', code: 'CHILD_NO_CONDITIONS' });
    }
  }
  if (type === 'REPEATER') {
    if (isChild)
      out.push({ path: 'parent_id', code: 'REPEATER_TOP_LEVEL_ONLY' });
    if (draft.repeat === undefined || draft.repeat === null) {
      out.push({ path: 'repeat', code: 'REPEAT_REQUIRED' });
    }
  } else {
    if (draft.repeat !== undefined && draft.repeat !== null) {
      out.push({ path: 'repeat', code: 'REPEAT_ONLY_REPEATER' });
    }
    if (opts.hasChildren) {
      out.push({ path: 'type', code: 'REPEATER_HAS_CHILDREN' });
    }
  }

  const topLevel = others.filter((s) => !s.parent_id);
  const earlierField = (name: string): ConfigSibling | null =>
    topLevel.find((s) => s.name === name) ?? null;

  // linked_validation.target names a sibling in the same set (C16).
  if (isPlainObject(draft.linked_validation)) {
    const raw = draft.linked_validation;
    const target =
      typeof raw.target === 'string' && raw.target.trim() !== ''
        ? raw.target.trim()
        : typeof raw.target_field_id === 'string'
          ? raw.target_field_id.trim()
          : '';
    const set = others.filter((s) => (s.parent_id ?? null) === parentId);
    if (!set.some((s) => s.name === target || s.id === target)) {
      out.push({
        path: 'linked_validation.target',
        code: 'LINK_TARGET_NOT_SIBLING',
      });
    }
  }

  checkConditions(draft, options, earlierField, out);
  checkPricing(draft, options, out);
  if (type === 'REPEATER') checkRepeat(draft, options, earlierField, out);
  checkUi(draft, options, out);
  // A palette comes from a product option or from the field's own options.
  if (type === 'COLOR_PALETTE') {
    const ui = isPlainObject(draft.ui) ? draft.ui : {};
    const fromOption =
      typeof ui.palette_from_option === 'string' &&
      ui.palette_from_option !== '';
    if (!fromOption && optionValues(draft.options).length === 0) {
      out.push({ path: 'options', code: 'INVALID_VALUE' });
    }
  }
  return out;
}

function checkConditions(
  draft: ConfigDraft,
  options: Map<string, string[]>,
  earlierField: (name: string) => ConfigSibling | null,
  out: ConfigIssue[],
): void {
  const raw = draft.conditions;
  if (raw === undefined || raw === null) return;
  if (!isPlainObject(raw)) {
    out.push({ path: 'conditions', code: 'INVALID_SHAPE' });
    return;
  }
  unknownKeys(raw, CONDITION_KEYS, 'conditions', out);
  if (raw.match !== 'all' && raw.match !== 'any') {
    out.push({ path: 'conditions.match', code: 'INVALID_VALUE' });
  }
  if (
    !Array.isArray(raw.rules) ||
    raw.rules.length === 0 ||
    raw.rules.length > CONFIG_LIMITS.conditionRules
  ) {
    out.push({
      path: 'conditions.rules',
      code: 'OUT_OF_RANGE',
      params: { min: 1, max: CONFIG_LIMITS.conditionRules },
    });
    return;
  }
  raw.rules.forEach((rule: unknown, i: number) => {
    const p = `conditions.rules[${i}]`;
    if (!isPlainObject(rule)) {
      out.push({ path: p, code: 'INVALID_SHAPE' });
      return;
    }
    unknownKeys(rule, RULE_KEYS, p, out);
    const op = rule.op;
    if (
      typeof op !== 'string' ||
      !(P_CONDITION_OPS as readonly string[]).includes(op)
    ) {
      out.push({ path: `${p}.op`, code: 'INVALID_VALUE' });
    }
    const key = typeof rule.key === 'string' ? rule.key : '';
    if (key === '' || key.length > CONFIG_LIMITS.keyLength) {
      out.push({ path: `${p}.key`, code: 'INVALID_VALUE' });
    } else if (rule.source === 'option') {
      if (!options.has(key)) {
        out.push({ path: `${p}.key`, code: 'UNKNOWN_OPTION', params: { key } });
      }
    } else if (rule.source === 'field') {
      const target = earlierField(key);
      if (!target || key === draft.name) {
        out.push({ path: `${p}.key`, code: 'UNKNOWN_FIELD', params: { key } });
      } else if (!isEarlier(target, draft)) {
        out.push({
          path: `${p}.key`,
          code: 'FORWARD_REFERENCE',
          params: { key },
        });
      }
    } else {
      out.push({ path: `${p}.source`, code: 'INVALID_VALUE' });
    }
    const v = rule.value;
    switch (op) {
      case 'set':
      case 'unset':
        if (v !== undefined && v !== null) {
          out.push({ path: `${p}.value`, code: 'INVALID_VALUE' });
        }
        break;
      case 'eq':
      case 'neq':
        if (
          !(typeof v === 'string' && v.length <= CONFIG_LIMITS.keyLength) &&
          !(typeof v === 'number' && Number.isFinite(v))
        ) {
          out.push({ path: `${p}.value`, code: 'INVALID_VALUE' });
        }
        break;
      case 'in':
      case 'nin':
        if (
          !Array.isArray(v) ||
          v.length === 0 ||
          v.length > CONFIG_LIMITS.conditionValues ||
          !v.every(
            (x) =>
              (typeof x === 'string' && x.length <= CONFIG_LIMITS.keyLength) ||
              (typeof x === 'number' && Number.isFinite(x)),
          )
        ) {
          out.push({ path: `${p}.value`, code: 'INVALID_VALUE' });
        }
        break;
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          out.push({ path: `${p}.value`, code: 'INVALID_VALUE' });
        }
        break;
      default:
        break;
    }
  });
}

/**
 * The values a per_option price may name: the palette option's values for a
 * COLOR_PALETTE that reads a product option, else the field's own options.
 */
function pricedOptionValues(
  draft: ConfigDraft,
  options: Map<string, string[]>,
): string[] {
  const ui = isPlainObject(draft.ui) ? draft.ui : {};
  if (
    draft.type === 'COLOR_PALETTE' &&
    typeof ui.palette_from_option === 'string' &&
    ui.palette_from_option !== ''
  ) {
    return (options.get(ui.palette_from_option) ?? []).map((v) =>
      v.normalize('NFC').trim(),
    );
  }
  return optionValues(draft.options);
}

function checkPricing(
  draft: ConfigDraft,
  options: Map<string, string[]>,
  out: ConfigIssue[],
): void {
  const raw = draft.pricing;
  if (raw === undefined || raw === null) return;
  if (!isPlainObject(raw)) {
    out.push({ path: 'pricing', code: 'INVALID_SHAPE' });
    return;
  }
  unknownKeys(raw, PRICING_KEYS, 'pricing', out);
  const mode = raw.mode;
  if (
    typeof mode !== 'string' ||
    !(P_PRICING_MODES as readonly string[]).includes(mode)
  ) {
    out.push({ path: 'pricing.mode', code: 'INVALID_VALUE' });
    return;
  }
  const allowed =
    mode === 'fixed' ||
    (mode === 'per_option' && OPTION_PRICED_TYPES.has(draft.type)) ||
    (mode === 'per_char' &&
      (draft.type === 'TEXT' || draft.type === 'TEXTAREA')) ||
    (mode === 'per_item' && draft.type === 'REPEATER');
  if (!allowed) {
    out.push({
      path: 'pricing.mode',
      code: 'PRICING_NOT_ALLOWED',
      params: { mode },
    });
  }
  if (mode === 'per_option') {
    if (raw.amount !== undefined && raw.amount !== null) {
      out.push({ path: 'pricing.amount', code: 'INVALID_VALUE' });
    }
    if (!isPlainObject(raw.option_prices)) {
      out.push({ path: 'pricing.option_prices', code: 'INVALID_SHAPE' });
      return;
    }
    const entries = Object.entries(raw.option_prices);
    if (entries.length > CONFIG_LIMITS.optionPrices) {
      out.push({ path: 'pricing.option_prices', code: 'OUT_OF_RANGE' });
    }
    // per_option needs choices to price (FONT included) and every priced
    // key must be one of them.
    const priced = new Set(pricedOptionValues(draft, options));
    if (priced.size === 0) {
      out.push({ path: 'options', code: 'INVALID_VALUE' });
    }
    for (const [k, v] of entries) {
      if (k.length > CONFIG_LIMITS.keyLength) {
        out.push({ path: 'pricing.option_prices', code: 'TOO_LONG' });
        continue;
      }
      const issue = priceIssue(v);
      if (issue) out.push({ path: `pricing.option_prices.${k}`, code: issue });
      else if (priced.size > 0 && !priced.has(k.normalize('NFC').trim())) {
        out.push({
          path: `pricing.option_prices.${k}`,
          code: 'NOT_IN_OPTIONS',
        });
      }
    }
    return;
  }
  if (raw.option_prices !== undefined && raw.option_prices !== null) {
    out.push({ path: 'pricing.option_prices', code: 'INVALID_VALUE' });
  }
  const issue = priceIssue(raw.amount);
  if (issue) out.push({ path: 'pricing.amount', code: issue });
}

function checkRepeat(
  draft: ConfigDraft,
  options: Map<string, string[]>,
  earlierField: (name: string) => ConfigSibling | null,
  out: ConfigIssue[],
): void {
  const raw = draft.repeat;
  if (raw === undefined || raw === null) return;
  if (!isPlainObject(raw)) {
    out.push({ path: 'repeat', code: 'INVALID_SHAPE' });
    return;
  }
  unknownKeys(raw, REPEAT_KEYS, 'repeat', out);
  if (!isPlainObject(raw.count)) {
    out.push({ path: 'repeat.count', code: 'INVALID_SHAPE' });
  } else {
    unknownKeys(raw.count, COUNT_KEYS, 'repeat.count', out);
    const option = raw.count.option;
    if (typeof option !== 'string' || !options.has(option)) {
      out.push({
        path: 'repeat.count.option',
        code: 'UNKNOWN_OPTION',
        params: { key: typeof option === 'string' ? option.slice(0, 120) : '' },
      });
    }
    const map = raw.count.map;
    if (map !== undefined && map !== null) {
      if (!isPlainObject(map)) {
        out.push({ path: 'repeat.count.map', code: 'INVALID_SHAPE' });
      } else {
        const entries = Object.entries(map);
        if (entries.length > CONFIG_LIMITS.countMapEntries) {
          out.push({ path: 'repeat.count.map', code: 'OUT_OF_RANGE' });
        }
        for (const [k, v] of entries) {
          if (k.length > CONFIG_LIMITS.keyLength) {
            out.push({ path: 'repeat.count.map', code: 'TOO_LONG' });
          } else if (!isInt(v, 0, CONFIG_LIMITS.countMax)) {
            out.push({
              path: `repeat.count.map.${k}`,
              code: 'OUT_OF_RANGE',
              params: { min: 0, max: CONFIG_LIMITS.countMax },
            });
          }
        }
      }
    }
  }
  if (!isInt(raw.start_index, 1, MAX_REPEAT_INSTANCES)) {
    out.push({
      path: 'repeat.start_index',
      code: 'OUT_OF_RANGE',
      params: { min: 1, max: MAX_REPEAT_INSTANCES },
    });
  }
  if (!isInt(raw.max, 1, MAX_REPEAT_INSTANCES)) {
    out.push({
      path: 'repeat.max',
      code: 'OUT_OF_RANGE',
      params: { min: 1, max: MAX_REPEAT_INSTANCES },
    });
  }
  const lead = raw.lead;
  if (lead === undefined || lead === null) return;
  if (!isPlainObject(lead)) {
    out.push({ path: 'repeat.lead', code: 'INVALID_SHAPE' });
    return;
  }
  unknownKeys(lead, LEAD_KEYS, 'repeat.lead', out);
  for (const k of ['fields', 'options'] as const) {
    const list = lead[k];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list) || list.length > MAX_REPEAT_INSTANCES) {
      out.push({ path: `repeat.lead.${k}`, code: 'INVALID_SHAPE' });
      continue;
    }
    list.forEach((name: unknown, i: number) => {
      const p = `repeat.lead.${k}[${i}]`;
      if (typeof name !== 'string' || name === '') {
        out.push({ path: p, code: 'INVALID_VALUE' });
      } else if (k === 'options') {
        if (!options.has(name)) {
          out.push({ path: p, code: 'UNKNOWN_OPTION', params: { key: name } });
        }
      } else {
        const target = earlierField(name);
        if (!target) {
          out.push({ path: p, code: 'UNKNOWN_FIELD', params: { key: name } });
        } else if (target.type === 'REPEATER') {
          out.push({ path: p, code: 'INVALID_VALUE', params: { key: name } });
        } else if (!isEarlier(target, draft)) {
          out.push({
            path: p,
            code: 'FORWARD_REFERENCE',
            params: { key: name },
          });
        }
      }
    });
  }
}

function checkUi(
  draft: ConfigDraft,
  options: Map<string, string[]>,
  out: ConfigIssue[],
): void {
  const raw = draft.ui;
  if (raw === undefined || raw === null) return;
  if (!isPlainObject(raw)) {
    out.push({ path: 'ui', code: 'INVALID_SHAPE' });
    return;
  }
  unknownKeys(raw, UI_KEYS, 'ui', out);
  const bad = (k: string) =>
    out.push({ path: `ui.${k}`, code: 'INVALID_VALUE' });
  if (
    raw.placement !== undefined &&
    raw.placement !== 'before_variants' &&
    raw.placement !== 'after_variants'
  ) {
    bad('placement');
  }
  if (
    raw.transform !== undefined &&
    raw.transform !== 'uppercase' &&
    raw.transform !== 'none'
  ) {
    bad('transform');
  }
  if (
    raw.counter !== undefined &&
    typeof raw.counter !== 'boolean' &&
    raw.counter !== 'linked'
  ) {
    bad('counter');
  }
  for (const k of ['limit_to_target', 'validation_summary'] as const) {
    if (raw[k] !== undefined && typeof raw[k] !== 'boolean') bad(k);
  }
  if (
    raw.insert_char !== undefined &&
    !(typeof raw.insert_char === 'string' && charCount(raw.insert_char) === 1)
  ) {
    bad('insert_char');
  }
  if (
    raw.font_family !== undefined &&
    !(
      typeof raw.font_family === 'string' &&
      raw.font_family.length <= CONFIG_LIMITS.fontFamily &&
      FONT_FAMILY.test(raw.font_family)
    )
  ) {
    bad('font_family');
  }
  if (raw.default_checked !== undefined) {
    const list = raw.default_checked;
    if (
      draft.type !== 'CHECKBOX_GROUP' ||
      !Array.isArray(list) ||
      list.length > CONFIG_LIMITS.defaultChecked
    ) {
      bad('default_checked');
    } else {
      const allowed = new Set(optionValues(draft.options));
      list.forEach((v: unknown, i: number) => {
        if (typeof v !== 'string' || !allowed.has(v.normalize('NFC').trim())) {
          out.push({
            path: `ui.default_checked[${i}]`,
            code: 'NOT_IN_OPTIONS',
          });
        }
      });
    }
  }
  if (raw.palette_from_option !== undefined) {
    const option = raw.palette_from_option;
    if (draft.type !== 'COLOR_PALETTE' || typeof option !== 'string') {
      bad('palette_from_option');
    } else if (!options.has(option)) {
      out.push({
        path: 'ui.palette_from_option',
        code: 'UNKNOWN_OPTION',
        params: { key: option },
      });
    }
  }
  if (raw.palette_hex !== undefined) {
    if (!isPlainObject(raw.palette_hex)) {
      bad('palette_hex');
    } else {
      const entries = Object.entries(raw.palette_hex);
      if (entries.length > CONFIG_LIMITS.paletteHex) bad('palette_hex');
      for (const [k, v] of entries) {
        if (k.length > CONFIG_LIMITS.keyLength) {
          out.push({ path: 'ui.palette_hex', code: 'TOO_LONG' });
        } else if (typeof v !== 'string' || !HEX.test(v)) {
          out.push({ path: `ui.palette_hex.${k}`, code: 'INVALID_HEX' });
        }
      }
    }
  }
}

/** True for an app-only type (CHECKBOX_GROUP, COLOR_PALETTE, REPEATER). */
export function isAppOnlyType(type: unknown): boolean {
  return typeof type === 'string' && APP_ONLY_TYPES.has(type);
}

// ---------------------------------------------------------------------------
// Translations
// ---------------------------------------------------------------------------

/** The six M4.1 translation columns (C6). */
export const TRANSLATION_EXTRA_KEYS = [
  'display_label',
  'sublabel',
  'note',
  'help_text',
  'help_image_url',
  'messages',
] as const;

export type TranslationExtraKey = (typeof TRANSLATION_EXTRA_KEYS)[number];

/** A help image URL: http(s) or a site-relative path (never `//host` or `javascript:`). */
export function isSafeImageUrl(v: string): boolean {
  if (v.length > CONFIG_LIMITS.urlLength) return false;
  if (v.startsWith('/')) return !v.startsWith('//') && !v.startsWith('/\\');
  return /^https?:\/\/[^\s/]+/i.test(v);
}

/** Problems of one translation's M4.1 columns (`path` prefix e.g. `translations[0]`). */
export function validateTranslationExtras(
  t: Record<string, unknown>,
  path: string,
): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  for (const k of ['display_label', 'sublabel', 'note', 'help_text'] as const) {
    const v = t[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string')
      out.push({ path: `${path}.${k}`, code: 'INVALID_VALUE' });
    else if (v.length > CONFIG_LIMITS.translationText) {
      out.push({ path: `${path}.${k}`, code: 'TOO_LONG' });
    }
  }
  const url = t.help_image_url;
  if (url !== undefined && url !== null && url !== '') {
    if (typeof url !== 'string' || !isSafeImageUrl(url)) {
      out.push({ path: `${path}.help_image_url`, code: 'INVALID_URL' });
    }
  }
  const messages = t.messages;
  if (messages !== undefined && messages !== null) {
    if (!isPlainObject(messages)) {
      out.push({ path: `${path}.messages`, code: 'INVALID_SHAPE' });
    } else {
      for (const [k, v] of Object.entries(messages)) {
        if (!Object.prototype.hasOwnProperty.call(P_MESSAGE_KEYS, k)) {
          out.push({ path: `${path}.messages.${k}`, code: 'UNKNOWN_KEY' });
        } else if (v !== null && typeof v !== 'string') {
          out.push({ path: `${path}.messages.${k}`, code: 'INVALID_VALUE' });
        } else if (
          typeof v === 'string' &&
          v.length > CONFIG_LIMITS.messageText
        ) {
          out.push({ path: `${path}.messages.${k}`, code: 'TOO_LONG' });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Option config (variation cards, D9 / C38)
// ---------------------------------------------------------------------------

/**
 * Problems of the M4.1 keys of a `variant_option_config` (`valueMeta`
 * keys ⊆ values, `badge_color` hex, `count` integer 0..100). Exported for
 * the product write path; other keys (colorMap, swatchMap, …) are not
 * checked here.
 */
export function validateOptionConfig(optionConfig: unknown): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  if (optionConfig === null || optionConfig === undefined) return out;
  if (!Array.isArray(optionConfig)) {
    return [{ path: 'variant_option_config', code: 'INVALID_SHAPE' }];
  }
  optionConfig.forEach((o: unknown, i: number) => {
    if (
      !isPlainObject(o) ||
      o.valueMeta === undefined ||
      o.valueMeta === null
    ) {
      return;
    }
    const p = `variant_option_config[${i}].valueMeta`;
    if (!isPlainObject(o.valueMeta)) {
      out.push({ path: p, code: 'INVALID_SHAPE' });
      return;
    }
    const values = new Set(
      Array.isArray(o.values)
        ? o.values.filter((v) => typeof v === 'string')
        : [],
    );
    for (const [value, meta] of Object.entries(o.valueMeta)) {
      if (value.length > CONFIG_LIMITS.keyLength) {
        out.push({ path: p, code: 'TOO_LONG' });
        continue;
      }
      const mp = `${p}.${value}`;
      if (!values.has(value)) out.push({ path: mp, code: 'NOT_IN_OPTIONS' });
      if (!isPlainObject(meta)) {
        out.push({ path: mp, code: 'INVALID_SHAPE' });
        continue;
      }
      unknownKeys(meta, VALUE_META_KEYS, mp, out);
      for (const k of ['label', 'sublabel', 'badge'] as const) {
        const v = meta[k];
        if (
          v !== undefined &&
          v !== null &&
          !(typeof v === 'string' && v.length <= CONFIG_LIMITS.valueMetaText)
        ) {
          out.push({ path: `${mp}.${k}`, code: 'INVALID_VALUE' });
        }
      }
      if (
        meta.badge_color !== undefined &&
        meta.badge_color !== null &&
        !(typeof meta.badge_color === 'string' && HEX.test(meta.badge_color))
      ) {
        out.push({ path: `${mp}.badge_color`, code: 'INVALID_HEX' });
      }
      if (
        meta.count !== undefined &&
        meta.count !== null &&
        !isInt(meta.count, 0, CONFIG_LIMITS.countMax)
      ) {
        out.push({
          path: `${mp}.count`,
          code: 'OUT_OF_RANGE',
          params: { min: 0, max: CONFIG_LIMITS.countMax },
        });
      }
      if (meta.i18n !== undefined && meta.i18n !== null) {
        checkValueMetaI18n(meta.i18n, `${mp}.i18n`, out);
      }
    }
  });
  return out;
}

const VALUE_META_I18N_KEYS = new Set(['label', 'sublabel', 'badge']);

/** `valueMeta[v].i18n`: `{<locale>: {label?, sublabel?, badge?}}`, strings within limits. */
function checkValueMetaI18n(
  raw: unknown,
  path: string,
  out: ConfigIssue[],
): void {
  if (!isPlainObject(raw)) {
    out.push({ path, code: 'INVALID_SHAPE' });
    return;
  }
  const entries = Object.entries(raw);
  if (entries.length > CONFIG_LIMITS.valueMetaLocales) {
    out.push({ path, code: 'OUT_OF_RANGE' });
    return;
  }
  for (const [locale, texts] of entries) {
    if (
      locale.length > CONFIG_LIMITS.localeLength ||
      !LOCALE_KEY.test(locale)
    ) {
      out.push({ path, code: 'INVALID_VALUE' });
      continue;
    }
    const lp = `${path}.${locale}`;
    if (!isPlainObject(texts)) {
      out.push({ path: lp, code: 'INVALID_SHAPE' });
      continue;
    }
    unknownKeys(texts, VALUE_META_I18N_KEYS, lp, out);
    for (const k of VALUE_META_I18N_KEYS) {
      const v = texts[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string') {
        out.push({ path: `${lp}.${k}`, code: 'INVALID_VALUE' });
      } else if (v.length > CONFIG_LIMITS.valueMetaText) {
        out.push({ path: `${lp}.${k}`, code: 'TOO_LONG' });
      }
    }
  }
}
