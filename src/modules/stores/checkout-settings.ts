import { BadRequestException } from '@nestjs/common';

// ── Store checkout settings (M5 W2-A, M5-PLAN §4 M5.1) ───────────────────────
// Per-store checkout behaviour, stored in `Store.checkout_settings` (JSONB,
// nullable). NULL and every omitted key mean the platform default, which is
// exactly today's behaviour — so a store that never touched the card is
// unaffected and its storefront payload stays byte-identical (G0).
//
// The storefront mirror lives in `multi-stores-web/src/lib/checkoutSettings.ts`
// and the dashboard form in `multi-stores-dashboard/src/lib/checkoutSettings.ts`.
// Keep the three in sync when adding a key.

export const AFTER_ADD_TO_CART = ['stay', 'cart', 'checkout'] as const;
export type AfterAddToCart = (typeof AFTER_ADD_TO_CART)[number];

export interface CheckoutSettings {
  /** Where the shopper goes after "add to cart". `stay` = today's toast. */
  after_add_to_cart: AfterAddToCart;
  /** Whether the checkout form requires a phone number. Today it is optional. */
  phone_required: boolean;
  /** Pay button label per locale (`{ sv: 'Betala med kort' }`); null = the
   *  storefront's translated default. */
  pay_button_label: Record<string, string> | null;
  /** Query keys that carry a coupon code on any store URL (`?coupon=CODE`). */
  coupon_param: string[];
  /** Apply a coupon found in the URL automatically. */
  coupon_autoapply: boolean;
}

export const DEFAULT_CHECKOUT_SETTINGS: Readonly<CheckoutSettings> = Object.freeze({
  after_add_to_cart: 'stay',
  phone_required: false,
  pay_button_label: null,
  coupon_param: ['coupon'],
  coupon_autoapply: false,
});

// Limits for the validator. Locale keys are BCP-47-ish short tags (`sv`,
// `pt-BR`); query keys are plain URL-safe identifiers.
const MAX_LABEL_LENGTH = 60;
const MAX_LOCALE_LABELS = 20;
const MAX_COUPON_PARAMS = 5;
const MAX_COUPON_PARAM_LENGTH = 32;
const LOCALE_KEY_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const COUPON_PARAM_RE = /^[A-Za-z0-9_-]+$/;

function invalid(message: string): never {
  throw new BadRequestException({
    code: 'STORE_CHECKOUT_SETTINGS_INVALID',
    message,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates and normalizes the `checkout_settings` body of a store update.
 * Unknown keys are rejected (the dashboard only sends known ones), omitted
 * keys fall back to the default, and the result is always a full object.
 * `null` (or `{}`) clears the overrides, i.e. stores NULL.
 */
export function normalizeCheckoutSettingsInput(
  raw: unknown,
): CheckoutSettings | null {
  if (raw === null || raw === undefined) return null;
  if (!isPlainObject(raw)) invalid('checkout_settings must be an object');

  const out: CheckoutSettings = { ...DEFAULT_CHECKOUT_SETTINGS };
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    switch (key) {
      case 'after_add_to_cart':
        if (value === undefined || value === null) break;
        if (!AFTER_ADD_TO_CART.includes(value as AfterAddToCart))
          invalid(
            `after_add_to_cart must be one of ${AFTER_ADD_TO_CART.join(', ')}`,
          );
        out.after_add_to_cart = value as AfterAddToCart;
        break;
      case 'phone_required':
        if (value === undefined || value === null) break;
        if (typeof value !== 'boolean')
          invalid('phone_required must be a boolean');
        out.phone_required = value;
        break;
      case 'coupon_autoapply':
        if (value === undefined || value === null) break;
        if (typeof value !== 'boolean')
          invalid('coupon_autoapply must be a boolean');
        out.coupon_autoapply = value;
        break;
      case 'pay_button_label': {
        if (value === undefined || value === null) break;
        if (!isPlainObject(value))
          invalid('pay_button_label must be an object keyed by locale');
        const labels: Record<string, string> = {};
        const entries = Object.entries(value);
        if (entries.length > MAX_LOCALE_LABELS)
          invalid(`pay_button_label may hold at most ${MAX_LOCALE_LABELS} locales`);
        for (const [locale, label] of entries) {
          if (!LOCALE_KEY_RE.test(locale))
            invalid(`pay_button_label: "${locale}" is not a locale key`);
          if (typeof label !== 'string')
            invalid(`pay_button_label.${locale} must be a string`);
          const trimmed = label.trim();
          // An emptied field means "use the default for this locale".
          if (!trimmed) continue;
          if (trimmed.length > MAX_LABEL_LENGTH)
            invalid(
              `pay_button_label.${locale} must be at most ${MAX_LABEL_LENGTH} characters`,
            );
          labels[locale] = trimmed;
        }
        out.pay_button_label = Object.keys(labels).length ? labels : null;
        break;
      }
      case 'coupon_param': {
        if (value === undefined || value === null) break;
        if (!Array.isArray(value))
          invalid('coupon_param must be an array of query keys');
        if (value.length > MAX_COUPON_PARAMS)
          invalid(`coupon_param may hold at most ${MAX_COUPON_PARAMS} keys`);
        const keys: string[] = [];
        for (const entry of value) {
          if (typeof entry !== 'string')
            invalid('coupon_param entries must be strings');
          const trimmed = entry.trim();
          if (!trimmed) continue;
          if (
            trimmed.length > MAX_COUPON_PARAM_LENGTH ||
            !COUPON_PARAM_RE.test(trimmed)
          )
            invalid(
              `coupon_param: "${trimmed}" must be letters, digits, "_" or "-" (max ${MAX_COUPON_PARAM_LENGTH})`,
            );
          if (!keys.includes(trimmed)) keys.push(trimmed);
        }
        // An emptied list falls back to the default key rather than disabling
        // the feature silently (coupon_autoapply is the switch for that).
        out.coupon_param = keys.length ? keys : [...DEFAULT_CHECKOUT_SETTINGS.coupon_param];
        break;
      }
      default:
        invalid(`checkout_settings: unknown key "${key}"`);
    }
  }
  return isDefaultCheckoutSettings(out) ? null : out;
}

/** True when every key equals the platform default. */
export function isDefaultCheckoutSettings(s: CheckoutSettings): boolean {
  const d = DEFAULT_CHECKOUT_SETTINGS;
  return (
    s.after_add_to_cart === d.after_add_to_cart &&
    s.phone_required === d.phone_required &&
    s.coupon_autoapply === d.coupon_autoapply &&
    s.pay_button_label === null &&
    s.coupon_param.length === d.coupon_param.length &&
    s.coupon_param.every((k, i) => k === d.coupon_param[i])
  );
}

/**
 * Reads a stored `Store.checkout_settings` value defensively (a hand-edited
 * row must not break the storefront): unknown/invalid keys are ignored and
 * the result is a full object with defaults filled in.
 */
export function readStoredCheckoutSettings(raw: unknown): CheckoutSettings {
  const out: CheckoutSettings = { ...DEFAULT_CHECKOUT_SETTINGS };
  if (!isPlainObject(raw)) return out;
  if (AFTER_ADD_TO_CART.includes(raw.after_add_to_cart as AfterAddToCart))
    out.after_add_to_cart = raw.after_add_to_cart as AfterAddToCart;
  if (typeof raw.phone_required === 'boolean')
    out.phone_required = raw.phone_required;
  if (typeof raw.coupon_autoapply === 'boolean')
    out.coupon_autoapply = raw.coupon_autoapply;
  if (isPlainObject(raw.pay_button_label)) {
    const labels: Record<string, string> = {};
    for (const [locale, label] of Object.entries(raw.pay_button_label)) {
      if (typeof label === 'string' && label.trim()) labels[locale] = label.trim();
    }
    if (Object.keys(labels).length) out.pay_button_label = labels;
  }
  if (Array.isArray(raw.coupon_param)) {
    const keys = raw.coupon_param.filter(
      (k): k is string => typeof k === 'string' && COUPON_PARAM_RE.test(k),
    );
    if (keys.length) out.coupon_param = keys;
  }
  return out;
}

/**
 * The public projection for `GET /storefront/:slug`: the full settings when
 * the store overrides anything, `undefined` when everything is default so the
 * `checkout` key is absent and existing payloads stay byte-identical.
 */
export function publicCheckoutSettings(
  raw: unknown,
): CheckoutSettings | undefined {
  if (raw === null || raw === undefined) return undefined;
  const settings = readStoredCheckoutSettings(raw);
  return isDefaultCheckoutSettings(settings) ? undefined : settings;
}
