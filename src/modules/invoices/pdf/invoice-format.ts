/**
 * Locale-aware formatting for invoice PDFs. All numbers use Latin digits
 * (`numberingSystem: 'latn'`, decision L6), including on Arabic invoices.
 * Bidi control marks that Intl inserts for RTL locales are stripped: the
 * template isolates every number in `<bdi dir="ltr">`, which is more robust
 * than relying on invisible marks inside a PDF.
 */
import { currencyDecimals } from '../../../common/money/currency.util';
import type { PdfLocale } from './snapshot-for-pdf';

const INTL_LOCALE: Record<PdfLocale, string> = {
  en: 'en-GB',
  ar: 'ar',
  tr: 'tr-TR',
  de: 'de-DE',
  fr: 'fr-FR',
  sv: 'sv-SE',
};

const BIDI_MARKS = /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g;

function intlLocale(locale: PdfLocale): string {
  return `${INTL_LOCALE[locale] ?? 'en-GB'}-u-nu-latn`;
}

/** Normalises any space-like group separator to a plain no-break space. */
function clean(s: string): string {
  return s.replace(BIDI_MARKS, '').replace(/[\u202f\u00a0]/g, '\u00a0');
}

/** Formats a major-unit amount in the invoice currency, e.g. "1 234,50 kr". */
export function formatMoney(
  amount: number,
  currency: string,
  locale: PdfLocale,
): string {
  const value = Number(amount) || 0;
  const digits = currencyDecimals(currency);
  // Avoid "-0,00" when a residual rounds to zero.
  const safe = Math.abs(value) < 0.5 / 10 ** digits ? 0 : value;
  try {
    return clean(
      new Intl.NumberFormat(intlLocale(locale), {
        style: 'currency',
        currency,
        currencyDisplay: locale === 'ar' ? 'code' : 'symbol',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(safe),
    );
  } catch {
    return `${currency} ${safe.toFixed(digits)}`;
  }
}

/** Plain number without currency (quantities). */
export function formatNumber(value: number, locale: PdfLocale): string {
  return clean(
    new Intl.NumberFormat(intlLocale(locale), {
      maximumFractionDigits: 3,
    }).format(Number(value) || 0),
  );
}

/** VAT rate in basis points → "25 %" (sv) / "25%" (en). */
export function formatPercent(rateBp: number, locale: PdfLocale): string {
  return clean(
    new Intl.NumberFormat(intlLocale(locale), {
      style: 'percent',
      maximumFractionDigits: 2,
    }).format((Number(rateBp) || 0) / 10000),
  );
}

/**
 * Formats an ISO date ("2026-10-14" or a full timestamp) as a numeric date in
 * the invoice locale; sv keeps the Swedish ISO style "2026-10-14". The date
 * part is interpreted as a calendar date (UTC), never shifted by timezone.
 */
export function formatDate(
  iso: string | Date | null | undefined,
  locale: PdfLocale,
): string {
  if (!iso) return '';
  const d =
    iso instanceof Date
      ? iso
      : new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  if (locale === 'sv') return d.toISOString().slice(0, 10);
  return clean(
    new Intl.DateTimeFormat(intlLocale(locale), {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: 'UTC',
    }).format(d),
  );
}
