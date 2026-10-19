import { currencyDecimals } from '../../common/money/currency.util';
import {
  isSnapshotFileRow,
  snapshotLabel,
  sortSnapshotRows,
  SNAPSHOT_LABEL_FALLBACK,
} from '../../common/personalization/snapshot-label';
import {
  allocateLargestRemainder,
  includedTaxMinor,
  MAX_RATE_BP,
  roundSymmetric,
} from '../../common/money/tax.util';
import { deriveNetTotals } from '../taxes/tax.service';
import {
  formatPaymentMethod,
  personalizationPrintLines,
} from '../mail/order-mail.helpers';
import { hasPersonalizationGroups } from '@multi-stores/core/personalization/display';
import type { TaxExemptReason } from '../b2b/b2b.types';
import {
  INVOICE_SNAPSHOT_VERSION,
  INVOICE_TEMPLATE_VERSION,
  type InvoiceAddress,
  type InvoiceBankDetails,
  type InvoiceBuyer,
  type InvoiceLine,
  type InvoiceLineDetail,
  type InvoiceSeller,
  type InvoiceSnapshot,
  type InvoiceTaxExemption,
  type InvoiceVatSummaryRow,
} from './invoices.types';

// Pure builders of the immutable invoice / credit-note snapshot (M3 §3.2).
// Everything is computed in minor units of the order currency and turned
// back into major units once, so the invariants hold exactly:
//   Σ lines.line_net === totals.net
//   Σ vat_summary.vat === totals.vat
//   totals.net + totals.vat === totals.gross

// ── Input shapes (structural: Prisma payloads satisfy them) ────────────────

type Money = unknown; // Prisma Decimal | number | string

interface TitleTranslation {
  locale: string;
  title: string;
}

export interface SnapshotOrderItem {
  quantity: number;
  unit_price: Money;
  total_price: Money;
  tax_rate_bp: number | null;
  product?: {
    sku?: string | null;
    translations?: TitleTranslation[];
  } | null;
  variant?: { sku?: string | null; options?: unknown } | null;
  custom_product?: {
    translations?: TitleTranslation[];
    product?: { sku?: string | null } | null;
  } | null;
  custom_field_values?: {
    value: string | null;
    file_url: string | null;
    // M4.0 snapshot of the field at order time (null on rows written before).
    field_name?: string | null;
    field_type?: string | null;
    field_label?: unknown;
    display_value?: unknown;
    sort_order?: number | null;
    // M4.1 grouping columns (C1); absent on rows read without them.
    group_key?: string | null;
    group_index?: number | null;
    group_label?: unknown;
    source?: string | null;
    meta?: unknown;
    custom_field: {
      name: string;
      type: string;
      translations?: {
        locale: string;
        label: string;
        option_labels?: unknown;
      }[];
    } | null;
  }[];
}

export interface SnapshotOrderAddress {
  full_name: string;
  company_name?: string | null;
  line1: string;
  line2?: string | null;
  postal_code: string;
  city: string;
  state?: string | null;
  country_code: string;
  phone?: string | null;
}

export interface SnapshotOrder {
  order_number: string;
  created_at: Date | string;
  currency: string;
  payment_method: 'COD' | 'STRIPE' | 'KUSTOM';
  paid_at?: Date | string | null;
  card_brand?: string | null;
  card_last4?: string | null;
  total: Money;
  tax_amount: Money;
  tax_rate_bp?: number | null;
  tax_pricing_mode: 'INCLUSIVE' | 'EXCLUSIVE';
  tax_lines?: unknown;
  shipping_cost: Money;
  shipping_tax_rate_bp?: number | null;
  shipping_tax_amount?: Money;
  shipping_method_name?: string | null;
  discount_amount?: Money;
  customer_type?: 'PERSON' | 'COMPANY' | null;
  company_name?: string | null;
  org_number?: string | null;
  vat_number?: string | null;
  buyer_reference?: string | null;
  /** b2b app M2.5: why the order carries no VAT (null = taxed). */
  tax_exempt_reason?: TaxExemptReason | null;
  /** b2b app M2.5: VatEvidence JSON of the exemption decision. */
  vat_validation?: unknown;
  address?: SnapshotOrderAddress | null;
  customer?: {
    first_name?: string | null;
    last_name?: string | null;
    user?: { email?: string | null } | null;
  } | null;
  items: SnapshotOrderItem[];
}

export interface BuildInvoiceInput {
  order: SnapshotOrder;
  seller: InvoiceSeller;
  /** Seller bank accounts (printed only on unpaid, non-COD invoices). */
  bank: Omit<InvoiceBankDetails, 'reference'>;
  /** One of the six supported locales. */
  locale: string;
  /** The store's primary locale (label fallback of personalization rows). */
  primaryLocale?: string | null;
  /** YYYY-MM-DD in the seller's timezone. */
  issueDate: string;
  /** Seller timezone (order date is printed in it). */
  timezone: string;
  dueDays: number;
  paid: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function money(currency: string) {
  const factor = 10 ** currencyDecimals(currency);
  return {
    toMinor: (major: Money) => Math.round(Number(major || 0) * factor),
    // `|| 0` turns -0 into 0 so negated zeros serialize and compare cleanly.
    toMajor: (minor: number) => minor / factor || 0,
  };
}

/** YYYY-MM-DD of an instant in `timeZone`. */
export function isoDateInZone(at: Date | string, timeZone: string): string {
  const date = at instanceof Date ? at : new Date(at);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** YYYY-MM-DD + n days (calendar arithmetic, no timezone involved). */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function pick<T extends { locale: string }>(
  rows: T[] | undefined,
  locale: string,
): T | undefined {
  if (!rows?.length) return undefined;
  return (
    rows.find((r) => r.locale === locale) ??
    rows.find((r) => r.locale === 'en') ??
    rows[0]
  );
}

function itemTitle(item: SnapshotOrderItem, locale: string): string {
  return (
    pick(item.custom_product?.translations, locale)?.title ||
    pick(item.product?.translations, locale)?.title ||
    'Item'
  );
}

function itemDetails(
  item: SnapshotOrderItem,
  locale: string,
  primaryLocale?: string | null,
): InvoiceLineDetail[] {
  const details: InvoiceLineDetail[] = [];
  const options = item.variant?.options;
  if (options && typeof options === 'object' && !Array.isArray(options)) {
    for (const [k, v] of Object.entries(options as Record<string, unknown>)) {
      if (v === null || v === undefined || v === '') continue;
      details.push({
        label: k,
        value: typeof v === 'object' ? JSON.stringify(v) : String(v as string),
      });
    }
  }
  // M4.1: personalization items (repeater groups) print one detail each,
  // "Artikel 2: KARIN, Röd"; option rows never print alone. Only orders
  // of the personalization app carry groups.
  const values = item.custom_field_values ?? [];
  if (hasPersonalizationGroups(values)) {
    for (const line of personalizationPrintLines(
      values,
      locale,
      primaryLocale ?? undefined,
      'file',
    )) {
      if (!line.label || line.label === SNAPSHOT_LABEL_FALLBACK) continue;
      details.push({ label: line.label, value: line.text });
    }
    return details;
  }
  // M4.0: labels and option texts come from the order-time snapshot, so a
  // renamed or deleted field prints what the buyer saw; rows without a
  // snapshot fall back to the live field (snapshotLabel).
  for (const cf of sortSnapshotRows(values)) {
    const { label, value: text } = snapshotLabel(cf, locale);
    const isFile = isSnapshotFileRow(cf) || !!cf.file_url;
    const value = isFile ? 'file' : text;
    if (!label || label === SNAPSHOT_LABEL_FALLBACK || !value) continue;
    details.push({ label, value });
  }
  return details;
}

function copyAddress(
  a: SnapshotOrderAddress | null | undefined,
): InvoiceAddress | null {
  if (!a) return null;
  return {
    name: a.full_name || null,
    company_name: a.company_name || null,
    line1: a.line1,
    line2: a.line2 || null,
    postal_code: a.postal_code,
    city: a.city,
    state: a.state || null,
    country_code: a.country_code,
    phone: a.phone || null,
  };
}

const EXEMPT_REASONS: readonly TaxExemptReason[] = [
  'REVERSE_CHARGE',
  'CUSTOMER_EXEMPT',
];

function exemptReasonOf(v: unknown): TaxExemptReason | null {
  return EXEMPT_REASONS.includes(v as TaxExemptReason)
    ? (v as TaxExemptReason)
    : null;
}

/** The fields of an order's VatEvidence JSON the invoice prints. */
function evidenceOf(raw: unknown): {
  source: string | null;
  vat_number: string | null;
  destination_country: string | null;
  request_identifier: string | null;
  checked_at: string | null;
  name: string | null;
} | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  return {
    source: str(o.source),
    vat_number: str(o.vat_number),
    destination_country: str(o.destination_country),
    request_identifier: str(o.request_identifier),
    checked_at: str(o.checked_at),
    name: str(o.name),
  };
}

/**
 * b2b app M2.5: the snapshot's exemption block, or null for a taxed order
 * (then nothing about the document changes).
 */
function buildTaxExemption(
  order: SnapshotOrder,
  buyer: InvoiceBuyer,
  seller: InvoiceSeller,
  timeZone: string,
): InvoiceTaxExemption | null {
  const reason = exemptReasonOf(order.tax_exempt_reason);
  if (!reason) return null;
  const ev = evidenceOf(order.vat_validation);
  const fromVies = ev?.source === 'VIES';
  return {
    reason,
    vat_number: buyer.vat_number ?? ev?.vat_number ?? null,
    buyer_country:
      (order.address?.country_code || ev?.destination_country || '')
        .trim()
        .toUpperCase() || null,
    seller_vat_number: seller.vat_number || null,
    legal_text_key:
      reason === 'REVERSE_CHARGE'
        ? 'REVERSE_CHARGE_ART_138'
        : 'CUSTOMER_EXEMPT',
    vies:
      fromVies && ev
        ? {
            request_identifier: ev.request_identifier,
            checked_at: ev.checked_at,
            // Printed like every other invoice date: the seller's local day.
            checked_on: ev.checked_at
              ? isoDateInZone(ev.checked_at, timeZone)
              : null,
            name: ev.name,
          }
        : null,
  };
}

function buildBuyer(order: SnapshotOrder): InvoiceBuyer {
  const type = order.customer_type ?? 'PERSON';
  const company = type === 'COMPANY';
  const personName = [order.customer?.first_name, order.customer?.last_name]
    .filter((s) => !!s && s.trim())
    .join(' ')
    .trim();
  const name =
    (company && order.company_name) ||
    order.address?.full_name ||
    personName ||
    '—';
  const address = copyAddress(order.address);
  return {
    type,
    name,
    company_name: company ? order.company_name || null : null,
    org_number: company ? order.org_number || null : null,
    // b2b app M2.5: an exempt order prints the VAT number the exemption was
    // decided for (the validated one); every other order is unchanged.
    vat_number: company
      ? (exemptReasonOf(order.tax_exempt_reason)
          ? evidenceOf(order.vat_validation)?.vat_number
          : null) ||
        order.vat_number ||
        null
      : null,
    reference: company ? order.buyer_reference || null : null,
    email: order.customer?.user?.email || null,
    // The Address row is mutable and shared, so it is copied, not referenced.
    billing_address: address,
    shipping_address: address ? { ...address } : null,
  };
}

interface RawTaxLine {
  label: string;
  rate_bp: number;
  taxable_amount: number;
  tax_amount: number;
  exempt_reason?: TaxExemptReason;
}

function parseTaxLines(raw: unknown): RawTaxLine[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
    .map((l) => ({
      label: typeof l.label === 'string' ? l.label : '',
      rate_bp: Number(l.rate_bp) || 0,
      taxable_amount: Number(l.taxable_amount) || 0,
      tax_amount: Number(l.tax_amount) || 0,
      ...(exemptReasonOf(l.exempt_reason)
        ? { exempt_reason: exemptReasonOf(l.exempt_reason)! }
        : {}),
    }));
}

/**
 * Whether the order was taxed with stacked (compounding) rates on a line,
 * which invoices do not support yet: the per-line effective rate of a
 * stacked line is not one of the order's itemized rates. Orders without
 * itemized tax lines (legacy, or fully discounted) cannot be checked and
 * pass. Lines with a zero amount are skipped.
 */
export function hasStackedTaxRates(order: SnapshotOrder): boolean {
  const taxLines = parseTaxLines(order.tax_lines);
  if (!taxLines.length) return false;
  const rates = new Set(taxLines.map((t) => t.rate_bp));
  const used: number[] = order.items
    .filter((i) => Number(i.total_price) > 0)
    .map((i) => Number(i.tax_rate_bp) || 0);
  if (Number(order.shipping_cost) > 0 && Number(order.shipping_tax_amount)) {
    used.push(Number(order.shipping_tax_rate_bp) || 0);
  }
  return used.some((r) => r > 0 && !rates.has(r));
}

// ── Invoice ─────────────────────────────────────────────────────────────────

/**
 * Snapshot of an invoice for `order`, without a number: refs.invoice_number
 * and bank.reference are '' until withNumber() fills them inside the
 * numbering transaction.
 */
export function buildInvoiceSnapshot(
  input: BuildInvoiceInput,
): InvoiceSnapshot {
  const { order, locale } = input;
  const currency = order.currency;
  const { toMinor, toMajor } = money(currency);
  const inclusive = order.tax_pricing_mode !== 'EXCLUSIVE';

  // Item lines: pre-discount nets. INCLUSIVE uses the same formula as the
  // tax engine (taxLineMinor) on the undiscounted line amount.
  const lines: InvoiceLine[] = [];
  const itemRates = new Set<number>();
  let itemsNet = 0;
  for (const item of order.items) {
    const rate = Math.max(
      0,
      Math.min(MAX_RATE_BP, Number(item.tax_rate_bp) || 0),
    );
    itemRates.add(rate);
    const base = toMinor(item.total_price);
    const unit = toMinor(item.unit_price);
    const lineNet = inclusive ? base - includedTaxMinor(base, rate) : base;
    const unitNet = inclusive
      ? roundSymmetric((unit * MAX_RATE_BP) / (MAX_RATE_BP + rate))
      : unit;
    itemsNet += lineNet;
    lines.push({
      kind: 'item',
      description: itemTitle(item, locale),
      sku: item.variant?.sku || item.product?.sku || null,
      details: itemDetails(item, locale, input.primaryLocale),
      qty: item.quantity,
      unit_net: toMajor(unitNet),
      vat_rate_bp: rate,
      line_net: toMajor(lineNet),
    });
  }

  // Shipping line (net from the order's own snapshot columns).
  const derived = deriveNetTotals(order, currency);
  const shippingNet = toMinor(derived.net_shipping);
  const shippingCost = toMinor(order.shipping_cost);
  if (shippingCost !== 0 || order.shipping_method_name?.trim()) {
    lines.push({
      kind: 'shipping',
      description: order.shipping_method_name?.trim() || '',
      sku: null,
      details: [],
      qty: 1,
      unit_net: toMajor(shippingNet),
      vat_rate_bp: Number(order.shipping_tax_rate_bp) || 0,
      line_net: toMajor(shippingNet),
    });
  }

  // Totals straight from the order.
  const gross = toMinor(order.total);
  const vat = toMinor(order.tax_amount);
  const net = gross - vat;

  // Discount (or rounding) residual: whatever makes the lines sum to net.
  const residual = net - itemsNet - shippingNet;
  if (residual !== 0) {
    const hasDiscount = toMinor(order.discount_amount) > 0;
    lines.push({
      kind: hasDiscount ? 'discount' : 'rounding',
      description: '',
      sku: null,
      details: [],
      qty: 1,
      unit_net: toMajor(residual),
      vat_rate_bp: hasDiscount
        ? itemRates.size === 1
          ? [...itemRates][0]
          : null
        : null,
      line_net: toMajor(residual),
    });
  }

  // VAT summary from the order's itemized tax lines (legacy: one row).
  const rows: {
    label: string | null;
    rate_bp: number;
    net: number;
    vat: number;
    exempt_reason?: TaxExemptReason;
  }[] = [];
  const exemptReason = exemptReasonOf(order.tax_exempt_reason);
  const taxLines = parseTaxLines(order.tax_lines);
  if (taxLines.length) {
    for (const t of taxLines) {
      rows.push({
        label: t.label || null,
        rate_bp: t.rate_bp,
        net: toMinor(t.taxable_amount),
        vat: toMinor(t.tax_amount),
        ...(t.exempt_reason ? { exempt_reason: t.exempt_reason } : {}),
      });
    }
  } else if (vat !== 0) {
    rows.push({
      label: null,
      rate_bp: Number(order.tax_rate_bp) || 0,
      net,
      vat,
    });
  }
  // Untaxed remainder (exempt / zero-rated lines) as a 0 % row, so the
  // summary's gross column adds up to the total.
  const rowsNet = rows.reduce((s, r) => s + r.net, 0);
  if (net - rowsNet > 0) {
    rows.push({
      label: null,
      rate_bp: 0,
      net: net - rowsNet,
      vat: 0,
      // An exempt order's untaxed remainder is exempt for the same reason.
      ...(exemptReason ? { exempt_reason: exemptReason } : {}),
    });
  }
  const vat_summary: InvoiceVatSummaryRow[] = rows.map((r) => ({
    label: r.label,
    rate_bp: r.rate_bp,
    net: toMajor(r.net),
    vat: toMajor(r.vat),
    gross: toMajor(r.net + r.vat),
    ...(r.exempt_reason ? { exempt_reason: r.exempt_reason } : {}),
  }));

  const buyer = buildBuyer(order);
  const taxExemption = buildTaxExemption(
    order,
    buyer,
    input.seller,
    input.timezone,
  );
  const isCod = order.payment_method === 'COD';
  const dueDate = input.paid
    ? input.issueDate
    : isCod
      ? input.issueDate
      : addDays(input.issueDate, Math.max(0, input.dueDays));
  const paidAt = order.paid_at ? new Date(order.paid_at).toISOString() : null;

  return {
    version: INVOICE_SNAPSHOT_VERSION,
    template_version: INVOICE_TEMPLATE_VERSION,
    kind: 'INVOICE',
    locale,
    currency,
    tax_mode: inclusive ? 'INCLUSIVE' : 'EXCLUSIVE',
    seller: input.seller,
    buyer,
    lines,
    vat_summary,
    totals: {
      net: toMajor(net),
      vat: toMajor(vat),
      gross: toMajor(gross),
      // An exempt document always shows Net / VAT 0 / Total (excl).
      layout:
        buyer.type === 'COMPANY' || !inclusive || taxExemption
          ? 'excl'
          : 'incl',
    },
    payment: {
      method: order.payment_method,
      label: formatPaymentMethod(order, locale),
      status: input.paid ? 'paid' : 'unpaid',
      paid: input.paid,
      paid_at: input.paid ? paidAt : null,
    },
    bank: !input.paid && !isCod ? { ...input.bank, reference: '' } : null,
    refs: {
      order_number: order.order_number,
      order_date: isoDateInZone(order.created_at, input.timezone),
      invoice_number: '',
      issue_date: input.issueDate,
      due_date: dueDate,
    },
    ...(taxExemption ? { tax_exemption: taxExemption } : {}),
  };
}

/** The snapshot with its allocated number (refs + bank payment reference). */
export function withNumber(
  snapshot: InvoiceSnapshot,
  number: string,
): InvoiceSnapshot {
  return {
    ...snapshot,
    bank: snapshot.bank ? { ...snapshot.bank, reference: number } : null,
    refs: { ...snapshot.refs, invoice_number: number },
  };
}

// ── Credit note ─────────────────────────────────────────────────────────────

export interface BuildCreditInput {
  original: InvoiceSnapshot;
  /** Gross to credit (positive, major units) or the full remaining. */
  amount: number | 'full';
  /** Σ |gross| of credit notes already issued against the invoice. */
  priorCredited: number;
  issueDate: string;
  reasonCode?: 'refund' | 'cancellation' | null;
  reason?: string | null;
}

/**
 * Credit-note snapshot (D4). Full credit with nothing credited before is the
 * negated mirror of the invoice; anything else is one line per VAT rate with
 * the gross allocated pro-rata to the invoice's gross per rate (largest
 * remainder, shipping included — L11). The caller enforces the caps.
 */
export function buildCreditSnapshot(input: BuildCreditInput): InvoiceSnapshot {
  const { original } = input;
  const { toMinor, toMajor } = money(original.currency);
  const neg = (major: number) => toMajor(-toMinor(major));

  const base = {
    version: INVOICE_SNAPSHOT_VERSION as typeof INVOICE_SNAPSHOT_VERSION,
    template_version: INVOICE_TEMPLATE_VERSION,
    kind: 'CREDIT_NOTE' as const,
    locale: original.locale,
    currency: original.currency,
    tax_mode: original.tax_mode,
    seller: original.seller,
    buyer: original.buyer,
    payment: original.payment,
    bank: null,
    refs: {
      order_number: original.refs.order_number,
      order_date: original.refs.order_date,
      invoice_number: '',
      issue_date: input.issueDate,
      due_date: null,
      credited_number: original.refs.invoice_number,
      credited_issue_date: original.refs.issue_date,
      reason_code: input.reasonCode ?? null,
      reason: input.reason ?? null,
    },
    // b2b app M2.5: a credit note of an exempt invoice is exempt the same way.
    ...(original.tax_exemption
      ? { tax_exemption: original.tax_exemption }
      : {}),
  };

  if (input.amount === 'full' && toMinor(input.priorCredited) === 0) {
    return {
      ...base,
      lines: original.lines.map((l) => ({
        ...l,
        unit_net: neg(l.unit_net),
        line_net: neg(l.line_net),
      })),
      vat_summary: original.vat_summary.map((r) => ({
        ...r,
        net: neg(r.net),
        vat: neg(r.vat),
        gross: neg(r.gross),
      })),
      totals: {
        net: neg(original.totals.net),
        vat: neg(original.totals.vat),
        gross: neg(original.totals.gross),
        layout: original.totals.layout,
      },
    };
  }

  const totalGross = toMinor(original.totals.gross);
  const credit =
    input.amount === 'full'
      ? totalGross - toMinor(input.priorCredited)
      : toMinor(input.amount);

  // Weights: the invoice's gross per VAT row; any gap to the total (no
  // summary rows at all, or rounding) is weighted at 0 %.
  const weights: {
    label: string | null;
    rate_bp: number;
    gross: number;
    exempt_reason?: TaxExemptReason;
  }[] = original.vat_summary.map((r) => ({
    label: r.label,
    rate_bp: r.rate_bp,
    gross: toMinor(r.gross),
    ...(r.exempt_reason ? { exempt_reason: r.exempt_reason } : {}),
  }));
  const weightSum = weights.reduce((s, w) => s + w.gross, 0);
  if (totalGross - weightSum > 0) {
    // On an exempt invoice the untaxed gap is exempt for the same reason.
    const reason = original.tax_exemption?.reason;
    weights.push({
      label: null,
      rate_bp: 0,
      gross: totalGross - weightSum,
      ...(reason ? { exempt_reason: reason } : {}),
    });
  }
  const shares = allocateLargestRemainder(
    credit,
    weights.map((w) => w.gross),
  );

  const lines: InvoiceLine[] = [];
  const vat_summary: InvoiceVatSummaryRow[] = [];
  let netSum = 0;
  let vatSum = 0;
  weights.forEach((w, i) => {
    const share = shares[i];
    if (!share) return;
    const vat = includedTaxMinor(share, w.rate_bp);
    const net = share - vat;
    netSum += net;
    vatSum += vat;
    lines.push({
      kind: 'credit',
      description: '',
      sku: null,
      details: [],
      qty: 1,
      unit_net: toMajor(-net),
      vat_rate_bp: w.rate_bp,
      line_net: toMajor(-net),
    });
    vat_summary.push({
      label: w.label,
      rate_bp: w.rate_bp,
      net: toMajor(-net),
      vat: toMajor(-vat),
      gross: toMajor(-share),
      ...(w.exempt_reason ? { exempt_reason: w.exempt_reason } : {}),
    });
  });

  return {
    ...base,
    lines,
    vat_summary,
    totals: {
      net: toMajor(-netSum),
      vat: toMajor(-vatSum),
      gross: toMajor(-credit),
      layout: original.totals.layout,
    },
  };
}

// ── Invariants ──────────────────────────────────────────────────────────────

/** Broken invariants of a snapshot (empty = consistent). */
export function snapshotInvariantErrors(snapshot: InvoiceSnapshot): string[] {
  const { toMinor } = money(snapshot.currency);
  const errors: string[] = [];
  const linesNet = snapshot.lines.reduce((s, l) => s + toMinor(l.line_net), 0);
  const summaryVat = snapshot.vat_summary.reduce(
    (s, r) => s + toMinor(r.vat),
    0,
  );
  const { net, vat, gross } = snapshot.totals;
  if (linesNet !== toMinor(net)) {
    errors.push(
      `Σ lines.line_net (${linesNet}) !== totals.net (${toMinor(net)})`,
    );
  }
  if (summaryVat !== toMinor(vat)) {
    errors.push(
      `Σ vat_summary.vat (${summaryVat}) !== totals.vat (${toMinor(vat)})`,
    );
  }
  if (toMinor(net) + toMinor(vat) !== toMinor(gross)) {
    errors.push('totals.net + totals.vat !== totals.gross');
  }
  return errors;
}
