import { PricingType, StoreType } from '@prisma/client';
import { StorefrontService } from './storefront.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { TaxService } from '../taxes/tax.service';

// Customer stories (customer-stories contract 2/3.4): storefront payloads
// carry `stories` only when there is at least one (Namez byte-identity: the
// payload equals the one built before stories existed), own products on both
// store kinds, custom products inherit the base product's stories (S7) even
// when mockups replace the images, and the template preview sample product
// follows the same rule.

function ownProduct(videos: unknown[], extra: Record<string, unknown> = {}) {
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
    images: [{ id: 'i1', url: '/uploads/products/a.webp', alt_text: null }],
    videos,
    attributes: [],
    variants: [],
    category: null,
    creator_categories: [],
    custom_fields: [],
    faqs: [],
    shipping_profile: null,
    ...extra,
  };
}

function customProduct(opts: {
  videos: unknown[];
  mockups: unknown[];
  stories?: unknown[];
}) {
  return {
    id: 'cp1',
    creator_id: 'c1',
    status: 'PUBLISHED',
    pricing_type: PricingType.SINGLE,
    final_price: 199,
    primary_creator_category_id: null,
    translations: [],
    mockup_images: opts.mockups,
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
      images: [{ id: 'bi1', url: '/uploads/products/base.webp' }],
      videos: opts.videos,
      ...(opts.stories ? { stories: opts.stories } : {}),
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

const STORY_ROW = {
  id: 's1',
  product_id: 'base',
  kind: 'IMAGE',
  url: '/uploads/products/story.webp',
  poster_url: null,
  duration_s: null,
  width: 800,
  height: 1000,
  name: 'Anna',
  rating: 5,
  verified: true,
  sort_order: 0,
  autoplay: false,
  loop: false,
  created_at: new Date('2026-11-14T10:00:00Z'),
  updated_at: new Date('2026-11-14T10:00:00Z'),
  translations: [{ locale: 'sv', quote: 'Bra!', subtitle: 'Stockholm' }],
};

const STORY_OUT = {
  id: 's1',
  kind: 'image',
  url: '/uploads/products/story.webp',
  poster_url: null,
  duration_s: null,
  width: 800,
  height: 1000,
  name: 'Anna',
  rating: 5,
  verified: true,
  autoplay: false,
  loop: false,
  translations: [{ locale: 'sv', quote: 'Bra!', subtitle: 'Stockholm' }],
};

const get = (service: StorefrontService) =>
  service.getProduct('shop', 'produkt', 'sv') as Promise<
    Record<string, unknown>
  >;

type FindArgs = { include: Record<string, unknown> };

const sampleOf = (service: StorefrontService) => {
  (service as unknown as { open: () => Promise<boolean> }).open = () =>
    Promise.resolve(true);
  return service.getSampleProduct('shop') as Promise<Record<string, unknown>>;
};

describe('StorefrontService customer stories', () => {
  it.each([StoreType.INDEPENDENT, StoreType.MARKETPLACE])(
    'own product without stories (%s): payload equals the pre-stories payload',
    async (storeType) => {
      const now = build({ storeType, own: ownProduct([], { stories: [] }) });
      const before = build({ storeType, own: ownProduct([]) });
      const payload = await get(now.service);
      expect(payload).not.toHaveProperty('stories');
      expect(payload).toEqual(await get(before.service));
      // The include asks for the ordered rows with their translations.
      const args = now.prisma.product.findFirst.mock.calls[0][0] as FindArgs;
      expect(args.include.stories).toEqual({
        orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
        include: {
          translations: {
            select: { locale: true, quote: true, subtitle: true },
            orderBy: { locale: 'asc' },
          },
        },
      });
    },
  );

  it.each([StoreType.INDEPENDENT, StoreType.MARKETPLACE])(
    'own product with a story (%s): mapped wire shape',
    async (storeType) => {
      const { service } = build({
        storeType,
        own: ownProduct([], { stories: [STORY_ROW] }),
      });
      const payload = await get(service);
      expect(payload.stories).toEqual([STORY_OUT]);
    },
  );

  it('custom product without base stories: payload equals the pre-stories payload', async () => {
    const now = build({
      storeType: StoreType.MARKETPLACE,
      custom: customProduct({ videos: [], mockups: [], stories: [] }),
    });
    const before = build({
      storeType: StoreType.MARKETPLACE,
      custom: customProduct({ videos: [], mockups: [] }),
    });
    const payload = await get(now.service);
    expect(payload._type).toBe('custom_product');
    expect(payload).not.toHaveProperty('stories');
    expect(payload).toEqual(await get(before.service));
  });

  it('custom product with mockups still carries the base product stories (S7)', async () => {
    const { service, prisma } = build({
      storeType: StoreType.MARKETPLACE,
      custom: customProduct({
        videos: [],
        stories: [STORY_ROW],
        mockups: [{ url: '/uploads/products/mock.webp', sort_order: 0 }],
      }),
    });
    const payload = await get(service);
    expect(payload.images).toEqual([
      { url: '/uploads/products/mock.webp', alt_text: null, sort_order: 0 },
    ]);
    expect(payload.stories).toEqual([STORY_OUT]);
    const full = prisma.customProduct.findFirst.mock.calls
      .map((c) => c[0] as FindArgs)
      .find((a) => a.include);
    const base = full?.include.product as FindArgs;
    expect(base.include.stories).toBeDefined();
  });

  it('template preview sample product follows the omission rule', async () => {
    const sample = (extra: Record<string, unknown>) => ({
      ...ownProduct([], extra),
      translations: [{ locale: 'sv', title: 'T', description: '', slug: 't' }],
    });
    const now = await sampleOf(
      build({ storeType: StoreType.INDEPENDENT, own: sample({ stories: [] }) })
        .service,
    );
    const before = await sampleOf(
      build({ storeType: StoreType.INDEPENDENT, own: sample({}) }).service,
    );
    expect(now).not.toHaveProperty('stories');
    expect(now).toEqual(before);

    const withStory = await sampleOf(
      build({
        storeType: StoreType.INDEPENDENT,
        own: sample({ stories: [STORY_ROW] }),
      }).service,
    );
    expect(withStory.stories).toEqual([STORY_OUT]);
  });
});
