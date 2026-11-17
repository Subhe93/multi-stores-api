import type { Prisma } from '@prisma/client';

/**
 * Products that need no shipping (services / digital products), the way
 * Shopify does it with the "Physical product" setting. This file is the ONLY
 * place that turns a `requires_shipping` value into a decision: no other
 * file reads `product.requires_shipping`, `item.requires_shipping` or
 * `order.requires_shipping` to branch (copying the value into a payload is
 * fine).
 *
 * One rule everywhere: only the literal `false` switches shipping off. A
 * missing, `null` or `true` value means "requires shipping", so old rows,
 * mocked objects and cached payloads keep today's behaviour.
 *
 * Pure: no Nest imports, no I/O.
 */

export interface ShippingFlagSource {
  requires_shipping?: boolean | null;
}

/**
 * Live decision for a cart / quote line. `variant` is reserved for the later
 * per-variant override (a nullable `ProductVariant.requires_shipping`): the
 * variant's value when it is a boolean, else the product's.
 *
 * When that column is added: the order quote, the cart and the order
 * snapshot already decide per line (the order quote tells the shipping
 * service so with `lines_prefiltered`). Two public routes still decide per
 * product, `POST /shipping/estimate` and `POST /shipping/countries` (they
 * receive product ids only), and need the variant ids to stay exact.
 */
export function lineRequiresShipping(
  product: ShippingFlagSource | null | undefined,
  variant?: ShippingFlagSource | null,
): boolean {
  const own = variant?.requires_shipping;
  if (own === true || own === false) return own;
  return product?.requires_shipping !== false;
}

/**
 * A cart / quote requires shipping when any line does. An empty list
 * requires shipping (nothing is known, so nothing changes).
 */
export function cartRequiresShipping(lines: readonly boolean[]): boolean {
  if (lines.length === 0) return true;
  return lines.some((requires) => requires);
}

/** Snapshot reader: an order line as sold (`OrderItem.requires_shipping`). */
export function orderLineRequiresShipping(
  item: ShippingFlagSource | null | undefined,
): boolean {
  return item?.requires_shipping !== false;
}

/** Snapshot reader: an order as placed (`Order.requires_shipping`). */
export function orderRequiresShipping(
  order: ShippingFlagSource | null | undefined,
): boolean {
  return order?.requires_shipping !== false;
}

/**
 * Whether the shipped hooks are due on a status change that reaches
 * DELIVERED without having passed SHIPPED. Only for an order that requires
 * no shipping: its fulfilment IS its "shipment" (so a capture-on-shipment
 * payment is still captured). An order that requires shipping keeps today's
 * rule: DELIVERED without SHIPPED runs no shipped hook.
 */
export function fulfilmentRunsShippedHooks(input: {
  requiresShipping: boolean;
  /** Rank of the status the order leaves. */
  fromRank: number;
  /** Rank of SHIPPED on the same scale. */
  shippedRank: number;
  /** The status the order moves to. */
  to: string;
}): boolean {
  if (input.requiresShipping) return false;
  if (input.to !== 'DELIVERED') return false;
  return input.fromRank < input.shippedRank;
}

/** The one product column the live decision reads. */
export const PRODUCT_SHIPPING_SELECT = {
  requires_shipping: true,
} satisfies Prisma.ProductSelect;
