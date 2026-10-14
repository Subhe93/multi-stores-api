import {
  INVOICE_PHRASES,
  PDF_LOCALES,
  fillPhrase,
  getInvoicePhrases,
  resolvePdfLocale,
} from './invoice-phrases';
import {
  esc,
  renderInvoiceFooterHtml,
  renderInvoiceHtml,
  shouldShowBankBox,
} from './invoice-template';
import { formatMoney } from './invoice-format';
import { invoicePdfFilename } from './invoice-pdf.service';
import { toSnapshotForPdf, type SnapshotForPdf } from './snapshot-for-pdf';
import {
  sampleArPersonInvoice,
  sampleSvCompanyInvoice,
  sampleSvCreditNote,
} from './testing/sample-snapshots';

const nbsp = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');

function render(snap: SnapshotForPdf): string {
  return renderInvoiceHtml(snap, getInvoicePhrases(snap.locale));
}

const sv = () => toSnapshotForPdf(sampleSvCompanyInvoice());
const ar = () => toSnapshotForPdf(sampleArPersonInvoice());
const cn = () => toSnapshotForPdf(sampleSvCreditNote());

describe('invoice phrases', () => {
  const enKeys = Object.keys(INVOICE_PHRASES.en).sort();

  it.each(PDF_LOCALES)('%s has exactly the en keys, all non-empty', (loc) => {
    const p = INVOICE_PHRASES[loc] as Record<string, string>;
    expect(Object.keys(p).sort()).toEqual(enKeys);
    for (const k of enKeys) expect(p[k].trim()).not.toBe('');
  });

  it.each(PDF_LOCALES)('%s keeps every {placeholder} of en', (loc) => {
    const p = INVOICE_PHRASES[loc] as Record<string, string>;
    const en = INVOICE_PHRASES.en as Record<string, string>;
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const k of enKeys) expect(ph(p[k])).toEqual(ph(en[k]));
  });

  it('uses the Swedish legal wording', () => {
    const p = INVOICE_PHRASES.sv;
    expect(p.invoice).toBe('Faktura');
    expect(p.creditNote).toBe('Kreditfaktura');
    expect(p.orgNumber).toBe('Org.nr');
    expect(p.vatNumber).toBe('Momsreg.nr');
    expect(p.dueDate).toBe('Förfallodatum');
    expect(p.fTaxApproved).toBe('Godkänd för F-skatt');
    expect(p.ofWhichVat).toBe('varav moms');
  });

  it('resolves locales with fallback to en', () => {
    expect(resolvePdfLocale('sv-SE')).toBe('sv');
    expect(resolvePdfLocale('AR')).toBe('ar');
    expect(resolvePdfLocale('nl')).toBe('en');
    expect(resolvePdfLocale(null)).toBe('en');
    expect(fillPhrase('Page {x} of {y}', { x: 1, y: 2 })).toBe('Page 1 of 2');
  });
});

describe('formatMoney', () => {
  it('formats SEK the Swedish way with Latin digits', () => {
    expect(nbsp(formatMoney(1234.5, 'SEK', 'sv'))).toBe('1 234,50 kr');
    expect(formatMoney(1234.5, 'SEK', 'ar')).toMatch(/^[0-9.,\sA-Z]+$/);
    expect(formatMoney(1200, 'JPY', 'en')).not.toMatch(/\.00/);
    expect(nbsp(formatMoney(-0.001, 'SEK', 'sv'))).toBe('0,00 kr');
  });
});

describe('renderInvoiceHtml', () => {
  it('renders sv as LTR with Swedish amounts and labels', () => {
    const html = render(sv());
    expect(html).toContain('<html lang="sv" dir="ltr">');
    expect(html).toContain('>Faktura<');
    expect(nbsp(html)).toContain('1 484,41 kr');
    expect(html).toContain('Momsreg.nr');
    expect(html).toContain('556036-0793');
    // Items, shipping and the discount line, labelled by kind.
    expect(html).toContain('Hoodie Classic');
    expect(html).toContain('<bdi>Färg</bdi>: <bdi>Svart</bdi>');
    expect(html).toContain('Frakt: <bdi>PostNord MyPack</bdi>');
    expect(html).toContain('Rabatt: <bdi>HÖST10</bdi>');
    expect(html).toContain('Art.nr: <bdi dir="ltr">HD-100-BLK-L</bdi>');
    // The contact person is listed once, not repeated inside the address.
    expect(html.match(/Anna Lindqvist/g)).toHaveLength(2); // contact + delivery
    // Delivery address differs from billing → both blocks.
    expect(html).toContain('Leveransadress');
    expect(html).toContain('Lagervägen 7');
  });

  it('renders ar as RTL with numbers isolated LTR', () => {
    const html = render(ar());
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('فاتورة');
    // Amounts, org number and dates sit in LTR isolates with Latin digits.
    expect(html).toMatch(/<bdi dir="ltr">1,346\.00\sSEK<\/bdi>/);
    expect(html).toContain('<bdi dir="ltr">556036-0793</bdi>');
    expect(html).toContain('<bdi dir="ltr">14/10/2026</bdi>');
    expect(html).not.toMatch(/[٠-٩]/); // no Arabic-Indic digits
    expect(html).not.toMatch(/[\u200e\u200f\u061c]/); // no stray bidi marks
    // Same billing and delivery address → no separate delivery block.
    expect(html).not.toContain('عنوان التوصيل');
  });

  it('uses the excl layout for a company buyer', () => {
    const html = render(sv());
    expect(html).toContain('totals-excl');
    expect(html).toContain('Summa exkl. moms');
    expect(html).toMatch(/Moms <bdi dir="ltr">25\s%<\/bdi>/);
    expect(html).toContain('Att betala'); // unpaid
    expect(html).not.toContain('varav moms');
  });

  it('uses the incl layout ("of which VAT") for a person', () => {
    const html = render(ar());
    expect(html).toContain('totals-incl');
    expect(html).toContain('of-which-vat');
    expect(html).toContain(INVOICE_PHRASES.ar.ofWhichVat);
    const svIncl = toSnapshotForPdf({
      ...sampleSvCompanyInvoice(),
      totals: { net: 1247, vat: 237.41, gross: 1484.41, layout: 'incl' },
    });
    expect(render(svIncl)).toContain('varav moms');
  });

  describe('bank box', () => {
    it('shows for an unpaid, non-COD invoice', () => {
      const s = sv();
      expect(shouldShowBankBox(s)).toBe(true);
      const html = render(s);
      expect(html).toContain('class="bank"');
      expect(html).toContain(
        '<bdi dir="ltr">SE45 5000 0000 0583 9825 7466</bdi>',
      );
      expect(html).toContain('<bdi dir="ltr">5050-1055</bdi>');
      expect(html).toContain('Betalningsinformation');
    });

    it('is hidden when paid', () => {
      const s = sv();
      s.payment.status = 'paid';
      expect(shouldShowBankBox(s)).toBe(false);
      expect(render(s)).not.toContain('class="bank"');
    });

    it('is hidden for cash on delivery', () => {
      const s = sv();
      s.payment.method = 'COD';
      expect(shouldShowBankBox(s)).toBe(false);
      expect(render(s)).not.toContain('class="bank"');
    });

    it('is hidden on credit notes and without bank data', () => {
      expect(shouldShowBankBox(cn())).toBe(false);
      const s = sv();
      s.bank = null;
      expect(shouldShowBankBox(s)).toBe(false);
    });
  });

  it('renders a credit note with the reference to the original', () => {
    const html = render(cn());
    expect(html).toContain('Kreditfaktura');
    expect(html).toContain('Kreditfakturanummer');
    expect(html).toContain(
      'Kreditering av faktura <bdi dir="ltr">1001</bdi> daterad <bdi dir="ltr">2026-10-14</bdi>',
    );
    expect(html).toContain('Återbetalning');
    expect(html).toContain('Krediterat belopp');
    expect(nbsp(html)).toContain('\u22121 484,41 kr');
    expect(html).not.toContain('Förfallodatum');
  });

  it('prefers a free-text credit reason over the reason code', () => {
    const raw = sampleSvCreditNote();
    raw.refs.reason = 'Skadad vara';
    expect(render(toSnapshotForPdf(raw))).toContain('Skadad vara');
  });

  it('escapes every buyer / seller / line string', () => {
    const raw = sampleSvCompanyInvoice();
    const evil = '<script>alert("x")</script> & \'Co\'';
    raw.buyer.name = evil;
    raw.buyer.reference = evil;
    raw.buyer.billing_address!.line1 = evil;
    raw.seller.legal_name = evil;
    raw.seller.footer_note = evil;
    raw.lines[0].description = evil;
    raw.lines[0].details = [{ label: evil, value: evil }];
    const snap = toSnapshotForPdf(raw);
    const p = getInvoicePhrases('sv');
    const html = renderInvoiceHtml(snap, p) + renderInvoiceFooterHtml(snap, p);
    expect(html).not.toContain('<script>');
    expect(html).toContain(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Co&#39;',
    );
    expect(esc('<a href="x">')).toBe('&lt;a href=&quot;x&quot;&gt;');
  });

  it('only embeds data: URI logos', () => {
    const p = getInvoicePhrases('sv');
    expect(
      renderInvoiceHtml(sv(), p, { logoDataUri: 'https://evil.example/x.png' }),
    ).not.toContain('<img');
    expect(
      renderInvoiceHtml(sv(), p, {
        logoDataUri: 'data:image/png;base64,iVBORw0KGgo=',
      }),
    ).toContain('<img class="logo" src="data:image/png;base64,iVBORw0KGgo="');
  });
});

describe('renderInvoiceFooterHtml', () => {
  it('prints legal line, F-tax and page numbers', () => {
    const html = renderInvoiceFooterHtml(sv(), getInvoicePhrases('sv'));
    expect(html).toContain('Neronet Academy AB');
    expect(html).toContain('Säte: <bdi>Stockholm</bdi>');
    expect(html).toContain('Godkänd för F-skatt');
    expect(html).toContain(
      'Sida <span class="pageNumber"></span> av <span class="totalPages"></span>',
    );
  });

  it('omits F-tax when not approved and goes RTL for ar', () => {
    const raw = sampleSvCompanyInvoice();
    raw.seller.f_tax_approved = false;
    expect(
      renderInvoiceFooterHtml(toSnapshotForPdf(raw), getInvoicePhrases('sv')),
    ).not.toContain('F-skatt');
    const arHtml = renderInvoiceFooterHtml(ar(), getInvoicePhrases('ar'));
    expect(arHtml).toContain('dir="rtl"');
    expect(arHtml).toContain('صفحة <span class="pageNumber"></span> من');
  });
});

describe('toSnapshotForPdf / filename', () => {
  it('maps refs and nested seller address', () => {
    const s = sv();
    expect(s.number).toBe('1001');
    expect(s.issue_date).toBe('2026-10-14');
    expect(s.due_date).toBe('2026-11-13');
    expect(s.seller.city).toBe('Stockholm');
    expect(s.buyer.contact_name).toBe('Anna Lindqvist');
    expect(cn().refs.credited_invoice_number).toBe('1001');
    expect(() => toSnapshotForPdf(null)).toThrow();
  });

  it('builds ASCII filenames per locale', () => {
    expect(invoicePdfFilename({ kind: 'INVOICE', locale: 'sv' }, '1001')).toBe(
      'Faktura-1001.pdf',
    );
    expect(
      invoicePdfFilename({ kind: 'CREDIT_NOTE', locale: 'de' }, 'CN-1'),
    ).toBe('Gutschrift-CN-1.pdf');
    expect(invoicePdfFilename({ kind: 'INVOICE', locale: 'ar' }, '1/2')).toBe(
      'Invoice-1-2.pdf',
    );
  });
});
