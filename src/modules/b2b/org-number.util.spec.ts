import {
  luhnValid,
  normalizeOrgNumber,
  validateOrgNumber,
} from './org-number.util';

// Format rules of the b2b app (D7). Strict rules apply only to the
// countries a store lists; everything else takes the generic format.

const SE = { strictCountries: ['SE'] };
const NORDIC = { strictCountries: ['SE', 'FI', 'DK', 'NO'] };

describe('validateOrgNumber: Sweden (Luhn)', () => {
  it('accepts a valid number with or without the hyphen and normalises it', () => {
    expect(validateOrgNumber('SE', '556036-0793', SE)).toMatchObject({
      ok: true,
      normalized: '556036-0793',
      country: 'SE',
      format: 'NNNNNN-NNNN',
    });
    expect(validateOrgNumber('se', '5560360793', SE).normalized).toBe(
      '556036-0793',
    );
    expect(validateOrgNumber('SE', ' 556 016-0680 ', SE).normalized).toBe(
      '556016-0680',
    );
    // The 12-digit VAT-style form is reduced to the 10-digit number.
    expect(validateOrgNumber('SE', '165560360793', SE).normalized).toBe(
      '556036-0793',
    );
  });

  it('rejects a Luhn failure (typo) and keeps the input as typed', () => {
    const r = validateOrgNumber('SE', '559123-4567', SE);
    expect(r).toMatchObject({
      ok: false,
      reason: 'CHECKSUM',
      normalized: '559123-4567',
      format: 'NNNNNN-NNNN',
    });
  });

  it('rejects a number that is too short or not digits', () => {
    expect(validateOrgNumber('SE', '55603', SE)).toMatchObject({
      ok: false,
      reason: 'FORMAT',
    });
    expect(validateOrgNumber('SE', 'HRB 12345', SE)).toMatchObject({
      ok: false,
      reason: 'FORMAT',
    });
  });

  it('reports an empty input as EMPTY with the expected format', () => {
    expect(validateOrgNumber('SE', '   ', SE)).toEqual({
      ok: false,
      normalized: '',
      reason: 'EMPTY',
      format: 'NNNNNN-NNNN',
      country: 'SE',
    });
    expect(validateOrgNumber('DE', null).reason).toBe('EMPTY');
  });
});

describe('validateOrgNumber: FI / DK / NO', () => {
  it('Finland: Y-tunnus with the mod-11 check digit', () => {
    expect(validateOrgNumber('FI', '0112038-9', NORDIC)).toMatchObject({
      ok: true,
      normalized: '0112038-9',
    });
    expect(validateOrgNumber('FI', '01120389', NORDIC).normalized).toBe(
      '0112038-9',
    );
    expect(validateOrgNumber('FI', '0112038-8', NORDIC).reason).toBe(
      'CHECKSUM',
    );
  });

  it('Denmark: 8-digit CVR with mod-11 weights', () => {
    expect(validateOrgNumber('DK', '22 75 62 14', NORDIC)).toMatchObject({
      ok: true,
      normalized: '22756214',
    });
    expect(validateOrgNumber('DK', '22756215', NORDIC).reason).toBe('CHECKSUM');
  });

  it('Norway: 9-digit organisasjonsnummer, trailing MVA ignored', () => {
    expect(validateOrgNumber('NO', '923 609 016', NORDIC)).toMatchObject({
      ok: true,
      normalized: '923609016',
    });
    expect(validateOrgNumber('NO', '923609016MVA', NORDIC).ok).toBe(true);
    expect(validateOrgNumber('NO', '923609017', NORDIC).reason).toBe(
      'CHECKSUM',
    );
  });
});

describe('validateOrgNumber: generic rule', () => {
  it('accepts a German registry number and other free forms (4-20 chars)', () => {
    expect(validateOrgNumber('DE', 'HRB 12345')).toMatchObject({
      ok: true,
      normalized: 'HRB 12345',
      country: null,
      format: '4-20 characters',
    });
    expect(validateOrgNumber('DE', '  HRB   12345 ').normalized).toBe(
      'HRB 12345',
    );
    expect(validateOrgNumber('US', '12-3456789').ok).toBe(true);
  });

  it('rejects too short / too long / odd characters', () => {
    expect(validateOrgNumber('DE', 'AB1').reason).toBe('FORMAT');
    expect(validateOrgNumber('DE', '1'.repeat(21)).reason).toBe('FORMAT');
    expect(validateOrgNumber('DE', 'HRB#12345').reason).toBe('FORMAT');
  });

  it('applies the generic rule to a country not in the strict list', () => {
    // SE is not listed: a Luhn failure passes as a generic string.
    expect(
      validateOrgNumber('SE', '559123-4567', { strictCountries: ['FI'] }),
    ).toMatchObject({ ok: true, normalized: '559123-4567', country: null });
    // Listed but without a rule: generic as well (L7).
    expect(
      validateOrgNumber('DE', 'HRB 12345', { strictCountries: ['DE'] }),
    ).toMatchObject({ ok: true, country: null });
  });
});

describe('normalizeOrgNumber / luhnValid', () => {
  it('returns the pretty form when valid for the country, else the input', () => {
    expect(normalizeOrgNumber('SE', '5560360793')).toBe('556036-0793');
    expect(normalizeOrgNumber('SE', '559123-4567')).toBe('559123-4567');
    expect(normalizeOrgNumber(null, ' HRB  1 ')).toBe('HRB 1');
    expect(normalizeOrgNumber('DE', '')).toBe('');
  });

  it('luhnValid', () => {
    expect(luhnValid('5560360793')).toBe(true);
    expect(luhnValid('5591234567')).toBe(false);
    expect(luhnValid('55x0360793')).toBe(false);
  });
});
