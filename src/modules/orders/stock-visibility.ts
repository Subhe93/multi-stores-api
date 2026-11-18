/**
 * At or below this remaining stock the storefront prints the count itself
 * ("In stock (7)"): multi-stores-web
 * src/components/product/VariantSelector.tsx (`matchingVariant.stock <= 10`).
 * Keep both in step.
 */
export const LOW_STOCK_DISPLAY_THRESHOLD = 10;

/**
 * A stock write of an order line that was applied (the conditional update
 * matched a tracked row). `delta` is negative for a sale, positive for a
 * return.
 */
export type StockMove = {
  kind: 'product' | 'variant';
  id: string;
  delta: number;
};

/**
 * Whether a buyer can see a stock change of a tracked product / variant on
 * the storefront: it crossed zero in either direction ("sold out", the
 * disabled variant values), or the count on either side is one the
 * storefront prints. A sale from 500 to 499 is invisible, so a busy store
 * keeps its cache. Untracked stock (null) never counts.
 */
export function isStockChangeVisible(
  oldStock: number | null | undefined,
  newStock: number | null | undefined,
): boolean {
  if (oldStock == null || newStock == null) return false;
  if (oldStock === newStock) return false;
  const crossedZero = oldStock > 0 !== newStock > 0;
  return (
    crossedZero ||
    newStock <= LOW_STOCK_DISPLAY_THRESHOLD ||
    oldStock <= LOW_STOCK_DISPLAY_THRESHOLD
  );
}

/** The net move per row: two lines of one variant count once. */
export function netStockMoves(
  moves: StockMove[],
): Record<StockMove['kind'], Map<string, number>> {
  const net = {
    product: new Map<string, number>(),
    variant: new Map<string, number>(),
  };
  for (const move of moves) {
    net[move.kind].set(
      move.id,
      (net[move.kind].get(move.id) ?? 0) + move.delta,
    );
  }
  return net;
}
