import { buildCollectionPaths } from '../../modules/storefront/storefront.service';
import {
  collectionPath,
  collectionPathMoves,
  productPath,
  productSlugMoves,
  rootPagePath,
} from './slug-moves';

// Public paths that move on a slug change (old-slug 301s).

describe('path builders', () => {
  it('percent-encodes segments with lowercase hex (WP permalinks)', () => {
    expect(productPath('kläder')).toBe('/products/kl%c3%a4der');
    expect(productPath('mugg', 'SV')).toBe('/sv/products/mugg');
    expect(collectionPath(['gåvor', 'هدية'])).toBe(
      '/collections/g%c3%a5vor/%d9%87%d8%af%d9%8a%d8%a9',
    );
    expect(rootPagePath('om-oss')).toBe('/om-oss');
  });
});

describe('productSlugMoves', () => {
  it('primary-locale slug: the unprefixed URL moves', () => {
    expect(
      productSlugMoves({
        primaryLocale: 'sv',
        before: [{ locale: 'sv', slug: 'mugg' }],
        after: [{ locale: 'sv', slug: 'kaffemugg' }],
      }),
    ).toEqual([{ from: '/products/mugg', to: '/products/kaffemugg' }]);
  });

  it('secondary-locale slug: /<locale>/products and the unprefixed URL move', () => {
    expect(
      productSlugMoves({
        primaryLocale: 'sv',
        before: [
          { locale: 'sv', slug: 'mugg' },
          { locale: 'en', slug: 'cup' },
        ],
        after: [
          { locale: 'sv', slug: 'mugg' },
          { locale: 'en', slug: 'mug' },
        ],
      }),
    ).toEqual([
      { from: '/products/cup', to: '/products/mug' },
      { from: '/en/products/cup', to: '/en/products/mug' },
    ]);
  });

  it('a slug still held by another locale of the product does not move', () => {
    expect(
      productSlugMoves({
        primaryLocale: 'sv',
        before: [
          { locale: 'sv', slug: 'mugg' },
          { locale: 'en', slug: 'mugg' },
        ],
        after: [
          { locale: 'sv', slug: 'mugg' },
          { locale: 'en', slug: 'mug' },
        ],
      }),
    ).toEqual([]);
  });

  it('a slug shared by primary and secondary locales moves to the new primary', () => {
    expect(
      productSlugMoves({
        primaryLocale: 'sv',
        before: [
          { locale: 'sv', slug: 'mugg' },
          { locale: 'ar', slug: 'mugg' },
        ],
        after: [
          { locale: 'sv', slug: 'kopp' },
          { locale: 'ar', slug: 'كوب' },
        ],
      }),
    ).toEqual([
      { from: '/products/mugg', to: '/products/kopp' },
      {
        from: '/ar/products/mugg',
        to: '/ar/products/%d9%83%d9%88%d8%a8',
      },
    ]);
  });

  it('unchanged slugs or no slugs left: nothing moves', () => {
    const same = [{ locale: 'sv', slug: 'mugg' }];
    expect(
      productSlugMoves({ primaryLocale: 'sv', before: same, after: same }),
    ).toEqual([]);
    expect(
      productSlugMoves({ primaryLocale: 'sv', before: same, after: [] }),
    ).toEqual([]);
  });
});

describe('collectionPathMoves', () => {
  const row = (
    id: string,
    slug: string,
    parent_id: string | null,
    extra: Partial<{ is_active: boolean; visibility: string }> = {},
  ) => ({
    id,
    slug,
    parent_id,
    is_active: true,
    visibility: 'PUBLIC',
    ...extra,
  });

  it('a renamed collection moves with its whole subtree', () => {
    const before = buildCollectionPaths([
      row('a', 'klader', null),
      row('b', 'troja', 'a'),
      row('c', 'barn', 'b'),
      row('d', 'skor', null),
    ]);
    const after = buildCollectionPaths([
      row('a', 'kläder-och-mode', null),
      row('b', 'troja', 'a'),
      row('c', 'barn', 'b'),
      row('d', 'skor', null),
    ]);
    expect(collectionPathMoves(before, after)).toEqual([
      {
        from: '/collections/klader',
        to: '/collections/kl%c3%a4der-och-mode',
      },
      {
        from: '/collections/klader/troja',
        to: '/collections/kl%c3%a4der-och-mode/troja',
      },
      {
        from: '/collections/klader/troja/barn',
        to: '/collections/kl%c3%a4der-och-mode/troja/barn',
      },
    ]);
  });

  it('a re-parented collection moves; unserved rows never do', () => {
    const before = buildCollectionPaths([
      row('a', 'klader', null),
      row('b', 'troja', 'a'),
      row('x', 'dold', null, { is_active: false }),
      row('y', 'etikett', null, { visibility: 'INTERNAL' }),
    ]);
    const after = buildCollectionPaths([
      row('a', 'klader', null),
      row('b', 'troja', null),
      row('x', 'dold-2', null, { is_active: false }),
      row('y', 'etikett-2', null, { visibility: 'INTERNAL' }),
    ]);
    expect(collectionPathMoves(before, after)).toEqual([
      { from: '/collections/klader/troja', to: '/collections/troja' },
    ]);
  });

  it('an old path another collection serves after the change is not moved', () => {
    const before = buildCollectionPaths([
      row('a', 'rea', null),
      row('b', 'rea-2', null),
    ]);
    const after = buildCollectionPaths([
      row('a', 'kampanj', null),
      row('b', 'rea', null),
    ]);
    expect(collectionPathMoves(before, after)).toEqual([
      { from: '/collections/rea-2', to: '/collections/rea' },
    ]);
  });
});
