// Mirror of multi-stores-shared/src/constants/store-apps.ts — keep in sync.

// Registry of the per-store apps (feature add-ons). A store with no StoreApp
// rows behaves exactly as a store without the apps system; every app is a
// strict opt-in that an admin makes available and the creator then enables.
// Source of truth for the mirrors in api / dashboard / web — keep in sync.

export const STORE_APP_KEYS = [
  'markets',
  'b2b',
  'invoices',
  'importer',
] as const;

export type StoreAppKey = (typeof STORE_APP_KEYS)[number];

export interface StoreAppDefinition {
  key: StoreAppKey;
  // i18n keys resolved by each app (dashboard: creator.apps.<key>.name).
  name_key: string;
  description_key: string;
  // Only an INDEPENDENT store may enable it.
  requires_independent: boolean;
  // Apps that must be enabled first; disabling one of them while this app is
  // enabled is refused.
  depends_on: StoreAppKey[];
  // When true the app's settings object is included in the public storefront
  // payload (GET /storefront/:slug → apps[key].settings). Off for every app
  // until an app actually needs it.
  expose_settings_to_storefront: boolean;
}

export const STORE_APPS: Record<StoreAppKey, StoreAppDefinition> = {
  markets: {
    key: 'markets',
    name_key: 'markets.name',
    description_key: 'markets.description',
    requires_independent: true,
    depends_on: [],
    expose_settings_to_storefront: false,
  },
  b2b: {
    key: 'b2b',
    name_key: 'b2b.name',
    description_key: 'b2b.description',
    requires_independent: false,
    depends_on: [],
    // The storefront reads allow_company / default_buyer_type from the
    // public payload (apps.b2b.settings) to seed the buyer-type toggle.
    expose_settings_to_storefront: true,
  },
  invoices: {
    key: 'invoices',
    name_key: 'invoices.name',
    description_key: 'invoices.description',
    requires_independent: true,
    depends_on: [],
    expose_settings_to_storefront: false,
  },
  importer: {
    key: 'importer',
    name_key: 'importer.name',
    description_key: 'importer.description',
    requires_independent: true,
    depends_on: ['markets'],
    expose_settings_to_storefront: false,
  },
};

export function isStoreAppKey(value: unknown): value is StoreAppKey {
  return (
    typeof value === 'string' &&
    (STORE_APP_KEYS as readonly string[]).includes(value)
  );
}

/** Apps that list `key` in their depends_on. */
export function storeAppDependents(key: StoreAppKey): StoreAppKey[] {
  return STORE_APP_KEYS.filter((k) => STORE_APPS[k].depends_on.includes(key));
}
