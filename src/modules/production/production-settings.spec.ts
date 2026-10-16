import {
  DEFAULT_PRODUCTION_SETTINGS,
  PRODUCTION_PRESETS,
  nameKey,
  normalizeProductionSettings,
  validateProductionSettings,
} from './production-settings';
import { validateStoreAppSettings } from '../../common/store-apps/settings-validators';

describe('production settings (M4.3 §3.3)', () => {
  it('defaults for an empty or malformed object', () => {
    expect(normalizeProductionSettings({})).toEqual(
      DEFAULT_PRODUCTION_SETTINGS,
    );
    expect(normalizeProductionSettings(null)).toEqual(
      DEFAULT_PRODUCTION_SETTINGS,
    );
    expect(
      normalizeProductionSettings({
        on_complete: 'later',
        include_variant_options: 'yes',
        exclude_field_types: ['TEXT', 'NOPE'],
      }),
    ).toMatchObject({
      on_complete: 'suggest',
      include_variant_options: true,
      exclude_field_types: ['TEXT'],
    });
  });

  it('lenient read trims, de-duplicates and caps lists', () => {
    const s = normalizeProductionSettings({
      default_custom_items: [
        ' Packed ',
        'Packed',
        '',
        5,
        ...new Array<string>(20).fill('x'),
      ],
    });
    expect(s.default_custom_items[0]).toBe('Packed');
    expect(s.default_custom_items.length).toBeLessThanOrEqual(10);
  });

  it('lenient read never yields auto + SHIPPED', () => {
    expect(
      normalizeProductionSettings({
        on_complete: 'auto',
        complete_target: 'SHIPPED',
      }).on_complete,
    ).toBe('suggest');
  });

  it('strict validation: accepts the defaults and the namez preset', () => {
    expect(validateProductionSettings({}).ok).toBe(true);
    expect(validateProductionSettings({ ...PRODUCTION_PRESETS.namez }).ok).toBe(
      true,
    );
    expect(validateStoreAppSettings('production', {})).toEqual([]);
  });

  it('strict validation: types, enums and limits', () => {
    const r = validateProductionSettings({
      include_variant_options: 'yes',
      exclude_option_names: Array(21).fill('a'),
      exclude_field_types: ['TEXT', 'BOGUS'],
      default_custom_items: ['x'.repeat(81)],
      on_complete: 'later',
      complete_target: 'DELIVERED',
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/include_variant_options/);
    expect(r.errors.join(' ')).toMatch(/exclude_option_names/);
    expect(r.errors.join(' ')).toMatch(/exclude_field_types/);
    expect(r.errors.join(' ')).toMatch(/default_custom_items/);
    expect(r.errors.join(' ')).toMatch(/on_complete/);
    expect(r.errors.join(' ')).toMatch(/complete_target/);
    expect(validateProductionSettings([]).ok).toBe(false);
  });

  it('strict validation: auto + SHIPPED is refused (never auto-ship)', () => {
    const r = validateProductionSettings({
      on_complete: 'auto',
      complete_target: 'SHIPPED',
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/SHIPPED/);
    // Through the registry too (STORE_APP_SETTINGS_INVALID).
    expect(
      validateStoreAppSettings('production', {
        on_complete: 'auto',
        complete_target: 'SHIPPED',
      }).length,
    ).toBe(1);
  });

  it('strict validation: a QC target needs use_quality_check', () => {
    expect(
      validateProductionSettings({
        complete_target: 'QUALITY_CHECK',
        use_quality_check: false,
      }).ok,
    ).toBe(false);
    expect(
      validateProductionSettings({
        on_complete: 'none',
        use_quality_check: false,
      }).ok,
    ).toBe(true);
  });

  it('namez preset (Q16): suggest SHIPPED, no QC, quantity attribute excluded', () => {
    const s = normalizeProductionSettings(PRODUCTION_PRESETS.namez);
    expect(s).toMatchObject({
      on_complete: 'suggest',
      complete_target: 'SHIPPED',
      use_quality_check: false,
      include_variant_options: true,
    });
    const keys = s.exclude_option_names.map(nameKey);
    expect(keys).toContain(nameKey('pa_rakna'));
    expect(keys).toContain(nameKey('valj-antal'));
  });

  it('nameKey ignores case, accents, pa_ prefix and separators', () => {
    expect(nameKey('pa_rakna')).toBe(nameKey('Räkna'));
    expect(nameKey('Välj antal')).toBe(nameKey('valj-antal'));
  });
});
