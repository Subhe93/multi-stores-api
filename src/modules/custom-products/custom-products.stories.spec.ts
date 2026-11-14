import { UserRole } from '@prisma/client';
import { CustomProductsService } from './custom-products.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';

// Customer stories (S7): the custom product editor GET carries the base
// product's stories in the wire shape, read-only for the creator.

describe('CustomProductsService.findById base product stories', () => {
  it('includes the base stories and maps them to the wire shape', async () => {
    const prisma = {
      customProduct: {
        findUnique: jest.fn((_args: unknown) =>
          Promise.resolve({
            id: 'cp1',
            creator_id: 'c1',
            product: {
              provider_id: 'p1',
              stories: [
                {
                  id: 's2',
                  product_id: 'base',
                  kind: 'YOUTUBE',
                  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                  poster_url: null,
                  duration_s: null,
                  width: null,
                  height: null,
                  name: 'Bo',
                  rating: null,
                  verified: false,
                  sort_order: 1,
                  created_at: new Date(),
                  updated_at: new Date(),
                  translations: [],
                },
                {
                  id: 's1',
                  product_id: 'base',
                  kind: 'IMAGE',
                  url: '/uploads/products/a.webp',
                  poster_url: null,
                  duration_s: null,
                  width: 800,
                  height: 800,
                  name: 'Anna',
                  rating: 5,
                  verified: true,
                  sort_order: 0,
                  created_at: new Date(),
                  updated_at: new Date(),
                  translations: [
                    { locale: 'sv', quote: 'Bra', subtitle: null },
                  ],
                },
              ],
            },
          }),
        ),
      },
      creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
      storeLanguageConfig: { findFirst: jest.fn(() => Promise.resolve(null)) },
    };
    const service = new CustomProductsService(
      prisma as unknown as PrismaService,
      {} as NotificationsService,
    );
    const res = await service.findById('cp1', 'u', UserRole.CREATOR);
    const args = prisma.customProduct.findUnique.mock.calls[0][0] as {
      include: { product: { include: Record<string, unknown> } };
    };
    expect(args.include.product.include.stories).toBeDefined();
    expect(res.product.stories).toEqual([
      {
        id: 's1',
        kind: 'image',
        url: '/uploads/products/a.webp',
        poster_url: null,
        duration_s: null,
        width: 800,
        height: 800,
        name: 'Anna',
        rating: 5,
        verified: true,
        autoplay: false,
        loop: false,
        translations: [{ locale: 'sv', quote: 'Bra', subtitle: null }],
      },
      expect.objectContaining({ id: 's2', kind: 'youtube', name: 'Bo' }),
    ]);
  });

  it('keeps stories out of the creator list (detail-only)', async () => {
    const prisma = {
      creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
      customProduct: {
        findMany: jest.fn((_args: unknown) => Promise.resolve([])),
        count: jest.fn(() => Promise.resolve(0)),
      },
    };
    const service = new CustomProductsService(
      prisma as unknown as PrismaService,
      {} as NotificationsService,
    );
    await service.findByCreator('u');
    const args = prisma.customProduct.findMany.mock.calls[0][0] as {
      include: { product: { include: Record<string, unknown> } };
    };
    expect(args.include.product.include.videos).toBeDefined();
    expect(args.include.product.include.stories).toBeUndefined();
  });
});
