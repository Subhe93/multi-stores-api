/**
 * The view model the PDF template reads, and the single adapter from the
 * stored snapshot (WP-A's `InvoiceSnapshot`, persisted as JSON on
 * Invoice.snapshot) to it. If the snapshot shape changes, only
 * `toSnapshotForPdf()` has to follow; the template and its specs stay put.
 *
 * Amounts are signed numbers in MAJOR units (credit notes are negative).
 * VAT rates are basis points (2500 = 25 %).
 */
import { currencyDecimals } from '../../../common/money/currency.util';
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
  /** b2b app M2.5: set on the exempt (0 %) row only. */
  exempt_reason?: 'REVERSE_CHARGE' | 'CUSTOMER_EXEMPT' | null;
}

/** b2b app M2.5: why the document carries no VAT (template v2). */
export interface PdfTaxExemption {
  reason: 'REVERSE_CHARGE' | 'CUSTOMER_EXEMPT';
  /** Buyer VAT number. */
  vat_number?: string | null;
  buyer_country?: string | null;
  seller_vat_number?: string | null;
  legal_text_key?: 'REVERSE_CHARGE_ART_138' | 'CUSTOMER_EXEMPT' | null;
  vies?: {
    request_identifier?: string | null;
    checked_at?: string | null;
    /** YYYY-MM-DD in the seller's timezone; preferred over checked_at. */
    checked_on?: string | null;
    name?: string | null;
  } | null;
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
  /** b2b app M2.5: absent / null = taxed (v1 snapshots never have it). */
  tax_exemption?: PdfTaxExemption | null;
  /**
   * Supplier copy for a provider (see toSupplierCopy): not a tax invoice.
   * The template then prints the banner, the delivery block, the lines and
   * one subtotal only.
   */
  supplier_copy?: boolean;
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
    tax_exemption: s.tax_exemption ?? null,
  };
}

/**
 * Redacted view model of a supplier copy: the document header (number,
 * dates, store), the buyer NAME and DELIVERY address only, the given lines
 * (indexes into `full.lines`, i.e. the provider's own lines) and their
 * subtotal. Everything else is dropped from the data itself, not only
 * hidden by the template: buyer email / phone / org and VAT numbers, the
 * billing address, other parties' lines, order totals, the VAT summary,
 * payment and bank details, the tax-exemption block (buyer VAT number) and
 * free-text notes.
 */
export function toSupplierCopy(
  full: SnapshotForPdf,
  lineIndexes: readonly number[],
): SnapshotForPdf {
  const keep = new Set(lineIndexes);
  const lines = (full.lines ?? []).filter((_, i) => keep.has(i));
  const factor = 10 ** currencyDecimals(full.currency);
  const subtotal =
    lines.reduce((sum, l) => sum + Math.round(Number(l.line_net) * factor), 0) /
      factor || 0;
  // Delivery address only: the billing address is never the provider's
  // business, so an order without one prints no address block at all.
  const ship = full.buyer?.shipping_address ?? null;
  const delivery: PdfAddress | null = ship
    ? {
        name: ship.name,
        company: ship.company,
        line1: ship.line1,
        line2: ship.line2,
        postal_code: ship.postal_code,
        city: ship.city,
        state: ship.state,
        country_code: ship.country_code,
        // The buyer's phone number is not part of the supplier copy.
        phone: null,
      }
    : null;
  const seller = full.seller ?? ({ legal_name: '' } as PdfSeller);
  return {
    template_version: full.template_version,
    kind: full.kind,
    number: full.number,
    issue_date: full.issue_date,
    due_date: null,
    locale: full.locale,
    currency: full.currency,
    seller: {
      legal_name: seller.legal_name,
      brand_name: seller.brand_name,
      address_line1: seller.address_line1,
      address_line2: seller.address_line2,
      postal_code: seller.postal_code,
      city: seller.city,
      country_code: seller.country_code,
      logo_url: seller.logo_url,
    },
    buyer: {
      type: full.buyer?.type === 'COMPANY' ? 'COMPANY' : 'PERSON',
      name: full.buyer?.name ?? '',
      billing_address: null,
      shipping_address: delivery,
    },
    lines,
    vat_summary: [],
    totals: { net: subtotal, vat: 0, gross: subtotal, layout: 'excl' },
    payment: { method: '', label: null, status: 'unpaid', paid_at: null },
    bank: null,
    refs: {
      order_number: full.refs?.order_number ?? '',
      order_date: full.refs?.order_date ?? null,
      credited_invoice_number: full.refs?.credited_invoice_number ?? null,
      credited_invoice_date: full.refs?.credited_invoice_date ?? null,
      reason_code: null,
      reason: null,
    },
    tax_exemption: null,
    supplier_copy: true,
  };
}
