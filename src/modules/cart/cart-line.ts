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
  /** Designer app (M4.2): the customer design of the line. */
  design_id?: string | null;
  /**
   * Designer app: the guest design token, accepted on input only (cart add /
   * guest migration claims the design, a quote checks it). Never stored:
   * `normalizeCartLine` drops it.
   */
  design_token?: string | null;
  /**
   * Designer app: set only on a stored Kustom session snapshot, on lines
   * whose design ownership the session verified (token / customer) when the
   * lines were stored. `normalizeCartLine` drops it; read it with
   * `verifiedDesignIds`.
   */
  design_verified?: boolean;
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
  /** Designer app (M4.2): present only on designer lines (G0: absent otherwise). */
  design_id?: string | null;
}

export function normalizeCartLine(line: CartLineLike): NormalizedCartLine {
  return {
    product_id: line.product_id || null,
    custom_product_id: line.custom_product_id || null,
    variant_id: line.variant_id || null,
    bundle_offer_id: line.bundle_offer_id || null,
    quantity: Math.max(1, Math.trunc(Number(line.quantity) || 1)),
    custom_fields: line.custom_fields ?? null,
    // The key only exists on designer lines, so every other normalized line
    // (and a stored Kustom snapshot) is exactly what it was before M4.2.
    ...(line.design_id ? { design_id: line.design_id } : {}),
  };
}

/**
 * Designer app: design ids of a stored snapshot (Kustom session `items`)
 * whose ownership was verified when the snapshot was written. Anything
 * else (a raw client line, an unverified line) is never trusted.
 */
export function verifiedDesignIds(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const out = new Set<string>();
  for (const l of items) {
    if (!l || typeof l !== 'object') continue;
    const line = l as { design_id?: unknown; design_verified?: unknown };
    if (line.design_verified === true && typeof line.design_id === 'string') {
      out.add(line.design_id);
    }
  }
  return [...out];
}
