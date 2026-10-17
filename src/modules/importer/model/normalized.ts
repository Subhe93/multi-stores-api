/**
 * NormalizedCatalog — the contract between the source adapters (WP-B) and
 * mapping / planning / applying (WP-C). See M4.4-DESIGN §4.1.
 *
 * Rules:
 * - Everything here is source-faithful: names, HTML and SEO strings are kept
 *   raw. Cleaning (D22) and sanitizing (D11) happen in mapping, through
 *   `model/clean.ts`, so Mapping review can show "before → after".
 * - `ext_id` fields always hold the full external reference
 *   `woo:<site_host>:<kind>:<id>` (M4-INTEGRATION C7), built with
 *   `model/external-ref.ts`. `source_id` keeps the raw source id.
 * - Additions to the design's shape are marked "(WP-B addition)".
 */

export type ImportSourceKindName = 'WP_BUNDLE' | 'WC_REST';

export interface SourceCapabilities {
  products: true;
  variations: true;
  categories: true;
  category_seo: boolean;
  category_order: boolean;
  swatches: boolean;
  variation_cards: boolean;
  personalization_flags: boolean;
  npp_templates: boolean;
  old_slugs: boolean;
  shipping: boolean;
  tax_settings: boolean;
  product_seo: boolean;
  /** (WP-B addition) `_wp_attachment_metadata.original_image` is available (bundle v1 only). */
  original_images: boolean;
}

export type NIssueLevel = 'info' | 'warn' | 'error';

/** Parser-level finding. `code` uses the `W_*` / `IMPORT_*` vocabulary of M4.4 §10. */
export interface NIssue {
  level: NIssueLevel;
  code: string;
  message: string;
  external_ref?: string;
  data?: Record<string, unknown>;
}

export interface NMediaRef {
  /** Attachment external ref (`woo:<host>:attachment:<id>`) when the media is a WP attachment. */
  ext_id?: string;
  /** Best known URL after host-alias rewrite (empty when `missing`). */
  url: string;
  /** Download candidates in D9 order: original_image, de-`-scaled`, as given. */
  candidates: string[];
  alt?: string | null;
  mime?: string | null;
  /** (WP-B addition) The attachment id is referenced but not present in the bundle (W_MEDIA_MISSING_IN_BUNDLE). */
  missing?: boolean;
}

export interface NCategorySeo {
  title?: string;
  description?: string;
  focus_keyword?: string;
  robots?: string[];
  canonical?: string;
}

export interface NCategory {
  ext_id: string;
  /** (WP-B addition) raw term_id */
  source_id: string;
  parent_ext_id: string | null;
  slug: string;
  name: string;
  description_html: string;
  /** D24 sibling sort key: [Woo `order` meta, `term_order`, name (sv collation), term_id]. */
  order_key: [number, number, string, number];
  thumbnail: NMediaRef | null;
  /** term_taxonomy.count as stored by WordPress (published objects only). */
  count: number;
  seo: NCategorySeo;
  /** (WP-B addition) 0 for roots. */
  depth: number;
  /** (WP-B addition) slugs from the root down to this category (WordPress hierarchical permalink). */
  path: string[];
  /** (WP-B addition) rank among its siblings after D24 sorting (0-based). */
  sibling_rank: number;
}

/** (WP-B addition) the design lists `tags: NTag[]` without a shape. */
export interface NTag {
  ext_id: string;
  source_id: string;
  slug: string;
  name: string;
  description_html: string;
  count: number;
}

export type NSwatchType = 'color' | 'image' | 'button' | 'radio' | 'select';

/** ACF variation-card data on a term (M4.1 valueMeta source; price/shipment are report-only). */
export interface NTermCard {
  label?: string;
  size?: string;
  badge?: string;
  badge_color?: string;
  price_text?: string;
  shipment_text?: string;
}

export interface NAttributeTerm {
  ext_id: string;
  slug: string;
  name: string;
  /** Woo termmeta `order` (0 when absent). The `terms` array is already sorted per the attribute's orderby. */
  order: number;
  color?: string;
  image?: NMediaRef;
  card?: NTermCard;
}

export interface NAttribute {
  ext_id: string;
  taxonomy: string;
  label: string;
  swatch_type: NSwatchType | null;
  terms: NAttributeTerm[];
  /** (WP-B addition) attribute_orderby from WooCommerce. */
  orderby?: string;
}

export interface NPrice {
  regular: number | null;
  sale: number | null;
  current: number | null;
}

/** Woo sale window (`_sale_price_dates_from/to`, ISO strings) on a product or variation. */
export interface NSaleWindow {
  sale_from?: string;
  sale_to?: string;
}

export interface NStock {
  manage: boolean;
  qty: number | null;
  status: string;
}

export interface NProductAttribute {
  key: string;
  label: string;
  position: number;
  visible: boolean;
  variation: boolean;
  /** Term slugs (taxonomy attribute, in term order) or local values. */
  values: string[];
  /** (WP-B addition) true for global `pa_*` attributes. */
  is_taxonomy: boolean;
}

export interface NVariation {
  ext_id: string;
  /** (WP-B addition) raw post ID */
  source_id: string;
  status: string;
  menu_order: number;
  /** attribute key → term slug / local value, `null` = "any value". */
  attrs: Record<string, string | null>;
  price: NPrice & NSaleWindow;
  sku: string | null;
  stock: NStock;
  /** (WP-B addition) variation image (`_thumbnail_id` > 0). */
  image?: NMediaRef | null;
}

export type NMechanism =
  | { kind: 'two_names'; detector: 'iwings.a'; placeholders: (string | null)[] }
  | { kind: 'single_name'; detector: 'iwings.b' }
  | {
      kind: 'name_color_per_item';
      detector: 'iwings.c1' | 'iwings.c2';
      quantity_attribute: string;
      /** term slug → number of items */
      counts: Record<string, number>;
      max: number;
      palette_attribute: string;
    }
  | {
      kind: 'engraving_lines';
      detector: 'iwings.d';
      count_attribute: string;
      max: number;
      max_length: number;
    }
  | {
      kind: 'checkbox_group';
      detector: 'ppom';
      label: string;
      options: { label: string; checked: boolean }[];
    }
  | { kind: 'broken'; detector: string; reason: string };

export interface NProductDesigner {
  enabled: boolean;
  template_ext_id: string | null;
  addons?: unknown;
  pricing?: unknown;
}

export interface NFaqItem {
  field: string;
  label: string;
  html: string;
}

export type NProductStatus =
  | 'publish'
  | 'draft'
  | 'private'
  | 'pending'
  | 'future';

export interface NProduct {
  ext_id: string;
  /** (WP-B addition) raw post ID */
  source_id: string;
  type: 'simple' | 'variable' | 'other';
  status: NProductStatus;
  slug: string;
  old_slugs: string[];
  title: string;
  content_html: string;
  excerpt_html: string;
  sku: string | null;
  price: NPrice & NSaleWindow;
  tax: { status: 'taxable' | 'shipping' | 'none'; class: string };
  stock: NStock;
  weight: number | null;
  images: NMediaRef[];
  category_ext_ids: string[];
  primary_category_ext_id: string | null;
  tag_ext_ids: string[];
  shipping_class_slug: string | null;
  menu_order: number;
  upsell_ext_ids: string[];
  attributes: NProductAttribute[];
  variations: NVariation[];
  seo: {
    title?: string;
    description?: string;
    focus_keyword?: string;
    robots?: string[];
  };
  extras: { faq: NFaqItem[]; videos: string[] };
  personalization: NMechanism[];
  designer: NProductDesigner | null;
  total_sales: number;
  unmapped_meta_keys: string[];
  /** (WP-B addition) original Woo product type (`simple`, `variable`, `grouped`, …). */
  source_type?: string;
}

export interface NShippingMethod {
  instance_id: string;
  method_id: string;
  enabled: boolean;
  order: number;
  settings: Record<string, unknown>;
}

export interface NShippingZone {
  ext_id: string;
  name: string;
  order: number;
  locations: {
    type: 'country' | 'state' | 'postcode' | 'continent';
    code: string;
  }[];
  methods: NShippingMethod[];
}

export interface NShipping {
  classes: { ext_id: string; slug: string; name: string }[];
  zones: NShippingZone[];
  /**
   * (WP-B addition) false when the bundle has no shipping tables (legacy
   * export, W_SHIPPING_NOT_IN_BUNDLE): `zones` is then empty and the
   * shipping phase must be skipped, but `classes` are still known.
   */
  zones_available: boolean;
}

export interface NTemplate {
  ext_id: string;
  /** (WP-B addition) raw post ID */
  source_id: string;
  title: string;
  size_mode: string;
  elements: unknown[];
  fonts: string[];
  thumbnail: NMediaRef | null;
  assets: NMediaRef[];
  linked_product_ext_ids: string[];
  /** Every `_npp_*` meta, decoded (JSON / PHP) where possible — hand-off to M4.2 (C26). */
  raw_meta: Record<string, unknown>;
}

export interface NStoreSettings {
  rank_math?: {
    noindex_empty_taxonomies?: boolean;
    product_title_tpl?: string;
    sep?: string;
    /** (WP-B addition) */
    site_name?: string;
    /** (WP-B addition) */
    category_title_tpl?: string;
    /** (WP-B addition) */
    product_description_tpl?: string;
  };
  wvs?: Record<string, string>;
  npp_display?: Record<string, unknown>;
}

export interface NCatalogMeta {
  kind: ImportSourceKindName;
  format_version: 0 | 1;
  site_host: string;
  uploads_base: string;
  currency: string | null;
  prices_include_tax: boolean | null;
  locale: string | null;
  bases: { product: string; category: string; tag: string };
  versions: { wp?: string; wc?: string };
  exported_at?: string;
  /** `woocommerce_weight_unit` (kg, g, lbs, oz); null/absent when unknown (legacy bundle). */
  weight_unit?: string | null;
}

export interface NormalizedCatalog {
  meta: NCatalogMeta;
  capabilities: SourceCapabilities;
  /** Parents before children; siblings in D24 order (depth-first). */
  categories: NCategory[];
  tags: NTag[];
  attributes: NAttribute[];
  products: NProduct[];
  shipping: NShipping | null;
  templates: NTemplate[];
  store_settings: NStoreSettings;
  issues: NIssue[];
}
