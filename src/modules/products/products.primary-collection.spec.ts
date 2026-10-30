import { BadRequestException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ProductsService } from './products.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { BundlesService } from '../bundles/bundles.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';
import type { TaxManagementService } from '../taxes/tax-management.service';

// M6: replacing a creator product's collection links keeps the sort_order
// (= position in the collection) of the links that stay, and the primary
// collection follows the rules of resolvePrimaryCreatorCategory.

type Link = {
  product_id: string;
  creator_category_id: string;
  sort_order: number;
};

function build(opts: {
  links: Link[];
  primary: string | null;
  owned?: string[];
  // Highest sort_order of each collection across both link tables (other
  // products' links); absent = empty collection.
  collectionMax?: Record<string, number>;
}) {
  let links = opts.links.map((l) => ({ ...l }));
  const product: Record<string, unknown> = {
    id: 'p1',
    provider_id: null,
    creator_id: 'c1',
    base_price: 10,
    variant_option_config: null,
    primary_creator_category_id: opts.primary,
  };
  const owned = new Set(opts.owned ?? ['a', 'b', 'c', 'd']);
  const groupBy = ({
    where,
  }: {
    where: { creator_category_id: { in: string[] } };
  }) =>
    Promise.resolve(
      where.creator_category_id.in.flatMap((id) => {
        const own = links
          .filter((l) => l.creator_category_id === id)
          .map((l) => l.sort_order);
        const max = Math.max(-1, ...own, opts.collectionMax?.[id] ?? -1);
        return max < 0
          ? []
          : [{ creator_category_id: id, _max: { sort_order: max } }];
      }),
    );
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    product: {
      findUnique: jest.fn(() => Promise.resolve({ ...product })),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        Object.assign(product, data);
        return Promise.resolve({ ...product });
      }),
    },
    creatorCategory: {
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.filter((id) => owned.has(id)).map((id) => ({ id })),
        ),
      ),
    },
    productCreatorCategory: {
      findMany: jest.fn(() =>
        Promise.resolve(
          [...links]
            .sort((x, y) => x.sort_order - y.sort_order)
            // M6.3: the stored-link read also carries the visibility.
            .map((l) => ({ ...l, creator_category: { visibility: 'PUBLIC' } })),
        ),
      ),
      deleteMany: jest.fn(
        ({
          where,
        }: {
          where: { creator_category_id: { notIn: string[] } };
        }) => {
          const keep = new Set(where.creator_category_id.notIn);
          const before = links.length;
          links = links.filter((l) => keep.has(l.creator_category_id));
          return Promise.resolve({ count: before - links.length });
        },
      ),
      createMany: jest.fn(({ data }: { data: Link[] }) => {
        for (const d of data) {
          if (
            links.some((l) => l.creator_category_id === d.creator_category_id)
          )
            continue;
          links.push({ ...d });
        }
        return Promise.resolve({ count: data.length });
      }),
      groupBy: jest.fn(groupBy),
    },
    customProductCreatorCategory: { groupBy: jest.fn(groupBy) },
  };
  const revalidation = {
    revalidateStoreByCreatorId: jest.fn(() => Promise.resolve()),
  };
  const service = new ProductsService(
    prisma as unknown as PrismaService,
    {} as BundlesService,
    revalidation as unknown as RevalidationService,
    {} as TaxManagementService,
  );
  // findById at the end of update() is not what these tests check.
  jest
    .spyOn(service, 'findById')
    .mockImplementation(() => Promise.resolve({ ...product } as never));
  return {
    service,
    prisma,
    links: () => links,
    primary: () => product.primary_creator_category_id as string | null,
  };
}

describe('ProductsService.update collection links (M6)', () => {
  it('a new link goes to the end of the collection (max across own + custom links + 1)', async () => {
    const { service, links } = build({
      links: [{ product_id: 'p1', creator_category_id: 'a', sort_order: 5 }],
      primary: 'a',
      collectionMax: { a: 9, c: 7 },
    });
    await service.update('p1', 'u1', UserRole.CREATOR, {
      creator_category_ids: ['a', 'c', 'd'],
    });
    expect(links()).toEqual([
      // Existing link keeps its place.
      { product_id: 'p1', creator_category_id: 'a', sort_order: 5 },
      { product_id: 'p1', creator_category_id: 'c', sort_order: 8 },
      // Empty collection starts at 0.
      { product_id: 'p1', creator_category_id: 'd', sort_order: 0 },
    ]);
  });

  it('keeps the sort_order of the links that stay and only adds the new ones', async () => {
    const { service, links, prisma } = build({
      links: [
        { product_id: 'p1', creator_category_id: 'a', sort_order: 5 },
        { product_id: 'p1', creator_category_id: 'b', sort_order: 2 },
      ],
      primary: 'a',
    });
    await service.update('p1', 'u1', UserRole.CREATOR, {
      creator_category_ids: ['b', 'c'],
    });
    expect(links()).toEqual([
      { product_id: 'p1', creator_category_id: 'b', sort_order: 2 },
      { product_id: 'p1', creator_category_id: 'c', sort_order: 0 },
    ]);
    // Only the dropped link was deleted (never a wipe of all rows).
    expect(prisma.productCreatorCategory.deleteMany).toHaveBeenCalledWith({
      where: { product_id: 'p1', creator_category_id: { notIn: ['b', 'c'] } },
    });
  });

  it('primary: dropped → first of the new list; kept → unchanged; single → that one', async () => {
    const two = build({
      links: [
        { product_id: 'p1', creator_category_id: 'a', sort_order: 0 },
        { product_id: 'p1', creator_category_id: 'b', sort_order: 1 },
      ],
      primary: 'a',
    });
    await two.service.update('p1', 'u1', UserRole.CREATOR, {
      creator_category_ids: ['c', 'b'],
    });
    expect(two.primary()).toBe('c');

    const kept = build({
      links: [
        { product_id: 'p1', creator_category_id: 'a', sort_order: 0 },
        { product_id: 'p1', creator_category_id: 'b', sort_order: 1 },
      ],
      primary: 'b',
    });
    await kept.service.update('p1', 'u1', UserRole.CREATOR, {
      creator_category_ids: ['a', 'b', 'c'],
    });
    expect(kept.primary()).toBe('b');

    const single = build({ links: [], primary: null });
    await single.service.update('p1', 'u1', UserRole.CREATOR, {
      creator_category_ids: ['d'],
    });
    expect(single.primary()).toBe('d');
  });

  it('a requested primary must be linked (ids not owned by the creator are not links)', async () => {
    const ok = build({
      links: [{ product_id: 'p1', creator_category_id: 'a', sort_order: 0 }],
      primary: 'a',
    });
    await ok.service.update('p1', 'u1', UserRole.CREATOR, {
      creator_category_ids: ['a', 'b'],
      primary_creator_category_id: 'b',
    });
    expect(ok.primary()).toBe('b');

    const bad = build({
      links: [{ product_id: 'p1', creator_category_id: 'a', sort_order: 0 }],
      primary: 'a',
      owned: ['a'],
    });
    await expect(
      bad.service.update('p1', 'u1', UserRole.CREATOR, {
        creator_category_ids: ['a', 'foreign'],
        primary_creator_category_id: 'foreign',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('changing only the primary re-reads the stored links, by position', async () => {
    const { service, primary, prisma } = build({
      links: [
        { product_id: 'p1', creator_category_id: 'a', sort_order: 1 },
        { product_id: 'p1', creator_category_id: 'b', sort_order: 0 },
      ],
      primary: 'a',
    });
    await service.update('p1', 'u1', UserRole.CREATOR, {
      primary_creator_category_id: 'b',
    });
    expect(primary()).toBe('b');
    expect(prisma.productCreatorCategory.deleteMany).not.toHaveBeenCalled();
    // Clearing it falls back to the stored position order (b first).
    await service.update('p1', 'u1', UserRole.CREATOR, {
      primary_creator_category_id: null,
    });
    expect(primary()).toBe('b');
  });

  it('emits all links in the dropped set correctly: empty list clears links and primary', async () => {
    const { service, links, primary } = build({
      links: [{ product_id: 'p1', creator_category_id: 'a', sort_order: 0 }],
      primary: 'a',
    });
    await service.update('p1', 'u1', UserRole.CREATOR, {
      creator_category_ids: [],
    });
    expect(links()).toEqual([]);
    expect(primary()).toBeNull();
  });
});
