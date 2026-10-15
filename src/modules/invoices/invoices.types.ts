// Mirror of multi-stores-shared/src/types/invoice.ts — keep in sync.

// Invoices app (M3): legal seller profile, numbering, issued documents and
// the immutable snapshot each document is rendered from. Source of truth for
// the mirrors in api (src/modules/invoices/invoices.types.ts) / web /
// dashboard — keep in sync.

import type { BuyerType, TaxExemptReason } from '../b2b/b2b.types';

export type InvoiceKind = 'INVOICE' | 'CREDIT_NOTE';

export const INVOICE_KINDS: readonly InvoiceKind[] = ['INVOICE', 'CREDIT_NOTE'];

/** What caused the document (audit + idempotency semantics). */
export type InvoiceTrigger =
  | 'PAYMENT'
  | 'COD_CREATED'
  | 'COD_DELIVERED'
  | 'MANUAL'
  | 'REFUND'
  | 'CANCELLATION';

// ── App settings (StoreApp.settings of `invoices`) ──────────────────────────

export type InvoiceCodIssueOn = 'created' | 'delivered';

export interface InvoiceSettings {
  /** Issue automatically when an order is paid. */
  auto_issue: boolean;
  /** When a cash-on-delivery order is invoiced. */
  cod_issue_on: InvoiceCodIssueOn;
  /** Attach the PDF to order emails. */
  attach_pdf_to_email: boolean;
  /** Issue a full credit note when an invoiced order is cancelled. */
  credit_on_cancel: boolean;
}

export const DEFAULT_INVOICE_SETTINGS: InvoiceSettings = {
  auto_issue: true,
  cod_issue_on: 'delivered',
  attach_pdf_to_email: true,
  credit_on_cancel: true,
};

// ── Legal profile + numbering ───────────────────────────────────────────────

/** Editable fields of the seller's legal profile (PUT body; all optional). */
export interface LegalProfileInput {
  legal_name?: string | null;
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
  bankgiro?: string | null;
  plusgiro?: string | null;
  iban?: string | null;
  bic?: string | null;
  bank_name?: string | null;
  logo_url?: string | null;
  f_tax_approved?: boolean;
  due_days?: number;
  footer_note?: string | null;
  timezone?: string;
}

export interface NumberingSequenceView {
  prefix: string;
  padding: number;
  next_number: number;
  issued_count: number;
  /** next_number can no longer be changed (something was issued). */
  locked: boolean;
}

/** GET/PUT /invoices/my/legal-profile response. */
export interface LegalProfileView {
  legal_name: string | null;
  brand_name: string | null;
  org_number: string | null;
  vat_number: string | null;
  address_line1: string | null;
  address_line2: string | null;
  postal_code: string | null;
  city: string | null;
  country_code: string | null;
  registered_office: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  bankgiro: string | null;
  plusgiro: string | null;
  iban: string | null;
  bic: string | null;
  bank_name: string | null;
  logo_url: string | null;
  f_tax_approved: boolean;
  due_days: number;
  footer_note: string | null;
  timezone: string;
  /** Every field required to issue is filled in. */
  complete: boolean;
  /** Missing field keys; "iban|bankgiro" = at least one bank account. */
  missing: string[];
  numbering: {
    invoice: NumberingSequenceView;
    credit_note: NumberingSequenceView;
  };
}

export interface NumberingSequenceInput {
  /** Empty or ending in a non-digit ("INV-", "2026/"). */
  prefix?: string;
  next_number?: number;
  padding?: number;
}

/** PUT /invoices/my/numbering body. */
export interface NumberingInput {
  invoice?: NumberingSequenceInput;
  credit_note?: NumberingSequenceInput;
}

// ── Documents ───────────────────────────────────────────────────────────────

/** One document in lists (signed amounts: credit notes are negative). */
export interface InvoiceSummary {
  id: string;
  kind: InvoiceKind;
  number: string;
  /** YYYY-MM-DD in the seller's timezone. */
  issue_date: string;
  due_date: string | null;
  order_id: string;
  order_number: string;
  currency: string;
  net_total: number;
  vat_total: number;
  gross_total: number;
  paid: boolean;
  buyer_name: string;
  buyer_type: BuyerType | null;
  credited_invoice: { id: string; number: string } | null;
  trigger: InvoiceTrigger;
  reason: string | null;
  pdf_available: boolean;
  /** INVOICE: gross still creditable; CREDIT_NOTE: null. */
  remaining_creditable: number | null;
  /** b2b app M2.5: why the document carries no VAT; null when taxed. */
  tax_exempt_reason: TaxExemptReason | null;
  /** b2b app M2.5: buyer VAT number / ISO2 country of an exempt document. */
  buyer_vat_number: string | null;
  buyer_country: string | null;
}

/** GET /invoices/my/:id. */
export interface InvoiceDetail extends InvoiceSummary {
  snapshot: InvoiceSnapshot;
}

export interface InvoiceListResponse {
  items: InvoiceSummary[];
  total: number;
  page: number;
  limit: number;
}

export interface InvoiceBacklogOrder {
  id: string;
  order_number: string;
  created_at: string;
  total: number;
  currency: string;
  payment_method: 'COD' | 'STRIPE' | 'KUSTOM';
}

/** GET /invoices/my/backlog. */
export interface InvoiceBacklog {
  count: number;
  orders: InvoiceBacklogOrder[];
}

/** POST /invoices/my/backlog/issue. */
export interface InvoiceBulkIssueResult {
  issued: number;
  skipped: number;
  errors: {
    order_id: string;
    order_number: string;
    code: string;
    message: string;
  }[];
}

// ── Snapshot (what a PDF is rendered from; immutable once issued) ──────────

export const INVOICE_SNAPSHOT_VERSION = 1;

/** A postal address copied onto the document. */
export interface InvoiceAddress {
  name: string | null;
  company_name: string | null;
  line1: string;
  line2: string | null;
  postal_code: string;
  city: string;
  state: string | null;
  country_code: string;
  phone: string | null;
}

export interface InvoiceSeller {
  legal_name: string;
  /** Trading name (null when equal to / absent besides the legal name). */
  brand_name: string | null;
  org_number: string | null;
  vat_number: string | null;
  address: {
    line1: string;
    line2: string | null;
    postal_code: string;
    city: string;
    country_code: string;
  };
  registered_office: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  f_tax_approved: boolean;
  /** "/uploads/..." or https URL (profile logo, else the store logo). */
  logo_url: string | null;
  footer_note: string | null;
}

export interface InvoiceBuyer {
  type: BuyerType;
  /** Company name, else the address name, else the customer's name. */
  name: string;
  company_name: string | null;
  org_number: string | null;
  vat_number: string | null;
  /** Buyer reference ("Er referens") of a company order. */
  reference: string | null;
  email: string | null;
  billing_address: InvoiceAddress | null;
  shipping_address: InvoiceAddress | null;
}

/** One small "label: value" row under a line's description. */
export interface InvoiceLineDetail {
  label: string;
  value: string;
}

/**
 * item     an order line (pre-discount net)
 * shipping the shipping fee (description = method name or '')
 * discount the order discount as one negative net line (residual)
 * rounding residual of rounding when there is no discount
 * credit   partial credit note: one line per VAT rate (negative)
 * Renderers label shipping / discount / rounding / credit lines by `kind`
 * (localized phrase) and append `description` when it is not empty.
 */
export type InvoiceLineKind =
  | 'item'
  | 'shipping'
  | 'discount'
  | 'rounding'
  | 'credit';

/** All amounts in major units of the document currency, signed. */
export interface InvoiceLine {
  kind: InvoiceLineKind;
  description: string;
  sku: string | null;
  details: InvoiceLineDetail[];
  qty: number;
  /** Unit price excl. VAT (display only). */
  unit_net: number;
  /** null = several rates (a discount spread over mixed-rate lines). */
  vat_rate_bp: number | null;
  /** Line total excl. VAT; Σ line_net over `lines` === totals.net. */
  line_net: number;
}

export interface InvoiceVatSummaryRow {
  /** Tax label as on the order ("Moms"), null for the 0 % remainder row. */
  label: string | null;
  rate_bp: number;
  net: number;
  vat: number;
  gross: number;
  /**
   * b2b app M2.5: why the row carries no VAT (the order's reverse-charge /
   * exempt row). Absent on every taxed row, so those stay byte-identical.
   */
  exempt_reason?: TaxExemptReason;
}

/**
 * Which legal note the document prints (b2b app M2.5):
 * REVERSE_CHARGE_ART_138  intra-Community supply, art. 138 VAT Directive /
 *                         10 kap. 42 § ML, VAT accounted for by the buyer
 * CUSTOMER_EXEMPT         merchant-granted exemption ("Tax exempt", no article)
 */
export type InvoiceLegalTextKey = 'REVERSE_CHARGE_ART_138' | 'CUSTOMER_EXEMPT';

/** b2b app M2.5: why the document carries no VAT, with the VAT numbers. */
export interface InvoiceTaxExemption {
  reason: TaxExemptReason;
  /** Buyer VAT number (the VIES-validated one when there is one). */
  vat_number: string | null;
  /** ISO2 country the goods were shipped to. */
  buyer_country: string | null;
  seller_vat_number: string | null;
  legal_text_key: InvoiceLegalTextKey;
  /** VIES consultation behind a reverse charge (absent for manual ones). */
  vies?: {
    request_identifier: string | null;
    checked_at: string | null;
    /** YYYY-MM-DD of checked_at in the seller's timezone (printed date). */
    checked_on?: string | null;
    name: string | null;
  } | null;
}

export interface InvoiceTotals {
  net: number;
  vat: number;
  gross: number;
  /**
   * excl: Net / VAT per rate / Total (company buyer or EXCLUSIVE store).
   * incl: "Total X, of which VAT Y" (person on an INCLUSIVE store).
   */
  layout: 'excl' | 'incl';
}

export interface InvoicePayment {
  method: 'COD' | 'STRIPE' | 'KUSTOM';
  /** "Visa •••• 4242", "Kustom", localized cash-on-delivery label … */
  label: string;
  status: 'paid' | 'unpaid';
  paid: boolean;
  /** ISO timestamp, when known. */
  paid_at: string | null;
}

/** Shown only on unpaid, non-COD invoices. */
export interface InvoiceBankDetails {
  bankgiro: string | null;
  plusgiro: string | null;
  iban: string | null;
  bic: string | null;
  bank_name: string | null;
  /** Payment reference to quote (= the invoice number). */
  reference: string;
}

export interface InvoiceRefs {
  order_number: string;
  /** YYYY-MM-DD (seller timezone). */
  order_date: string;
  invoice_number: string;
  issue_date: string;
  due_date: string | null;
  /** Credit notes: the credited invoice. */
  credited_number?: string | null;
  credited_issue_date?: string | null;
  /** Credit notes: localized by renderers when set. */
  reason_code?: 'refund' | 'cancellation' | null;
  /** Free-text reason (manual credit notes). */
  reason?: string | null;
}

export interface InvoiceSnapshot {
  version: 1;
  /** PDF template revision the first render used (L8). */
  template_version: number;
  kind: InvoiceKind;
  /** One of en/ar/tr/de/fr/sv. */
  locale: string;
  currency: string;
  /** Pricing mode of the order the lines were derived from. */
  tax_mode: 'INCLUSIVE' | 'EXCLUSIVE';
  seller: InvoiceSeller;
  buyer: InvoiceBuyer;
  /** items, then shipping, discount, rounding (or credit lines). */
  lines: InvoiceLine[];
  vat_summary: InvoiceVatSummaryRow[];
  totals: InvoiceTotals;
  payment: InvoicePayment;
  bank: InvoiceBankDetails | null;
  refs: InvoiceRefs;
  /**
   * b2b app M2.5 (template v2): set only on exempt documents; absent on
   * every other snapshot (v1 snapshots never have it), so `version` stays 1.
   */
  tax_exemption?: InvoiceTaxExemption | null;
}

// ── API-only ────────────────────────────────────────────────────────────────

/**
 * Revision of the PDF template recorded in each new snapshot (L8). Bump it
 * when the printed layout changes in a way an auditor should be able to see.
 */
export const INVOICE_TEMPLATE_VERSION = 2;
