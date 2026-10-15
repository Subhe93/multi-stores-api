import { EU_COUNTRIES } from '../../taxes/tax-territory';
import type { ViesParsedResult } from './vies.types';

// Pure helpers of the VIES integration: member-state codes and the response
// parser. VIES answers errors with HTTP 200 and an `actionSucceed:false`
// envelope; every error except INVALID_INPUT means "could not check" and is
// treated as UNAVAILABLE (fail-closed: VAT is charged).

/** VIES member-state codes: the EU list with EL for Greece, plus XI. */
export const VIES_COUNTRIES: ReadonlySet<string> = new Set([
  ...EU_COUNTRIES.map((c) => (c === 'GR' ? 'EL' : c)),
  'XI',
]);

/** VAT prefix to VIES member-state code (GR becomes EL; EL / XI kept). */
export function toViesCountry(prefix: string): string {
  const p = prefix.toUpperCase();
  return p === 'GR' ? 'EL' : p;
}

/** VIES member-state code to ISO 3166 country (EL becomes GR; XI kept). */
export function viesCountryToIso(code: string): string {
  const c = code.toUpperCase();
  return c === 'EL' ? 'GR' : c;
}

/** Whether a VAT prefix belongs to a VIES member state (GR accepted as EL). */
export function isEuVatPrefix(prefix: string | null | undefined): boolean {
  return !!prefix && VIES_COUNTRIES.has(toViesCountry(prefix));
}

/** Split a normalised VAT number into the VIES code and the number part. */
export function splitViesNumber(normalized: string): {
  countryCode: string;
  number: string;
} {
  return {
    countryCode: toViesCountry(normalized.slice(0, 2)),
    number: normalized.slice(2),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** VIES marks an unknown name / address with "---"; blank is null too. */
function text(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return !t || /^-+$/.test(t) ? null : t;
}

/** First error code of an `errorWrappers` envelope. */
function errorCode(json: Record<string, unknown>): string | null {
  const wrappers = json.errorWrappers;
  if (Array.isArray(wrappers)) {
    for (const w of wrappers) {
      if (isRecord(w) && typeof w.error === 'string' && w.error) {
        return w.error;
      }
    }
  }
  return null;
}

/** One parsed VIES answer. Never throws; anything unexpected is UNAVAILABLE. */
export function parseViesResponse(json: unknown): ViesParsedResult {
  const unavailable = (code: string): ViesParsedResult => ({
    status: 'UNAVAILABLE',
    valid: false,
    name: null,
    address: null,
    request_identifier: null,
    request_date: null,
    error_code: code,
  });
  if (!isRecord(json)) return unavailable('MALFORMED_RESPONSE');
  const code = errorCode(json);
  if (json.actionSucceed === false || code) {
    const c = code ?? 'UNKNOWN_ERROR';
    if (c === 'INVALID_INPUT') return { ...unavailable(c), status: 'INVALID' };
    return unavailable(c);
  }
  if (typeof json.valid !== 'boolean') return unavailable('MALFORMED_RESPONSE');
  const requestDate =
    typeof json.requestDate === 'string' && json.requestDate
      ? json.requestDate
      : null;
  return {
    status: json.valid ? 'VALID' : 'INVALID',
    valid: json.valid,
    name: text(json.name),
    address: text(json.address),
    request_identifier: text(json.requestIdentifier),
    request_date: requestDate,
    error_code: null,
  };
}
