import { currencyDecimals } from './currency.util';

/**
 * Minor-unit tax arithmetic shared by the tax engine (modules/taxes) and the
 * payment mappers. Rates are basis points (2500 = 25 %). Everything here is
 * pure: rate resolution lives in TaxService.
 */

export const MAX_RATE_BP = 10_000;

export function clampRateBp(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_RATE_BP, Math.max(0, Math.trunc(n)));
}

/** Symmetric rounding: the magnitude is rounded, then the sign restored. */
export function roundSymmetric(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/**
 * Tax included in a minor-unit amount at `rateBp`:
 * `amount - amount * 10000 / (10000 + rate)`, rounded to the nearest minor
 * unit. Negative amounts yield negative tax, so a sum of line taxes stays
 * consistent with the tax of the sum. Rounding is symmetric because
 * Math.round(-2.5) is -2 but Math.round(2.5) is 3, which would make the tax
 * of a negative line differ from minus the tax of the same positive amount.
 */
export function includedTaxMinor(amountMinor: number, rateBp: number): number {
  const rate = clampRateBp(rateBp);
  if (rate === 0 || !amountMinor) return 0;
  const raw = amountMinor - (amountMinor * MAX_RATE_BP) / (MAX_RATE_BP + rate);
  return roundSymmetric(raw);
}

/** Tax added on top of a minor-unit net amount at `rateBp`, rounded. */
export function addedTaxMinor(amountMinor: number, rateBp: number): number {
  const rate = clampRateBp(rateBp);
  if (rate === 0 || !amountMinor) return 0;
  return roundSymmetric((amountMinor * rate) / MAX_RATE_BP);
}

/**
 * Same as includedTaxMinor for a major-unit amount: the result is rounded to
 * the currency's minor unit (two decimals for most, whole units for JPY-likes)
 * and returned in major units.
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

/**
 * Split an integer `total` across `weights` proportionally, in integers that
 * sum to exactly `total` (largest-remainder method: floors first, then the
 * leftover units go to the largest fractional parts, earlier index on ties).
 * Used to allocate an order discount across its lines before tax, and by the
 * Kustom mapper to put the very same share on each line. Zero weights (or an
 * all-zero weight list) receive nothing.
 */
export function allocateLargestRemainder(
  total: number,
  weights: number[],
): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  const target = Math.trunc(total);
  if (sum <= 0 || target === 0) return weights.map(() => 0);
  const sign = Math.sign(target);
  const abs = Math.abs(target);
  const exact = weights.map((w) => (Math.max(0, w) * abs) / sum);
  const floors = exact.map((x) => Math.floor(x));
  let leftover = abs - floors.reduce((s, x) => s + x, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - floors[i] }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (leftover <= 0) break;
    if (weights[i] <= 0) continue;
    floors[i] += 1;
    leftover -= 1;
  }
  return floors.map((x) => x * sign);
}
