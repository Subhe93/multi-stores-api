import { BadRequestException } from '@nestjs/common';
import {
  MARKET_PAYMENT_METHODS,
  type MarketPaymentMethod,
  type PaymentCheck,
} from './market.types';

// M157: optional payment methods per market. Pure helpers (no I/O): write
// validation with coded errors, fail-closed parsing of the stored JSON, the
// one allow rule every enforcement point uses, and the go-live gate.

export { MARKET_PAYMENT_METHODS, type MarketPaymentMethod };

export const MARKET_PAYMENT_METHODS_INVALID = 'MARKET_PAYMENT_METHODS_INVALID';
export const MARKET_PAYMENT_METHODS_NOT_READY =
  'MARKET_PAYMENT_METHODS_NOT_READY';
export const MARKET_PAYMENT_METHOD_NOT_ALLOWED =
  'MARKET_PAYMENT_METHOD_NOT_ALLOWED';

export type MarketPaymentMethodsInvalidReason =
  | 'unknown'
  | 'duplicate'
  | 'empty';

function isMethod(value: unknown): value is MarketPaymentMethod {
  return (
    typeof value === 'string' &&
    (MARKET_PAYMENT_METHODS as readonly string[]).includes(value)
  );
}

function sorted(methods: Iterable<MarketPaymentMethod>): MarketPaymentMethod[] {
  const set = new Set(methods);
  return MARKET_PAYMENT_METHODS.filter((m) => set.has(m));
}

function invalid(
  reason: MarketPaymentMethodsInvalidReason,
  message: string,
  value?: string,
): BadRequestException {
  return new BadRequestException({
    code: MARKET_PAYMENT_METHODS_INVALID,
    message,
    reason,
    ...(value !== undefined ? { value } : {}),
  });
}

/**
 * Write path. null = clear (the store's methods). Otherwise every entry must
 * be a known method (after trim + lower case), without duplicates, and the
 * list must not be empty: `[]` is NOT a synonym for null (a market with no
 * method would sell nothing). Output is sorted in MARKET_PAYMENT_METHODS
 * order so equal sets store equal JSON.
 */
export function normalizePaymentMethods(
  input: readonly unknown[] | null,
): MarketPaymentMethod[] | null {
  if (input === null) return null;
  const seen = new Set<MarketPaymentMethod>();
  let duplicate = false;
  for (const raw of input) {
    // Only a string can name a method: a non-string entry is unknown even
    // when its String() form would match (e.g. [['card']]).
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : null;
    if (!isMethod(value)) {
      throw invalid(
        'unknown',
        `Unknown payment method "${String(raw)}". Use card, kustom or cod.`,
        String(raw),
      );
    }
    if (seen.has(value)) duplicate = true;
    seen.add(value);
  }
  if (duplicate) {
    throw invalid('duplicate', 'Each payment method can be chosen once.');
  }
  if (seen.size === 0) {
    throw invalid(
      'empty',
      'Choose at least one payment method, or use the store payment methods.',
    );
  }
  return sorted(seen);
}

/**
 * Read path (DB JSON → context/view). SQL NULL (or undefined) → null
 * (unrestricted). A non-null value is FAIL-CLOSED: not an array → [];
 * unknown entries are dropped; duplicates removed; result sorted. `[]`
 * therefore means "nothing allowed" (only reachable through bad data).
 */
export function parsePaymentMethods(
  raw: unknown,
): MarketPaymentMethod[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return [];
  return sorted(raw.filter(isMethod));
}

/** The one rule. No market, or a market without the setting → true. */
export function marketAllowsMethod(
  market:
    | { paymentMethods?: readonly MarketPaymentMethod[] | null }
    | null
    | undefined,
  method: MarketPaymentMethod,
): boolean {
  if (!market || market.paymentMethods == null) return true;
  return market.paymentMethods.includes(method);
}

/** The coded 400 every enforcement point throws. */
export function marketPaymentMethodNotAllowed(
  method: MarketPaymentMethod,
): BadRequestException {
  return new BadRequestException({
    code: MARKET_PAYMENT_METHOD_NOT_ALLOWED,
    message:
      'This payment method is not available here. Please choose another one.',
    method,
  });
}

/**
 * The LIVE gate. Unrestricted (null): at least one provider can charge the
 * market currency (as before). Restricted: at least one ALLOWED provider
 * can. COD never satisfies the gate, so `['cod']` alone never goes LIVE.
 */
export function paymentCheckPassesFor(
  check: PaymentCheck | null | undefined,
  methods: readonly MarketPaymentMethod[] | null | undefined,
): boolean {
  const stripeOk = check?.stripe === 'ok';
  const kustomOk = check?.kustom === 'ok';
  if (methods == null) return stripeOk || kustomOk;
  return (
    (methods.includes('card') && stripeOk) ||
    (methods.includes('kustom') && kustomOk)
  );
}

/** Two stored values describe the same setting (null ≠ any array). */
export function samePaymentMethods(
  a: readonly MarketPaymentMethod[] | null,
  b: readonly MarketPaymentMethod[] | null,
): boolean {
  if (a === null || b === null) return a === b;
  const sa = sorted(a);
  const sb = sorted(b);
  return sa.length === sb.length && sa.every((m, i) => m === sb[i]);
}

/**
 * The market method an order payment method uses. Anything that is not COD
 * or KUSTOM is a card payment (STRIPE), so an unknown value is checked as
 * card rather than let through.
 */
export function paymentMethodOfOrder(
  method: string | null | undefined,
): MarketPaymentMethod {
  if (method === 'COD') return 'cod';
  if (method === 'KUSTOM') return 'kustom';
  return 'card';
}
