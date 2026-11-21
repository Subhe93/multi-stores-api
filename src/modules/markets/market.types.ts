// Mirror of multi-stores-shared/src/types/market.ts — keep in sync.

export type MarketStatus = 'DRAFT' | 'LIVE';
/**
 * M6.1: search indexing mode. AUTO = indexable on a custom domain, platform
 * subdomain redirects to the primary domain (else noindex); ALWAYS / NEVER
 * override on any host. The web proxy computes the effective result.
 */
export type MarketIndexing = 'AUTO' | 'ALWAYS' | 'NEVER';
export type StoreDomainStatus = 'PENDING' | 'VERIFIED' | 'ACTIVE';

/**
 * Locales the storefront can render (its `locales` list). 'ku' is Kurdish,
 * Kurmanji (Latin script, left to right); Sorani would be a separate 'ckb'.
 */
export const SUPPORTED_LOCALES = [
  'en',
  'ar',
  'tr',
  'de',
  'fr',
  'sv',
  'ku',
] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Locales in review: a store can enable them and reach them by their URL
 * prefix, but they stay out of the storefront language switcher, hreflang,
 * sitemaps and search indexing until a native speaker has reviewed the texts.
 * Removing a code here (and in the web / dashboard mirrors) makes it public.
 */
export const REVIEW_LOCALES: readonly SupportedLocale[] = [];

export function isReviewLocale(locale: string | null | undefined): boolean {
  return (REVIEW_LOCALES as readonly string[]).includes(locale ?? '');
}

/**
 * M156: one language-country URL path of a market. `path` is the first URL
 * segment: `${locale}-${country.toLowerCase()}` for a country row, `locale`
 * for a language-only row (country null). The root `/` always serves the
 * market's default_locale and never appears here.
 */
export interface MarketLocalePath {
  /** /^[a-z]{2}(-[a-z]{2})?$/, e.g. 'de-at' or 'ar'. Unique per market. */
  path: string;
  /** ISO 639-1, lower case; never the market's default_locale. */
  locale: string;
  /** ISO 3166-1 alpha-2, upper case, in market.countries; null = every country. */
  country: string | null;
  /** hreflang codes this URL answers for; first = primary ('de-AT'); each code unique per market. */
  hreflang: string[];
}

export type MarketLocalePathInactiveReason =
  | 'locale_unsupported' // not a storefront locale yet (SUPPORTED_LOCALES)
  | 'locale_not_enabled' // not in market.locales
  | 'country_not_in_market';

/** Dashboard view of a stored row. */
export interface MarketLocalePathView extends MarketLocalePath {
  active: boolean;
  /** null when active; otherwise the first failing rule, in the order above. */
  inactive_reason: MarketLocalePathInactiveReason | null;
}

// ── M157: payment methods per market ─────────────────────────────────────

/** Payment methods a market can restrict to. Stored and sent in this order. */
export const MARKET_PAYMENT_METHODS = ['card', 'kustom', 'cod'] as const;
export type MarketPaymentMethod = (typeof MARKET_PAYMENT_METHODS)[number];

/** Why the store cannot offer a method at all (GET /markets/payment-methods). */
export type StorePaymentMethodUnavailableReason =
  | 'card_not_connected'
  | 'kustom_not_configured'
  | 'cod_disabled'
  | 'not_independent';

export interface StorePaymentMethodStatus {
  method: MarketPaymentMethod;
  /** The store offers the method (currency-agnostic; the market check covers currencies). */
  available: boolean;
  /** null when available. */
  reason: StorePaymentMethodUnavailableReason | null;
  /** card only: the only card route is an ACTIVE TEST own key. */
  test_mode?: true;
}

/** GET /markets/payment-methods: always three rows, in MARKET_PAYMENT_METHODS order. */
export interface StorePaymentMethodsView {
  methods: StorePaymentMethodStatus[];
}

/** Error codes (HTTP 400, body { code, message, ... }). */
export type MarketPaymentMethodsErrorCode =
  | 'MARKET_PAYMENT_METHODS_INVALID' // + reason: 'unknown' | 'duplicate' | 'empty', value?: string
  | 'MARKET_PAYMENT_METHODS_NOT_READY';
export type PaymentMethodRuntimeErrorCode =
  | 'MARKET_PAYMENT_METHOD_NOT_ALLOWED' // + method: MarketPaymentMethod
  | 'KUSTOM_CURRENCY_NOT_ENABLED'; // + currency?: string

/** Kustom validation redirect reason (…/checkout?error=kustom_validation&reason=…). */
export type KustomValidationReasonM157 = 'payment_method_unavailable';

export type PriceRounding = {
  /** Round the converted amount to a multiple of this (1, 0.5, 0.1, ...). */
  increment?: number;
  /** Then move it to a price ending ('.99' → 26.99, '9' → 29, '0' → 30). */
  ending?: 'none' | '.99' | '.90' | '.95' | '9' | '0';
};

/**
 * How a market prices products that have no manual override.
 * - convert: base price × rate (manual rate or the platform FX table).
 * - fixed: no automatic conversion; products without an override still fall
 *   back to conversion when a rate is available, otherwise they are hidden.
 */
export interface PriceRule {
  mode: 'convert' | 'fixed';
  source?: 'manual' | 'platform';
  rate?: number;
  rounding?: PriceRounding;
}

export type PaymentProviderCheck = 'ok' | 'missing' | 'unknown';

/** Why Stripe cannot charge the market currency (details.stripe.reason_code). */
export type StripeCheckReason =
  | 'no_standard_account'
  | 'account_not_ready'
  | 'currency_not_supported_by_stripe'
  // The store's own Stripe key is a TEST key: no public card payments.
  | 'own_key_test_mode';

/** Why Kustom cannot charge the market currency (details.kustom.reason_code). */
export type KustomCheckReason = 'not_configured' | 'currency_not_supported';

export interface PaymentCheck {
  stripe: PaymentProviderCheck;
  kustom: PaymentProviderCheck;
  checked_at: string;
  details: {
    stripe?: {
      // 'OWN_KEY' when the store charges on its own Stripe key (no Connect
      // account checked); absent for the Connect account check.
      route?: 'OWN_KEY';
      account_id?: string;
      account_country?: string;
      charges_enabled?: boolean;
      card_payments?: string;
      currency_supported?: boolean;
      settlement_currency_supported?: boolean;
      reason_code?: StripeCheckReason;
    };
    kustom?: {
      configured: boolean;
      by_country: Record<string, 'ok' | 'mismatch' | 'unknown'>;
      expected_currency?: string;
      reason_code?: KustomCheckReason;
    };
  };
}

/**
 * The public shape of a LIVE market (proxy + storefront payloads). On a
 * market-preview host (`<slug>--<key>.<platform host>`) the route may be
 * DRAFT and carries `preview: true`; it is never listed in `markets`.
 */
export interface MarketRoute {
  key: string;
  name: string;
  default_locale: string;
  locales: string[];
  countries: string[];
  currency: string;
  is_default: boolean;
  primary_hostname: string | null;
  status: MarketStatus;
  /** M6.1: search indexing mode; the web proxy derives noindex / redirect. */
  indexing: MarketIndexing;
  /**
   * The owner's hreflang x-default market. Present (true) only on that one
   * market; absent everywhere else, so payloads of stores that never chose
   * one are unchanged. The web falls back to the default market when the
   * chosen one is not indexable.
   */
  is_x_default?: true;
  /**
   * M156: ACTIVE language-country paths, stored order. Absent when the
   * market has no active row, so payloads of every other market stay
   * byte-identical.
   */
  locale_paths?: MarketLocalePath[];
  preview?: true;
}

/** `GET /stores/by-domain/:host` — `market`/`markets` only with the app on. */
export interface StoreByDomainResponse {
  slug: string;
  redirect_to?: string;
  market?: MarketRoute;
  markets?: MarketRoute[];
  /**
   * Legacy `Store.custom_domain` (M6.1): the public host of the DEFAULT
   * market when it has no StoreDomain row of its own. Present (null when
   * unset) only with the app on; the web proxy / hreflang treat a default
   * AUTO market on it exactly like one with a `primary_hostname`.
   */
  custom_domain?: string | null;
  /**
   * Present only when the store has active redirects (M4.4 D17): the proxy
   * then loads `GET /stores/:slug/redirects?v=<version>` once per version.
   */
  redirects_version?: string;
}

/**
 * `GET /stores/:slug/market-context` (proxy, platform subdomains). With
 * `?market=<key>&preview=1` the named market answers (DRAFT too) and the
 * response is flagged `preview: true`.
 */
export type MarketContextResponse =
  | { enabled: false; redirects_version?: string }
  | {
      enabled: true;
      market: MarketRoute;
      markets: MarketRoute[];
      /** Legacy `Store.custom_domain` (see `StoreByDomainResponse`). */
      custom_domain: string | null;
      redirects_version?: string;
      preview?: true;
    };

export interface DomainView {
  id: string;
  hostname: string;
  is_primary: boolean;
  redirect_to: string | null;
  status: StoreDomainStatus;
  verified_at: string | null;
  /** expected_cname is null until the platform configures a DNS target. */
  dns: { expected_cname: string | null; observed: string[] | null };
}

/** `GET /markets` (creator dashboard). */
export interface MarketView {
  id: string;
  key: string;
  name: string;
  countries: string[];
  default_locale: string;
  locales: string[];
  currency: string;
  is_default: boolean;
  status: MarketStatus;
  /** M6.1: search indexing mode (AUTO | ALWAYS | NEVER). */
  indexing: MarketIndexing;
  /** hreflang x-default target; at most one market per store. */
  is_x_default: boolean;
  /** M156: every stored language-country path with its status; [] when unset. */
  locale_paths: MarketLocalePathView[];
  /** M157: null = the store's methods (default); otherwise the allowed subset, non-empty, sorted. */
  payment_methods: MarketPaymentMethod[] | null;
  price_rule: PriceRule;
  payment_check: PaymentCheck | null;
  /** Base → market rate in effect (null when it cannot be determined). */
  effective_rate: number | null;
  domains: DomainView[];
  /** `${slug}.${platform domain}` — always serves the default market. */
  platform_hostname: string;
  /**
   * `https://${slug}--${key}.${platform domain}`: serves this market before
   * its domain is connected (DRAFT included), checkout disabled. Null for
   * the default market (the platform subdomain already serves it).
   */
  preview_url: string | null;
}

export interface ProductMarketVariantPriceView {
  variant_id: string;
  label: string;
  auto_price: number | null;
  override: number | null;
}

export interface ProductMarketPriceView {
  market_id: string;
  key: string;
  name: string;
  currency: string;
  rate: number | null;
  available: boolean;
  auto_price: number | null;
  override: number | null;
  compare_at_auto: number | null;
  compare_at_override: number | null;
  variants: ProductMarketVariantPriceView[];
}

/** `GET /markets/products/:productId/prices`. */
export interface ProductMarketPricesView {
  base_currency: string;
  markets: ProductMarketPriceView[];
}

/** `GET /orders` rows carry this when the order was placed in a market. */
export interface OrderMarketRef {
  key: string;
  name: string;
  currency: string;
}

/** `POST /orders/quote` adds this when a market context applied. */
export interface QuoteMarketInfo {
  key: string;
  currency: string;
  rate: number | null;
}
