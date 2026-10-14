import {
  applyRounding,
  convertAmount,
  resolveMarketPrice,
  resolveVariantMarketPrice,
  type PricingContext,
} from './pricing.util';

// The pure price math every market hook is built on: conversion, the
// rounding rule, and which override wins.

const sek = (rate: number | null, rounding?: object) => ({
  currency: 'SEK',
  rate,
  ...(rounding ? { rounding } : {}),
});

describe('convertAmount', () => {
  it('multiplies by the rate', () => {
    expect(convertAmount(10, 11.2)).toBeCloseTo(112);
  });

  it('guards NaN, negative and zero rates', () => {
    expect(convertAmount(NaN, 1)).toBe(0);
    expect(convertAmount(10, NaN)).toBe(0);
    expect(convertAmount(10, 0)).toBe(0);
    expect(convertAmount(10, -1)).toBe(0);
  });
});

describe('applyRounding', () => {
  it('is roundMoney with no rule', () => {
    expect(applyRounding(27.456, undefined, 'EUR')).toBe(27.46);
    expect(applyRounding(27.456, {}, 'EUR')).toBe(27.46);
  });

  it('rounds to the increment', () => {
    expect(applyRounding(27.46, { increment: 1 }, 'EUR')).toBe(27);
    expect(applyRounding(27.56, { increment: 1 }, 'EUR')).toBe(28);
    expect(applyRounding(27.3, { increment: 0.5 }, 'EUR')).toBe(27.5);
    expect(applyRounding(27.34, { increment: 0.1 }, 'EUR')).toBe(27.3);
  });

  it('moves to the nearest decimal ending', () => {
    expect(applyRounding(27.4, { ending: '.99' }, 'EUR')).toBe(26.99);
    expect(applyRounding(27.6, { ending: '.99' }, 'EUR')).toBe(27.99);
    expect(applyRounding(27.99, { ending: '.99' }, 'EUR')).toBe(27.99);
    expect(applyRounding(27.4, { ending: '.90' }, 'EUR')).toBe(27.9);
    expect(applyRounding(27.2, { ending: '.95' }, 'EUR')).toBe(26.95);
    // Never below zero: a 0.3 price becomes 0.99, not -0.01.
    expect(applyRounding(0.3, { ending: '.99' }, 'EUR')).toBe(0.99);
  });

  it('moves to whole-number endings', () => {
    expect(applyRounding(27.5, { ending: '9' }, 'SEK')).toBe(29);
    expect(applyRounding(23, { ending: '9' }, 'SEK')).toBe(19);
    expect(applyRounding(3, { ending: '9' }, 'SEK')).toBe(9);
    expect(applyRounding(27.5, { ending: '0' }, 'SEK')).toBe(30);
    expect(applyRounding(24, { ending: '0' }, 'SEK')).toBe(20);
    expect(applyRounding(3, { ending: '0' }, 'SEK')).toBe(10);
  });

  it('applies the increment before the ending', () => {
    expect(applyRounding(27.26, { increment: 0.5, ending: '.99' }, 'EUR')).toBe(
      27.99,
    );
  });

  it('ignores decimal endings for zero-decimal currencies', () => {
    expect(applyRounding(1234.6, { ending: '.99' }, 'JPY')).toBe(1235);
    expect(applyRounding(1234.6, { ending: '0' }, 'JPY')).toBe(1230);
  });

  it('guards non-finite and non-positive amounts', () => {
    expect(applyRounding(NaN, { ending: '.99' }, 'EUR')).toBe(0);
    expect(applyRounding(0, { ending: '.99' }, 'EUR')).toBe(0);
    expect(applyRounding(-5, { ending: '9' }, 'EUR')).toBe(-5);
  });
});

describe('resolveMarketPrice', () => {
  it('converts and rounds when there is no override', () => {
    expect(
      resolveMarketPrice({
        basePrice: 299,
        override: null,
        ctx: { currency: 'EUR', rate: 0.0936, rounding: { ending: '.99' } },
      }),
    ).toBe(27.99);
  });

  it('lets the product override win, rounded to the currency', () => {
    expect(
      resolveMarketPrice({
        basePrice: 299,
        override: 25.5,
        ctx: sek(10, { ending: '9' }),
      }),
    ).toBe(25.5);
  });

  it('is null (hidden) in fixed mode without a rate and no override', () => {
    expect(
      resolveMarketPrice({ basePrice: 299, override: null, ctx: sek(null) }),
    ).toBeNull();
    expect(
      resolveMarketPrice({ basePrice: 299, override: 30, ctx: sek(null) }),
    ).toBe(30);
  });
});

describe('resolveVariantMarketPrice', () => {
  const ctx: PricingContext = {
    currency: 'EUR',
    rate: 0.1,
    rounding: { ending: '.99' },
  };

  it('variant override wins over everything', () => {
    expect(
      resolveVariantMarketPrice({
        basePrice: 299,
        adjustment: 50,
        productOverride: 25,
        variantOverride: 31.5,
        ctx,
      }),
    ).toBe(31.5);
  });

  it('product override plus the converted adjustment', () => {
    expect(
      resolveVariantMarketPrice({
        basePrice: 299,
        adjustment: 50,
        productOverride: 25,
        variantOverride: null,
        ctx,
      }),
    ).toBe(30);
    // No adjustment: the override as is.
    expect(
      resolveVariantMarketPrice({
        basePrice: 299,
        adjustment: 0,
        productOverride: 25,
        variantOverride: null,
        ctx,
      }),
    ).toBe(25);
  });

  it('converts base + adjustment with the rule when nothing is overridden', () => {
    expect(
      resolveVariantMarketPrice({
        basePrice: 299,
        adjustment: 50,
        productOverride: null,
        variantOverride: null,
        ctx,
      }),
    ).toBe(34.99);
  });

  it('fixed mode without a rate: only overrides price, else hidden', () => {
    expect(
      resolveVariantMarketPrice({
        basePrice: 299,
        adjustment: 50,
        productOverride: null,
        variantOverride: null,
        ctx: sek(null),
      }),
    ).toBeNull();
    expect(
      resolveVariantMarketPrice({
        basePrice: 299,
        adjustment: 50,
        productOverride: 25,
        variantOverride: null,
        ctx: sek(null),
      }),
    ).toBeNull();
    expect(
      resolveVariantMarketPrice({
        basePrice: 299,
        adjustment: 50,
        productOverride: null,
        variantOverride: 40,
        ctx: sek(null),
      }),
    ).toBe(40);
  });
});
