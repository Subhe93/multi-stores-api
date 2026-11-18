/**
 * The order as its BUYER may read it (POST /orders result, GET /orders/my,
 * GET /orders/:id as CUSTOMER). Any visitor can become a customer through
 * checkout, so a buyer's order payload must not carry what the platform
 * owes to whom or the supplier's catalogue internals:
 * - the order loses `commission` and `payouts`;
 * - each line loses `provider_base_amount` (the provider's price x qty);
 * - the nested product / variant / custom product keep only what a receipt
 *   shows (titles, images, the chosen options), never base_price,
 *   cost_price, stock, SKUs, price adjustments or owner ids.
 * Every other key of the order and of its lines is kept exactly as is (the
 * line prices the buyer paid, quantities, image_url, custom field values,
 * bundle, design / proof, shipping and tax snapshots, ids). Pure.
 */

type Row = Record<string, unknown>;

function isRow(v: unknown): v is Row {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Copies only the listed keys that are present on the row. */
function pick(row: Row, keys: readonly string[]): Row {
  const out: Row = {};
  for (const k of keys) if (k in row) out[k] = row[k];
  return out;
}

const PRODUCT_KEYS = ['id', 'translations', 'images'] as const;
const VARIANT_KEYS = ['id', 'options', 'images'] as const;
const CUSTOM_PRODUCT_KEYS = ['id', 'translations', 'mockup_images'] as const;

/** Nested product of a line: null / absent relations stay as they are. */
function buyerProduct(p: unknown): unknown {
  return isRow(p) ? pick(p, PRODUCT_KEYS) : p;
}

function buyerVariant(v: unknown): unknown {
  if (!isRow(v)) return v;
  const out = pick(v, VARIANT_KEYS);
  if ('product' in v) out.product = buyerProduct(v.product);
  return out;
}

function buyerCustomProduct(cp: unknown): unknown {
  if (!isRow(cp)) return cp;
  const out = pick(cp, CUSTOM_PRODUCT_KEYS);
  if ('product' in cp) out.product = buyerProduct(cp.product);
  return out;
}

/**
 * One order line as a buyer may read it. Also used for the lines of OTHER
 * fulfillers in a provider's view of a shared order (provider-order-view).
 */
export function buyerOrderItem(item: unknown): unknown {
  if (!isRow(item)) return item;
  const { provider_base_amount: _base, ...line } = item;
  void _base;
  const out: Row = { ...line };
  if ('product' in item) out.product = buyerProduct(item.product);
  if ('variant' in item) out.variant = buyerVariant(item.variant);
  if ('custom_product' in item) {
    out.custom_product = buyerCustomProduct(item.custom_product);
  }
  return out;
}

export function forBuyer<T>(order: T): T {
  if (!isRow(order)) return order;
  const { commission: _c, payouts: _p, ...rest } = order;
  void _c;
  void _p;
  const out: Row = { ...rest };
  if (Array.isArray(order.items)) out.items = order.items.map(buyerOrderItem);
  return out as T;
}
