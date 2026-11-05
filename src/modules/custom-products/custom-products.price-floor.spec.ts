import { PricingType, StoreType, TaxPricingMode } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { CustomProductsService } from './custom-products.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import {
  buildTaxContext,
  type TaxService,
  type TaxStoreFields,
} from '../taxes/tax.service';

// Marketplace minimum price of a custom product (provider base + VAT),
// resolved with the checkout tax engine for the creator's store, and the
// below_minimum flag of the creator's list.

const store: TaxStoreFields & { currency: null; markets: [] } = {
  id: 's1',
  store_type: StoreType.MARKETPLACE,
  tax_pricing_mode: TaxPricingMode.INCLUSIVE,
  tax_basis: 'SHIPPING',
  tax_country: null,
  oss_registered: false,
  use_platform_tax_rates: true,
  shipping_tax_class_id: null,
  display_prices_incl_tax: true,
  currency: null,
  markets: [],
};

function build(mode: TaxPricingMode = TaxPricingMode.INCLUSIVE) {
  const platform = {
    default_currency: 'EUR',
    default_tax_pricing_mode: mode,
    platform_tax_country: 'SE',
    platform_oss_registered: false,
  };
  const classes = [
    { id: 'std', store_id: null, key: 'standard', name: {}, is_default: true },
    { id: 'red', store_id: null, key: 'reduced', name: {}, is_default: false },
  ];
  const rate = (cls: string, bp: number) => ({
    id: `r-${cls}`,
    store_id: null,
    tax_class_id: cls,
    country: 'SE',
    region: null,
    postcode_pattern: null,
    rate_bp: bp,
    label: {},
    priority: 0,
    applies_to_shipping: true,
    is_active: true,
  });
  const taxService = {
    contextFor: jest.fn((s: TaxStoreFields) =>
      Promise.resolve(buildTaxContext(s, platform)),
    ),
    loadTaxData: jest.fn(() =>
      Promise.resolve({
        rates: [rate('std', 2500), rate('red', 1200)],
        classes,
      }),
    ),
  };
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    store: { findUnique: jest.fn(() => Promise.resolve(store)) },
    platformConfig: { findFirst: jest.fn(() => Promise.resolve(platform)) },
    customProduct: {
      findMany: jest.fn(() => Promise.resolve([] as unknown[])),
      count: jest.fn(() => Promise.resolve(0)),
    },
  };
  const service = new CustomProductsService(
    prisma as unknown as PrismaService,
    {} as NotificationsService,
    undefined,
    taxService as unknown as TaxService,
  );
  return { service, prisma };
}

const product = (over: Record<string, unknown> = {}) => ({
  base_price: 15,
  provider_id: 'prov',
  tax_class_id: null,
  tax_exempt: false,
  variants: [] as { id: string; price_adjustment: number }[],
  ...over,
});

type FloorAssert = (
  creatorId: string,
  baseProduct: ReturnType<typeof product>,
  pricing: {
    pricing_type: PricingType;
    final_price?: number;
    margin_amount?: number;
    selected_variants?: { variant_id: string; custom_price?: number }[];
  },
) => Promise<void>;

const assertFloor =
  (service: CustomProductsService): FloorAssert =>
  (...args) =>
    (service as unknown as { assertPriceFloor: FloorAssert }).assertPriceFloor(
      ...args,
    );

async function errorOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as BadRequestException;
  }
  throw new Error('expected a rejection');
}

describe('CustomProductsService minimum price', () => {
  it('rejects 18.74 for a 15.00 base at 25 % (minimum 18.75)', async () => {
    const { service } = build();
    const err = await errorOf(
      assertFloor(service)('c1', product(), {
        pricing_type: PricingType.SINGLE,
        final_price: 18.74,
      }),
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({
      code: 'CUSTOM_PRODUCT_PRICE_BELOW_MINIMUM',
      minimum: 18.75,
      currency: 'EUR',
    });
    await expect(
      assertFloor(service)('c1', product(), {
        pricing_type: PricingType.SINGLE,
        final_price: 18.75,
      }),
    ).resolves.toBeUndefined();
  });

  it("uses the product's tax class (reduced 12 % -> 16.80)", async () => {
    const { service } = build();
    const err = await errorOf(
      assertFloor(service)('c1', product({ tax_class_id: 'red' }), {
        pricing_type: PricingType.SINGLE,
        final_price: 16.79,
      }),
    );
    expect(err.getResponse()).toMatchObject({ minimum: 16.8 });
  });

  it('tax-exempt products and excl.-VAT pricing only need the base', async () => {
    const { service } = build();
    await expect(
      assertFloor(service)('c1', product({ tax_exempt: true }), {
        pricing_type: PricingType.SINGLE,
        final_price: 15,
      }),
    ).resolves.toBeUndefined();
    const excl = build(TaxPricingMode.EXCLUSIVE).service;
    await expect(
      assertFloor(excl)('c1', product(), {
        pricing_type: PricingType.SINGLE,
        final_price: 15,
      }),
    ).resolves.toBeUndefined();
  });

  it('PER_VARIANT names the offending variant', async () => {
    const { service } = build();
    const p = product({
      variants: [
        { id: 'v1', price_adjustment: 0 },
        { id: 'v2', price_adjustment: 5 },
      ],
    });
    const err = await errorOf(
      assertFloor(service)('c1', p, {
        pricing_type: PricingType.PER_VARIANT,
        selected_variants: [
          { variant_id: 'v1', custom_price: 19 },
          { variant_id: 'v2', custom_price: 24.99 },
        ],
      }),
    );
    expect(err.getResponse()).toMatchObject({
      minimum: 25,
      variant_id: 'v2',
    });
  });

  it('MARGIN reports the minimum margin', async () => {
    const { service } = build();
    const err = await errorOf(
      assertFloor(service)('c1', product(), {
        pricing_type: PricingType.MARGIN,
        margin_amount: 3,
      }),
    );
    expect(err.getResponse()).toMatchObject({
      minimum: 18.75,
      minimum_margin: 3.75,
    });
  });

  it('creator-only base products (no provider) are not checked', async () => {
    const { service } = build();
    await expect(
      assertFloor(service)('c1', product({ provider_id: null }), {
        pricing_type: PricingType.SINGLE,
        final_price: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it('the list flags existing products below the minimum', async () => {
    const { service, prisma } = build();
    prisma.customProduct.findMany.mockResolvedValue([
      {
        id: 'low',
        pricing_type: PricingType.SINGLE,
        final_price: 18,
        margin_amount: null,
        selected_variants: [],
        product: product(),
      },
      {
        id: 'ok',
        pricing_type: PricingType.SINGLE,
        final_price: 18.75,
        margin_amount: null,
        selected_variants: [],
        product: product(),
      },
    ]);
    const res = await service.findByCreator('u1');
    const rows = res.data as unknown as {
      id: string;
      below_minimum: boolean;
      price_floor: unknown;
    }[];
    expect(rows.map((r) => [r.id, r.below_minimum])).toEqual([
      ['low', true],
      ['ok', false],
    ]);
    expect(rows[0].price_floor).toEqual({
      prices_include_vat: true,
      vat_rate_bp: 2500,
      currency: 'EUR',
    });
  });
});

describe('CustomProductsService.update bundle floor', () => {
  // A SINGLE-priced product at 18.00 (below the 18.75 gross floor) attached
  // to bundle b1 with a 10 % offer: the edit page resends bundle_ids +
  // final_price on every save.
  function buildUpdate() {
    const { service, prisma } = build();
    const existing = {
      id: 'cp1',
      creator_id: 'c1',
      creator: { user_id: 'u1' },
      status: 'DRAFT',
      pricing_type: PricingType.SINGLE,
      final_price: 18,
      margin_amount: null,
      selected_variants: [],
      primary_creator_category_id: null,
      product: product(),
    };
    const p = prisma as unknown as Record<string, Record<string, jest.Mock>>;
    p.customProduct.findUnique = jest.fn(() => Promise.resolve(existing));
    p.customProduct.update = jest.fn(() => Promise.resolve({ id: 'cp1' }));
    p.bundle = {
      findMany: jest.fn((args: { select: Record<string, unknown> }) =>
        Promise.resolve(
          args.select.offers
            ? [
                {
                  id: 'b1',
                  offers: [
                    {
                      quantity: 2,
                      discount_type: 'PERCENTAGE',
                      discount_value: 10,
                    },
                  ],
                },
              ]
            : [{ id: 'b1', creator_id: 'c1' }],
        ),
      ),
    };
    p.bundleCustomProduct = {
      findMany: jest.fn(() => Promise.resolve([{ bundle_id: 'b1' }])),
      deleteMany: jest.fn(() => Promise.resolve({})),
    };
    p.customProductTranslation = {
      findFirst: jest.fn(() => Promise.resolve({ title: 'Tee' })),
      deleteMany: jest.fn(() => Promise.resolve({})),
    };
    return { service };
  }

  it('an unchanged price with the same bundles saves (text edit)', async () => {
    const { service } = buildUpdate();
    await expect(
      service.update('cp1', { final_price: 18, bundle_ids: ['b1'] }, 'u1'),
    ).resolves.toEqual({ id: 'cp1' });
  });

  it('a changed price re-checks the attached bundles', async () => {
    const { service } = buildUpdate();
    await expect(
      service.update('cp1', { final_price: 19, bundle_ids: ['b1'] }, 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
