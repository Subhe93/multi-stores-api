import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  activeLocalePaths,
  derivePath,
  isKnownLanguage,
  localePathStatus,
  localePathViews,
  normalizeLocalePaths,
  parseLocalePaths,
  primaryLocalePath,
} from './locale-paths';
import { CreateMarketDto, UpdateMarketDto } from './dto/market.dto';

const EU_COUNTRIES = [
  'DE',
  'FI',
  'AT',
  'NL',
  'BE',
  'FR',
  'ES',
  'IT',
  'IE',
  'PT',
];
const EU = { defaultLocale: 'en', countries: EU_COUNTRIES };
const NAMEZ = [
  { path: 'de-de', locale: 'de', country: 'DE', hreflang: ['de-DE', 'de'] },
  { path: 'de-at', locale: 'de', country: 'AT', hreflang: ['de-AT'] },
  { path: 'fr-fr', locale: 'fr', country: 'FR', hreflang: ['fr-FR', 'fr'] },
  { path: 'fr-be', locale: 'fr', country: 'BE', hreflang: ['fr-BE'] },
  { path: 'nl-nl', locale: 'nl', country: 'NL', hreflang: ['nl-NL', 'nl'] },
  { path: 'nl-be', locale: 'nl', country: 'BE', hreflang: ['nl-BE'] },
  { path: 'ar', locale: 'ar', country: null, hreflang: ['ar'] },
];

function errorOf(fn: () => unknown): { code: string; index: number } {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    const r = (err as BadRequestException).getResponse() as {
      code: string;
      index: number;
      message: string;
    };
    expect(typeof r.message).toBe('string');
    return { code: r.code, index: r.index };
  }
  throw new Error('expected a 400');
}

const row = (over: Record<string, unknown> = {}) => ({
  path: 'de-at',
  locale: 'de',
  country: 'AT',
  hreflang: ['de-AT'],
  ...over,
});

describe('normalizeLocalePaths (M156)', () => {
  it('accepts the Namez eu config unchanged (nl rows included)', () => {
    expect(normalizeLocalePaths(NAMEZ, EU)).toEqual(NAMEZ);
  });

  it('null, undefined and [] clear the column', () => {
    expect(normalizeLocalePaths(null, EU)).toBeNull();
    expect(normalizeLocalePaths(undefined, EU)).toBeNull();
    expect(normalizeLocalePaths([], EU)).toBeNull();
  });

  it('normalises case, a missing country and duplicate hreflang codes', () => {
    expect(
      normalizeLocalePaths(
        [
          {
            path: 'DE-AT',
            locale: 'DE',
            country: 'at',
            hreflang: ['de-at', 'DE-AT', 'De'],
          },
          { path: 'ar', locale: 'ar', hreflang: ['AR', 'ar'] },
        ],
        { defaultLocale: 'EN', countries: ['at'] },
      ),
    ).toEqual([
      { path: 'de-at', locale: 'de', country: 'AT', hreflang: ['de-AT', 'de'] },
      { path: 'ar', locale: 'ar', country: null, hreflang: ['ar'] },
    ]);
  });

  it.each([
    ['not an object', 'de-at'],
    ['array row', ['de-at']],
    ['bad path', row({ path: 'de_at' })],
    ['three-letter path', row({ path: 'deu' })],
    ['bad locale', row({ locale: 'deu' })],
    ['bad country', row({ country: 'AUT' })],
    ['country not a string', row({ country: 1 })],
    ['no hreflang', row({ hreflang: [] })],
    ['hreflang not a list', row({ hreflang: 'de-AT' })],
    ['bad hreflang code', row({ hreflang: ['de_AT'] })],
    [
      'too many hreflang codes',
      row({ hreflang: ['de-AT', 'de', 'x', 'y', 'z'] }),
    ],
  ])('rule 1 shape: %s → MARKET_LOCALE_PATH_INVALID', (_l, bad) => {
    expect(errorOf(() => normalizeLocalePaths([NAMEZ[0], bad], EU))).toEqual({
      code: 'MARKET_LOCALE_PATH_INVALID',
      index: 1,
    });
  });

  it('rule 1: more than 50 rows', () => {
    const many = Array.from({ length: 51 }, () => NAMEZ[6]);
    expect(errorOf(() => normalizeLocalePaths(many, EU)).code).toBe(
      'MARKET_LOCALE_PATH_INVALID',
    );
  });

  it('rule 2: an unknown language is refused; a real non-storefront one is not', () => {
    expect(
      errorOf(() =>
        normalizeLocalePaths(
          [row({ path: 'xx-at', locale: 'xx', hreflang: ['xx-AT'] })],
          EU,
        ),
      ),
    ).toEqual({ code: 'MARKET_LOCALE_PATH_LANGUAGE_UNKNOWN', index: 0 });
    expect(isKnownLanguage('nl')).toBe(true);
    expect(isKnownLanguage('de')).toBe(true);
    expect(isKnownLanguage('zz')).toBe(false);
    expect(isKnownLanguage('deu')).toBe(false);
  });

  it('rule 3: the default locale has no path', () => {
    expect(
      errorOf(() =>
        normalizeLocalePaths(
          [NAMEZ[0], row({ path: 'en-at', locale: 'en', hreflang: ['en-AT'] })],
          EU,
        ),
      ),
    ).toEqual({ code: 'MARKET_LOCALE_PATH_DEFAULT_LOCALE', index: 1 });
  });

  it.each([
    ['country path for another country', row({ path: 'de-de' })],
    ['plain path on a country row', row({ path: 'de' })],
    [
      '2-letter path of another language',
      { path: 'fr', locale: 'ar', country: null, hreflang: ['ar'] },
    ],
    [
      'country path on a language-only row',
      { path: 'ar-de', locale: 'ar', country: null, hreflang: ['ar'] },
    ],
  ])('rule 4: %s → MARKET_LOCALE_PATH_MISMATCH', (_l, bad) => {
    expect(errorOf(() => normalizeLocalePaths([bad], EU))).toEqual({
      code: 'MARKET_LOCALE_PATH_MISMATCH',
      index: 0,
    });
  });

  it('rule 5: the country must be one of the market countries', () => {
    expect(
      errorOf(() =>
        normalizeLocalePaths(
          [row({ path: 'de-ch', country: 'CH', hreflang: ['de-CH'] })],
          EU,
        ),
      ),
    ).toEqual({ code: 'MARKET_LOCALE_PATH_COUNTRY', index: 0 });
    // A market without countries can only have language-only rows.
    expect(
      errorOf(() =>
        normalizeLocalePaths([NAMEZ[0]], {
          defaultLocale: 'sv',
          countries: [],
        }),
      ).code,
    ).toBe('MARKET_LOCALE_PATH_COUNTRY');
    expect(
      normalizeLocalePaths([NAMEZ[6]], { defaultLocale: 'sv', countries: [] }),
    ).toEqual([NAMEZ[6]]);
  });

  it('rule 6: duplicate paths', () => {
    expect(
      errorOf(() => normalizeLocalePaths([NAMEZ[1], NAMEZ[0], NAMEZ[1]], EU)),
    ).toEqual({ code: 'MARKET_LOCALE_PATH_DUPLICATE', index: 2 });
  });

  it.each([
    ['wrong language', row({ hreflang: ['de-AT', 'fr'] })],
    ['wrong region', row({ hreflang: ['de-AT', 'de-DE'] })],
    [
      'region on a language-only row',
      { path: 'ar', locale: 'ar', country: null, hreflang: ['ar-DE'] },
    ],
    ['plain code first on a country row', row({ hreflang: ['de', 'de-AT'] })],
  ])('rule 7: %s → MARKET_LOCALE_PATH_HREFLANG', (_l, bad) => {
    expect(errorOf(() => normalizeLocalePaths([bad], EU))).toEqual({
      code: 'MARKET_LOCALE_PATH_HREFLANG',
      index: 0,
    });
  });

  it('rule 8: one hreflang code points at one URL only', () => {
    expect(
      errorOf(() =>
        normalizeLocalePaths(
          [NAMEZ[0], row({ hreflang: ['de-AT', 'de'] })],
          EU,
        ),
      ),
    ).toEqual({ code: 'MARKET_LOCALE_PATH_HREFLANG', index: 1 });
    // A language-only row and a country row cannot both claim `ar`.
    expect(
      errorOf(() =>
        normalizeLocalePaths(
          [
            NAMEZ[6],
            {
              path: 'ar-de',
              locale: 'ar',
              country: 'DE',
              hreflang: ['ar-DE', 'ar'],
            },
          ],
          EU,
        ),
      ),
    ).toEqual({ code: 'MARKET_LOCALE_PATH_HREFLANG', index: 1 });
  });
});

describe('activity rule and views (M156)', () => {
  const eu = { locales: ['de', 'fr', 'ar'], countries: EU_COUNTRIES };

  it('nl rows are stored but locale_unsupported; the rest are active', () => {
    const views = localePathViews(NAMEZ, eu);
    expect(views.map((v) => [v.path, v.active, v.inactive_reason])).toEqual([
      ['de-de', true, null],
      ['de-at', true, null],
      ['fr-fr', true, null],
      ['fr-be', true, null],
      ['nl-nl', false, 'locale_unsupported'],
      ['nl-be', false, 'locale_unsupported'],
      ['ar', true, null],
    ]);
    expect(activeLocalePaths(NAMEZ, eu).map((r) => r.path)).toEqual([
      'de-de',
      'de-at',
      'fr-fr',
      'fr-be',
      'ar',
    ]);
  });

  it('reasons in rule order: unsupported, not enabled, country removed', () => {
    const m = { locales: ['de'], countries: ['DE'] };
    expect(localePathStatus({ locale: 'nl', country: 'XX' }, m)).toBe(
      'locale_unsupported',
    );
    expect(localePathStatus({ locale: 'fr', country: 'XX' }, m)).toBe(
      'locale_not_enabled',
    );
    expect(localePathStatus({ locale: 'de', country: 'AT' }, m)).toBe(
      'country_not_in_market',
    );
    expect(localePathStatus({ locale: 'de', country: null }, m)).toBeNull();
  });

  it('primary path: language-only row, else the plain hreflang, else the first', () => {
    const active = activeLocalePaths(NAMEZ, eu);
    expect(primaryLocalePath(active, 'de')?.path).toBe('de-de');
    expect(primaryLocalePath(active, 'fr')?.path).toBe('fr-fr');
    expect(primaryLocalePath(active, 'ar')?.path).toBe('ar');
    expect(primaryLocalePath(active, 'sv')).toBeNull();
    const noPlain = [NAMEZ[1], { ...NAMEZ[0], hreflang: ['de-DE'] }];
    expect(primaryLocalePath(noPlain, 'de')?.path).toBe('de-at');
    const withOnly = [
      NAMEZ[0],
      { path: 'de', locale: 'de', country: null, hreflang: ['de'] },
    ];
    expect(primaryLocalePath(withOnly, 'de')?.path).toBe('de');
  });

  it('derivePath', () => {
    expect(derivePath('de', 'AT')).toBe('de-at');
    expect(derivePath('ar', null)).toBe('ar');
  });
});

describe('parseLocalePaths (stored JSON, defensive)', () => {
  it('reads the stored rows back', () => {
    expect(parseLocalePaths(NAMEZ)).toEqual(NAMEZ);
  });

  it('drops malformed rows and never throws', () => {
    expect(parseLocalePaths(null)).toEqual([]);
    expect(parseLocalePaths({ path: 'de-de' })).toEqual([]);
    expect(parseLocalePaths('x')).toEqual([]);
    expect(
      parseLocalePaths([
        null,
        'de-de',
        { path: 'de-de', locale: 'de', country: 'AT', hreflang: ['de-AT'] },
        { path: 'DE-AT', locale: 'de', country: 'AT', hreflang: ['de-AT'] },
        { path: 'de-at', locale: 'de', country: 'AT', hreflang: [] },
        { path: 'de-at', locale: 'de', country: 'AT', hreflang: [1, 'de-AT'] },
        { path: 'de-at', locale: 'de', country: 'AT', hreflang: ['de-AT'] },
      ]),
    ).toEqual([
      { path: 'de-at', locale: 'de', country: 'AT', hreflang: ['de-AT'] },
    ]);
  });
});

describe('Market DTO locale_paths (M156)', () => {
  async function errorsFor(
    cls: typeof CreateMarketDto | typeof UpdateMarketDto,
    body: Record<string, unknown>,
  ) {
    const errors = await validate(plainToInstance(cls, body), {
      skipMissingProperties: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    return errors.map((e) => e.property);
  }

  it.each([CreateMarketDto, UpdateMarketDto])(
    '%p accepts the Namez rows, null and []',
    async (cls) => {
      expect(await errorsFor(cls, { locale_paths: NAMEZ })).toEqual([]);
      expect(await errorsFor(cls, { locale_paths: null })).toEqual([]);
      expect(await errorsFor(cls, { locale_paths: [] })).toEqual([]);
      expect(await errorsFor(cls, {})).toEqual([]);
    },
  );

  it.each([CreateMarketDto, UpdateMarketDto])(
    '%p refuses malformed rows',
    async (cls) => {
      for (const bad of [
        'de-at',
        [row({ path: 'DE-AT' })],
        [row({ locale: 'deu' })],
        [row({ country: 'AUT' })],
        [row({ hreflang: [] })],
        [row({ hreflang: ['de_AT'] })],
        [row({ extra: true })],
        Array.from({ length: 51 }, () => row()),
      ]) {
        expect(await errorsFor(cls, { locale_paths: bad })).toEqual([
          'locale_paths',
        ]);
      }
    },
  );
});

describe('migration 20261202120000_market_locale_paths', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '../../../prisma/migrations/20261202120000_market_locale_paths/migration.sql',
    ),
    'utf8',
  );

  it('adds one nullable JSONB column, nothing else', () => {
    const statements = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--') && l.trim())
      .join('\n');
    expect(statements.trim()).toBe(
      'ALTER TABLE "Market" ADD COLUMN IF NOT EXISTS "locale_paths" JSONB;',
    );
    expect(statements).not.toMatch(
      /\bDROP\b|\bUPDATE\s+"|\bDEFAULT\b|NOT NULL/i,
    );
  });
});
