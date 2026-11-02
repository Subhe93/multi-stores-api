import { BadRequestException } from '@nestjs/common';
import {
  isValidSwedishOrgNumber,
  luhnValid,
  normalizeSwedishOrgNumber,
  traderDetailsComplete,
  validateTraderDetails,
} from './trader-details';
import { isReservedStoreSlug } from '../../common/slug/reserved-store-slugs';
import { isDisposableEmail } from '../../common/email/disposable-domains';

// SPEC §1: trader details validation (Swedish Luhn org numbers, VAT format),
// the reserved store slugs and the disposable-domain denylist.

const valid = {
  legal_name: 'Namez AB',
  business_type: 'company',
  org_number: '556016-0680',
  vat_number: 'SE556016068001',
  address_line1: 'Storgatan 1',
  postal_code: '111 22',
  city: 'Stockholm',
  country: 'se',
  phone: '+46 70 123 45 67',
  support_email: 'Support@Namez.se',
};

describe('Swedish org number (Luhn)', () => {
  it('accepts valid company and personal numbers in every common shape', () => {
    expect(luhnValid('5560160680')).toBe(true);
    expect(isValidSwedishOrgNumber('556016-0680')).toBe(true);
    expect(isValidSwedishOrgNumber('5560160680')).toBe(true);
    expect(isValidSwedishOrgNumber('165560160680')).toBe(true);
    // Personnummer (test number from Skatteverket's public samples).
    expect(isValidSwedishOrgNumber('811218-9876')).toBe(true);
    expect(isValidSwedishOrgNumber('198112189876')).toBe(true);
    expect(normalizeSwedishOrgNumber('19811218-9876')).toBe('8112189876');
  });

  it('rejects a wrong checksum, letters and odd lengths', () => {
    expect(isValidSwedishOrgNumber('556016-0681')).toBe(false);
    expect(isValidSwedishOrgNumber('55601606')).toBe(false);
    expect(isValidSwedishOrgNumber('ABC016-0680')).toBe(false);
    expect(isValidSwedishOrgNumber('')).toBe(false);
    expect(luhnValid('12a4')).toBe(false);
  });
});

describe('validateTraderDetails', () => {
  it('normalises a valid record and stamps completed_at', () => {
    const now = new Date('2026-11-12T10:00:00Z');
    const out = validateTraderDetails(valid, now);
    expect(out).toEqual({
      legal_name: 'Namez AB',
      business_type: 'company',
      org_number: '5560160680',
      vat_number: 'SE556016068001',
      address_line1: 'Storgatan 1',
      postal_code: '111 22',
      city: 'Stockholm',
      country: 'SE',
      phone: '+46 70 123 45 67',
      support_email: 'support@namez.se',
      completed_at: now.toISOString(),
    });
    expect(traderDetailsComplete(out)).toBe(true);
  });

  it('lists every offending field in TRADER_DETAILS_INVALID', () => {
    const err = (() => {
      try {
        validateTraderDetails({
          ...valid,
          legal_name: '',
          org_number: '556016-0681',
          vat_number: 'bad',
          support_email: 'nope',
          business_type: 'ngo',
        });
      } catch (e) {
        return e as BadRequestException;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err!.getResponse()).toMatchObject({
      code: 'TRADER_DETAILS_INVALID',
      fields: expect.arrayContaining([
        'legal_name',
        'org_number',
        'vat_number',
        'support_email',
        'business_type',
      ]),
    });
  });

  it('only checks the Luhn checksum for Swedish traders; VAT and line2 are optional', () => {
    const out = validateTraderDetails({
      ...valid,
      country: 'DE',
      org_number: 'HRB 12345',
      vat_number: undefined,
      business_type: 'private',
    });
    expect(out.org_number).toBe('HRB 12345');
    expect(out).not.toHaveProperty('vat_number');
    expect(out).not.toHaveProperty('address_line2');
  });

  it('traderDetailsComplete is false for null, partial or invalid records', () => {
    expect(traderDetailsComplete(null)).toBe(false);
    expect(traderDetailsComplete({ legal_name: 'X' })).toBe(false);
    expect(traderDetailsComplete({ ...valid, org_number: '1' })).toBe(false);
  });
});

describe('reserved store slugs', () => {
  it('refuses platform hostnames and paths, case-insensitively', () => {
    for (const slug of ['www', 'api', 'admin', 'checkout', 'namez', 'ms-dash']) {
      expect(isReservedStoreSlug(slug)).toBe(true);
    }
    expect(isReservedStoreSlug('ADMIN')).toBe(true);
    expect(isReservedStoreSlug('my-shop')).toBe(false);
    expect(isReservedStoreSlug('admin-tools')).toBe(false);
  });
});

describe('disposable email domains', () => {
  it('matches the domain and its subdomains, never ordinary providers', () => {
    expect(isDisposableEmail('x@mailinator.com')).toBe(true);
    expect(isDisposableEmail('x@MAILINATOR.COM')).toBe(true);
    expect(isDisposableEmail('x@abc.guerrillamail.com')).toBe(true);
    expect(isDisposableEmail('x@gmail.com')).toBe(false);
    expect(isDisposableEmail('x@notmailinator.com')).toBe(false);
    expect(isDisposableEmail('no-at-sign')).toBe(false);
  });
});
