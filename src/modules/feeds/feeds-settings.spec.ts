import {
  DEFAULT_FEEDS_SETTINGS,
  generateFeedToken,
  isFeedToken,
  normalizeFeedsSettings,
  validateFeedsSettings,
} from './feeds-settings';
import { validateStoreAppSettings } from '../../common/store-apps/settings-validators';
import {
  STORE_APPS,
  STORE_APP_KEYS,
} from '../../common/store-apps/store-apps.registry';

describe('feeds settings (M5.6)', () => {
  it('is registered: default off, any store type, settings private', () => {
    expect(STORE_APP_KEYS).toContain('feeds');
    expect(STORE_APPS.feeds).toMatchObject({
      requires_independent: false,
      depends_on: [],
      expose_settings_to_storefront: false,
    });
  });

  it('generates 32-char hex tokens', () => {
    const t = generateFeedToken();
    expect(t).toHaveLength(32);
    expect(isFeedToken(t)).toBe(true);
    expect(generateFeedToken()).not.toBe(t);
    expect(isFeedToken('short')).toBe(false);
    expect(isFeedToken('G'.repeat(32))).toBe(false);
  });

  it('normalizes defaults and drops odd values', () => {
    expect(normalizeFeedsSettings({})).toEqual(DEFAULT_FEEDS_SETTINGS);
    expect(normalizeFeedsSettings(null)).toEqual(DEFAULT_FEEDS_SETTINGS);
    expect(
      normalizeFeedsSettings({
        google: 'yes',
        facebook: false,
        default_brand: '  Namz ',
        token: 'bad',
        include_variants: false,
        shipping_label: '',
      }),
    ).toEqual({
      google: true,
      facebook: false,
      default_brand: 'Namz',
      token: null,
      include_variants: false,
      shipping_label: null,
    });
  });

  it('validates the write strictly (unknown keys, types, token shape)', () => {
    const token = generateFeedToken();
    expect(
      validateFeedsSettings({ google: true, token, default_brand: null }),
    ).toEqual({ ok: true, errors: [] });
    expect(validateFeedsSettings({ foo: 1 }).errors[0]).toMatch(
      /Unknown setting "foo"/,
    );
    expect(validateFeedsSettings({ google: 'x' }).errors[0]).toMatch(
      /google must be true or false/,
    );
    expect(validateFeedsSettings({ token: 'typed-by-hand' }).errors[0]).toMatch(
      /token must be a generated/,
    );
    expect(
      validateFeedsSettings({ default_brand: 'x'.repeat(71) }).errors[0],
    ).toMatch(/at most 70/);
    expect(validateFeedsSettings('nope').ok).toBe(false);
    // Wired into the store-apps validator table.
    expect(validateStoreAppSettings('feeds', { bogus: true })).toHaveLength(1);
    expect(validateStoreAppSettings('feeds', { facebook: false })).toEqual([]);
  });
});
