// EC sales list (periodisk sammanställning) of reverse-charge sales (b2b app
// M2.5, D11). Pure helpers: period bucketing, row aggregation and the CSV
// writer. The data is loaded by TaxManagementService.ecSalesReport.

export type EcSalesPeriod = 'month' | 'quarter';
export type EcSalesSource = 'invoices' | 'orders';

/** One document (invoice / credit note / order or its refund mirror). */
export interface EcSalesDocument {
  date: Date;
  /**
   * The date is a calendar date (Invoice.issue_date, already the seller's
   * local day): bucketed by its UTC components, never shifted by a zone.
   */
  date_only?: boolean;
  buyer_country: string;
  buyer_vat_number: string;
  buyer_name: string | null;
  /** Signed goods amount in the document currency. */
  amount: number;
  currency: string;
  /** Base-to-document-currency rate (null / 1 = same currency). */
  fx_rate: number | null;
}

export interface EcSalesRow {
  period: string;
  buyer_country: string;
  buyer_vat_number: string;
  buyer_name: string | null;
  goods_amount: number;
  currency: string;
  goods_amount_store_currency: number;
  store_currency: string;
  document_count: number;
}

export interface EcSalesReport {
  source: EcSalesSource;
  /** False for the orders source: partial refunds are not netted. */
  partial_refunds_included: boolean;
  rows: EcSalesRow[];
}

/** Default seller timezone (StoreLegalProfile.timezone default). */
export const DEFAULT_EC_SALES_TIMEZONE = 'Europe/Stockholm';

/** Calendar year / month (1-12) / day of an instant in `timeZone`. */
export function zonedParts(
  date: Date,
  timeZone: string,
): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
  } catch {
    // Unknown zone: fall back to UTC rather than failing the report.
    return {
      y: date.getUTCFullYear(),
      m: date.getUTCMonth() + 1,
      d: date.getUTCDate(),
      h: date.getUTCHours(),
      mi: date.getUTCMinutes(),
      s: date.getUTCSeconds(),
    };
  }
  const get = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    y: get('year'),
    m: get('month'),
    d: get('day'),
    h: get('hour'),
    mi: get('minute'),
    s: get('second'),
  };
}

/** The instant a YYYY-MM-DD day starts in `timeZone`. */
export function zonedDayStart(ymd: string, timeZone: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const offsetAt = (t: number) => {
    const p = zonedParts(new Date(t), timeZone);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - t;
  };
  let t = guess - offsetAt(guess);
  // Second pass settles a DST change between the guess and the result.
  t = guess - offsetAt(t);
  return new Date(t);
}

/**
 * '2026-10' (month) or '2026-Q4' (quarter) of an instant in the seller's
 * timezone (UTC components for a date-only value).
 */
export function ecSalesPeriodKey(
  date: Date,
  period: EcSalesPeriod,
  timeZone = 'UTC',
  dateOnly = false,
): string {
  const parts = dateOnly
    ? { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1 }
    : zonedParts(date, timeZone);
  const y = parts.y;
  const m = parts.m - 1;
  return period === 'quarter'
    ? `${y}-Q${Math.floor(m / 3) + 1}`
    : `${y}-${String(m + 1).padStart(2, '0')}`;
}

const cents = (v: number) => Math.round(v * 100);

/**
 * Group documents by (period, buyer country, buyer VAT number, currency).
 * Amounts are summed in cents; the store-currency amount of each document
 * is amount / fx_rate rounded to cents before summing.
 */
export function aggregateEcSales(
  docs: EcSalesDocument[],
  period: EcSalesPeriod,
  storeCurrency: string,
  timeZone = 'UTC',
): EcSalesRow[] {
  const groups = new Map<
    string,
    EcSalesRow & { amountC: number; storeC: number }
  >();
  for (const d of docs) {
    const periodKey = ecSalesPeriodKey(d.date, period, timeZone, d.date_only);
    const key = [
      periodKey,
      d.buyer_country,
      d.buyer_vat_number,
      d.currency,
    ].join('|');
    const rate = d.fx_rate && d.fx_rate > 0 ? d.fx_rate : 1;
    const g = groups.get(key) ?? {
      period: periodKey,
      buyer_country: d.buyer_country,
      buyer_vat_number: d.buyer_vat_number,
      buyer_name: d.buyer_name,
      goods_amount: 0,
      currency: d.currency,
      goods_amount_store_currency: 0,
      store_currency: storeCurrency,
      document_count: 0,
      amountC: 0,
      storeC: 0,
    };
    g.amountC += cents(d.amount);
    g.storeC += cents(
      d.currency === storeCurrency ? d.amount : d.amount / rate,
    );
    g.document_count += 1;
    if (!g.buyer_name && d.buyer_name) g.buyer_name = d.buyer_name;
    groups.set(key, g);
  }
  return Array.from(groups.values())
    .map(({ amountC, storeC, ...row }) => ({
      ...row,
      goods_amount: amountC / 100,
      goods_amount_store_currency: storeC / 100,
    }))
    .sort(
      (a, b) =>
        a.period.localeCompare(b.period) ||
        a.buyer_country.localeCompare(b.buyer_country) ||
        a.buyer_vat_number.localeCompare(b.buyer_vat_number) ||
        a.currency.localeCompare(b.currency),
    );
}

/** Text cell: formula-injection guard plus RFC 4180 quoting. */
function textCell(v: string | null): string {
  let s = v ?? '';
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV of the report. Numeric cells are written raw (a negative credit
 * amount must stay a number, so the shared toCsv is not reused).
 */
export function ecSalesCsv(rows: EcSalesRow[]): string {
  const header = [
    'period',
    'buyer_country',
    'buyer_vat_number',
    'buyer_name',
    'goods_amount',
    'currency',
    'goods_amount_store_currency',
    'store_currency',
    'document_count',
  ];
  const body = rows.map((r) =>
    [
      textCell(r.period),
      textCell(r.buyer_country),
      textCell(r.buyer_vat_number),
      textCell(r.buyer_name),
      r.goods_amount.toFixed(2),
      textCell(r.currency),
      r.goods_amount_store_currency.toFixed(2),
      textCell(r.store_currency),
      String(r.document_count),
    ].join(','),
  );
  return [header.join(','), ...body].join('\r\n') + '\r\n';
}
