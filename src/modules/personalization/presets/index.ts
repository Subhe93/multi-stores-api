import { isPlainObject } from '@multi-stores/core/personalization/rules';
import type { ConfigIssue } from '../personalization.errors';
import { isSafeImageUrl } from '../personalization-config.validator';
import { checkboxGroupPreset } from './checkbox-group';
import { engravingsPreset } from './engravings';
import { nameColorPerItemPreset } from './name-color-per-item';
import { namesEqualLengthPreset } from './names-equal-length';
import type {
  PresetDefinition,
  PresetParam,
  PresetSummary,
} from './preset.types';
import { singleNamePreset } from './single-name';

export * from './preset.types';

/** The five presets (M4.1 §4.6), in display order. */
export const PRESETS: readonly PresetDefinition[] = [
  namesEqualLengthPreset,
  singleNamePreset,
  nameColorPerItemPreset,
  engravingsPreset,
  checkboxGroupPreset,
];

export const PRESET_KEYS = PRESETS.map((p) => p.key);

export function findPreset(key: string): PresetDefinition | null {
  return PRESETS.find((p) => p.key === key) ?? null;
}

export function presetSummaries(): PresetSummary[] {
  return PRESETS.map((p) => ({
    key: p.key,
    version: p.version,
    params: p.params.map((param) => ({ ...param })),
  }));
}

const MAX_STRING = 200;
const MAX_LIST = 50;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Checks and defaults preset params. `optionValues` maps each product option
 * name to its values. Unknown keys are refused. Returns the effective
 * params or the issues (`path` = `params.<key>`).
 */
export function resolvePresetParams(
  preset: PresetDefinition,
  raw: unknown,
  optionValues: ReadonlyMap<string, string[]>,
): { params: Record<string, unknown>; errors: ConfigIssue[] } {
  const errors: ConfigIssue[] = [];
  const input = raw === undefined || raw === null ? {} : raw;
  if (!isPlainObject(input)) {
    return { params: {}, errors: [{ path: 'params', code: 'INVALID_SHAPE' }] };
  }
  const known = new Map(preset.params.map((p) => [p.key, p]));
  for (const k of Object.keys(input)) {
    if (!known.has(k))
      errors.push({ path: `params.${k}`, code: 'UNKNOWN_KEY' });
  }
  const params: Record<string, unknown> = {};
  // Plain types first; map/list types read their `ref` param afterwards.
  const order = [...preset.params].sort(
    (a, b) => Number(!!a.ref) - Number(!!b.ref),
  );
  for (const def of order) {
    const v = input[def.key];
    if (v === undefined || v === null) {
      if (def.required) {
        errors.push({ path: `params.${def.key}`, code: 'REQUIRED' });
      } else if (def.default !== undefined) {
        params[def.key] = clone(def.default);
      }
      continue;
    }
    const issue = checkParam(def, v, params, optionValues);
    if (issue) errors.push({ path: `params.${def.key}`, code: issue });
    else params[def.key] = clone(v);
  }
  // Option params must name an option of the product (only those in use).
  const used = preset.optionParamsUsed
    ? new Set(preset.optionParamsUsed(params))
    : null;
  for (const def of preset.params) {
    if (def.type !== 'option' || params[def.key] === undefined) continue;
    if (used && !used.has(def.key)) continue;
    const name = params[def.key] as string;
    if (!optionValues.has(name)) {
      errors.push({
        path: `params.${def.key}`,
        code: 'UNKNOWN_OPTION',
        params: { key: name.slice(0, 120) },
      });
    }
  }
  return { params, errors };
}

function isInt(v: unknown, min?: number, max?: number): v is number {
  return (
    typeof v === 'number' &&
    Number.isInteger(v) &&
    (min === undefined || v >= min) &&
    (max === undefined || v <= max)
  );
}

function isText(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '' && v.length <= MAX_STRING;
}

function checkParam(
  def: PresetParam,
  v: unknown,
  resolved: Record<string, unknown>,
  optionValues: ReadonlyMap<string, string[]>,
): string | null {
  switch (def.type) {
    case 'option':
    case 'string':
      return isText(v) ? null : 'INVALID_VALUE';
    case 'number':
      return isInt(v, def.min, def.max) ? null : 'OUT_OF_RANGE';
    case 'boolean':
      return typeof v === 'boolean' ? null : 'INVALID_VALUE';
    case 'enum':
      return typeof v === 'string' && (def.values ?? []).includes(v)
        ? null
        : 'INVALID_VALUE';
    case 'string_list': {
      if (!Array.isArray(v) || v.length === 0 || v.length > MAX_LIST) {
        return 'INVALID_VALUE';
      }
      if (!v.every(isText)) return 'INVALID_VALUE';
      return new Set(v).size === v.length ? null : 'DUPLICATE_VALUE';
    }
    case 'option_value_map': {
      if (!isPlainObject(v) || Object.keys(v).length > 100)
        return 'INVALID_VALUE';
      const option = def.ref ? resolved[def.ref] : undefined;
      const values =
        typeof option === 'string' ? optionValues.get(option) : undefined;
      for (const [k, n] of Object.entries(v)) {
        if (!isInt(n, 0, 100)) return 'OUT_OF_RANGE';
        if (values && !values.includes(k)) return 'NOT_IN_OPTIONS';
      }
      return null;
    }
    case 'checked_list': {
      if (v === 'all') return null;
      if (!Array.isArray(v) || v.length > MAX_LIST) return 'INVALID_VALUE';
      const list = def.ref ? resolved[def.ref] : undefined;
      const allowed = Array.isArray(list) ? list : [];
      return v.every((x) => typeof x === 'string' && allowed.includes(x))
        ? null
        : 'NOT_IN_OPTIONS';
    }
    case 'image_map': {
      if (!isPlainObject(v)) return 'INVALID_VALUE';
      for (const [k, url] of Object.entries(v)) {
        if (!(def.keys ?? []).includes(k)) return 'UNKNOWN_KEY';
        if (url === null || url === '') continue;
        if (typeof url !== 'string' || !isSafeImageUrl(url))
          return 'INVALID_URL';
      }
      return null;
    }
    default:
      return 'INVALID_VALUE';
  }
}
