import { normalizeVatNumber, validateVatNumber } from './vat-number.util';

// VAT formats of the b2b app (D7): country-prefix table, generic fallback,
// normalisation (uppercase, no separators), format only - no VIES.

describe('validateVatNumber', () => {
  it('accepts a Swedish number and normalises case / spaces', () => {
    expect(validateVatNumber('SE556677889901')).toEqual({
      ok: true,
      normalized: 'SE556677889901',
      country: 'SE',
      reason: null,
    });
    expect(validateVatNumber(' se 5566 7788 9901 ')).toMatchObject({
      ok: true,
      normalized: 'SE556677889901',
    });
    expect(validateVatNumber('SE-5566.7788-9901').normalized).toBe(
      'SE556677889901',
    );
  });

  it('rejects a Swedish number with only 10 digits', () => {
    expect(validateVatNumber('SE5566778899')).toMatchObject({
      ok: false,
      reason: 'FORMAT',
      country: 'SE',
    });
  });

  it('knows the other prefixes in the table', () => {
    expect(validateVatNumber('DE123456789').ok).toBe(true);
    expect(validateVatNumber('DE12345678').ok).toBe(false);
    expect(validateVatNumber('NO999999999MVA').ok).toBe(true);
    expect(validateVatNumber('NO999999999').ok).toBe(false);
    expect(validateVatNumber('FI12345678').ok).toBe(true);
    expect(validateVatNumber('DK12345678').ok).toBe(true);
    expect(validateVatNumber('GB123456789').ok).toBe(true);
    expect(validateVatNumber('GB123456789012').ok).toBe(true);
    expect(validateVatNumber('GB1234567').ok).toBe(false);
    expect(validateVatNumber('NL123456789B01').ok).toBe(true);
    expect(validateVatNumber('ATU12345678').ok).toBe(true);
    expect(validateVatNumber('BE0123456789').ok).toBe(true);
    expect(validateVatNumber('FRXX123456789').ok).toBe(true);
    expect(validateVatNumber('IT12345678901').ok).toBe(true);
    expect(validateVatNumber('ESA1234567B').ok).toBe(true);
    expect(validateVatNumber('IE1234567T').ok).toBe(true);
    expect(validateVatNumber('PL1234567890').ok).toBe(true);
  });

  it('uses the generic rule for an unknown prefix', () => {
    expect(validateVatNumber('CH123456')).toMatchObject({
      ok: true,
      country: 'CH',
    });
    expect(validateVatNumber('CH1')).toMatchObject({ ok: false });
  });

  it('accepts EL (Greece) through the generic rule', () => {
    expect(validateVatNumber('EL123456789')).toMatchObject({
      ok: true,
      country: 'EL',
    });
  });

  it('rejects a prefix that is not a country code', () => {
    expect(validateVatNumber('XX123')).toMatchObject({
      ok: false,
      reason: 'FORMAT',
      country: 'XX',
    });
    expect(validateVatNumber('QQ123456789').ok).toBe(false);
  });

  it('rejects garbage and reports an empty input', () => {
    expect(validateVatNumber('12345').ok).toBe(false);
    expect(validateVatNumber('S!556677889901').ok).toBe(false);
    expect(validateVatNumber('').reason).toBe('EMPTY');
    expect(validateVatNumber(null).reason).toBe('EMPTY');
  });

  it('normalizeVatNumber never throws and keeps the value as typed otherwise', () => {
    expect(normalizeVatNumber(' de 123 ')).toBe('DE123');
    expect(normalizeVatNumber(undefined)).toBe('');
  });
});
