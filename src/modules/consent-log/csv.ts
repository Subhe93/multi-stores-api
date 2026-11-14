/**
 * CSV helpers of the consent-log export (consent v2 §5.6): comma separated,
 * CRLF lines, text cells guarded against spreadsheet formula injection.
 */

export const CONSENT_CSV_COLUMNS = [
  'id',
  'created_at',
  'consent_id',
  'action',
  'source',
  'analytics',
  'marketing',
  'external_media',
  'consent_version',
  'vendors',
  'locale',
  'text_hash',
] as const;

/** A text cell: a leading `= + - @` (or tab / CR) gets a `'` prefix, then quote when needed. */
export function csvCell(
  value: string | number | boolean | null | undefined,
): string {
  if (value === null || value === undefined) return '';
  let v = String(value);
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",;\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export interface ConsentCsvRow {
  id: string;
  created_at: Date;
  consent_id: string;
  action: string;
  source: string;
  analytics: boolean | null;
  marketing: boolean | null;
  external_media: boolean | null;
  consent_version: string;
  vendors: string[];
  locale: string;
  text_hash: string;
}

const bool = (v: boolean | null): string => (v === null ? '' : v ? '1' : '0');

export function csvHeader(): string {
  return CONSENT_CSV_COLUMNS.join(',') + '\r\n';
}

export function csvLine(r: ConsentCsvRow): string {
  return (
    [
      csvCell(r.id),
      csvCell(r.created_at.toISOString()),
      csvCell(r.consent_id),
      csvCell(r.action),
      csvCell(r.source),
      bool(r.analytics),
      bool(r.marketing),
      bool(r.external_media),
      csvCell(r.consent_version),
      csvCell((r.vendors ?? []).join(' ')),
      csvCell(r.locale),
      csvCell(r.text_hash),
    ].join(',') + '\r\n'
  );
}
