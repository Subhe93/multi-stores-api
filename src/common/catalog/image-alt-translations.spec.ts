import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  IMAGE_ALT_MAX,
  IMAGE_ALT_MAX_LOCALES,
  altTranslationsColumn,
  normalizeAltTranslations,
  prepareImageAltTranslations,
  publicImage,
  readAltTranslations,
  swapPrimaryAlt,
} from './image-alt-translations';

// M170 A: per-locale alt text of a product image (ProductImage.alt_translations).

function coded(fn: () => unknown): Record<string, unknown> {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as Record<string, unknown>;
  }
  throw new Error('expected a BadRequestException');
}

describe('normalizeAltTranslations', () => {
  it('keeps valid locales, trims and collapses whitespace', () => {
    expect(
      normalizeAltTranslations(
        { de: '  Rotes   Dalapferd\n aus Holz ', 'de-AT': 'Rotes Pferd' },
        'sv',
      ),
    ).toEqual({ de: 'Rotes Dalapferd aus Holz', 'de-AT': 'Rotes Pferd' });
  });

  it('drops empty values; an empty map, null and undefined are null', () => {
    expect(normalizeAltTranslations({ de: '   ', en: 'Horse' }, 'sv')).toEqual({
      en: 'Horse',
    });
    expect(normalizeAltTranslations({ de: '' }, 'sv')).toBeNull();
    expect(normalizeAltTranslations({}, 'sv')).toBeNull();
    expect(normalizeAltTranslations(null, 'sv')).toBeNull();
    expect(normalizeAltTranslations(undefined, 'sv')).toBeNull();
  });

  it('drops the store primary-locale key (alt_text is its only source)', () => {
    expect(
      normalizeAltTranslations({ sv: 'Röd dalahäst', de: 'Pferd' }, 'sv'),
    ).toEqual({ de: 'Pferd' });
    expect(normalizeAltTranslations({ sv: 'Röd dalahäst' }, 'sv')).toBeNull();
    // A regional variant of the primary language is its own locale.
    expect(normalizeAltTranslations({ 'sv-FI': 'Häst' }, 'sv')).toEqual({
      'sv-FI': 'Häst',
    });
  });

  it.each([
    ['an array', ['de']],
    ['a string', 'de'],
    ['a number', 5],
  ])('refuses %s', (_name, input) => {
    expect(coded(() => normalizeAltTranslations(input, 'sv'))).toMatchObject({
      code: 'PRODUCT_IMAGE_ALT_INVALID',
      fields: ['images'],
    });
  });

  it.each(['DE', 'deu', 'de_AT', 'de-at', '__proto__', ''])(
    'refuses the locale key %p',
    (key) => {
      const input = JSON.parse(`{${JSON.stringify(key)}: "x"}`) as unknown;
      expect(coded(() => normalizeAltTranslations(input, 'sv')).code).toBe(
        'PRODUCT_IMAGE_ALT_INVALID',
      );
    },
  );

  it('refuses a non-string value', () => {
    expect(coded(() => normalizeAltTranslations({ de: 5 }, 'sv')).code).toBe(
      'PRODUCT_IMAGE_ALT_INVALID',
    );
    expect(coded(() => normalizeAltTranslations({ de: null }, 'sv')).code).toBe(
      'PRODUCT_IMAGE_ALT_INVALID',
    );
  });

  it('accepts exactly the max length and refuses one more', () => {
    expect(
      normalizeAltTranslations({ de: 'x'.repeat(IMAGE_ALT_MAX) }, 'sv'),
    ).toEqual({ de: 'x'.repeat(IMAGE_ALT_MAX) });
    expect(
      coded(() =>
        normalizeAltTranslations({ de: 'x'.repeat(IMAGE_ALT_MAX + 1) }, 'sv'),
      ).code,
    ).toBe('PRODUCT_IMAGE_ALT_INVALID');
    // The limit applies to the primary-locale key too (fails, never hidden).
    expect(
      coded(() =>
        normalizeAltTranslations({ sv: 'x'.repeat(IMAGE_ALT_MAX + 1) }, 'sv'),
      ).code,
    ).toBe('PRODUCT_IMAGE_ALT_INVALID');
  });

  it('refuses more locales than the limit', () => {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const many = Object.fromEntries(
      Array.from({ length: IMAGE_ALT_MAX_LOCALES + 1 }, (_, i) => [
        `a${letters[i]}`,
        'x',
      ]),
    );
    expect(coded(() => normalizeAltTranslations(many, 'sv')).code).toBe(
      'PRODUCT_IMAGE_ALT_INVALID',
    );
    const ok = Object.fromEntries(Object.entries(many).slice(1));
    expect(Object.keys(normalizeAltTranslations(ok, 'sv') ?? {})).toHaveLength(
      IMAGE_ALT_MAX_LOCALES,
    );
  });
});

describe('readAltTranslations', () => {
  it('keeps non-empty strings only and never throws', () => {
    expect(readAltTranslations({ de: 'Pferd', en: 5, fr: '' })).toEqual({
      de: 'Pferd',
    });
    expect(readAltTranslations(null)).toBeNull();
    expect(readAltTranslations('x')).toBeNull();
    expect(readAltTranslations([])).toBeNull();
    expect(readAltTranslations({})).toBeNull();
  });
});

describe('prepareImageAltTranslations', () => {
  const stored = [
    { url: '/a.webp', alt_translations: { de: 'A-de' } },
    { url: '/b.webp', alt_translations: null },
    { url: '/c.webp', alt_translations: { de: 'C-de', en: 'C-en' } },
  ];

  it('undefined carries the stored map of the same url (older clients)', () => {
    expect(
      prepareImageAltTranslations(
        [{ url: '/c.webp' }, { url: '/a.webp' }, { url: '/b.webp' }],
        stored,
        'sv',
      ),
    ).toEqual([{ de: 'C-de', en: 'C-en' }, { de: 'A-de' }, null]);
  });

  it('null and {} clear; a sent map replaces the stored one', () => {
    expect(
      prepareImageAltTranslations(
        [
          { url: '/a.webp', alt_translations: null },
          { url: '/c.webp', alt_translations: {} },
          { url: '/b.webp', alt_translations: { en: ' B-en ' } },
        ],
        stored,
        'sv',
      ),
    ).toEqual([null, null, { en: 'B-en' }]);
  });

  it('a replaced image (new url) starts without a map', () => {
    expect(
      prepareImageAltTranslations([{ url: '/new.webp' }], stored, 'sv'),
    ).toEqual([null]);
  });

  it('the same url twice gets the same carried map', () => {
    expect(
      prepareImageAltTranslations(
        [{ url: '/a.webp' }, { url: '/a.webp' }],
        stored,
        'sv',
      ),
    ).toEqual([{ de: 'A-de' }, { de: 'A-de' }]);
  });

  it('an invalid map fails the whole list', () => {
    expect(
      coded(() =>
        prepareImageAltTranslations(
          [{ url: '/a.webp' }, { url: '/b.webp', alt_translations: { XX: 1 } }],
          stored,
          'sv',
        ),
      ).code,
    ).toBe('PRODUCT_IMAGE_ALT_INVALID');
  });
});

describe('altTranslationsColumn', () => {
  it('maps no map to SQL NULL and keeps a map', () => {
    expect(altTranslationsColumn(null)).toBe(Prisma.DbNull);
    expect(altTranslationsColumn(undefined)).toBe(Prisma.DbNull);
    expect(altTranslationsColumn({})).toBe(Prisma.DbNull);
    expect(altTranslationsColumn({ de: 'Pferd' })).toEqual({ de: 'Pferd' });
  });
});

describe('publicImage', () => {
  it('removes the key when the image has no map (same keys as before)', () => {
    const row: Record<string, unknown> = {
      id: 'i1',
      url: '/a.webp',
      alt_text: null,
      sort_order: 0,
    };
    expect(publicImage({ ...row, alt_translations: null })).toEqual(row);
    expect(publicImage({ ...row, alt_translations: {} })).toEqual(row);
    expect(publicImage(row)).toEqual(row);
    expect(
      Object.keys(publicImage({ ...row, alt_translations: null })),
    ).toEqual(Object.keys(row));
  });

  it('keeps a map', () => {
    expect(
      publicImage({ url: '/a.webp', alt_translations: { de: 'Pferd' } }),
    ).toEqual({ url: '/a.webp', alt_translations: { de: 'Pferd' } });
  });
});

describe('swapPrimaryAlt (store primary language changed)', () => {
  it('promotes the alt of the new primary language and keeps the old default under the old language', () => {
    expect(
      swapPrimaryAlt(
        {
          alt_text: 'Röd dalahäst',
          alt_translations: { en: 'Red horse', de: 'Rotes Pferd' },
        },
        'sv',
        'en',
      ),
    ).toEqual({
      alt_text: 'Red horse',
      alt_translations: { de: 'Rotes Pferd', sv: 'Röd dalahäst' },
    });
  });

  it('leaves an image without an alt for the new primary language alone', () => {
    expect(
      swapPrimaryAlt(
        { alt_text: 'Röd dalahäst', alt_translations: { de: 'Rotes Pferd' } },
        'sv',
        'en',
      ),
    ).toBeNull();
    expect(
      swapPrimaryAlt({ alt_text: 'x', alt_translations: null }, 'sv', 'en'),
    ).toBeNull();
    expect(
      swapPrimaryAlt(
        { alt_text: 'x', alt_translations: { en: ' ' } },
        'sv',
        'en',
      ),
    ).toBeNull();
    expect(
      swapPrimaryAlt(
        { alt_text: 'x', alt_translations: { en: 'y' } },
        'en',
        'en',
      ),
    ).toBeNull();
  });

  it('an empty default alt adds no key; an existing old-language alt is kept; the map can end empty', () => {
    expect(
      swapPrimaryAlt(
        { alt_text: '  ', alt_translations: { en: 'Red horse' } },
        'sv',
        'en',
      ),
    ).toEqual({ alt_text: 'Red horse', alt_translations: null });
    expect(
      swapPrimaryAlt(
        {
          alt_text: 'old default',
          alt_translations: { en: 'Red horse', sv: 'Röd häst' },
        },
        'sv',
        'en',
      ),
    ).toEqual({ alt_text: 'Red horse', alt_translations: { sv: 'Röd häst' } });
  });

  it('a default alt over the map limit is cut to IMAGE_ALT_MAX so the next save stays valid', () => {
    const next = swapPrimaryAlt(
      {
        alt_text: 'a'.repeat(IMAGE_ALT_MAX + 50),
        alt_translations: { en: 'Red' },
      },
      'sv',
      'en',
    );
    expect(next?.alt_translations?.sv).toHaveLength(IMAGE_ALT_MAX);
    expect(normalizeAltTranslations(next?.alt_translations, 'en')).toEqual(
      next?.alt_translations,
    );
  });

  it('a swap back restores the first state', () => {
    const first = {
      alt_text: 'Röd dalahäst',
      alt_translations: { en: 'Red horse' },
    };
    const there = swapPrimaryAlt(first, 'sv', 'en');
    expect(swapPrimaryAlt(there!, 'en', 'sv')).toEqual(first);
  });
});
