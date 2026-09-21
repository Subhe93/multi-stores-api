import { TaxBasis, TaxPricingMode } from '@prisma/client';
import {
  computeTaxes,
  effectiveRateBp,
  postcodeMatches,
  resolveRatesForLine,
  type TaxClassRow,
  type TaxComputeInput,
  type TaxContext,
  type TaxData,
  type TaxRateRow,
} from './tax.service';

// The engine is pure: every scenario below builds a context + rate table
// and checks the numbers the contract (API-CONTRACT-TAX.md §2) prescribes.

const VAT = { en: 'VAT', sv: 'Moms', de: 'MwSt.' };

function cls(
  id: string,
  key: string,
  extra: Partial<TaxClassRow> = {},
): TaxClassRow {
  return {
    id,
    store_id: null,
    key,
    name: { en: key },
    is_default: false,
    ...extra,
  };
}

let seq = 0;
function rate(
  classId: string,
  country: string,
  rateBp: number,
  extra: Partial<TaxRateRow> = {},
): TaxRateRow {
  seq += 1;
  return {
    id: `rate-${seq}`,
    store_id: null,
    tax_class_id: classId,
    country,
    region: null,
    postcode_pattern: null,
    rate_bp: rateBp,
    label: VAT,
    priority: 0,
    applies_to_shipping: true,
    is_active: true,
    ...extra,
  };
}

const CLASSES: TaxClassRow[] = [
  cls('std', 'standard', { is_default: true }),
  cls('red', 'reduced'),
  cls('zero', 'zero'),
];

const EU_RATES: TaxRateRow[] = [
  rate('std', 'SE', 2500),
  rate('red', 'SE', 1200),
  rate('std', 'DE', 1900),
  rate('red', 'DE', 700),
  rate('std', 'FR', 2000),
];

function context(overrides: Partial<TaxContext> = {}): TaxContext {
  return {
    registrant: 'STORE',
    storeId: 'store-1',
    rateStoreId: 'store-1',
    taxCountry: 'SE',
    pricingMode: TaxPricingMode.INCLUSIVE,
    basis: TaxBasis.SHIPPING,
    ossRegistered: false,
    usePlatformRates: true,
    shippingTaxClassId: null,
    displayPricesInclTax: true,
    ...overrides,
  };
}

function compute(
  overrides: Partial<Omit<TaxComputeInput, 'ctx' | 'data'>> & {
    ctx?: Partial<TaxContext>;
  } = {},
  data: TaxData = { classes: CLASSES, rates: EU_RATES },
) {
  const { ctx: ctxOverrides, ...rest } = overrides;
  return computeTaxes({
    ctx: context(ctxOverrides),
    data,
    currency: 'SEK',
    locale: 'sv',
    lines: [{ amount: 100, tax_class_id: null, tax_exempt: false }],
    shipping_cost: 0,
    discount_amount: 0,
    shipping: { country: 'SE' },
    ...rest,
  });
}

const sumTaxLines = (r: ReturnType<typeof computeTaxes>) =>
  Math.round(r.tax_lines.reduce((s, l) => s + l.tax_amount, 0) * 100) / 100;

describe('computeTaxes: inclusive vs exclusive', () => {
  it('INCLUSIVE splits the tax out of the gross and leaves the total alone', () => {
    const r = compute({
      lines: [{ amount: 125, tax_class_id: null, tax_exempt: false }],
      shipping_cost: 49,
    });
    expect(r.items[0]).toMatchObject({
      tax_rate_bp: 2500,
      tax_amount: 25,
      tax_class_key: 'standard',
      gross: 125,
    });
    expect(r.shipping_tax_amount).toBe(9.8);
    expect(r.shipping_tax_rate_bp).toBe(2500);
    expect(r.tax_total).toBe(34.8);
    expect(r.total).toBe(174);
    expect(r.headline_rate_bp).toBe(2500);
    expect(r.tax_pricing_mode).toBe('INCLUSIVE');
    expect(r.tax_basis_country).toBe('SE');
  });

  it('EXCLUSIVE adds the tax on top of the net and the total', () => {
    const r = compute({
      ctx: { pricingMode: TaxPricingMode.EXCLUSIVE },
      lines: [{ amount: 100, tax_class_id: null, tax_exempt: false }],
      shipping_cost: 40,
    });
    expect(r.items[0]).toMatchObject({ tax_amount: 25, gross: 125 });
    expect(r.shipping_tax_amount).toBe(10);
    expect(r.tax_total).toBe(35);
    expect(r.total).toBe(175);
    expect(r.tax_pricing_mode).toBe('EXCLUSIVE');
  });

  it('rounds per line in minor units, then sums', () => {
    // 19.98 at 25 % inclusive → 399.6 minor → 4.00; three of them → 12.00,
    // not round(3 × 399.6) = 11.99.
    const r = compute({
      lines: [
        { amount: 19.98, tax_class_id: null, tax_exempt: false },
        { amount: 19.98, tax_class_id: null, tax_exempt: false },
        { amount: 19.98, tax_class_id: null, tax_exempt: false },
      ],
    });
    expect(r.items.map((i) => i.tax_amount)).toEqual([4, 4, 4]);
    expect(r.tax_total).toBe(12);
  });

  it('respects zero-decimal currencies', () => {
    const r = compute({
      currency: 'JPY',
      lines: [{ amount: 1001, tax_class_id: null, tax_exempt: false }],
    });
    expect(r.items[0].tax_amount).toBe(200);
    expect(r.total).toBe(1001);
  });
});

describe('computeTaxes: exempt, zero class, export', () => {
  it('a tax_exempt product is 0 % but still reports its class', () => {
    const r = compute({
      lines: [{ amount: 100, tax_class_id: 'std', tax_exempt: true }],
    });
    expect(r.items[0]).toMatchObject({
      tax_rate_bp: 0,
      tax_amount: 0,
      tax_class_key: 'standard',
    });
    expect(r.tax_lines).toEqual([]);
  });

  it('the zero class is 0 %', () => {
    const r = compute({
      lines: [{ amount: 100, tax_class_id: 'zero', tax_exempt: false }],
    });
    expect(r.items[0]).toMatchObject({ tax_rate_bp: 0, tax_class_key: 'zero' });
  });

  it('a destination outside the territory is an export (0 %)', () => {
    const r = compute({ shipping: { country: 'US' }, shipping_cost: 49 });
    expect(r.items[0].tax_amount).toBe(0);
    expect(r.shipping_tax_amount).toBe(0);
    expect(r.tax_total).toBe(0);
    expect(r.headline_rate_bp).toBe(0);
    expect(r.total).toBe(149);
    expect(r.tax_basis_country).toBe('US');
  });

  it('a non-EU registrant only taxes its own country', () => {
    const data: TaxData = {
      classes: CLASSES,
      rates: [rate('std', 'SA', 1500), rate('std', 'AE', 500)],
    };
    const home = compute(
      { ctx: { taxCountry: 'SA' }, shipping: { country: 'SA' } },
      data,
    );
    const abroad = compute(
      { ctx: { taxCountry: 'SA' }, shipping: { country: 'AE' } },
      data,
    );
    expect(home.items[0].tax_rate_bp).toBe(1500);
    expect(abroad.items[0].tax_rate_bp).toBe(0);
  });

  it('a registrant with no country never taxes', () => {
    const r = compute({ ctx: { taxCountry: null } });
    expect(r.tax_total).toBe(0);
  });

  it('estimates with the registration country before an address is known', () => {
    const r = compute({ shipping: null });
    expect(r.items[0].tax_rate_bp).toBe(2500);
    expect(r.tax_basis_country).toBe('SE');
  });
});

describe('computeTaxes: OSS destination vs origin', () => {
  it('below the OSS threshold an EU sale uses the registration country rates', () => {
    const r = compute({ shipping: { country: 'DE' } });
    expect(r.items[0].tax_rate_bp).toBe(2500);
    expect(r.tax_basis_country).toBe('DE');
  });

  it('OSS-registered: the destination country rates apply', () => {
    const r = compute({
      ctx: { ossRegistered: true },
      shipping: { country: 'DE' },
      lines: [
        { amount: 100, tax_class_id: 'std', tax_exempt: false },
        { amount: 100, tax_class_id: 'red', tax_exempt: false },
      ],
    });
    expect(r.items.map((i) => i.tax_rate_bp)).toEqual([1900, 700]);
    expect(r.tax_lines.map((l) => l.rate_bp)).toEqual([1900, 700]);
  });

  it('the tax basis picks the address: BILLING and STORE', () => {
    const billing = compute({
      ctx: { basis: TaxBasis.BILLING, ossRegistered: true },
      shipping: { country: 'DE' },
      billing: { country: 'FR' },
    });
    expect(billing.items[0].tax_rate_bp).toBe(2000);
    const store = compute({
      ctx: { basis: TaxBasis.STORE },
      shipping: { country: 'US' },
    });
    expect(store.items[0].tax_rate_bp).toBe(2500);
    expect(store.tax_basis_country).toBe('SE');
  });
});

describe('resolveRatesForLine: specificity, priority, stacking, scope', () => {
  const ctx = context({ taxCountry: 'US', ossRegistered: false });
  const std = 'std';
  const usRates: TaxRateRow[] = [
    rate(std, 'US', 0, { id: 'country' }),
    rate(std, 'US', 725, { id: 'ca', region: 'CA' }),
    rate(std, 'US', 1000, {
      id: 'ca-zip',
      region: 'CA',
      postcode_pattern: '902*',
    }),
    rate(std, 'US', 850, {
      id: 'ny-range',
      region: 'NY',
      postcode_pattern: '10000-10299',
    }),
    rate(std, 'US', 400, { id: 'ny-p1', region: 'NY', priority: 1 }),
    rate(std, 'US', 300, { id: 'ny-p0-a', region: 'NY', priority: 0 }),
    rate(std, 'US', 100, { id: 'ny-p0-b', region: 'NY', priority: 0 }),
  ];
  const data: TaxData = { classes: CLASSES, rates: usRates };
  const line = { tax_class_id: null, tax_exempt: false };
  const ids = (dest: { country: string; region?: string; postcode?: string }) =>
    resolveRatesForLine(ctx, data, line, dest).rates.map((r) => r.id);

  it('postcode beats region beats country', () => {
    expect(ids({ country: 'US' })).toEqual(['country']);
    expect(ids({ country: 'US', region: 'CA', postcode: '94016' })).toEqual([
      'ca',
    ]);
    expect(ids({ country: 'US', region: 'ca', postcode: '90210' })).toEqual([
      'ca-zip',
    ]);
    expect(ids({ country: 'US', region: 'NY', postcode: '10150' })).toEqual([
      'ny-range',
    ]);
  });

  it('the lowest priority wins and equal priorities stack', () => {
    expect(ids({ country: 'US', region: 'NY', postcode: '12000' })).toEqual([
      'ny-p0-b',
      'ny-p0-a',
    ]);
  });

  it('stacked rates compound in ascending order', () => {
    const r = computeTaxes({
      ctx: { ...ctx, pricingMode: TaxPricingMode.EXCLUSIVE },
      data,
      currency: 'USD',
      lines: [{ amount: 100, tax_class_id: null, tax_exempt: false }],
      shipping_cost: 0,
      discount_amount: 0,
      shipping: { country: 'US', region: 'NY', postcode: '12000' },
    });
    // 1 % on 100 = 1.00, then 3 % on 101 = 3.03.
    expect(r.tax_lines).toEqual([
      { label: 'VAT', rate_bp: 300, taxable_amount: 101, tax_amount: 3.03 },
      { label: 'VAT', rate_bp: 100, taxable_amount: 100, tax_amount: 1 },
    ]);
    expect(r.items[0].tax_amount).toBe(4.03);
    expect(r.items[0].tax_rate_bp).toBe(
      effectiveRateBp([{ rate_bp: 100 }, { rate_bp: 300 }]),
    );
    expect(r.items[0].tax_rate_bp).toBe(403);
  });

  it('a store row shadows the platform row of the same scope', () => {
    const seCtx = context();
    const rows: TaxRateRow[] = [
      rate(std, 'SE', 2500, { id: 'platform' }),
      rate(std, 'SE', 2000, { id: 'mine', store_id: 'store-1' }),
      rate(std, 'SE', 999, { id: 'theirs', store_id: 'store-2' }),
    ];
    const got = resolveRatesForLine(
      seCtx,
      { classes: CLASSES, rates: rows },
      line,
      {
        country: 'SE',
      },
    );
    expect(got.rates.map((r) => r.id)).toEqual(['mine']);
  });

  it('use_platform_tax_rates=false hides platform rows; MARKETPLACE sees only them', () => {
    const rows: TaxRateRow[] = [
      rate(std, 'SE', 2500, { id: 'platform' }),
      rate(std, 'SE', 1200, { id: 'mine', store_id: 'store-1', region: 'X' }),
    ];
    const d = { classes: CLASSES, rates: rows };
    const ownOnly = resolveRatesForLine(
      context({ usePlatformRates: false }),
      d,
      line,
      { country: 'SE' },
    );
    expect(ownOnly.rates).toEqual([]);
    const platform = resolveRatesForLine(
      context({ registrant: 'PLATFORM', rateStoreId: null }),
      d,
      line,
      { country: 'SE', region: 'X' },
    );
    expect(platform.rates.map((r) => r.id)).toEqual(['platform']);
  });

  it('falls back to the default class when the product class has no rate', () => {
    const custom = cls('books', 'books', { store_id: 'store-1' });
    const got = resolveRatesForLine(
      context(),
      { classes: [...CLASSES, custom], rates: EU_RATES },
      { tax_class_id: 'books', tax_exempt: false },
      { country: 'SE' },
    );
    expect(got.class_key).toBe('books');
    expect(got.rates.map((r) => r.rate_bp)).toEqual([2500]);
  });

  it('ignores inactive rates and honours applies_to_shipping', () => {
    const rows: TaxRateRow[] = [
      rate(std, 'SE', 2500, { id: 'off', is_active: false }),
      rate(std, 'SE', 1200, { id: 'no-ship', applies_to_shipping: false }),
    ];
    const d = { classes: CLASSES, rates: rows };
    expect(
      resolveRatesForLine(context(), d, line, { country: 'SE' }).rates.map(
        (r) => r.id,
      ),
    ).toEqual(['no-ship']);
    expect(
      resolveRatesForLine(
        context(),
        d,
        line,
        { country: 'SE' },
        { forShipping: true },
      ).rates,
    ).toEqual([]);
  });
});

describe('postcodeMatches', () => {
  it('handles exact, prefix and ranges', () => {
    expect(postcodeMatches(null, '12345')).toBe(true);
    expect(postcodeMatches('114 35', '11435')).toBe(true);
    expect(postcodeMatches('114*', '11435')).toBe(true);
    expect(postcodeMatches('115*', '11435')).toBe(false);
    expect(postcodeMatches('10000-19999', '15000')).toBe(true);
    expect(postcodeMatches('10000-19999', '20000')).toBe(false);
    expect(postcodeMatches('AB1-AB9', 'AB5')).toBe(true);
    expect(postcodeMatches('114*', null)).toBe(false);
  });
});

describe('computeTaxes: discount allocation', () => {
  it('allocates the discount by largest remainder so the shares sum exactly', () => {
    const r = compute({
      lines: [
        { amount: 100, tax_class_id: 'std', tax_exempt: false },
        { amount: 50, tax_class_id: 'red', tax_exempt: false },
        { amount: 33.33, tax_class_id: 'std', tax_exempt: false },
      ],
      discount_amount: 10,
    });
    const shares = r.items.map((i) => i.discount_allocated);
    expect(Math.round(shares.reduce((s, x) => s + x, 0) * 100) / 100).toBe(10);
    expect(shares).toEqual([5.45, 2.73, 1.82]);
    // Tax is computed on the discounted line: (100 - 5.45) at 25 % incl.
    expect(r.items[0].tax_amount).toBe(18.91);
    // (50 - 2.73) = 47.27 at 12 % inclusive → 506.46 minor → 5.06.
    expect(r.items[1].tax_amount).toBe(5.06);
    expect(r.total).toBe(173.33);
    expect(sumTaxLines(r)).toBe(r.tax_total);
  });

  it('caps the discount at the subtotal', () => {
    const r = compute({
      lines: [{ amount: 20, tax_class_id: null, tax_exempt: false }],
      discount_amount: 50,
    });
    expect(r.items[0].discount_allocated).toBe(20);
    expect(r.items[0].tax_amount).toBe(0);
    expect(r.total).toBe(0);
  });
});

describe('computeTaxes: shipping class', () => {
  const lines = [
    { amount: 100, tax_class_id: 'red', tax_exempt: false },
    { amount: 100, tax_class_id: 'std', tax_exempt: false },
    { amount: 100, tax_class_id: 'zero', tax_exempt: false },
  ];

  it('follows the highest-rate class among the lines by default', () => {
    const r = compute({ lines, shipping_cost: 50 });
    expect(r.shipping_tax_rate_bp).toBe(2500);
    expect(r.shipping_tax_amount).toBe(10);
  });

  it('uses the configured shipping class when set', () => {
    const r = compute({
      ctx: { shippingTaxClassId: 'red' },
      lines,
      shipping_cost: 50,
    });
    expect(r.shipping_tax_rate_bp).toBe(1200);
    expect(r.shipping_tax_amount).toBe(5.36);
  });

  it('is untaxed when nothing on the order is', () => {
    const r = compute({
      lines: [{ amount: 100, tax_class_id: 'zero', tax_exempt: false }],
      shipping_cost: 50,
    });
    expect(r.shipping_tax_rate_bp).toBe(0);
    expect(r.shipping_tax_amount).toBe(0);
  });

  it('resolves the rate even when the chosen method is free', () => {
    const r = compute({ lines, shipping_cost: 0 });
    expect(r.shipping_tax_rate_bp).toBe(2500);
    expect(r.shipping_tax_amount).toBe(0);
  });
});

describe('computeTaxes: tax_lines', () => {
  it('groups by (label, rate) in the requested locale and sums to tax_total', () => {
    const r = compute({
      ctx: { ossRegistered: true },
      locale: 'de',
      shipping: { country: 'DE' },
      lines: [
        { amount: 119, tax_class_id: 'std', tax_exempt: false },
        { amount: 238, tax_class_id: 'std', tax_exempt: false },
        { amount: 107, tax_class_id: 'red', tax_exempt: false },
      ],
      shipping_cost: 11.9,
      discount_amount: 0,
    });
    expect(r.tax_lines).toEqual([
      { label: 'MwSt.', rate_bp: 1900, taxable_amount: 310, tax_amount: 58.9 },
      { label: 'MwSt.', rate_bp: 700, taxable_amount: 100, tax_amount: 7 },
    ]);
    expect(sumTaxLines(r)).toBe(r.tax_total);
    expect(r.tax_total).toBe(65.9);
    expect(r.headline_rate_bp).toBe(1900);
  });

  it('Σ tax_lines == tax_total across random mixed orders', () => {
    let s = 7;
    const rnd = () => ((s = (s * 48271) % 2147483647) % 100000) / 100;
    for (let i = 0; i < 200; i++) {
      const lines = Array.from({ length: 1 + (i % 4) }, (_, j) => ({
        amount: rnd(),
        tax_class_id: ['std', 'red', 'zero', null][(i + j) % 4],
        tax_exempt: (i + j) % 7 === 0,
      }));
      const r = compute({
        ctx: {
          pricingMode:
            i % 2 ? TaxPricingMode.EXCLUSIVE : TaxPricingMode.INCLUSIVE,
        },
        lines,
        shipping_cost: rnd(),
        discount_amount: (i % 3) * 3.33,
      });
      expect(sumTaxLines(r)).toBe(r.tax_total);
      const itemTax = r.items.reduce((t, it) => t + it.tax_amount, 0);
      expect(Math.round((itemTax + r.shipping_tax_amount) * 100) / 100).toBe(
        r.tax_total,
      );
    }
  });
});
