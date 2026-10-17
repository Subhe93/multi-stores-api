/* eslint-disable */
// MIRROR (M4.1 C12): below this 3-line header, a byte copy of multi-stores-shared/src/personalization/evaluator.ts.
// Never edit here: edit the shared file and run multi-stores-shared/scripts/sync-personalization-evaluator.mjs.
/**
 * Personalization evaluator (M4.1 §3.2, D3/D4/D5/D8/D10, contracts C1/C14/C15/C34).
 * Mirrored with types.ts (see the KEEP IN SYNC note there). Pure code only.
 *
 * `evaluatePersonalization(defs, raw, ctx)`:
 * - app off → the M4.0 validator (`validatePersonalization`) on top-level
 *   fields of M4.0 types, unchanged (legacy branch, D10);
 * - app on → visibility, normalization, validation (per-field checks still
 *   delegated to `validatePersonalization`), repeaters, price and lines.
 *   Fields without M4.1 features keep exactly the M4.0 values and issues.
 */

import {
  charCount,
  isPlainObject,
  normalizeFieldValues,
  readLinkedValidation,
  stripVariationSelectors,
  validatePersonalization,
  FILE_FIELD_TYPES,
  type FieldDef,
  type Issue,
  type NormalizedValue,
  type NormalizedValues,
} from './rules';
import { evaluateConditions, findOptionConfig, isValueSet, optionCount } from './conditions';
import {
  APP_ONLY_TYPES,
  P_MESSAGE_KEYS,
  P_PRICING_MODES,
  type LocaleText,
  type PContext,
  type PError,
  type PErrorCode,
  type PFieldDef,
  type PLine,
  type PLineMeta,
  type PMessageKey,
  type PPricingMode,
  type PResult,
  type PTranslation,
  type PUi,
} from './types';

// ---------------------------------------------------------------------------
// Money (integer minor units; no float arithmetic on amounts)
// ---------------------------------------------------------------------------

/** Largest accepted modifier: 1 000 000.00 (keeps every sum a safe integer). */
export const MAX_PRICE_MINOR = 100_000_000;

/**
 * Largest per-unit delta (one line or the sum), in minor units: what a
 * Decimal(10,2) column holds (99 999 999.99). Anything above, or any amount
 * that is not a safe integer, is the `PERSONALIZATION_PRICE_TOO_HIGH` error,
 * never a silent 0.
 */
export const MAX_DELTA_MINOR = 9_999_999_999;

/** True for an own (non-inherited) key of a lookup map. */
function hasOwn(map: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}

/**
 * Converts a non-negative amount (number or decimal string, '.' or ',') to
 * integer minor units, rounding half up on the decimal text. Negative,
 * non-numeric or too large amounts give 0 (modifiers are ≥ 0, Q6).
 */
export function toMinorUnits(v: unknown): number {
  let s: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0 || v > MAX_PRICE_MINOR / 100) return 0;
    s = v.toFixed(6);
  } else if (typeof v === 'string') {
    s = v.trim().replace(',', '.');
  } else {
    return 0;
  }
  const m = /^(\d{1,9})(?:\.(\d*))?$/.exec(s);
  if (!m) return 0;
  const frac = (m[2] ?? '') + '000';
  let minor = Number(m[1]) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) minor += 1;
  return minor > MAX_PRICE_MINOR ? 0 : minor;
}

/** Formats integer minor units as a two-decimal string ("12.50"). */
export function formatMinorUnits(minor: number): string {
  const m = Math.max(0, Math.trunc(minor));
  const cents = m % 100;
  return `${Math.floor(m / 100)}.${cents < 10 ? '0' : ''}${cents}`;
}

// ---------------------------------------------------------------------------
// Character helpers (§3.4; code points per C14)
// ---------------------------------------------------------------------------

/** First code points of `s` (NFC) whose `charCount` is at most `max`; VS15/16 are kept but not counted. */
export function truncateChars(s: string, max: number): string {
  const text = s.normalize('NFC');
  if (!Number.isFinite(max)) return text;
  let count = 0;
  let out = '';
  for (const ch of Array.from(text)) {
    const counts = ch !== '︎' && ch !== '️';
    if (counts && count >= max) break;
    if (counts) count++;
    out += ch;
  }
  return out;
}

/**
 * Inserts `ch` at a UTF-16 caret (namez ❤ button, A L671-690). Refused (null)
 * when `charCount(value) >= max`. The caret never splits a surrogate pair.
 */
export function insertAtCaret(
  value: string,
  caret: number,
  ch: string,
  max?: number | null,
): { value: string; caret: number } | null {
  if (typeof max === 'number' && Number.isFinite(max) && charCount(value) >= max) return null;
  let c = Number.isFinite(caret) ? Math.min(Math.max(0, Math.trunc(caret)), value.length) : value.length;
  const prev = value.charCodeAt(c - 1);
  const next = value.charCodeAt(c);
  if (c > 0 && prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) c += 1;
  return { value: value.slice(0, c) + ch + value.slice(c), caret: c + ch.length };
}

// ---------------------------------------------------------------------------
// Config readers (lenient: rows are JSON)
// ---------------------------------------------------------------------------

/** True when a field uses any M4.1 feature (app-only type, parent, conditions, pricing, repeat, ui). */
export function isAdvancedField(def: PFieldDef): boolean {
  return (
    APP_ONLY_TYPES.has(def.type) ||
    (def.parent_id !== undefined && def.parent_id !== null) ||
    [def.conditions, def.pricing, def.repeat, def.ui].some((v) => v !== undefined && v !== null)
  );
}

export function readUi(raw: unknown): PUi {
  return isPlainObject(raw) ? (raw as PUi) : {};
}

export interface ReadPricing {
  mode: PPricingMode;
  amountMinor: number;
  optionPricesMinor: Record<string, number>;
}

export function readPricing(raw: unknown): ReadPricing | null {
  if (!isPlainObject(raw)) return null;
  const mode = raw.mode;
  if (typeof mode !== 'string' || !(P_PRICING_MODES as readonly string[]).includes(mode)) return null;
  // Null prototype + own-key lookups: a value such as "constructor" or
  // "__proto__" can never read an inherited member as a price.
  const optionPricesMinor = Object.create(null) as Record<string, number>;
  if (isPlainObject(raw.option_prices)) {
    for (const [k, v] of Object.entries(raw.option_prices)) {
      optionPricesMinor[k.normalize('NFC').trim()] = toMinorUnits(v);
    }
  }
  return { mode: mode as PPricingMode, amountMinor: toMinorUnits(raw.amount), optionPricesMinor };
}

export interface ReadRepeat {
  option: string;
  map: Record<string, number> | null;
  start: number;
  max: number;
  leadFields: string[];
  leadOptions: string[];
}

/** Max repeater instances (config validator: `max` 1..20). */
export const MAX_REPEAT_INSTANCES = 20;

export function readRepeat(raw: unknown): ReadRepeat | null {
  if (!isPlainObject(raw) || !isPlainObject(raw.count)) return null;
  const option = raw.count.option;
  if (typeof option !== 'string' || option === '') return null;
  const int = (v: unknown, def: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : def;
  const start = Math.min(Math.max(int(raw.start_index, 1), 1), MAX_REPEAT_INSTANCES);
  const max = Math.min(Math.max(int(raw.max, MAX_REPEAT_INSTANCES), 0), MAX_REPEAT_INSTANCES);
  const map = isPlainObject(raw.count.map) ? (raw.count.map as Record<string, number>) : null;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
  const lead = isPlainObject(raw.lead) ? raw.lead : {};
  return { option, map, start, max, leadFields: strings(lead.fields), leadOptions: strings(lead.options) };
}

/** Item indexes of a repeater: `start_index .. min(N, start_index + max - 1)` (namez "q ≥ i and q > 1" = start 2). */
export function repeaterIndexes(def: PFieldDef, ctx: Pick<PContext, 'variantOptions' | 'optionConfig'>): number[] {
  const r = readRepeat(def.repeat);
  if (!r) return [];
  const n = optionCount(ctx, { option: r.option, map: r.map });
  const last = Math.min(n, r.start + r.max - 1);
  const out: number[] = [];
  for (let i = r.start; i <= last; i++) out.push(i);
  return out;
}

/** Option strings of a field, NFC + trimmed (same reading as the M4.0 option check). */
export function optionValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options
    .filter((o) => typeof o === 'string' || typeof o === 'number')
    .map((o) => String(o).normalize('NFC').trim())
    .filter((o) => o !== '');
}

export interface PaletteEntry {
  value: string;
  hex: string | null;
}

/**
 * COLOR_PALETTE choices: `ui.palette_from_option` (that option's values ∩
 * values on active variants, hex from `colorMap`), else `options` with
 * `ui.palette_hex`.
 */
export function resolvePalette(
  def: PFieldDef,
  ctx: Pick<PContext, 'optionConfig' | 'activeOptionValues'>,
): PaletteEntry[] {
  const ui = readUi(def.ui);
  const hexOf = (map: unknown, v: string): string | null =>
    isPlainObject(map) && typeof map[v] === 'string' && map[v] !== '' ? (map[v] as string) : null;
  if (typeof ui.palette_from_option === 'string' && ui.palette_from_option !== '') {
    const option = ui.palette_from_option;
    const cfg = findOptionConfig(ctx, option);
    const active = ctx.activeOptionValues?.[option];
    const values = (Array.isArray(cfg?.values) ? cfg!.values : []).filter(
      (v): v is string => typeof v === 'string' && v !== '',
    );
    return values
      .filter((v) => !Array.isArray(active) || active.includes(v))
      .map((v) => ({ value: v.normalize('NFC').trim(), hex: hexOf(cfg?.colorMap, v) }));
  }
  return optionValues(def.options).map((v) => ({ value: v, hex: hexOf(ui.palette_hex, v) }));
}

function readCheckedRules(raw: unknown): { min?: number; max?: number } {
  if (!isPlainObject(raw)) return {};
  const int = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v)
      ? Math.trunc(v)
      : typeof v === 'string' && /^\s*\d+\s*$/.test(v)
        ? parseInt(v, 10)
        : undefined;
  return { min: int(raw.min_checked), max: int(raw.max_checked) };
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** App-mode text normalization (D7): NFC, strip VS15/16, trim, then `ui.transform`. */
export function normalizeText(s: string, transform?: string | null): string {
  const t = stripVariationSelectors(s.normalize('NFC')).trim();
  return transform === 'uppercase' ? t.toUpperCase() : t;
}

/**
 * CHECKBOX_GROUP selection. Key absent → `ui.default_checked` (PPOM default);
 * present but empty (`[]`, `null`, `''`, `false`) → none. Values are NFC +
 * trimmed, deduplicated and returned in option order; `invalid` lists values
 * that are not options. `false` is the canonical "explicitly none" marker
 * when the field has defaults, so re-evaluating canonical values is stable.
 */
export function checkboxSelection(
  def: PFieldDef,
  rawContainer: unknown,
): { list: string[]; invalid: string[]; canonical: string[] | false | undefined } {
  const options = optionValues(def.options);
  const ui = readUi(def.ui);
  const defaults = Array.isArray(ui.default_checked)
    ? optionValues(ui.default_checked).filter((v) => options.includes(v))
    : [];
  const container = isPlainObject(rawContainer) ? rawContainer : {};
  const present = Object.prototype.hasOwnProperty.call(container, def.id) && container[def.id] !== undefined;
  const raw = present ? container[def.id] : undefined;

  let picked: string[];
  if (!present) picked = defaults;
  else if (Array.isArray(raw)) picked = optionValues(raw);
  else if (typeof raw === 'string' || typeof raw === 'number') picked = optionValues([raw]);
  else picked = [];

  const unique = picked.filter((v, i) => picked.indexOf(v) === i);
  const invalid = unique.filter((v) => !options.includes(v));
  const list = options.filter((o) => unique.includes(o));
  const canonical = list.length > 0 ? list : present && defaults.length > 0 ? false : undefined;
  return { list, invalid, canonical };
}

// ---------------------------------------------------------------------------
// Translations
// ---------------------------------------------------------------------------

/** Translation row for display: locale → primary → en → first. */
export function pickFieldTranslation(
  translations: readonly PTranslation[] | null | undefined,
  locale?: string | null,
  primary?: string | null,
): PTranslation | undefined {
  if (!Array.isArray(translations) || translations.length === 0) return undefined;
  for (const key of [locale, primary, 'en']) {
    const t = key ? translations.find((x) => x && x.locale === key) : undefined;
    if (t) return t;
  }
  return translations[0];
}

/** `map[locale]` → `[primary]` → `.en` → first non-empty (same chain as the snapshot reader). */
export function localeText(map: unknown, locale?: string | null, primary?: string | null): string | null {
  if (!isPlainObject(map)) return null;
  const ok = (v: unknown): v is string => typeof v === 'string' && v !== '';
  for (const key of [locale, primary, 'en']) if (key && ok(map[key])) return map[key] as string;
  for (const v of Object.values(map)) if (ok(v)) return v;
  return null;
}

function nonEmptyMap(map: LocaleText): LocaleText | null {
  return Object.keys(map).length > 0 ? map : null;
}

/** Snapshot `field_label`: `display_label || label` per locale (app); `label` only (legacy). */
function labelMap(def: PFieldDef, app: boolean): LocaleText | null {
  const out: LocaleText = {};
  for (const t of def.translations ?? []) {
    if (!t || typeof t.locale !== 'string') continue;
    const l = (app ? t.display_label || t.label : t.label) ?? '';
    if (typeof l === 'string' && l !== '') out[t.locale] = l;
  }
  return nonEmptyMap(out);
}

function optionLabel(t: PTranslation, value: string): string | null {
  const labels = t.option_labels;
  if (!isPlainObject(labels)) return null;
  const l = labels[value];
  return typeof l === 'string' && l !== '' ? l : null;
}

/** `{locale: option label}` for one value; null when no locale translates it. */
function optionDisplayMap(def: PFieldDef, value: string): LocaleText | null {
  const out: LocaleText = {};
  for (const t of def.translations ?? []) {
    if (!t || typeof t.locale !== 'string') continue;
    const l = optionLabel(t, value);
    if (l !== null) out[t.locale] = l;
  }
  return nonEmptyMap(out);
}

/**
 * `{locale: labels joined by ', '}` for CHECKBOX_GROUP / COLOR_PALETTE values
 * (C2). Null when no locale translates any value; otherwise every translated
 * locale gets an entry (raw value where it has no label), so a locale without
 * labels never falls back to another language's labels.
 */
function listDisplayMap(def: PFieldDef, list: string[]): LocaleText | null {
  const out: LocaleText = {};
  let any = false;
  for (const t of def.translations ?? []) {
    if (!t || typeof t.locale !== 'string') continue;
    const labels = list.map((v) => optionLabel(t, v));
    if (labels.some((l) => l !== null)) any = true;
    out[t.locale] = labels.map((l, i) => l ?? list[i]).join(', ');
  }
  return any ? nonEmptyMap(out) : null;
}

/** Repeater item label per locale (`display_label || label` with `{i}`); null without a template. */
function groupLabelMap(rep: PFieldDef, index: number): LocaleText | null {
  const out: LocaleText = {};
  for (const t of rep.translations ?? []) {
    if (!t || typeof t.locale !== 'string') continue;
    const l = t.display_label || t.label;
    if (typeof l === 'string' && l !== '') out[t.locale] = l.replace(/\{i\}/g, String(index));
  }
  return nonEmptyMap(out);
}

const CODE_TO_MESSAGE_KEY: Record<string, PMessageKey> = Object.fromEntries(
  Object.entries(P_MESSAGE_KEYS).map(([k, code]) => [code, k as PMessageKey]),
);

/** `translation.messages[key]` (same translation row as the label), `{i}` replaced; '' when none. */
export function fieldMessage(
  def: PFieldDef,
  code: PErrorCode,
  ctx: Pick<PContext, 'locale' | 'primaryLocale'>,
  index?: number,
): string {
  const key = CODE_TO_MESSAGE_KEY[code];
  if (!key) return '';
  const t = pickFieldTranslation(def.translations, ctx.locale, ctx.primaryLocale);
  const msgs = t?.messages;
  if (!isPlainObject(msgs)) return '';
  const m = msgs[key];
  if (typeof m !== 'string' || m === '') return '';
  return index === undefined ? m : m.replace(/\{i\}/g, String(index));
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

function bySortOrder(a: PFieldDef, b: PFieldDef): number {
  return (a.sort_order ?? 0) - (b.sort_order ?? 0);
}

/** Top-level defs and children per parent, from a flat list (`parent_id`) and/or a tree (`children`). */
export function splitFieldTree(defs: readonly PFieldDef[]): {
  top: PFieldDef[];
  childrenOf: Map<string, PFieldDef[]>;
} {
  const seen = new Set<string>();
  const top: PFieldDef[] = [];
  const childrenOf = new Map<string, PFieldDef[]>();
  const add = (def: PFieldDef, treeParent: string | null): void => {
    if (!def || typeof def.id !== 'string' || seen.has(def.id)) return;
    seen.add(def.id);
    const parent = treeParent ?? (typeof def.parent_id === 'string' && def.parent_id !== '' ? def.parent_id : null);
    if (parent === null) top.push(def);
    else childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), def]);
    for (const c of def.children ?? []) add(c, def.id);
  };
  for (const d of defs ?? []) add(d, null);
  top.sort(bySortOrder);
  for (const list of childrenOf.values()) list.sort(bySortOrder);
  return { top, childrenOf };
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/** Text stored in `value` (same rule as the M4.0 snapshot writer). */
function valueText(v: NormalizedValue): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    return v.every((x) => typeof x === 'string' || typeof x === 'number')
      ? v.map(String).join(', ')
      : JSON.stringify(v);
  }
  return JSON.stringify(v);
}

interface LineDraft extends Omit<PLine, 'sort_order' | 'price_delta' | 'price_delta_minor'> {
  minor: number;
  legacy_sort: number;
}

interface GroupRef {
  key: string;
  index: number;
  labels: LocaleText | null;
}

function draftLines(
  def: PFieldDef,
  value: NormalizedValue,
  ctx: PContext,
  app: boolean,
  group: GroupRef | null,
  palette: PaletteEntry[] | null,
): LineDraft[] {
  const i18nLabel = labelMap(def, app);
  const label = localeText(i18nLabel, ctx.locale, ctx.primaryLocale) || def.name;
  const groupLabel = group ? localeText(group.labels, ctx.locale, ctx.primaryLocale) : null;
  const base = {
    field_id: def.id,
    field_name: def.name,
    source: 'FIELD' as const,
    type: String(def.type),
    label,
    group_key: group?.key ?? null,
    group_index: group?.index ?? null,
    group_label: groupLabel,
    minor: 0,
    legacy_sort: def.sort_order ?? 0,
  };
  const make = (text: string, display: LocaleText | null, isFile: boolean, meta: PLineMeta | null): LineDraft => ({
    ...base,
    value: text,
    display_value: localeText(display, ctx.locale, ctx.primaryLocale) ?? text,
    is_file: isFile,
    meta,
    i18n: { label: i18nLabel, display_value: display, group_label: group?.labels ?? null },
  });

  if ((FILE_FIELD_TYPES as readonly string[]).includes(def.type)) {
    const list = Array.isArray(value) ? value : [value];
    return list
      .filter((u): u is string => typeof u === 'string' && u !== '')
      .map((u) => make(u, null, true, null));
  }
  if (app && def.type === 'CHECKBOX_GROUP') {
    const list = Array.isArray(value) ? value.map(String) : [];
    if (list.length === 0) return [];
    return [make(list.join(', '), listDisplayMap(def, list), false, null)];
  }
  const text = valueText(value);
  if (text === null) return [];
  if (app && def.type === 'COLOR_PALETTE') {
    const hex = palette?.find((p) => p.value === text)?.hex ?? null;
    return [make(text, listDisplayMap(def, [text]), false, hex ? { hex } : null)];
  }
  const display = def.type === 'SELECT' || def.type === 'FONT' ? optionDisplayMap(def, text) : null;
  return [make(text, display, false, null)];
}

function optionLine(option: string, ctx: PContext, group: GroupRef): LineDraft | null {
  const v = ctx.variantOptions?.[option];
  if (typeof v !== 'string' || v === '') return null;
  const primary = ctx.primaryLocale || ctx.locale;
  const hexMap = findOptionConfig(ctx, option)?.colorMap;
  const hex = isPlainObject(hexMap) && typeof hexMap[v] === 'string' && hexMap[v] !== '' ? (hexMap[v] as string) : null;
  return {
    field_id: null,
    field_name: option,
    source: 'OPTION',
    type: 'OPTION',
    label: option,
    value: v,
    display_value: v,
    is_file: false,
    group_key: group.key,
    group_index: group.index,
    group_label: localeText(group.labels, ctx.locale, ctx.primaryLocale),
    meta: hex ? { hex, option_name: option } : { option_name: option },
    i18n: { label: { [primary]: option }, display_value: { [primary]: v }, group_label: group.labels },
    minor: 0,
    legacy_sort: 0,
  };
}

function finishLines(drafts: LineDraft[], legacy: boolean): PLine[] {
  return drafts.map((d, i) => {
    const { minor, legacy_sort, ...rest } = d;
    return {
      ...rest,
      price_delta: formatMinorUnits(minor),
      price_delta_minor: minor,
      sort_order: legacy ? legacy_sort : i,
    };
  });
}

/** Per-unit price of one field value (§3.2 step 6), in minor units. */
function fieldPriceMinor(def: PFieldDef, value: NormalizedValue | undefined, items: number): number {
  const p = readPricing(def.pricing);
  if (!p || !isValueSet(value)) return 0;
  switch (p.mode) {
    case 'fixed':
      return p.amountMinor;
    case 'per_item':
      return p.amountMinor * Math.max(items, 0);
    case 'per_option': {
      const list = Array.isArray(value) ? value.map(String) : [String(value)];
      return list.reduce(
        (sum, v) => sum + (hasOwn(p.optionPricesMinor, v) ? p.optionPricesMinor[v] : 0),
        0,
      );
    }
    case 'per_char': {
      if (typeof value !== 'string' || (def.type !== 'TEXT' && def.type !== 'TEXTAREA')) return 0;
      const link = readLinkedValidation(def.linked_validation);
      const fill = link && link.type === 'equal_length' ? link.fill_char : undefined;
      const fillCp = fill ? stripVariationSelectors(fill.normalize('NFC')) : null;
      const chars = Array.from(stripVariationSelectors(value.normalize('NFC')));
      return p.amountMinor * chars.filter((c) => c !== fillCp).length;
    }
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function toPError(issue: Issue, message = ''): PError {
  const out: PError = { code: issue.code, field_id: issue.field_id, field_name: issue.field_name, message };
  if (issue.params !== undefined) out.params = issue.params;
  return out;
}

function emptyResult(legacy: boolean, errors: PError[]): PResult {
  return {
    ok: errors.length === 0,
    errors,
    values: {},
    priceDelta: '0.00',
    priceDeltaMinor: 0,
    lines: [],
    visibleIds: [],
    legacy,
  };
}

/** The M4.0 path (D10): top-level fields of M4.0 types, advanced keys ignored. */
function evaluateLegacy(top: PFieldDef[], raw: unknown, ctx: PContext): PResult {
  const fields = top.filter((d) => !APP_ONLY_TYPES.has(d.type));
  const res = validatePersonalization({
    fields: fields as FieldDef[],
    values: raw,
    prefilled: ctx.prefilled,
    isFileRef: ctx.isFileRef,
    patternTester: ctx.patternTester,
  });
  const drafts: LineDraft[] = [];
  for (const f of fields) {
    const v = res.values[f.id];
    if (v !== undefined) drafts.push(...draftLines(f, v, ctx, false, null, null));
  }
  return {
    ok: res.ok,
    errors: res.issues.map((i) => toPError(i)),
    values: res.values,
    priceDelta: '0.00',
    priceDeltaMinor: 0,
    lines: finishLines(drafts, true),
    visibleIds: fields.map((f) => f.id),
    legacy: true,
  };
}

/** App-mode value of a TEXT-like field before validation (advanced fields only, D7). */
function appTextValue(
  def: PFieldDef,
  v: NormalizedValue | undefined,
  child: boolean,
): NormalizedValue | undefined {
  if (v === undefined || (!child && !isAdvancedField(def))) return v;
  if (def.type !== 'TEXT' && def.type !== 'TEXTAREA') return v;
  if (typeof v !== 'string' && typeof v !== 'number') return v;
  const t = normalizeText(String(v), readUi(def.ui).transform);
  return t === '' ? undefined : t;
}

interface SortedError {
  error: PError;
  order: [number, number, number];
}

interface SetResult {
  values: NormalizedValues;
  errors: SortedError[];
}

/**
 * Validates one set of sibling fields (top level, or one repeater item):
 * M4.0 types through `validatePersonalization`, CHECKBOX_GROUP and
 * COLOR_PALETTE here. `values` must already be app-normalized.
 */
function validateSet(
  defs: PFieldDef[],
  visible: Set<string>,
  values: NormalizedValues,
  rawContainer: unknown,
  ctx: PContext,
  mapIssue: (def: PFieldDef, code: PErrorCode, params: Issue['params'], position: number) => SortedError,
): SetResult {
  const plain = defs.filter((d) => !APP_ONLY_TYPES.has(d.type));
  const plainValues: Record<string, unknown> = {};
  for (const d of plain) if (values[d.id] !== undefined) plainValues[d.id] = values[d.id];
  const res = validatePersonalization({
    fields: plain as FieldDef[],
    values: plainValues,
    isFileRef: ctx.isFileRef,
    patternTester: ctx.patternTester,
    isVisible: (f) => visible.has(f.id),
  });
  const out: NormalizedValues = { ...res.values };
  const errors: SortedError[] = [];
  const position = new Map(defs.map((d, i) => [d.id, i]));
  for (const issue of res.issues) {
    const def = defs.find((d) => d.id === issue.field_id);
    if (!def) {
      // Payload-level issue (cannot happen: the payload was checked first).
      errors.push({ error: toPError(issue), order: [0, 0, 0] });
      continue;
    }
    errors.push(mapIssue(def, issue.code, issue.params, position.get(def.id) ?? 0));
  }

  for (const def of defs) {
    if (!visible.has(def.id)) continue;
    const pos = position.get(def.id) ?? 0;
    if (def.type === 'CHECKBOX_GROUP') {
      const sel = checkboxSelection(def, rawContainer);
      if (sel.canonical !== undefined) out[def.id] = sel.canonical;
      const rules = readCheckedRules(def.validation_rules);
      if (sel.invalid.length > 0) {
        errors.push(mapIssue(def, 'CUSTOM_FIELD_INVALID_OPTION', undefined, pos));
      } else if (sel.list.length === 0) {
        if (def.is_required) errors.push(mapIssue(def, 'CUSTOM_FIELD_REQUIRED', undefined, pos));
      } else if (rules.min !== undefined && sel.list.length < rules.min) {
        errors.push(mapIssue(def, 'CUSTOM_FIELD_MIN_CHECKED', { min: rules.min }, pos));
      } else if (rules.max !== undefined && sel.list.length > rules.max) {
        errors.push(mapIssue(def, 'CUSTOM_FIELD_MAX_CHECKED', { max: rules.max }, pos));
      }
    } else if (def.type === 'COLOR_PALETTE') {
      const v = values[def.id];
      if (v === undefined) {
        if (def.is_required) errors.push(mapIssue(def, 'CUSTOM_FIELD_REQUIRED', undefined, pos));
        continue;
      }
      out[def.id] = v;
      const palette = resolvePalette(def, ctx);
      if (typeof v !== 'string' || !palette.some((p) => p.value === v)) {
        errors.push(mapIssue(def, 'CUSTOM_FIELD_INVALID_OPTION', undefined, pos));
      }
    }
  }
  return { values: out, errors };
}

/** App-normalized values of known fields; repeater children always count as advanced. */
function appValues(defs: PFieldDef[], normalized: NormalizedValues, child: boolean): NormalizedValues {
  const out: NormalizedValues = {};
  for (const d of defs) {
    const v = appTextValue(d, normalized[d.id], child);
    if (v !== undefined) out[d.id] = v;
  }
  return out;
}

interface RepeaterState {
  def: PFieldDef;
  indexes: number[];
  /** Canonical item objects, index-aligned with `indexes`. */
  items: NormalizedValues[];
  children: PFieldDef[];
  lead: { fields: string[]; options: string[]; index: number } | null;
}

/**
 * Evaluates a product's personalization for one cart/order line (M4.1 §3.2).
 * Price, values and lines are computed from the definitions only; nothing the
 * client sends besides the raw values is trusted (D4).
 */
export function evaluatePersonalization(defs: readonly PFieldDef[], raw: unknown, ctx: PContext): PResult {
  const { top, childrenOf } = splitFieldTree(defs);
  if (!ctx.appEnabled) return evaluateLegacy(top, raw, ctx);

  // Same payload guard as M4.0 (shape, size, depth).
  const guard = validatePersonalization({ fields: [], values: raw });
  if (!guard.ok) return emptyResult(false, guard.issues.map((i) => toPError(i)));

  const rawObj: Record<string, unknown> = isPlainObject(raw) ? raw : {};
  const normalized = normalizeFieldValues(raw);
  const pre = appValues(top, normalized, false);

  // Pass 1: visibility in field order; conditions read earlier visible fields by name.
  const visible = new Set<string>();
  const byName = new Map<string, unknown>();
  const repeaters = new Map<string, RepeaterState>();
  for (const def of top) {
    const shown = evaluateConditions(def.conditions, ctx, (name) => byName.get(name));
    if (!shown) continue;
    visible.add(def.id);
    let v: unknown = pre[def.id];
    if (def.type === 'CHECKBOX_GROUP') v = checkboxSelection(def, rawObj).canonical;
    if (def.type === 'REPEATER') {
      const state = buildRepeater(def, childrenOf.get(def.id) ?? [], ctx);
      repeaters.set(def.id, state);
      // Conditions see a repeater as its item count (set/unset, gt/gte/lt/lte).
      v = state.indexes.length > 0 ? state.indexes.length : undefined;
    }
    if (!byName.has(def.name)) byName.set(def.name, v);
  }

  // Pass 2: validation.
  const topPos = new Map(top.map((d, i) => [d.id, i]));
  const mapTop = (def: PFieldDef, code: PErrorCode, params: Issue['params'], pos: number): SortedError => {
    const error: PError = { code, field_id: def.id, field_name: def.name, message: fieldMessage(def, code, ctx) };
    if (params !== undefined) error.params = params;
    return { error, order: [pos, 0, 0] };
  };
  const nonRepeaters = top.filter((d) => d.type !== 'REPEATER');
  const topSet = validateSet(nonRepeaters, visible, pre, rawObj, ctx, (def, code, params) =>
    mapTop(def, code, params, topPos.get(def.id) ?? 0),
  );
  const errors: SortedError[] = [...topSet.errors];
  const values: NormalizedValues = { ...topSet.values };

  for (const state of repeaters.values()) {
    const rep = state.def;
    const pos = topPos.get(rep.id) ?? 0;
    const rawList = rawObj[rep.id];
    if (rawList !== undefined && rawList !== null && !Array.isArray(rawList)) {
      errors.push(mapTop(rep, 'CUSTOM_FIELD_INVALID_PAYLOAD', undefined, pos));
    }
    const list = Array.isArray(rawList) ? rawList : [];
    const childVisible = new Set(state.children.map((c) => c.id));
    state.indexes.forEach((index, k) => {
      const rawItem = isPlainObject(list[k]) ? list[k] : {};
      const itemValues = appValues(state.children, normalizeFieldValues(rawItem), true);
      const res = validateSet(state.children, childVisible, itemValues, rawItem, ctx, (child, code, params, cpos) => {
        const error: PError = {
          code,
          field_id: rep.id,
          field_name: rep.name,
          child_id: child.id,
          child_name: child.name,
          group_index: index,
          message: fieldMessage(child, code, ctx, index),
        };
        if (params !== undefined) error.params = params;
        return { error, order: [pos, index, cpos] };
      });
      errors.push(...res.errors);
      state.items.push(normalizeFieldValues(res.values));
    });
    if (state.items.some((it) => Object.keys(it).length > 0)) values[rep.id] = state.items;
  }
  errors.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2]);

  // Pass 3: lines and price.
  const drafts = buildLineDrafts(top, visible, repeaters, values, ctx);
  const priceDeltaMinor = guardPrice(drafts, errors);
  const lines = finishLines(drafts, false);
  const visibleIds = top.filter((d) => visible.has(d.id)).map((d) => d.id);
  for (const state of repeaters.values()) {
    if (state.indexes.length > 0) visibleIds.push(...state.children.map((c) => c.id));
  }
  const errorList = errors.map((e) => e.error);
  return {
    ok: errorList.length === 0,
    errors: errorList,
    values: normalizeFieldValues(values),
    priceDelta: formatMinorUnits(priceDeltaMinor),
    priceDeltaMinor,
    lines,
    visibleIds,
    legacy: false,
  };
}

/**
 * Pass 3 of `evaluatePersonalization`: the line drafts of every visible
 * top-level field and repeater item, with the per-field and repeater
 * prices (lead fields and option lines are grouped under their repeater).
 */
function buildLineDrafts(
  top: readonly PFieldDef[],
  visible: ReadonlySet<string>,
  repeaters: ReadonlyMap<string, RepeaterState>,
  values: NormalizedValues,
  ctx: PContext,
): LineDraft[] {
  const leadOf = new Map<string, RepeaterState>();
  for (const state of repeaters.values()) {
    if (!state.lead || state.indexes.length === 0) continue;
    for (const name of state.lead.fields) {
      const def = top.find((d) => d.name === name && d.type !== 'REPEATER');
      if (def && !leadOf.has(def.id)) leadOf.set(def.id, state);
    }
  }
  const palettes = new Map<string, PaletteEntry[]>();
  const paletteOf = (def: PFieldDef): PaletteEntry[] | null => {
    if (def.type !== 'COLOR_PALETTE') return null;
    if (!palettes.has(def.id)) palettes.set(def.id, resolvePalette(def, ctx));
    return palettes.get(def.id) ?? null;
  };
  const priced = (def: PFieldDef, v: NormalizedValue, group: GroupRef | null): LineDraft[] => {
    const lines = draftLines(def, v, ctx, true, group, paletteOf(def));
    if (lines.length > 0) lines[0].minor += fieldPriceMinor(def, v, 1);
    return lines;
  };

  const drafts: LineDraft[] = [];
  for (const def of top) {
    if (!visible.has(def.id) || leadOf.has(def.id)) continue;
    if (def.type !== 'REPEATER') {
      const v = values[def.id];
      if (v !== undefined) drafts.push(...priced(def, v, null));
      continue;
    }
    const state = repeaters.get(def.id);
    if (!state || state.indexes.length === 0) continue;
    const groupKey = def.name.slice(0, 64);
    if (state.lead) {
      const group: GroupRef = { key: groupKey, index: state.lead.index, labels: groupLabelMap(def, state.lead.index) };
      for (const [fieldId, owner] of leadOf) {
        if (owner !== state) continue;
        const leadDef = top.find((d) => d.id === fieldId);
        const v = leadDef && visible.has(leadDef.id) ? values[leadDef.id] : undefined;
        if (leadDef && v !== undefined) drafts.push(...priced(leadDef, v, group));
      }
      for (const option of state.lead.options) {
        const line = optionLine(option, ctx, group);
        if (line) drafts.push(line);
      }
    }
    const repPricing = readPricing(def.pricing);
    let firstWithValue = true;
    state.indexes.forEach((index, k) => {
      const item = state.items[k] ?? {};
      const group: GroupRef = { key: groupKey, index, labels: groupLabelMap(def, index) };
      const itemLines: LineDraft[] = [];
      for (const child of state.children) {
        const v = item[child.id];
        if (v !== undefined) itemLines.push(...priced(child, v, group));
      }
      if (repPricing && itemLines.length > 0 && Object.values(item).some(isValueSet)) {
        // Repeater price: per_item on every item with a value, fixed once.
        if (repPricing.mode === 'per_item') itemLines[0].minor += repPricing.amountMinor;
        else if (repPricing.mode === 'fixed' && firstWithValue) itemLines[0].minor += repPricing.amountMinor;
        firstWithValue = false;
      }
      drafts.push(...itemLines);
    });
  }

  return drafts;
}

/**
 * Price guard of `evaluatePersonalization`: every line and the sum must be
 * a safe integer that fits a Decimal(10,2) amount; otherwise every line's
 * price is zeroed and `PERSONALIZATION_PRICE_TOO_HIGH` is appended (an
 * error, never a silent 0). Returns the per-unit delta in minor units.
 */
function guardPrice(drafts: LineDraft[], errors: SortedError[]): number {
  let priceDeltaMinor = 0;
  let priceOk = true;
  for (const d of drafts) {
    if (!Number.isSafeInteger(d.minor) || d.minor < 0 || d.minor > MAX_DELTA_MINOR) priceOk = false;
    else priceDeltaMinor += d.minor;
  }
  if (!Number.isSafeInteger(priceDeltaMinor) || priceDeltaMinor > MAX_DELTA_MINOR) priceOk = false;
  if (!priceOk) {
    for (const d of drafts) d.minor = 0;
    priceDeltaMinor = 0;
    errors.push({
      error: { code: 'PERSONALIZATION_PRICE_TOO_HIGH', field_id: '', field_name: '', message: '' },
      order: [Number.MAX_SAFE_INTEGER, 0, 0],
    });
  }
  return priceDeltaMinor;
}

function buildRepeater(def: PFieldDef, children: PFieldDef[], ctx: PContext): RepeaterState {
  const r = readRepeat(def.repeat);
  const indexes = repeaterIndexes(def, ctx);
  // A child is never a REPEATER (D5).
  const kids = children.filter((c) => c.type !== 'REPEATER');
  const lead =
    r && r.start > 1 && (r.leadFields.length > 0 || r.leadOptions.length > 0)
      ? { fields: r.leadFields, options: r.leadOptions, index: r.start - 1 }
      : null;
  return { def, indexes, items: [], children: kids, lead };
}

// ---------------------------------------------------------------------------
// Snapshot columns (C1/C19)
// ---------------------------------------------------------------------------

/**
 * The C1 columns of one line for `buildOrderValues(…, {lines})`. Keys whose
 * value is null are left out (Prisma JSON columns need an absent key, not
 * null). The upload id and file classification stay with the builder.
 */
export interface PSnapshotColumns {
  custom_field_id: string | null;
  value?: string;
  file_url?: string;
  field_name: string;
  field_type?: string;
  field_label?: LocaleText;
  display_value?: LocaleText;
  sort_order: number;
  group_key?: string;
  group_index?: number;
  group_label?: LocaleText;
  source: 'FIELD' | 'OPTION';
  price_delta: string;
  meta?: PLineMeta;
}

export function lineSnapshotColumns(line: PLine): PSnapshotColumns {
  const out: PSnapshotColumns = {
    custom_field_id: line.field_id,
    field_name: line.field_name,
    sort_order: line.sort_order,
    source: line.source,
    price_delta: line.price_delta,
  };
  if (line.is_file) out.file_url = line.value;
  else out.value = line.value;
  if (line.source === 'FIELD') out.field_type = line.type;
  if (line.i18n.label) out.field_label = line.i18n.label;
  if (line.i18n.display_value) out.display_value = line.i18n.display_value;
  if (line.group_key !== null) out.group_key = line.group_key;
  if (line.group_index !== null) out.group_index = line.group_index;
  if (line.i18n.group_label) out.group_label = line.i18n.group_label;
  if (line.meta) out.meta = line.meta;
  return out;
}
