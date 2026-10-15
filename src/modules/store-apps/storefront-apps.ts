import {
  STORE_APPS,
  StoreAppDefinition,
  StoreAppKey,
  isStoreAppKey,
} from '../../common/store-apps/store-apps.registry';
import { b2bPublicSettings } from '../b2b/b2b-settings';

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
 * Per-app completion of the whitelisted public settings (pure). Runs after
 * the `public_settings_keys` pick; may add derived values the storefront
 * needs but must leave the object untouched when nothing applies.
 */
const PUBLIC_SETTINGS_PROJECTORS: Partial<
  Record<
    StoreAppKey,
    (picked: Record<string, unknown>) => Record<string, unknown>
  >
> = {
  b2b: b2bPublicSettings,
};

/** The settings object an app exposes publicly (whitelist applied). */
export function publicAppSettings(
  key: StoreAppKey,
  settings: unknown,
  definition: StoreAppDefinition,
): Record<string, unknown> {
  const all =
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {};
  const keys = definition.public_settings_keys;
  if (!keys) return all;
  const picked: Record<string, unknown> = {};
  for (const k of keys) if (k in all) picked[k] = all[k];
  const project = PUBLIC_SETTINGS_PROJECTORS[key];
  return project ? project(picked) : picked;
}

/**
 * The public `apps` object of GET /storefront/:slug: one entry per app in
 * effect, settings included only for apps that opt into exposing them
 * (restricted to their `public_settings_keys` when listed). Rows
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
      entry.settings = publicAppSettings(
        row.app_key,
        row.settings,
        registry[row.app_key],
      );
    }
    apps[row.app_key] = entry;
  }
  return apps;
}
