import { StoreType } from '@prisma/client';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { StorefrontService } from './storefront.service';
import { CreatorCategoriesService } from '../creator-categories/creator-categories.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import type { MarketPricingService } from '../markets/market-pricing.service';
import type { TaxService } from '../taxes/tax.service';

// M4.4 category SEO: `noindex_when_empty` collections get a
// `published_product_count` in the public tree and are left out of the
// sitemap while empty. Stores without a flag pay no extra query and keep
// the same payload. Category saves carry meta_title/meta_desc over (X19).

type Row = Record<string, unknown>;

const cat = (id: string, extra: Row = {}): Row => ({
  id,
  creator_id: 'c1',
  parent_id: null,
  slug: id,
  thumbnail_url: null,
  match_rule: 'MANUAL',
  match_tags: [],
  sort_order: 0,
  is_active: true,
  external_ref: null,
  noindex_when_empty: false,
  created_at: new Date(0),
  updated_at: new Date(0),
  translations: [],
  ...extra,
});

function build(
  categories: Row[],
  storeType: StoreType = StoreType.INDEPENDENT,
) {
  const groupOwn = jest.fn(() =>
    Promise.resolve([{ creator_category_id: 'full', _count: { _all: 2 } }]),
  );
  const groupCustom = jest.fn(() =>
    Promise.resolve([{ creator_category_id: 'empty', _count: { _all: 1 } }]),
  );
  const productCount = jest.fn(() => Promise.resolve(0));
  const prisma = {
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 's1',
          slug: 'namez',
          store_type: storeType,
          creator: { id: 'c1' },
          language_config: { primary_locale: 'sv', secondary_locales: [] },
        }),
      ),
    },
    creatorCategory: { findMany: jest.fn(() => Promise.resolve(categories)) },
    productCreatorCategory: { groupBy: groupOwn },
    customProductCreatorCategory: { groupBy: groupCustom },
    product: {
      findMany: jest.fn(() => Promise.resolve([])),
      count: productCount,
    },
    customProduct: {
      findMany: jest.fn(() => Promise.resolve([])),
      count: jest.fn(() => Promise.resolve(0)),
    },
    page: { findMany: jest.fn(() => Promise.resolve([])) },
    staticPage: { findMany: jest.fn(() => Promise.resolve([])) },
    legalPage: { findMany: jest.fn(() => Promise.resolve([])) },
  };
  const markets = { resolve: jest.fn(() => Promise.resolve(null)) };
  const service = new StorefrontService(
    prisma as unknown as PrismaService,
    {} as StoreAppsService,
    markets as unknown as MarketsContextService,
    {} as MarketPricingService,
    {} as TaxService,
  );
  return { service, groupOwn, groupCustom, productCount };
}

describe('StorefrontService.getCreatorCategories published_product_count', () => {
  it('no flagged collection: no count query and no count key', async () => {
    const { service, groupOwn } = build([
      cat('a'),
      cat('b', { parent_id: 'a' }),
    ]);
    const tree = await service.getCreatorCategories('namez');
    expect(groupOwn).not.toHaveBeenCalled();
    expect(tree).toHaveLength(1);
    expect(tree[0]).not.toHaveProperty('published_product_count');
    expect(tree[0].children[0]).not.toHaveProperty('published_product_count');
  });

  it('a flagged collection: every row gets its count (own products only for independent stores)', async () => {
    const { service, groupOwn, groupCustom } = build([
      cat('full'),
      cat('empty', { noindex_when_empty: true }),
    ]);
    const tree = await service.getCreatorCategories('namez');
    expect(groupOwn).toHaveBeenCalledTimes(1);
    expect(groupCustom).not.toHaveBeenCalled();
    const counts = Object.fromEntries(
      tree.map((n) => [n.id, n.published_product_count]),
    );
    expect(counts).toEqual({ full: 2, empty: 0 });
  });

  it('marketplace stores also count custom products; TAGS collections use a tag count', async () => {
    const { service, groupCustom, productCount } = build(
      [
        cat('empty', { noindex_when_empty: true }),
        cat('tagged', { match_rule: 'TAGS', match_tags: ['x'] }),
      ],
      StoreType.MARKETPLACE,
    );
    const tree = await service.getCreatorCategories('namez');
    expect(groupCustom).toHaveBeenCalledTimes(1);
    expect(productCount).toHaveBeenCalledTimes(1);
    expect(tree.find((n) => n.id === 'empty')?.published_product_count).toBe(1);
    expect(tree.find((n) => n.id === 'tagged')?.published_product_count).toBe(
      0,
    );
  });
});

describe('StorefrontService.getSitemapData noindex_when_empty', () => {
  it('drops flagged collections without published products only', async () => {
    const { service } = build([
      cat('full', { noindex_when_empty: true }),
      cat('empty', { noindex_when_empty: true }),
      cat('plain'),
    ]);
    const data = await service.getSitemapData('namez');
    expect(data.collections.map((c) => c.slug)).toEqual(['full', 'plain']);
  });

  it('no flag: no count query, every active collection listed with its path (M6.7)', async () => {
    const { service, groupOwn } = build([
      cat('a'),
      cat('b', { parent_id: 'a' }),
    ]);
    const data = await service.getSitemapData('namez');
    expect(groupOwn).not.toHaveBeenCalled();
    expect(data.collections).toEqual([
      { slug: 'a', path: ['a'], lastmod: new Date(0) },
      { slug: 'b', path: ['a', 'b'], lastmod: new Date(0) },
    ]);
  });
});

describe('CreatorCategoriesService.update SEO carry-over (X19)', () => {
  function setup(stored: Row[]) {
    const createMany = jest.fn();
    const findManyTr = jest.fn(() => Promise.resolve(stored));
    const prisma = {
      creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
      creatorCategory: {
        findUnique: jest.fn(() => Promise.resolve({ creator_id: 'c1' })),
        update: jest.fn(),
      },
      creatorCategoryTranslation: {
        findMany: findManyTr,
        deleteMany: jest.fn(),
        createMany,
      },
      // Pass-through: the array form resolves its operations, the callback
      // form runs against this fake (M5 A-X: the rewrite is one transaction).
      $transaction: jest.fn(
        (arg: unknown): Promise<unknown> =>
          Array.isArray(arg)
            ? Promise.all(arg as Promise<unknown>[])
            : (arg as (tx: unknown) => Promise<unknown>)(prisma),
      ),
    };
    const svc = new CreatorCategoriesService(
      prisma as unknown as PrismaService,
      {
        revalidateStoreByCreatorId: jest.fn(),
      } as unknown as RevalidationService,
    );
    (svc as unknown as Record<string, unknown>).findById = jest.fn(() =>
      Promise.resolve({}),
    );
    return { svc, createMany, findManyTr, prisma };
  }

  it('undefined keeps the stored meta per locale; null/"" clears; noindex flag passes through', async () => {
    const { svc, createMany, prisma } = setup([
      { locale: 'sv', meta_title: 'SEO sv', meta_desc: 'Desc sv' },
    ]);
    await svc.update('cat1', 'u1', {
      noindex_when_empty: true,
      translations: [
        { locale: 'sv', name: 'Barn' },
        { locale: 'en', name: 'Kids', meta_title: 'Kids SEO', meta_desc: '' },
      ],
    });
    expect(
      (prisma.creatorCategory.update.mock.calls as unknown[][])[0][0],
    ).toMatchObject({
      data: { noindex_when_empty: true },
    });
    const rows = (createMany.mock.calls as { data: Row[] }[][])[0][0].data;
    expect(rows.map((r) => [r.locale, r.meta_title, r.meta_desc])).toEqual([
      ['sv', 'SEO sv', 'Desc sv'],
      ['en', 'Kids SEO', null],
    ]);
  });

  it('no read when every row carries every carried-over column (description + long_description + meta)', async () => {
    const { svc, findManyTr } = setup([]);
    await svc.update('cat1', 'u1', {
      translations: [
        {
          locale: 'sv',
          name: 'Barn',
          description: '',
          long_description: '',
          meta_title: null,
          meta_desc: 'x',
        },
      ],
    });
    expect(findManyTr).not.toHaveBeenCalled();
  });
});
