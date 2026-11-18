import { UserRole } from '@prisma/client';
import { VariantsService } from './variants.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';

// Variant price / stock is part of the storefront product payload: every
// write refreshes the stores that show the product.

function setup(product: {
  id: string;
  creator_id: string | null;
  provider_id: string | null;
}) {
  const prisma = {
    product: { findUnique: jest.fn(() => Promise.resolve(product)) },
    productVariant: {
      findUnique: jest.fn(() => Promise.resolve({ product })),
      create: jest.fn(() => Promise.resolve({ id: 'v1' })),
      update: jest.fn(() => Promise.resolve({ id: 'v1' })),
      delete: jest.fn(() => Promise.resolve({ id: 'v1' })),
    },
  };
  const revalidation = { revalidateStoresOfProduct: jest.fn() };
  const svc = new VariantsService(
    prisma as unknown as PrismaService,
    revalidation as unknown as RevalidationService,
  );
  return { svc, revalidation };
}

describe('VariantsService storefront revalidation', () => {
  it('create, update, delete and updateStock revalidate the stores of the product', async () => {
    const product = { id: 'base', creator_id: null, provider_id: 'prov1' };
    const { svc, revalidation } = setup(product);
    await svc.create('base', { sku: 'A' } as never, 'admin', UserRole.ADMIN);
    await svc.update('v1', { price: 5 } as never, 'admin', UserRole.ADMIN);
    await svc.updateStock('v1', 3, 'admin', UserRole.ADMIN);
    await svc.delete('v1', 'admin', UserRole.ADMIN);
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledTimes(4);
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledWith(
      product,
    );
  });
});
