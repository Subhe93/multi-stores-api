import { PricingType, StoreType } from '@prisma/client';
import { StorefrontService } from './storefront.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { TaxService } from '../taxes/tax.service';

// M170 A: the product page payload carries `images[].alt_translations` only
// on images that have a map; an image without one keeps exactly its previous
// keys. Only the two product-page image includes opt in to the column.

const PLAIN = {
  id: 'i1',
  product_id: 'p1',
  variant_id: null,
  url: '/uploads/products/a.webp',
  alt_text: 'Röd dalahäst',
  sort_order: 0,
  is_featured: true,
};
const LOCALIZED = {
  id: 'i2',
  product_id: 'p1',
  variant_id: null,
  url: '/uploads/products/b.webp',
  alt_text: null,
  sort_order: 1,
  is_featured: false,
};

function ownProduct(images: unknown[]) {
  return {
    id: 'p1',
    creator_id: 'c1',
    provider_id: null,
    base_price: 299,
    compare_at_price: null,
    variant_option_config: null,
    tax_class_id: null,
    tax_exempt: false,
    translations: [],
    images,
    videos: [],
    attributes: [],
    variants: [],
    category: null,
    creator_categories: [],
    custom_fields: [],
    faqs: [],
    shipping_profile: null,
  };
}

function customProduct(images: unknown[], mockups: unknown[] = []) {
  return {
    id: 'cp1',
    creator_id: 'c1',
    status: 'PUBLISHED',
    pricing_type: PricingType.SINGLE,
    final_price: 199,
    primary_creator_category_id: null,
    translations: [],
    mockup_images: mockups,
    selected_variants: [],
    field_values: [],
    faqs: [],
    creator_categories: [],
    product: {
      id: 'base',
      provider_id: null,
      compare_at_price: null,
      product_type: 'TRADITIONAL',
      customization_type: null,
      variant_option_config: null,
      tax_class_id: null,
      tax_exempt: false,
      images,
      videos: [],
      attributes: [],
      variants: [],
      category: null,
      provider: null,
      custom_fields: [],
      faqs: [],
      shipping_profile: null,
    },
  };
}

function build(opts: {
  storeType: StoreType;
  own?: unknown;
  custom?: unknown;
}) {
  const store = {
    id: 's1',
    slug: 'shop',
    creator_id: 'c1',
    store_type: opts.storeType,
    show_vendor_name: false,
    currency: 'SEK',
    tax_country: 'SE',
    creator: { id: 'c1' },
  };
  const prisma = {
    store: { findUnique: jest.fn(() => Promise.resolve(store)) },
    product: {
      findFirst: jest.fn((_args: unknown) => Promise.resolve(opts.own ?? null)),
    },
    customProduct: {
      findFirst: jest.fn((_args: unknown) =>
        Promise.resolve(opts.custom ?? null),
      ),
    },
    promotion: { findMany: jest.fn(() => Promise.resolve([])) },
    bundle: { findMany: jest.fn(() => Promise.resolve([])) },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'EUR' })),
    },
  };
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(false)),
    getSettings: jest.fn(() => Promise.resolve({})),
  };
  const service = new StorefrontService(
    prisma as unknown as PrismaService,
    storeApps as unknown as StoreAppsService,
    {
      resolve: jest.fn(() => Promise.resolve(null)),
    } as unknown as MarketsContextService,
    {} as MarketPricingService,
    {} as TaxService,
  );
  return { service, prisma };
}

const get = (service: StorefrontService) =>
  service.getProduct('shop', 'produkt', 'sv') as Promise<
    Record<string, unknown>
  >;

type FindArgs = { include: Record<string, unknown> };

const PAGE_IMAGES_INCLUDE = {
  where: { variant_id: null },
  orderBy: [{ is_featured: 'desc' }, { sort_order: 'asc' }],
  omit: { alt_translations: false },
};

describe('StorefrontService product page image alt translations', () => {
  it('own product: the image include opts in to the column', async () => {
    const { service, prisma } = build({
      storeType: StoreType.INDEPENDENT,
      own: ownProduct([]),
    });
    await get(service);
    const args = prisma.product.findFirst.mock.calls[0][0] as FindArgs;
    expect(args.include.images).toEqual(PAGE_IMAGES_INCLUDE);
    // Variant-linked rows keep the global omit.
    expect(args.include.variants).toEqual({
      where: { is_active: true },
      include: { images: true },
    });
  });

  it('own product: the map is served only on images that have one', async () => {
    const { service } = build({
      storeType: StoreType.INDEPENDENT,
      own: ownProduct([
        { ...PLAIN, alt_translations: null },
        { ...LOCALIZED, alt_translations: { de: 'Rotes Pferd', en: 'Horse' } },
      ]),
    });
    const payload = await get(service);
    const images = payload.images as Record<string, unknown>[];
    // Exactly the previous keys, in the previous order.
    expect(images[0]).toEqual(PLAIN);
    expect(Object.keys(images[0])).toEqual(Object.keys(PLAIN));
    expect(images[1]).toEqual({
      ...LOCALIZED,
      alt_translations: { de: 'Rotes Pferd', en: 'Horse' },
    });
  });

  it('own product without localized alts: no key anywhere in the payload', async () => {
    const { service } = build({
      storeType: StoreType.MARKETPLACE,
      own: ownProduct([
        { ...PLAIN, alt_translations: null },
        { ...LOCALIZED, alt_translations: {} },
      ]),
    });
    const payload = await get(service);
    expect(JSON.stringify(payload)).not.toContain('alt_translations');
    expect(payload.images).toEqual([PLAIN, LOCALIZED]);
  });

  it('custom product: base images opt in and are shaped the same way', async () => {
    const { service, prisma } = build({
      storeType: StoreType.MARKETPLACE,
      custom: customProduct([
        { ...PLAIN, alt_translations: { de: 'Rotes Pferd' } },
        { ...LOCALIZED, alt_translations: null },
      ]),
    });
    const payload = await get(service);
    expect(payload._type).toBe('custom_product');
    expect(payload.images).toEqual([
      { ...PLAIN, alt_translations: { de: 'Rotes Pferd' } },
      LOCALIZED,
    ]);
    const full = prisma.customProduct.findFirst.mock.calls
      .map((c) => c[0] as FindArgs)
      .find((a) => a.include);
    const base = full?.include.product as FindArgs;
    expect(base.include.images).toEqual(PAGE_IMAGES_INCLUDE);
  });

  it('custom product with mockups: mockup rows are unchanged (no alt map)', async () => {
    const { service } = build({
      storeType: StoreType.MARKETPLACE,
      custom: customProduct(
        [{ ...PLAIN, alt_translations: { de: 'Rotes Pferd' } }],
        [{ url: '/uploads/products/mock.webp', sort_order: 0 }],
      ),
    });
    const payload = await get(service);
    expect(payload.images).toEqual([
      { url: '/uploads/products/mock.webp', alt_text: null, sort_order: 0 },
    ]);
  });

  it('the template preview sample product never opts in to the column', async () => {
    const sample = {
      ...ownProduct([{ ...PLAIN }]),
      translations: [{ locale: 'sv', title: 'T', description: '', slug: 't' }],
    };
    const { service, prisma } = build({
      storeType: StoreType.INDEPENDENT,
      own: sample,
    });
    (service as unknown as { open: () => Promise<boolean> }).open = () =>
      Promise.resolve(true);
    const out = await service.getSampleProduct('shop');
    expect(JSON.stringify(out)).not.toContain('alt_translations');
    for (const call of prisma.product.findFirst.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain('alt_translations');
    }
  });
});
