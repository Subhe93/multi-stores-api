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
  /**
   * The row's tracked stock as the writer loaded it BEFORE the write, when
   * it has it (the order lines of a stock return). See isStockMoveVisible.
   */
  before?: number | null;
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

/**
 * The decision for one moved row. `now` is the stock read after the commit
 * and `delta` the row's net move, so the stock before is `now - delta`: the
 * last of several concurrent writers reads the final count, which is what
 * a sale needs (the count it ends on). Returns landing together are the
 * opposite case: each reads the final count and sees a move far above the
 * threshold (10 -> 11 -> 12 read as 11 -> 12 twice), while the first of
 * them loaded the real starting stock. `before` is that loaded value.
 */
export function isStockMoveVisible(
  now: number,
  delta: number,
  before?: number,
): boolean {
  return (
    isStockChangeVisible(now - delta, now) ||
    (before !== undefined && isStockChangeVisible(before, before + delta))
  );
}

/**
 * The stock each row had when its writer loaded it, for the moves that
 * carry it (all lines of one order load it once: the first one counts).
 */
export function loadedStockBefore(
  moves: StockMove[],
): Record<StockMove['kind'], Map<string, number>> {
  const before = {
    product: new Map<string, number>(),
    variant: new Map<string, number>(),
  };
  for (const move of moves) {
    if (move.before != null && !before[move.kind].has(move.id)) {
      before[move.kind].set(move.id, move.before);
    }
  }
  return before;
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
