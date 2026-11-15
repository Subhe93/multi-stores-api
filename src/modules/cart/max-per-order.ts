import { BadRequestException } from '@nestjs/common';

/**
 * Per-order quantity limit of a product (`Product.max_per_order`, headless
 * booking B2). Pure helpers shared by the cart (add/update) and orders
 * (quote/create, which also price Kustom sessions). A limit applies to the
 * units of one own product summed across its variants and personalized
 * lines; custom-product lines (`custom_product_id`) never count towards a
 * product's limit. `null` = unlimited (every product before B2).
 */

export const CART_MAX_PER_ORDER = 'CART_MAX_PER_ORDER';

/** Lowest and highest value the DTOs accept. */
export const MAX_PER_ORDER_MIN = 1;
export const MAX_PER_ORDER_MAX = 9999;

/** The limit of the own product behind a line; null = no limit. */
export interface LineLimit {
  productId: string;
  max: number;
}

/** A positive integer limit, or null (unset / malformed = unlimited). */
export function readMaxPerOrder(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1
    ? raw
    : null;
}

/** The limit of an own product row, or null when it has none. */
export function lineLimitOf(product: {
  id: string;
  max_per_order?: number | null;
}): LineLimit | null {
  const max = readMaxPerOrder(product.max_per_order);
  return max === null ? null : { productId: product.id, max };
}

/** 400 CART_MAX_PER_ORDER with `{ max, product_id }` in params. */
export function maxPerOrderError(
  productId: string,
  max: number,
): BadRequestException {
  return new BadRequestException({
    code: CART_MAX_PER_ORDER,
    message: `You can order at most ${max} of this product per order.`,
    params: { max, product_id: productId },
  });
}

/** Throws CART_MAX_PER_ORDER when `quantity` units exceed `max`. */
export function assertMaxPerOrder(
  productId: string,
  quantity: number,
  max: number | null,
): void {
  if (max !== null && quantity > max) throw maxPerOrderError(productId, max);
}

/**
 * Sums the quantity of every limited line per product and throws for the
 * first product over its limit (lines in order). Lines without a limit are
 * ignored, so a cart without limited products never throws.
 */
export function assertLineLimits(
  lines: readonly { limit: LineLimit | null; quantity: number }[],
): void {
  const totals = new Map<string, { max: number; quantity: number }>();
  for (const line of lines) {
    if (!line.limit) continue;
    const entry = totals.get(line.limit.productId) ?? {
      max: line.limit.max,
      quantity: 0,
    };
    entry.quantity += line.quantity;
    totals.set(line.limit.productId, entry);
  }
  for (const [productId, { max, quantity }] of totals) {
    assertMaxPerOrder(productId, quantity, max);
  }
}

/**
 * Highest quantity a selector may offer: the smaller of stock and the
 * per-order limit (null = no bound from that side), rounded down to a
 * multiple of `step` (bundles). Null when neither bounds it.
 */
export function effectiveMax(
  stock: number | null,
  maxPerOrder: number | null,
  step = 1,
): number | null {
  const bounds = [stock, maxPerOrder].filter(
    (n): n is number => typeof n === 'number' && Number.isFinite(n),
  );
  if (bounds.length === 0) return null;
  const s = Number.isInteger(step) && step > 1 ? step : 1;
  const top = Math.max(0, Math.min(...bounds));
  return Math.floor(top / s) * s;
}
