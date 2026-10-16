import { validateStoreAppSettings } from '../../common/store-apps/settings-validators';
import { STORE_APPS } from '../../common/store-apps/store-apps.registry';
import {
  DEFAULT_PERSONALIZATION_SETTINGS,
  parsePersonalizationSettings,
  PERSONALIZATION_PUBLIC_SETTINGS_KEYS,
  personalizationPublicSettings,
  validatePersonalizationSettings,
} from './personalization-settings';

describe('personalization settings (M4.1 §3.9, C23)', () => {
  it('defaults: retention 60 days, badge on, selection price, personalize CTA', () => {
    expect(parsePersonalizationSettings(undefined)).toEqual({
      free_shipping_badge: true,
      free_shipping_country: null,
      card_price_mode: 'selection',
      validation_summary: true,
      url_prefill: {},
      listing_cta: 'personalize',
      retention_days: 60,
    });
    expect(DEFAULT_PERSONALIZATION_SETTINGS.retention_days).toBe(60);
  });

  it('lenient parse keeps valid values and falls back per key', () => {
    const s = parsePersonalizationSettings({
      free_shipping_badge: false,
      free_shipping_country: 'se',
      card_price_mode: 'from',
      validation_summary: 'yes',
      url_prefill: {
        name1: 'name_1',
        color: 'option:Färg',
        'bad key': 'x',
        empty: '',
      },
      listing_cta: 'banana',
      retention_days: 5,
    });
    expect(s).toEqual({
      free_shipping_badge: false,
      free_shipping_country: 'SE',
      card_price_mode: 'from',
      validation_summary: true,
      url_prefill: { name1: 'name_1', color: 'option:Färg' },
      listing_cta: 'personalize',
      retention_days: 60,
    });
  });

  it('strict validation: subset ok, unknown keys ignored', () => {
    expect(validatePersonalizationSettings({})).toEqual({
      ok: true,
      errors: [],
    });
    expect(
      validatePersonalizationSettings({
        free_shipping_badge: true,
        free_shipping_country: null,
        card_price_mode: 'selection',
        validation_summary: false,
        url_prefill: { name1: 'name_1', 'cf[name]': 'name' },
        listing_cta: 'none',
        retention_days: 730,
        something_else: 1,
      }).ok,
    ).toBe(true);
  });

  it.each([
    [{ free_shipping_badge: 'yes' }],
    [{ free_shipping_country: 'SWE' }],
    [{ card_price_mode: 'cheapest' }],
    [{ listing_cta: 'add' }],
    [{ retention_days: 6 }],
    [{ retention_days: 731 }],
    [{ retention_days: 30.5 }],
    [{ url_prefill: [] }],
    [{ url_prefill: { 'a b': 'x' } }],
    [{ url_prefill: { a: 'option:' } }],
    [
      {
        url_prefill: Object.fromEntries(
          Array.from({ length: 21 }, (_, i) => [`p${i}`, 'x']),
        ),
      },
    ],
  ])('rejects %j', (raw) => {
    const r = validatePersonalizationSettings(raw);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-object', () => {
    expect(validatePersonalizationSettings(null).ok).toBe(false);
    expect(validatePersonalizationSettings([]).ok).toBe(false);
  });

  it('is the registered validator of the app', () => {
    expect(
      validateStoreAppSettings('personalization', { retention_days: 1 }),
    ).toHaveLength(1);
    expect(
      validateStoreAppSettings('personalization', { retention_days: 7 }),
    ).toEqual([]);
  });

  it('public projection = the registry whitelist (no private keys)', () => {
    const pub = personalizationPublicSettings({
      retention_days: 90,
      free_shipping_country: 'SE',
      card_price_mode: 'from',
    });
    expect(Object.keys(pub).sort()).toEqual(
      [...PERSONALIZATION_PUBLIC_SETTINGS_KEYS].sort(),
    );
    expect(pub).not.toHaveProperty('retention_days');
    expect(pub).not.toHaveProperty('free_shipping_country');
    expect(
      [...(STORE_APPS.personalization.public_settings_keys ?? [])].sort(),
    ).toEqual([...PERSONALIZATION_PUBLIC_SETTINGS_KEYS].sort());
  });
});
