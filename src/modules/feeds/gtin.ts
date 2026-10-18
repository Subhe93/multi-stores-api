// GTIN helpers shared by the product DTO/service (write validation) and the
// feed builder. A GTIN is 8, 12, 13 or 14 digits whose last digit is a
// mod-10 check digit (weights 3/1 from the right, as GS1 specifies).

export const GTIN_LENGTHS: readonly number[] = [8, 12, 13, 14];

/** Digits only, surrounding whitespace removed; null for an empty value. */
export function normalizeGtin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s ? s : null;
}

/** True when `value` is a GTIN-8/12/13/14 with a correct check digit. */
export function isValidGtin(value: string): boolean {
  if (!/^\d+$/.test(value) || !GTIN_LENGTHS.includes(value.length)) {
    return false;
  }
  // A GTIN of only zeros is syntactically valid but meaningless.
  if (/^0+$/.test(value)) return false;
  const digits = value.split('').map((d) => Number(d));
  const check = digits.pop() as number;
  let sum = 0;
  // Rightmost payload digit carries weight 3, then 1, 3, 1 ...
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
    sum += digits[i] * w;
  }
  return (10 - (sum % 10)) % 10 === check;
}
