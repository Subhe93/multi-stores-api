// Product-level stock as it should be shown.
//
// An order line of a product with variants takes stock from the VARIANT row
// only (orders.service: the line's stock row), so `Product.stock_quantity`
// of such a product is never touched by a sale and drifts away from the
// truth. Rather than adding a write to every stock path, the number is
// computed when it is read:
//
//  - no active variant: the product's own number (unchanged);
//  - every active variant carries a number: their sum (a negative counts
//    as 0);
//  - any active variant is untracked (null): the product's own number,
//    unchanged, because the total is not known.

type StockVariant = {
  stock_quantity?: number | null;
  is_active?: boolean | null;
};

/**
 * @param product  the row that carries the product-level number
 * @param variants the product's variants; inactive ones are ignored (a list
 *                 that was already filtered to active rows works the same)
 */
export function effectiveProductStock<
  P extends { stock_quantity?: number | null },
>(
  product: P,
  variants: readonly StockVariant[] | null | undefined,
): P['stock_quantity'] | number {
  // Returned as stored (null, or absent on a lean row) when it applies, so
  // a payload that did not carry the key keeps not carrying it.
  const own = product.stock_quantity;
  const active = (variants ?? []).filter((v) => v.is_active !== false);
  if (active.length === 0) return own;
  let sum = 0;
  for (const v of active) {
    const n = v.stock_quantity;
    if (n === null || n === undefined) return own;
    sum += Math.max(0, n);
  }
  return sum;
}
