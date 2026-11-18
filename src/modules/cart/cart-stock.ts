// Stock limits in the cart.
//
// The cart used to accept any quantity; the refusal came only at POST
// /orders (ORDER_INSUFFICIENT_STOCK). A cart line is now bounded by the same
// stock row order creation takes from (orders.service priceLine):
//
//  - a line with a variant: that variant, when its stock_quantity is set;
//    an untracked variant holds no stock (no fall back to the product);
//  - an own product line without a variant: the product, when it tracks
//    inventory and its stock_quantity is set;
//  - an imported (custom product) line: the base variant / base product by
//    the same two rules, but only while CUSTOM_LINE_STOCK_SINCE is in
//    effect (orders/custom-line-stock.ts); otherwise it holds no stock.
//
// Several cart lines can sell the same stock row (the same variant with
// different personalization, the same product twice), so a line's room is
// the row's stock minus the units of that row on the cart's OTHER lines.

export const CART_INSUFFICIENT_STOCK = 'CART_INSUFFICIENT_STOCK';

/** What a cart line row tells about the stock row it would take from. */
export type CartStockLine = {
  id?: string;
  product_id?: string | null;
  variant_id?: string | null;
  custom_product_id?: string | null;
  quantity: number;
};

export type StockRowRef = { kind: 'variant' | 'product'; id: string };

export const stockRowKey = (ref: StockRowRef): string =>
  `${ref.kind}:${ref.id}`;

/**
 * The row a cart line would take stock from, before any "is it tracked"
 * check, or null when it can hold none.
 *
 * @param baseProductOf     base product id of each custom product in play
 * @param customLinesHold   whether imported lines hold stock right now
 */
export function cartLineStockRef(
  line: CartStockLine,
  baseProductOf: ReadonlyMap<string, string>,
  customLinesHold: boolean,
): StockRowRef | null {
  if (line.custom_product_id) {
    if (!customLinesHold) return null;
    if (line.variant_id) return { kind: 'variant', id: line.variant_id };
    const base = baseProductOf.get(line.custom_product_id);
    return base ? { kind: 'product', id: base } : null;
  }
  if (line.variant_id) return { kind: 'variant', id: line.variant_id };
  if (line.product_id) return { kind: 'product', id: line.product_id };
  return null;
}

/** Tracked stock of a row, or null when the row is not tracked / unknown. */
export type TrackedStockOf = (ref: StockRowRef) => number | null;

/**
 * Units of the stock row `ref` on `lines` (the caller leaves out the line
 * being changed).
 */
export function unitsOnRow(
  ref: StockRowRef,
  lines: readonly CartStockLine[],
  baseProductOf: ReadonlyMap<string, string>,
  customLinesHold: boolean,
): number {
  const key = stockRowKey(ref);
  let units = 0;
  for (const line of lines) {
    const other = cartLineStockRef(line, baseProductOf, customLinesHold);
    if (other && stockRowKey(other) === key) units += line.quantity;
  }
  return units;
}

/**
 * The largest quantity a line may hold: the row's stock minus the units of
 * the same row on the other lines, never below 0.
 */
export function roomOnRow(stock: number, unitsOnOtherLines: number): number {
  return Math.max(0, Math.max(0, stock) - unitsOnOtherLines);
}

/** Body of the 400 answered when a line would exceed its stock row. */
export function insufficientStockError(
  line: Pick<CartStockLine, 'product_id' | 'variant_id' | 'custom_product_id'>,
  available: number,
) {
  return {
    code: CART_INSUFFICIENT_STOCK,
    message:
      available > 0
        ? `Only ${available} in stock.`
        : 'This item is out of stock.',
    available,
    ...(line.product_id ? { product_id: line.product_id } : {}),
    ...(line.variant_id ? { variant_id: line.variant_id } : {}),
    ...(line.custom_product_id
      ? { custom_product_id: line.custom_product_id }
      : {}),
  };
}
