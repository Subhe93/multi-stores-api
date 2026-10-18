/**
 * WordPress export bundle layout (M4.4 §2.1): file allowlist and column
 * orders for the legacy bundle (format 0, no header rows; Discovery C L6)
 * and bundle v1 (header rows + manifest.json).
 */

export const POSTS_COLUMNS = [
  'ID',
  'post_author',
  'post_date',
  'post_date_gmt',
  'post_content',
  'post_title',
  'post_excerpt',
  'post_status',
  'comment_status',
  'ping_status',
  'post_password',
  'post_name',
  'to_ping',
  'pinged',
  'post_modified',
  'post_modified_gmt',
  'post_content_filtered',
  'post_parent',
  'guid',
  'menu_order',
  'post_type',
  'post_mime_type',
  'comment_count',
] as const;

/**
 * Post types of `posts.tsv` (same lists as `WPX_POST_TYPES` /
 * `WPX_CONTENT_POST_TYPES` in tools/importer/wp-export.sh, checked by
 * wp-export-format.spec.ts). Catalog types are exported in every status but
 * trash / auto-draft / inherit; content types (M5 B17) only when published.
 */
export const CATALOG_POST_TYPES: readonly string[] = [
  'product',
  'product_variation',
  'npp_template',
  'acf-field-group',
  'acf-field',
];
export const CONTENT_POST_TYPES: readonly string[] = ['page', 'post'];

export interface TableSpec {
  file: string;
  /** Column order of the legacy bundle (format 0). */
  columns: readonly string[];
  /** Trailing columns that may be absent (e.g. `terms.term_order` without taxonomy-terms-order). */
  minColumns?: number;
  required: boolean;
  /** Present in bundle v1 only. */
  v1Only?: boolean;
  /**
   * Legacy column names are unknown (the table schema varies by plugin
   * version); the adapter reads such rows positionally / heuristically.
   */
  positional?: boolean;
}

export const BUNDLE_TABLES = {
  posts: { file: 'posts.tsv', columns: POSTS_COLUMNS, required: true },
  postmeta: {
    file: 'postmeta.tsv',
    columns: ['meta_id', 'post_id', 'meta_key', 'meta_value'],
    required: true,
  },
  terms: {
    file: 'terms.tsv',
    columns: ['term_id', 'name', 'slug', 'term_group', 'term_order'],
    minColumns: 4,
    required: true,
  },
  term_taxonomy: {
    file: 'term_taxonomy.tsv',
    columns: [
      'term_taxonomy_id',
      'term_id',
      'taxonomy',
      'description',
      'parent',
      'count',
    ],
    required: true,
  },
  termmeta: {
    file: 'termmeta.tsv',
    columns: ['meta_id', 'term_id', 'meta_key', 'meta_value'],
    required: false,
  },
  term_relationships: {
    file: 'term_relationships.tsv',
    columns: ['object_id', 'term_taxonomy_id', 'term_order'],
    minColumns: 2,
    required: true,
  },
  attribute_taxonomies: {
    file: 'attribute_taxonomies.tsv',
    columns: [
      'attribute_id',
      'attribute_name',
      'attribute_label',
      'attribute_type',
      'attribute_orderby',
      'attribute_public',
    ],
    required: false,
  },
  attachments: {
    file: 'attachments.tsv',
    // v1 adds _wp_attached_file, _wp_attachment_metadata, _wp_attachment_image_alt.
    columns: [
      'ID',
      'guid',
      'post_mime_type',
      'post_parent',
      '_wp_attached_file',
      '_wp_attachment_metadata',
      '_wp_attachment_image_alt',
    ],
    minColumns: 4,
    required: false,
  },
  options: {
    file: 'options.tsv',
    columns: ['option_name', 'option_value'],
    required: false,
  },
  ppom_meta: {
    file: 'ppom_meta.tsv',
    columns: [],
    required: false,
    positional: true,
  },
  shipping_zones: {
    file: 'shipping_zones.tsv',
    columns: ['zone_id', 'zone_name', 'zone_order'],
    required: false,
    v1Only: true,
  },
  shipping_zone_locations: {
    file: 'shipping_zone_locations.tsv',
    columns: ['location_id', 'zone_id', 'location_code', 'location_type'],
    required: false,
    v1Only: true,
  },
  shipping_zone_methods: {
    file: 'shipping_zone_methods.tsv',
    columns: [
      'zone_id',
      'instance_id',
      'method_id',
      'method_order',
      'is_enabled',
    ],
    required: false,
    v1Only: true,
  },
  tax_rates: {
    file: 'tax_rates.tsv',
    columns: [],
    required: false,
    v1Only: true,
    positional: true,
  },
  tax_rate_locations: {
    file: 'tax_rate_locations.tsv',
    columns: [],
    required: false,
    v1Only: true,
    positional: true,
  },
} as const satisfies Record<string, TableSpec>;

export type BundleTableName = keyof typeof BUNDLE_TABLES;

export const MANIFEST_FILE = 'manifest.json';

/** Every file name a bundle may contain (§9.3: allowlisted names only). */
export const BUNDLE_FILE_ALLOWLIST: readonly string[] = [
  MANIFEST_FILE,
  ...Object.values(BUNDLE_TABLES).map((t) => t.file),
  'plugins.csv',
  'versions.txt',
];

export function isAllowedBundleFile(name: string): boolean {
  return BUNDLE_FILE_ALLOWLIST.includes(name);
}

/**
 * Options the parser keeps. Everything else in `options.tsv` is ignored
 * (payment gateways etc. are never exported, but a hand-made bundle could
 * contain them). `woocommerce_<method>_<instance>_settings` is matched by
 * pattern (shipping method instances only).
 */
export const OPTION_ALLOWLIST: readonly string[] = [
  'siteurl',
  'home',
  'blogname',
  'WPLANG',
  'permalink_structure',
  'category_base',
  'show_on_front',
  'page_on_front',
  'page_for_posts',
  'woocommerce_permalinks',
  'woocommerce_currency',
  'woocommerce_price_num_decimals',
  'woocommerce_prices_include_tax',
  'woocommerce_calc_taxes',
  'woocommerce_tax_based_on',
  'woocommerce_default_country',
  'woocommerce_weight_unit',
  'woocommerce_dimension_unit',
  'woocommerce_allowed_countries',
  'woocommerce_specific_allowed_countries',
  'woocommerce_ship_to_countries',
  'woocommerce_specific_ship_to_countries',
  'woocommerce_shipping_cost_requires_address',
  'wc_hide_shipping_options',
  'npp_display',
  'npp_sale',
  'npp_welcome_template_ids',
  'rank_math_modules',
  'rank-math-options-titles',
  'rank-math-options-general',
  'rank-math-options-sitemap',
  'woo_variation_swatches',
];

export const SHIPPING_METHOD_OPTION_RE =
  /^woocommerce_([a-z0-9_]+?)_(\d+)_settings$/;

/** Only these sub-keys of `rank-math-options-general` are kept (drops `console_email_*` PII, Discovery C L8). */
export const RANK_MATH_GENERAL_ALLOWED_KEYS: readonly string[] = [
  'wc_remove_product_base',
  'wc_remove_category_base',
  'wc_remove_category_parent_slugs',
  'strip_category_base',
  'noindex_hidden_products',
  'attachment_redirect_urls',
];

export function isAllowedOption(name: string): boolean {
  return (
    OPTION_ALLOWLIST.includes(name) || SHIPPING_METHOD_OPTION_RE.test(name)
  );
}

export interface BundleManifest {
  format: 'wp-bundle';
  format_version: 1;
  site_url?: string;
  home_url?: string;
  wp_version?: string;
  wc_version?: string;
  db_prefix?: string;
  exported_at?: string;
  locale?: string;
  files?: string[];
}

export function parseManifest(text: string): BundleManifest {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('manifest.json is not valid JSON');
  }
  if (!data || typeof data !== 'object')
    throw new Error('manifest.json must be an object');
  const m = data as Record<string, unknown>;
  if (m.format !== 'wp-bundle')
    throw new Error('manifest.json: format must be "wp-bundle"');
  if (m.format_version !== 1)
    throw new Error(
      `manifest.json: unsupported format_version ${String(m.format_version)}`,
    );
  const str = (k: string): string | undefined => {
    const v = m[k];
    return typeof v === 'string' ? v : undefined;
  };
  return {
    format: 'wp-bundle',
    format_version: 1,
    site_url: str('site_url'),
    home_url: str('home_url'),
    wp_version: str('wp_version'),
    wc_version: str('wc_version'),
    db_prefix: str('db_prefix'),
    exported_at: str('exported_at'),
    locale: str('locale'),
    files: Array.isArray(m.files)
      ? m.files.filter((f): f is string => typeof f === 'string')
      : undefined,
  };
}
