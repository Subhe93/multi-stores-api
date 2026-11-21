import type {
  MarketIndexing,
  MarketLocalePath,
  MarketPaymentMethod,
  MarketRoute,
  PriceRule,
} from './market.types';

/**
 * The one object every market-aware hook receives (storefront, cart, orders,
 * Kustom). Null everywhere the "markets" app is off, in which case the hook
 * site runs the pre-markets code path unchanged.
 */
export interface MarketContext {
  id: string;
  key: string;
  name: string;
  countries: string[];
  defaultLocale: string;
  /** Secondary locales (never contains defaultLocale). */
  locales: string[];
  /** Market currency, upper-case. */
  currency: string;
  /** resolveStoreCurrency(store): what base prices are stored in. */
  storeCurrency: string;
  /**
   * Effective base→market rate (1 when the currencies are equal). Null only
   * for a `fixed` price rule with no rate: products without an override are
   * then hidden and amounts stored in the base currency cannot be converted.
   */
  rate: number | null;
  priceRule: PriceRule;
  isDefault: boolean;
  status: 'DRAFT' | 'LIVE';
  /** M6.1: search indexing mode (the web proxy applies it; still routed). */
  indexing: MarketIndexing;
  /** The owner's hreflang x-default market (absent/false = not chosen). */
  isXDefault?: boolean;
  /**
   * M156: ACTIVE language-country paths, stored order (activity rule in
   * locale-paths.ts). `toContext` always sets it ([] = bare locale folders);
   * optional only so hand-built contexts (tests, fixtures) need not name it.
   */
  localePaths?: MarketLocalePath[];
  /**
   * M157: the payment methods this market allows (a subset of the store's),
   * or null = the store's methods. `toContext` always sets it (parsed
   * fail-closed: a malformed stored value reads as []); optional only so
   * hand-built contexts need not name it (undefined = unrestricted). Read
   * through marketAllowsMethod (payment-methods.ts). Never on MarketRoute.
   */
  paymentMethods?: MarketPaymentMethod[] | null;
  /** The ACTIVE primary StoreDomain host, else null (platform subdomain). */
  primaryHostname: string | null;
  /** Every ACTIVE hostname of the market (what a client may claim to be on). */
  hostnames: string[];
  /**
   * Resolved for a market-preview host (`resolve(..., { preview: true })`):
   * the market may be DRAFT and the checkout is view-only. Absent otherwise.
   */
  preview?: true;
}

export function toMarketRoute(ctx: MarketContext): MarketRoute {
  // A preview route carries the real status plus the flag; every other
  // route is LIVE by construction (resolve/listLive gate on it).
  if (ctx.preview) {
    return {
      key: ctx.key,
      name: ctx.name,
      default_locale: ctx.defaultLocale,
      locales: ctx.locales,
      countries: ctx.countries,
      currency: ctx.currency,
      is_default: ctx.isDefault,
      primary_hostname: ctx.primaryHostname,
      status: ctx.status,
      indexing: ctx.indexing,
      ...(ctx.isXDefault ? { is_x_default: true as const } : {}),
      ...(ctx.localePaths?.length ? { locale_paths: ctx.localePaths } : {}),
      preview: true,
    };
  }
  return {
    key: ctx.key,
    name: ctx.name,
    default_locale: ctx.defaultLocale,
    locales: ctx.locales,
    countries: ctx.countries,
    currency: ctx.currency,
    is_default: ctx.isDefault,
    primary_hostname: ctx.primaryHostname,
    status: 'LIVE',
    indexing: ctx.indexing,
    ...(ctx.isXDefault ? { is_x_default: true as const } : {}),
    ...(ctx.localePaths?.length ? { locale_paths: ctx.localePaths } : {}),
  };
}
