import { CustomProductsService } from './custom-products.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RedirectsService } from '../redirects/redirects.service';

// Provider approval gate (SPEC §4): while the platform requires provider
// approval, an unverified provider's products are out of the creator
// catalogue. Importing one by id, or asking for its price floor, is refused
// the same way as a draft product.

function setup(verified: boolean) {
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    product: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          status: 'PUBLISHED',
          provider_id: 'prov',
          tax_class_id: null,
          tax_exempt: false,
        }),
      ),
    },
    platformConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve({ require_provider_approval: true }),
      ),
    },
    provider: {
      findUnique: jest.fn(() => Promise.resolve({ verified })),
    },
    customProduct: { create: jest.fn() },
  };
  const svc = new CustomProductsService(
    prisma as unknown as PrismaService,
    {} as never,
    {} as unknown as RedirectsService,
  );
  const internals = svc as unknown as Record<string, unknown>;
  internals.assertStoreAllowsCustomProducts = jest.fn(() => Promise.resolve());
  internals.loadFloorSetup = jest.fn(() => null);
  return { svc, prisma };
}

const dto = {
  product_id: 'base',
  import_mode: 'AS_IS',
  pricing_type: 'SINGLE',
  final_price: 10,
  translations: [{ locale: 'sv', title: 'T', slug: 't' }],
} as never;

describe('CustomProductsService provider approval gate', () => {
  it('create: an unverified provider product is not importable', async () => {
    const { svc, prisma } = setup(false);
    await expect(svc.create('u', dto)).rejects.toMatchObject({
      status: 400,
      response: { code: 'CUSTOM_PRODUCT_BASE_NOT_IMPORTABLE' },
    });
    expect(prisma.provider.findUnique).toHaveBeenCalledWith({
      where: { id: 'prov' },
      select: { verified: true },
    });
    expect(prisma.customProduct.create).not.toHaveBeenCalled();
  });

  it('price floor: an unverified provider product is not found', async () => {
    const { svc } = setup(false);
    await expect(svc.getPriceFloor('u', 'base')).rejects.toMatchObject({
      status: 404,
      response: { code: 'CUSTOM_PRODUCT_BASE_PRODUCT_NOT_FOUND' },
    });
  });

  it('price floor: a verified provider product passes the gate', async () => {
    const { svc } = setup(true);
    // No tax engine in this harness: the floor is not enforced (null).
    await expect(svc.getPriceFloor('u', 'base')).resolves.toBeNull();
  });
});

// The base product served with a custom product (list, detail, create and
// update results) never carries the provider's confidential cost_price or
// importer identities, on the product or on its variants.
describe('CustomProductsService base product columns', () => {
  it('the includes omit cost_price and external_ref', () => {
    const { svc } = setup(true);
    const internals = svc as unknown as {
      includes: {
        product: { omit: unknown; include: { variants: { omit: unknown } } };
        selected_variants: { include: { variant: { omit: unknown } } };
      };
      detailIncludes: { product: { omit: unknown } };
    };
    const productOmit = { cost_price: true, external_ref: true };
    expect(internals.includes.product.omit).toEqual(productOmit);
    expect(internals.detailIncludes.product.omit).toEqual(productOmit);
    expect(internals.includes.product.include.variants.omit).toEqual({
      external_ref: true,
    });
    expect(internals.includes.selected_variants.include.variant.omit).toEqual({
      external_ref: true,
    });
  });
});
