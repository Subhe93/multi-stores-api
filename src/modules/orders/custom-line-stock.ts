/**
 * Stock of imported (resold) products: a creator's CustomProduct sells a
 * provider's base product, so its order line takes the provider's stock at
 * sale and gives it back on failure, release, refund or trash, exactly like
 * an own product line.
 *
 * Orders placed before this existed took nothing for such lines, yet the
 * old restore paths wrote the line's base variant (or a client-sent
 * product_id) on every failure, release, refund and trash: provider stock
 * grew by units that were never taken. Nothing in the schema says whether a
 * line took stock, so one cut-over moment decides both sides:
 *
 * - `CUSTOM_LINE_STOCK_SINCE` (an ISO-8601 instant with an explicit zone,
 *   e.g. `2026-11-20T03:10:00Z`) is compared with `Order.created_at`.
 *   create() writes `created_at` from the same clock that decided whether
 *   the line took stock, so the stored moment and the decision agree.
 * - Unset (or invalid): OFF. Resale lines neither take nor return stock, so
 *   the inflation stops at once. Own lines are never affected.
 *
 * Edge cases (intended):
 * - An order created before `since` (or while it was unset) never returns
 *   resale stock and never re-takes it on a late payment or a reverted
 *   refund. Residual: an old order whose failure was handled by the OLD code
 *   (stock inflated by q) and that is paid after the deploy is not re-taken,
 *   so those q units stay.
 * - Set the variable only after EVERY API instance runs this build. An old
 *   instance creating orders after `since` would make orders that later
 *   return stock they never took. Once set, never move or remove it: a later
 *   or removed value would stop the return of stock taken in between.
 * - A row untracked at sale but tracked at return gets units it never gave
 *   (tracking is read at return time; the same holds for own products).
 * - Variant deleted after the sale (variant_id SET NULL, the option
 *   snapshot remains): nothing is returned, for own lines too (they used to
 *   fall back to product-level stock they never took).
 * - CustomProduct deleted after the sale (custom_product_id SET NULL): a
 *   variant line on a provider product is still recognised as resale (its
 *   product has no creator); a variantless line has no known base and
 *   returns nothing (conservative). A creator-only base product (creator_id
 *   set) whose CustomProduct was deleted reads as an own line, so an OLD
 *   order of that kind still returns its units. Rare; accepted.
 * - Two stores reselling one base product share its stock row; the
 *   conditional decrement of create() is race-safe (the second buyer of the
 *   last unit gets ORDER_INSUFFICIENT_STOCK). Unpaid checkouts hold provider
 *   stock until the abandonment sweep releases them, like own products.
 */

export const CUSTOM_LINE_STOCK_ENV = 'CUSTOM_LINE_STOCK_SINCE';

const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** The cut-over instant, or null (feature off) for anything not exact. */
export function parseCustomLineStockSince(
  raw: string | undefined | null,
): Date | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!ISO_INSTANT.test(value)) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Whether a resale line of an order placed at `at` holds stock. */
export function customLineHoldsStock(
  at: Date | null | undefined,
  since: Date | null,
): boolean {
  if (since === null || !at) return false;
  return at.getTime() >= since.getTime();
}

export type StockTarget = { kind: 'product' | 'variant'; id: string };

/** What an order line row tells about where its stock went. */
export type StockLine = {
  variant_id: string | null;
  product_id: string | null;
  custom_product_id?: string | null;
  variant_options_snapshot?: unknown;
  custom_product?: { product_id: string } | null;
  variant?: { product?: { creator_id?: string | null } | null } | null;
  product?: { creator_id?: string | null } | null;
};

/**
 * The row whose stock this line took at sale (and so must get back), or
 * null when it took none. Rules, in order:
 * 1. Resale line: a custom_product_id, or a variant / product without a
 *    creator (a provider product). Own lines always belong to the store
 *    creator (priceLine enforces it), so a creator-less product behind a
 *    line means resale, also after its CustomProduct was deleted.
 * 2. Resale line of an order before the cut-over: null (nothing taken).
 * 3. A variant: that variant.
 * 4. No variant but an option snapshot (the sold variant was deleted):
 *    null, own lines included.
 * 5. Resale: the CustomProduct's base product (never the line's own
 *    product_id, which a client could have chosen), else null.
 * 6. Own: the line's product, else null.
 * A tracked check stays with the writers (stock not null, track_inventory
 * for products), so untracked rows are never written.
 */
export function lineStockTarget(
  line: StockLine,
  orderCreatedAt: Date | null | undefined,
  since: Date | null,
): StockTarget | null {
  const resale =
    !!line.custom_product_id ||
    (line.variant_id != null && line.variant?.product?.creator_id === null) ||
    (line.variant_id == null &&
      line.product_id != null &&
      line.product?.creator_id === null);
  if (resale && !customLineHoldsStock(orderCreatedAt, since)) return null;
  if (line.variant_id != null) return { kind: 'variant', id: line.variant_id };
  if (line.variant_options_snapshot != null) return null;
  if (resale) {
    const base = line.custom_product?.product_id;
    return base ? { kind: 'product', id: base } : null;
  }
  return line.product_id ? { kind: 'product', id: line.product_id } : null;
}
