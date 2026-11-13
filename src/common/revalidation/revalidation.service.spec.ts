import type { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from './revalidation.service';

// Provider products (decision D5): a base product change refreshes every
// store that resells it through a CustomProduct.

describe('RevalidationService: reselling stores of a base product', () => {
  function make(creators: string[], slugs: Record<string, string>) {
    const prisma = {
      customProduct: {
        findMany: jest.fn(() =>
          Promise.resolve(creators.map((creator_id) => ({ creator_id }))),
        ),
      },
      store: {
        findMany: jest.fn(
          ({ where }: { where: { creator_id: { in: string[] } } }) =>
            Promise.resolve(
              where.creator_id.in
                .filter((c) => slugs[c])
                .map((c) => ({ slug: slugs[c] })),
            ),
        ),
      },
    };
    const svc = new RevalidationService(prisma as unknown as PrismaService);
    const posted = jest
      .spyOn(svc, 'revalidateStoreBySlug')
      .mockResolvedValue(undefined);
    return { svc, prisma, posted };
  }

  it('revalidates each distinct reselling store once', async () => {
    const { svc, prisma, posted } = make(['c1', 'c2', 'c3'], {
      c1: 'noroj',
      c2: 'shop-two',
    });
    await svc.revalidateStoresByBaseProductId('base-1');
    expect(prisma.customProduct.findMany).toHaveBeenCalledWith({
      where: { product_id: 'base-1' },
      select: { creator_id: true },
      distinct: ['creator_id'],
    });
    expect(posted.mock.calls.map((c) => c[0]).sort()).toEqual([
      'noroj',
      'shop-two',
    ]);
  });

  it('does nothing for a product no store resells', async () => {
    const { svc, prisma, posted } = make([], {});
    await svc.revalidateStoresByBaseProductId('base-1');
    expect(prisma.store.findMany).not.toHaveBeenCalled();
    expect(posted).not.toHaveBeenCalled();
  });

  it('revalidateStoreSlugs dedupes and sends every slug', async () => {
    const { svc, posted } = make([], {});
    const slugs = Array.from({ length: 23 }, (_, i) => `s${i}`);
    await svc.revalidateStoreSlugs([...slugs, 's0']);
    expect(posted).toHaveBeenCalledTimes(23);
  });
});
