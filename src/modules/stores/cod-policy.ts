// Cash on delivery policy.
//
// In the marketplace model (supplier / influencer store / platform as seller
// of record) the platform takes its share from the card charge, so cash on
// delivery is not offered there at all. Only an INDEPENDENT store, which
// keeps the cash as its own revenue, may enable it.
//
// The stored `Store.cod_enabled` flag is never trusted on its own: every
// read goes through effectiveCodEnabled(), so a `true` left on a MARKETPLACE
// row (set before this rule, or before an admin type switch) reads as false
// without a data migration.

export const STORE_COD_MARKETPLACE_NOT_ALLOWED = {
  code: 'STORE_COD_MARKETPLACE_NOT_ALLOWED',
  message: 'Cash on delivery is not available for marketplace stores.',
} as const;

/** Whether the store really offers cash on delivery. */
export function effectiveCodEnabled(
  store:
    | { store_type?: string | null; cod_enabled?: boolean | null }
    | null
    | undefined,
): boolean {
  return store?.store_type === 'INDEPENDENT' && store.cod_enabled === true;
}

/**
 * A store row as it leaves the API: `cod_enabled` carries the effective
 * value. Rows that do not carry both columns are returned untouched.
 */
export function withEffectiveCod<T extends object>(store: T): T {
  const row = store as { store_type?: unknown; cod_enabled?: unknown };
  if (!('cod_enabled' in row) || !('store_type' in row)) return store;
  return {
    ...store,
    cod_enabled: effectiveCodEnabled(
      row as { store_type?: string | null; cod_enabled?: boolean | null },
    ),
  };
}
