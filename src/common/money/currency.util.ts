/**
 * Currency helpers shared by the order, payment and mail paths.
 *
 * Two separate concerns live here:
 *  - which currency an order is priced in (per-store, falling back to platform), and
 *  - how an amount converts to the integer Stripe expects, which depends on how
 *    many minor units the currency actually has.
 */

/**
 * Currencies Stripe accepts that have NO minor unit — an "amount" is already
 * the whole unit, so the usual ×100 would overcharge by 100×.
 * https://docs.stripe.com/currencies#zero-decimal
 */
const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

/**
 * Currencies Stripe charges in the major unit even though they have minor
 * units — the amount must be a multiple of 100.
 * https://docs.stripe.com/currencies#special-cases
 */
const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

/** Currencies a store may be priced in. Kept explicit so a typo can't reach Stripe. */
export const SUPPORTED_CURRENCIES = [
  'AED', 'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EGP',
  'EUR', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW',
  'MAD', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'QAR', 'RON', 'SAR',
  'SEK', 'SGD', 'THB', 'TRY', 'TWD', 'USD', 'ZAR',
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export function isSupportedCurrency(code: string | null | undefined): boolean {
  if (!code) return false;
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(code.toUpperCase());
}

/** How many minor units this currency has (2 for most, 0 for JPY-likes). */
export function currencyDecimals(currency: string): number {
  const c = currency.toLowerCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  // Three-decimal currencies must still be sent rounded to the hundred, so for
  // amount conversion they behave like two-decimal ones.
  if (THREE_DECIMAL.has(c)) return 2;
  return 2;
}

/**
 * Convert a decimal amount to the integer Stripe expects. For a zero-decimal
 * currency that is the amount itself; for three-decimal currencies Stripe
 * requires the smallest unit to be a multiple of 100.
 */
export function toStripeAmount(amount: number, currency: string): number {
  const c = currency.toLowerCase();
  if (ZERO_DECIMAL.has(c)) return Math.round(amount);
  const cents = Math.round(amount * 100);
  if (THREE_DECIMAL.has(c)) return Math.round(cents / 100) * 100;
  return cents;
}

/** Inverse of toStripeAmount — turns a Stripe integer back into a decimal amount. */
export function fromStripeAmount(amount: number, currency: string): number {
  const c = currency.toLowerCase();
  if (ZERO_DECIMAL.has(c)) return amount;
  return amount / 100;
}

/**
 * The currency an order placed through this store is priced in. Only
 * INDEPENDENT stores may carry their own — a marketplace order is charged on
 * the platform account and split with transfers, so it stays on the platform
 * currency even if a stale value is sitting on the row.
 */
export function resolveStoreCurrency(
  store: { store_type?: string | null; currency?: string | null } | null | undefined,
  platformDefault: string | null | undefined,
): string {
  const fallback = (platformDefault || 'EUR').toUpperCase();
  if (!store || store.store_type !== 'INDEPENDENT') return fallback;
  if (!isSupportedCurrency(store.currency)) return fallback;
  return store.currency!.toUpperCase();
}
