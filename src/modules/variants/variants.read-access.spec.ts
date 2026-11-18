import { ProductStatus, UserRole } from '@prisma/client';
import { VariantsService } from './variants.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';

// Supplier privacy: variant reads carry stock and price adjustments, so they
// follow the product visibility of GET /products/:id (catalogueReadLevel):
// the owner and admins in full, a creator on a PUBLISHED provider product
// without the importer identity, everyone else a 404.

const variantRow = (id: string) => ({
  id,
  product_id: 'p1',
  sku: `SKU-${id}`,
  price_adjustment: 5,
  stock_quantity: 4,
  external_ref: `woo:var:${id}`,
  images: [],
});

function setup(
  product: {
    provider_id: string | null;
    creator_id: string | null;
    status: ProductStatus;
  },
  providerVerified = true,
) {
  const prisma = {
    product: { findUnique: jest.fn(() => Promise.resolve(product)) },
    productVariant: {
      findMany: jest.fn(() =>
        Promise.resolve([variantRow('v1'), variantRow('v2')]),
      ),
      findUnique: jest.fn(() =>
        Promise.resolve({ ...variantRow('v1'), product }),
      ),
    },
    provider: {
      findUnique: jest.fn(
        ({ where }: { where: { user_id?: string; id?: string } }) =>
          Promise.resolve(
            where.id
              ? { verified: providerVerified }
              : where.user_id === 'u-prov'
                ? { id: 'pA' }
                : null,
          ),
      ),
    },
    // Provider approval required (the platform default).
    platformConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve({ require_provider_approval: true }),
      ),
    },
    creator: {
      findUnique: jest.fn(({ where }: { where: { user_id: string } }) =>
        Promise.resolve(where.user_id === 'u-creator' ? { id: 'c1' } : null),
      ),
    },
  };
  const svc = new VariantsService(
    prisma as unknown as PrismaService,
    {} as RevalidationService,
  );
  return { svc, prisma };
}

const PUBLISHED_PROVIDER = {
  provider_id: 'pA',
  creator_id: null,
  status: ProductStatus.PUBLISHED,
};

describe('variant reads: visibility', () => {
  it('a creator on a PUBLISHED product of an unverified provider (approval required): 404', async () => {
    const { svc } = setup(PUBLISHED_PROVIDER, false);
    await expect(
      svc.findByProduct('p1', 'u-creator', UserRole.CREATOR),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.findById('v1', 'u-creator', UserRole.CREATOR),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('the owning provider gets the full rows (list and one)', async () => {
    const { svc } = setup({
      ...PUBLISHED_PROVIDER,
      status: ProductStatus.DRAFT,
    });
    const rows = await svc.findByProduct('p1', 'u-prov', UserRole.PROVIDER);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      external_ref: 'woo:var:v1',
      stock_quantity: 4,
    });
    const one = await svc.findById('v1', 'u-prov', UserRole.PROVIDER);
    expect(one).toMatchObject({ id: 'v1', external_ref: 'woo:var:v1' });
    // The product relation loaded for the check is not served.
    expect(one).not.toHaveProperty('product');
  });

  it('an admin gets the full rows', async () => {
    const { svc } = setup({
      ...PUBLISHED_PROVIDER,
      status: ProductStatus.DRAFT,
    });
    const rows = await svc.findByProduct('p1', 'u-admin', UserRole.ADMIN);
    expect(rows[0]).toHaveProperty('external_ref');
  });

  it('a creator on a PUBLISHED provider product: rows without external_ref', async () => {
    const { svc } = setup(PUBLISHED_PROVIDER);
    const rows = (await svc.findByProduct(
      'p1',
      'u-creator',
      UserRole.CREATOR,
    )) as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).not.toHaveProperty('external_ref');
    expect(rows[0]).toMatchObject({ stock_quantity: 4, price_adjustment: 5 });
    const one = await svc.findById('v1', 'u-creator', UserRole.CREATOR);
    expect(one).not.toHaveProperty('external_ref');
    expect(one).not.toHaveProperty('product');
  });

  it('a competing provider: 404, the variants are never read', async () => {
    // u-prov is provider pA; the product belongs to pB.
    const foreign = setup({ ...PUBLISHED_PROVIDER, provider_id: 'pB' });
    await expect(
      foreign.svc.findByProduct('p1', 'u-prov', UserRole.PROVIDER),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'PRODUCT_NOT_FOUND' },
    });
    expect(foreign.prisma.productVariant.findMany).not.toHaveBeenCalled();
    await expect(
      foreign.svc.findById('v1', 'u-prov', UserRole.PROVIDER),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'VARIANT_NOT_FOUND' },
    });
  });

  it('a creator on a DRAFT provider product: 404', async () => {
    const { svc } = setup({
      ...PUBLISHED_PROVIDER,
      status: ProductStatus.DRAFT,
    });
    await expect(
      svc.findByProduct('p1', 'u-creator', UserRole.CREATOR),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.findById('v1', 'u-creator', UserRole.CREATOR),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'VARIANT_NOT_FOUND' },
    });
  });

  it('an unknown product or variant: 404', async () => {
    const { svc, prisma } = setup(PUBLISHED_PROVIDER);
    prisma.product.findUnique.mockResolvedValueOnce(null as never);
    await expect(
      svc.findByProduct('nope', 'u-admin', UserRole.ADMIN),
    ).rejects.toMatchObject({ status: 404 });
    prisma.productVariant.findUnique.mockResolvedValueOnce(null as never);
    await expect(
      svc.findById('nope', 'u-admin', UserRole.ADMIN),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'VARIANT_NOT_FOUND' },
    });
  });
});
