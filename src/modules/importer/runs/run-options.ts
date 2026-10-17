import { CustomizationType } from '@prisma/client';
import type { TermCleanupRules } from '../model/clean';

/**
 * Run options (M4.4 §12.2, edited in Mapping review). Stored on
 * `ImportRun.options`; `normalizeRunOptions` fills defaults and rejects
 * anything malformed, so the planner only ever sees a complete object.
 */

export const IMPORT_SCOPES = [
  'categories',
  'products',
  'media',
  'shipping',
  'personalization',
  'templates',
  'redirects',
] as const;
export type ImportScope = (typeof IMPORT_SCOPES)[number];

export const SOURCE_STATUSES = [
  'publish',
  'draft',
  'private',
  'pending',
  'future',
] as const;
export type TargetProductStatus = 'PUBLISHED' | 'DRAFT';

export interface CustomizationTypeRuleOption {
  mechanisms?: string[];
  designer?: boolean;
  type: CustomizationType;
}

export interface ImportRunOptions {
  scopes: Record<ImportScope, boolean>;
  platform_category_id: string | null;
  skip_ext_ids: string[];
  include_drafts: boolean;
  status_map: Record<(typeof SOURCE_STATUSES)[number], TargetProductStatus>;
  conflict_policy: 'SKIP_MODIFIED' | 'OVERWRITE';
  on_source_removed: 'keep' | 'draft' | 'archive';
  match_existing: { categories: 'slug' | 'none'; products: 'none' };
  customization_type_rules: CustomizationTypeRuleOption[];
  term_cleanup: Required<TermCleanupRules>;
  label_overrides: Record<string, string>;
  faq_labels: Record<string, string>;
  shipping: {
    method_names: Record<string, string>;
    default_days: { min: number; max: number };
    free_shipping_as_threshold: boolean;
  };
  designer_fallback_fields: boolean;
  redirect_skipped: boolean;
  /**
   * M5 B17: also redirect the WordPress shortlink `/?p=<post id>` of every
   * published product (and of pages, when the bundle carries them). Off by
   * default: it adds one row per product.
   */
  redirect_shortlinks: boolean;
  verify_media: boolean;
  /**
   * Stock on UPDATE (M4.4 fix 17): `keep` (default) leaves the platform's
   * `stock_quantity` of existing products/variants alone (orders move it);
   * `overwrite` copies the source stock again. CREATE always sets it.
   */
  stock_on_update: 'keep' | 'overwrite';
  /**
   * Help images per preset key (C25/X15), e.g. `names_equal_length:
   * {name_1, name_2, model_text}`. Source-site URLs (plugin constants, not
   * product data); downloaded through the public media pipeline and passed
   * to the preset as `help_images` with the uploaded URLs.
   */
  preset_help_images: Record<string, Record<string, string>>;
}

/** Preset keys / image keys accepted in `preset_help_images`. */
export const PRESET_HELP_IMAGE_KEYS: Readonly<
  Record<string, readonly string[]>
> = {
  names_equal_length: ['name_1', 'name_2', 'model_text'],
};

export function defaultRunOptions(): ImportRunOptions {
  return {
    scopes: {
      categories: true,
      products: true,
      media: true,
      shipping: true,
      personalization: true,
      templates: true,
      redirects: true,
    },
    platform_category_id: null,
    skip_ext_ids: [],
    include_drafts: true,
    status_map: {
      publish: 'PUBLISHED',
      draft: 'DRAFT',
      private: 'DRAFT',
      pending: 'DRAFT',
      future: 'DRAFT',
    },
    conflict_policy: 'SKIP_MODIFIED',
    on_source_removed: 'keep',
    match_existing: { categories: 'slug', products: 'none' },
    customization_type_rules: [],
    term_cleanup: {
      strip_price_suffix: true,
      strip_trailing_colon: true,
      unicode: true,
    },
    label_overrides: {},
    faq_labels: {},
    shipping: {
      method_names: {},
      default_days: { min: 2, max: 4 },
      free_shipping_as_threshold: true,
    },
    designer_fallback_fields: true,
    redirect_skipped: true,
    redirect_shortlinks: false,
    verify_media: false,
    stock_on_update: 'keep',
    preset_help_images: {},
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const MAX_STRING = 500;
const MAX_LIST = 20_000;

/** Validates and completes run options. `errors` is empty when the input is usable. */
export function normalizeRunOptions(input: unknown): {
  options: ImportRunOptions;
  errors: string[];
} {
  const o = defaultRunOptions();
  const errors: string[] = [];
  if (input === undefined || input === null) return { options: o, errors };
  if (!isObj(input))
    return { options: o, errors: ['options must be an object'] };

  const bool = (path: string, v: unknown, set: (b: boolean) => void) => {
    if (v === undefined) return;
    if (typeof v !== 'boolean') errors.push(`${path} must be a boolean`);
    else set(v);
  };
  const strMap = (
    path: string,
    v: unknown,
    set: (m: Record<string, string>) => void,
  ) => {
    if (v === undefined) return;
    if (!isObj(v)) {
      errors.push(`${path} must be an object of strings`);
      return;
    }
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) {
      if (
        typeof val !== 'string' ||
        val.length > MAX_STRING ||
        k.length > 200
      ) {
        errors.push(`${path}.${k} must be a string (≤ ${MAX_STRING})`);
        continue;
      }
      out[k] = val;
    }
    set(out);
  };
  const oneOf = <T extends string>(
    path: string,
    v: unknown,
    allowed: readonly T[],
    set: (x: T) => void,
  ) => {
    if (v === undefined) return;
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v))
      errors.push(`${path} must be one of: ${allowed.join(', ')}`);
    else set(v as T);
  };

  const known = new Set([
    'scopes',
    'platform_category_id',
    'skip_ext_ids',
    'include_drafts',
    'status_map',
    'conflict_policy',
    'on_source_removed',
    'match_existing',
    'customization_type_rules',
    'term_cleanup',
    'label_overrides',
    'faq_labels',
    'shipping',
    'designer_fallback_fields',
    'redirect_skipped',
    'redirect_shortlinks',
    'verify_media',
    'stock_on_update',
    'preset_help_images',
  ]);
  for (const k of Object.keys(input))
    if (!known.has(k)) errors.push(`unknown option: ${k}`);

  if (input.scopes !== undefined) {
    if (!isObj(input.scopes)) errors.push('scopes must be an object');
    else
      for (const [k, v] of Object.entries(input.scopes)) {
        if (!(IMPORT_SCOPES as readonly string[]).includes(k))
          errors.push(`unknown scope: ${k}`);
        else bool(`scopes.${k}`, v, (b) => (o.scopes[k as ImportScope] = b));
      }
  }
  if (input.platform_category_id !== undefined) {
    const v = input.platform_category_id;
    if (v !== null && (typeof v !== 'string' || v.length > 64))
      errors.push('platform_category_id must be a string id or null');
    else o.platform_category_id = v || null;
  }
  if (input.skip_ext_ids !== undefined) {
    const v = input.skip_ext_ids;
    if (
      !Array.isArray(v) ||
      v.length > MAX_LIST ||
      v.some((x) => typeof x !== 'string' || x.length > 255)
    )
      errors.push('skip_ext_ids must be a list of external refs');
    else o.skip_ext_ids = [...new Set(v as string[])];
  }
  bool('include_drafts', input.include_drafts, (b) => (o.include_drafts = b));
  if (input.status_map !== undefined) {
    if (!isObj(input.status_map)) errors.push('status_map must be an object');
    else
      for (const [k, v] of Object.entries(input.status_map)) {
        if (!(SOURCE_STATUSES as readonly string[]).includes(k))
          errors.push(`status_map: unknown source status ${k}`);
        else
          oneOf(`status_map.${k}`, v, ['PUBLISHED', 'DRAFT'] as const, (x) => {
            o.status_map[k as (typeof SOURCE_STATUSES)[number]] = x;
          });
      }
  }
  oneOf(
    'conflict_policy',
    input.conflict_policy,
    ['SKIP_MODIFIED', 'OVERWRITE'] as const,
    (x) => (o.conflict_policy = x),
  );
  oneOf(
    'on_source_removed',
    input.on_source_removed,
    ['keep', 'draft', 'archive'] as const,
    (x) => (o.on_source_removed = x),
  );
  if (input.match_existing !== undefined) {
    if (!isObj(input.match_existing))
      errors.push('match_existing must be an object');
    else {
      oneOf(
        'match_existing.categories',
        input.match_existing.categories,
        ['slug', 'none'] as const,
        (x) => (o.match_existing.categories = x),
      );
      oneOf(
        'match_existing.products',
        input.match_existing.products,
        ['none'] as const,
        (x) => (o.match_existing.products = x),
      );
    }
  }
  if (input.customization_type_rules !== undefined) {
    const v = input.customization_type_rules;
    const types = Object.values(CustomizationType) as string[];
    if (!Array.isArray(v) || v.length > 50)
      errors.push('customization_type_rules must be a list');
    else {
      const rules: CustomizationTypeRuleOption[] = [];
      v.forEach((r: unknown, i) => {
        if (
          !isObj(r) ||
          typeof r.type !== 'string' ||
          !types.includes(r.type)
        ) {
          errors.push(`customization_type_rules[${i}].type is invalid`);
          return;
        }
        const mechanisms = r.mechanisms;
        if (
          mechanisms !== undefined &&
          (!Array.isArray(mechanisms) ||
            mechanisms.some((m) => typeof m !== 'string'))
        ) {
          errors.push(`customization_type_rules[${i}].mechanisms is invalid`);
          return;
        }
        if (r.designer !== undefined && typeof r.designer !== 'boolean') {
          errors.push(`customization_type_rules[${i}].designer is invalid`);
          return;
        }
        rules.push({
          type: r.type as CustomizationType,
          ...(mechanisms ? { mechanisms: mechanisms as string[] } : {}),
          ...(r.designer !== undefined ? { designer: r.designer } : {}),
        });
      });
      o.customization_type_rules = rules;
    }
  }
  if (input.term_cleanup !== undefined) {
    if (!isObj(input.term_cleanup))
      errors.push('term_cleanup must be an object');
    else {
      const t = input.term_cleanup;
      bool(
        'term_cleanup.strip_price_suffix',
        t.strip_price_suffix,
        (b) => (o.term_cleanup.strip_price_suffix = b),
      );
      bool(
        'term_cleanup.strip_trailing_colon',
        t.strip_trailing_colon,
        (b) => (o.term_cleanup.strip_trailing_colon = b),
      );
      bool(
        'term_cleanup.unicode',
        t.unicode,
        (b) => (o.term_cleanup.unicode = b),
      );
    }
  }
  strMap(
    'label_overrides',
    input.label_overrides,
    (m) => (o.label_overrides = m),
  );
  strMap('faq_labels', input.faq_labels, (m) => (o.faq_labels = m));
  if (input.shipping !== undefined) {
    if (!isObj(input.shipping)) errors.push('shipping must be an object');
    else {
      const s = input.shipping;
      strMap(
        'shipping.method_names',
        s.method_names,
        (m) => (o.shipping.method_names = m),
      );
      if (s.default_days !== undefined) {
        const d = s.default_days;
        if (
          !isObj(d) ||
          !Number.isInteger(d.min) ||
          !Number.isInteger(d.max) ||
          (d.min as number) < 0 ||
          (d.max as number) < (d.min as number) ||
          (d.max as number) > 365
        )
          errors.push(
            'shipping.default_days must be {min, max} integers, 0 ≤ min ≤ max ≤ 365',
          );
        else
          o.shipping.default_days = {
            min: d.min as number,
            max: d.max as number,
          };
      }
      bool(
        'shipping.free_shipping_as_threshold',
        s.free_shipping_as_threshold,
        (b) => (o.shipping.free_shipping_as_threshold = b),
      );
    }
  }
  bool(
    'designer_fallback_fields',
    input.designer_fallback_fields,
    (b) => (o.designer_fallback_fields = b),
  );
  bool(
    'redirect_skipped',
    input.redirect_skipped,
    (b) => (o.redirect_skipped = b),
  );
  bool(
    'redirect_shortlinks',
    input.redirect_shortlinks,
    (b) => (o.redirect_shortlinks = b),
  );
  bool('verify_media', input.verify_media, (b) => (o.verify_media = b));
  oneOf(
    'stock_on_update',
    input.stock_on_update,
    ['keep', 'overwrite'] as const,
    (x) => (o.stock_on_update = x),
  );
  if (input.preset_help_images !== undefined) {
    const v = input.preset_help_images;
    if (!isObj(v)) errors.push('preset_help_images must be an object');
    else {
      const out: Record<string, Record<string, string>> = {};
      for (const [preset, images] of Object.entries(v)) {
        const allowed = PRESET_HELP_IMAGE_KEYS[preset];
        if (!allowed) {
          errors.push(`preset_help_images: unknown preset ${preset}`);
          continue;
        }
        if (!isObj(images)) {
          errors.push(`preset_help_images.${preset} must be an object`);
          continue;
        }
        const map: Record<string, string> = {};
        for (const [k, url] of Object.entries(images)) {
          if (!allowed.includes(k)) {
            errors.push(`preset_help_images.${preset}: unknown image ${k}`);
            continue;
          }
          if (
            typeof url !== 'string' ||
            url.length > 1000 ||
            !/^https?:\/\/[^\s/]+\/\S*$/i.test(url)
          ) {
            errors.push(
              `preset_help_images.${preset}.${k} must be an http(s) URL`,
            );
            continue;
          }
          map[k] = url;
        }
        out[preset] = map;
      }
      o.preset_help_images = out;
    }
  }
  return { options: o, errors };
}
