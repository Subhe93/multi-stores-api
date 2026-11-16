import { BadRequestException } from '@nestjs/common';
import {
  ExternalUrlRejected,
  assertExternalHostAllowed,
  isExternalHostAllowed,
  parseExternalReturnUrl,
  tryParseExternalReturnUrl,
} from './external-site-hosts';

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

/** After payment: a "back to site" button, or a cancellable auto-redirect. */
export const RETURN_MODES = ['button', 'auto'] as const;
export type ReturnMode = (typeof RETURN_MODES)[number];

/**
 * The external-site keys (headless booking P3). A body that omits any of them
 * keeps the stored value of each omitted key (see `withStoredExternalReturn`),
 * so a client that does not know them cannot wipe them.
 */
export const EXTERNAL_RETURN_KEYS = [
  'external_site_url',
  'return_url',
  'return_mode',
  'back_label',
  'external_focus',
] as const;

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
  /** The store's own website (https, exact host). Null = no external site. */
  external_site_url: string | null;
  /** Where "back to site" goes after payment; may carry `{order_number}`.
   *  Host = the external_site_url host or its www twin. Null = the site URL. */
  return_url: string | null;
  /** `button` (default) or `auto` (countdown redirect after a paid order). */
  return_mode: ReturnMode;
  /** "Back to site" button label per locale; null = translated default. */
  back_label: Record<string, string> | null;
  /** Focused storefront: the store is a purchase step of the external site
   *  (reduced header/footer, browsing pages redirect to the site). Only ever
   *  true while an external site is set; absent = off, so the internal
   *  shape of every store without it is unchanged. */
  external_focus?: boolean;
}

type ExternalReturnKey = (typeof EXTERNAL_RETURN_KEYS)[number];

/**
 * What is stored and sent to the storefront: the external-site keys appear
 * only while an external site is set, so the JSON of every other store stays
 * exactly what it was before P3. `external_focus` appears only when true, so
 * a store with a site but without the focused storefront keeps its P3 JSON.
 */
export type CompactCheckoutSettings = Omit<CheckoutSettings, ExternalReturnKey> &
  Partial<Pick<CheckoutSettings, ExternalReturnKey>>;

/**
 * Drops the external-site keys when no external site is configured, and
 * `external_focus` whenever it is off.
 */
export function compactCheckoutSettings(
  s: CheckoutSettings,
): CompactCheckoutSettings {
  const out: CompactCheckoutSettings = { ...s };
  if (!s.external_focus) delete out.external_focus;
  if (s.external_site_url) return out;
  for (const k of EXTERNAL_RETURN_KEYS) delete out[k];
  return out;
}

export const DEFAULT_CHECKOUT_SETTINGS: Readonly<CheckoutSettings> = Object.freeze({
  after_add_to_cart: 'stay',
  phone_required: false,
  pay_button_label: null,
  coupon_param: ['coupon'],
  coupon_autoapply: false,
  external_site_url: null,
  return_url: null,
  return_mode: 'button',
  back_label: null,
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
): CompactCheckoutSettings | null {
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
      case 'external_focus':
        if (value === undefined || value === null) break;
        if (typeof value !== 'boolean')
          invalid('external_focus must be a boolean');
        if (value) out.external_focus = true;
        break;
      case 'pay_button_label':
      case 'back_label':
        if (value === undefined || value === null) break;
        if (key === 'back_label')
          out.back_label = normalizeLocaleLabels('back_label', value);
        else out.pay_button_label = normalizeLocaleLabels('pay_button_label', value);
        break;
      case 'external_site_url':
        if (value === undefined || value === null || value === '') break;
        out.external_site_url = parseExternalReturnUrl(value, 'external_site_url');
        break;
      case 'return_url':
        if (value === undefined || value === null || value === '') break;
        out.return_url = parseExternalReturnUrl(value, 'return_url');
        break;
      case 'return_mode':
        if (value === undefined || value === null) break;
        if (!RETURN_MODES.includes(value as ReturnMode))
          invalid(`return_mode must be one of ${RETURN_MODES.join(', ')}`);
        out.return_mode = value as ReturnMode;
        break;
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
  if (out.external_site_url) {
    // The platform-host rule is NOT checked here: this function also runs
    // for bodies that only carry the stored site over, and a save of an
    // unrelated key must never start failing. `StoresService.update` checks
    // it when the site or the focused storefront actually changes.
    if (out.return_url)
      assertExternalHostAllowed(out.return_url, out.external_site_url);
  } else {
    // A return target or the focused storefront without a site is refused;
    // the cosmetic keys have no meaning without a site and fall back to
    // their defaults.
    if (out.return_url)
      throw new ExternalUrlRejected('return_url', 'external_site_url_required');
    if (out.external_focus)
      throw new ExternalUrlRejected(
        'external_focus',
        'external_site_url_required',
      );
    out.return_mode = DEFAULT_CHECKOUT_SETTINGS.return_mode;
    out.back_label = null;
  }
  return isDefaultCheckoutSettings(out) ? null : compactCheckoutSettings(out);
}

/** Validates a `{ locale: label }` map; an emptied entry means "default". */
function normalizeLocaleLabels(
  key: 'pay_button_label' | 'back_label',
  value: unknown,
): Record<string, string> | null {
  if (!isPlainObject(value)) invalid(`${key} must be an object keyed by locale`);
  const labels: Record<string, string> = {};
  const entries = Object.entries(value);
  if (entries.length > MAX_LOCALE_LABELS)
    invalid(`${key} may hold at most ${MAX_LOCALE_LABELS} locales`);
  for (const [locale, label] of entries) {
    if (!LOCALE_KEY_RE.test(locale))
      invalid(`${key}: "${locale}" is not a locale key`);
    if (typeof label !== 'string') invalid(`${key}.${locale} must be a string`);
    const trimmed = label.trim();
    // An emptied field means "use the default for this locale".
    if (!trimmed) continue;
    if (trimmed.length > MAX_LABEL_LENGTH)
      invalid(`${key}.${locale} must be at most ${MAX_LABEL_LENGTH} characters`);
    labels[locale] = trimmed;
  }
  return Object.keys(labels).length ? labels : null;
}

/**
 * Carries the stored external-site keys a checkout_settings body (an object)
 * omits, key by key, so a client that saves only some keys (or none, an
 * older client) cannot wipe the others. An explicit empty
 * `external_site_url` (null or '') still clears every external key, and
 * `null` as the whole body still clears everything. When the body names a
 * new site, the stored return_url is carried only if it stays on that host.
 * `external_focus` follows the same rule: omitted = kept, cleared with the
 * site.
 */
export function withStoredExternalReturn(raw: unknown, stored: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  if (
    'external_site_url' in raw &&
    (raw.external_site_url === null ||
      raw.external_site_url === undefined ||
      raw.external_site_url === '')
  )
    return raw;
  const missing = EXTERNAL_RETURN_KEYS.filter((k) => !(k in raw));
  if (!missing.length) return raw;
  const current = readStoredCheckoutSettings(stored);
  if (!current.external_site_url) return raw;
  const carried: Record<string, unknown> = { ...raw };
  for (const k of missing) {
    if (k === 'return_url' && 'external_site_url' in raw) {
      const site = tryParseExternalReturnUrl(
        raw.external_site_url,
        'external_site_url',
      );
      if (
        !site ||
        !current.return_url ||
        !isExternalHostAllowed(current.return_url, site)
      )
        continue;
    }
    carried[k] = current[k];
  }
  return carried;
}

/**
 * Audit labels of the external-site keys an update changes: the two URLs
 * (`<key> (cleared)` when emptied) and the focused storefront switch
 * (`external_focus` when turned on, `external_focus (cleared)` when off).
 */
export function changedExternalFields(
  before: CheckoutSettings,
  after: CheckoutSettings,
): string[] {
  const fields: string[] = changedExternalUrlKeys(before, after).map((k) =>
    after[k] === null ? `${k} (cleared)` : k,
  );
  if (Boolean(before.external_focus) !== Boolean(after.external_focus))
    fields.push(
      after.external_focus ? 'external_focus' : 'external_focus (cleared)',
    );
  return fields;
}

/** Names of the external-site URL keys that differ between two settings. */
export function changedExternalUrlKeys(
  before: CheckoutSettings,
  after: CheckoutSettings,
): ('external_site_url' | 'return_url')[] {
  return (['external_site_url', 'return_url'] as const).filter(
    (k) => before[k] !== after[k],
  );
}

/** True when every key equals the platform default. */
export function isDefaultCheckoutSettings(s: CheckoutSettings): boolean {
  const d = DEFAULT_CHECKOUT_SETTINGS;
  return (
    s.after_add_to_cart === d.after_add_to_cart &&
    s.phone_required === d.phone_required &&
    s.coupon_autoapply === d.coupon_autoapply &&
    s.pay_button_label === null &&
    s.external_site_url === null &&
    s.return_url === null &&
    s.return_mode === d.return_mode &&
    s.back_label === null &&
    !s.external_focus &&
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
  out.pay_button_label = readStoredLabels(raw.pay_button_label);
  // External site (P3): re-checked on every read, so a hand-edited row can
  // never turn the storefront into an open redirect.
  const site = tryParseExternalReturnUrl(raw.external_site_url, 'external_site_url');
  if (site) {
    out.external_site_url = site;
    const ret = tryParseExternalReturnUrl(raw.return_url, 'return_url');
    if (ret && isExternalHostAllowed(ret, site)) out.return_url = ret;
    if (RETURN_MODES.includes(raw.return_mode as ReturnMode))
      out.return_mode = raw.return_mode as ReturnMode;
    out.back_label = readStoredLabels(raw.back_label);
    if (raw.external_focus === true) out.external_focus = true;
  }
  if (Array.isArray(raw.coupon_param)) {
    const keys = raw.coupon_param.filter(
      (k): k is string => typeof k === 'string' && COUPON_PARAM_RE.test(k),
    );
    if (keys.length) out.coupon_param = keys;
  }
  return out;
}

function readStoredLabels(raw: unknown): Record<string, string> | null {
  if (!isPlainObject(raw)) return null;
  const labels: Record<string, string> = {};
  for (const [locale, label] of Object.entries(raw)) {
    if (typeof label === 'string' && label.trim()) labels[locale] = label.trim();
  }
  return Object.keys(labels).length ? labels : null;
}

/**
 * The public projection for `GET /storefront/:slug`: the full settings when
 * the store overrides anything, `undefined` when everything is default so the
 * `checkout` key is absent and existing payloads stay byte-identical.
 */
export function publicCheckoutSettings(
  raw: unknown,
): CompactCheckoutSettings | undefined {
  if (raw === null || raw === undefined) return undefined;
  const settings = readStoredCheckoutSettings(raw);
  return isDefaultCheckoutSettings(settings)
    ? undefined
    : compactCheckoutSettings(settings);
}
