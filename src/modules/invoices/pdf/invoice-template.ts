/**
 * Pure HTML template for invoice and credit-note PDFs (M3-DESIGN §4.1).
 *
 * - One self-contained A4 document: inline CSS, base64 fonts, logo as a data
 *   URI. Nothing is fetched (the renderer blocks the network).
 * - Every dynamic string goes through `esc()`.
 * - Arabic renders `dir="rtl"`; amounts, dates, numbers, org/VAT numbers and
 *   IBAN are isolated in `<bdi dir="ltr">` so they never reorder; free text
 *   (names, addresses) is isolated in `<bdi>` (direction auto).
 * - Lines follow the client's Elgiganten example (D12): unit price excl. VAT,
 *   qty, VAT %, amount excl. VAT; shipping / discount / rounding as lines;
 *   a VAT summary per rate; two totals layouts (`excl` / `incl`).
 * - The bank box appears only when the invoice is unpaid and not COD.
 * - The legal line, F-tax line and "page x / y" go into Chromium's
 *   footerTemplate (`renderInvoiceFooterHtml`).
 */
import {
  fillPhrase,
  resolvePdfLocale,
  type InvoicePhrases,
} from './invoice-phrases';
import {
  formatDate,
  formatMoney,
  formatNumber,
  formatPercent,
} from './invoice-format';
import { INVOICE_FONT_STACK } from './fonts';
import type {
  PdfAddress,
  PdfLine,
  PdfLineDetail,
  PdfLocale,
  SnapshotForPdf,
} from './snapshot-for-pdf';

export interface InvoiceTemplateOptions {
  /** `data:` URI of the seller logo; anything else is ignored. */
  logoDataUri?: string | null;
  /** `@font-face` CSS (see fonts.ts); omitted in unit tests. */
  fontCss?: string;
}

// ---------------------------------------------------------------- helpers

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

type Scalar = string | number | boolean | null | undefined;

/** HTML-escapes any value (null/undefined → ''). */
export function esc(value: Scalar): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Left-to-right isolated run (numbers, amounts, dates, identifiers). */
function ltr(value: Scalar): string {
  const s = esc(value);
  return s ? `<bdi dir="ltr">${s}</bdi>` : '';
}

/** Direction-isolated free text (names, addresses) — direction auto. */
function txt(value: Scalar): string {
  const s = esc(value);
  return s ? `<bdi>${s}</bdi>` : '';
}

/** Escaped phrase with escaped `{vars}` filled in (vars may contain markup). */
function phrase(p: string, vars: Record<string, string> = {}): string {
  return fillPhrase(esc(p), vars);
}

function present(v: Scalar): boolean {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

function isCod(method: string | null | undefined): boolean {
  const m = String(method ?? '').toUpperCase();
  return m === 'COD' || m === 'CASH_ON_DELIVERY';
}

/** Bank box rule (D7/§4.1): only when unpaid and not cash on delivery. */
export function shouldShowBankBox(s: SnapshotForPdf): boolean {
  if (s.kind !== 'INVOICE') return false;
  if (s.payment?.status === 'paid') return false;
  if (isCod(s.payment?.method)) return false;
  const b = s.bank;
  return (
    !!b &&
    [b.bankgiro, b.plusgiro, b.iban].some((v) => present(v)) &&
    Number(s.totals?.gross) > 0
  );
}

/** Localised country name for an ISO2 code ("SE" → "Sverige"). */
function countryName(
  code: string | null | undefined,
  locale: PdfLocale,
): string {
  if (!present(code)) return '';
  const c = String(code).trim().toUpperCase();
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(c) ?? c;
  } catch {
    return c;
  }
}

function addressLines(
  a: PdfAddress | null | undefined,
  locale: PdfLocale,
): string[] {
  if (!a) return [];
  const cityLine = [a.postal_code, a.city].filter(present).join(' ');
  return [
    a.company,
    a.name,
    a.line1,
    a.line2,
    cityLine,
    a.state,
    countryName(a.country_code, locale),
  ]
    .filter(present)
    .map((v) => String(v).trim());
}

function sameAddress(
  a: PdfAddress | null | undefined,
  b: PdfAddress | null | undefined,
): boolean {
  return addressLines(a, 'en').join('|') === addressLines(b, 'en').join('|');
}

/** "Label: value" as HTML, each part isolated so mixed scripts never reorder. */
function detailHtml(d: PdfLineDetail): string {
  if (typeof d === 'string') return txt(d);
  if (!d) return '';
  return present(d.label) ? `${txt(d.label)}: ${txt(d.value)}` : txt(d.value);
}

/** One label/value row in a key-value list. */
function kv(label: string, valueHtml: string): string {
  if (!valueHtml) return '';
  return `<tr><th>${esc(label)}</th><td>${valueHtml}</td></tr>`;
}

// ---------------------------------------------------------------- CSS

function css(fontCss: string, rtl: boolean): string {
  return `
${fontCss}
@page { size: A4; margin: 15mm 14mm 27mm 14mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: ${INVOICE_FONT_STACK};
  font-size: 9pt; line-height: 1.4; color: #1f2328;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
bdi[dir="ltr"] { unicode-bidi: isolate; direction: ltr; }
.muted { color: #6a737d; }
.small { font-size: 7.8pt; }
.header { display: flex; justify-content: space-between; align-items: flex-start; gap: 10mm; }
.brand { flex: 1 1 auto; min-width: 0; }
.brand .logo { max-height: 18mm; max-width: 60mm; object-fit: contain; display: block; margin-bottom: 4mm; }
.brand .brand-name { font-size: 14pt; font-weight: 700; letter-spacing: ${rtl ? '0' : '-0.01em'}; }
.brand .legal { margin-top: 1mm; }
.doc { flex: 0 0 74mm; }
.doc h1 { margin: 0 0 3mm; font-size: 20pt; font-weight: 700; letter-spacing: ${rtl ? '0' : '0.04em'}; text-transform: ${rtl ? 'none' : 'uppercase'}; text-align: end; }
.doc h1.credit { color: #b42318; }
.kvt { width: 100%; border-collapse: collapse; }
.kvt th { text-align: start; font-weight: 400; color: #6a737d; padding: 0.45mm 0; white-space: nowrap; padding-inline-end: 4mm; vertical-align: top; }
.kvt td { text-align: end; padding: 0.45mm 0; font-weight: 600; }
.doc .kvt { border-top: 0.6mm solid #1f2328; }
.doc .kvt tr:first-child th, .doc .kvt tr:first-child td { padding-top: 1.6mm; }
.chip { display: inline-block; padding: 0.3mm 2.2mm; border-radius: 3mm; font-size: 7.6pt; font-weight: 700; }
.chip.paid { background: #e6f4ea; color: #1a7f37; }
.chip.unpaid { background: #fff4e5; color: #9a6700; }
.parties { display: flex; gap: 6mm; margin-top: 6mm; }
.party { flex: 1 1 0; min-width: 0; }
.party h2, .section-title { margin: 0 0 1.6mm; font-size: 7.6pt; font-weight: 700; text-transform: ${rtl ? 'none' : 'uppercase'}; letter-spacing: ${rtl ? '0' : '0.08em'}; color: #6a737d; border-bottom: 0.25mm solid #d0d7de; padding-bottom: 1mm; }
.party .name { font-weight: 700; font-size: 10pt; }
.party .ids { margin-top: 1.2mm; }
.credit-ref { margin-top: 7mm; padding: 2.6mm 3.4mm; border-inline-start: 1mm solid #b42318; background: #fdf2f1; }
.credit-ref .title { font-weight: 700; }
table.lines { width: 100%; border-collapse: collapse; margin-top: 6mm; }
table.lines thead th { background: #f3f4f6; font-size: 7.6pt; font-weight: 700; color: #444d56; padding: 1.6mm 2mm; text-align: end; vertical-align: bottom; line-height: 1.25; min-width: 20mm; border-bottom: 0.3mm solid #d0d7de; }
table.lines thead th.qty { min-width: 0; }
table.lines thead th.desc { text-align: start; }
table.lines td { padding: 1.6mm 2mm; border-bottom: 0.2mm solid #e5e7eb; text-align: end; vertical-align: top; white-space: nowrap; }
table.lines td.desc { text-align: start; white-space: normal; width: 100%; }
table.lines td.desc .d { color: #6a737d; font-size: 7.8pt; }
table.lines tr { break-inside: avoid; }
table.lines tr.adj td { color: #444d56; }
.bottom { display: flex; gap: 8mm; margin-top: 5mm; align-items: flex-start; break-inside: avoid; }
.vat-summary { flex: 1 1 0; }
.vat-summary table { width: 100%; border-collapse: collapse; }
.vat-summary th { font-size: 7.4pt; font-weight: 700; color: #6a737d; text-align: end; padding: 1mm 1.5mm; border-bottom: 0.25mm solid #d0d7de; }
.vat-summary th:first-child, .vat-summary td:first-child { text-align: start; }
.vat-summary td { text-align: end; padding: 1mm 1.5mm; border-bottom: 0.2mm solid #eef0f2; }
.totals { flex: 0 0 76mm; }
.totals table { width: 100%; border-collapse: collapse; }
.totals th { text-align: start; font-weight: 400; padding: 1mm 0; }
.totals td { text-align: end; padding: 1mm 0; white-space: nowrap; }
.totals tr.sub th { padding-inline-start: 4mm; color: #6a737d; font-size: 8pt; }
.totals tr.sub td { color: #6a737d; font-size: 8pt; }
.totals tr.grand th, .totals tr.grand td { font-size: 12.5pt; font-weight: 700; border-top: 0.6mm solid #1f2328; padding-top: 2.2mm; }
.totals tr.after-grand th, .totals tr.after-grand td { padding-top: 1.5mm; }
.bank { margin-top: 5mm; border: 0.3mm solid #d0d7de; border-radius: 1.5mm; padding: 2.5mm 4mm; break-inside: avoid; }
.bank .grid { display: flex; flex-wrap: wrap; gap: 1.5mm 8mm; margin-top: 1mm; }
.bank .item .l { font-size: 7.4pt; color: #6a737d; }
.bank .item .v { font-weight: 700; font-size: 10pt; }
.bank .note { margin-top: 1.5mm; }
.footer-note { margin-top: 6mm; white-space: pre-line; color: #444d56; }
`;
}

// ---------------------------------------------------------------- blocks

function sellerBlock(
  s: SnapshotForPdf,
  p: InvoicePhrases,
  locale: PdfLocale,
  logoDataUri: string | null | undefined,
): string {
  const seller = s.seller;
  const logo =
    logoDataUri && /^data:image\/[a-z0-9.+-]+;base64,/i.test(logoDataUri)
      ? `<img class="logo" src="${esc(logoDataUri)}" alt="">`
      : '';
  const brand = present(seller.brand_name)
    ? seller.brand_name
    : seller.legal_name;
  const addr = addressLines(
    {
      line1: seller.address_line1,
      line2: seller.address_line2,
      postal_code: seller.postal_code,
      city: seller.city,
      country_code: seller.country_code,
    },
    locale,
  );
  const showLegal =
    present(seller.brand_name) &&
    String(seller.brand_name).trim() !== String(seller.legal_name).trim();
  return `
<div class="brand">
  ${logo}
  <div class="brand-name">${txt(brand)}</div>
  ${showLegal ? `<div class="legal">${txt(seller.legal_name)}</div>` : ''}
  <div class="muted">${addr.map(txt).join('<br>')}</div>
  <div class="muted small" style="margin-top:1.2mm">
    ${present(seller.org_number) ? `${esc(p.orgNumber)} ${ltr(seller.org_number)}` : ''}
    ${present(seller.org_number) && present(seller.vat_number) ? ' &nbsp;·&nbsp; ' : ''}
    ${present(seller.vat_number) ? `${esc(p.vatNumber)} ${ltr(seller.vat_number)}` : ''}
  </div>
</div>`;
}

function docBlock(
  s: SnapshotForPdf,
  p: InvoicePhrases,
  locale: PdfLocale,
): string {
  const credit = s.kind === 'CREDIT_NOTE';
  const title = credit ? p.creditNote : p.invoice;
  const paid = s.payment?.status === 'paid';
  const cod = isCod(s.payment?.method);
  const methodLabel = present(s.payment?.label)
    ? s.payment.label
    : cod
      ? p.cashOnDelivery
      : s.payment?.method;
  const status = credit
    ? ''
    : `<span class="chip ${paid ? 'paid' : 'unpaid'}">${esc(paid ? p.paid : p.unpaid)}</span>`;
  const rows = [
    kv(credit ? p.creditNoteNumber : p.number, ltr(s.number)),
    kv(
      credit ? p.creditNoteDate : p.issueDate,
      ltr(formatDate(s.issue_date, locale)),
    ),
    !credit && present(s.due_date)
      ? kv(p.dueDate, ltr(formatDate(s.due_date, locale)))
      : '',
    kv(p.orderNumber, ltr(s.refs?.order_number)),
    present(s.refs?.order_date)
      ? kv(p.orderDate, ltr(formatDate(s.refs.order_date, locale)))
      : '',
    present(methodLabel) ? kv(p.paymentMethod, txt(methodLabel)) : '',
    status ? kv(p.paymentStatus, status) : '',
  ].join('');
  return `
<div class="doc">
  <h1 class="${credit ? 'credit' : ''}">${esc(title)}</h1>
  <table class="kvt">${rows}</table>
</div>`;
}

function buyerBlock(
  s: SnapshotForPdf,
  p: InvoicePhrases,
  locale: PdfLocale,
): string {
  const b = s.buyer;
  // The buyer name is the heading and the contact person is listed below,
  // so neither is repeated inside the address.
  const ba = b.billing_address;
  const same = (v: string | null | undefined, w: string | null | undefined) =>
    present(v) && present(w) && String(v).trim() === String(w).trim();
  const billing = addressLines(
    ba
      ? {
          ...ba,
          company: same(ba.company, b.name) ? null : ba.company,
          name:
            same(ba.name, b.name) || same(ba.name, b.contact_name)
              ? null
              : ba.name,
        }
      : null,
    locale,
  );
  const ids = [
    [
      present(b.org_number) ? `${esc(p.orgNumber)} ${ltr(b.org_number)}` : '',
      present(b.vat_number) ? `${esc(p.vatNumber)} ${ltr(b.vat_number)}` : '',
    ]
      .filter(Boolean)
      .join(' &nbsp;·&nbsp; '),
    present(b.contact_name)
      ? `${esc(p.contactPerson)}: ${txt(b.contact_name)}`
      : '',
    present(b.reference) ? `${esc(p.reference)}: ${txt(b.reference)}` : '',
    [b.email, b.phone].filter(present).map(ltr).join(' &nbsp;·&nbsp; '),
  ].filter(Boolean);

  const party = `
<div class="party">
  <h2>${esc(p.billingAddress)}</h2>
  <div class="name">${txt(b.name)}</div>
  <div>${billing.map(txt).join('<br>')}</div>
  ${ids.length ? `<div class="ids small">${ids.join('<br>')}</div>` : ''}
</div>`;

  const ship = b.shipping_address;
  const delivery =
    ship &&
    addressLines(ship, locale).length &&
    !sameAddress(ship, b.billing_address)
      ? `
<div class="party">
  <h2>${esc(p.deliveryAddress)}</h2>
  <div>${addressLines(ship, locale).map(txt).join('<br>')}</div>
</div>`
      : '';

  return `<div class="parties">${party}${delivery}</div>`;
}

function creditRefBlock(
  s: SnapshotForPdf,
  p: InvoicePhrases,
  locale: PdfLocale,
): string {
  if (s.kind !== 'CREDIT_NOTE') return '';
  const r = s.refs ?? ({} as SnapshotForPdf['refs']);
  const head = present(r.credited_invoice_number)
    ? phrase(p.creditFor, {
        number: ltr(r.credited_invoice_number),
        date: ltr(formatDate(r.credited_invoice_date, locale)),
      })
    : '';
  const reasonText = present(r.reason)
    ? String(r.reason)
    : r.reason_code === 'refund'
      ? p.reasonRefund
      : r.reason_code === 'cancellation'
        ? p.reasonCancellation
        : '';
  if (!head && !reasonText) return '';
  return `
<div class="credit-ref">
  ${head ? `<div class="title">${head}</div>` : ''}
  ${reasonText ? `<div>${esc(p.reason)}: ${txt(reasonText)}</div>` : ''}
</div>`;
}

/** Description HTML: item text, or localised kind label (+ description). */
function lineLabel(l: PdfLine, p: InvoicePhrases): string {
  const kind = l.kind ?? 'item';
  if (kind === 'item') return txt(l.description);
  const label =
    kind === 'shipping'
      ? p.shipping
      : kind === 'discount'
        ? p.discount
        : kind === 'rounding'
          ? p.rounding
          : p.creditLine;
  return present(l.description)
    ? `${esc(label)}: ${txt(l.description)}`
    : esc(label);
}

function linesTable(
  s: SnapshotForPdf,
  p: InvoicePhrases,
  locale: PdfLocale,
): string {
  const money = (v: number) => ltr(formatMoney(v, s.currency, locale));
  const rows = (s.lines ?? [])
    .map((l) => {
      const kind = l.kind ?? 'item';
      // Discount and rounding are amounts, not units: no qty / unit price.
      const unitless = kind === 'discount' || kind === 'rounding';
      const details = [
        ...(l.details ?? []).map(detailHtml),
        present(l.sku) ? `${esc(p.sku)}: ${ltr(l.sku)}` : '',
      ].filter(Boolean);
      const rate =
        l.vat_rate_bp === null || l.vat_rate_bp === undefined
          ? ''
          : ltr(formatPercent(l.vat_rate_bp, locale));
      return `<tr class="${kind === 'item' ? 'item' : `adj ${esc(kind)}`}">
  <td class="desc"><div>${lineLabel(l, p)}</div>${details
    .map((d) => `<div class="d">${d}</div>`)
    .join('')}</td>
  <td>${unitless ? '' : ltr(formatNumber(l.qty, locale))}</td>
  <td>${unitless ? '' : money(l.unit_net)}</td>
  <td>${rate}</td>
  <td>${money(l.line_net)}</td>
</tr>`;
    })
    .join('');

  return `
<table class="lines">
  <thead><tr>
    <th class="desc">${esc(p.description)}</th>
    <th class="qty">${esc(p.qty)}</th>
    <th>${esc(p.unitPriceExclVat)}</th>
    <th>${esc(p.vatRate)}</th>
    <th>${esc(p.lineTotalExclVat)}</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function vatSummaryTable(
  s: SnapshotForPdf,
  p: InvoicePhrases,
  locale: PdfLocale,
): string {
  const rows = s.vat_summary ?? [];
  if (!rows.length) return '<div class="vat-summary"></div>';
  const money = (v: number) => ltr(formatMoney(v, s.currency, locale));
  return `
<div class="vat-summary">
  <div class="section-title">${esc(p.vatSummary)}</div>
  <table>
    <thead><tr>
      <th>${esc(p.rate)}</th><th>${esc(p.net)}</th><th>${esc(p.vat)}</th><th>${esc(p.gross)}</th>
    </tr></thead>
    <tbody>
      ${rows
        .map(
          (r) => `<tr>
        <td>${ltr(formatPercent(r.rate_bp, locale))}</td>
        <td>${money(r.net)}</td>
        <td>${money(r.vat)}</td>
        <td>${money(r.gross)}</td>
      </tr>`,
        )
        .join('')}
    </tbody>
  </table>
</div>`;
}

function totalsBlock(
  s: SnapshotForPdf,
  p: InvoicePhrases,
  locale: PdfLocale,
): string {
  const t = s.totals;
  const money = (v: number) => ltr(formatMoney(v, s.currency, locale));
  const credit = s.kind === 'CREDIT_NOTE';
  const grandLabel = credit
    ? p.totalCredited
    : s.payment?.status === 'paid'
      ? p.total
      : p.totalToPay;
  const perRate = (s.vat_summary ?? []).filter((r) => Number(r.vat) !== 0);
  const vatAt = (bp: number) =>
    phrase(p.vatAtRate, { rate: ltr(formatPercent(bp, locale)) });

  let rows: string;
  if (t.layout === 'incl') {
    // Person on an INCLUSIVE store: "Total X, of which VAT Y" (+ per rate).
    rows = [
      `<tr class="grand"><th>${esc(grandLabel)}</th><td>${money(t.gross)}</td></tr>`,
      `<tr class="after-grand of-which-vat"><th>${esc(p.ofWhichVat)}</th><td>${money(t.vat)}</td></tr>`,
      perRate.length > 1
        ? perRate
            .map(
              (r) =>
                `<tr class="sub"><th>${vatAt(r.rate_bp)}</th><td>${money(r.vat)}</td></tr>`,
            )
            .join('')
        : '',
      `<tr class="sub"><th>${esc(p.netTotal)}</th><td>${money(t.net)}</td></tr>`,
    ].join('');
  } else {
    // Company buyer or EXCLUSIVE store: Net / VAT per rate / Total.
    const vatRows = perRate.length
      ? perRate
          .map(
            (r) =>
              `<tr><th>${vatAt(r.rate_bp)}</th><td>${money(r.vat)}</td></tr>`,
          )
          .join('')
      : `<tr><th>${esc(p.vatTotal)}</th><td>${money(t.vat)}</td></tr>`;
    rows = [
      `<tr><th>${esc(p.netTotal)}</th><td>${money(t.net)}</td></tr>`,
      vatRows,
      `<tr class="grand"><th>${esc(grandLabel)}</th><td>${money(t.gross)}</td></tr>`,
    ].join('');
  }
  return `<div class="totals totals-${t.layout === 'incl' ? 'incl' : 'excl'}"><table>${rows}</table></div>`;
}

function bankBlock(s: SnapshotForPdf, p: InvoicePhrases): string {
  if (!shouldShowBankBox(s)) return '';
  const b = s.bank!;
  const item = (label: string, value: Scalar) =>
    present(value)
      ? `<div class="item"><div class="l">${esc(label)}</div><div class="v">${ltr(value)}</div></div>`
      : '';
  return `
<div class="bank">
  <div class="section-title">${esc(p.bankDetails)}</div>
  <div class="grid">
    ${item(p.bankgiro, b.bankgiro)}
    ${item(p.plusgiro, b.plusgiro)}
    ${item(p.iban, b.iban)}
    ${item(p.bic, b.bic)}
    ${present(b.bank_name) ? `<div class="item"><div class="l">${esc(p.bankName)}</div><div class="v">${txt(b.bank_name)}</div></div>` : ''}
    ${item(p.paymentReference, present(b.reference) ? b.reference : s.number)}
  </div>
  <div class="note small muted">${phrase(p.payInstruction, { number: ltr(present(b.reference) ? b.reference : s.number) })}</div>
</div>`;
}

// ---------------------------------------------------------------- public

/** Full HTML document for the invoice body. Pure: same input, same output. */
export function renderInvoiceHtml(
  snapshot: SnapshotForPdf,
  phrases: InvoicePhrases,
  opts: InvoiceTemplateOptions = {},
): string {
  const locale = resolvePdfLocale(snapshot.locale);
  const rtl = locale === 'ar';
  const s = snapshot;
  const p = phrases;
  return `<!doctype html>
<html lang="${esc(locale)}" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<title>${esc(s.kind === 'CREDIT_NOTE' ? p.creditNote : p.invoice)} ${esc(s.number)}</title>
<style>${css(opts.fontCss ?? '', rtl)}</style>
</head>
<body class="${s.kind === 'CREDIT_NOTE' ? 'credit-note' : 'invoice'}">
<div class="header">
  ${sellerBlock(s, p, locale, opts.logoDataUri)}
  ${docBlock(s, p, locale)}
</div>
${creditRefBlock(s, p, locale)}
${buyerBlock(s, p, locale)}
${linesTable(s, p, locale)}
<div class="bottom">
  ${vatSummaryTable(s, p, locale)}
  ${totalsBlock(s, p, locale)}
</div>
${bankBlock(s, p)}
${present(s.seller.footer_note) ? `<div class="footer-note small">${txt(s.seller.footer_note)}</div>` : ''}
</body>
</html>`;
}

/**
 * Chromium `footerTemplate`: seller legal line, contact line, F-tax line and
 * "page x of y". Chromium renders it in a separate context without the body
 * CSS, so styles are inline and the font size is explicit.
 */
export function renderInvoiceFooterHtml(
  snapshot: SnapshotForPdf,
  phrases: InvoicePhrases,
  opts: Pick<InvoiceTemplateOptions, 'fontCss'> = {},
): string {
  const locale = resolvePdfLocale(snapshot.locale);
  const rtl = locale === 'ar';
  const seller = snapshot.seller;
  const p = phrases;
  const addr = [
    seller.address_line1,
    seller.address_line2,
    [seller.postal_code, seller.city].filter(present).join(' '),
    countryName(seller.country_code, locale),
  ].filter(present);

  const col = (lines: string[]) =>
    lines.length
      ? `<div style="flex:1 1 0;min-width:0">${lines.join('<br>')}</div>`
      : '';

  const legal = col(
    [
      `<b>${txt(seller.legal_name)}</b>`,
      addr.length ? addr.map(txt).join(rtl ? '\u060c ' : ', ') : '',
      present(seller.registered_office)
        ? `${esc(p.registeredOffice)}: ${txt(seller.registered_office)}`
        : '',
    ].filter(Boolean),
  );
  const contact = col(
    [
      present(seller.phone) ? `${esc(p.phone)}: ${ltr(seller.phone)}` : '',
      present(seller.email) ? `${esc(p.email)}: ${ltr(seller.email)}` : '',
      present(seller.website) ? ltr(seller.website) : '',
    ].filter(Boolean),
  );
  const ids = col(
    [
      present(seller.org_number)
        ? `${esc(p.orgNumber)}: ${ltr(seller.org_number)}`
        : '',
      present(seller.vat_number)
        ? `${esc(p.vatNumber)}: ${ltr(seller.vat_number)}`
        : '',
      // L15: printed only when the seller is approved.
      seller.f_tax_approved ? esc(p.fTaxApproved) : '',
    ].filter(Boolean),
  );
  const page = phrase(p.page, {
    x: '<span class="pageNumber"></span>',
    y: '<span class="totalPages"></span>',
  });

  return `<div dir="${rtl ? 'rtl' : 'ltr'}" lang="${esc(locale)}" style="width:100%;margin:0 14mm;font-family:${esc(INVOICE_FONT_STACK)};font-size:7pt;line-height:1.45;color:#6a737d;-webkit-print-color-adjust:exact">
${opts.fontCss ? `<style>${opts.fontCss}</style>` : ''}
<div style="display:flex;gap:6mm;border-top:0.3mm solid #d0d7de;padding-top:2mm">
${legal}${contact}${ids}
<div style="flex:0 0 auto;text-align:end;white-space:nowrap"><bdi>${page}</bdi></div>
</div>
</div>`;
}
