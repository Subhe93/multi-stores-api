import { StoreType } from '@prisma/client';

/** The creator columns that decide whether Kustom can be offered. */
export interface KustomCreatorFields {
  kustom_enabled: boolean;
  kustom_merchant_id: string | null;
  kustom_shared_secret: string | null;
}

/**
 * Select fragment for the creator fields above — shared so every eligibility
 * check reads the same columns. The secret is only tested for presence and
 * must never be spread into a response.
 */
export const kustomCreatorSelect = {
  kustom_enabled: true,
  kustom_merchant_id: true,
  kustom_shared_secret: true,
} as const;

/**
 * Currencies Kustom (Klarna) processes. A store priced in anything else must
 * not offer Kustom: the checkout would only fail after the order exists and
 * stock is reserved. Extend when a creator's Kustom contract covers more.
 */
export const KUSTOM_CURRENCIES = new Set([
  'SEK',
  'NOK',
  'DKK',
  'EUR',
  'GBP',
  'USD',
  'CHF',
  'PLN',
  'CZK',
  'HUF',
  'RON',
  'AUD',
  'NZD',
  'CAD',
]);

export function isKustomCurrencySupported(
  currency: string | null | undefined,
): boolean {
  return Boolean(currency) && KUSTOM_CURRENCIES.has(currency!.toUpperCase());
}

/** Whether the creator has a complete, switched-on Kustom configuration. */
export function isKustomCreatorReady(
  creator: KustomCreatorFields | null | undefined,
): boolean {
  return Boolean(
    creator &&
    creator.kustom_enabled &&
    creator.kustom_merchant_id &&
    creator.kustom_shared_secret,
  );
}

/**
 * Kustom is offered only by active INDEPENDENT stores whose creator is ready:
 * the money settles on the creator's own Kustom merchant account, exactly like
 * Stripe direct charges, so a marketplace order (which must be split between
 * providers, creator and platform) can never go through it.
 */
export function isKustomEnabledForStore(
  store:
    | {
        store_type: StoreType;
        is_active?: boolean;
        creator: KustomCreatorFields | null;
        /** Resolved presentment currency; checked when provided. */
        currency?: string | null;
      }
    | null
    | undefined,
): boolean {
  if (!store) return false;
  if (store.is_active === false) return false;
  if (store.store_type !== StoreType.INDEPENDENT) return false;
  if (
    store.currency !== undefined &&
    !isKustomCurrencySupported(store.currency)
  ) {
    return false;
  }
  return isKustomCreatorReady(store.creator);
}
