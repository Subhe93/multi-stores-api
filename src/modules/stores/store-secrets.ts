// Server-side tracking columns of a Store row and how they leave the API.
//
// `meta_capi_token` (encrypted Meta Conversions API token) is never returned
// by any endpoint. PrismaService already omits the column from every read;
// the helpers below are the explicit second line for the payloads that
// return a Store row, and they add the owner-facing `meta_capi_token_set`.
//
// Both payload helpers also carry the EFFECTIVE cash-on-delivery flag
// (cod-policy.ts): a marketplace store never offers it, whatever the row says.

import { withEffectiveCod } from './cod-policy';

/**
 * Pass as `omit` on an owner / admin Store query so the row carries the
 * (encrypted) token long enough for `ownerStorePayload` to derive
 * `meta_capi_token_set` from it.
 */
export const WITH_CAPI_TOKEN = { meta_capi_token: false } as const;

type WithoutToken<T> = Omit<T, 'meta_capi_token'>;

/**
 * Owner / admin payload: the token is replaced by `meta_capi_token_set`.
 * The test event code stays (it is not a secret and the owner edits it).
 */
export function ownerStorePayload<T extends object>(
  store: T,
): WithoutToken<T> & { meta_capi_token_set: boolean } {
  const { meta_capi_token, ...rest } = store as T & {
    meta_capi_token?: string | null;
  };
  return {
    ...(withEffectiveCod(rest) as WithoutToken<T>),
    meta_capi_token_set: Boolean(meta_capi_token),
  };
}

/**
 * Store columns that are private to the owner / an admin and never travel in
 * a public payload: GET /storefront/:slug (fullStore), GET /stores/:slug and
 * the provider store views (publicStoreRow). The owner reads them from
 * /stores/my/store, /taxes/my/settings and /mail/store/notifications. The
 * public contract spec and docs/storefront-api.md list the same keys.
 */
export const PRIVATE_STORE_KEYS = [
  'notification_email',
  'status_reason',
  'golive_requested_at',
  'stripe_key_lock_until',
  'cache_enabled',
  'oss_registered',
  'shipping_tax_class_id',
] as const;

type PrivateStoreKey = (typeof PRIVATE_STORE_KEYS)[number];

/**
 * Store row for anyone who is not the owner or an admin (public storefront,
 * providers): neither the token, nor whether one is set, nor the test code,
 * nor any PRIVATE_STORE_KEYS column.
 */
export function publicStoreRow<T extends object>(
  store: T,
): Omit<T, 'meta_capi_token' | 'meta_test_event_code' | PrivateStoreKey> {
  const rest = withEffectiveCod({ ...store }) as Record<string, unknown>;
  delete rest.meta_capi_token;
  delete rest.meta_test_event_code;
  for (const key of PRIVATE_STORE_KEYS) delete rest[key];
  return rest as Omit<
    T,
    'meta_capi_token' | 'meta_test_event_code' | PrivateStoreKey
  >;
}
