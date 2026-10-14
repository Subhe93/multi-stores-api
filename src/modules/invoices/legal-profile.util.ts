// Pure validators of the seller's legal profile (invoices app). No
// exceptions: each returns the normalized value and whether it is valid, so
// the service decides which error code to raise.

export interface ValidationResult {
  ok: boolean;
  /** Canonical form to store (empty when the input was blank). */
  normalized: string;
}

/** Uppercase and strip spaces / dashes: "se45 5000 …" → "SE455000…". */
export function normalizeIban(raw: string | null | undefined): string {
  return (raw ?? '').toUpperCase().replace(/[\s-]/g, '');
}

/** ISO 13616 lengths of the countries most likely to appear. */
const IBAN_LENGTHS: Record<string, number> = {
  SE: 24,
  DE: 22,
  FI: 18,
  DK: 18,
  NO: 15,
  GB: 22,
  FR: 27,
  NL: 18,
  AT: 20,
  BE: 16,
  IT: 27,
  ES: 24,
  IE: 22,
  PL: 28,
  TR: 26,
  CH: 21,
};

/** mod-97 of a long digit string, chunked to stay within safe integers. */
function mod97(digits: string): number {
  let rest = 0;
  for (let i = 0; i < digits.length; i += 7) {
    rest = Number(String(rest) + digits.slice(i, i + 7)) % 97;
  }
  return rest;
}

/** IBAN structure + country length (when known) + ISO 7064 mod-97 check. */
export function validateIban(raw: string | null | undefined): ValidationResult {
  const normalized = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(normalized)) {
    return { ok: false, normalized };
  }
  const expected = IBAN_LENGTHS[normalized.slice(0, 2)];
  if (expected && normalized.length !== expected) {
    return { ok: false, normalized };
  }
  const rearranged = normalized.slice(4) + normalized.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (c) =>
    String(c.charCodeAt(0) - 55),
  );
  return { ok: mod97(digits) === 1, normalized };
}

/** Luhn (mod-10) over a digit string, check digit last. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Swedish bankgiro number: 7 or 8 digits with a mod-10 check digit, stored
 * as "NNN-NNNN" / "NNNN-NNNN" ("50501055" is accepted and formatted).
 */
export function validateBankgiro(
  raw: string | null | undefined,
): ValidationResult {
  const compact = (raw ?? '').replace(/[\s-]/g, '');
  if (!/^\d{7,8}$/.test(compact)) {
    return { ok: false, normalized: (raw ?? '').trim() };
  }
  const normalized = `${compact.slice(0, -4)}-${compact.slice(-4)}`;
  return { ok: luhnValid(compact), normalized };
}

/** BIC / SWIFT: 8 or 11 characters (bank, country, location, branch). */
export function validateBic(raw: string | null | undefined): ValidationResult {
  const normalized = (raw ?? '').toUpperCase().replace(/\s/g, '');
  return {
    ok: /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(normalized),
    normalized,
  };
}

/** The profile fields completeness looks at. */
export interface CompletenessFields {
  legal_name?: string | null;
  org_number?: string | null;
  vat_number?: string | null;
  address_line1?: string | null;
  postal_code?: string | null;
  city?: string | null;
  country_code?: string | null;
  iban?: string | null;
  bankgiro?: string | null;
  plusgiro?: string | null;
}

/** Key reported when no bank account at all is set. */
export const MISSING_BANK_ACCOUNT = 'iban|bankgiro';

/**
 * What must be filled in before anything can be issued. The VAT number is
 * required only when the documents carry VAT (`chargesVat`); one bank account
 * (IBAN, bankgiro or plusgiro) is required so unpaid invoices can be paid.
 * A missing profile reports every field.
 */
export function profileCompleteness(
  profile: CompletenessFields | null | undefined,
  opts: { chargesVat: boolean },
): { complete: boolean; missing: string[] } {
  const p = profile ?? {};
  const blank = (v: string | null | undefined) => !v || !v.trim();
  const missing: string[] = [];
  const required: (keyof CompletenessFields)[] = [
    'legal_name',
    'org_number',
    'address_line1',
    'postal_code',
    'city',
    'country_code',
  ];
  for (const key of required) if (blank(p[key])) missing.push(key);
  if (opts.chargesVat && blank(p.vat_number)) missing.push('vat_number');
  if (blank(p.iban) && blank(p.bankgiro) && blank(p.plusgiro)) {
    missing.push(MISSING_BANK_ACCOUNT);
  }
  return { complete: missing.length === 0, missing };
}

/** Whether `tz` is an IANA zone this runtime knows. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
