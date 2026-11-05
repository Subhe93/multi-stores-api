import { FulfillerType } from '@prisma/client';
import {
  buildCreditSnapshot,
  buildInvoiceSnapshot,
  withNumber,
  type SnapshotOrder,
} from './invoice-snapshot.builder';
import { providerLinesOf, type ProviderMatchItem } from './provider-lines';
import type { InvoiceSeller } from './invoices.types';

// Supplier-copy line matching: snapshot lines carry no order_item_id, so
// they are matched back to the order items they were built from.

const SELLER: InvoiceSeller = {
  legal_name: 'Store AB',
  brand_name: null,
  org_number: '556036-0793',
  vat_number: 'SE556036079301',
  address: {
    line1: 'Storgatan 1',
    line2: null,
    postal_code: '11122',
    city: 'Stockholm',
    country_code: 'SE',
  },
  registered_office: null,
  email: null,
  phone: null,
  website: null,
  f_tax_approved: false,
  logo_url: null,
  footer_note: null,
};

function item(
  title: string,
  unit: number,
  qty: number,
  rate: number,
  fulfiller: [FulfillerType, string],
  sku: string | null = null,
): ProviderMatchItem {
  return {
    quantity: qty,
    unit_price: unit,
    total_price: unit * qty,
    tax_rate_bp: rate,
    product: { sku, translations: [{ locale: 'en', title }] },
    variant: null,
    custom_product: null,
    fulfiller_type: fulfiller[0],
    fulfiller_id: fulfiller[1],
  };
}

const P1: [FulfillerType, string] = [FulfillerType.PROVIDER, 'p1'];
const P2: [FulfillerType, string] = [FulfillerType.PROVIDER, 'p2'];
const C1: [FulfillerType, string] = [FulfillerType.CREATOR, 'c1'];

function invoiceFor(items: ProviderMatchItem[]) {
  const gross = items.reduce((s, i) => s + Number(i.total_price), 0) + 49;
  const order: SnapshotOrder = {
    order_number: 'ORD-1',
    created_at: '2026-10-01T10:00:00Z',
    currency: 'SEK',
    payment_method: 'STRIPE',
    paid_at: '2026-10-01T10:00:00Z',
    total: gross,
    tax_amount: 0,
    tax_pricing_mode: 'INCLUSIVE',
    shipping_cost: 49,
    shipping_method_name: 'PostNord',
    address: null,
    customer: null,
    items,
  };
  return withNumber(
    buildInvoiceSnapshot({
      order,
      seller: SELLER,
      bank: {
        bankgiro: null,
        plusgiro: null,
        iban: null,
        bic: null,
        bank_name: null,
      },
      locale: 'en',
      issueDate: '2026-10-01',
      timezone: 'Europe/Stockholm',
      dueDays: 30,
      paid: true,
    }),
    '1001',
  );
}

describe('providerLinesOf', () => {
  const items = [
    item('Mug', 125, 2, 2500, P1, 'MUG'),
    item('Poster', 200, 1, 2500, C1),
    item('Cap', 80, 1, 1200, P2),
    item('Tote bag', 60, 1, 2500, P1),
  ];

  it('returns only the lines of items the provider fulfils', () => {
    const snap = invoiceFor(items);
    const res = providerLinesOf(snap, items, 'p1');
    expect(res.indexes).toEqual([0, 3]);
    expect(res.indexes.map((i) => snap.lines[i].description)).toEqual([
      'Mug',
      'Tote bag',
    ]);
    // INCLUSIVE 25 %: 250 → 200 net, 60 → 48 net.
    expect(res.subtotal).toBe(248);

    expect(providerLinesOf(snap, items, 'p2').indexes).toEqual([2]);
    // A creator id equal to a provider id never matches.
    expect(providerLinesOf(snap, items, 'c1').indexes).toEqual([]);
  });

  it('never attributes shipping / discount lines to a provider', () => {
    const snap = invoiceFor(items);
    const res = providerLinesOf(snap, items, 'p1');
    expect(res.indexes.every((i) => snap.lines[i].kind === 'item')).toBe(true);
  });

  it('does not depend on the order items coming back in issue order', () => {
    const snap = invoiceFor(items);
    const shuffled = [items[3], items[2], items[0], items[1]];
    expect(providerLinesOf(snap, shuffled, 'p1').indexes).toEqual([0, 3]);
  });

  it('falls back to the amounts when the title changed after issuing', () => {
    const snap = invoiceFor(items);
    const renamed = items.map((i) =>
      i === items[3]
        ? {
            ...i,
            product: {
              sku: null,
              translations: [{ locale: 'en', title: 'Bag v2' }],
            },
          }
        : i,
    );
    expect(providerLinesOf(snap, renamed, 'p1').indexes).toEqual([0, 3]);
  });

  it('leaves out an amounts-only match shared by different owners', () => {
    // Same price / qty / rate, both renamed after issuing: ambiguous.
    const a = item('Sticker A', 30, 1, 2500, P1);
    const b = item('Sticker B', 30, 1, 2500, P2);
    const snap = invoiceFor([a, b]);
    const rename = (i: ProviderMatchItem, t: string) => ({
      ...i,
      product: { sku: null, translations: [{ locale: 'en', title: t }] },
    });
    const res = providerLinesOf(snap, [rename(a, 'X'), rename(b, 'Y')], 'p1');
    expect(res.indexes).toEqual([]);
    // With the titles intact the exact pass resolves both.
    expect(providerLinesOf(snap, [a, b], 'p1').indexes).toEqual([0]);
    expect(providerLinesOf(snap, [a, b], 'p2').indexes).toEqual([1]);
  });

  it('tells apart same-title lines by their variant options', () => {
    const withOptions = (
      i: ProviderMatchItem,
      color: string,
    ): ProviderMatchItem => ({
      ...i,
      variant: { sku: null, options: { Color: color } },
    });
    // Other party's Red first: matching on title / SKU / amounts alone
    // would hand line 0 to p1 (mine first).
    const red = withOptions(item('Hoodie', 400, 1, 2500, P2, 'HD'), 'Red');
    const blue = withOptions(item('Hoodie', 400, 1, 2500, P1, 'HD'), 'Blue');
    const snap = invoiceFor([red, blue]);
    expect(snap.lines[0].details).toEqual([{ label: 'Color', value: 'Red' }]);
    const res = providerLinesOf(snap, [red, blue], 'p1');
    expect(res.indexes).toEqual([1]);
    expect(snap.lines[1].details).toEqual([{ label: 'Color', value: 'Blue' }]);
    expect(providerLinesOf(snap, [blue, red], 'p2').indexes).toEqual([0]);
  });

  it('leaves out a line when the details no longer tell the owners apart', () => {
    const red = {
      ...item('Hoodie', 400, 1, 2500, P2, 'HD'),
      variant: { sku: null, options: { Color: 'Red' } },
    };
    const blue = {
      ...item('Hoodie', 400, 1, 2500, P1, 'HD'),
      variant: { sku: null, options: { Color: 'Blue' } },
    };
    const snap = invoiceFor([red, blue]);
    // p1's variant now reads "Red" too: two items, one "Red" line.
    const recolored = {
      ...blue,
      variant: { sku: null, options: { Color: 'Red' } },
    };
    const res = providerLinesOf(snap, [red, recolored], 'p1');
    expect(res.indexes).toEqual([]);
  });

  it('still pairs truly identical lines of different owners', () => {
    const a = item('Sticker', 30, 1, 2500, P2, 'ST');
    const b = item('Sticker', 30, 1, 2500, P1, 'ST');
    const snap = invoiceFor([a, b]);
    // Identical in print: one of the two lines is p1's, either is exact.
    expect(providerLinesOf(snap, [a, b], 'p1').indexes).toHaveLength(1);
    expect(providerLinesOf(snap, [a, b], 'p2').indexes).toHaveLength(1);
  });

  it('matches the negated lines of a full credit note', () => {
    const inv = invoiceFor(items);
    const cn = buildCreditSnapshot({
      original: inv,
      amount: 'full',
      priorCredited: 0,
      issueDate: '2026-10-05',
    });
    const res = providerLinesOf(cn, items, 'p1');
    expect(res.indexes).toEqual([0, 3]);
    expect(res.subtotal).toBe(-248);
  });

  it('finds no provider lines on a partial credit note (per-rate lines)', () => {
    const inv = invoiceFor(items);
    const cn = buildCreditSnapshot({
      original: inv,
      amount: 100,
      priorCredited: 0,
      issueDate: '2026-10-05',
    });
    expect(cn.lines.every((l) => l.kind === 'credit')).toBe(true);
    expect(providerLinesOf(cn, items, 'p1')).toEqual({
      indexes: [],
      subtotal: 0,
    });
  });
});
