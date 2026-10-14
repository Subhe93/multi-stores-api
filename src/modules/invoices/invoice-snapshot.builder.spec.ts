import { TaxBasis, TaxPricingMode } from '@prisma/client';
import { computeTaxes, type TaxRateRow } from '../taxes/tax.service';
import { currencyDecimals } from '../../common/money/currency.util';
import {
  addDays,
  buildCreditSnapshot,
  buildInvoiceSnapshot,
  hasStackedTaxRates,
  snapshotInvariantErrors,
  withNumber,
  type BuildInvoiceInput,
  type SnapshotOrder,
  type SnapshotOrderItem,
} from './invoice-snapshot.builder';
import type { InvoiceSeller, InvoiceSnapshot } from './invoices.types';

// The builder is pure. Orders are priced with the real tax engine
// (computeTaxes) so the matrix below exercises the same numbers checkout
// stores on Order / OrderItem, and every snapshot must satisfy the
// invariants exactly (minor units).

const RATES: TaxRateRow[] = [
  ['std', 2500],
  ['red', 1200],
  ['low', 600],
].map(([cls, bp], i) => ({
  id: `r${i}`,
  store_id: null,
  tax_class_id: cls as string,
  country: 'SE',
  region: null,
  postcode_pattern: null,
  rate_bp: bp as number,
  label: { en: 'VAT', sv: 'Moms' },
  priority: 0,
  applies_to_shipping: true,
  is_active: true,
}));
const CLASSES = ['std', 'red', 'low', 'zero'].map((id) => ({
  id,
  store_id: null,
  key: id,
  name: { en: id },
  is_default: id === 'std',
}));

interface LineSpec {
  unit: number;
  qty: number;
  cls: string;
  exempt?: boolean;
}

const SELLER: InvoiceSeller = {
  legal_name: 'Neronet Academy AB',
  brand_name: 'Namez',
  org_number: '556036-0793',
  vat_number: 'SE556036079301',
  address: {
    line1: 'Storgatan 1',
    line2: null,
    postal_code: '11122',
    city: 'Stockholm',
    country_code: 'SE',
  },
  registered_office: 'Stockholm',
  email: 'info@namez.se',
  phone: null,
  website: null,
  f_tax_approved: true,
  logo_url: null,
  footer_note: null,
};

function makeOrder(opts: {
  mode: TaxPricingMode;
  currency: string;
  lines: LineSpec[];
  shipping: number;
  discount: number;
  company?: boolean;
}): SnapshotOrder {
  const r = computeTaxes({
    ctx: {
      registrant: 'STORE',
      storeId: 's1',
      rateStoreId: 's1',
      taxCountry: 'SE',
      pricingMode: opts.mode,
      basis: TaxBasis.SHIPPING,
      ossRegistered: false,
      usePlatformRates: true,
      shippingTaxClassId: null,
      displayPricesInclTax: true,
    },
    data: { rates: RATES, classes: CLASSES },
    currency: opts.currency,
    locale: 'sv',
    lines: opts.lines.map((l) => ({
      amount: l.unit * l.qty,
      tax_class_id: l.cls,
      tax_exempt: !!l.exempt,
    })),
    shipping_cost: opts.shipping,
    discount_amount: opts.discount,
    shipping: { country: 'SE' },
  });
  const items: SnapshotOrderItem[] = opts.lines.map((l, i) => ({
    quantity: l.qty,
    unit_price: l.unit,
    total_price: l.unit * l.qty,
    tax_rate_bp: r.items[i].tax_rate_bp,
    product: {
      sku: `SKU-${i}`,
      translations: [
        { locale: 'en', title: `Product ${i}` },
        { locale: 'sv', title: `Produkt ${i}` },
      ],
    },
    variant: null,
    custom_product: null,
    custom_field_values: [],
  }));
  return {
    order_number: 'ORD-1',
    created_at: new Date('2026-10-13T23:30:00Z'),
    currency: opts.currency,
    payment_method: 'STRIPE',
    paid_at: new Date('2026-10-13T23:31:00Z'),
    card_brand: 'visa',
    card_last4: '4242',
    total: r.total,
    tax_amount: r.tax_total,
    tax_rate_bp: r.headline_rate_bp,
    tax_pricing_mode: opts.mode,
    tax_lines: r.tax_lines,
    shipping_cost: opts.shipping,
    shipping_tax_rate_bp: r.shipping_tax_rate_bp,
    shipping_tax_amount: r.shipping_tax_amount,
    shipping_method_name: opts.shipping ? 'PostNord' : null,
    discount_amount: Math.min(
      opts.discount,
      opts.lines.reduce((s, l) => s + l.unit * l.qty, 0),
    ),
    customer_type: opts.company ? 'COMPANY' : null,
    company_name: opts.company ? 'Acme AB' : null,
    org_number: opts.company ? '556036-0793' : null,
    vat_number: opts.company ? 'SE556036079301' : null,
    buyer_reference: opts.company ? 'PO-77' : null,
    address: {
      full_name: 'Anna Svensson',
      line1: 'Gatan 2',
      postal_code: '11123',
      city: 'Stockholm',
      country_code: 'SE',
    },
    customer: {
      first_name: 'Anna',
      last_name: 'Svensson',
      user: { email: 'anna@example.com' },
    },
    items,
  };
}

function input(order: SnapshotOrder, extra: Partial<BuildInvoiceInput> = {}) {
  return {
    order,
    seller: SELLER,
    bank: {
      bankgiro: '5050-1055',
      plusgiro: null,
      iban: null,
      bic: null,
      bank_name: null,
    },
    locale: 'sv',
    issueDate: '2026-10-14',
    timezone: 'Europe/Stockholm',
    dueDays: 30,
    paid: true,
    ...extra,
  } satisfies BuildInvoiceInput;
}

const minor = (v: number, currency: string) =>
  Math.round(v * 10 ** currencyDecimals(currency));

const LINE_SETS: Record<string, LineSpec[]> = {
  single25: [
    { unit: 199, qty: 2, cls: 'std' },
    { unit: 49, qty: 1, cls: 'std' },
  ],
  mixed: [
    { unit: 299, qty: 1, cls: 'std' },
    { unit: 89, qty: 3, cls: 'red' },
    { unit: 59, qty: 2, cls: 'low' },
  ],
  exempt: [
    { unit: 299, qty: 1, cls: 'std' },
    { unit: 150, qty: 1, cls: 'std', exempt: true },
  ],
};

describe('buildInvoiceSnapshot (matrix)', () => {
  const modes = [TaxPricingMode.INCLUSIVE, TaxPricingMode.EXCLUSIVE];
  const discounts = { none: 0, coupon: 37, full: 1_000_000 };
  const shippings = { paid: 49, free: 0 };
  const currencies = ['SEK', 'EUR', 'JPY'];

  for (const mode of modes)
    for (const [dName, discount] of Object.entries(discounts))
      for (const [sName, shipping] of Object.entries(shippings))
        for (const [lName, lines] of Object.entries(LINE_SETS))
          for (const currency of currencies) {
            it(`${mode} ${dName} discount, ${sName} shipping, ${lName}, ${currency}`, () => {
              const order = makeOrder({
                mode,
                currency,
                lines,
                shipping,
                discount,
              });
              const s = buildInvoiceSnapshot(input(order));
              expect(snapshotInvariantErrors(s)).toEqual([]);
              expect(minor(s.totals.gross, currency)).toBe(
                minor(Number(order.total), currency),
              );
              expect(
                s.vat_summary.reduce((t, r) => t + minor(r.vat, currency), 0),
              ).toBe(minor(Number(order.tax_amount), currency));
              const kinds = s.lines.map((l) => l.kind);
              if (dName === 'none') {
                expect(kinds).not.toContain('rounding');
                expect(kinds).not.toContain('discount');
              } else {
                expect(kinds).toContain('discount');
              }
              expect(kinds.includes('shipping')).toBe(shipping > 0);
              expect(s.totals.layout).toBe(
                mode === TaxPricingMode.EXCLUSIVE ? 'excl' : 'incl',
              );
              // The summary's gross column adds up to the total.
              expect(
                s.vat_summary.reduce((t, r) => t + minor(r.gross, currency), 0),
              ).toBe(minor(s.totals.gross, currency));
            });
          }

  it('a 100 % discount yields a zero total invoice', () => {
    const s = buildInvoiceSnapshot(
      input(
        makeOrder({
          mode: TaxPricingMode.INCLUSIVE,
          currency: 'SEK',
          lines: LINE_SETS.mixed,
          shipping: 0,
          discount: 1_000_000,
        }),
      ),
    );
    expect(s.totals).toMatchObject({ net: 0, vat: 0, gross: 0 });
    expect(snapshotInvariantErrors(s)).toEqual([]);
  });
});

describe('buildInvoiceSnapshot (fields)', () => {
  const base = () =>
    makeOrder({
      mode: TaxPricingMode.INCLUSIVE,
      currency: 'SEK',
      lines: LINE_SETS.single25,
      shipping: 49,
      discount: 0,
    });

  it('person on an INCLUSIVE store: pre-discount net lines, incl layout', () => {
    const s = buildInvoiceSnapshot(input(base()));
    expect(s.lines[0]).toMatchObject({
      kind: 'item',
      description: 'Produkt 0',
      sku: 'SKU-0',
      qty: 2,
      unit_net: 159.2,
      vat_rate_bp: 2500,
      line_net: 318.4,
    });
    expect(s.lines[2]).toMatchObject({
      kind: 'shipping',
      description: 'PostNord',
      line_net: 39.2,
    });
    expect(s.totals).toEqual({
      net: 396.8,
      vat: 99.2,
      gross: 496,
      layout: 'incl',
    });
    expect(s.buyer).toMatchObject({
      type: 'PERSON',
      name: 'Anna Svensson',
      company_name: null,
      email: 'anna@example.com',
    });
    expect(s.payment).toMatchObject({
      method: 'STRIPE',
      label: 'Visa •••• 4242',
      status: 'paid',
      paid: true,
    });
    expect(s.bank).toBeNull();
    // Order date is printed in the seller timezone (23:30Z = 01:30 CEST).
    expect(s.refs).toMatchObject({
      order_number: 'ORD-1',
      order_date: '2026-10-14',
      issue_date: '2026-10-14',
      due_date: '2026-10-14',
      invoice_number: '',
    });
    expect(s.template_version).toBe(1);
    expect(s.version).toBe(1);
  });

  it('company buyer: M2 snapshot block and excl layout', () => {
    const s = buildInvoiceSnapshot(
      input({
        ...base(),
        customer_type: 'COMPANY',
        company_name: 'Acme AB',
        org_number: '556036-0793',
        vat_number: 'SE556036079301',
        buyer_reference: 'PO-77',
      }),
    );
    expect(s.buyer).toMatchObject({
      type: 'COMPANY',
      name: 'Acme AB',
      company_name: 'Acme AB',
      org_number: '556036-0793',
      vat_number: 'SE556036079301',
      reference: 'PO-77',
    });
    expect(s.buyer.billing_address).toMatchObject({ name: 'Anna Svensson' });
    expect(s.totals.layout).toBe('excl');
  });

  it('unpaid non-COD: due date + bank box; withNumber fills the reference', () => {
    const s = buildInvoiceSnapshot(input(base(), { paid: false }));
    expect(s.refs.due_date).toBe(addDays('2026-10-14', 30));
    expect(s.bank).toMatchObject({ bankgiro: '5050-1055', reference: '' });
    const n = withNumber(s, 'INV-1001');
    expect(n.refs.invoice_number).toBe('INV-1001');
    expect(n.bank?.reference).toBe('INV-1001');
    // COD unpaid: no bank box, due on issue.
    const cod = buildInvoiceSnapshot(
      input({ ...base(), payment_method: 'COD' }, { paid: false }),
    );
    expect(cod.bank).toBeNull();
    expect(cod.refs.due_date).toBe('2026-10-14');
  });

  it('details: variant options and custom fields in the locale with en fallback', () => {
    const order = base();
    order.items[0].variant = { sku: 'VAR-1', options: { Färg: 'Röd' } };
    order.items[0].custom_field_values = [
      {
        value: 'gold',
        file_url: null,
        custom_field: {
          name: 'finish',
          type: 'SELECT',
          translations: [
            { locale: 'en', label: 'Finish', option_labels: { gold: 'Gold' } },
            { locale: 'sv', label: 'Finish', option_labels: { gold: 'Guld' } },
          ],
        },
      },
      {
        value: 'Hej',
        file_url: null,
        custom_field: {
          name: 'text_1',
          type: 'TEXT',
          translations: [{ locale: 'en', label: 'Engraving' }],
        },
      },
      {
        value: null,
        file_url: '/uploads/x.png',
        custom_field: { name: 'logo', type: 'IMAGE', translations: [] },
      },
    ];
    const s = buildInvoiceSnapshot(input(order));
    expect(s.lines[0].sku).toBe('VAR-1');
    expect(s.lines[0].details).toEqual([
      { label: 'Färg', value: 'Röd' },
      { label: 'Finish', value: 'Guld' },
      { label: 'Engraving', value: 'Hej' },
      { label: 'logo', value: 'file' },
    ]);
  });

  it('legacy order without tax_lines: one VAT row from the headline rate', () => {
    const order = { ...base(), tax_lines: null };
    const s = buildInvoiceSnapshot(input(order));
    expect(s.vat_summary).toEqual([
      { label: null, rate_bp: 2500, net: 396.8, vat: 99.2, gross: 496 },
    ]);
    expect(snapshotInvariantErrors(s)).toEqual([]);
  });
});

describe('buildCreditSnapshot', () => {
  const invoice = (): InvoiceSnapshot =>
    withNumber(
      buildInvoiceSnapshot(
        input(
          makeOrder({
            mode: TaxPricingMode.INCLUSIVE,
            currency: 'SEK',
            lines: LINE_SETS.mixed,
            shipping: 49,
            discount: 37,
          }),
        ),
      ),
      '1001',
    );

  it('full credit with nothing credited before is the negated mirror', () => {
    const inv = invoice();
    const c = buildCreditSnapshot({
      original: inv,
      amount: 'full',
      priorCredited: 0,
      issueDate: '2026-10-20',
      reasonCode: 'cancellation',
    });
    expect(c.kind).toBe('CREDIT_NOTE');
    expect(c.totals.gross).toBe(-inv.totals.gross);
    expect(c.totals.vat).toBe(-inv.totals.vat);
    expect(c.lines.map((l) => l.line_net)).toEqual(
      inv.lines.map((l) => -l.line_net || 0),
    );
    expect(c.bank).toBeNull();
    expect(c.refs).toMatchObject({
      credited_number: '1001',
      credited_issue_date: '2026-10-14',
      reason_code: 'cancellation',
      due_date: null,
      issue_date: '2026-10-20',
    });
    expect(snapshotInvariantErrors(c)).toEqual([]);
  });

  it('partial credit is pro-rata per VAT rate and sums exactly to the amount', () => {
    const inv = invoice();
    for (const amount of [0.01, 30, 123.45, inv.totals.gross]) {
      const c = buildCreditSnapshot({
        original: inv,
        amount,
        priorCredited: 0,
        issueDate: '2026-10-20',
      });
      expect(minor(c.totals.gross, 'SEK')).toBe(-minor(amount, 'SEK'));
      expect(snapshotInvariantErrors(c)).toEqual([]);
      expect(c.lines.every((l) => l.kind === 'credit')).toBe(true);
      const rates = c.vat_summary.map((r) => r.rate_bp);
      expect(new Set(rates).size).toBe(rates.length);
    }
    const c = buildCreditSnapshot({
      original: inv,
      amount: 100,
      priorCredited: 0,
      issueDate: '2026-10-20',
    });
    // Each rate's share is proportional to the invoice's gross at that rate.
    for (const row of c.vat_summary) {
      const orig = inv.vat_summary.find((r) => r.rate_bp === row.rate_bp)!;
      expect(
        Math.abs(-row.gross - (100 * orig.gross) / inv.totals.gross),
      ).toBeLessThan(0.02);
    }
  });

  it("'full' after earlier credits credits the remainder pro-rata", () => {
    const inv = invoice();
    const c = buildCreditSnapshot({
      original: inv,
      amount: 'full',
      priorCredited: 50,
      issueDate: '2026-10-20',
    });
    expect(minor(c.totals.gross, 'SEK')).toBe(
      -(minor(inv.totals.gross, 'SEK') - 5000),
    );
    expect(snapshotInvariantErrors(c)).toEqual([]);
  });
});

describe('hasStackedTaxRates', () => {
  const order = (over: Partial<SnapshotOrder>): SnapshotOrder =>
    ({
      ...makeOrder({
        mode: TaxPricingMode.INCLUSIVE,
        currency: 'SEK',
        lines: LINE_SETS.mixed,
        shipping: 49,
        discount: 0,
      }),
      ...over,
    }) as SnapshotOrder;

  it('single rates per line (and legacy / fully discounted orders) pass', () => {
    expect(hasStackedTaxRates(order({}))).toBe(false);
    expect(hasStackedTaxRates(order({ tax_lines: null }))).toBe(false);
    expect(
      hasStackedTaxRates(
        makeOrder({
          mode: TaxPricingMode.INCLUSIVE,
          currency: 'SEK',
          lines: LINE_SETS.mixed,
          shipping: 0,
          discount: 1_000_000,
        }),
      ),
    ).toBe(false);
  });

  it('a line whose effective rate is a compound of itemized rates is stacked', () => {
    const o = order({
      tax_lines: [
        { label: 'VAT', rate_bp: 2500, taxable_amount: 100, tax_amount: 25 },
        { label: 'Extra', rate_bp: 500, taxable_amount: 125, tax_amount: 6.25 },
      ],
    });
    o.items = [{ ...o.items[0], tax_rate_bp: 3125 }];
    o.shipping_cost = 0;
    expect(hasStackedTaxRates(o)).toBe(true);
  });
});
