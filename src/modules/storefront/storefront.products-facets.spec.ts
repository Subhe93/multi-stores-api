import { StoreType } from '@prisma/client';
import {
  MARKET,
  buildList,
  ids,
  type ListFixture,
} from './__fixtures__/product-list-fake';

// GET /storefront/:slug/products with shopper filters / facets=1 (opt-in).
// The fake list rows: own products have sizes S (untracked) and L (stock 2);
// imported products have colours Red (untracked) and Blue (stock 3).

type Row = Record<string, unknown> & { id: string };
type Args = {
  where?: Record<string, unknown>;
  select?: Record<string, unknown>;
};

function fixture(over: Partial<ListFixture> = {}): ListFixture {
  return {
    own: [
      {
        id: 'p-a',
        created: '2026-10-05T10:00:00Z',
        price: 300,
        links: ['col-new'],
      },
      {
        id: 'p-b',
        created: '2026-10-04T10:00:00Z',
        price: 120,
        links: ['tag-sale'],
      },
      { id: 'p-c', created: '2026-10-03T10:00:00Z', price: 80 },
    ],
    custom: [
      {
        id: 'cp-a',
        created: '2026-10-06T10:00:00Z',
        price: 210,
        links: ['col-new'],
      },
    ],
    ...over,
  };
}

/**
 * The fake projects arrays only, so the light reads (which select nested
 * objects) get the full rows plus the fields the faceted path reads.
 */
function build(over: Partial<ListFixture> = {}) {
  const fx = fixture(over);
  const built = buildList(fx);
  const { prisma } = built;
  const linksOf = new Map(
    [...fx.own, ...(fx.custom ?? [])].map((s) => [s.id, s.links ?? []]),
  );
  const withLinks = (r: Row) => ({
    ...r,
    creator_categories: (linksOf.get(r.id) ?? []).map((id) => ({
      creator_category_id: id,
    })),
  });
  const own = prisma.product.findMany.getMockImplementation()!;
  prisma.product.findMany.mockImplementation(async (args: Args = {}) => {
    if (!args.select?.creator_categories) return own(args);
    const rows = (await own({ where: args.where })) as Row[];
    return rows.map((r) =>
      withLinks({
        ...r,
        category_id: r.id === 'p-c' ? 'cat-bags' : 'cat-tops',
      }),
    );
  });
  const custom = prisma.customProduct.findMany.getMockImplementation()!;
  prisma.customProduct.findMany.mockImplementation(async (args: Args = {}) => {
    if (!args.select?.creator_categories) return custom(args);
    const rows = (await custom({ where: args.where })) as Row[];
    return rows.map((r) =>
      withLinks({
        ...r,
        product: {
          ...(r.product as object),
          category_id: 'cat-tops',
          track_inventory: true,
          stock_quantity: 5,
          variant_option_config: null,
        },
      }),
    );
  });
  const extra = prisma as unknown as {
    creatorCategory: Record<string, jest.Mock>;
    category: { findMany: jest.Mock };
  };
  extra.creatorCategory.findMany = jest.fn(() =>
    Promise.resolve([
      {
        id: 'col-new',
        slug: 'new',
        parent_id: null,
        sort_order: 0,
        match_rule: 'MANUAL',
        match_tags: [],
        translations: [
          { locale: 'en', name: 'New in' },
          { locale: 'sv', name: 'Nyheter' },
        ],
      },
      {
        id: 'col-sale',
        slug: 'sale',
        parent_id: null,
        sort_order: 1,
        match_rule: 'TAGS',
        match_tags: ['tag-sale'],
        translations: [{ locale: 'en', name: 'Sale' }],
      },
    ]),
  );
  extra.category = {
    findMany: jest.fn(() =>
      Promise.resolve([
        {
          id: 'cat-tops',
          slug: 'tops',
          translations: [{ locale: 'en', name: 'Tops' }],
        },
        {
          id: 'cat-bags',
          slug: 'bags',
          translations: [{ locale: 'en', name: 'Bags' }],
        },
      ]),
    ),
  };
  return { ...built, extra };
}

type Page = {
  items: { id: string; base_price: number }[];
  total: number;
  page: number;
  limit: number;
  has_more: boolean;
  facets?: Record<string, unknown>;
};

describe('product list filters and facets', () => {
  it('without the new parameters reads exactly as before', async () => {
    const { service, prisma, extra } = build();
    const before = await service.getProducts('shop', { page: '1', limit: '2' });
    expect(Object.keys(before as object)).toEqual([
      'items',
      'total',
      'page',
      'limit',
      'has_more',
    ]);
    expect(extra.creatorCategory.findMany).not.toHaveBeenCalled();
    expect(extra.category.findMany).not.toHaveBeenCalled();
    for (const call of prisma.product.findMany.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain(
        'creator_categories":{"select',
      );
    }
  });

  it('facets=1 adds the facet answer to the page; the items are the same', async () => {
    const plain = (await build().service.getProducts('shop', {
      page: '1',
      limit: '10',
      locale: 'sv',
    })) as Page;
    const { service } = build();
    const faceted = (await service.getProducts('shop', {
      page: '1',
      limit: '10',
      locale: 'sv',
      facets: '1',
    })) as Page;
    expect(faceted.items).toEqual(plain.items);
    expect(faceted.total).toBe(4);
    const f = faceted.facets as {
      collection: { value: string; label: string; count: number }[];
      type: { value: string; count: number }[];
      size: { label: string; count: number }[];
      color: { label: string; count: number }[];
      price: unknown;
      in_stock: unknown;
    };
    expect(f.collection).toEqual([
      { value: 'new', label: 'Nyheter', count: 2, parent: null },
      { value: 'sale', label: 'Sale', count: 1, parent: null },
    ]);
    expect(f.type.map((t) => [t.value, t.count])).toEqual([
      ['bags', 1],
      ['tops', 3],
    ]);
    expect(f.size.map((s) => [s.label, s.count])).toEqual([
      ['S', 3],
      ['L', 3],
    ]);
    expect(f.color.map((c) => [c.label, c.count])).toEqual([
      ['Blue', 1],
      ['Red', 1],
    ]);
    expect(f.price).toEqual({ min: 80, max: 300 });
    expect(f.in_stock).toEqual({ count: 4 });
  });

  it('filters by collection (MANUAL and TAGS), type, size and price', async () => {
    const { service } = build();
    const get = async (extraQ: Record<string, string>) =>
      ids(
        (
          (await service.getProducts('shop', {
            page: '1',
            limit: '10',
            ...extraQ,
          })) as Page
        ).items,
      );
    expect(await get({ collection: 'new' })).toEqual(['p-a', 'cp-a']);
    expect(await get({ collection: 'new,sale' })).toEqual([
      'p-a',
      'p-b',
      'cp-a',
    ]);
    expect(await get({ type: 'bags' })).toEqual(['p-c']);
    expect(await get({ size: 'l' })).toEqual(['p-a', 'p-b', 'p-c']);
    expect(await get({ color: 'blue' })).toEqual(['cp-a']);
    expect(await get({ price_min: '100', price_max: '250' })).toEqual([
      'p-b',
      'cp-a',
    ]);
  });

  it('pages the filtered set with the true total and sorts by price', async () => {
    const { service } = build();
    const first = (await service.getProducts('shop', {
      page: '1',
      limit: '2',
      sort: 'price_asc',
      size: 's',
    })) as Page;
    expect(ids(first.items)).toEqual(['p-c', 'p-b']);
    expect(first.total).toBe(3);
    expect(first.has_more).toBe(true);
    const second = (await service.getProducts('shop', {
      page: '2',
      limit: '2',
      sort: 'price_asc',
      size: 's',
    })) as Page;
    expect(ids(second.items)).toEqual(['p-a']);
    expect(second.has_more).toBe(false);
  });

  it('filters the full list and the limit mode too (plain arrays, no facets)', async () => {
    const { service } = build();
    const all = await service.getProducts('shop', {
      collection: 'new',
      facets: '1',
    });
    expect(Array.isArray(all)).toBe(true);
    expect(ids(all)).toEqual(['p-a', 'cp-a']);
    const limited = await service.getProducts('shop', {
      limit: '1',
      type: 'tops',
    });
    expect(ids(limited)).toEqual(['p-a']);
  });

  it('independent stores list own products only', async () => {
    const { service, prisma } = build({ storeType: StoreType.INDEPENDENT });
    const page = (await service.getProducts('shop', {
      page: '1',
      limit: '10',
      facets: '1',
    })) as Page;
    expect(ids(page.items)).toEqual(['p-a', 'p-b', 'p-c']);
    expect(prisma.customProduct.findMany).not.toHaveBeenCalled();
  });

  it('a market filters on the market price and drops hidden products', async () => {
    const { service } = build({
      market: MARKET,
      own: [
        { id: 'p-a', created: '2026-10-05T10:00:00Z', price: 300 },
        {
          id: 'p-b',
          created: '2026-10-04T10:00:00Z',
          price: 120,
          hiddenIn: ['m-eu'],
        },
        { id: 'p-c', created: '2026-10-03T10:00:00Z', price: 80 },
      ],
      custom: [],
    });
    const page = (await service.getProducts('shop', {
      page: '1',
      limit: '10',
      facets: '1',
      price_max: '20',
    })) as Page;
    // Rate 0.1 with a .99 ending: 300 -> 29.99, 80 -> 7.99.
    expect(ids(page.items)).toEqual(['p-c']);
    expect(page.items[0].base_price).toBeLessThan(20);
    expect((page.facets as { price: { max: number } }).price.max).toBeLessThan(
      31,
    );
  });

  it('an empty result keeps the facets so the shopper can widen', async () => {
    const { service } = build();
    const page = (await service.getProducts('shop', {
      page: '1',
      limit: '10',
      facets: '1',
      color: 'mauve',
    })) as Page;
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect((page.facets as { color: unknown[] }).color).toHaveLength(2);
  });
});
