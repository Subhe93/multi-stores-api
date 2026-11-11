// Server-side tracking columns of a Store row and how they leave the API.
//
// `meta_capi_token` (encrypted Meta Conversions API token) is never returned
// by any endpoint. PrismaService already omits the column from every read;
// the helpers below are the explicit second line for the payloads that
// return a Store row, and they add the owner-facing `meta_capi_token_set`.

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
    ...(rest as WithoutToken<T>),
    meta_capi_token_set: Boolean(meta_capi_token),
  };
}

/**
 * Store row for anyone who is not the owner or an admin (public storefront,
 * providers): neither the token, nor whether one is set, nor the test code.
 */
export function publicStoreRow<T extends object>(
  store: T,
): Omit<T, 'meta_capi_token' | 'meta_test_event_code'> {
  const rest = { ...store } as T & {
    meta_capi_token?: string | null;
    meta_test_event_code?: string | null;
  };
  delete rest.meta_capi_token;
  delete rest.meta_test_event_code;
  return rest;
}
