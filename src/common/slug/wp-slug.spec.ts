import { Prisma } from '@prisma/client';
import { sanitizeTitle } from '@multi-stores/core/slug';
import {
  idFallbackSlug,
  isReservedPageSlug,
  isWpSlug,
  lookupSlug,
  resolveSlugBase,
  slugFromCandidates,
  storeSlugLocale,
  uniqueCollectionSlug,
  uniquePlatformCategorySlug,
  uniqueProductSlug,
  uniqueStaticPageSlug,
  uniqueV2PageSlug,
  withSlugRetry,
  type SlugDb,
} from './wp-slug';

// WordPress slug rules of the API (plans/slug-wp-rules): sanitizing with the
// store content locale, fallbacks, uniqueness domains and lookups.

type Row = { id: string; slug: string; [k: string]: unknown };

/** findFirst over in-memory rows, honouring `slug`, owner and `id: { not }`. */
function finder(
  rows: Row[],
  match: (r: Row, where: Record<string, unknown>) => boolean,
) {
  return jest.fn(({ where }: { where: Record<string, unknown> }) => {
    const notId = (where.id as { not?: string } | undefined)?.not;
    return Promise.resolve(
      rows.find(
        (r) => r.slug === where.slug && r.id !== notId && match(r, where),
      ) ?? null,
    );
  });
}

describe('sanitizing with the store content locale', () => {
  it.each([
    ['Kläder', 'sv', 'klader'],
    ['Present till svärfar', 'sv', 'present-till-svarfar'],
    ['هدية لأمي', 'ar', 'هدية-لأمي'],
    ['هدية لأمي', 'sv', 'هدية-لأمي'],
    ['Straße', 'de', 'strasse'],
    ['Straße', 'sv', 'strase'],
    ['Kläder', 'de', 'klaeder'],
  ])('%s (%s) -> %s', (input, locale, out) => {
    expect(slugFromCandidates([input], locale)).toBe(out);
  });

  it('falls back to the next candidate, then to the id', () => {
    expect(slugFromCandidates(['!!!', '', 'Kläder'], 'sv')).toBe('klader');
    expect(
      resolveSlugBase({
        candidates: ['!!!', '   '],
        locale: 'sv',
        prefix: 'product',
        id: 'ABCDEF12-3456-7890-abcd-ef1234567890',
      }),
    ).toEqual({ slug: 'product-abcdef12', keep: false });
    expect(idFallbackSlug('page')).toMatch(/^page-[0-9a-f]{8}$/);
  });

  it('keeps a stored slug sent back unchanged (re-sanitizing would change it)', () => {
    // `straße` came from an import; sanitizing it again gives `strase`.
    expect(sanitizeTitle('straße', { locale: 'sv' })).toBe('strase');
    expect(
      resolveSlugBase({
        candidates: ['straße'],
        locale: 'sv',
        stored: 'straße',
        prefix: 'product',
      }),
    ).toEqual({ slug: 'straße', keep: true });
    // A different value is sanitized and is no longer "kept".
    expect(
      resolveSlugBase({
        candidates: ['Ny Slug'],
        locale: 'sv',
        stored: 'straße',
        prefix: 'product',
      }),
    ).toEqual({ slug: 'ny-slug', keep: false });
    // Sanitizing to the stored value counts as unchanged.
    expect(
      resolveSlugBase({
        candidates: ['Klader'],
        locale: 'sv',
        stored: 'klader',
        prefix: 'product',
      }),
    ).toEqual({ slug: 'klader', keep: true });
  });

  it('isWpSlug validates a stored decoded slug in its encoded form', () => {
    expect(isWpSlug('kläder', 'sv')).toBe(true); // imported WP slug
    expect(isWpSlug('straße', 'sv')).toBe(true);
    expect(isWpSlug('هدية-لأمي', 'sv')).toBe(true);
    expect(isWpSlug('3d_presenter', 'sv')).toBe(true);
    expect(isWpSlug('Bad_Slug', 'sv')).toBe(false);
    expect(isWpSlug('two words', 'sv')).toBe(false);
    expect(isWpSlug('م'.repeat(40), 'sv')).toBe(false); // 240 encoded bytes
    expect(isWpSlug('', 'sv')).toBe(false);
  });

  it('reads the store primary locale, default en', async () => {
    const findUnique = jest
      .fn()
      .mockResolvedValueOnce({ language_config: { primary_locale: 'sv' } })
      .mockResolvedValueOnce(null);
    const db = { store: { findUnique } } as unknown as SlugDb;
    expect(await storeSlugLocale(db, { creatorId: 'c1' })).toBe('sv');
    const [args] = findUnique.mock.calls[0] as [{ where: unknown }];
    expect(args.where).toEqual({ creator_id: 'c1' });
    expect(await storeSlugLocale(db, { storeId: 's1' })).toBe('en');
    expect(await storeSlugLocale(db, {})).toBe('en');
  });
});

describe('lookups (WP query context)', () => {
  it.each([
    ['kl%C3%A4der', 'kläder'], // browser / Next uppercase hex
    ['kl%c3%a4der', 'kläder'], // WP lowercase hex
    ['kläder'.normalize('NFD'), 'kläder'], // NFD
    ['KLÄDER', 'kläder'],
    ['%D9%87%D8%AF%D9%8A%D8%A9', 'هدية'],
    ['svärfar', 'svärfar'], // no accent folding at lookup, like WP
  ])('%s -> %s', (raw, stored) => {
    expect(lookupSlug(raw)).toBe(stored);
  });
});

describe('uniqueness domains', () => {
  it('products: own + custom of the creator, any locale, -2/-3, self excluded', async () => {
    const own: Row[] = [
      { id: 't1', slug: 'mugg', product_id: 'p1', creator_id: 'c1' },
      { id: 't2', slug: 'mugg-2', product_id: 'p2', creator_id: 'c1' },
      { id: 't3', slug: 'kopp', product_id: 'p9', creator_id: 'other' },
    ];
    const custom: Row[] = [
      { id: 'u1', slug: 'tröja', custom_product_id: 'cp1', creator_id: 'c1' },
    ];
    const ownerOf = (r: Row, where: Record<string, unknown>, key: string) => {
      const rel = where[key] as { creator_id?: string; id?: { not?: string } };
      const self = key === 'product' ? r.product_id : r.custom_product_id;
      return r.creator_id === rel.creator_id && self !== rel.id?.not;
    };
    const db = {
      productTranslation: {
        findFirst: finder(own, (r, w) => ownerOf(r, w, 'product')),
      },
      customProductTranslation: {
        findFirst: finder(custom, (r, w) => ownerOf(r, w, 'custom_product')),
      },
    } as unknown as SlugDb;
    const owner = { creatorId: 'c1' };
    expect(await uniqueProductSlug(db, owner, 'mugg')).toBe('mugg-3');
    expect(await uniqueProductSlug(db, owner, 'kopp')).toBe('kopp'); // other creator
    expect(await uniqueProductSlug(db, owner, 'tröja')).toBe('tröja-2'); // custom product
    // The product itself does not collide with its own slug.
    expect(
      await uniqueProductSlug(db, owner, 'mugg', { productId: 'p1' }),
    ).toBe('mugg');
    // WP reserved feed slugs are suffixed for products too.
    expect(await uniqueProductSlug(db, owner, 'feed')).toBe('feed-2');
  });

  it('collections: <slug>-<parent> first (WP hierarchical terms), then -N', async () => {
    const rows: Row[] = [
      { id: 'a', slug: 'red', creator_id: 'c1' },
      { id: 'b', slug: 'red-shirts-men', creator_id: 'c1' },
    ];
    const db = {
      creatorCategory: {
        findFirst: finder(rows, (r, w) => r.creator_id === w.creator_id),
      },
    } as unknown as SlugDb;
    expect(await uniqueCollectionSlug(db, 'c1', 'red', ['shirts'])).toBe(
      'red-shirts',
    );
    rows.push({ id: 'c', slug: 'red-shirts', creator_id: 'c1' });
    // All alternates taken: the suffix goes on the last one (`red-shirts-men-2`).
    expect(await uniqueCollectionSlug(db, 'c1', 'red', ['shirts', 'men'])).toBe(
      'red-shirts-men-2',
    );
    expect(await uniqueCollectionSlug(db, 'c1', 'red', [])).toBe('red-2');
    // A root collection with a free slug, and terms have no reserved list.
    expect(await uniqueCollectionSlug(db, 'c1', 'feed', [])).toBe('feed');
    // The row being edited is excluded.
    expect(await uniqueCollectionSlug(db, 'c1', 'red', [], 'a')).toBe('red');
  });

  it('pages: reserved routes, locale prefixes, feeds and numeric slugs get -2', async () => {
    const v2: Row[] = [{ id: 'p1', slug: 'om-oss', store_id: 's1' }];
    const legacy: Row[] = [{ id: 'l1', slug: 'about', store_id: 's1' }];
    const db = {
      page: { findFirst: finder(v2, (r, w) => r.store_id === w.store_id) },
      staticPage: {
        findFirst: finder(legacy, (r, w) => r.store_id === w.store_id),
      },
    } as unknown as SlugDb;
    for (const [base, out] of [
      ['cart', 'cart-2'],
      ['products', 'products-2'],
      ['sv', 'sv-2'],
      ['feed', 'feed-2'],
      ['2024', '2024-2'],
      ['page3', 'page3-2'],
      ['om-oss', 'om-oss-2'],
      ['هدية-لأمي', 'هدية-لأمي'],
    ]) {
      expect(await uniqueV2PageSlug(db, 's1', base)).toBe(out);
    }
    // v2 ignores legacy slugs (the builder upgrade reuses them)...
    expect(await uniqueV2PageSlug(db, 's1', 'about')).toBe('about');
    // ...but a new legacy page avoids v2 slugs (v2 would shadow it).
    expect(await uniqueStaticPageSlug(db, 's1', 'om-oss')).toBe('om-oss-2');
    expect(await uniqueStaticPageSlug(db, 's1', 'about')).toBe('about-2');
    expect(await uniqueStaticPageSlug(db, 's1', 'about', 'l1')).toBe('about');
    expect(isReservedPageSlug('Cart')).toBe(true);
  });

  it('platform categories: global, no reserved list', async () => {
    const rows: Row[] = [{ id: 'k1', slug: 'klader' }];
    const db = {
      category: { findFirst: finder(rows, () => true) },
    } as unknown as SlugDb;
    expect(await uniquePlatformCategorySlug(db, 'klader')).toBe('klader-2');
    expect(await uniquePlatformCategorySlug(db, 'klader', 'k1')).toBe('klader');
  });

  it('withSlugRetry runs the write once more after a P2002 race', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'x',
    });
    const fn = jest.fn().mockRejectedValueOnce(p2002).mockResolvedValue('ok');
    await expect(withSlugRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    const other = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(withSlugRetry(other)).rejects.toThrow('boom');
    expect(other).toHaveBeenCalledTimes(1);
  });
});
