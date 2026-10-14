// Organisation-number formats (b2b app, D7). Pure: no I/O, no exceptions.
// Only countries the store lists in `org_number_countries` get their strict
// rule; every other country (and listed countries without a rule) accept
// the generic format. Mirrored in the web for inline messages; this is the
// authoritative copy.

export interface OrgNumberRule {
  /** Human-readable expected format, shown in error messages. */
  format: string;
  /** Digits-only canonical form after stripping separators, or null. */
  normalize: (raw: string) => string | null;
  /** Checksum over the normalized digits; absent = format only. */
  checksum?: (digits: string) => boolean;
  /** Pretty form stored on the order / shown back to the shopper. */
  pretty: (digits: string) => string;
}

export type OrgNumberReason = 'EMPTY' | 'FORMAT' | 'CHECKSUM';

export interface OrgNumberResult {
  ok: boolean;
  /** Canonical form when ok, the trimmed input otherwise. */
  normalized: string;
  reason: OrgNumberReason | null;
  /** The expected format of the rule that was applied. */
  format: string;
  /** ISO2 of the strict rule applied, null for the generic rule. */
  country: string | null;
}

const digitsOnly = (raw: string) => raw.replace(/[\s\-.]/g, '');

/** Luhn mod-10 (Swedish standard): doubles every other digit from the right. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const fromRight = digits.length - 1 - i;
    let d = Number(digits[i]);
    if (fromRight % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Weighted sum of the leading digits (helper of the Nordic mod-11 checks). */
function weightedSum(digits: string, weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) {
    sum += Number(digits[i]) * weights[i];
  }
  return sum;
}

export const ORG_NUMBER_RULES: Record<string, OrgNumberRule> = {
  // Sweden: NNNNNN-NNNN, Luhn over the 10 digits. The 12-digit form with a
  // "16" prefix (as in the VAT number) is accepted and reduced.
  SE: {
    format: 'NNNNNN-NNNN',
    normalize: (raw) => {
      let d = digitsOnly(raw);
      if (d.length === 12 && d.startsWith('16')) d = d.slice(2);
      return /^\d{10}$/.test(d) ? d : null;
    },
    checksum: luhnValid,
    pretty: (d) => `${d.slice(0, 6)}-${d.slice(6)}`,
  },
  // Finland: Y-tunnus NNNNNNN-N, modulus 11 with weights 7 9 10 5 8 4 2.
  FI: {
    format: 'NNNNNNN-N',
    normalize: (raw) => {
      const d = digitsOnly(raw);
      return /^\d{8}$/.test(d) ? d : null;
    },
    checksum: (d) => {
      const rem = weightedSum(d, [7, 9, 10, 5, 8, 4, 2]) % 11;
      if (rem === 1) return false;
      const check = rem === 0 ? 0 : 11 - rem;
      return check === Number(d[7]);
    },
    pretty: (d) => `${d.slice(0, 7)}-${d.slice(7)}`,
  },
  // Denmark: CVR, 8 digits, modulus 11 with weights 2 7 6 5 4 3 2 1.
  DK: {
    format: 'NNNNNNNN',
    normalize: (raw) => {
      const d = digitsOnly(raw);
      return /^\d{8}$/.test(d) ? d : null;
    },
    checksum: (d) => weightedSum(d, [2, 7, 6, 5, 4, 3, 2, 1]) % 11 === 0,
    pretty: (d) => d,
  },
  // Norway: organisasjonsnummer, 9 digits, modulus 11 with weights
  // 3 2 7 6 5 4 3 2 over the first eight. A trailing "MVA" is ignored.
  NO: {
    format: 'NNNNNNNNN',
    normalize: (raw) => {
      const d = digitsOnly(raw.replace(/MVA$/i, ''));
      return /^\d{9}$/.test(d) ? d : null;
    },
    checksum: (d) => {
      const rem = weightedSum(d, [3, 2, 7, 6, 5, 4, 3, 2]) % 11;
      const check = rem === 0 ? 0 : 11 - rem;
      if (check === 10) return false;
      return check === Number(d[8]);
    },
    pretty: (d) => d,
  },
};

/** Generic rule: 4-20 characters of letters, digits, space, dot, slash, dash. */
export const GENERIC_ORG_NUMBER_FORMAT = '4-20 characters';
const GENERIC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .\-/]{2,18}[A-Za-z0-9]$/;

/**
 * Validate an organisation number for a country. `strictCountries` lists
 * the ISO2 codes whose rule applies; a listed country without a rule, and
 * every unlisted country, fall back to the generic format.
 */
export function validateOrgNumber(
  country: string | null | undefined,
  raw: string | null | undefined,
  opts: { strictCountries?: readonly string[] } = {},
): OrgNumberResult {
  const trimmed = (raw ?? '').trim().replace(/\s+/g, ' ');
  const iso = (country ?? '').trim().toUpperCase();
  const strict = (opts.strictCountries ?? []).map((c) => c.toUpperCase());
  const rule = strict.includes(iso) ? ORG_NUMBER_RULES[iso] : undefined;

  if (!trimmed) {
    return {
      ok: false,
      normalized: '',
      reason: 'EMPTY',
      format: rule?.format ?? GENERIC_ORG_NUMBER_FORMAT,
      country: rule ? iso : null,
    };
  }
  if (!rule) {
    const ok = GENERIC_PATTERN.test(trimmed);
    return {
      ok,
      normalized: trimmed,
      reason: ok ? null : 'FORMAT',
      format: GENERIC_ORG_NUMBER_FORMAT,
      country: null,
    };
  }
  const digits = rule.normalize(trimmed);
  if (!digits) {
    return {
      ok: false,
      normalized: trimmed,
      reason: 'FORMAT',
      format: rule.format,
      country: iso,
    };
  }
  if (rule.checksum && !rule.checksum(digits)) {
    return {
      ok: false,
      normalized: trimmed,
      reason: 'CHECKSUM',
      format: rule.format,
      country: iso,
    };
  }
  return {
    ok: true,
    normalized: rule.pretty(digits),
    reason: null,
    format: rule.format,
    country: iso,
  };
}

/**
 * Best-effort canonical form for prefill storage (customer / address
 * defaults): the strict pretty form when the number validates for the
 * country, else the trimmed input. Never rejects.
 */
export function normalizeOrgNumber(
  country: string | null | undefined,
  raw: string | null | undefined,
): string {
  const iso = (country ?? '').trim().toUpperCase();
  return validateOrgNumber(iso, raw, { strictCountries: iso ? [iso] : [] })
    .normalized;
}
