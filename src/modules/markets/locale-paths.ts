import { BadRequestException } from '@nestjs/common';
import {
  SUPPORTED_LOCALES,
  type MarketLocalePath,
  type MarketLocalePathInactiveReason,
  type MarketLocalePathView,
} from './market.types';

// M156: optional language-country URL paths per market (/de-de/, /de-at/).
// Pure helpers (no I/O): write-time validation, defensive parsing of the
// stored JSON, and the activity rule shared with the web and the dashboard.

export const LOCALE_PATH_SEGMENT_RE = /^[a-z]{2}(?:-[a-z]{2})?$/;
/** A first URL segment shaped like a country path (`de-at`). */
export const COUNTRY_PATH_SEGMENT_RE = /^[a-z]{2}-[a-z]{2}$/;
export const MAX_LOCALE_PATHS = 50;
export const MAX_HREFLANG_PER_PATH = 4;

const LOCALE_RE = /^[a-z]{2}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const HREFLANG_RE = /^([a-z]{2})(?:-([a-z]{2}))?$/i;

export type MarketLocalePathErrorCode =
  | 'MARKET_LOCALE_PATH_INVALID'
  | 'MARKET_LOCALE_PATH_LANGUAGE_UNKNOWN'
  | 'MARKET_LOCALE_PATH_DEFAULT_LOCALE'
  | 'MARKET_LOCALE_PATH_MISMATCH'
  | 'MARKET_LOCALE_PATH_COUNTRY'
  | 'MARKET_LOCALE_PATH_DUPLICATE'
  | 'MARKET_LOCALE_PATH_HREFLANG';

/** The market values the activity rule reads. */
export interface LocalePathMarket {
  /** Secondary locales (the default is never in here). */
  locales: readonly string[];
  countries: readonly string[];
}

// ISO 639-1 codes: the fallback when the runtime has no Intl language data.
const ISO_639_1 = new Set(
  (
    'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ' +
    'ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr ' +
    'fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is ' +
    'it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln ' +
    'lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ' +
    'ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk ' +
    'sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ' +
    'ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'
  ).split(' '),
);

let languageNames: Intl.DisplayNames | null | undefined;

function intlLanguageNames(): Intl.DisplayNames | null {
  if (languageNames !== undefined) return languageNames;
  try {
    const names = new Intl.DisplayNames(['en'], {
      type: 'language',
      fallback: 'code',
    });
    // A runtime without language data answers every code with itself.
    languageNames = names.of('de') !== 'de' ? names : null;
  } catch {
    languageNames = null;
  }
  return languageNames;
}

/**
 * True for a real ISO 639-1 language (`de`, `nl`), false for `xx`. It does
 * not have to be a storefront locale: a row for a language the storefront
 * cannot render yet is stored and stays inactive.
 */
export function isKnownLanguage(code: string): boolean {
  if (!LOCALE_RE.test(code)) return false;
  const names = intlLanguageNames();
  if (names) {
    try {
      return names.of(code) !== code;
    } catch {
      return false;
    }
  }
  return ISO_639_1.has(code);
}

/** The path a (locale, country) row must have (API rule 4). */
export function derivePath(locale: string, country: string | null): string {
  return country ? `${locale}-${country.toLowerCase()}` : locale;
}

function fail(
  code: MarketLocalePathErrorCode,
  index: number,
  message: string,
): never {
  throw new BadRequestException({ code, message, index });
}

/** `de` / `de-at` / `DE-at` → `de` / `de-AT`; null when malformed. */
function normalizeHreflang(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = HREFLANG_RE.exec(raw.trim());
  if (!m) return null;
  const lang = m[1].toLowerCase();
  return m[2] ? `${lang}-${m[2].toUpperCase()}` : lang;
}

/**
 * Validate and normalise the `locale_paths` of a create / update body.
 * `defaultLocale` and `countries` are the EFFECTIVE values (the body's,
 * else the stored row's). Returns null for null / [] (the column is then
 * cleared: today's bare /<locale>/ folders). Every failure is a 400
 * `{ code, message, index }`, `index` being the offending row.
 */
export function normalizeLocalePaths(
  rows: readonly unknown[] | null | undefined,
  market: {
    defaultLocale: string | null | undefined;
    countries: readonly string[];
  },
): MarketLocalePath[] | null {
  if (rows == null) return null;
  if (!Array.isArray(rows)) {
    fail('MARKET_LOCALE_PATH_INVALID', 0, 'locale_paths must be a list');
  }
  if (!rows.length) return null;
  if (rows.length > MAX_LOCALE_PATHS) {
    fail(
      'MARKET_LOCALE_PATH_INVALID',
      MAX_LOCALE_PATHS,
      `At most ${MAX_LOCALE_PATHS} language-country URLs per market`,
    );
  }
  const defaultLocale = market.defaultLocale?.trim().toLowerCase() || null;
  const countries = new Set(market.countries.map((c) => c.toUpperCase()));
  const out: MarketLocalePath[] = [];
  const paths = new Set<string>();
  const pairs = new Set<string>();
  const codes = new Map<string, number>();

  rows.forEach((raw, index) => {
    // Rule 1: shape.
    const r = (raw ?? null) as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      fail('MARKET_LOCALE_PATH_INVALID', index, 'Each row must be an object');
    }
    const path =
      typeof r.path === 'string' ? r.path.trim().toLowerCase() : null;
    const locale =
      typeof r.locale === 'string' ? r.locale.trim().toLowerCase() : null;
    const countryRaw = r.country;
    const country =
      countryRaw == null || countryRaw === ''
        ? null
        : typeof countryRaw === 'string'
          ? countryRaw.trim().toUpperCase()
          : undefined;
    const hreflangRaw = Array.isArray(r.hreflang) ? r.hreflang : null;
    const hreflang = hreflangRaw?.map(normalizeHreflang) ?? null;
    if (
      !path ||
      !LOCALE_PATH_SEGMENT_RE.test(path) ||
      !locale ||
      !LOCALE_RE.test(locale) ||
      country === undefined ||
      (country !== null && !COUNTRY_RE.test(country)) ||
      !hreflang ||
      !hreflang.length ||
      hreflang.length > MAX_HREFLANG_PER_PATH ||
      hreflang.some((c) => c === null)
    ) {
      fail(
        'MARKET_LOCALE_PATH_INVALID',
        index,
        'Each row needs a path, a language, an optional country and 1-4 hreflang codes',
      );
    }
    // Rule 2: a real language (not necessarily a storefront locale yet).
    if (!isKnownLanguage(locale)) {
      fail(
        'MARKET_LOCALE_PATH_LANGUAGE_UNKNOWN',
        index,
        `"${locale}" is not a known language code`,
      );
    }
    // Rule 3: the root serves the default locale.
    if (defaultLocale && locale === defaultLocale) {
      fail(
        'MARKET_LOCALE_PATH_DEFAULT_LOCALE',
        index,
        `"${locale}" is the market's default language; it is served at the root`,
      );
    }
    // Rule 4: the path says what the row serves.
    const expected = derivePath(locale, country);
    if (path !== expected) {
      fail(
        'MARKET_LOCALE_PATH_MISMATCH',
        index,
        `The path for this row must be "${expected}"`,
      );
    }
    // Rule 5: the country belongs to the market.
    if (country !== null && !countries.has(country)) {
      fail(
        'MARKET_LOCALE_PATH_COUNTRY',
        index,
        `Country "${country}" is not one of the market's countries`,
      );
    }
    // Rule 6: unique path and (locale, country).
    const pair = `${locale}|${country ?? ''}`;
    if (paths.has(path) || pairs.has(pair)) {
      fail(
        'MARKET_LOCALE_PATH_DUPLICATE',
        index,
        `The URL "/${path}/" is listed more than once`,
      );
    }
    paths.add(path);
    pairs.add(pair);
    // Rule 7: every code names this row's language (and country).
    const unique = Array.from(new Set(hreflang as string[]));
    for (const code of unique) {
      const [lang, region] = code.split('-');
      if (lang !== locale || (region ?? null) !== (region ? country : null)) {
        fail(
          'MARKET_LOCALE_PATH_HREFLANG',
          index,
          `hreflang "${code}" does not match this row's language and country`,
        );
      }
    }
    if (country !== null && unique[0] !== `${locale}-${country}`) {
      fail(
        'MARKET_LOCALE_PATH_HREFLANG',
        index,
        `The first hreflang code of this row must be "${locale}-${country}"`,
      );
    }
    // Rule 8: one URL per hreflang code.
    for (const code of unique) {
      if (codes.has(code)) {
        fail(
          'MARKET_LOCALE_PATH_HREFLANG',
          index,
          `hreflang "${code}" is already used by row ${codes.get(code)! + 1}`,
        );
      }
      codes.set(code, index);
    }
    out.push({ path, locale, country, hreflang: unique });
  });
  return out;
}

/**
 * Read the stored JSON defensively: rows that are not well-formed (shape
 * and the path rule) are dropped, never thrown. Null / not a list → [].
 */
export function parseLocalePaths(value: unknown): MarketLocalePath[] {
  if (!Array.isArray(value)) return [];
  const out: MarketLocalePath[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const path = typeof r.path === 'string' ? r.path : '';
    const locale = typeof r.locale === 'string' ? r.locale : '';
    const country =
      r.country == null ? null : typeof r.country === 'string' ? r.country : '';
    if (
      !LOCALE_PATH_SEGMENT_RE.test(path) ||
      !LOCALE_RE.test(locale) ||
      (country !== null && !COUNTRY_RE.test(country)) ||
      path !== derivePath(locale, country) ||
      seen.has(path)
    ) {
      continue;
    }
    const hreflang = Array.isArray(r.hreflang)
      ? Array.from(
          new Set(
            r.hreflang.filter(
              (c): c is string => typeof c === 'string' && HREFLANG_RE.test(c),
            ),
          ),
        )
      : [];
    if (!hreflang.length) continue;
    seen.add(path);
    out.push({ path, locale, country, hreflang });
  }
  return out;
}

/**
 * Activity rule (identical in api / web / dashboard): the first failing
 * condition, or null when the row is active.
 */
export function localePathStatus(
  row: Pick<MarketLocalePath, 'locale' | 'country'>,
  market: LocalePathMarket,
): MarketLocalePathInactiveReason | null {
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(row.locale)) {
    return 'locale_unsupported';
  }
  if (!market.locales.includes(row.locale)) return 'locale_not_enabled';
  if (row.country !== null && !market.countries.includes(row.country)) {
    return 'country_not_in_market';
  }
  return null;
}

/** Active rows only, stored order ([] = the market keeps bare folders). */
export function activeLocalePaths(
  rows: readonly MarketLocalePath[],
  market: LocalePathMarket,
): MarketLocalePath[] {
  return rows.filter((r) => localePathStatus(r, market) === null);
}

/** Every stored row plus its status (the dashboard view). */
export function localePathViews(
  rows: readonly MarketLocalePath[],
  market: LocalePathMarket,
): MarketLocalePathView[] {
  return rows.map((r) => {
    const reason = localePathStatus(r, market);
    return {
      path: r.path,
      locale: r.locale,
      country: r.country,
      hreflang: [...r.hreflang],
      active: reason === null,
      inactive_reason: reason,
    };
  });
}

/**
 * Primary path of a locale among ACTIVE rows: the language-only row, else
 * the row whose hreflang has the plain code, else the first in stored order.
 */
export function primaryLocalePath(
  activeRows: readonly MarketLocalePath[],
  locale: string,
): MarketLocalePath | null {
  const own = activeRows.filter((r) => r.locale === locale);
  return (
    own.find((r) => r.country === null) ??
    own.find((r) => r.hreflang.includes(locale)) ??
    own[0] ??
    null
  );
}
