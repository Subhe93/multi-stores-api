import { StoreType } from '@prisma/client';
import { StorefrontService } from './storefront.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { TaxService } from '../taxes/tax.service';

// A MANUAL collection lists own + custom products merged in the creator's
// drag order (link sort_order, one index space), newest first on ties.
// TAGS collections and plain lists keep own-then-custom by date.

const CC = '11111111-1111-1111-1111-111111111111';

function own(id: string, created: string) {
  return {
    id,
    creator_id: 'c1',
    base_price: 100,
    compare_at_price: null,
    tax_class_id: null,
    tax_exempt: false,
    created_at: new Date(created),
    translations: [],
    images: [],
    variants: [],
    category: null,
  };
}

function custom(id: string, created: string) {
  return {
    id,
    status: 'PUBLISHED',
    pricing_type: 'SINGLE',
    final_price: 50,
    created_at: new Date(created),
    translations: [],
    mockup_images: [],
    selected_variants: [],
    product: {
      images: [],
      variants: [],
      category: null,
      provider: null,
      tax_class_id: null,
      tax_exempt: false,
    },
  };
}

function build(opts: {
  matchRule: 'MANUAL' | 'TAGS';
  ownLinks: { product_id: string; sort_order: number }[];
  customLinks: { custom_product_id: string; sort_order: number }[];
}) {
  const store = {
    id: 's1',
    slug: 'shop',
    creator_id: 'c1',
    store_type: StoreType.MARKETPLACE,
    show_vendor_name: false,
    creator: { id: 'c1' },
  };
  // Findmany order = created_at desc, as Prisma would return it.
  const ownRows = [
    own('p-new', '2026-10-03'),
    own('p-mid', '2026-10-02'),
    own('p-old', '2026-10-01'),
  ];
  const customRows = [
    custom('cp-new', '2026-10-03'),
    custom('cp-old', '2026-09-01'),
  ];
  const collection = {
    id: CC,
    match_rule: opts.matchRule,
    match_tags: ['x'],
    is_active: true,
    visibility: 'PUBLIC',
  };
  const prisma = {
    store: { findUnique: jest.fn(() => Promise.resolve(store)) },
    creatorCategory: {
      findUnique: jest.fn(() => Promise.resolve(collection)),
      findFirst: jest.fn(() => Promise.resolve(collection)),
    },
    product: { findMany: jest.fn(() => Promise.resolve(ownRows)) },
    customProduct: { findMany: jest.fn(() => Promise.resolve(customRows)) },
    productCreatorCategory: {
      findMany: jest.fn(() => Promise.resolve(opts.ownLinks)),
    },
    customProductCreatorCategory: {
      findMany: jest.fn(() => Promise.resolve(opts.customLinks)),
    },
    promotion: { findMany: jest.fn(() => Promise.resolve([])) },
  };
  const service = new StorefrontService(
    prisma as unknown as PrismaService,
    {
      isEnabled: jest.fn(() => Promise.resolve(false)),
    } as unknown as StoreAppsService,
    {
      resolve: jest.fn(() => Promise.resolve(null)),
    } as unknown as MarketsContextService,
    {} as MarketPricingService,
    {} as TaxService,
  );
  return { service, prisma };
}

const ids = (list: unknown) => (list as { id: string }[]).map((p) => p.id);

describe('StorefrontService.getProducts manual collection order', () => {
  it('MANUAL: interleaves own and custom products by link sort_order', async () => {
    const { service } = build({
      matchRule: 'MANUAL',
      ownLinks: [
        { product_id: 'p-new', sort_order: 4 },
        { product_id: 'p-mid', sort_order: 0 },
        { product_id: 'p-old', sort_order: 2 },
      ],
      customLinks: [
        { custom_product_id: 'cp-new', sort_order: 3 },
        { custom_product_id: 'cp-old', sort_order: 1 },
      ],
    });
    const list = await service.getProducts('shop', { creator_category: 'c' });
    expect(ids(list)).toEqual(['p-mid', 'cp-old', 'p-old', 'cp-new', 'p-new']);
    // Custom rows keep their marker after the merge.
    expect(
      (list as { id: string; _type?: string }[]).find((p) => p.id === 'cp-old')
        ?._type,
    ).toBe('custom_product');
  });

  it('MANUAL: ties fall back to newest first (legacy per-kind indexes)', async () => {
    // Before product_order existed both kinds were numbered from 0.
    const { service } = build({
      matchRule: 'MANUAL',
      ownLinks: [
        { product_id: 'p-old', sort_order: 0 },
        { product_id: 'p-new', sort_order: 1 },
        { product_id: 'p-mid', sort_order: 2 },
      ],
      customLinks: [
        { custom_product_id: 'cp-old', sort_order: 0 },
        { custom_product_id: 'cp-new', sort_order: 1 },
      ],
    });
    const list = await service.getProducts('shop', { creator_category: 'c' });
    expect(ids(list)).toEqual(['p-old', 'cp-old', 'p-new', 'cp-new', 'p-mid']);
  });

  it('MANUAL: any slice of the merged list follows the manual order (sections slice by limit)', async () => {
    const { service } = build({
      matchRule: 'MANUAL',
      ownLinks: [
        { product_id: 'p-new', sort_order: 4 },
        { product_id: 'p-mid', sort_order: 0 },
        { product_id: 'p-old', sort_order: 2 },
      ],
      customLinks: [
        { custom_product_id: 'cp-new', sort_order: 3 },
        { custom_product_id: 'cp-old', sort_order: 1 },
      ],
    });
    const list = await service.getProducts('shop', {
      creator_category_id: CC,
      limit: 2,
    });
    const all = ids(list);
    expect(all.slice(0, 2)).toEqual(['p-mid', 'cp-old']);
    expect(all.slice(2, 4)).toEqual(['p-old', 'cp-new']);
    expect(all.slice(4, 6)).toEqual(['p-new']);
  });

  it('TAGS: keeps own-then-custom by date and reads no links', async () => {
    const { service, prisma } = build({
      matchRule: 'TAGS',
      ownLinks: [],
      customLinks: [],
    });
    const list = await service.getProducts('shop', { creator_category: 'c' });
    expect(ids(list)).toEqual(['p-new', 'p-mid', 'p-old', 'cp-new', 'cp-old']);
    expect(prisma.productCreatorCategory.findMany).not.toHaveBeenCalled();
  });

  it('no collection: unchanged order', async () => {
    const { service, prisma } = build({
      matchRule: 'MANUAL',
      ownLinks: [],
      customLinks: [],
    });
    const list = await service.getProducts('shop', {});
    expect(ids(list)).toEqual(['p-new', 'p-mid', 'p-old', 'cp-new', 'cp-old']);
    expect(prisma.productCreatorCategory.findMany).not.toHaveBeenCalled();
  });
});
