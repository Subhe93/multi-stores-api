import { BadRequestException } from '@nestjs/common';
import { couponBreaksProviderFloor } from '../orders/marketplace-commission';

/**
 * Provider-cost floor of a coupon (MARKETPLACE stores only).
 *
 * ONE rule shared by the order path (OrdersService.computeTotals), the cart's
 * validate-coupon and the product-page coupon preview, so the banner and the
 * cart can never show a discount the order then refuses.
 *
 * A coupon breaks the floor when the store is not INDEPENDENT, the coupon
 * actually lowers the merchandise revenue (discount > 0), and the net
 * merchandise revenue after it (net of VAT: marketplace VAT is the
 * platform's) falls below what the providers are owed — the lower of their
 * base total and the net revenue without the coupon (couponBreaksProviderFloor).
 *
 * Error contract: the order path and validate-coupon reject with a 400
 * `ORDER_DISCOUNT_BELOW_PROVIDER_COST` (the existing order code, so one
 * storefront translation covers both). The coupon preview never throws for
 * it: it answers `applies: false, below_cost: true, discount_amount: null`.
 */
export const COUPON_BELOW_PROVIDER_COST = 'ORDER_DISCOUNT_BELOW_PROVIDER_COST';

export function couponBelowProviderCostError(): BadRequestException {
  return new BadRequestException({
    code: COUPON_BELOW_PROVIDER_COST,
    message:
      'This coupon cannot be applied to the items in your cart. Please remove it and try again.',
  });
}

export async function couponBelowProviderCost(input: {
  /** store_type === INDEPENDENT: the floor never applies. */
  independent: boolean;
  /** The coupon's discount on the order (same basis as the subtotal). */
  discountAmount: number;
  /** Σ provider base of the cart's provider lines (net, capped per line). */
  providerBaseTotal: number;
  /** Net merchandise revenue with the coupon (TaxComputeResult.net_items). */
  netItemsAfter: number;
  /**
   * Net merchandise revenue of the same cart without the coupon. Lazy: it
   * is only computed when the cheap pre-check cannot decide.
   */
  netItemsBefore: () => number | Promise<number>;
}): Promise<boolean> {
  if (input.independent || !(input.discountAmount > 0)) return false;
  // Cheap pre-check: revenue still at or above the base never breaks it.
  if (
    Math.round(input.netItemsAfter * 100) >=
    Math.round(input.providerBaseTotal * 100)
  ) {
    return false;
  }
  return couponBreaksProviderFloor({
    discountAmount: input.discountAmount,
    netItemsAfter: input.netItemsAfter,
    netItemsBefore: await input.netItemsBefore(),
    providerBaseTotal: input.providerBaseTotal,
  });
}
