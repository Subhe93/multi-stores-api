import { CustomProductsService } from './custom-products.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';

// GET /custom-products?q=: the dashboard's collection product picker searches
// the creator's custom products by title (any locale), slug or base SKU.

function build(total = 3) {
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    customProduct: {
      findMany: jest.fn(() => Promise.resolve([{ id: 'cp1' }])),
      count: jest.fn(() => Promise.resolve(total)),
    },
  };
  const service = new CustomProductsService(
    prisma as unknown as PrismaService,
    {} as NotificationsService,
  );
  return { service, prisma };
}

describe('CustomProductsService.findByCreator q', () => {
  it('without q: lists every custom product of the creator (unchanged)', async () => {
    const { service, prisma } = build();
    const res = await service.findByCreator('u1', 2, 10);
    const args = prisma.customProduct.findMany.mock.calls[0] as unknown[];
    expect(args[0]).toMatchObject({
      where: { creator_id: 'c1' },
      skip: 10,
      take: 10,
    });
    expect((args[0] as { where: object }).where).not.toHaveProperty('OR');
    expect(res.meta).toEqual({ total: 3, page: 2, limit: 10, totalPages: 1 });
  });

  it('with q: case-insensitive title / slug / base SKU match, same filter for the count', async () => {
    const { service, prisma } = build();
    await service.findByCreator('u1', 1, 20, '  Mug ');
    const contains = { contains: 'Mug', mode: 'insensitive' };
    const where = {
      creator_id: 'c1',
      OR: [
        { translations: { some: { title: contains } } },
        { translations: { some: { slug: contains } } },
        { product: { sku: contains } },
      ],
    };
    expect(
      (prisma.customProduct.findMany.mock.calls[0] as unknown[])[0],
    ).toMatchObject({ where });
    expect((prisma.customProduct.count.mock.calls[0] as unknown[])[0]).toEqual({
      where,
    });
  });

  it('blank or repeated q is ignored', async () => {
    const { service, prisma } = build();
    await service.findByCreator('u1', 1, 20, '   ');
    await service.findByCreator('u1', 1, 20, ['a', 'b']);
    for (const call of prisma.customProduct.count.mock.calls as unknown[][])
      expect(call[0]).toEqual({ where: { creator_id: 'c1' } });
  });
});
