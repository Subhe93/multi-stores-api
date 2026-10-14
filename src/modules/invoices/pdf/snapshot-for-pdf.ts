/**
 * The view model the PDF template reads, and the single adapter from the
 * stored snapshot (WP-A's `InvoiceSnapshot`, persisted as JSON on
 * Invoice.snapshot) to it. If the snapshot shape changes, only
 * `toSnapshotForPdf()` has to follow; the template and its specs stay put.
 *
 * Amounts are signed numbers in MAJOR units (credit notes are negative).
 * VAT rates are basis points (2500 = 25 %).
 */
import type { InvoiceAddress, InvoiceSnapshot } from '../invoices.types';

export type PdfLocale = 'en' | 'ar' | 'tr' | 'de' | 'fr' | 'sv';

export interface PdfAddress {
  name?: string | null;
  company?: string | null;
  line1?: string | null;
  line2?: string | null;
  postal_code?: string | null;
  city?: string | null;
  state?: string | null;
  /** ISO 3166-1 alpha-2; printed as a localised country name. */
  country_code?: string | null;
  phone?: string | null;
}

export interface PdfSeller {
  legal_name: string;
  brand_name?: string | null;
  org_number?: string | null;
  vat_number?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  postal_code?: string | null;
  city?: string | null;
  country_code?: string | null;
  registered_office?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  f_tax_approved?: boolean | null;
  footer_note?: string | null;
  /** `/uploads/...` (public logo) or https; https logos are skipped (no network). */
  logo_url?: string | null;
}

export interface PdfBank {
  bankgiro?: string | null;
  plusgiro?: string | null;
  iban?: string | null;
  bic?: string | null;
  bank_name?: string | null;
  /** Payment reference to quote; defaults to the document number. */
  reference?: string | null;
}

export interface PdfBuyer {
  type: 'PERSON' | 'COMPANY';
  /** Company name for COMPANY buyers, person name otherwise. */
  name: string;
  /** Contact person of a company buyer. */
  contact_name?: string | null;
  org_number?: string | null;
  vat_number?: string | null;
  /** Buyer's own reference (PO / "Er referens"). */
  reference?: string | null;
  email?: string | null;
  phone?: string | null;
  billing_address?: PdfAddress | null;
  shipping_address?: PdfAddress | null;
}

/** A detail under a line: either a ready label ("Colour: Red") or label/value. */
export type PdfLineDetail = string | { label: string; value: string };

/**
 * item     an order line
 * shipping / discount / rounding / credit
 *          labelled with the localised phrase for the kind, followed by
 *          `description` when it is not empty
 */
export type PdfLineKind =
  | 'item'
  | 'shipping'
  | 'discount'
  | 'rounding'
  | 'credit';

export interface PdfLine {
  kind?: PdfLineKind;
  description: string;
  sku?: string | null;
  details?: PdfLineDetail[];
  qty: number;
  unit_net: number;
  /** null = several rates (e.g. a discount spread over mixed rates). */
  vat_rate_bp: number | null;
  line_net: number;
}

export interface PdfVatRow {
  label?: string | null;
  rate_bp: number;
  net: number;
  vat: number;
  gross: number;
}

export interface PdfTotals {
  net: number;
  vat: number;
  gross: number;
  /** excl: Net / VAT / Total; incl: "Total X, of which VAT Y". */
  layout: 'excl' | 'incl';
}

export interface PdfPayment {
  /** COD | STRIPE | KUSTOM (COD hides the bank box). */
  method: string;
  /** Localised label, e.g. "Visa •••• 4242". */
  label?: string | null;
  status: 'paid' | 'unpaid';
  paid_at?: string | null;
}

export interface PdfRefs {
  order_number: string;
  /** ISO date (YYYY-MM-DD). */
  order_date?: string | null;
  /** Credit notes only: the invoice being credited. */
  credited_invoice_number?: string | null;
  credited_invoice_date?: string | null;
  /** Credit notes only: localised by the template. */
  reason_code?: 'refund' | 'cancellation' | null;
  /** Free-text reason (manual credit notes); wins over reason_code. */
  reason?: string | null;
}

export interface SnapshotForPdf {
  template_version?: number;
  kind: 'INVOICE' | 'CREDIT_NOTE';
  number: string;
  /** ISO date YYYY-MM-DD. */
  issue_date: string;
  due_date?: string | null;
  locale: string;
  currency: string;
  seller: PdfSeller;
  buyer: PdfBuyer;
  /** Items first, then shipping / discount / rounding (or credit lines). */
  lines: PdfLine[];
  vat_summary: PdfVatRow[];
  totals: PdfTotals;
  payment: PdfPayment;
  bank?: PdfBank | null;
  refs: PdfRefs;
}

function address(a: InvoiceAddress | null | undefined): PdfAddress | null {
  if (!a) return null;
  return {
    name: a.name,
    company: a.company_name,
    line1: a.line1,
    line2: a.line2,
    postal_code: a.postal_code,
    city: a.city,
    state: a.state,
    country_code: a.country_code,
    phone: a.phone,
  };
}

/**
 * Single adapter point: stored `InvoiceSnapshot` JSON → template view model.
 * Lenient on purpose (`?.`, `??`): an old snapshot must still render.
 */
export function toSnapshotForPdf(stored: unknown): SnapshotForPdf {
  if (!stored || typeof stored !== 'object') {
    throw new Error('Invoice snapshot is missing or not an object');
  }
  const s = stored as InvoiceSnapshot;
  const seller = s.seller;
  const buyer = s.buyer;
  const billing = address(buyer?.billing_address);
  const contact =
    buyer?.type === 'COMPANY' &&
    billing?.name &&
    billing.name.trim() !== String(buyer.name ?? '').trim()
      ? billing.name
      : null;
  return {
    template_version: s.template_version,
    kind: s.kind,
    number: s.refs?.invoice_number ?? '',
    issue_date: s.refs?.issue_date ?? '',
    due_date: s.refs?.due_date ?? null,
    locale: s.locale,
    currency: s.currency,
    seller: {
      legal_name: seller?.legal_name ?? '',
      brand_name: seller?.brand_name,
      org_number: seller?.org_number,
      vat_number: seller?.vat_number,
      address_line1: seller?.address?.line1,
      address_line2: seller?.address?.line2,
      postal_code: seller?.address?.postal_code,
      city: seller?.address?.city,
      country_code: seller?.address?.country_code,
      registered_office: seller?.registered_office,
      email: seller?.email,
      phone: seller?.phone,
      website: seller?.website,
      f_tax_approved: seller?.f_tax_approved,
      footer_note: seller?.footer_note,
      logo_url: seller?.logo_url,
    },
    buyer: {
      type: buyer?.type === 'COMPANY' ? 'COMPANY' : 'PERSON',
      name: buyer?.name ?? '',
      contact_name: contact,
      org_number: buyer?.org_number,
      vat_number: buyer?.vat_number,
      reference: buyer?.reference,
      email: buyer?.email,
      phone: billing?.phone ?? null,
      billing_address: billing,
      shipping_address: address(buyer?.shipping_address),
    },
    lines: (s.lines ?? []).map((l) => ({
      kind: l.kind,
      description: l.description,
      sku: l.sku,
      details: l.details,
      qty: l.qty,
      unit_net: l.unit_net,
      vat_rate_bp: l.vat_rate_bp,
      line_net: l.line_net,
    })),
    vat_summary: s.vat_summary ?? [],
    totals: s.totals,
    payment: {
      method: s.payment?.method,
      label: s.payment?.label,
      status: s.payment?.status === 'paid' ? 'paid' : 'unpaid',
      paid_at: s.payment?.paid_at,
    },
    bank: s.bank,
    refs: {
      order_number: s.refs?.order_number ?? '',
      order_date: s.refs?.order_date,
      credited_invoice_number: s.refs?.credited_number,
      credited_invoice_date: s.refs?.credited_issue_date,
      reason_code: s.refs?.reason_code ?? null,
      reason: s.refs?.reason,
    },
  };
}
