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
  'personalization',
  'production',
  'designer',
  'feeds',
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
  // When set (and settings are exposed), only these keys of the settings
  // object reach the public payload; every other key stays private.
  public_settings_keys?: string[];
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
    // public payload (apps.b2b.settings) to seed the buyer-type toggle, and
    // the reverse-charge switch / pricing to show the VAT-number check.
    // vies_requester_vat stays private.
    expose_settings_to_storefront: true,
    public_settings_keys: [
      'allow_company',
      'default_buyer_type',
      'require_vat_number',
      'org_number_countries',
      'reverse_charge_enabled',
      'reverse_charge_pricing',
    ],
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
  // M4.1: advanced product personalization (repeaters, conditions, presets,
  // variation cards). Applies only to the creator's own products.
  personalization: {
    key: 'personalization',
    name_key: 'personalization.name',
    description_key: 'personalization.description',
    requires_independent: false,
    depends_on: [],
    // retention_days and free_shipping_country stay private.
    expose_settings_to_storefront: true,
    public_settings_keys: [
      'free_shipping_badge',
      'card_price_mode',
      'validation_summary',
      'url_prefill',
      'listing_cta',
    ],
  },
  // M4.3: per-order production checklist (post-order only).
  production: {
    key: 'production',
    name_key: 'production.name',
    description_key: 'production.description',
    requires_independent: false,
    depends_on: [],
    expose_settings_to_storefront: false,
  },
  // M4.2: product designer (templates in mm, storefront canvas editor,
  // server-rendered print files). Independent-only: the creator is the sole
  // fulfiller of designed lines.
  designer: {
    key: 'designer',
    name_key: 'designer.name',
    description_key: 'designer.description',
    requires_independent: true,
    depends_on: [],
    // Retention and print settings stay private.
    expose_settings_to_storefront: true,
    public_settings_keys: [
      'max_upload_mb',
      'min_effective_dpi_warning',
      'shop_button_text',
    ],
  },
  // M5.6: Google Merchant / Meta catalog product feeds (public token URLs).
  // Any store type; settings (token!) never reach the storefront payload.
  feeds: {
    key: 'feeds',
    name_key: 'feeds.name',
    description_key: 'feeds.description',
    requires_independent: false,
    depends_on: [],
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
