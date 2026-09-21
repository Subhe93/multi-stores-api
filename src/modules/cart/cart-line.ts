/**
 * One line of a purchase, in the exact shape `POST /cart/items` accepts. It is
 * what a CartItem row carries minus the row bookkeeping, and what a Kustom
 * checkout session snapshots so an order can be priced without a server cart.
 */
export interface CartLine {
  product_id?: string | null;
  custom_product_id?: string | null;
  variant_id?: string | null;
  bundle_offer_id?: string | null;
  quantity: number;
  custom_fields?: Record<string, unknown> | null;
}

/**
 * Anything that can be normalised into a line: a CartLine, a CartItem row
 * (whose custom_fields is an arbitrary JSON value) or a stored snapshot.
 */
export type CartLineLike = Omit<CartLine, 'custom_fields'> & {
  custom_fields?: unknown;
};

/**
 * A line as the order pricing loop consumes it: every id present (null when
 * absent) so cart rows and snapshot lines look the same. `id` is only set for
 * real cart rows (it keys per-item customisations in CreateOrderDto).
 */
export interface NormalizedCartLine {
  id?: string;
  product_id: string | null;
  custom_product_id: string | null;
  variant_id: string | null;
  bundle_offer_id: string | null;
  quantity: number;
  custom_fields: unknown;
}

export function normalizeCartLine(line: CartLineLike): NormalizedCartLine {
  return {
    product_id: line.product_id || null,
    custom_product_id: line.custom_product_id || null,
    variant_id: line.variant_id || null,
    bundle_offer_id: line.bundle_offer_id || null,
    quantity: Math.max(1, Math.trunc(Number(line.quantity) || 1)),
    custom_fields: line.custom_fields ?? null,
  };
}
