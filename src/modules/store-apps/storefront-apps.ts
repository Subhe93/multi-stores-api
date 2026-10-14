import {
  STORE_APPS,
  StoreAppDefinition,
  StoreAppKey,
  isStoreAppKey,
} from '../../common/store-apps/store-apps.registry';

/** The StoreApp columns the storefront projection needs. */
export interface StoreAppRowLike {
  app_key: string;
  available: boolean;
  enabled: boolean;
  settings: unknown;
}

export interface StorefrontStoreApp {
  enabled: true;
  settings?: Record<string, unknown>;
}

/** Mirrors `StorefrontApps` in multi-stores-shared/src/types/store-app.ts. */
export type StorefrontApps = Partial<Record<StoreAppKey, StorefrontStoreApp>>;

/** An app is in effect only when the admin allowed it and the creator enabled it. */
export function isStoreAppRowActive(row: StoreAppRowLike): boolean {
  return row.available && row.enabled;
}

/**
 * The public `apps` object of GET /storefront/:slug: one entry per app in
 * effect, settings included only for apps that opt into exposing them. Rows
 * with a key the registry no longer knows are dropped. No rows → `{}`.
 * `registry` is injectable for tests only.
 */
export function buildStorefrontApps(
  rows: StoreAppRowLike[],
  registry: Record<StoreAppKey, StoreAppDefinition> = STORE_APPS,
): StorefrontApps {
  const apps: StorefrontApps = {};
  for (const row of rows) {
    if (!isStoreAppKey(row.app_key) || !isStoreAppRowActive(row)) continue;
    const entry: StorefrontStoreApp = { enabled: true };
    if (registry[row.app_key].expose_settings_to_storefront) {
      entry.settings =
        row.settings && typeof row.settings === 'object'
          ? (row.settings as Record<string, unknown>)
          : {};
    }
    apps[row.app_key] = entry;
  }
  return apps;
}
