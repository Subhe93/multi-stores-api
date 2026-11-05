/**
 * Marketplace commission split (MARKETPLACE stores only; independent stores
 * never call this: the creator is the seller and keeps the whole total).
 *
 * The platform is the seller of record, so the order's VAT is the platform's
 * liability and is reserved for it first: it is never part of the provider or
 * creator shares. The split itself works on the NET merchandise revenue
 * (Σ line nets after the discount share = TaxComputeResult.net_items) with
 * the same rules as before:
 *
 *  1. platform = commissionPercent of the net revenue;
 *  2. the provider is never paid less than their floor, base × (1 − %): the
 *     platform commission gives way first if a discount would cut into it;
 *  3. the rest (the payout pool) is split pro-rata between the provider base
 *     and the creator margin, both scaled by the discount factor;
 *  4. the creator receives what remains of the pool.
 *
 * Provider base prices are net (excl. VAT) supply prices: they are compared to
 * net revenue exactly as EXCLUSIVE stores always did, so the provider's share
 * does not depend on whether the store displays prices incl. or excl. VAT.
 *
 * Everything is computed in integer minor units (two decimals, the
 * Decimal(10,2) the ledger stores), so platform + provider + creator equals
 * the net revenue exactly, and with the VAT and the net shipping the parts add
 * up to the order total to the cent. Orders without VAT (EXCLUSIVE stores
 * already split a net subtotal; reverse charge / exempt buyers) get exactly
 * the split they got before.
 */
export interface MarketplaceCommissionInput {
  /** Order subtotal as stored (incl. VAT in INCLUSIVE mode). */
  subtotal: number;
  /** Order discount as stored (same basis as the subtotal). */
  discountAmount: number;
  /**
   * Net merchandise revenue: Σ line nets after the discount share. Equals
   * subtotal − discount when the subtotal carries no VAT.
   */
  netItems: number;
  /** Σ provider base (net) of every provider line. */
  providerBaseTotal: number;
  /** Platform commission in percent (e.g. 15). */
  commissionPercent: number;
}

export interface MarketplaceCommissionSplit {
  platformAmount: number;
  providerAmount: number;
  creatorAmount: number;
}

const toMinor = (major: number) =>
  Math.round((Number(major) || 0) * 100 + Number.EPSILON);
const toMajor = (minor: number) => minor / 100;

export function computeMarketplaceCommission(
  input: MarketplaceCommissionInput,
): MarketplaceCommissionSplit {
  const rate = (Number(input.commissionPercent) || 0) / 100;
  const subtotal = toMinor(input.subtotal);
  const discount = toMinor(input.discountAmount);
  const base = toMinor(input.providerBaseTotal);
  const grossRevenue = subtotal - discount;
  // Net revenue never exceeds what was collected for the goods.
  const commissionBase = Math.max(
    0,
    Math.min(toMinor(input.netItems), Math.max(0, grossRevenue)),
  );

  // Gross -> net factor of the merchandise; it turns the subtotal into its
  // net equivalent so the discount factor and the creator margin are net too.
  const netFactor = grossRevenue > 0 ? commissionBase / grossRevenue : 1;
  const subtotalNet = subtotal * netFactor;

  let platform = Math.round(commissionBase * rate);

  // A coupon is offered by the creator (or the platform) — the provider never
  // agreed to it, so it must not come out of their share. The floor is what
  // the provider would have received on an undiscounted order (base minus the
  // platform's percentage); anything the discount takes is absorbed by the
  // creator's margin first, then by the platform's commission.
  const providerFloor = Math.round(base * (1 - rate));
  if (platform > commissionBase - providerFloor) {
    platform = Math.max(0, commissionBase - providerFloor);
  }

  const discountFactor = subtotalNet > 0 ? commissionBase / subtotalNet : 1;
  const payoutPool = commissionBase - platform;

  // Distribute the pool pro-rata between provider base and creator margin.
  const scaledProviderBase = base * discountFactor;
  const scaledCreatorMargin = (subtotalNet - base) * discountFactor;
  const totalScaled = scaledProviderBase + scaledCreatorMargin;

  let provider = 0;
  let creator = 0;
  if (totalScaled > 0 && payoutPool > 0) {
    provider = Math.round((payoutPool * scaledProviderBase) / totalScaled);
    // Never below the provider's floor, never above what was collected.
    if (provider < providerFloor) provider = providerFloor;
    if (provider > payoutPool) provider = payoutPool;
    creator = Math.max(0, payoutPool - provider);
  }

  return {
    platformAmount: toMajor(platform),
    providerAmount: toMajor(provider),
    creatorAmount: toMajor(creator),
  };
}

/**
 * Coupon guard of a marketplace order: a coupon is refused only when it
 * actually reduces the merchandise revenue (discount > 0) AND the net revenue
 * after it falls below what the provider is owed. The reference is the lower
 * of the provider base and the net revenue without the coupon (a cart that
 * is already under its base is judged by its own net revenue, which any real
 * discount lowers further). Free-shipping and zero-amount coupons always pass.
 */
export function couponBreaksProviderFloor(input: {
  discountAmount: number;
  /** Net merchandise revenue with the coupon (TaxComputeResult.net_items). */
  netItemsAfter: number;
  /** Net merchandise revenue of the same cart without the coupon. */
  netItemsBefore: number;
  providerBaseTotal: number;
}): boolean {
  if (toMinor(input.discountAmount) <= 0) return false;
  const floor = Math.min(
    toMinor(input.providerBaseTotal),
    toMinor(input.netItemsBefore),
  );
  return toMinor(input.netItemsAfter) < floor;
}
