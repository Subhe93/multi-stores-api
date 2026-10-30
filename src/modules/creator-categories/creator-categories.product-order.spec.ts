import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { CreatorCategoriesService } from './creator-categories.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { UpdateCreatorCategoryDto } from './dto/creator-category.dto';
import { computeLinkSortOrders, mergedProductOrder } from './product-order';

// Manual collection order: `product_order` tokens (`p:<id>` / `cp:<id>`)
// give own and custom products one shared sort_order index space.

const P1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const P2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const P3 = 'aaaaaaaa-0000-0000-0000-000000000003';
const C1 = 'cccccccc-0000-0000-0000-000000000001';
const C2 = 'cccccccc-0000-0000-0000-000000000002';

describe('computeLinkSortOrders', () => {
  it('uses the token index; missing links follow (own, then custom) in current order', () => {
    const res = computeLinkSortOrders(
      [`cp:${C2}`, `p:${P2}`, `p:${P2}`, `p:unknown`],
      [
        { id: P1, sort_order: 5 },
        { id: P2, sort_order: 0 },
        { id: P3, sort_order: 1 },
      ],
      [
        { id: C1, sort_order: 0 },
        { id: C2, sort_order: 9 },
      ],
    );
    // Duplicates collapse (first wins): cp:C2=0, p:P2=1, p:unknown=2 → next=3.
    expect(res.custom.get(C2)).toBe(0);
    expect(res.own.get(P2)).toBe(1);
    expect(res.own.get(P3)).toBe(3);
    expect(res.own.get(P1)).toBe(4);
    expect(res.custom.get(C1)).toBe(5);
  });
});

describe('mergedProductOrder', () => {
  it('sorts by sort_order, then newest first, then own before custom', () => {
    expect(
      mergedProductOrder(
        [
          { id: P1, sort_order: 1, created_at: '2026-01-01' },
          { id: P2, sort_order: 0, created_at: '2026-01-01' },
        ],
        [
          { id: C1, sort_order: 0, created_at: '2026-02-01' },
          { id: C2, sort_order: 1, created_at: '2026-01-01' },
        ],
      ),
    ).toEqual([`cp:${C1}`, `p:${P2}`, `p:${P1}`, `cp:${C2}`]);
  });
});

describe('product_order DTO validation', () => {
  const check = async (product_order: unknown) =>
    validate(plainToInstance(UpdateCreatorCategoryDto, { product_order }));

  it('accepts p:/cp: uuid tokens', async () => {
    expect(await check([`p:${P1}`, `cp:${C1}`])).toHaveLength(0);
  });

  it('rejects other shapes and over-long arrays', async () => {
    expect((await check([`x:${P1}`])).length).toBeGreaterThan(0);
    expect((await check(['p:123'])).length).toBeGreaterThan(0);
    expect((await check('p:1')).length).toBeGreaterThan(0);
    expect(
      (await check(Array.from({ length: 2001 }, () => `p:${P1}`))).length,
    ).toBeGreaterThan(0);
  });
});

type OwnLink = { product_id: string; sort_order: number };
type CustomLink = { custom_product_id: string; sort_order: number };

function build(seed: { own?: OwnLink[]; custom?: CustomLink[] } = {}) {
  const ownLinks: OwnLink[] = [...(seed.own ?? [])];
  const customLinks: CustomLink[] = [...(seed.custom ?? [])];
  const revalidate = jest.fn();
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    creatorCategory: {
      findUnique: jest.fn(({ include }: { include?: unknown } = {}) =>
        Promise.resolve(
          include
            ? {
                id: 'cat1',
                creator_id: 'c1',
                translations: [],
                products: [...ownLinks]
                  .sort((a, b) => a.sort_order - b.sort_order)
                  .map((l) => ({
                    ...l,
                    product: { id: l.product_id, created_at: new Date(0) },
                  })),
                custom_products: [...customLinks]
                  .sort((a, b) => a.sort_order - b.sort_order)
                  .map((l) => ({
                    ...l,
                    custom_product: {
                      id: l.custom_product_id,
                      created_at: new Date(0),
                    },
                  })),
              }
            : { id: 'cat1', creator_id: 'c1', visibility: 'PUBLIC' },
        ),
      ),
      create: jest.fn(() => Promise.resolve({ id: 'cat1' })),
      update: jest.fn(() => Promise.resolve({})),
    },
    // Ownership: the creator owns P1..P3 and C1..C2 only.
    product: {
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.filter((id) => id.startsWith('a')).map((id) => ({ id })),
        ),
      ),
    },
    customProduct: {
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.filter((id) => id.startsWith('c')).map((id) => ({ id })),
        ),
      ),
    },
    productCreatorCategory: {
      findMany: jest.fn(() => Promise.resolve(ownLinks.map((l) => ({ ...l })))),
      deleteMany: jest.fn(() => {
        ownLinks.length = 0;
        return Promise.resolve({});
      }),
      createMany: jest.fn(({ data }: { data: OwnLink[] }) => {
        ownLinks.push(...data.map((d) => ({ ...d })));
        return Promise.resolve({ count: data.length });
      }),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { product_id_creator_category_id: { product_id: string } };
          data: { sort_order: number };
        }) => {
          const l = ownLinks.find(
            (x) =>
              x.product_id === where.product_id_creator_category_id.product_id,
          )!;
          l.sort_order = data.sort_order;
          return Promise.resolve(l);
        },
      ),
    },
    customProductCreatorCategory: {
      findMany: jest.fn(() =>
        Promise.resolve(customLinks.map((l) => ({ ...l }))),
      ),
      deleteMany: jest.fn(() => {
        customLinks.length = 0;
        return Promise.resolve({});
      }),
      createMany: jest.fn(({ data }: { data: CustomLink[] }) => {
        customLinks.push(...data.map((d) => ({ ...d })));
        return Promise.resolve({ count: data.length });
      }),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: {
            custom_product_id_creator_category_id: {
              custom_product_id: string;
            };
          };
          data: { sort_order: number };
        }) => {
          const l = customLinks.find(
            (x) =>
              x.custom_product_id ===
              where.custom_product_id_creator_category_id.custom_product_id,
          )!;
          l.sort_order = data.sort_order;
          return Promise.resolve(l);
        },
      ),
    },
    // Batch form (array) and interactive form (callback with the client).
    $transaction: jest.fn((arg: unknown): Promise<unknown> =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
        : Promise.all(arg as Promise<unknown>[]),
    ),
  };
  const service = new CreatorCategoriesService(
    prisma as unknown as PrismaService,
    {
      revalidateStoreByCreatorId: revalidate,
    } as unknown as RevalidationService,
  );
  const sorted = () => ({
    own: Object.fromEntries(ownLinks.map((l) => [l.product_id, l.sort_order])),
    custom: Object.fromEntries(
      customLinks.map((l) => [l.custom_product_id, l.sort_order]),
    ),
  });
  return { service, prisma, sorted, revalidate };
}

describe('CreatorCategoriesService product_order', () => {
  it('update with ids + product_order: one shared index space across both kinds', async () => {
    const { service, sorted, revalidate } = build();
    const res = await service.update('cat1', 'u1', {
      product_ids: [P1, P2, P3],
      custom_product_ids: [C1],
      product_order: [`p:${P2}`, `cp:${C1}`, `p:${P1}`],
    });
    // P3 is missing from product_order → goes after.
    expect(sorted()).toEqual({
      own: { [P1]: 2, [P2]: 0, [P3]: 3 },
      custom: { [C1]: 1 },
    });
    expect(res.product_order).toEqual([
      `p:${P2}`,
      `cp:${C1}`,
      `p:${P1}`,
      `p:${P3}`,
    ]);
    expect(revalidate).toHaveBeenCalledWith('c1');
  });

  it('product_order alone reorders the existing links only', async () => {
    const { service, prisma, sorted, revalidate } = build({
      own: [
        { product_id: P1, sort_order: 0 },
        { product_id: P2, sort_order: 1 },
      ],
      custom: [{ custom_product_id: C1, sort_order: 0 }],
    });
    await service.update('cat1', 'u1', {
      product_order: [`cp:${C1}`, `p:${P2}`, `p:${P1}`, `cp:${C2}`],
    });
    expect(prisma.productCreatorCategory.deleteMany).not.toHaveBeenCalled();
    expect(prisma.productCreatorCategory.createMany).not.toHaveBeenCalled();
    expect(
      prisma.customProductCreatorCategory.createMany,
    ).not.toHaveBeenCalled();
    // C2 is not linked: ignored, never created.
    expect(sorted()).toEqual({
      own: { [P1]: 2, [P2]: 1 },
      custom: { [C1]: 0 },
    });
    expect(revalidate).toHaveBeenCalledWith('c1');
  });

  it('only writes the links whose sort_order changes', async () => {
    const { service, prisma } = build({
      own: [
        { product_id: P1, sort_order: 0 },
        { product_id: P2, sort_order: 1 },
      ],
    });
    await service.update('cat1', 'u1', {
      product_order: [`p:${P1}`, `p:${P2}`],
    });
    expect(prisma.productCreatorCategory.update).not.toHaveBeenCalled();
  });

  it('creates new links at their product_order index (no follow-up updates)', async () => {
    const { service, prisma, sorted } = build();
    await service.update('cat1', 'u1', {
      product_ids: [P1, P2],
      custom_product_ids: [C1],
      product_order: [`cp:${C1}`, `p:${P2}`, `p:${P1}`],
    });
    expect(sorted()).toEqual({
      own: { [P1]: 2, [P2]: 1 },
      custom: { [C1]: 0 },
    });
    expect(prisma.productCreatorCategory.update).not.toHaveBeenCalled();
    expect(prisma.customProductCreatorCategory.update).not.toHaveBeenCalled();
  });

  it('rewrites the links and the order inside one transaction', async () => {
    const { service, prisma } = build({
      own: [{ product_id: P1, sort_order: 0 }],
    });
    prisma.productCreatorCategory.createMany.mockImplementationOnce(() =>
      Promise.reject(new Error('boom')),
    );
    await expect(
      service.update('cat1', 'u1', {
        product_ids: [P2],
        product_order: [`p:${P2}`],
      }),
    ).rejects.toThrow('boom');
    // deleteMany + createMany ran through the interactive transaction
    // callback (the mock passes the same client as `tx`).
    const fnCalls = prisma.$transaction.mock.calls.filter(
      ([arg]) => typeof arg === 'function',
    );
    expect(fnCalls).toHaveLength(1);
  });

  it('without product_order the per-kind array indexes are kept (unchanged behaviour)', async () => {
    const { service, sorted } = build();
    await service.update('cat1', 'u1', {
      product_ids: [P2, P1],
      custom_product_ids: [C2, C1],
    });
    expect(sorted()).toEqual({
      own: { [P2]: 0, [P1]: 1 },
      custom: { [C2]: 0, [C1]: 1 },
    });
  });

  it('create applies product_order; foreign ids are still never linked', async () => {
    const { service, sorted } = build();
    await service.create('u1', {
      slug: 'x',
      translations: [{ locale: 'en', name: 'X' }],
      product_ids: [P1, 'bbbbbbbb-0000-0000-0000-000000000009'],
      custom_product_ids: [C1],
      product_order: [
        `cp:${C1}`,
        'p:bbbbbbbb-0000-0000-0000-000000000009',
        `p:${P1}`,
      ],
    });
    expect(sorted()).toEqual({ own: { [P1]: 2 }, custom: { [C1]: 0 } });
  });
});
