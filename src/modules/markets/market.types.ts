// Mirror of multi-stores-shared/src/types/market.ts — keep in sync.

export type MarketStatus = 'DRAFT' | 'LIVE';
export type StoreDomainStatus = 'PENDING' | 'VERIFIED' | 'ACTIVE';

/** Locales the storefront can render (its `locales` list). */
export const SUPPORTED_LOCALES = ['en', 'ar', 'tr', 'de', 'fr', 'sv'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

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
  | 'currency_not_supported_by_stripe';

/** Why Kustom cannot charge the market currency (details.kustom.reason_code). */
export type KustomCheckReason = 'not_configured' | 'currency_not_supported';

export interface PaymentCheck {
  stripe: PaymentProviderCheck;
  kustom: PaymentProviderCheck;
  checked_at: string;
  details: {
    stripe?: {
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
  preview?: true;
}

/** `GET /stores/by-domain/:host` — `market`/`markets` only with the app on. */
export interface StoreByDomainResponse {
  slug: string;
  redirect_to?: string;
  market?: MarketRoute;
  markets?: MarketRoute[];
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
