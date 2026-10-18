import { isValidGtin, normalizeGtin } from './gtin';

describe('GTIN check digit (M5.6)', () => {
  it('accepts valid GTIN-8/12/13/14', () => {
    expect(isValidGtin('96385074')).toBe(true); // GTIN-8
    expect(isValidGtin('036000291452')).toBe(true); // UPC-A
    expect(isValidGtin('4006381333931')).toBe(true); // EAN-13
    expect(isValidGtin('9780306406157')).toBe(true); // ISBN-13 as EAN
    expect(isValidGtin('10614141000415')).toBe(true); // GTIN-14
  });

  it('rejects a wrong check digit, wrong length, non-digits and zeros', () => {
    expect(isValidGtin('4006381333932')).toBe(false);
    expect(isValidGtin('96385075')).toBe(false);
    expect(isValidGtin('123456789')).toBe(false); // 9 digits
    expect(isValidGtin('40063813339')).toBe(false); // 11 digits
    expect(isValidGtin('4006381333A31')).toBe(false);
    expect(isValidGtin('0000000000000')).toBe(false);
    expect(isValidGtin('')).toBe(false);
  });

  it('normalizeGtin trims and maps empty to null', () => {
    expect(normalizeGtin('  4006381333931 ')).toBe('4006381333931');
    expect(normalizeGtin('')).toBeNull();
    expect(normalizeGtin(null)).toBeNull();
  });
});
