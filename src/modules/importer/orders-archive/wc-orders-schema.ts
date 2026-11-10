/**
 * WooCommerce order archive layout (plans/wp-order-archive, M70).
 *
 * The archive is a `.tar.gz` / `.tgz` / `.zip` holding TSV exports (header
 * row, `\N` or `NULL` for SQL NULL, WP-CLI / mysql `--batch` escaping) of
 * the order tables, plus an optional `manifest.txt` (`key=value` lines).
 * Table prefixes (`wp_`) are stripped from the file names.
 *
 * HPOS (WooCommerce 8+, `woocommerce_custom_orders_table_enabled = yes`):
 *   wc_orders, wc_order_addresses, wc_order_operational_data, wc_orders_meta,
 *   woocommerce_order_items, woocommerce_order_itemmeta.
 * Legacy (posts storage):
 *   posts (post_type shop_order / shop_order_refund), postmeta,
 *   woocommerce_order_items, woocommerce_order_itemmeta.
 */

export const ORDERS_MANIFEST_FILE = 'manifest.txt';

export const ORDERS_ARCHIVE_FILES = {
  // HPOS
  wc_orders: 'wc_orders.tsv',
  wc_order_addresses: 'wc_order_addresses.tsv',
  wc_order_operational_data: 'wc_order_operational_data.tsv',
  wc_orders_meta: 'wc_orders_meta.tsv',
  // Legacy
  posts: 'posts.tsv',
  postmeta: 'postmeta.tsv',
  // Both
  order_items: 'woocommerce_order_items.tsv',
  order_itemmeta: 'woocommerce_order_itemmeta.tsv',
} as const;

export type OrdersArchiveTable = keyof typeof ORDERS_ARCHIVE_FILES;

/** Every file name the orders archive may contain (allowlist for extraction). */
export const ORDERS_ARCHIVE_ALLOWLIST: readonly string[] = [
  ORDERS_MANIFEST_FILE,
  ...Object.values(ORDERS_ARCHIVE_FILES),
];

export function isAllowedOrdersArchiveFile(name: string): boolean {
  return ORDERS_ARCHIVE_ALLOWLIST.includes(name);
}

/** Header columns each table must at least provide (the rest is optional). */
export const ORDERS_ARCHIVE_REQUIRED_COLUMNS: Record<
  OrdersArchiveTable,
  readonly string[]
> = {
  wc_orders: ['id', 'status', 'type', 'date_created_gmt'],
  wc_order_addresses: ['order_id', 'address_type'],
  wc_order_operational_data: ['order_id'],
  wc_orders_meta: ['order_id', 'meta_key', 'meta_value'],
  posts: ['ID', 'post_type', 'post_status', 'post_date', 'post_parent'],
  postmeta: ['post_id', 'meta_key', 'meta_value'],
  order_items: [
    'order_item_id',
    'order_item_name',
    'order_item_type',
    'order_id',
  ],
  order_itemmeta: ['order_item_id', 'meta_key', 'meta_value'],
};

/** Address columns of wc_order_addresses / the `_billing_*` / `_shipping_*` meta. */
export const ADDRESS_FIELDS = [
  'first_name',
  'last_name',
  'company',
  'address_1',
  'address_2',
  'city',
  'state',
  'postcode',
  'country',
  'email',
  'phone',
] as const;

export type AddressField = (typeof ADDRESS_FIELDS)[number];
export type ArchivedAddress = Partial<Record<AddressField, string>>;

/** Meta keys a sequential-order-number plugin may use, in lookup order. */
export const ORDER_NUMBER_META_KEYS = [
  '_order_number_formatted',
  '_order_number',
  '_alg_wc_full_custom_order_number',
  '_wcj_order_number',
] as const;
