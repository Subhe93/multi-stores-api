import type { MarketRoute, PriceRule } from './market.types';

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
  /** M6: robots noindex for this market (the web applies it; still routed). */
  noindex: boolean;
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
      noindex: ctx.noindex,
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
    noindex: ctx.noindex,
  };
}
