import {
  BUYER_TYPES,
  type B2bSettings,
  type BuyerType,
  DEFAULT_B2B_SETTINGS,
} from './b2b.types';

// StoreApp.settings of the b2b app (D6). Two readers: a lenient parse for
// the hot paths (anything odd falls back to the default of that field,
// never throws) and a strict validation for the dashboard write
// (PUT /stores/my/apps/b2b), whose errors become STORE_APP_SETTINGS_INVALID.

export { DEFAULT_B2B_SETTINGS };

const ISO2 = /^[A-Za-z]{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBuyerType(value: unknown): value is BuyerType {
  return typeof value === 'string' && (BUYER_TYPES as string[]).includes(value);
}

/** Lenient read: defaults merged, invalid fields replaced by their default. */
export function parseB2bSettings(raw: unknown): B2bSettings {
  const d = DEFAULT_B2B_SETTINGS;
  if (!isRecord(raw)) {
    return { ...d, org_number_countries: [...d.org_number_countries] };
  }
  const countries = Array.isArray(raw.org_number_countries)
    ? raw.org_number_countries
        .filter((c): c is string => typeof c === 'string' && ISO2.test(c))
        .map((c) => c.toUpperCase())
    : null;
  return {
    allow_company:
      typeof raw.allow_company === 'boolean'
        ? raw.allow_company
        : d.allow_company,
    default_buyer_type: isBuyerType(raw.default_buyer_type)
      ? raw.default_buyer_type
      : d.default_buyer_type,
    require_vat_number:
      typeof raw.require_vat_number === 'boolean'
        ? raw.require_vat_number
        : d.require_vat_number,
    org_number_countries:
      countries !== null
        ? [...new Set(countries)]
        : [...d.org_number_countries],
  };
}

/**
 * Strict write validation. Every key is optional (the dashboard may send a
 * subset) and unknown keys are ignored (stored, never read), but a present
 * known key must have the right type.
 */
export function validateB2bSettings(raw: unknown): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: ['settings must be an object.'] };
  }
  if ('allow_company' in raw && typeof raw.allow_company !== 'boolean') {
    errors.push('allow_company must be true or false.');
  }
  if (
    'require_vat_number' in raw &&
    typeof raw.require_vat_number !== 'boolean'
  ) {
    errors.push('require_vat_number must be true or false.');
  }
  if ('default_buyer_type' in raw && !isBuyerType(raw.default_buyer_type)) {
    errors.push(`default_buyer_type must be one of ${BUYER_TYPES.join(', ')}.`);
  }
  if ('org_number_countries' in raw) {
    const list = raw.org_number_countries;
    if (!Array.isArray(list)) {
      errors.push('org_number_countries must be a list of ISO country codes.');
    } else {
      const bad = list.filter((c) => typeof c !== 'string' || !ISO2.test(c));
      if (bad.length) {
        errors.push(
          `org_number_countries contains invalid country codes: ${bad
            .map((c) => JSON.stringify(c))
            .join(', ')}.`,
        );
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
