import { ProductStatus, UserRole } from '@prisma/client';
import { ProductsService } from './products.service';
import type { PrismaService } from '../../prisma/prisma.service';

// Mutations outside update() / delete() must refresh the storefront cache
// too: an unpublished product otherwise stays visible on the store.

function setup(product: {
  id: string;
  creator_id: string | null;
  provider_id: string | null;
}) {
  const prisma = {
    product: {
      findUnique: jest.fn(() => Promise.resolve(product)),
      update: jest.fn(({ data }: { data: object }) =>
        Promise.resolve({ ...product, ...data }),
      ),
    },
    productImage: {
      findUnique: jest.fn(() =>
        Promise.resolve({ product_id: product.id, variant_id: 'v1' }),
      ),
      findMany: jest.fn(() => Promise.resolve([{ id: 'i1' }, { id: 'i2' }])),
      create: jest.fn(({ data }: { data: object }) => Promise.resolve(data)),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
      delete: jest.fn(() => Promise.resolve({ id: 'i1' })),
    },
  };
  const revalidation = {
    revalidateStoreByCreatorId: jest.fn(() => Promise.resolve()),
    revalidateStoresByBaseProductId: jest.fn(() => Promise.resolve()),
  };
  const svc = new ProductsService(
    prisma as unknown as PrismaService,
    {} as never,
    revalidation as never,
    {} as never,
  );
  (svc as unknown as Record<string, unknown>).checkOwnership = jest.fn(() =>
    Promise.resolve(),
  );
  return { svc, prisma, revalidation };
}

const own = { id: 'p1', creator_id: 'c1', provider_id: null };
const base = { id: 'base', creator_id: null, provider_id: 'prov1' };

describe('ProductsService storefront revalidation', () => {
  it.each([
    ProductStatus.PUBLISHED,
    ProductStatus.DRAFT,
    ProductStatus.ARCHIVED,
  ])('updateStatus(%s) revalidates the creator store', async (status) => {
    const { svc, prisma, revalidation } = setup(own);
    await svc.updateStatus('p1', status, 'u', UserRole.CREATOR);
    expect(prisma.product.update).toHaveBeenCalled();
    expect(revalidation.revalidateStoreByCreatorId).toHaveBeenCalledWith('c1');
    expect(revalidation.revalidateStoresByBaseProductId).not.toHaveBeenCalled();
  });

  it('updateStatus of a provider base product revalidates the reselling stores', async () => {
    const { svc, revalidation } = setup(base);
    await svc.updateStatus(
      'base',
      ProductStatus.ARCHIVED,
      'u',
      UserRole.PROVIDER,
    );
    expect(revalidation.revalidateStoresByBaseProductId).toHaveBeenCalledWith(
      'base',
    );
    expect(revalidation.revalidateStoreByCreatorId).not.toHaveBeenCalled();
  });

  it('updateStatus revalidates after the write', async () => {
    const { svc, prisma, revalidation } = setup(own);
    const order: string[] = [];
    prisma.product.update.mockImplementation(() => {
      order.push('write');
      return Promise.resolve(own);
    });
    revalidation.revalidateStoreByCreatorId.mockImplementation(() => {
      order.push('revalidate');
      return Promise.resolve();
    });
    await svc.updateStatus('p1', ProductStatus.DRAFT, 'u', UserRole.CREATOR);
    expect(order).toEqual(['write', 'revalidate']);
  });

  it('updateStatus revalidates even when the step after the write throws', async () => {
    const { svc, prisma, revalidation } = setup(own);
    // releaseLiveProductPaths reads the product again: make that read fail.
    (svc as unknown as Record<string, unknown>).redirects = {};
    prisma.product.findUnique
      .mockImplementationOnce(() => Promise.resolve(own))
      .mockImplementation(() => Promise.reject(new Error('db down')));
    await expect(
      svc.updateStatus('p1', ProductStatus.DRAFT, 'u', UserRole.CREATOR),
    ).rejects.toThrow();
    expect(prisma.product.update).toHaveBeenCalled();
    expect(revalidation.revalidateStoreByCreatorId).toHaveBeenCalledWith('c1');
  });

  it('addImage, deleteImage and reorderImages revalidate the creator store', async () => {
    const { svc, revalidation } = setup(own);
    await svc.addImage('p1', 'u', UserRole.CREATOR, '/uploads/a.jpg');
    await svc.deleteImage('i1', 'u', UserRole.CREATOR);
    await svc.reorderImages('p1', ['i2', 'i1'], 'u', UserRole.CREATOR);
    expect(revalidation.revalidateStoreByCreatorId).toHaveBeenCalledTimes(3);
    expect(revalidation.revalidateStoreByCreatorId).toHaveBeenCalledWith('c1');
  });

  it('an image change on a provider base product revalidates the reselling stores', async () => {
    const { svc, revalidation } = setup(base);
    await svc.addImage('base', 'u', UserRole.PROVIDER, '/uploads/a.jpg');
    await svc.deleteImage('i1', 'u', UserRole.PROVIDER);
    await svc.reorderImages('base', ['i2', 'i1'], 'u', UserRole.PROVIDER);
    expect(revalidation.revalidateStoresByBaseProductId).toHaveBeenCalledTimes(
      3,
    );
    expect(revalidation.revalidateStoresByBaseProductId).toHaveBeenCalledWith(
      'base',
    );
  });
});
