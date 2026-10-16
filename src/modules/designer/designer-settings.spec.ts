import {
  DEFAULT_DESIGNER_SETTINGS,
  normalizeDesignerSettings,
  validateDesignerSettings,
} from './designer-settings';
import { validateStoreAppSettings } from '../../common/store-apps/settings-validators';
import { STORE_APPS } from '../../common/store-apps/store-apps.registry';

describe('designer settings', () => {
  it('defaults follow U12 / §4.3 (photos 60, files 30 after shipping, drafts 30)', () => {
    expect(normalizeDesignerSettings(undefined)).toEqual({
      retention_days: 60,
      draft_retention_days: 30,
      print_keep_days_after_shipped: 30,
      max_upload_mb: 25,
      min_effective_dpi_warning: 100,
      print_px_per_mm: 6,
      print_formats: ['png'],
      shop_button_text: { sv: 'Designa din skylt' },
    });
    expect(DEFAULT_DESIGNER_SETTINGS.retention_days).toBe(60);
  });

  it('accepts a full valid object', () => {
    const r = validateDesignerSettings({
      retention_days: 90,
      draft_retention_days: 14,
      print_keep_days_after_shipped: 0,
      max_upload_mb: 40,
      min_effective_dpi_warning: 150,
      print_px_per_mm: 6,
      print_formats: ['png'],
      shop_button_text: { sv: 'Designa', en: 'Design yours' },
    });
    expect(r).toEqual({ ok: true, errors: [] });
  });

  it('rejects out-of-range and non-integer numbers', () => {
    const r = validateDesignerSettings({
      retention_days: 6,
      draft_retention_days: 0,
      print_keep_days_after_shipped: 366,
      max_upload_mb: 41,
      min_effective_dpi_warning: 29.5,
    });
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(5);
  });

  it('keeps drafts within the photo retention', () => {
    expect(
      validateDesignerSettings({ retention_days: 20, draft_retention_days: 21 })
        .errors,
    ).toEqual(['draft_retention_days cannot be longer than retention_days.']);
    // Against the default retention (60) when retention_days is absent.
    expect(validateDesignerSettings({ draft_retention_days: 61 }).ok).toBe(
      false,
    );
    // The lenient reader clamps instead of throwing.
    expect(
      normalizeDesignerSettings({
        retention_days: 20,
        draft_retention_days: 25,
      }).draft_retention_days,
    ).toBe(20);
  });

  it('allows only 6 px/mm and PNG in M4.2', () => {
    expect(validateDesignerSettings({ print_px_per_mm: 11.811 }).ok).toBe(
      false,
    );
    expect(validateDesignerSettings({ print_formats: ['png', 'pdf'] }).ok).toBe(
      false,
    );
    expect(validateDesignerSettings({ print_formats: [] }).ok).toBe(false);
  });

  it('validates the button text map (locale keys, ≤ 40 chars)', () => {
    expect(
      validateDesignerSettings({ shop_button_text: { sv: 'x'.repeat(41) } }).ok,
    ).toBe(false);
    expect(
      validateDesignerSettings({ shop_button_text: { Swedish: 'x' } }).ok,
    ).toBe(false);
    expect(validateDesignerSettings({ shop_button_text: 'x' }).ok).toBe(false);
    // The lenient reader drops bad entries and falls back to the default.
    expect(
      normalizeDesignerSettings({ shop_button_text: { sv: ' ', xx_YY: 'a' } })
        .shop_button_text,
    ).toEqual({ sv: 'Designa din skylt' });
  });

  it('ignores unknown keys and rejects non-objects', () => {
    expect(validateDesignerSettings({ foo: 1 }).ok).toBe(true);
    expect(validateDesignerSettings([]).ok).toBe(false);
  });

  it('is registered as the designer settings validator', () => {
    expect(validateStoreAppSettings('designer', { retention_days: 1 })).toEqual(
      ['retention_days must be a whole number from 7 to 730.'],
    );
    expect(validateStoreAppSettings('designer', {})).toEqual([]);
  });

  it('registry: independent-only, off by default, three public keys', () => {
    expect(STORE_APPS.designer).toEqual({
      key: 'designer',
      name_key: 'designer.name',
      description_key: 'designer.description',
      requires_independent: true,
      depends_on: [],
      expose_settings_to_storefront: true,
      public_settings_keys: [
        'max_upload_mb',
        'min_effective_dpi_warning',
        'shop_button_text',
      ],
    });
  });
});
