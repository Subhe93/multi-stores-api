import { KUSTOM_CURRENCIES } from './kustom.eligibility';

/**
 * Which currency Kustom (Klarna) charges in per purchase country. Kustom has
 * no API listing a merchant's enabled markets or currencies (the integration
 * only has order create/read/capture/refund), so the markets payment check
 * reasons from this static table: a market whose currency is the one Kustom
 * uses for each of its countries can be offered Kustom; a mismatch means the
 * checkout would fail after the order exists. A country missing here answers
 * `unknown` and the creator is told to confirm with Kustom support.
 */
export const KUSTOM_COUNTRY_CURRENCY: Readonly<Record<string, string>> = {
  SE: 'SEK',
  NO: 'NOK',
  DK: 'DKK',
  FI: 'EUR',
  DE: 'EUR',
  AT: 'EUR',
  NL: 'EUR',
  BE: 'EUR',
  FR: 'EUR',
  ES: 'EUR',
  IT: 'EUR',
  IE: 'EUR',
  PT: 'EUR',
  GB: 'GBP',
  US: 'USD',
  CH: 'CHF',
  PL: 'PLN',
  CZ: 'CZK',
  HU: 'HUF',
  RO: 'RON',
  AU: 'AUD',
  NZ: 'NZD',
  CA: 'CAD',
};

export type KustomCountryVerdict = 'ok' | 'mismatch' | 'unknown';

/** The currency Kustom charges in for a country, or null when not listed. */
export function kustomCurrencyForCountry(country: string): string | null {
  return KUSTOM_COUNTRY_CURRENCY[country.trim().toUpperCase()] ?? null;
}

export function isKustomMarketCurrency(currency: string): boolean {
  return KUSTOM_CURRENCIES.has(currency.trim().toUpperCase());
}

export interface KustomCountryMatrix {
  /** Overall verdict for the market (M1-DESIGN §3.6). */
  status: 'ok' | 'missing' | 'unknown';
  by_country: Record<string, KustomCountryVerdict>;
  /** The currency Kustom expects for the first mismatching country. */
  expected_currency?: string;
}

/**
 * Compare a market's currency with the table for each of its countries:
 * `ok` when every known country charges in this currency (and at least one
 * is known), `missing` when any known country charges in another currency
 * (`expected_currency` names it), `unknown` when no country is known.
 */
export function checkKustomCountries(
  countries: readonly string[],
  currency: string,
): KustomCountryMatrix {
  const wanted = currency.trim().toUpperCase();
  const by_country: Record<string, KustomCountryVerdict> = {};
  let known = 0;
  let expected: string | undefined;
  for (const raw of countries) {
    const country = raw.trim().toUpperCase();
    if (!country) continue;
    const table = kustomCurrencyForCountry(country);
    if (!table) {
      by_country[country] = 'unknown';
      continue;
    }
    known += 1;
    if (table === wanted) {
      by_country[country] = 'ok';
    } else {
      by_country[country] = 'mismatch';
      expected ??= table;
    }
  }
  if (expected)
    return { status: 'missing', by_country, expected_currency: expected };
  if (known === 0) return { status: 'unknown', by_country };
  return { status: 'ok', by_country };
}
