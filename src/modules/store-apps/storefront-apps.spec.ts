import { buildStorefrontApps, isStoreAppRowActive } from './storefront-apps';
import {
  STORE_APPS,
  StoreAppDefinition,
  StoreAppKey,
} from '../../common/store-apps/store-apps.registry';

// The pure projection behind GET /storefront/:slug → apps. Tests that need a
// different registry pass one in instead of mutating the shared STORE_APPS.

function registryWith(
  overrides: Partial<Record<StoreAppKey, Partial<StoreAppDefinition>>>,
): Record<StoreAppKey, StoreAppDefinition> {
  const copy = {} as Record<StoreAppKey, StoreAppDefinition>;
  for (const key of Object.keys(STORE_APPS) as StoreAppKey[]) {
    copy[key] = { ...STORE_APPS[key], ...overrides[key] };
  }
  return copy;
}

describe('buildStorefrontApps', () => {
  it('returns {} for a store without rows', () => {
    expect(buildStorefrontApps([])).toEqual({});
  });

  it('includes only apps that are available AND enabled', () => {
    const apps = buildStorefrontApps([
      { app_key: 'markets', available: true, enabled: true, settings: {} },
      { app_key: 'b2b', available: true, enabled: false, settings: {} },
      { app_key: 'invoices', available: false, enabled: true, settings: {} },
    ]);
    expect(apps).toEqual({ markets: { enabled: true } });
  });

  it('drops rows whose key the registry no longer knows', () => {
    expect(
      buildStorefrontApps([
        { app_key: 'legacy', available: true, enabled: true, settings: {} },
      ]),
    ).toEqual({});
  });

  it('omits settings for an app that does not expose them (markets)', () => {
    const apps = buildStorefrontApps([
      {
        app_key: 'markets',
        available: true,
        enabled: true,
        settings: { secret: 'x' },
      },
    ]);
    expect(apps.markets).toEqual({ enabled: true });
    expect(apps.markets).not.toHaveProperty('settings');
  });

  // b2b app (M2, D6): the storefront reads allow_company etc. from the payload.
  it('exposes the b2b settings with the real registry', () => {
    const apps = buildStorefrontApps([
      {
        app_key: 'b2b',
        available: true,
        enabled: true,
        settings: { allow_company: false },
      },
    ]);
    expect(apps.b2b).toEqual({
      enabled: true,
      settings: { allow_company: false },
    });
  });

  it('exposes settings for an app that opts in', () => {
    const registry = registryWith({
      b2b: { expose_settings_to_storefront: true },
    });
    expect(
      buildStorefrontApps(
        [
          {
            app_key: 'b2b',
            available: true,
            enabled: true,
            settings: { a: 1 },
          },
        ],
        registry,
      ),
    ).toEqual({ b2b: { enabled: true, settings: { a: 1 } } });
    // A non-object settings value degrades to {} rather than leaking.
    expect(
      buildStorefrontApps(
        [{ app_key: 'b2b', available: true, enabled: true, settings: null }],
        registry,
      ),
    ).toEqual({ b2b: { enabled: true, settings: {} } });
    // Other apps keep the registry default.
    expect(
      buildStorefrontApps(
        [{ app_key: 'markets', available: true, enabled: true, settings: {} }],
        registry,
      ),
    ).toEqual({ markets: { enabled: true } });
  });
});

describe('isStoreAppRowActive', () => {
  it('needs both switches', () => {
    const base = { app_key: 'b2b', settings: {} };
    expect(
      isStoreAppRowActive({ ...base, available: true, enabled: true }),
    ).toBe(true);
    expect(
      isStoreAppRowActive({ ...base, available: true, enabled: false }),
    ).toBe(false);
    expect(
      isStoreAppRowActive({ ...base, available: false, enabled: true }),
    ).toBe(false);
  });
});
