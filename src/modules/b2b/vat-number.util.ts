// VAT-number formats by country prefix (b2b app, D7). Format only - no VIES
// lookup. Pure, no exceptions. The number is stored as typed, uppercased and
// without spaces / separators.

/**
 * Country-prefix patterns; every other known prefix (VAT_PREFIXES) uses the
 * generic EU-style rule, an unknown prefix is invalid.
 */
export const VAT_PATTERNS: Record<string, RegExp> = {
  SE: /^SE\d{12}$/,
  DE: /^DE\d{9}$/,
  FI: /^FI\d{8}$/,
  DK: /^DK\d{8}$/,
  NO: /^NO\d{9}MVA$/,
  GB: /^GB(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
  FR: /^FR[A-Z0-9]{2}\d{9}$/,
  NL: /^NL\d{9}B\d{2}$/,
  AT: /^ATU\d{8}$/,
  BE: /^BE[01]\d{9}$/,
  IT: /^IT\d{11}$/,
  ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/,
  IE: /^IE(\d{7}[A-Z]{1,2}|\d[A-Z0-9+*]\d{5}[A-Z])$/,
  PL: /^PL\d{10}$/,
};

export const GENERIC_VAT_PATTERN = /^[A-Z]{2}[A-Z0-9]{2,13}$/;

/**
 * Prefixes the generic rule accepts: ISO 3166-1 alpha-2 codes plus EL
 * (Greece's VAT prefix, used instead of GR) and XI (Northern Ireland).
 */
export const VAT_PREFIXES: ReadonlySet<string> = new Set(
  (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI ' +
    'BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN ' +
    'CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK ' +
    'FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM ' +
    'HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN ' +
    'KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ' +
    'ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP ' +
    'NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
    'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF ' +
    'TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI ' +
    'VN VU WF WS YE YT ZA ZM ZW EL XI'
  ).split(' '),
);

export interface VatNumberResult {
  ok: boolean;
  /** Uppercased, separators removed; empty when the input was blank. */
  normalized: string;
  /** The two-letter prefix (null when the input has none). */
  country: string | null;
  reason: 'EMPTY' | 'FORMAT' | null;
}

/** Uppercase and strip spaces, dots and dashes. */
export function normalizeVatNumber(raw: string | null | undefined): string {
  return (raw ?? '').toUpperCase().replace(/[\s\-.]/g, '');
}

export function validateVatNumber(
  raw: string | null | undefined,
): VatNumberResult {
  const normalized = normalizeVatNumber(raw);
  if (!normalized) {
    return { ok: false, normalized, country: null, reason: 'EMPTY' };
  }
  const prefix = normalized.slice(0, 2);
  const country = /^[A-Z]{2}$/.test(prefix) ? prefix : null;
  const specific = country ? VAT_PATTERNS[country] : undefined;
  const ok = specific
    ? specific.test(normalized)
    : !!country &&
      VAT_PREFIXES.has(country) &&
      GENERIC_VAT_PATTERN.test(normalized);
  return { ok, normalized, country, reason: ok ? null : 'FORMAT' };
}
