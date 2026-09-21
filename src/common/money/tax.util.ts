import { currencyDecimals } from './currency.util';

/**
 * VAT is platform-wide and prices are always tax inclusive: the rate never
 * changes what the customer pays, it only says how much of an amount is tax.
 * Rates are basis points (2500 = 25 %). A store may override the platform
 * default; null on the store means "inherit".
 */

const MAX_RATE_BP = 10_000;

function clampRate(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_RATE_BP, Math.max(0, Math.trunc(n)));
}

/** The single place a store's effective VAT rate is decided. */
export function resolveStoreTaxRateBp(
  store: { tax_rate_bp?: number | null } | null | undefined,
  platformConfig: { default_tax_rate_bp?: number | null } | null | undefined,
): number {
  return (
    clampRate(store?.tax_rate_bp) ??
    clampRate(platformConfig?.default_tax_rate_bp) ??
    0
  );
}

/**
 * Tax included in a minor-unit amount at `rateBp`:
 * `amount - amount * 10000 / (10000 + rate)`, rounded to the nearest minor
 * unit. Negative amounts (discount lines) yield negative tax, so a sum of
 * line taxes stays consistent with the tax of the sum.
 */
export function includedTaxMinor(amountMinor: number, rateBp: number): number {
  const rate = clampRate(rateBp) ?? 0;
  if (rate === 0 || !amountMinor) return 0;
  const raw = amountMinor - (amountMinor * MAX_RATE_BP) / (MAX_RATE_BP + rate);
  // Symmetric rounding: Math.round(-2.5) is -2 but Math.round(2.5) is 3, which
  // would make the tax of a discount line differ from minus the tax of the
  // same positive amount. Round the magnitude, then restore the sign.
  return Math.sign(raw) * Math.round(Math.abs(raw));
}

/** The money parts of an order that carry tax, in major units. */
export interface TaxedOrderParts {
  items: { total_price: unknown }[];
  shipping_cost: unknown;
  discount_amount: unknown;
}

/**
 * Tax included in an order as the sum of its parts — one rounded figure per
 * item line, one for shipping and a negative one for the discount — which is
 * exactly how the Kustom mapper stamps its order lines (see
 * buildKustomOrderLines / sumKustomTax). Order.tax_amount is computed with
 * this so it always equals the `order_tax_amount` sent to Kustom; a single
 * rounding of the total could differ from the line sum by a minor unit.
 * Returned in major units, rounded to the currency's minor unit.
 */
export function includedTaxForOrder(
  parts: TaxedOrderParts,
  rateBp: number,
  currency: string,
): number {
  const factor = 10 ** currencyDecimals(currency);
  const minor = (major: unknown) => Math.round(Number(major) * factor);
  let taxMinor = 0;
  for (const item of parts.items) {
    taxMinor += includedTaxMinor(minor(item.total_price), rateBp);
  }
  taxMinor += includedTaxMinor(minor(parts.shipping_cost), rateBp);
  taxMinor += includedTaxMinor(-minor(parts.discount_amount), rateBp);
  return taxMinor / factor;
}

/**
 * Same as includedTaxMinor for a major-unit amount: the result is rounded to
 * the currency's minor unit (two decimals for most, whole units for JPY-likes)
 * and returned in major units — the value that goes into Order.tax_amount.
 */
export function includedTax(
  amountMajor: number,
  rateBp: number,
  currency: string,
): number {
  const factor = 10 ** currencyDecimals(currency);
  const minor = Math.round(Number(amountMajor) * factor);
  return includedTaxMinor(minor, rateBp) / factor;
}
