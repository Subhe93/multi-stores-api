import {
  DEFAULT_REVIEWS_SETTINGS,
  normalizeReviewsSettings,
  validateReviewsSettings,
} from './reviews-settings';
import { validateStoreAppSettings } from '../../common/store-apps/settings-validators';
import {
  STORE_APPS,
  STORE_APP_KEYS,
  isStoreAppKey,
} from '../../common/store-apps/store-apps.registry';
import { buildStorefrontApps } from '../store-apps/storefront-apps';

describe('reviews app settings', () => {
  it('accepts {} and { auto_publish: boolean }', () => {
    expect(validateReviewsSettings({})).toEqual({ ok: true, errors: [] });
    expect(validateReviewsSettings({ auto_publish: true }).ok).toBe(true);
    expect(validateReviewsSettings({ auto_publish: false }).ok).toBe(true);
  });

  it.each([
    [{ auto_publish: 'yes' }],
    [{ auto_publish: 1 }],
    [{ auto_publish: null }],
    [{ auto_publish: true, extra: 1 }],
    [{ moderation: false }],
    [null],
    [[]],
    ['on'],
    [undefined],
  ])('rejects %p', (raw) => {
    const res = validateReviewsSettings(raw);
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
  });

  it('is the registered validator of the app', () => {
    expect(validateStoreAppSettings('reviews', { auto_publish: true })).toEqual(
      [],
    );
    expect(
      validateStoreAppSettings('reviews', { auto_publish: 'x' }),
    ).toHaveLength(1);
    expect(validateStoreAppSettings('reviews', { other: 1 })).toHaveLength(1);
  });

  it('lenient read: moderation first unless auto_publish is exactly true', () => {
    expect(DEFAULT_REVIEWS_SETTINGS).toEqual({ auto_publish: false });
    expect(normalizeReviewsSettings(null)).toEqual({ auto_publish: false });
    expect(normalizeReviewsSettings({})).toEqual({ auto_publish: false });
    expect(normalizeReviewsSettings({ auto_publish: 'true' })).toEqual({
      auto_publish: false,
    });
    expect(normalizeReviewsSettings({ auto_publish: true })).toEqual({
      auto_publish: true,
    });
  });
});

describe('reviews app registration', () => {
  it('is a registry key for every store type, without dependencies', () => {
    expect(STORE_APP_KEYS).toContain('reviews');
    expect(isStoreAppKey('reviews')).toBe(true);
    expect(STORE_APPS.reviews).toEqual({
      key: 'reviews',
      name_key: 'reviews.name',
      description_key: 'reviews.description',
      requires_independent: false,
      depends_on: [],
      expose_settings_to_storefront: false,
    });
  });

  it('storefront payload: apps.reviews = { enabled: true }, never the settings', () => {
    const row = {
      app_key: 'reviews',
      available: true,
      enabled: true,
      settings: { auto_publish: true },
    };
    expect(buildStorefrontApps([row])).toEqual({ reviews: { enabled: true } });
  });

  it('storefront payload: nothing while the app is off (byte-identical store payload)', () => {
    const base = { app_key: 'reviews', settings: { auto_publish: true } };
    expect(
      buildStorefrontApps([{ ...base, available: true, enabled: false }]),
    ).toEqual({});
    expect(
      buildStorefrontApps([{ ...base, available: false, enabled: true }]),
    ).toEqual({});
    expect(buildStorefrontApps([])).toEqual({});
  });
});
