import {
  buildKustomAddress,
  BUYER_NAME_MAX_LENGTH,
  CARE_OF_MAX_LENGTH,
  kustomBuyerName,
  kustomCareOf,
} from './kustom.mapper';

// M175: the "c/o" line of an address, read from Kustom and sent back to it.

describe('kustomCareOf', () => {
  it('trims, caps at the column length, null when empty', () => {
    expect(kustomCareOf({ care_of: '  Familjen Lind ' })).toBe('Familjen Lind');
    expect(kustomCareOf({ care_of: 'x'.repeat(300) })).toBe(
      'x'.repeat(CARE_OF_MAX_LENGTH),
    );
    expect(CARE_OF_MAX_LENGTH).toBe(120);
    for (const empty of [undefined, null, '', '   ']) {
      expect(kustomCareOf({ care_of: empty })).toBeNull();
    }
    expect(kustomCareOf(undefined)).toBeNull();
    expect(kustomCareOf(null)).toBeNull();
    // Anything that is not a string is ignored (the body is remote JSON).
    expect(kustomCareOf({ care_of: 5 as unknown as string })).toBeNull();
  });

  it('a cap that lands on a space leaves no trailing space', () => {
    const value = `${'x'.repeat(119)} tail`;
    expect(kustomCareOf({ care_of: value })).toBe('x'.repeat(119));
  });
});

describe('buildKustomAddress (order-first prefill, M175)', () => {
  const order = (care_of?: string | null) => ({
    address: {
      full_name: 'Karin Berg',
      line1: 'Sturegatan 6',
      city: 'Stockholm',
      postal_code: '114 35',
      country_code: 'se',
      care_of,
    },
    customer: { user: { email: 'anna@example.com' } },
  });

  it('sends a stored c/o back to Kustom', () => {
    expect(buildKustomAddress(order(' Familjen Lind '))).toMatchObject({
      given_name: 'Karin',
      family_name: 'Berg',
      street_address: 'Sturegatan 6',
      care_of: 'Familjen Lind',
    });
  });

  it('never sends the key without a value', () => {
    for (const empty of [undefined, null, '', '  ']) {
      expect(buildKustomAddress(order(empty))).not.toHaveProperty('care_of');
    }
  });
});

describe('kustomBuyerName (M175)', () => {
  it('is the billing name, else the shipping name, else null', () => {
    const billing = { given_name: ' Erik ', family_name: 'Berg' };
    const shipping = { given_name: 'Karin', family_name: 'Berg' };
    expect(kustomBuyerName(billing, shipping)).toBe('Erik Berg');
    expect(kustomBuyerName(undefined, shipping)).toBe('Karin Berg');
    expect(kustomBuyerName({ given_name: ' ' }, shipping)).toBe('Karin Berg');
    expect(kustomBuyerName({ family_name: 'Berg' })).toBe('Berg');
    expect(kustomBuyerName(null, null)).toBeNull();
    expect(kustomBuyerName({}, {})).toBeNull();
  });

  it('collapses spaces, ignores non-strings and caps at the column length', () => {
    expect(
      kustomBuyerName({ given_name: 'Anna  Maria', family_name: 'Lind' }),
    ).toBe('Anna Maria Lind');
    expect(
      kustomBuyerName({ given_name: 5 as unknown as string, family_name: 'x' }),
    ).toBe('x');
    expect(kustomBuyerName({ given_name: 'x'.repeat(300) })).toBe(
      'x'.repeat(BUYER_NAME_MAX_LENGTH),
    );
    expect(BUYER_NAME_MAX_LENGTH).toBe(200);
  });
});
