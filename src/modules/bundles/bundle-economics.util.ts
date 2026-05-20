import { computeBundlePricing, BundleOfferLike } from './bundle-pricing.util';

/**
 * A product that may be linked to a bundle. The check needs to know both the
 * customer-facing unit price (what the customer pays per item before bundle
 * discount) and the provider's base cost (what the platform owes the provider
 * per item). For creator-only products (no provider), providerBasePrice is 0
 * and no check is needed.
 */
export interface ProductForBundleCheck {
  id: string;
  unitPrice: number;
  providerBasePrice: number;
  title?: string;
}

export interface BundleEconomicViolation {
  productId: string;
  productTitle?: string;
  offerIndex: number;
  effectiveUnitPrice: number;
  providerBase: number;
  shortfall: number;
}

export interface BundleEconomicValidationResult {
  valid: boolean;
  violations: BundleEconomicViolation[];
}

/**
 * Verify that every (product, offer) combination produces an effective unit
 * price that still covers the provider's base cost. A negative margin here
 * means the creator would owe more to the provider than what the customer
 * pays — the platform has to either absorb the loss or shortchange the
 * provider. Both are unacceptable, so the bundle must be rejected.
 */
export function validateBundleEconomics(
  offers: BundleOfferLike[],
  products: ProductForBundleCheck[],
): BundleEconomicValidationResult {
  const violations: BundleEconomicViolation[] = [];

  for (const product of products) {
    if (product.providerBasePrice <= 0) continue; // creator-only, no provider cost

    for (let i = 0; i < offers.length; i++) {
      const pricing = computeBundlePricing(product.unitPrice, offers[i]);
      if (pricing.effectiveUnitPrice < product.providerBasePrice) {
        violations.push({
          productId: product.id,
          productTitle: product.title,
          offerIndex: i,
          effectiveUnitPrice: pricing.effectiveUnitPrice,
          providerBase: product.providerBasePrice,
          shortfall: product.providerBasePrice - pricing.effectiveUnitPrice,
        });
      }
    }
  }

  return { valid: violations.length === 0, violations };
}

export function formatViolationsMessage(
  violations: BundleEconomicViolation[],
): string {
  if (violations.length === 0) return '';
  const lines = violations.slice(0, 3).map((v) => {
    const name = v.productTitle || v.productId;
    return `"${name}": offer #${v.offerIndex + 1} would sell at ${v.effectiveUnitPrice.toFixed(2)} but provider cost is ${v.providerBase.toFixed(2)} (shortfall ${v.shortfall.toFixed(2)})`;
  });
  const more = violations.length > 3 ? ` and ${violations.length - 3} more` : '';
  return `Bundle would sell below provider cost: ${lines.join('; ')}${more}`;
}
