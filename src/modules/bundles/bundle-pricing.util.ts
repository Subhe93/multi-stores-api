import { BundleDiscountType } from '@prisma/client';

export interface BundleOfferLike {
  quantity: number;
  discount_type: BundleDiscountType | 'ITEM' | 'PERCENTAGE' | 'FIXED';
  discount_value: number | string | { toString(): string };
}

export interface BundlePricing {
  effectiveUnitPrice: number;
  cartQuantity: number;
  originalTotal: number;
  finalTotal: number;
}

export function computeBundlePricing(
  baseUnitPrice: number,
  offer: BundleOfferLike,
): BundlePricing {
  const unit = Number(baseUnitPrice) || 0;
  const q = Number(offer.quantity) || 0;
  const d = Number(offer.discount_value) || 0;

  if (q <= 0) {
    return {
      effectiveUnitPrice: unit,
      cartQuantity: 1,
      originalTotal: unit,
      finalTotal: unit,
    };
  }

  if (offer.discount_type === 'PERCENTAGE') {
    const pct = Math.min(100, Math.max(0, d));
    const originalTotal = unit * q;
    const finalTotal = originalTotal * (1 - pct / 100);
    return {
      effectiveUnitPrice: q > 0 ? finalTotal / q : unit,
      cartQuantity: q,
      originalTotal,
      finalTotal,
    };
  }

  if (offer.discount_type === 'FIXED') {
    const originalTotal = unit * q;
    const finalTotal = Math.max(0, originalTotal - d);
    return {
      effectiveUnitPrice: q > 0 ? finalTotal / q : unit,
      cartQuantity: q,
      originalTotal,
      finalTotal,
    };
  }

  // ITEM: buy q, get d free → cart holds (q + d) units, customer pays for q
  const cartQuantity = q + d;
  const finalTotal = unit * q;
  const originalTotal = unit * cartQuantity;
  return {
    effectiveUnitPrice: cartQuantity > 0 ? finalTotal / cartQuantity : unit,
    cartQuantity,
    originalTotal,
    finalTotal,
  };
}
