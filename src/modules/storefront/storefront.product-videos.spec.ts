import { PricingType, StoreType } from '@prisma/client';
import { StorefrontService } from './storefront.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { TaxService } from '../taxes/tax.service';

// Product video (contract section 2/3.3): storefront payloads carry
// `videos` only when there is at least one (Namez byte-identity), own
// products on both store kinds, custom products inherit the base product's
// videos (D5) even when mockups replace the images, and the template
// preview sample product follows the same rule.

const VIDEO_ROW = {
  id: 'v1',
  product_id: 'base',
  kind: 'YOUTUBE',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  poster_url: '/uploads/products/poster.webp',
  alt_text: 'Demo',
  duration_s: 30,
  width: 1920,
  height: 1080,
  position: 1,
  sort_order: 0,
  autoplay: false,
  loop: false,
  created_at: new Date('2026-11-13T10:00:00Z'),
  updated_at: new Date('2026-11-13T10:00:00Z'),
};

const VIDEO_OUT = {
  id: 'v1',
  kind: 'youtube',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  poster_url: '/uploads/products/poster.webp',
  duration_s: 30,
  width: 1920,
  height: 1080,
  position: 1,
  autoplay: false,
  loop: false,
  alt: 'Demo',
  created_at: '2026-11-13T10:00:00.000Z',
};

function ownProduct(videos: unknown[]) {
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
  };
}

function customProduct(opts: { videos: unknown[]; mockups: unknown[] }) {
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

describe('StorefrontService product videos', () => {
  it.each([StoreType.INDEPENDENT, StoreType.MARKETPLACE])(
    'own product without videos (%s): no `videos` key at all',
    async (storeType) => {
      const { service, prisma } = build({ storeType, own: ownProduct([]) });
      const payload = await get(service);
      expect(payload).not.toHaveProperty('videos');
      expect(JSON.stringify(payload)).not.toContain('videos');
      // The include asks for the ordered rows.
      const args = prisma.product.findFirst.mock.calls[0][0] as FindArgs;
      expect(args.include.videos).toEqual({
        orderBy: [{ position: 'asc' }, { sort_order: 'asc' }],
      });
    },
  );

  it.each([StoreType.INDEPENDENT, StoreType.MARKETPLACE])(
    'own product with a video (%s): mapped wire shape',
    async (storeType) => {
      const { service } = build({
        storeType,
        own: ownProduct([VIDEO_ROW]),
      });
      const payload = await get(service);
      expect(payload.videos).toEqual([VIDEO_OUT]);
    },
  );

  it('custom product without base videos: no `videos` key', async () => {
    const { service } = build({
      storeType: StoreType.MARKETPLACE,
      custom: customProduct({ videos: [], mockups: [] }),
    });
    const payload = await get(service);
    expect(payload._type).toBe('custom_product');
    expect(payload).not.toHaveProperty('videos');
  });

  it('custom product with mockups still carries the base product videos (D5)', async () => {
    const { service, prisma } = build({
      storeType: StoreType.MARKETPLACE,
      custom: customProduct({
        videos: [VIDEO_ROW],
        mockups: [{ url: '/uploads/products/mock.webp', sort_order: 0 }],
      }),
    });
    const payload = await get(service);
    expect(payload.images).toEqual([
      { url: '/uploads/products/mock.webp', alt_text: null, sort_order: 0 },
    ]);
    expect(payload.videos).toEqual([VIDEO_OUT]);
    // Videos come from the base product include, not from the custom row.
    const full = prisma.customProduct.findFirst.mock.calls
      .map((c) => c[0] as FindArgs)
      .find((a) => a.include);
    const base = full?.include.product as FindArgs;
    expect(base.include.videos).toBeDefined();
  });

  it('template preview sample product follows the omission rule', async () => {
    const sample = {
      ...ownProduct([]),
      translations: [{ locale: 'sv', title: 'T', description: '', slug: 't' }],
    };
    const empty = build({ storeType: StoreType.INDEPENDENT, own: sample });
    (empty.service as unknown as { open: () => Promise<boolean> }).open = () =>
      Promise.resolve(true);
    const r1 = (await empty.service.getSampleProduct('shop')) as Record<
      string,
      unknown
    >;
    expect(r1).not.toHaveProperty('videos');

    const withVideo = build({
      storeType: StoreType.INDEPENDENT,
      own: { ...sample, videos: [VIDEO_ROW] },
    });
    (withVideo.service as unknown as { open: () => Promise<boolean> }).open =
      () => Promise.resolve(true);
    const r2 = (await withVideo.service.getSampleProduct('shop')) as Record<
      string,
      unknown
    >;
    expect(r2.videos).toEqual([VIDEO_OUT]);
  });
});
