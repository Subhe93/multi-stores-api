import { PricingType, TaxBasis, TaxPricingMode } from '@prisma/client';
import {
  bundleUnitBelowFloor,
  findPriceFloorViolation,
  floorDestinations,
  highestRateBp,
  minimumCustomerPrice,
} from './price-floor';
import type { TaxContext, TaxData } from '../taxes/tax.service';

// Marketplace minimum customer price of a custom product: the provider base
// (net) plus VAT when the store's prices include VAT, rounded up to the cent.

describe('minimumCustomerPrice', () => {
  it.each([
    [15, 2500, 18.75],
    [15, 1200, 16.8],
    [15, 600, 15.9],
    [9.99, 2500, 12.49], // 12.4875 rounded up, never below base + VAT
    [10, 0, 10],
    [0, 2500, 0],
  ])('base %p at %p bp incl. VAT -> %p', (base, bp, expected) => {
    expect(minimumCustomerPrice(base, bp, true)).toBe(expected);
  });

  it('prices excl. VAT: the minimum is the base itself', () => {
    expect(minimumCustomerPrice(15, 2500, false)).toBe(15);
    expect(minimumCustomerPrice(9.99, 1200, false)).toBe(9.99);
  });

  it('the net of the minimum always covers the base', () => {
    for (const base of [0.01, 1.11, 7.77, 9.99, 13.37, 99.95]) {
      for (const bp of [600, 1200, 2500]) {
        const min = minimumCustomerPrice(base, bp, true);
        const vat = Math.round((min * 100 * bp) / (10000 + bp));
        expect(Math.round(min * 100) - vat).toBeGreaterThanOrEqual(
          Math.round(base * 100),
        );
      }
    }
  });
});

describe('findPriceFloorViolation', () => {
  const variants = [
    { variant_id: 'v-s', price_adjustment: 0 },
    { variant_id: 'v-xl', price_adjustment: 2 },
  ];

  it('SINGLE: the one price must reach the highest variant minimum', () => {
    const input = {
      pricingType: PricingType.SINGLE,
      finalPrice: 18.75,
      marginAmount: 0,
      basePrice: 15,
      variants,
    };
    // XL costs 17 net -> 21.25 incl. 25 % VAT.
    expect(findPriceFloorViolation(input, 2500, true)).toEqual({
      minimum: 21.25,
      price: 18.75,
      variant_id: 'v-xl',
    });
    expect(
      findPriceFloorViolation({ ...input, finalPrice: 21.25 }, 2500, true),
    ).toBeNull();
  });

  it('SINGLE without variants: base + VAT; 18.74 is one cent short', () => {
    const input = {
      pricingType: PricingType.SINGLE,
      finalPrice: 18.74,
      marginAmount: 0,
      basePrice: 15,
      variants: [],
    };
    expect(findPriceFloorViolation(input, 2500, true)).toEqual({
      minimum: 18.75,
      price: 18.74,
    });
    expect(
      findPriceFloorViolation({ ...input, finalPrice: 18.75 }, 2500, true),
    ).toBeNull();
  });

  it('SINGLE at 12 % and 6 %', () => {
    const at = (finalPrice: number, bp: number) =>
      findPriceFloorViolation(
        {
          pricingType: PricingType.SINGLE,
          finalPrice,
          marginAmount: 0,
          basePrice: 15,
          variants: [],
        },
        bp,
        true,
      );
    expect(at(16.79, 1200)?.minimum).toBe(16.8);
    expect(at(16.8, 1200)).toBeNull();
    expect(at(15.89, 600)?.minimum).toBe(15.9);
    expect(at(15.9, 600)).toBeNull();
  });

  it('excl.-VAT store: the base itself is enough', () => {
    const input = {
      pricingType: PricingType.SINGLE,
      finalPrice: 15,
      marginAmount: 0,
      basePrice: 15,
      variants: [],
    };
    expect(findPriceFloorViolation(input, 2500, false)).toBeNull();
    expect(
      findPriceFloorViolation({ ...input, finalPrice: 14.99 }, 2500, false),
    ).toEqual({ minimum: 15, price: 14.99 });
  });

  it('PER_VARIANT: each variant against its own minimum', () => {
    const input = {
      pricingType: PricingType.PER_VARIANT,
      finalPrice: 0,
      marginAmount: 0,
      basePrice: 15,
      variants: [
        { variant_id: 'v-s', price_adjustment: 0, custom_price: 18.75 },
        { variant_id: 'v-xl', price_adjustment: 2, custom_price: 21 },
      ],
    };
    expect(findPriceFloorViolation(input, 2500, true)).toEqual({
      minimum: 21.25,
      price: 21,
      variant_id: 'v-xl',
    });
    input.variants[1].custom_price = 21.25;
    expect(findPriceFloorViolation(input, 2500, true)).toBeNull();
  });

  it('PER_VARIANT: a variant without a price sells at its net cost (too low)', () => {
    expect(
      findPriceFloorViolation(
        {
          pricingType: PricingType.PER_VARIANT,
          finalPrice: 0,
          marginAmount: 0,
          basePrice: 15,
          variants: [{ variant_id: 'v-s', price_adjustment: 0 }],
        },
        1200,
        true,
      ),
    ).toEqual({ minimum: 16.8, price: 15, variant_id: 'v-s' });
  });

  it('MARGIN: the margin must cover the VAT of the most expensive variant', () => {
    const input = {
      pricingType: PricingType.MARGIN,
      finalPrice: 0,
      marginAmount: 3.75,
      basePrice: 15,
      variants,
    };
    // S needs 3.75, XL (17 net) needs 4.25.
    expect(findPriceFloorViolation(input, 2500, true)).toEqual({
      minimum: 21.25,
      price: 20.75,
      minimum_margin: 4.25,
      variant_id: 'v-xl',
    });
    expect(
      findPriceFloorViolation({ ...input, marginAmount: 4.25 }, 2500, true),
    ).toBeNull();
  });

  it('MARGIN in an excl.-VAT store: any margin >= 0 passes', () => {
    expect(
      findPriceFloorViolation(
        {
          pricingType: PricingType.MARGIN,
          finalPrice: 0,
          marginAmount: 0,
          basePrice: 15,
          variants,
        },
        2500,
        false,
      ),
    ).toBeNull();
  });
});

describe('floorDestinations', () => {
  it('registration country (null) without market countries', () => {
    expect(floorDestinations(null)).toEqual([null]);
    expect(floorDestinations([[], null])).toEqual([null]);
  });

  it('every market country, upper-cased and de-duplicated', () => {
    expect(
      floorDestinations([
        ['se', 'NO'],
        ['SE', 'hu'],
      ]),
    ).toEqual([{ country: 'SE' }, { country: 'NO' }, { country: 'HU' }]);
  });
});

describe('highestRateBp (SE 25 % vs HU 27 %)', () => {
  const ctx = (ossRegistered: boolean): TaxContext => ({
    registrant: 'PLATFORM',
    storeId: 's1',
    rateStoreId: null,
    taxCountry: 'SE',
    pricingMode: TaxPricingMode.INCLUSIVE,
    basis: TaxBasis.SHIPPING,
    ossRegistered,
    usePlatformRates: true,
    shippingTaxClassId: null,
    displayPricesInclTax: true,
  });
  const rate = (country: string, bp: number) => ({
    id: `r-${country}`,
    store_id: null,
    tax_class_id: 'std',
    country,
    region: null,
    postcode_pattern: null,
    rate_bp: bp,
    label: {},
    priority: 0,
    applies_to_shipping: true,
    is_active: true,
  });
  const data: TaxData = {
    classes: [
      {
        id: 'std',
        store_id: null,
        key: 'standard',
        name: {},
        is_default: true,
      },
    ],
    rates: [rate('SE', 2500), rate('HU', 2700)],
  };
  const product = { tax_class_id: null, tax_exempt: false };
  const dests = floorDestinations([['SE'], ['HU']]);

  it('OSS: selling to HU lifts the minimum to the 27 % rate', () => {
    const bp = highestRateBp(ctx(true), data, product, dests);
    expect(bp).toBe(2700);
    expect(minimumCustomerPrice(100, bp, true)).toBe(127);
  });

  it('no OSS: HU is taxed at the Swedish rate, so 25 %', () => {
    expect(highestRateBp(ctx(false), data, product, dests)).toBe(2500);
  });

  it('no market countries: the registration country rate', () => {
    expect(highestRateBp(ctx(true), data, product, [null])).toBe(2500);
  });
});

describe('bundleUnitBelowFloor (checkout = attach-time floor)', () => {
  it('incl. VAT: the gross bundle price must reach base + VAT', () => {
    // base 15 at 25 % -> floor 18.75
    expect(bundleUnitBelowFloor(18.74, 15, 2500, true)).toBe(true);
    expect(bundleUnitBelowFloor(18.75, 15, 2500, true)).toBe(false);
    // A gross 16.00 covers the net base 15 but not base + VAT.
    expect(bundleUnitBelowFloor(16, 15, 2500, true)).toBe(true);
  });

  it('excl. VAT or no rate: the net base itself', () => {
    expect(bundleUnitBelowFloor(15, 15, 2500, false)).toBe(false);
    expect(bundleUnitBelowFloor(14.99, 15, 0, true)).toBe(true);
  });

  it('no provider base: never below', () => {
    expect(bundleUnitBelowFloor(0, 0, 2500, true)).toBe(false);
  });
});
