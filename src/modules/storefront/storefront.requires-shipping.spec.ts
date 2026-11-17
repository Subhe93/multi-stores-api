import { PricingType, StoreType } from '@prisma/client';
import { StorefrontService } from './storefront.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { TaxService } from '../taxes/tax.service';

// Product detail of a product that requires no shipping (service / digital
// product): no shipping profile is served - not its own stored one and not
// a provider default - so the product page shows no shipping table. Own
// products always carry `requires_shipping`; a custom product carries the
// key only when its base product has it off.

const PROFILE = { id: 'sp1', name: 'Standard', zones: [] };
const DEFAULT_PROFILE = {
  id: 'sp-default',
  name: 'Provider default',
  zones: [],
};

function ownProduct(extra: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    creator_id: 'c1',
    provider_id: null,
    base_price: 299,
    compare_at_price: null,
    variant_option_config: null,
    tax_class_id: null,
    tax_exempt: false,
    requires_shipping: true,
    translations: [],
    images: [],
    videos: [],
    attributes: [],
    variants: [],
    category: null,
    creator_categories: [],
    custom_fields: [],
    faqs: [],
    shipping_profile_id: null,
    shipping_profile: null,
    ...extra,
  };
}

function customProduct(base: Record<string, unknown> = {}) {
  return {
    id: 'cp1',
    creator_id: 'c1',
    status: 'PUBLISHED',
    pricing_type: PricingType.SINGLE,
    final_price: 199,
    primary_creator_category_id: null,
    translations: [],
    mockup_images: [],
    selected_variants: [],
    field_values: [],
    faqs: [],
    creator_categories: [],
    product: {
      id: 'base',
      provider_id: 'prov1',
      compare_at_price: null,
      product_type: 'TRADITIONAL',
      customization_type: null,
      variant_option_config: null,
      tax_class_id: null,
      tax_exempt: false,
      images: [],
      videos: [],
      attributes: [],
      variants: [],
      category: null,
      provider: null,
      custom_fields: [],
      faqs: [],
      shipping_profile: null,
      ...base,
    },
  };
}

function build(opts: { own?: unknown; custom?: unknown }) {
  const store = {
    id: 's1',
    slug: 'shop',
    creator_id: 'c1',
    store_type: opts.custom ? StoreType.MARKETPLACE : StoreType.INDEPENDENT,
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
    shippingProfile: {
      findFirst: jest.fn((_args: unknown) => Promise.resolve(DEFAULT_PROFILE)),
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
  const get = () =>
    service.getProduct('shop', 'produkt', 'sv') as Promise<
      Record<string, unknown>
    >;
  return { prisma, get };
}

describe('own product detail', () => {
  it('requires shipping: its own profile is served, flag true', async () => {
    const { get, prisma } = build({
      own: ownProduct({ shipping_profile: PROFILE }),
    });
    const p = await get();
    expect(p.shipping_profile).toEqual(PROFILE);
    expect(p.requires_shipping).toBe(true);
    expect(prisma.shippingProfile.findFirst).not.toHaveBeenCalled();
  });

  it('requires shipping, no own profile: the provider default is served', async () => {
    const { get, prisma } = build({
      own: ownProduct({ provider_id: 'prov1' }),
    });
    const p = await get();
    expect(prisma.shippingProfile.findFirst).toHaveBeenCalledTimes(1);
    expect(p.shipping_profile).toEqual(DEFAULT_PROFILE);
  });

  it('no shipping: the stored profile is not served, flag false', async () => {
    const { get, prisma } = build({
      own: ownProduct({
        requires_shipping: false,
        shipping_profile_id: 'sp1',
        shipping_profile: PROFILE,
      }),
    });
    const p = await get();
    expect(p.shipping_profile).toBeNull();
    expect(p.requires_shipping).toBe(false);
    // The stored choice is kept on the row (re-enabling restores it).
    expect(p.shipping_profile_id).toBe('sp1');
    expect(prisma.shippingProfile.findFirst).not.toHaveBeenCalled();
  });

  it('no shipping: no provider default fallback', async () => {
    const { get, prisma } = build({
      own: ownProduct({ requires_shipping: false, provider_id: 'prov1' }),
    });
    const p = await get();
    expect(p.shipping_profile).toBeNull();
    expect(prisma.shippingProfile.findFirst).not.toHaveBeenCalled();
  });

  it('a row without the column behaves as "requires shipping"', async () => {
    const { requires_shipping: _flag, ...legacy } = ownProduct({
      shipping_profile: PROFILE,
    });
    const { get } = build({ own: legacy });
    const p = await get();
    expect(p.shipping_profile).toEqual(PROFILE);
    expect('requires_shipping' in p).toBe(false);
  });
});

describe('custom product detail', () => {
  it('base requires shipping: provider default served, no key', async () => {
    const { get, prisma } = build({ custom: customProduct() });
    const p = await get();
    expect(p._type).toBe('custom_product');
    expect(prisma.shippingProfile.findFirst).toHaveBeenCalledTimes(1);
    expect(p.shipping_profile).toEqual(DEFAULT_PROFILE);
    expect('requires_shipping' in p).toBe(false);
  });

  it('base requires shipping (flag true): still no key', async () => {
    const { get } = build({
      custom: customProduct({
        requires_shipping: true,
        shipping_profile: PROFILE,
      }),
    });
    const p = await get();
    expect(p.shipping_profile).toEqual(PROFILE);
    expect('requires_shipping' in p).toBe(false);
  });

  it('base requires no shipping: no profile, no default, key false', async () => {
    const { get, prisma } = build({
      custom: customProduct({
        requires_shipping: false,
        shipping_profile: PROFILE,
      }),
    });
    const p = await get();
    expect(p.shipping_profile).toBeNull();
    expect(p.requires_shipping).toBe(false);
    expect(prisma.shippingProfile.findFirst).not.toHaveBeenCalled();
  });
});
