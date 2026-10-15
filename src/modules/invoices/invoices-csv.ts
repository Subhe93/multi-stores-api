import { currencyDecimals } from '../../common/money/currency.util';
import type { InvoiceSnapshot } from './invoices.types';

// CSV export of issued documents (M3 §3.6). Formula escaping applies to TEXT
// cells only: numeric cells are pre-formatted with the currency's decimals,
// so a credit note's "-120.00" stays a number in spreadsheets (the
// tax-management export escapes every value starting with "-").

export const INVOICE_CSV_COLUMNS = [
  'number',
  'kind',
  'issue_date',
  'due_date',
  'credited_number',
  'order_number',
  'buyer_type',
  'buyer_name',
  'buyer_org_number',
  'buyer_vat_number',
  'payment_method',
  'paid',
  'currency',
  'net_total',
  'vat_total',
  'gross_total',
  'vat_breakdown',
  // b2b app M2.5: empty for taxed documents.
  'tax_exempt_reason',
  'buyer_country',
] as const;

export interface InvoiceCsvRow {
  number: string;
  kind: string;
  issue_date: string;
  due_date: string | null;
  credited_number: string | null;
  order_number: string;
  buyer_type: string | null;
  buyer_name: string;
  currency: string;
  paid: boolean;
  net_total: number;
  vat_total: number;
  gross_total: number;
  snapshot: InvoiceSnapshot | null;
  /** b2b app M2.5: Invoice.tax_exempt_reason (null = taxed). */
  tax_exempt_reason?: string | null;
  /** b2b app M2.5: Invoice.buyer_vat_number (the validated number). */
  buyer_vat_number?: string | null;
  /** b2b app M2.5: Invoice.buyer_country (destination of the goods). */
  buyer_country?: string | null;
}

/** A text cell: neutralize spreadsheet formulas, then quote when needed. */
export function csvText(value: string | null | undefined): string {
  let v = value ?? '';
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",;\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** A numeric cell: fixed decimals of the currency, never escaped. */
export function csvAmount(value: number, currency: string): string {
  const decimals = currencyDecimals(currency);
  const fixed = (Number(value) || 0).toFixed(decimals);
  return fixed === `-${(0).toFixed(decimals)}` ? fixed.slice(1) : fixed;
}

function percent(rateBp: number): string {
  return `${Number((rateBp / 100).toFixed(2))}%`;
}

/** "25%:200.00;12%:12.00" from the snapshot's VAT summary. */
export function vatBreakdown(
  snapshot: InvoiceSnapshot | null,
  currency: string,
): string {
  return (snapshot?.vat_summary ?? [])
    .map((r) => `${percent(r.rate_bp)}:${csvAmount(r.vat, currency)}`)
    .join(';');
}

/** The CSV body (header + rows, CRLF line ends, no BOM). */
export function invoicesToCsv(rows: InvoiceCsvRow[]): string {
  const lines: string[] = [INVOICE_CSV_COLUMNS.join(',')];
  for (const r of rows) {
    const buyer = r.snapshot?.buyer;
    const cells = [
      csvText(r.number),
      csvText(r.kind),
      csvText(r.issue_date),
      csvText(r.due_date),
      csvText(r.credited_number),
      csvText(r.order_number),
      csvText(r.buyer_type),
      csvText(r.buyer_name),
      csvText(buyer?.org_number),
      csvText(r.buyer_vat_number || buyer?.vat_number),
      csvText(r.snapshot?.payment?.method),
      r.paid ? 'true' : 'false',
      csvText(r.currency),
      csvAmount(r.net_total, r.currency),
      csvAmount(r.vat_total, r.currency),
      csvAmount(r.gross_total, r.currency),
      csvText(vatBreakdown(r.snapshot, r.currency)),
      csvText(r.tax_exempt_reason),
      csvText(r.buyer_country),
    ];
    lines.push(cells.join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
