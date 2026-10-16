import { join } from 'path';
import { MemoryBundleReader } from '../../bundle-reader';
import type { ImportSourceView } from '../../source-adapter';
import type { DryRunOptions } from '../../../model/dry-run-summary';

/** Shared test fixtures for the WordPress bundle adapter (not a spec file). */

/**
 * Real rows copied verbatim (WP-CLI escaping preserved) from the read-only
 * Namez export of 2026-10-15. Selection: products 2229, 2826, 3484, 4106,
 * 4256, 4275, 4326, 4414 with their variations (variation fb_/_wc_gla_/
 * _wc_facebook_ sync meta dropped), NPP templates 4273 and 4315, all ACF
 * field posts, every attribute term, the categories of those products plus
 * their ancestors and halsband / namnhalsband-med-egen-gravyr /
 * studentskyltar, their attachments, PPOM and an options subset without
 * rank-math-options-general (PII).
 */
export const SLICE_DIR = join(__dirname, 'namez-slice');

/** The full read-only export; tests that need it are skipped when it is absent. */
export const NAMEZ_EXPORT_DIR =
  process.env.NAMEZ_EXPORT_DIR ?? 'C:/Projects/namez.se-readonly/db-export';

/** ImportSource of the Namez run (M4.4 §12.1). */
export const NAMEZ_SOURCE: ImportSourceView = {
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
};

/** Run options of the saved profile `namez-2026` that affect the dry run (M4.4 §12.2). */
export const NAMEZ_RUN_OPTIONS: DryRunOptions = {
  skip_ext_ids: ['woo:namez.se:product:4326'],
  include_drafts: true,
  status_map: {
    publish: 'PUBLISHED',
    draft: 'DRAFT',
    private: 'DRAFT',
    pending: 'DRAFT',
    future: 'DRAFT',
  },
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
  designer_fallback_fields: true,
  redirect_skipped: true,
};

// Bundle v1 (manifest + header rows + shipping tables), hand-made sample.

const tsv = (rows: (string | number | null)[][]) =>
  rows
    .map((r) =>
      r
        .map((c) =>
          c === null
            ? 'NULL'
            : String(c)
                .replace(/\\/g, '\\\\')
                .replace(/\t/g, '\\t')
                .replace(/\n/g, '\\n'),
        )
        .join('\t'),
    )
    .join('\n') + '\n';

const POST_HEADER = [
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
];
const post = (
  id: number,
  type: string,
  status: string,
  name: string,
  title: string,
  parent = 0,
  menuOrder = 0,
  content = '',
) => [
  id,
  1,
  '2026-01-01 00:00:00',
  '2026-01-01 00:00:00',
  content,
  title,
  '',
  status,
  'closed',
  'closed',
  '',
  name,
  '',
  '',
  '2026-01-01 00:00:00',
  '2026-01-01 00:00:00',
  '',
  parent,
  `https://shop.example/?p=${id}`,
  menuOrder,
  type,
  '',
  0,
];

/** A small hand-made bundle v1 (§2.1) with every table kind. */
export function v1Sample(): MemoryBundleReader {
  const php = (s: string) => s;
  return new MemoryBundleReader({
    'manifest.json': JSON.stringify({
      format: 'wp-bundle',
      format_version: 1,
      site_url: 'https://shop.example',
      wp_version: '7.1.3',
      wc_version: '11.2.1',
      exported_at: '2026-10-20T10:00:00Z',
      locale: 'sv_SE',
    }),
    'posts.tsv': tsv([
      POST_HEADER,
      post(
        10,
        'product',
        'publish',
        'mugg',
        'Mugg',
        0,
        0,
        '<p data-start="1">Hej\nrad två</p>',
      ),
      post(20, 'product', 'publish', 'skylt', 'Skylt'),
      post(21, 'product_variation', 'publish', 'skylt-a', 'Skylt A', 20, 1),
      post(22, 'product_variation', 'publish', 'skylt-any', 'Skylt any', 20, 2),
      post(30, 'product', 'trash', 'gone', 'Gone'),
    ]),
    'postmeta.tsv': tsv([
      ['meta_id', 'post_id', 'meta_key', 'meta_value'],
      [1, 10, '_price', '99'],
      [2, 10, '_regular_price', '149'],
      [3, 10, '_sale_price', '99'],
      [4, 10, '_sale_price_dates_from', '4102444800'],
      [5, 10, '_thumbnail_id', '500'],
      [6, 10, '_weight', '0,5'],
      [7, 10, '_crosssell_ids', php('a:1:{i:0;i:20;}')],
      [
        8,
        20,
        '_product_attributes',
        php(
          'a:1:{s:5:"farg-";a:6:{s:4:"name";s:5:"Färg";s:5:"value";s:11:"Röd | Blå";s:8:"position";i:0;s:10:"is_visible";i:1;s:12:"is_variation";i:1;s:11:"is_taxonomy";i:0;}}',
        ),
      ],
      [9, 21, 'attribute_farg-', 'Röd'],
      [10, 21, '_price', '200'],
      [11, 22, 'attribute_farg-', ''],
      [12, 22, '_price', '200'],
      [13, 21, '_sku', 'SK-1'],
    ]),
    'terms.tsv': tsv([
      ['term_id', 'name', 'slug', 'term_group', 'term_order'],
      [2, 'simple', 'simple', 0, 0],
      [4, 'variable', 'variable', 0, 0],
      [50, 'Muggar &amp; koppar', 'muggar', 0, 0],
      [60, 'Frakt Stor', 'stor', 0, 0],
    ]),
    'term_taxonomy.tsv': tsv([
      [
        'term_taxonomy_id',
        'term_id',
        'taxonomy',
        'description',
        'parent',
        'count',
      ],
      [2, 2, 'product_type', '', 0, 1],
      [4, 4, 'product_type', '', 0, 1],
      [50, 50, 'product_cat', 'Beskrivning', 0, 1],
      [60, 60, 'product_shipping_class', '', 0, 1],
    ]),
    'term_relationships.tsv': tsv([
      ['object_id', 'term_taxonomy_id', 'term_order'],
      [10, 2, 0],
      [10, 50, 0],
      [10, 60, 0],
      [20, 4, 0],
    ]),
    'attachments.tsv': tsv([
      [
        'ID',
        'guid',
        'post_mime_type',
        'post_parent',
        '_wp_attached_file',
        '_wp_attachment_metadata',
        '_wp_attachment_image_alt',
      ],
      [
        500,
        'https://old.example/wp-content/uploads/2026/04/mugg-scaled.jpg',
        'image/jpeg',
        10,
        '2026/04/mugg-scaled.jpg',
        php(
          'a:3:{s:5:"width";i:2560;s:4:"file";s:23:"2026/04/mugg-scaled.jpg";s:14:"original_image";s:8:"mugg.jpg";}',
        ),
        'En mugg',
      ],
    ]),
    'options.tsv': tsv([
      ['option_name', 'option_value'],
      ['woocommerce_currency', 'SEK'],
      ['woocommerce_prices_include_tax', 'yes'],
      [
        'woocommerce_permalinks',
        php(
          'a:3:{s:12:"product_base";s:8:"/produkt";s:13:"category_base";s:9:"kategori/";s:8:"tag_base";s:0:"";}',
        ),
      ],
      [
        'woocommerce_flat_rate_3_settings',
        php('a:2:{s:5:"title";s:8:"Standard";s:4:"cost";s:2:"49";}'),
      ],
      [
        'woocommerce_stripe_settings',
        php('a:1:{s:10:"secret_key";s:6:"sk_xxx";}'),
      ],
      [
        'rank-math-options-general',
        php(
          'a:2:{s:21:"console_email_send_to";s:13:"a@example.com";s:22:"wc_remove_product_base";s:3:"off";}',
        ),
      ],
    ]),
    'shipping_zones.tsv': tsv([
      ['zone_id', 'zone_name', 'zone_order'],
      [1, 'Sverige', 0],
    ]),
    'shipping_zone_locations.tsv': tsv([
      ['location_id', 'zone_id', 'location_code', 'location_type'],
      [1, 1, 'SE', 'country'],
      [2, 1, '784*', 'postcode'],
    ]),
    'shipping_zone_methods.tsv': tsv([
      ['zone_id', 'instance_id', 'method_id', 'method_order', 'is_enabled'],
      [1, 3, 'flat_rate', 1, 1],
      [1, 4, 'local_pickup', 2, 0],
      [0, 5, 'free_shipping', 1, 1],
    ]),
    'evil.sh': 'rm -rf /',
  });
}
