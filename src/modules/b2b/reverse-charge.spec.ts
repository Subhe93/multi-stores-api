import { DEFAULT_B2B_SETTINGS, type VatEvidence } from './b2b.types';
import {
  decideTaxExemption,
  whyOfVatStatus,
  type CustomerExemptionRef,
  type ExemptionInputs,
} from './reverse-charge';

// D2 / D4: every branch of the pure reverse-charge decision.

const SE_STORE = { registrant: 'STORE' as const, taxCountry: 'SE' };

function vat(
  number: string,
  status: VatEvidence['status'] = 'valid',
): VatEvidence {
  return {
    source: 'VIES',
    vat_number: number,
    country_code: number.slice(0, 2),
    status,
    valid: status === 'valid',
    name: 'Muster GmbH',
    address: 'Musterstr. 1',
    request_identifier: null,
    requester: null,
    checked_at: '2026-10-15T09:12:00.000Z',
    check_id: 'chk-1',
    error_code: null,
  };
}

function inputs(over: Partial<ExemptionInputs> = {}): ExemptionInputs {
  return {
    settings: { ...DEFAULT_B2B_SETTINGS, reverse_charge_enabled: true },
    vat: vat('DE123456789'),
    customerExemption: null,
    ...over,
  };
}

const decide = (over: Partial<Parameters<typeof decideTaxExemption>[0]> = {}) =>
  decideTaxExemption({
    ctx: SE_STORE,
    destinationCountry: 'DE',
    buyerType: 'COMPANY',
    inputs: inputs(),
    ...over,
  });

const why = (d: ReturnType<typeof decideTaxExemption>) =>
  d.reason === null ? d.why : null;

describe('decideTaxExemption', () => {
  it('SE seller, DE company with a valid DE number: reverse charge', () => {
    const d = decide();
    expect(d.reason).toBe('REVERSE_CHARGE');
    if (d.reason) {
      expect(d.evidence).toMatchObject({
        vat_number: 'DE123456789',
        seller_country: 'SE',
        destination_country: 'DE',
        vat_country_matches_destination: true,
        check_id: 'chk-1',
      });
    }
  });

  it('SE to SE: SAME_COUNTRY', () => {
    expect(why(decide({ destinationCountry: 'SE' }))).toBe('SAME_COUNTRY');
  });

  it('SE to NO: DESTINATION_NOT_EU', () => {
    expect(why(decide({ destinationCountry: 'NO' }))).toBe(
      'DESTINATION_NOT_EU',
    );
  });

  it('no destination yet: NO_DESTINATION', () => {
    expect(why(decide({ destinationCountry: null }))).toBe('NO_DESTINATION');
  });

  it('NO seller: SELLER_NOT_EU', () => {
    expect(
      why(decide({ ctx: { registrant: 'STORE', taxCountry: 'NO' } })),
    ).toBe('SELLER_NOT_EU');
  });

  it('MARKETPLACE: the platform is the registrant', () => {
    expect(
      why(decide({ ctx: { registrant: 'PLATFORM', taxCountry: 'SE' } })),
    ).toBe('MARKETPLACE');
  });

  it('SE number shipped to DE: VAT_COUNTRY_IS_SELLER', () => {
    expect(
      why(decide({ inputs: inputs({ vat: vat('SE556036079301') }) })),
    ).toBe('VAT_COUNTRY_IS_SELLER');
  });

  it('DE number shipped to FR: reverse charge, mismatch recorded', () => {
    const d = decide({ destinationCountry: 'FR' });
    expect(d.reason).toBe('REVERSE_CHARGE');
    if (d.reason) {
      expect(d.evidence.vat_country_matches_destination).toBe(false);
    }
  });

  it('EL number shipped to GR matches the destination', () => {
    const d = decide({
      destinationCountry: 'GR',
      inputs: inputs({ vat: vat('EL123456789') }),
    });
    expect(d.reason).toBe('REVERSE_CHARGE');
    if (d.reason) expect(d.evidence.vat_country_matches_destination).toBe(true);
  });

  it('invalid / format / not EU: VAT_INVALID; unavailable: VAT_UNAVAILABLE', () => {
    for (const s of ['invalid', 'format_invalid', 'not_eu'] as const) {
      expect(
        why(decide({ inputs: inputs({ vat: vat('DE123456789', s) }) })),
      ).toBe('VAT_INVALID');
    }
    expect(
      why(
        decide({ inputs: inputs({ vat: vat('DE123456789', 'unavailable') }) }),
      ),
    ).toBe('VAT_UNAVAILABLE');
  });

  it('no number: NO_VAT', () => {
    expect(why(decide({ inputs: inputs({ vat: null }) }))).toBe('NO_VAT');
  });

  it('a PERSON with a number: no reverse charge', () => {
    expect(why(decide({ buyerType: 'PERSON' }))).toBe('PERSON');
  });

  it('app or setting off: APP_OFF', () => {
    expect(why(decide({ inputs: null }))).toBe('APP_OFF');
    expect(
      why(
        decide({
          inputs: inputs({
            settings: {
              ...DEFAULT_B2B_SETTINGS,
              reverse_charge_enabled: false,
            },
          }),
        }),
      ),
    ).toBe('APP_OFF');
  });

  const full: CustomerExemptionRef = {
    id: 'ex-1',
    kind: 'FULL',
    vat_number: null,
    created_at: new Date('2026-10-01T08:00:00Z'),
  };
  const manualRc: CustomerExemptionRef = {
    id: 'ex-2',
    kind: 'REVERSE_CHARGE',
    vat_number: 'DE123456789',
  };

  it('FULL exemption with SE to SE: CUSTOMER_EXEMPT (any buyer type)', () => {
    for (const buyerType of ['COMPANY', 'PERSON'] as const) {
      const d = decide({
        destinationCountry: 'SE',
        buyerType,
        inputs: inputs({ vat: null, customerExemption: full }),
      });
      expect(d.reason).toBe('CUSTOMER_EXEMPT');
      if (d.reason) {
        expect(d.evidence).toMatchObject({
          source: 'MANUAL',
          exemption_id: 'ex-1',
          exemption_kind: 'FULL',
          exemption_created_at: '2026-10-01T08:00:00.000Z',
        });
        // The merchant's private note never reaches the evidence.
        expect(d.evidence).not.toHaveProperty('note');
      }
    }
  });

  it('manual RC exemption skips VIES but keeps the territory rules', () => {
    const d = decide({
      inputs: inputs({
        vat: vat('DE123456789', 'unavailable'),
        customerExemption: manualRc,
      }),
    });
    expect(d.reason).toBe('REVERSE_CHARGE');
    if (d.reason) {
      expect(d.evidence).toMatchObject({
        source: 'MANUAL',
        exemption_kind: 'REVERSE_CHARGE',
        vat_number: 'DE123456789',
        destination_country: 'DE',
      });
    }
    expect(
      why(
        decide({
          destinationCountry: 'SE',
          inputs: inputs({ customerExemption: manualRc }),
        }),
      ),
    ).toBe('SAME_COUNTRY');
    expect(
      why(
        decide({
          inputs: inputs({
            vat: null,
            customerExemption: { ...manualRc, vat_number: 'SE556036079301' },
          }),
        }),
      ),
    ).toBe('VAT_COUNTRY_IS_SELLER');
  });

  it('a revoked exemption is never loaded, so it is ignored', () => {
    // prepare() only selects revoked_at = null rows: no exemption here.
    expect(
      why(
        decide({
          destinationCountry: 'SE',
          inputs: inputs({ customerExemption: null }),
        }),
      ),
    ).toBe('SAME_COUNTRY');
  });
});

describe('whyOfVatStatus', () => {
  it('maps statuses without a destination', () => {
    expect(whyOfVatStatus('valid')).toBeNull();
    expect(whyOfVatStatus('invalid')).toBe('VAT_INVALID');
    expect(whyOfVatStatus('format_invalid')).toBe('VAT_INVALID');
    expect(whyOfVatStatus('unavailable')).toBe('VAT_UNAVAILABLE');
  });
});
