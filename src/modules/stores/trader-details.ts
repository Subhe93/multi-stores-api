import { BadRequestException } from '@nestjs/common';

/**
 * Legal trader identity of a store (SPEC §1): what e-handelslagen 8 § and
 * distansavtalslagen 2 kap. 2 § require before selling. Stored as
 * `Store.trader_details` (jsonb) with `completed_at` set by the API.
 */
export interface TraderDetails {
  legal_name: string;
  business_type: 'company' | 'private';
  org_number: string;
  vat_number?: string;
  address_line1: string;
  address_line2?: string;
  postal_code: string;
  city: string;
  /** ISO2, upper case. */
  country: string;
  phone: string;
  support_email: string;
  completed_at: string;
}

export const VAT_NUMBER_PATTERN = /^[A-Z]{2}[A-Z0-9]{2,12}$/;

/** Luhn (mod 10) checksum over a digit string. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Digits of a Swedish org number / personnummer as the checksum sees them:
 * 10 digits. Accepts "556016-0680", "5560160680", a 12-digit personnummer
 * with century (the 19/20 prefix is dropped) and the "16" prefix some
 * sources put in front of org numbers. Null when the shape is wrong.
 */
export function normalizeSwedishOrgNumber(raw: string): string | null {
  const digits = raw.replace(/[\s\-+]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === 10) return digits;
  if (digits.length === 12 && /^(16|18|19|20)/.test(digits)) {
    return digits.slice(2);
  }
  return null;
}

/** 10 digits with a valid Luhn checksum (companies and private persons). */
export function isValidSwedishOrgNumber(raw: string): boolean {
  const digits = normalizeSwedishOrgNumber(raw);
  return digits !== null && luhnValid(digits);
}

const REQUIRED_FIELDS = [
  'legal_name',
  'org_number',
  'address_line1',
  'postal_code',
  'city',
  'country',
  'phone',
  'support_email',
] as const;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Validates a trader-details body and returns the normalised record (trimmed,
 * ISO2 upper-cased, VAT upper-cased, SE org number without separators).
 * Throws 400 TRADER_DETAILS_INVALID with `fields` (the offending keys).
 */
export function validateTraderDetails(
  input: Record<string, unknown>,
  now = new Date(),
): TraderDetails {
  const fields: string[] = [];
  const body = input ?? {};
  for (const key of REQUIRED_FIELDS) {
    if (!str(body[key])) fields.push(key);
  }
  const businessType = str(body.business_type);
  if (businessType !== 'company' && businessType !== 'private') {
    fields.push('business_type');
  }
  const country = str(body.country).toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) fields.push('country');

  let orgNumber = str(body.org_number);
  if (orgNumber && country === 'SE') {
    const normalized = normalizeSwedishOrgNumber(orgNumber);
    if (!normalized || !luhnValid(normalized)) fields.push('org_number');
    else orgNumber = normalized;
  }

  const vat = str(body.vat_number).toUpperCase().replace(/\s/g, '');
  if (vat && !VAT_NUMBER_PATTERN.test(vat)) fields.push('vat_number');

  const supportEmail = str(body.support_email).toLowerCase();
  if (supportEmail && !EMAIL_PATTERN.test(supportEmail)) {
    fields.push('support_email');
  }
  const phone = str(body.phone);
  if (phone && !/^\+?[0-9 ()-]{5,30}$/.test(phone)) fields.push('phone');

  const unique = [...new Set(fields)];
  if (unique.length) {
    throw new BadRequestException({
      code: 'TRADER_DETAILS_INVALID',
      message: `Invalid trader details: ${unique.join(', ')}`,
      fields: unique,
    });
  }

  const address2 = str(body.address_line2);
  return {
    legal_name: str(body.legal_name),
    business_type: businessType as 'company' | 'private',
    org_number: orgNumber,
    ...(vat ? { vat_number: vat } : {}),
    address_line1: str(body.address_line1),
    ...(address2 ? { address_line2: address2 } : {}),
    postal_code: str(body.postal_code),
    city: str(body.city),
    country,
    phone,
    support_email: supportEmail,
    completed_at: now.toISOString(),
  };
}

/** Whether a stored value is a complete, still-valid trader record. */
export function traderDetailsComplete(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    validateTraderDetails(value as Record<string, unknown>);
    return true;
  } catch {
    return false;
  }
}
