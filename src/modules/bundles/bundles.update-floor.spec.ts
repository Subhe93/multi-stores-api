import { BundlesService } from './bundles.service';
import type { PrismaService } from '../../prisma/prisma.service';

// Bundle edits run the (gross) floor only on a real change: every member
// when the discount changed, else just the newly attached members.

function build() {
  const existing = {
    creator_id: 'c1',
    offers: [{ quantity: 2, discount_type: 'PERCENTAGE', discount_value: 10 }],
    products: [{ product_id: 'p1' }],
    custom_products: [{ custom_product_id: 'cp1' }],
  };
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    bundle: {
      findUnique: jest.fn(() => Promise.resolve(existing)),
      update: jest.fn(() => ({})),
    },
    bundleTranslation: { deleteMany: jest.fn(), createMany: jest.fn() },
    bundleOffer: { deleteMany: jest.fn(), create: jest.fn() },
    bundleProduct: { deleteMany: jest.fn(), createMany: jest.fn() },
    bundleCustomProduct: { deleteMany: jest.fn(), createMany: jest.fn() },
    $transaction: jest.fn(() => Promise.resolve([])),
  };
  const service = new BundlesService(prisma as unknown as PrismaService);
  const check = jest
    .spyOn(service, 'assertBundleEconomicallyValid')
    .mockResolvedValue(undefined);
  return { service, check };
}

const sameOffer = {
  quantity: 2,
  discount_type: 'PERCENTAGE',
  discount_value: 10,
};

describe('BundlesService.update floor check', () => {
  it('unchanged offers + members check nothing (text edit)', async () => {
    const { service, check } = build();
    await service.update('b1', 'u1', {
      offers: [sameOffer],
      product_ids: ['p1'],
      custom_product_ids: ['cp1'],
    } as never);
    expect(check).toHaveBeenCalledWith(expect.anything(), [], []);
  });

  it('unchanged offers check only newly attached members', async () => {
    const { service, check } = build();
    await service.update('b1', 'u1', {
      custom_product_ids: ['cp1', 'cp2'],
    } as never);
    expect(check).toHaveBeenCalledWith(expect.anything(), [], ['cp2']);
  });

  it('a changed discount checks every member', async () => {
    const { service, check } = build();
    await service.update('b1', 'u1', {
      offers: [{ ...sameOffer, discount_value: 20 }],
    } as never);
    expect(check).toHaveBeenCalledWith(expect.anything(), ['p1'], ['cp1']);
  });
});
