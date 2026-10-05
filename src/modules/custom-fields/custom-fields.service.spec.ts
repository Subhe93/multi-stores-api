import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CustomFieldsService } from './custom-fields.service';
import { PrismaService } from '../../prisma/prisma.service';

// The service is exercised against a hand-rolled PrismaService mock: each
// scenario seeds the product's owner links and checks the ownership gate.

type ProductRow = {
  id: string;
  provider: { user_id: string } | null;
  creator: { user_id: string } | null;
};

function makePrisma(products: ProductRow[]) {
  const fields = new Map<string, { id: string; product_id: string }>([
    ['f1', { id: 'f1', product_id: 'p-provider' }],
    ['f2', { id: 'f2', product_id: 'p-creator' }],
  ]);
  return {
    product: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(products.find((p) => p.id === where.id) ?? null),
      ),
    },
    productCustomField: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(fields.get(where.id) ?? null),
      ),
      create: jest.fn((args: unknown) => Promise.resolve({ created: args })),
      update: jest.fn((args: unknown) => Promise.resolve({ updated: args })),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      delete: jest.fn((args: unknown) => Promise.resolve({ deleted: args })),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    customFieldTranslation: {
      deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
  };
}

const PRODUCTS: ProductRow[] = [
  { id: 'p-provider', provider: { user_id: 'u-prov' }, creator: null },
  { id: 'p-creator', provider: null, creator: { user_id: 'u-creator' } },
];

const dto = { field_type: 'TEXT', is_required: false } as never;

describe('CustomFieldsService ownership', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: CustomFieldsService;

  beforeEach(() => {
    prisma = makePrisma(PRODUCTS);
    service = new CustomFieldsService(prisma as unknown as PrismaService);
  });

  it('lets the owning provider create a field', async () => {
    await expect(
      service.create('p-provider', dto, 'u-prov', UserRole.PROVIDER),
    ).resolves.toBeDefined();
    expect(prisma.productCustomField.create).toHaveBeenCalledTimes(1);
  });

  it('refuses another provider with CUSTOM_FIELD_FORBIDDEN', async () => {
    const err = await service
      .create('p-provider', dto, 'u-other', UserRole.PROVIDER)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      code: 'CUSTOM_FIELD_FORBIDDEN',
    });
    expect(prisma.productCustomField.create).not.toHaveBeenCalled();
  });

  it('lets an admin manage any product', async () => {
    await expect(
      service.create('p-provider', dto, 'u-admin', UserRole.ADMIN),
    ).resolves.toBeDefined();
    await expect(
      service.delete('f2', 'u-admin', UserRole.ADMIN),
    ).resolves.toBeDefined();
  });

  it('lets the owning creator manage a creator-owned product', async () => {
    await expect(
      service.create('p-creator', dto, 'u-creator', UserRole.CREATOR),
    ).resolves.toBeDefined();
    await expect(
      service.update('f2', dto, 'u-creator', UserRole.CREATOR),
    ).resolves.toBeDefined();
    await expect(
      service.reorder('p-creator', ['f2'], 'u-creator', UserRole.CREATOR),
    ).resolves.toBeDefined();
  });

  it('refuses a creator on a provider-owned product', async () => {
    await expect(
      service.create('p-provider', dto, 'u-creator', UserRole.CREATOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('resolves update/delete ownership through the field product_id', async () => {
    // f1 belongs to p-provider: a foreign provider must be refused.
    await expect(
      service.update('f1', dto, 'u-other', UserRole.PROVIDER),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.delete('f1', 'u-other', UserRole.PROVIDER),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.productCustomField.update).not.toHaveBeenCalled();
    expect(prisma.productCustomField.delete).not.toHaveBeenCalled();

    // The owner goes through.
    await expect(
      service.delete('f1', 'u-prov', UserRole.PROVIDER),
    ).resolves.toBeDefined();
  });

  it('reports a missing field or product as not found', async () => {
    await expect(
      service.delete('missing', 'u-prov', UserRole.PROVIDER),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.create('missing', dto, 'u-prov', UserRole.PROVIDER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('scopes reorder writes to the product', async () => {
    await service.reorder(
      'p-provider',
      ['f1', 'foreign'],
      'u-prov',
      UserRole.PROVIDER,
    );
    expect(prisma.productCustomField.updateMany).toHaveBeenCalledWith({
      where: { id: 'foreign', product_id: 'p-provider' },
      data: { sort_order: 1 },
    });
  });
});
