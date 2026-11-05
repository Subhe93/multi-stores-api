import { getInvoicePhrases, INVOICE_PHRASES } from './invoice-phrases';
import { renderInvoiceFooterHtml, renderInvoiceHtml } from './invoice-template';
import { supplierCopyPdfFilename } from './invoice-pdf.service';
import { toSnapshotForPdf, toSupplierCopy } from './snapshot-for-pdf';
import {
  sampleArPersonInvoice,
  sampleSvCompanyInvoice,
} from './testing/sample-snapshots';
import type { InvoiceSnapshot } from '../invoices.types';

// Supplier copy for providers: a redacted view model of the stored snapshot
// rendered by the same template (variant flag), never the tax invoice.

function render(stored: InvoiceSnapshot, keep: number[]) {
  const copy = toSupplierCopy(toSnapshotForPdf(stored), keep);
  const p = getInvoicePhrases(copy.locale);
  return {
    copy,
    p,
    html: renderInvoiceHtml(copy, p),
    footer: renderInvoiceFooterHtml(copy, p),
  };
}

describe('supplier copy (redaction)', () => {
  // Line 0 (Hoodie) is the provider's; 1 and 2 belong to other parties.
  const full = sampleSvCompanyInvoice();

  it('keeps only the given lines and their subtotal', () => {
    const { copy } = render(full, [0]);
    expect(copy.supplier_copy).toBe(true);
    expect(copy.lines.map((l) => l.description)).toEqual(['Hoodie Classic']);
    expect(copy.totals).toEqual({
      net: 800,
      vat: 0,
      gross: 800,
      layout: 'excl',
    });
    expect(copy.vat_summary).toEqual([]);
  });

  it('drops buyer contact / tax ids, billing address, payment and bank data', () => {
    const { copy, html, footer } = render(full, [0]);
    expect(Object.keys(copy.buyer).sort()).toEqual(
      ['billing_address', 'name', 'shipping_address', 'type'].sort(),
    );
    expect(copy.buyer.name).toBe('Elektronikhuset Norden AB');
    expect(copy.buyer.billing_address).toBeNull();
    expect(copy.buyer.shipping_address).toMatchObject({
      line1: 'Lagervägen 7',
      phone: null,
    });
    expect(copy.bank).toBeNull();
    expect(copy.tax_exemption).toBeNull();

    const all = html + footer;
    for (const secret of [
      'ekonomi@elektronikhuset.se', // buyer email
      '+46 31 700 00 00', // buyer phone
      'SE556677889901', // buyer VAT number
      '556677-8899', // buyer org number
      'PO-2026-0412', // buyer reference
      'Box 1234', // billing address (differs from delivery)
      'Kaffebönor', // another party's line
      'Svensk design', // another party's line
      'PostNord MyPack', // shipping line
      'HÖST10', // order discount
      '1484', // order gross total
      '237', // order VAT total
      'SE45 5000', // bank IBAN
      '5050-1055', // bankgiro
      'Faktura 30 dagar', // payment label
    ]) {
      expect(all).not.toContain(secret);
    }
    // No VAT summary / totals / bank / payment blocks at all.
    expect(html).not.toContain(getInvoicePhrases('sv').vatSummary);
    expect(html).not.toContain(getInvoicePhrases('sv').totalToPay);
    expect(html).not.toContain(getInvoicePhrases('sv').bankDetails);
    expect(html).not.toContain(getInvoicePhrases('sv').paymentStatus);
  });

  it('prints the localized banner, the delivery address and the header refs', () => {
    const { html, p } = render(full, [0]);
    expect(html).toContain(p.supplierCopyBanner);
    expect(p.supplierCopyBanner).toBe('Leverantörskopia — inte en faktura');
    expect(html).toContain(p.supplierSubtotal);
    expect(html).toContain(p.deliveryAddress);
    expect(html).not.toContain(p.billingAddress);
    expect(html).toContain('Elektronikhuset Norden AB');
    expect(html).toContain('Lagervägen 7');
    expect(html).toContain('1001'); // document number
    expect(html).toContain('ORD-7F3K2Q');
    expect(html).toContain('Swedags'); // store
    expect(html).toContain('Hoodie Classic');
    expect(html).toContain('HD-100-BLK-L');
    // The h1 is "Supplier copy", not "Invoice".
    expect(html).toContain(`<h1>${p.supplierCopy}</h1>`);
  });

  it('uses the delivery address when billing equals delivery (person)', () => {
    const ar = sampleArPersonInvoice();
    const { html, copy, p } = render(ar, [0]);
    expect(copy.buyer.email).toBeUndefined();
    expect(html).not.toContain('sara@example.com');
    expect(html).not.toContain('+46 70 123 45 67');
    expect(html).toContain('Drottninggatan 45');
    expect(html).toContain(p.supplierCopyBanner);
    expect(html).toContain('dir="rtl"');
  });

  it('never falls back to the billing address when there is no delivery address', () => {
    const noShip: InvoiceSnapshot = {
      ...full,
      buyer: { ...full.buyer, shipping_address: null },
    };
    const { html, copy, p } = render(noShip, [0]);
    expect(copy.buyer.shipping_address).toBeNull();
    expect(copy.buyer.billing_address).toBeNull();
    expect(html).not.toContain('Box 1234');
    expect(html).not.toContain(p.deliveryAddress);
    expect(html).not.toContain(p.billingAddress);
    expect(html).toContain('Hoodie Classic');
  });

  it('redacts a credit note the same way and keeps the credited reference', () => {
    const cn: InvoiceSnapshot = {
      ...full,
      kind: 'CREDIT_NOTE',
      lines: full.lines.map((l) => ({
        ...l,
        unit_net: -l.unit_net,
        line_net: -l.line_net,
      })),
      bank: null,
      refs: {
        ...full.refs,
        invoice_number: 'CN-7',
        credited_number: '1001',
        credited_issue_date: '2026-10-14',
        reason: 'Customer phoned about +46 31 700 00 00',
      },
    };
    const { html, copy } = render(cn, [0]);
    expect(copy.lines.map((l) => l.line_net)).toEqual([-800]);
    expect(copy.totals.net).toBe(-800);
    expect(html).toContain('CN-7');
    expect(html).toContain('1001');
    expect(html).not.toContain('Kaffebönor');
    // Free-text reasons may hold buyer data: never printed on the copy.
    expect(html).not.toContain('Customer phoned');
  });

  it('leaves the tax-invoice rendering untouched', () => {
    const p = getInvoicePhrases('sv');
    const html = renderInvoiceHtml(toSnapshotForPdf(full), p);
    expect(html).not.toContain(p.supplierCopyBanner);
    expect(html).toContain('ekonomi@elektronikhuset.se');
  });

  it('names the file after the localized label (ASCII, en fallback)', () => {
    expect(supplierCopyPdfFilename('sv', '1001')).toBe(
      'Leverantorskopia-1001.pdf',
    );
    expect(supplierCopyPdfFilename('ar', '1001')).toBe(
      'Supplier-copy-1001.pdf',
    );
    expect(INVOICE_PHRASES.en.supplierCopy).toBe('Supplier copy');
  });
});
