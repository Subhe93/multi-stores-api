// Settings of the `personalization` store app (M4.1 §3.9, C23), kept in
// StoreApp.settings. Two readers, like the b2b and production apps: a
// lenient parse for the runtime (odd values fall back to the default of
// that key, never throws) and a strict validation for the dashboard write
// (PUT /stores/my/apps/personalization → STORE_APP_SETTINGS_INVALID).
//
// Public keys (registry `public_settings_keys`, projected to the storefront):
// free_shipping_badge, card_price_mode, validation_summary, url_prefill,
// listing_cta. Private: free_shipping_country, retention_days.

export const CARD_PRICE_MODES = ['selection', 'from'] as const;
export type CardPriceMode = (typeof CARD_PRICE_MODES)[number];

/** `personalize` = listing quick-add links to the product's form (namez loop CTA). */
export const LISTING_CTAS = ['personalize', 'none'] as const;
export type ListingCta = (typeof LISTING_CTAS)[number];

export interface PersonalizationSettings {
  /** Variation cards show "free shipping" when the card price reaches the threshold. */
  free_shipping_badge: boolean;
  /** ISO2 country whose shipping threshold the badge uses; null = market / store country. */
  free_shipping_country: string | null;
  /** Card price: the variant matching the current picks, or always "from <min>". */
  card_price_mode: CardPriceMode;
  /** Summary list of missing fields after a failed add to cart. */
  validation_summary: boolean;
  /** URL param → field name, or `option:<Option name>` (namez `?name1=&color=`). */
  url_prefill: Record<string, string>;
  listing_cta: ListingCta;
  /** Days to keep customer uploads after the order (U12, C23). */
  retention_days: number;
}

export const PERSONALIZATION_SETTINGS_LIMITS = {
  retention_days_min: 7,
  retention_days_max: 730,
  url_prefill_entries: 20,
  url_prefill_param_length: 40,
  url_prefill_target_length: 120,
} as const;

/** The public whitelist (mirror of the registry's `public_settings_keys`). */
export const PERSONALIZATION_PUBLIC_SETTINGS_KEYS = [
  'free_shipping_badge',
  'card_price_mode',
  'validation_summary',
  'url_prefill',
  'listing_cta',
] as const;

export const DEFAULT_PERSONALIZATION_SETTINGS: Readonly<PersonalizationSettings> =
  Object.freeze({
    free_shipping_badge: true,
    free_shipping_country: null,
    card_price_mode: 'selection',
    validation_summary: true,
    url_prefill: Object.freeze({}) as Record<string, string>,
    listing_cta: 'personalize',
    retention_days: 60,
  });

const ISO2 = /^[A-Za-z]{2}$/;
/** URL query parameter names: letters, digits, `_`, `-`, `[`, `]`, `.`. */
const PARAM_NAME = /^[A-Za-z0-9_\-[\].]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isOneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === 'string' && (values as readonly string[]).includes(value)
  );
}

function isRetentionDays(value: unknown): value is number {
  const L = PERSONALIZATION_SETTINGS_LIMITS;
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= L.retention_days_min &&
    value <= L.retention_days_max
  );
}

function isPrefillParam(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= PERSONALIZATION_SETTINGS_LIMITS.url_prefill_param_length &&
    PARAM_NAME.test(key)
  );
}

function isPrefillTarget(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= PERSONALIZATION_SETTINGS_LIMITS.url_prefill_target_length &&
    value.trim() !== 'option:'
  );
}

/** Lenient read: defaults merged, invalid values replaced by their default. */
export function parsePersonalizationSettings(
  raw: unknown,
): PersonalizationSettings {
  const d = DEFAULT_PERSONALIZATION_SETTINGS;
  if (!isRecord(raw)) return { ...d, url_prefill: {} };
  const prefill: Record<string, string> = {};
  if (isRecord(raw.url_prefill)) {
    for (const [k, v] of Object.entries(raw.url_prefill)) {
      if (
        Object.keys(prefill).length >=
        PERSONALIZATION_SETTINGS_LIMITS.url_prefill_entries
      )
        break;
      if (isPrefillParam(k) && isPrefillTarget(v)) prefill[k] = v.trim();
    }
  }
  return {
    free_shipping_badge:
      typeof raw.free_shipping_badge === 'boolean'
        ? raw.free_shipping_badge
        : d.free_shipping_badge,
    free_shipping_country:
      typeof raw.free_shipping_country === 'string' &&
      ISO2.test(raw.free_shipping_country)
        ? raw.free_shipping_country.toUpperCase()
        : null,
    card_price_mode: isOneOf(CARD_PRICE_MODES, raw.card_price_mode)
      ? raw.card_price_mode
      : d.card_price_mode,
    validation_summary:
      typeof raw.validation_summary === 'boolean'
        ? raw.validation_summary
        : d.validation_summary,
    url_prefill: prefill,
    listing_cta: isOneOf(LISTING_CTAS, raw.listing_cta)
      ? raw.listing_cta
      : d.listing_cta,
    retention_days: isRetentionDays(raw.retention_days)
      ? raw.retention_days
      : d.retention_days,
  };
}

/**
 * The whitelisted public settings, leniently parsed (for the storefront
 * `apps` projector). Private keys never appear.
 */
export function personalizationPublicSettings(
  raw: unknown,
): Pick<
  PersonalizationSettings,
  (typeof PERSONALIZATION_PUBLIC_SETTINGS_KEYS)[number]
> {
  const s = parsePersonalizationSettings(raw);
  return {
    free_shipping_badge: s.free_shipping_badge,
    card_price_mode: s.card_price_mode,
    validation_summary: s.validation_summary,
    url_prefill: s.url_prefill,
    listing_cta: s.listing_cta,
  };
}

/**
 * Strict write validation. Every key is optional (the dashboard may send a
 * subset) and unknown keys are ignored (stored, never read), but a present
 * known key must have the right type and range.
 */
export function validatePersonalizationSettings(raw: unknown): {
  ok: boolean;
  errors: string[];
} {
  if (!isRecord(raw)) {
    return { ok: false, errors: ['settings must be an object.'] };
  }
  const L = PERSONALIZATION_SETTINGS_LIMITS;
  const errors: string[] = [];
  for (const key of ['free_shipping_badge', 'validation_summary'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') {
      errors.push(`${key} must be a boolean.`);
    }
  }
  const country = raw.free_shipping_country;
  if (
    country !== undefined &&
    country !== null &&
    !(typeof country === 'string' && ISO2.test(country))
  ) {
    errors.push(
      'free_shipping_country must be an ISO 3166-1 alpha-2 code or null.',
    );
  }
  if (
    raw.card_price_mode !== undefined &&
    !isOneOf(CARD_PRICE_MODES, raw.card_price_mode)
  ) {
    errors.push(
      `card_price_mode must be one of: ${CARD_PRICE_MODES.join(', ')}.`,
    );
  }
  if (
    raw.listing_cta !== undefined &&
    !isOneOf(LISTING_CTAS, raw.listing_cta)
  ) {
    errors.push(`listing_cta must be one of: ${LISTING_CTAS.join(', ')}.`);
  }
  if (
    raw.retention_days !== undefined &&
    !isRetentionDays(raw.retention_days)
  ) {
    errors.push(
      `retention_days must be an integer between ${L.retention_days_min} and ${L.retention_days_max}.`,
    );
  }
  if (raw.url_prefill !== undefined) {
    if (!isRecord(raw.url_prefill)) {
      errors.push('url_prefill must be an object of param → field name.');
    } else {
      const entries = Object.entries(raw.url_prefill);
      if (entries.length > L.url_prefill_entries) {
        errors.push(
          `url_prefill accepts at most ${L.url_prefill_entries} entries.`,
        );
      }
      for (const [k, v] of entries) {
        if (!isPrefillParam(k)) {
          errors.push(
            `url_prefill param "${k.slice(0, 60)}" must be 1-${L.url_prefill_param_length} characters of A-Z, a-z, 0-9, _ - [ ] .`,
          );
        }
        if (!isPrefillTarget(v)) {
          errors.push(
            `url_prefill.${k.slice(0, 60)} must be a field name or option:<Option name> (at most ${L.url_prefill_target_length} characters).`,
          );
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
