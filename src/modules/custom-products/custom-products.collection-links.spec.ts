import { CustomProductsService } from './custom-products.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';

// Linking a custom product to a collection from its editor puts it at the
// end of that collection's manual order: max sort_order across own + custom
// links of the collection, + 1. Kept links keep their sort_order.

describe('CustomProductsService collection links: new link sort_order', () => {
  it('appends new links after the collection max; kept links untouched', async () => {
    const created: unknown[] = [];
    const prisma = {
      creatorCategory: {
        findMany: jest.fn(() =>
          Promise.resolve(
            ['a', 'b', 'c'].map((id) => ({ id, visibility: 'PUBLIC' })),
          ),
        ),
      },
      productCreatorCategory: {
        groupBy: jest.fn(() =>
          Promise.resolve([
            { creator_category_id: 'b', _max: { sort_order: 4 } },
          ]),
        ),
      },
      customProductCreatorCategory: {
        findMany: jest.fn(() =>
          Promise.resolve([{ creator_category_id: 'a', sort_order: 3 }]),
        ),
        deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
        groupBy: jest.fn(() =>
          Promise.resolve([
            { creator_category_id: 'b', _max: { sort_order: 11 } },
          ]),
        ),
        createMany: jest.fn(({ data }: { data: unknown[] }) => {
          created.push(...data);
          return Promise.resolve({ count: data.length });
        }),
      },
    };
    const service = new CustomProductsService(
      prisma as unknown as PrismaService,
      {} as NotificationsService,
    );
    await (
      service as unknown as {
        syncCreatorCategories(
          id: string,
          creatorId: string,
          ids: string[],
        ): Promise<unknown>;
      }
    ).syncCreatorCategories('cp1', 'c1', ['a', 'b', 'c']);
    // Only the new collections are queried and created.
    expect(prisma.productCreatorCategory.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { creator_category_id: { in: ['b', 'c'] } },
      }),
    );
    expect(created).toEqual([
      { custom_product_id: 'cp1', creator_category_id: 'b', sort_order: 12 },
      { custom_product_id: 'cp1', creator_category_id: 'c', sort_order: 0 },
    ]);
  });
});
