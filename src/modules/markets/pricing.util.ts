import { currencyDecimals, roundMoney } from '../../common/money/currency.util';
import type { PriceRounding } from './market.types';

/**
 * Pure price math of the markets app: base (store currency) → market
 * currency, with the market's rounding rule. Every function is total: a
 * non-finite input yields 0, and a missing rate yields null ("cannot be
 * priced automatically", the product is then hidden in that market).
 */

export interface PricingContext {
  currency: string;
  rate: number | null;
  rounding?: PriceRounding;
}

export function convertAmount(amountBase: number, rate: number): number {
  const a = Number(amountBase);
  const r = Number(rate);
  if (!Number.isFinite(a) || !Number.isFinite(r) || r <= 0) return 0;
  return a * r;
}

/**
 * Round a converted amount to a "nice" price: first to a multiple of
 * `increment`, then to the chosen ending. Decimal endings ('.99', '.90',
 * '.95') move to the nearest value with that fraction; '9' to the nearest
 * whole number ending in 9; '0' to the nearest multiple of 10. Zero-decimal
 * currencies ignore the decimal endings. Always ends with roundMoney().
 */
export function applyRounding(
  amount: number,
  rounding: PriceRounding | null | undefined,
  currency: string,
): number {
  let value = Number(amount);
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return roundMoney(value, currency);
  const increment = Number(rounding?.increment);
  if (Number.isFinite(increment) && increment > 0) {
    value = Math.round(value / increment) * increment;
  }
  const ending = rounding?.ending ?? 'none';
  const zeroDecimal = currencyDecimals(currency) === 0;
  switch (ending) {
    case '.99':
    case '.90':
    case '.95': {
      if (zeroDecimal) break;
      const fraction = Number(ending);
      const base = Math.floor(value);
      value = nearest(
        value,
        [base - 1 + fraction, base + fraction, base + 1 + fraction].filter(
          (c) => c > 0,
        ),
      );
      break;
    }
    case '9': {
      const k = Math.round((value - 9) / 10);
      value = Math.max(9, k * 10 + 9);
      break;
    }
    case '0': {
      value = Math.max(10, Math.round(value / 10) * 10);
      break;
    }
    default:
      break;
  }
  return roundMoney(value, currency);
}

/** The candidate closest to `value`; ties go to the higher one. */
function nearest(value: number, candidates: number[]): number {
  let best = candidates[0];
  for (const c of candidates) {
    const d = Math.abs(c - value);
    const bd = Math.abs(best - value);
    if (d < bd || (d === bd && c > best)) best = c;
  }
  return best;
}

/**
 * A product's price in the market: the manual override when set, else the
 * converted and rounded base price, else null when there is no rate.
 */
export function resolveMarketPrice(input: {
  basePrice: number;
  override: number | null | undefined;
  ctx: PricingContext;
}): number | null {
  const { basePrice, override, ctx } = input;
  if (override != null && Number.isFinite(Number(override))) {
    return roundMoney(Number(override), ctx.currency);
  }
  if (ctx.rate == null) return null;
  return applyRounding(
    convertAmount(basePrice, ctx.rate),
    ctx.rounding,
    ctx.currency,
  );
}

/**
 * A variant's price in the market. A variant override wins; a product
 * override is kept and the variant's base-currency adjustment is converted
 * on top of it (no price-ending rounding, the override is the creator's
 * number); otherwise the whole variant price is converted like a product.
 */
export function resolveVariantMarketPrice(input: {
  basePrice: number;
  adjustment: number;
  productOverride: number | null | undefined;
  variantOverride: number | null | undefined;
  ctx: PricingContext;
}): number | null {
  const { basePrice, adjustment, productOverride, variantOverride, ctx } =
    input;
  if (variantOverride != null && Number.isFinite(Number(variantOverride))) {
    return roundMoney(Number(variantOverride), ctx.currency);
  }
  if (productOverride != null && Number.isFinite(Number(productOverride))) {
    const adj = Number(adjustment) || 0;
    if (adj === 0) return roundMoney(Number(productOverride), ctx.currency);
    if (ctx.rate == null) return null;
    return roundMoney(
      Number(productOverride) + convertAmount(adj, ctx.rate),
      ctx.currency,
    );
  }
  return resolveMarketPrice({
    basePrice: Number(basePrice) + (Number(adjustment) || 0),
    override: null,
    ctx,
  });
}
