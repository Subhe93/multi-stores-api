import {
  isValidTimezone,
  profileCompleteness,
  validateBankgiro,
  validateBic,
  validateIban,
} from './legal-profile.util';
import { normalizeProfileInput } from './legal-profile.service';

describe('legal profile validators', () => {
  it('IBAN: mod-97 accepts SE/DE examples, rejects a typo and a wrong length', () => {
    expect(validateIban('se45 5000 0000 0583 9825 7466')).toEqual({
      ok: true,
      normalized: 'SE4550000000058398257466',
    });
    expect(validateIban('DE89370400440532013000').ok).toBe(true);
    expect(validateIban('DE89370400440532013001').ok).toBe(false);
    expect(validateIban('SE455000000005839825746').ok).toBe(false);
    expect(validateIban('').ok).toBe(false);
  });

  it('bankgiro: mod-10 with NNN(N)-NNNN formatting', () => {
    expect(validateBankgiro('5050-1055')).toEqual({
      ok: true,
      normalized: '5050-1055',
    });
    expect(validateBankgiro('50501055').normalized).toBe('5050-1055');
    expect(validateBankgiro('991-2346').ok).toBe(true);
    expect(validateBankgiro('5050-1056').ok).toBe(false);
    expect(validateBankgiro('12-34').ok).toBe(false);
  });

  it('BIC: 8 or 11 characters', () => {
    expect(validateBic('esse se ss').ok).toBe(true);
    expect(validateBic('ESSESESS123').ok).toBe(true);
    expect(validateBic('ESSESES').ok).toBe(false);
    expect(validateBic('1SSESESS').ok).toBe(false);
  });

  it('timezone: IANA zones only', () => {
    expect(isValidTimezone('Europe/Stockholm')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });

  it('completeness: VAT number only when VAT is charged; one bank account', () => {
    const base = {
      legal_name: 'Neronet Academy AB',
      org_number: '556036-0793',
      address_line1: 'Storgatan 1',
      postal_code: '11122',
      city: 'Stockholm',
      country_code: 'SE',
      bankgiro: '5050-1055',
    };
    expect(profileCompleteness(base, { chargesVat: false })).toEqual({
      complete: true,
      missing: [],
    });
    expect(profileCompleteness(base, { chargesVat: true }).missing).toEqual([
      'vat_number',
    ]);
    expect(
      profileCompleteness(
        { ...base, bankgiro: null, org_number: ' ' },
        { chargesVat: false },
      ).missing,
    ).toEqual(['org_number', 'iban|bankgiro']);
    expect(
      profileCompleteness(null, { chargesVat: true }).missing,
    ).toHaveLength(8);
  });

  it('normalizeProfileInput maps validator failures to INVOICE_* codes', () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
        return null;
      } catch (e) {
        return (e as { getResponse(): { code: string } }).getResponse().code;
      }
    };
    expect(code(() => normalizeProfileInput({ iban: 'SE00' }))).toBe(
      'INVOICE_IBAN_INVALID',
    );
    expect(code(() => normalizeProfileInput({ bankgiro: '1234-5678' }))).toBe(
      'INVOICE_BANKGIRO_INVALID',
    );
    expect(code(() => normalizeProfileInput({ bic: 'XX' }))).toBe(
      'INVOICE_BIC_INVALID',
    );
    expect(code(() => normalizeProfileInput({ vat_number: 'SE123' }))).toBe(
      'INVOICE_VAT_NUMBER_INVALID',
    );
    expect(
      normalizeProfileInput({
        iban: 'se45 5000 0000 0583 9825 7466',
        vat_number: 'se 556036079301',
        city: '  ',
        bankgiro: '50501055',
      }),
    ).toEqual({
      iban: 'SE4550000000058398257466',
      vat_number: 'SE556036079301',
      city: null,
      bankgiro: '5050-1055',
    });
  });
});
