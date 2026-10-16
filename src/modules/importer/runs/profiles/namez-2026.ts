/**
 * Saved run profile `namez-2026` (M4.4 §12.2): the Namez WooCommerce import.
 *
 * A plain options object in the `ImportRunOptions` input shape, validated by
 * `normalizeRunOptions` (see namez-2026.spec.ts). It is a preset for Mapping
 * review, not a source of truth: `platform_category_id` stays null and is
 * chosen in Mapping review (D23); confirming a run without it fails with
 * IMPORT_PLATFORM_CATEGORY_REQUIRED.
 *
 * Source settings of the same run (ImportSource, §12.1): site_host
 * `namez.se`, host_aliases `['3dnamez.se']`, settings `{product_base:
 * 'produkt', category_base: 'product-category', tag_base: 'product-tag',
 * locale: 'sv', currency: 'SEK'}` — see NAMEZ_2026_SOURCE below.
 */
export const NAMEZ_2026_PROFILE_KEY = 'namez-2026';

export const NAMEZ_2026_PROFILE = {
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
  skip_ext_ids: ['woo:namez.se:product:4326'],
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
  customization_type_rules: [
    {
      mechanisms: [
        'two_names',
        'single_name',
        'name_color_per_item',
        'checkbox_group',
      ],
      type: 'PRINT_3D',
    },
    { mechanisms: ['engraving_lines'], type: 'ENGRAVE' },
    { designer: true, type: 'PRINT' },
  ],
  term_cleanup: {
    strip_price_suffix: true,
    strip_trailing_colon: true,
    unicode: true,
  },
  label_overrides: { pa_namnskylt_stor_bokstav: 'Välj antal' },
  faq_labels: {
    product_care_instructions: 'Skötselråd',
    product_size_fit: 'Storlek & passform',
    product_delivery: 'Leverans',
  },
  shipping: {
    method_names: {
      flat_rate: 'Standardfrakt (Skickas inom 2-4 arbetsdagar)',
      local_pickup: 'Hämta själv - (Hagavägen 36, 784 40 Borlänge) Gratis',
    },
    default_days: { min: 2, max: 4 },
    free_shipping_as_threshold: true,
  },
  designer_fallback_fields: true,
  redirect_skipped: true,
  verify_media: true,
  stock_on_update: 'keep',
  // The iWings "two names" help modal images are plugin constants, not
  // product meta (Discovery B §4.6); the export has them as attachments of 2229.
  preset_help_images: {
    names_equal_length: {
      name_1: 'https://namez.se/wp-content/uploads/2024/09/left-3dnamez.jpg',
      name_2: 'https://namez.se/wp-content/uploads/2024/09/right-3dnamez.jpg',
      model_text: 'https://namez.se/wp-content/uploads/2024/09/framsidan.jpg',
    },
  },
} as const;

/** The ImportSource of the Namez run (§12.1). */
export const NAMEZ_2026_SOURCE = {
  kind: 'WP_BUNDLE',
  site_host: 'namez.se',
  host_aliases: ['3dnamez.se'],
  settings: {
    product_base: 'produkt',
    category_base: 'product-category',
    tag_base: 'product-tag',
    locale: 'sv',
    currency: 'SEK',
  },
} as const;
