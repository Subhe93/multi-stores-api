/**
 * Stripe payment routes (plans/stripe-restricted-keys/SPEC.md):
 * - OWN_KEY: INDEPENDENT store charging on the owner's own Stripe account
 *   through a restricted key (no Connect, no platform account involved).
 * - CONNECT_DIRECT: legacy INDEPENDENT store charging directly on the
 *   creator's Standard connected account.
 * - PLATFORM: MARKETPLACE store (separate charges and transfers).
 * Pure helpers only, so every caller (and the specs) share one rule.
 */
import { StoreType } from '@prisma/client';

export const PAYMENT_ROUTES = [
  'PLATFORM',
  'CONNECT_DIRECT',
  'OWN_KEY',
] as const;
export type PaymentRoute = (typeof PAYMENT_ROUTES)[number];

/** Resolve the route for a NEW payment: OWN_KEY > CONNECT_DIRECT > PLATFORM. */
export function resolvePaymentRoute(input: {
  storeType: StoreType | string | null | undefined;
  ownKeyActive: boolean;
}): PaymentRoute {
  if (input.storeType !== StoreType.INDEPENDENT) return 'PLATFORM';
  return input.ownKeyActive ? 'OWN_KEY' : 'CONNECT_DIRECT';
}

/**
 * Route of an existing order. `payment_route` is set when the PaymentIntent
 * is created; older orders keep null and follow the legacy rule (a
 * connected-account snapshot means a direct charge, else the platform).
 */
export function routeOfOrder(order: {
  payment_route?: string | null;
  stripe_account_id?: string | null;
}): PaymentRoute {
  const r = order.payment_route;
  if (r && (PAYMENT_ROUTES as readonly string[]).includes(r)) {
    return r as PaymentRoute;
  }
  return order.stripe_account_id ? 'CONNECT_DIRECT' : 'PLATFORM';
}

/** Status value of an active own key (StoreStripeKeys.status). */
export const OWN_KEY_ACTIVE_STATUS = 'ACTIVE';

/**
 * Readiness helper for code that reads the store row directly (storefront,
 * lifecycle, market payment check): an INDEPENDENT store whose own key row
 * is ACTIVE can take card payments. A TEST-mode key never counts for the
 * public checkout; it only does for the owner / an admin previewing the
 * store (`allowTest`), so a live store cannot take fake test payments.
 */
export function isOwnKeyCardReady(
  store: {
    store_type: StoreType | string | null | undefined;
    stripe_keys?: { status: string; livemode?: boolean | null } | null;
  },
  opts: { allowTest?: boolean } = {},
): boolean {
  return (
    store.store_type === StoreType.INDEPENDENT &&
    store.stripe_keys?.status === OWN_KEY_ACTIVE_STATUS &&
    (store.stripe_keys.livemode === true || opts.allowTest === true)
  );
}

/** An ACTIVE own key that is in TEST mode (owner preview only). */
export function isOwnKeyTestMode(store: {
  store_type: StoreType | string | null | undefined;
  stripe_keys?: { status: string; livemode?: boolean | null } | null;
}): boolean {
  return (
    store.store_type === StoreType.INDEPENDENT &&
    store.stripe_keys?.status === OWN_KEY_ACTIVE_STATUS &&
    store.stripe_keys.livemode === false
  );
}

/** True for a Stripe 401 (invalid, expired or revoked key). */
export function isStripeAuthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { statusCode?: number; type?: string; rawType?: string };
  return (
    e.statusCode === 401 ||
    e.type === 'StripeAuthenticationError' ||
    e.rawType === 'authentication_error'
  );
}

/** Strip anything that looks like a Stripe secret from a message. */
export function redactStripeSecrets(message: string): string {
  return message.replace(
    /\b(sk|rk|whsec)_(live_|test_)?[A-Za-z0-9]+/g,
    '$1_***',
  );
}
