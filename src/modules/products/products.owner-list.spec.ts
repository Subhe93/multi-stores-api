import { ProductStatus, UserRole } from '@prisma/client';
import { ProductsService } from './products.service';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  noCollectionWhere,
  outOfStockWhere,
  clampLimit,
  collectionWhere,
  orderByFor,
  parseSort,
  parseStock,
  searchWhere,
  sortByTitle,
  stockWhere,
} from './owner-list';

describe('owner-list helpers', () => {
  it('parses sort, stock and limit defensively', () => {
    expect(parseSort('price_desc')).toBe('price_desc');
    expect(parseSort('drop table')).toBe('newest');
    expect(parseSort(undefined)).toBe('newest');
    expect(parseStock('out_of_stock')).toBe('out_of_stock');
    expect(parseStock('x')).toBeUndefined();
    expect(clampLimit(undefined)).toBe(20);
    expect(clampLimit(50)).toBe(50);
    expect(clampLimit(5000)).toBe(100);
    expect(clampLimit(NaN)).toBe(20);
  });

  it('searches title, slug, product SKU and variant SKU', () => {
    const w = searchWhere('  mug ');
    expect(JSON.stringify(w)).toContain('"title":{"contains":"mug"');
    expect(JSON.stringify(w)).toContain('"slug":{"contains":"mug"');
    expect(JSON.stringify(w)).toContain('"sku":{"contains":"mug"');
    expect(JSON.stringify(w)).toContain('"variants":{"some":{"sku"');
    expect(searchWhere('   ')).toBeUndefined();
  });

  it('builds collection membership by rule', () => {
    expect(noCollectionWhere([])).toEqual({ creator_categories: { none: {} } });
    // Tag-rule members are in a collection too.
    expect(noCollectionWhere(['gift'])).toEqual({
      creator_categories: { none: {} },
      NOT: { tags: { some: { tag: { in: ['gift'] } } } },
    });
    expect(
      collectionWhere({ id: 'c1', match_rule: 'MANUAL', match_tags: [] }),
    ).toEqual({
      creator_categories: { some: { creator_category_id: 'c1' } },
    });
    expect(
      collectionWhere({ id: 'c2', match_rule: 'TAGS', match_tags: ['a'] }),
    ).toEqual({
      tags: { some: { tag: { in: ['a'] } } },
    });
    expect(
      collectionWhere({ id: 'c3', match_rule: 'TAGS', match_tags: [] }),
    ).toEqual({
      id: { in: [] },
    });
  });

  it('in_stock is the negation of out_of_stock', () => {
    expect(stockWhere('in_stock')).toEqual({ NOT: stockWhere('out_of_stock') });
    expect(stockWhere(undefined)).toBeUndefined();
  });

  it('a tracked product without a stock number is never out of stock (null-safe)', () => {
    const first = (outOfStockWhere().OR ?? [])[0] as {
      stock_quantity: unknown;
    };
    expect(first.stock_quantity).toEqual({ not: null, lte: 0 });
  });

  it('orders by a stable column list', () => {
    expect(orderByFor('newest')[0]).toEqual({ created_at: 'desc' });
    expect(orderByFor('price_asc')[0]).toEqual({ base_price: 'asc' });
    expect(orderByFor('updated')[0]).toEqual({ updated_at: 'desc' });
  });

  it('sorts by display title with a Swedish collator', () => {
    const rows = [
      { id: '1', translations: [{ locale: 'sv', title: 'Ölglas' }] },
      { id: '2', translations: [{ locale: 'sv', title: 'Ask 10' }] },
      { id: '3', translations: [{ locale: 'sv', title: 'ask 2' }] },
      {
        id: '4',
        translations: [
          { locale: 'sv', title: 'Zebra' },
          { locale: 'en', title: 'Bowl' },
        ],
      },
    ];
    expect(sortByTitle(rows, 'asc')).toEqual(['3', '2', '4', '1']);
    expect(sortByTitle(rows, 'desc')).toEqual(['1', '4', '2', '3']);
  });
});

type FindManyArgs = {
  where: { AND: Array<Record<string, unknown>>; id?: unknown };
  take?: number;
  skip?: number;
  orderBy?: unknown[];
};

const findManyArg = (fn: jest.Mock, call: number): FindManyArgs =>
  (fn.mock.calls as unknown[][])[call][0] as FindManyArgs;

describe('ProductsService.findMine', () => {
  const product = (id: string, title: string) => ({
    id,
    translations: [{ locale: 'sv', title, slug: `s-${id}` }],
  });

  function build() {
    const prisma = {
      creator: { findUnique: jest.fn().mockResolvedValue({ id: 'cr1' }) },
      provider: { findUnique: jest.fn() },
      creatorCategory: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      product: {
        count: jest.fn().mockResolvedValue(3),
        findMany: jest.fn(),
      },
    };
    const service = new ProductsService(
      prisma as unknown as PrismaService,
      {} as never,
      {} as never,
      {} as never,
    );
    return { prisma, service };
  }

  it('scopes to the creator, validates status and clamps the page size', async () => {
    const { prisma, service } = build();
    prisma.product.findMany.mockResolvedValue([product('a', 'A')]);
    const res = await service.findMine('u1', UserRole.CREATOR, {
      page: 2,
      limit: 500,
      status: 'BOGUS',
      sort: 'price_desc',
    });
    const args = findManyArg(prisma.product.findMany, 0);
    expect(args.where.AND[0]).toEqual({ creator_id: 'cr1' });
    expect(args.where.AND[1].status).toBeUndefined();
    expect(args.take).toBe(100);
    expect(args.skip).toBe(100);
    expect(args.orderBy?.[0]).toEqual({ base_price: 'desc' });
    expect(res.meta).toEqual({ total: 3, page: 2, limit: 100, totalPages: 1 });
    expect(res.data[0].slug).toBe('s-a');
  });

  it('passes a valid status through', async () => {
    const { prisma, service } = build();
    prisma.product.findMany.mockResolvedValue([]);
    await service.findMine('u1', UserRole.CREATOR, {
      status: ProductStatus.DRAFT,
    });
    expect(findManyArg(prisma.product.findMany, 0).where.AND[1].status).toBe(
      'DRAFT',
    );
  });

  it('ignores repeated (array) query params instead of crashing', async () => {
    const { prisma, service } = build();
    prisma.product.findMany.mockResolvedValue([]);
    await service.findMine('u1', UserRole.CREATOR, {
      search: ['a', 'b'] as unknown as string,
      collection: ['x', 'y'] as unknown as string,
      status: ['DRAFT'] as unknown as string,
    });
    expect(prisma.creatorCategory.findFirst).not.toHaveBeenCalled();
    expect(findManyArg(prisma.product.findMany, 0).where.AND).toHaveLength(2);
  });

  it('"none" excludes products listed through tag-rule collections', async () => {
    const { prisma, service } = build();
    prisma.creatorCategory.findMany.mockResolvedValue([
      { match_tags: ['a', 'b'] },
      { match_tags: ['b'] },
    ]);
    prisma.product.findMany.mockResolvedValue([]);
    await service.findMine('u1', UserRole.CREATOR, { collection: 'none' });
    expect(findManyArg(prisma.product.findMany, 0).where.AND[2]).toEqual({
      creator_categories: { none: {} },
      NOT: { tags: { some: { tag: { in: ['a', 'b'] } } } },
    });
  });

  it('returns an empty page for a collection of another store', async () => {
    const { prisma, service } = build();
    prisma.creatorCategory.findFirst.mockResolvedValue(null);
    const res = await service.findMine('u1', UserRole.CREATOR, {
      collection: 'foreign',
    });
    expect(prisma.creatorCategory.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'foreign', creator_id: 'cr1' } }),
    );
    expect(res.data).toEqual([]);
    expect(res.meta.total).toBe(0);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it('pages a title sort in memory and keeps the sorted order', async () => {
    const { prisma, service } = build();
    prisma.product.findMany
      .mockResolvedValueOnce([
        product('a', 'Cc'),
        product('b', 'Aa'),
        product('c', 'Bb'),
      ])
      .mockResolvedValueOnce([product('a', 'Cc'), product('c', 'Bb')]);
    const res = await service.findMine('u1', UserRole.CREATOR, {
      sort: 'title_asc',
      limit: 2,
      page: 1,
    });
    expect(findManyArg(prisma.product.findMany, 1).where).toEqual({
      id: { in: ['b', 'c'] },
    });
    // 'b' was filtered out by the mock: the remaining order still follows the sort.
    expect(res.data.map((p) => p.id)).toEqual(['c']);
  });
});
