/**
 * Markets app: the money amounts of a product page's promotions and bundle
 * offers are stored in the base currency. A market page shows (and the web
 * bundle math subtracts) them in the market currency, so FIXED amounts are
 * converted with the same `convert` the cart and orders use. Percentages,
 * free-item counts and free shipping are currency-free and stay as stored.
 *
 * `convert` returns null when the market cannot convert base amounts (no
 * rate): such an offer cannot be honoured in the market and is dropped,
 * like the cart refuses to price it.
 */

type Convert = (amountBase: number) => number | null;

interface PromotionLike {
  type: string;
  value: number;
  conditions: unknown;
}

interface BundleOfferLike {
  discount_type: string;
  discount_value: unknown;
}

interface BundleLike {
  offers: BundleOfferLike[];
}

/** Promotion types whose `value` is an amount in the base currency. */
const AMOUNT_PROMOTION_TYPES = new Set(['FIXED_AMOUNT']);

export function marketizePromotions<T extends PromotionLike>(
  promotions: T[],
  convert: Convert,
): T[] {
  const out: T[] = [];
  for (const p of promotions) {
    let value = p.value;
    if (AMOUNT_PROMOTION_TYPES.has(p.type)) {
      const converted = convert(Number(p.value));
      if (converted == null) continue;
      value = converted;
    }
    let conditions = p.conditions;
    const minAmount = readMinAmount(p.conditions);
    if (minAmount != null) {
      const converted = convert(minAmount);
      if (converted == null) continue;
      conditions = {
        ...(p.conditions as Record<string, unknown>),
        min_amount: converted,
      };
    }
    out.push({ ...p, value, conditions });
  }
  return out;
}

export function marketizeBundles<T extends BundleLike>(
  bundles: T[],
  convert: Convert,
): T[] {
  return bundles.map((b) => ({
    ...b,
    offers: b.offers.flatMap((o) => {
      if (o.discount_type !== 'FIXED') return [o];
      const converted = convert(Number(o.discount_value));
      return converted == null ? [] : [{ ...o, discount_value: converted }];
    }),
  }));
}

function readMinAmount(conditions: unknown): number | null {
  if (!conditions || typeof conditions !== 'object') return null;
  const raw = (conditions as { min_amount?: unknown }).min_amount;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
