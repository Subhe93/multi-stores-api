import { NotFoundException } from '@nestjs/common';
import { StoreStatus, StoreType } from '@prisma/client';
import { StorefrontService } from './storefront.service';

// Builder preview sample product (GET /storefront/:slug/v2/sample-product).
// Own products first on both store kinds; a MARKETPLACE (influencer) store
// with no own product falls back to the creator's most recently updated
// published custom product, served exactly as the product page serves it.

function build(opts: {
  storeType: StoreType;
  own?: Record<string, unknown> | null;
  custom?: Record<string, unknown> | null;
}) {
  const store = {
    id: 's1',
    slug: 'noroj',
    creator_id: 'c1',
    store_type: opts.storeType,
    status: StoreStatus.LIVE,
    creator: { id: 'c1' },
  };
  const prisma = {
    store: { findUnique: jest.fn(() => Promise.resolve(store)) },
    product: { findFirst: jest.fn(() => Promise.resolve(opts.own ?? null)) },
    customProduct: {
      findFirst: jest.fn(() => Promise.resolve(opts.custom ?? null)),
    },
  };
  const service = new StorefrontService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, prisma };
}

const ownRow = {
  id: 'own1',
  base_price: 20,
  compare_at_price: null,
  translations: [
    { locale: 'en', title: 'Mug', description: null, slug: 'mug' },
  ],
  images: [],
  variant_option_config: null,
  variants: [],
  faqs: [],
};

const customRow = {
  id: 'cp1',
  translations: [{ slug: '' }, { slug: 'bosphorus-poster' }],
};

const productPagePayload = {
  id: 'cp1',
  base_price: 30,
  _type: 'custom_product' as const,
  images: [{ url: '/m.png', alt_text: null, sort_order: 0 }],
};

describe('StorefrontService.getSampleProduct', () => {
  it('serves the own product first on a MARKETPLACE store', async () => {
    const { service, prisma } = build({
      storeType: StoreType.MARKETPLACE,
      own: ownRow,
      custom: customRow,
    });
    const r = await service.getSampleProduct('noroj');
    expect(r).toMatchObject({ id: 'own1', slug: 'mug' });
    expect(prisma.customProduct.findFirst).not.toHaveBeenCalled();
  });

  it('falls back to the latest published custom product on a MARKETPLACE store', async () => {
    const { service, prisma } = build({
      storeType: StoreType.MARKETPLACE,
      custom: customRow,
    });
    const getProduct = jest
      .spyOn(service, 'getProduct')
      .mockResolvedValue(productPagePayload as never);
    const viewer = { userId: 'owner' } as never;
    const r = await service.getSampleProduct('noroj', viewer);

    expect(prisma.customProduct.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { creator_id: 'c1', status: 'PUBLISHED' },
        orderBy: { updated_at: 'desc' },
      }),
    );
    // The product page's own payload (same shape), plus the sample's slug.
    expect(getProduct).toHaveBeenCalledWith(
      'noroj',
      'bosphorus-poster',
      undefined,
      undefined,
      undefined,
      viewer,
    );
    expect(r).toEqual({ ...productPagePayload, slug: 'bosphorus-poster' });
  });

  it('returns null when the product page resolves something else', async () => {
    const { service } = build({
      storeType: StoreType.MARKETPLACE,
      custom: customRow,
    });
    jest
      .spyOn(service, 'getProduct')
      .mockResolvedValue({ ...productPagePayload, id: 'draft-own' } as never);
    await expect(service.getSampleProduct('noroj')).resolves.toBeNull();
  });

  it('returns null when the custom product page 404s', async () => {
    const { service } = build({
      storeType: StoreType.MARKETPLACE,
      custom: customRow,
    });
    jest
      .spyOn(service, 'getProduct')
      .mockRejectedValue(new NotFoundException());
    await expect(service.getSampleProduct('noroj')).resolves.toBeNull();
  });

  it('returns null on a MARKETPLACE store with no product at all', async () => {
    const { service } = build({ storeType: StoreType.MARKETPLACE });
    await expect(service.getSampleProduct('noroj')).resolves.toBeNull();
  });

  it('never falls back to custom products on an INDEPENDENT store', async () => {
    const { service, prisma } = build({
      storeType: StoreType.INDEPENDENT,
      custom: customRow,
    });
    const getProduct = jest.spyOn(service, 'getProduct');
    await expect(service.getSampleProduct('noroj')).resolves.toBeNull();
    expect(prisma.customProduct.findFirst).not.toHaveBeenCalled();
    expect(getProduct).not.toHaveBeenCalled();
  });

  it('keeps the own product on an INDEPENDENT store', async () => {
    const { service } = build({
      storeType: StoreType.INDEPENDENT,
      own: ownRow,
    });
    await expect(service.getSampleProduct('noroj')).resolves.toMatchObject({
      id: 'own1',
      slug: 'mug',
    });
  });
});
