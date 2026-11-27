import { getInvoicePhrases } from './invoice-phrases';
import { renderInvoiceHtml } from './invoice-template';
import { toSnapshotForPdf, toSupplierCopy } from './snapshot-for-pdf';
import { sampleArPersonInvoice } from './testing/sample-snapshots';
import type { InvoiceAddress, InvoiceSnapshot } from '../invoices.types';

// M175: the invoice heads its billing block with the BUYER; a parcel for
// another person prints the existing delivery block with the recipient (and
// the "c/o" line). The layout is the pre-M175 one: no new block, and a
// snapshot whose two addresses are the same prints exactly as before.

const street: InvoiceAddress = {
  name: 'Anna Svensson',
  company_name: null,
  line1: 'Sturegatan 6',
  line2: null,
  postal_code: '114 35',
  city: 'Stockholm',
  state: null,
  country_code: 'SE',
  phone: null,
};

function personInvoice(
  shipping: Partial<InvoiceAddress> = {},
  billing: Partial<InvoiceAddress> = {},
): InvoiceSnapshot {
  const base = sampleArPersonInvoice();
  return {
    ...base,
    locale: 'en',
    buyer: {
      ...base.buyer,
      type: 'PERSON',
      name: 'Anna Svensson',
      billing_address: { ...street, ...billing },
      shipping_address: { ...street, ...shipping },
    },
  };
}

const p = getInvoicePhrases('en');
const html = (s: InvoiceSnapshot) =>
  renderInvoiceHtml(toSnapshotForPdf(s), getInvoicePhrases('en'));
const supplierHtml = (s: InvoiceSnapshot) =>
  renderInvoiceHtml(
    toSupplierCopy(toSnapshotForPdf(s), [0]),
    getInvoicePhrases('en'),
  );
/** The text of the party block that starts with the given heading. */
function party(doc: string, heading: string): string {
  const start = doc.indexOf(`<h2>${heading}</h2>`);
  if (start < 0) return '';
  return doc
    .slice(start, doc.indexOf('</div>\n</div>', start))
    .replace(/<br>/g, '\n')
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' | ');
}

describe('invoice PDF: buyer vs recipient (M175)', () => {
  it('same person on both addresses: one block, no delivery block', () => {
    const doc = html(personInvoice());
    expect(doc).toContain(`<h2>${p.billingAddress}</h2>`);
    expect(doc).not.toContain(`<h2>${p.deliveryAddress}</h2>`);
    expect(doc.split('Anna Svensson').length - 1).toBe(1);
  });

  it('a parcel for someone else: the buyer heads the invoice, the recipient is on the delivery block', () => {
    const doc = html(personInvoice({ name: 'Karin Berg' }));
    expect(party(doc, p.billingAddress)).toMatch(
      /^Billing address \| Anna Svensson \| Sturegatan 6 \| 114 35 Stockholm/,
    );
    expect(party(doc, p.billingAddress)).not.toContain('Karin Berg');
    expect(party(doc, p.deliveryAddress)).toMatch(
      /^Delivery address \| Karin Berg \| Sturegatan 6 \| 114 35 Stockholm/,
    );
  });

  it('c/o prints on its own line under the name', () => {
    const careOf = { care_of: 'Familjen Lind' };
    const doc = html(personInvoice({ name: 'Karin Berg', ...careOf }, careOf));
    expect(party(doc, p.deliveryAddress)).toMatch(
      /^Delivery address \| Karin Berg \| c\/o Familjen Lind \| Sturegatan 6/,
    );
    expect(party(doc, p.billingAddress)).toMatch(
      /^Billing address \| Anna Svensson \| c\/o Familjen Lind \| Sturegatan 6/,
    );
  });

  it('a snapshot without care_of (issued before M175) prints no c/o line', () => {
    expect(html(personInvoice({ name: 'Karin Berg' }))).not.toContain('c/o');
    expect(p.billingAddress).toBe('Billing address');
    expect(p.deliveryAddress).toBe('Delivery address');
  });
});

describe('supplier copy: the delivery block names the recipient (M175)', () => {
  it('a parcel for someone else is headed by the recipient, not the buyer', () => {
    const doc = supplierHtml(
      personInvoice({ name: 'Karin Berg', care_of: 'Familjen Lind' }),
    );
    expect(party(doc, p.deliveryAddress)).toMatch(
      /^Delivery address \| Karin Berg \| c\/o Familjen Lind \| Sturegatan 6/,
    );
    expect(doc).not.toContain('Anna Svensson');
  });

  it('buyer and recipient the same: headed by that name, printed once', () => {
    const doc = supplierHtml(personInvoice());
    expect(party(doc, p.deliveryAddress)).toMatch(
      /^Delivery address \| Anna Svensson \| Sturegatan 6/,
    );
    expect(doc.split('Anna Svensson').length - 1).toBe(1);
  });

  it('an address without a name falls back to the buyer name', () => {
    const doc = supplierHtml(personInvoice({ name: null }));
    expect(party(doc, p.deliveryAddress)).toMatch(
      /^Delivery address \| Anna Svensson \| Sturegatan 6/,
    );
  });
});
