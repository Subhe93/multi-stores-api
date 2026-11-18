import { CustomProductsService } from './custom-products.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';

// A custom product lives on the store of its creator: deleting it (or
// changing its status / FAQs) must drop the cached storefront data of that
// store.

function setup() {
  const cp = {
    id: 'cp1',
    creator_id: 'c1',
    product_id: 'base',
    status: 'PENDING_REVIEW',
    creator: { user_id: 'u1' },
    product: { provider: { user_id: 'prov-user' } },
    translations: [],
  };
  const order: string[] = [];
  const prisma = {
    customProduct: {
      findUnique: jest.fn(() => Promise.resolve(cp)),
      delete: jest.fn(() => {
        order.push('delete');
        return Promise.resolve({ id: 'cp1' });
      }),
      update: jest.fn(() => Promise.resolve({ id: 'cp1' })),
    },
    customProductFaq: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'f1', custom_product_id: 'cp1' }),
      ),
      create: jest.fn(() => Promise.resolve({ id: 'f1' })),
      update: jest.fn(() => Promise.resolve({ id: 'f1' })),
      delete: jest.fn(() => Promise.resolve({ id: 'f1' })),
    },
    customProductFaqTranslation: { deleteMany: jest.fn() },
  };
  const revalidation = {
    revalidateStoreByCreatorId: jest.fn(() => {
      order.push('revalidate');
      return Promise.resolve();
    }),
  };
  const svc = new CustomProductsService(
    prisma as unknown as PrismaService,
    { create: jest.fn() } as unknown as NotificationsService,
    undefined,
    undefined,
    revalidation as unknown as RevalidationService,
  );
  return { svc, prisma, revalidation, order };
}

describe('CustomProductsService storefront revalidation', () => {
  it('delete revalidates the creator store after the row is gone', async () => {
    const { svc, revalidation, order } = setup();
    await svc.delete('cp1', 'u1');
    expect(order).toEqual(['delete', 'revalidate']);
    expect(revalidation.revalidateStoreByCreatorId).toHaveBeenCalledWith('c1');
  });

  it('delete without a user (admin path) still revalidates the creator store', async () => {
    const { svc, revalidation } = setup();
    await svc.delete('cp1');
    expect(revalidation.revalidateStoreByCreatorId).toHaveBeenCalledWith('c1');
  });

  it('approve and reject revalidate the creator store', async () => {
    const { svc, revalidation } = setup();
    await svc.approve('cp1', 'prov-user');
    await svc.reject('cp1', 'prov-user', 'blurry print');
    expect(revalidation.revalidateStoreByCreatorId).toHaveBeenCalledTimes(2);
    expect(revalidation.revalidateStoreByCreatorId).toHaveBeenCalledWith('c1');
  });

  it('approve revalidates even when the step after the write throws', async () => {
    const { svc, prisma, revalidation } = setup();
    (
      svc as unknown as { notificationsService: { create: jest.Mock } }
    ).notificationsService.create = jest.fn(() =>
      Promise.reject(new Error('mail down')),
    );
    await expect(svc.approve('cp1', 'prov-user')).rejects.toThrow('mail down');
    expect(prisma.customProduct.update).toHaveBeenCalled();
    expect(revalidation.revalidateStoreByCreatorId).toHaveBeenCalledWith('c1');
  });

  it('FAQ create, update and delete revalidate the creator store', async () => {
    const { svc, revalidation } = setup();
    const translations = [{ locale: 'en', question: 'Q', answer: '<p>A</p>' }];
    await svc.createFaq('cp1', 'u1', { translations });
    await svc.updateFaq('f1', 'u1', { translations });
    await svc.deleteFaq('f1', 'u1');
    expect(revalidation.revalidateStoreByCreatorId).toHaveBeenCalledTimes(3);
  });
});
