import { TaxBasis, TaxPricingMode } from '@prisma/client';
import {
  EXEMPT_LABELS,
  computeTaxes,
  exemptLabel,
  exemptNetPrices,
  netOfRate,
  type TaxClassRow,
  type TaxContext,
  type TaxData,
  type TaxRateRow,
} from './tax.service';
import { currencyDecimals } from '../../common/money/currency.util';

// b2b app M2.5: the engine's exemption (reverse charge / customer exempt)
// and the D5 netting of INCLUSIVE prices. Pure, no I/O.

const VAT = { en: 'VAT', sv: 'Moms', de: 'MwSt.' };

function cls(id: string, key: string, isDefault = false): TaxClassRow {
  return {
    id,
    store_id: null,
    key,
    name: { en: key },
    is_default: isDefault,
  };
}

let seq = 0;
function rate(classId: string, country: string, rateBp: number): TaxRateRow {
  seq += 1;
  return {
    id: `r-${seq}`,
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
  };
}

const DATA: TaxData = {
  classes: [
    cls('std', 'standard', true),
    cls('red', 'reduced'),
    cls('low', 'low'),
    cls('zero', 'zero'),
  ],
  rates: [
    rate('std', 'SE', 2500),
    rate('red', 'SE', 1200),
    rate('low', 'SE', 600),
    rate('std', 'DE', 1900),
    rate('red', 'DE', 700),
    rate('std', 'FR', 2000),
  ],
};

function ctxOf(over: Partial<TaxContext> = {}): TaxContext {
  return {
    registrant: 'STORE',
    storeId: 's1',
    rateStoreId: 's1',
    taxCountry: 'SE',
    pricingMode: TaxPricingMode.INCLUSIVE,
    basis: TaxBasis.SHIPPING,
    ossRegistered: false,
    usePlatformRates: true,
    shippingTaxClassId: null,
    displayPricesInclTax: true,
    ...over,
  };
}

type Line = {
  unit_price: number;
  quantity: number;
  tax_class_id: string | null;
  tax_exempt: boolean;
};

/** What computeTotals does for an exempt order, in pure form. */
function exemptOrder(opts: {
  mode: TaxPricingMode;
  lines: Line[];
  shipping: number;
  discount: (subtotal: number) => number;
  currency: string;
  pricing?: 'net' | 'gross';
  ctx?: Partial<TaxContext>;
}) {
  const ctx = ctxOf({ pricingMode: opts.mode, ...opts.ctx });
  const f = 10 ** currencyDecimals(opts.currency);
  const subtotalGross =
    opts.lines.reduce(
      (s, l) => s + Math.round(l.unit_price * f) * l.quantity,
      0,
    ) / f;
  const discountGross = opts.discount(subtotalGross);
  const pricing = opts.pricing ?? 'net';
  const first = exemptNetPrices({
    ctx,
    data: DATA,
    currency: opts.currency,
    lines: opts.lines,
    shippingCosts: [],
    discount_amount: 0,
    subtotal_gross: subtotalGross,
    pricing,
  });
  const shipping = first.shipping_rate_bp
    ? netOfRate(opts.shipping, first.shipping_rate_bp, opts.currency)
    : opts.shipping;
  const second = exemptNetPrices({
    ctx,
    data: DATA,
    currency: opts.currency,
    lines: opts.lines,
    shippingCosts: [opts.shipping],
    discount_amount: discountGross,
    subtotal_gross: subtotalGross,
    pricing,
  });
  const result = computeTaxes({
    ctx: { ...ctx, exemption: { reason: 'REVERSE_CHARGE' } },
    data: DATA,
    currency: opts.currency,
    locale: 'en',
    lines: opts.lines.map((l, i) => ({
      amount: second.line_totals[i],
      tax_class_id: l.tax_class_id,
      tax_exempt: l.tax_exempt,
    })),
    shipping_cost: shipping,
    discount_amount: second.discount_amount,
    shipping: { country: 'DE' },
  });
  return { net: second, shipping, result, f };
}

describe('computeTaxes with an exemption', () => {
  const LINE_SETS: Record<string, Line[]> = {
    single: [
      { unit_price: 125, quantity: 2, tax_class_id: null, tax_exempt: false },
    ],
    mixed: [
      { unit_price: 125, quantity: 1, tax_class_id: 'std', tax_exempt: false },
      { unit_price: 99.9, quantity: 3, tax_class_id: 'red', tax_exempt: false },
      { unit_price: 33.3, quantity: 2, tax_class_id: 'low', tax_exempt: false },
    ],
    exemptLine: [
      { unit_price: 125, quantity: 1, tax_class_id: null, tax_exempt: false },
      { unit_price: 50, quantity: 1, tax_class_id: null, tax_exempt: true },
    ],
  };
  const SHIPPING = { paid: 49, free: 0 };
  const DISCOUNTS: Record<string, (s: number) => number> = {
    none: () => 0,
    percent: (s) => Math.round(s * 0.1 * 100) / 100,
    fixed: () => 20,
  };

  for (const mode of [TaxPricingMode.INCLUSIVE, TaxPricingMode.EXCLUSIVE]) {
    for (const [setName, lines] of Object.entries(LINE_SETS)) {
      for (const [shipName, shipping] of Object.entries(SHIPPING)) {
        for (const [discName, discount] of Object.entries(DISCOUNTS)) {
          for (const currency of ['SEK', 'EUR', 'JPY']) {
            it(`${mode} ${setName} ${shipName} ${discName} ${currency}`, () => {
              const {
                net,
                shipping: netShip,
                result,
                f,
              } = exemptOrder({
                mode,
                lines,
                shipping,
                discount,
                currency,
              });
              const m = (v: number) => Math.round(v * f);
              expect(result.tax_total).toBe(0);
              expect(result.shipping_tax_amount).toBe(0);
              expect(result.shipping_tax_rate_bp).toBe(0);
              expect(result.headline_rate_bp).toBe(0);
              expect(result.tax_exempt_reason).toBe('REVERSE_CHARGE');
              for (const item of result.items) {
                expect(item.tax_amount).toBe(0);
                expect(item.tax_rate_bp).toBe(0);
              }
              // unit x qty === line total, exactly.
              net.unit_prices.forEach((u, i) => {
                expect(m(u) * lines[i].quantity).toBe(m(net.line_totals[i]));
              });
              // total = sum of nets + net shipping - net discount.
              const expected =
                net.line_totals.reduce((s, x) => s + m(x), 0) +
                m(netShip) -
                m(net.discount_amount);
              expect(m(result.total)).toBe(expected);
              expect(result.net_total).toBe(result.total);
              expect(result.tax_lines).toHaveLength(1);
              expect(result.tax_lines[0]).toEqual({
                label: 'Reverse charge',
                rate_bp: 0,
                taxable_amount: result.total,
                tax_amount: 0,
                exempt_reason: 'REVERSE_CHARGE',
              });
              if (mode === TaxPricingMode.EXCLUSIVE) {
                // Prices are already net: nothing moves.
                net.unit_prices.forEach((u, i) =>
                  expect(u).toBe(m(lines[i].unit_price) / f),
                );
                expect(netShip).toBe(shipping);
              }
              // A tax-exempt product line is never netted.
              if (setName === 'exemptLine') {
                expect(net.unit_prices[1]).toBe(50);
              }
            });
          }
        }
      }
    }
  }

  it('INCLUSIVE 125 SEK at 25 % becomes 100.00; shipping 49 becomes 39.20', () => {
    const { net, shipping, result } = exemptOrder({
      mode: TaxPricingMode.INCLUSIVE,
      lines: [
        { unit_price: 125, quantity: 1, tax_class_id: null, tax_exempt: false },
      ],
      shipping: 49,
      discount: () => 0,
      currency: 'SEK',
    });
    expect(net.unit_prices).toEqual([100]);
    expect(shipping).toBe(39.2);
    expect(result.total).toBe(139.2);
    expect(result.net_items).toBe(100);
    expect(result.net_shipping).toBe(39.2);
  });

  it('a DE seller nets 119 EUR at 19 %, and the registration rate wins with OSS', () => {
    const { net } = exemptOrder({
      mode: TaxPricingMode.INCLUSIVE,
      lines: [
        { unit_price: 119, quantity: 1, tax_class_id: null, tax_exempt: false },
      ],
      shipping: 0,
      discount: () => 0,
      currency: 'EUR',
      ctx: { taxCountry: 'DE', ossRegistered: true },
    });
    expect(net.unit_prices).toEqual([100]);
    const se = exemptOrder({
      mode: TaxPricingMode.INCLUSIVE,
      lines: [
        { unit_price: 125, quantity: 1, tax_class_id: null, tax_exempt: false },
      ],
      shipping: 0,
      discount: () => 0,
      currency: 'SEK',
      ctx: { ossRegistered: true },
    });
    expect(se.net.unit_prices).toEqual([100]);
  });

  it("'gross' pricing keeps every amount (Shopify): the gross is the net", () => {
    const { net, shipping, result } = exemptOrder({
      mode: TaxPricingMode.INCLUSIVE,
      lines: [
        { unit_price: 125, quantity: 2, tax_class_id: null, tax_exempt: false },
      ],
      shipping: 49,
      discount: () => 25,
      currency: 'SEK',
      pricing: 'gross',
    });
    expect(net.unit_prices).toEqual([125]);
    expect(net.subtotal).toBe(250);
    expect(net.discount_amount).toBe(25);
    expect(shipping).toBe(49);
    expect(result.total).toBe(274);
    expect(result.tax_total).toBe(0);
    expect(result.net_total).toBe(274);
  });

  it('scales the discount by subtotal_net / subtotal_gross', () => {
    const { net } = exemptOrder({
      mode: TaxPricingMode.INCLUSIVE,
      lines: [
        { unit_price: 125, quantity: 4, tax_class_id: null, tax_exempt: false },
      ],
      shipping: 0,
      discount: () => 50,
      currency: 'SEK',
    });
    expect(net.subtotal).toBe(400);
    expect(net.discount_amount).toBe(40);
  });

  it('a zero total produces no breakdown row', () => {
    const r = computeTaxes({
      ctx: ctxOf({ exemption: { reason: 'CUSTOMER_EXEMPT' } }),
      data: DATA,
      currency: 'SEK',
      lines: [{ amount: 0, tax_class_id: null, tax_exempt: false }],
      shipping_cost: 0,
      discount_amount: 0,
    });
    expect(r.tax_lines).toEqual([]);
    expect(r.tax_exempt_reason).toBe('CUSTOMER_EXEMPT');
  });

  it('labels: localized per reason, English fallback', () => {
    expect(exemptLabel('REVERSE_CHARGE', 'sv')).toBe('Omvänd skattskyldighet');
    expect(exemptLabel('REVERSE_CHARGE', 'de-DE')).toBe(
      EXEMPT_LABELS.REVERSE_CHARGE.de,
    );
    expect(exemptLabel('CUSTOMER_EXEMPT', 'xx')).toBe('VAT exempt');
    for (const reason of ['REVERSE_CHARGE', 'CUSTOMER_EXEMPT'] as const) {
      expect(Object.keys(EXEMPT_LABELS[reason]).sort()).toEqual(
        ['ar', 'de', 'en', 'fr', 'sv', 'tr'].sort(),
      );
    }
  });

  it('without an exemption the result has no new keys (byte-identical)', () => {
    const r = computeTaxes({
      ctx: ctxOf(),
      data: DATA,
      currency: 'SEK',
      locale: 'sv',
      lines: [{ amount: 125, tax_class_id: null, tax_exempt: false }],
      shipping_cost: 49,
      discount_amount: 0,
      shipping: { country: 'SE' },
    });
    expect(r).not.toHaveProperty('tax_exempt_reason');
    for (const line of r.tax_lines) {
      expect(line).not.toHaveProperty('exempt_reason');
    }
    expect(JSON.stringify(r)).toBe(
      JSON.stringify({
        items: [
          {
            tax_rate_bp: 2500,
            tax_amount: 25,
            tax_class_key: 'standard',
            discount_allocated: 0,
            gross: 125,
          },
        ],
        shipping_tax_amount: 9.8,
        shipping_tax_rate_bp: 2500,
        tax_lines: [
          {
            label: 'Moms',
            rate_bp: 2500,
            taxable_amount: 139.2,
            tax_amount: 34.8,
          },
        ],
        tax_total: 34.8,
        total: 174,
        headline_rate_bp: 2500,
        tax_pricing_mode: 'INCLUSIVE',
        tax_basis_country: 'SE',
        display_mode: 'incl',
        net_items: 100,
        net_shipping: 39.2,
        net_total: 139.2,
      }),
    );
  });
});
