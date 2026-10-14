import {
  DEFAULT_B2B_SETTINGS,
  parseB2bSettings,
  validateB2bSettings,
} from './b2b-settings';

// StoreApp.settings of the b2b app (D6): the lenient read never throws and
// always yields a complete object; the strict write rejects wrong types.

describe('parseB2bSettings (lenient read)', () => {
  it('yields the defaults for null / {} / garbage', () => {
    expect(parseB2bSettings(null)).toEqual(DEFAULT_B2B_SETTINGS);
    expect(parseB2bSettings({})).toEqual(DEFAULT_B2B_SETTINGS);
    expect(parseB2bSettings('x')).toEqual(DEFAULT_B2B_SETTINGS);
    expect(parseB2bSettings([1])).toEqual(DEFAULT_B2B_SETTINGS);
    expect(parseB2bSettings(undefined)).toEqual(DEFAULT_B2B_SETTINGS);
  });

  it('keeps valid fields and replaces invalid ones by their default', () => {
    expect(
      parseB2bSettings({
        allow_company: false,
        default_buyer_type: 'COMPANY',
        require_vat_number: 'yes',
        org_number_countries: ['se', 'FI', 'xyz', 3, 'fi'],
      }),
    ).toEqual({
      allow_company: false,
      default_buyer_type: 'COMPANY',
      require_vat_number: false,
      org_number_countries: ['SE', 'FI'],
    });
    expect(
      parseB2bSettings({ default_buyer_type: 'robot' }).default_buyer_type,
    ).toBe('PERSON');
    expect(
      parseB2bSettings({ org_number_countries: 'SE' }).org_number_countries,
    ).toEqual(['SE']);
  });

  it('returns a fresh array so callers cannot mutate the defaults', () => {
    const a = parseB2bSettings(null);
    a.org_number_countries.push('FI');
    expect(DEFAULT_B2B_SETTINGS.org_number_countries).toEqual(['SE']);
  });
});

describe('validateB2bSettings (strict write)', () => {
  it('accepts a full valid object and an empty / partial one', () => {
    expect(
      validateB2bSettings({
        allow_company: true,
        default_buyer_type: 'PERSON',
        require_vat_number: false,
        org_number_countries: ['SE', 'FI'],
      }),
    ).toEqual({ ok: true, errors: [] });
    expect(validateB2bSettings({}).ok).toBe(true);
    expect(validateB2bSettings({ allow_company: false }).ok).toBe(true);
    expect(validateB2bSettings({ org_number_countries: [] }).ok).toBe(true);
  });

  it('rejects an unknown buyer type', () => {
    const r = validateB2bSettings({ default_buyer_type: 'ROBOT' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/default_buyer_type/);
  });

  it('rejects non-ISO country codes and a non-list', () => {
    expect(
      validateB2bSettings({ org_number_countries: ['SE', 'Sweden'] }).errors[0],
    ).toMatch(/"Sweden"/);
    expect(
      validateB2bSettings({ org_number_countries: 'SE' }).errors[0],
    ).toMatch(/list/);
  });

  it('rejects non-boolean flags and non-objects, listing every problem', () => {
    const r = validateB2bSettings({
      allow_company: 'yes',
      require_vat_number: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(2);
    expect(validateB2bSettings(null).ok).toBe(false);
    expect(validateB2bSettings([]).ok).toBe(false);
  });

  it('ignores unknown keys (stored, never read)', () => {
    expect(validateB2bSettings({ b: 2 }).ok).toBe(true);
  });
});
