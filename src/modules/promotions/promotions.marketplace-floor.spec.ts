import { BadRequestException } from '@nestjs/common';
import { PromotionsService } from './promotions.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { TaxService } from '../taxes/tax.service';
import { couponBelowProviderCost } from './coupon-provider-floor';

// Marketplace fixtures: an influencer store (MARKETPLACE, platform VAT SE 25 %
// INCLUSIVE, EUR) selling a custom product at 30 EUR whose provider base
// (net supply price) is 18 EUR. Net revenue at full price = 30 / 1.25 = 24.
// - 30 % coupon: 21 gross = 16.80 net < 18  -> below provider cost.
// - 10 % coupon: 27 gross = 21.60 net >= 18 -> fine.
// The same carts on an INDEPENDENT store never hit the floor.

const promo = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  coupon_code: 'SALE',
  creator_id: 'c1',
  provider_id: null,
  type: 'COUPON',
  value: 30,
  conditions: {},
  status: 'ACTIVE',
  starts_at: new Date(Date.now() - 1000),
  expires_at: null,
  usage_limit: null,
  usage_count: 0,
  ...over,
});

const storeRow = (storeType: 'MARKETPLACE' | 'INDEPENDENT') => ({
  id: 's1',
  creator_id: 'c1',
  store_type: storeType,
  tax_pricing_mode: 'INCLUSIVE',
  tax_basis: 'SHIPPING',
  tax_country: storeType === 'INDEPENDENT' ? 'SE' : null,
  oss_registered: false,
  use_platform_tax_rates: true,
  shipping_tax_class_id: null,
  display_prices_incl_tax: true,
  currency: 'EUR',
  primary_locale: 'en',
});

const customProduct = {
  id: 'cp1',
  pricing_type: 'SINGLE',
  final_price: 30,
  margin_amount: null,
  product: {
    base_price: 18,
    provider_id: 'prov1',
    tax_class_id: null,
    tax_exempt: false,
  },
  selected_variants: [],
};

// PER_VARIANT custom product: final 30, variant v1 sold at 45 (custom
// price) with a +5 price adjustment on the provider base 18 (-> 23).
const variantProduct = {
  id: 'cpv',
  pricing_type: 'PER_VARIANT',
  final_price: 30,
  margin_amount: null,
  product: {
    base_price: 18,
    provider_id: 'prov1',
    tax_class_id: null,
    tax_exempt: false,
    variants: [{ id: 'v1' }],
  },
  selected_variants: [{ variant_id: 'v1', custom_price: 45 }],
};

const ownProduct = {
  id: 'own1',
  base_price: 50,
  provider_id: null,
  tax_class_id: null,
  tax_exempt: false,
};

function serviceFor(
  row: Record<string, unknown> | null,
  storeType: 'MARKETPLACE' | 'INDEPENDENT' = 'MARKETPLACE',
) {
  const prisma = {
    promotion: { findUnique: () => Promise.resolve(row) },
    store: { findUnique: () => Promise.resolve(storeRow(storeType)) },
    customProduct: {
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          [customProduct, variantProduct].filter((c) =>
            where.id.in.includes(c.id),
          ),
        ),
    },
    product: {
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve([ownProduct].filter((p) => where.id.in.includes(p.id))),
    },
    productVariant: {
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          [{ id: 'v1', price_adjustment: 5 }].filter((v) =>
            where.id.in.includes(v.id),
          ),
        ),
    },
    platformConfig: {
      findFirst: () =>
        Promise.resolve({
          default_tax_pricing_mode: 'INCLUSIVE',
          platform_tax_country: 'SE',
          platform_oss_registered: false,
          default_currency: 'EUR',
        }),
    },
    taxRate: {
      findMany: () =>
        Promise.resolve([
          {
            id: 'r1',
            store_id: null,
            tax_class_id: 'std',
            country: 'SE',
            region: null,
            postcode_pattern: null,
            rate_bp: 2500,
            label: { en: 'VAT' },
            priority: 0,
            applies_to_shipping: true,
            is_active: true,
          },
        ]),
    },
    taxClass: {
      findMany: () =>
        Promise.resolve([
          {
            id: 'std',
            store_id: null,
            key: 'standard',
            name: { en: 'Standard' },
            is_default: true,
            sort_order: 0,
          },
        ]),
    },
  };
  return new PromotionsService(
    prisma as never,
    { resolve: () => Promise.resolve(null) } as never,
    new MarketPricingService({} as never),
    new TaxService(prisma as never),
  );
}

const preview = { coupon_code: 'SALE', store_id: 's1', product_id: 'cp1' };
const cart = (amount: number, extra: Record<string, unknown>[] = []) => ({
  coupon_code: 'SALE',
  store_id: 's1',
  subtotal: amount + extra.reduce((s, l) => s + Number(l.amount), 0),
  item_count: 1 + extra.length,
  product_ids: ['cp1', ...extra.map((l) => String(l.product_id))],
  line_totals: [{ product_id: 'cp1', amount, quantity: 1 }, ...extra] as never,
});

describe('coupon preview: marketplace provider-cost floor', () => {
  it('answers applies:false + below_cost with no price below provider cost', async () => {
    const r = await serviceFor(promo()).previewCoupon({
      ...preview,
      line_amount: 30,
    });
    expect(r).toMatchObject({
      percent: 30,
      applies: false,
      below_cost: true,
      discount_amount: null,
    });
  });

  it('keeps a coupon that stays above provider cost', async () => {
    const r = await serviceFor(promo({ value: 10 })).previewCoupon({
      ...preview,
      line_amount: 30,
    });
    expect(r).toMatchObject({
      applies: true,
      below_cost: false,
      discount_amount: 3,
    });
  });

  it('judges the catalogue price when no line amount is sent', async () => {
    const r = await serviceFor(promo()).previewCoupon(preview);
    expect(r.below_cost).toBe(true);
    expect(r.applies).toBe(false);
  });

  it('judges a fixed coupon and the quantity', async () => {
    // 2 x 30 = 60 gross, 48 net; base 36. A 10 EUR coupon: 50 gross = 40 net.
    const fixed = serviceFor(
      promo({ value: 10, conditions: { discount_kind: 'fixed' } }),
    );
    const ok = await fixed.previewCoupon({
      ...preview,
      line_amount: 60,
      quantity: 2,
    });
    expect(ok.below_cost).toBe(false);
    expect(ok.discount_amount).toBe(10);
    // 20 EUR: 40 gross = 32 net < 36.
    const big = serviceFor(
      promo({ value: 20, conditions: { discount_kind: 'fixed' } }),
    );
    const bad = await big.previewCoupon({
      ...preview,
      line_amount: 60,
      quantity: 2,
    });
    expect(bad.below_cost).toBe(true);
  });

  it('judges one unit when no quantity is sent (never estimated from the amount)', async () => {
    // 30 + a 20 add-on = 50; 20 %: 40 gross = 32 net >= base 18.
    const r = await serviceFor(promo({ value: 20 })).previewCoupon({
      ...preview,
      line_amount: 50,
    });
    expect(r).toMatchObject({
      applies: true,
      below_cost: false,
      discount_amount: 10,
    });
  });

  it('never applies the floor to a creator own product without a provider', async () => {
    const r = await serviceFor(promo({ value: 90 })).previewCoupon({
      ...preview,
      product_id: 'own1',
      line_amount: 50,
    });
    expect(r).toMatchObject({ applies: true, below_cost: false });
    expect(r.discount_amount).toBe(45);
  });

  it('never applies the floor on an INDEPENDENT store', async () => {
    const r = await serviceFor(promo(), 'INDEPENDENT').previewCoupon({
      ...preview,
      line_amount: 30,
    });
    expect(r).toMatchObject({
      applies: true,
      below_cost: false,
      discount_amount: 9,
    });
  });
});

describe('validate-coupon: marketplace provider-cost floor', () => {
  it('rejects with ORDER_DISCOUNT_BELOW_PROVIDER_COST like the order', async () => {
    const err = await serviceFor(promo())
      .validateCouponForCart(cart(30))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getStatus()).toBe(400);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'ORDER_DISCOUNT_BELOW_PROVIDER_COST',
    });
  });

  it('passes a coupon above provider cost', async () => {
    await expect(
      serviceFor(promo({ value: 10 })).validateCouponForCart(cart(30)),
    ).resolves.toMatchObject({ valid: true, discount_amount: 3 });
  });

  it('judges the whole cart: own-product margin can carry the discount', async () => {
    // cp1 30 + own1 50 = 80 gross, 64 net; 30 % = 24 -> 56 gross = 44.8 net,
    // still above the 18 provider base.
    await expect(
      serviceFor(promo()).validateCouponForCart(
        cart(30, [{ product_id: 'own1', amount: 50, quantity: 1 }]),
      ),
    ).resolves.toMatchObject({ valid: true, discount_amount: 24 });
  });

  it('judges the explicit quantity', async () => {
    const dto = cart(60);
    (dto.line_totals as unknown as { quantity?: number }[])[0].quantity = 2;
    // 2 x 30 at 30 %: 42 gross = 33.6 net < 36 base.
    await expect(
      serviceFor(promo()).validateCouponForCart(dto),
    ).rejects.toMatchObject({
      response: { code: 'ORDER_DISCOUNT_BELOW_PROVIDER_COST' },
    });
  });

  it('skips the floor for a line without quantity (add-ons are not units)', async () => {
    // One unit of 30 with a 20 add-on: line 50. The old estimate read it as
    // round(50 / 30) = 2 units (base 36) and rejected 20 % (40 gross = 32
    // net); the order judges base 18 and accepts.
    const dto = cart(50);
    (dto.line_totals as unknown as { quantity?: number }[])[0].quantity =
      undefined;
    await expect(
      serviceFor(promo({ value: 20 })).validateCouponForCart(dto),
    ).resolves.toMatchObject({ valid: true, discount_amount: 10 });
  });

  it('accepts a variant-priced line with its quantity like the order', async () => {
    // Variant v1 sold at 45, base 18 + 5 = 23. 20 %: 36 gross = 28.8 net.
    await expect(
      serviceFor(promo({ value: 20 })).validateCouponForCart({
        coupon_code: 'SALE',
        store_id: 's1',
        subtotal: 45,
        item_count: 1,
        product_ids: ['cpv'],
        line_totals: [
          { product_id: 'cpv', amount: 45, quantity: 1, variant_id: 'v1' },
        ],
      }),
    ).resolves.toMatchObject({ valid: true, discount_amount: 9 });
  });

  it('counts the variant adjustment in the base when the variant is sent', async () => {
    // 30 at 20 %: 24 gross = 19.2 net; base 18 + 5 = 23 -> below cost.
    await expect(
      serviceFor(promo({ value: 20 })).validateCouponForCart({
        coupon_code: 'SALE',
        store_id: 's1',
        subtotal: 30,
        item_count: 1,
        product_ids: ['cpv'],
        line_totals: [
          { product_id: 'cpv', amount: 30, quantity: 1, variant_id: 'v1' },
        ],
      }),
    ).rejects.toMatchObject({
      response: { code: 'ORDER_DISCOUNT_BELOW_PROVIDER_COST' },
    });
  });

  it('skips the floor when a product with variants comes without its variant', async () => {
    // Same cart without variant_id: the base would be underestimated (18),
    // so validate does not judge it and the order stays the guard.
    await expect(
      serviceFor(promo({ value: 20 })).validateCouponForCart({
        coupon_code: 'SALE',
        store_id: 's1',
        subtotal: 30,
        item_count: 1,
        product_ids: ['cpv'],
        line_totals: [{ product_id: 'cpv', amount: 30, quantity: 1 }],
      }),
    ).resolves.toMatchObject({ valid: true, discount_amount: 6 });
  });

  it('taxes the floor for the cart quote country when sent', async () => {
    const spy = jest.spyOn(TaxService.prototype, 'computeTaxes');
    try {
      await serviceFor(promo({ value: 10 })).validateCouponForCart({
        ...cart(30),
        country_code: 'de',
      });
      expect(spy).toHaveBeenCalled();
      const input = spy.mock.calls[0][0];
      expect(input.shipping?.country).toBe('DE');
      expect(input.billing?.country).toBe('DE');
    } finally {
      spy.mockRestore();
    }
  });

  it('cannot judge without line totals (the order stays the guard)', async () => {
    await expect(
      serviceFor(promo()).validateCouponForCart({
        coupon_code: 'SALE',
        store_id: 's1',
        subtotal: 30,
      }),
    ).resolves.toMatchObject({ valid: true });
  });

  it('never applies the floor on an INDEPENDENT store', async () => {
    await expect(
      serviceFor(promo(), 'INDEPENDENT').validateCouponForCart(cart(30)),
    ).resolves.toMatchObject({ valid: true, discount_amount: 9 });
  });

  it('lets free shipping through (no revenue lost)', async () => {
    await expect(
      serviceFor(
        promo({ type: 'FREE_SHIPPING', value: 0 }),
      ).validateCouponForCart(cart(30)),
    ).resolves.toMatchObject({ valid: true, free_shipping: true });
  });
});

describe('platform coupons by store kind', () => {
  const platform = promo({ creator_id: null, provider_id: null, value: 10 });

  it('apply on MARKETPLACE stores', async () => {
    await expect(
      serviceFor(platform).validateCoupon({
        coupon_code: 'SALE',
        store_id: 's1',
        subtotal: 100,
      }),
    ).resolves.toMatchObject({ valid: true, discount_amount: 10 });
    const r = await serviceFor(platform).previewCoupon({
      ...preview,
      line_amount: 30,
    });
    expect(r.applies).toBe(true);
  });

  it('are an invalid code on INDEPENDENT stores (validate, cart, preview)', async () => {
    const invalid = {
      response: {
        code: 'PROMOTION_COUPON_INVALID',
        message: 'Invalid coupon code',
      },
    };
    // validateCoupon is what the order path calls.
    await expect(
      serviceFor(platform, 'INDEPENDENT').validateCoupon({
        coupon_code: 'SALE',
        store_id: 's1',
        subtotal: 100,
      }),
    ).rejects.toMatchObject(invalid);
    await expect(
      serviceFor(platform, 'INDEPENDENT').validateCouponForCart(cart(30)),
    ).rejects.toMatchObject(invalid);
    await expect(
      serviceFor(platform, 'INDEPENDENT').previewCoupon(preview),
    ).rejects.toMatchObject(invalid);
  });

  it("keep a creator's own coupon valid on their INDEPENDENT store", async () => {
    await expect(
      serviceFor(promo({ value: 10 }), 'INDEPENDENT').validateCoupon({
        coupon_code: 'SALE',
        store_id: 's1',
        subtotal: 100,
      }),
    ).resolves.toMatchObject({ valid: true });
  });
});

describe('couponBelowProviderCost (shared with the order path)', () => {
  const base = {
    independent: false,
    discountAmount: 9,
    providerBaseTotal: 18,
    netItemsAfter: 16.8,
    netItemsBefore: () => 24,
  };

  it('breaks when net revenue after the coupon is under the base', async () => {
    await expect(couponBelowProviderCost(base)).resolves.toBe(true);
  });

  it('never breaks on INDEPENDENT stores or without a real discount', async () => {
    await expect(
      couponBelowProviderCost({ ...base, independent: true }),
    ).resolves.toBe(false);
    await expect(
      couponBelowProviderCost({ ...base, discountAmount: 0 }),
    ).resolves.toBe(false);
  });

  it('skips the second tax run when revenue stays above the base', async () => {
    const before = jest.fn(() => 24);
    await expect(
      couponBelowProviderCost({
        ...base,
        netItemsAfter: 18,
        netItemsBefore: before,
      }),
    ).resolves.toBe(false);
    expect(before).not.toHaveBeenCalled();
  });

  it('judges a cart already under its base by its own net revenue', async () => {
    // Base 30 but the cart nets 24 without the coupon: any discount breaks.
    await expect(
      couponBelowProviderCost({
        ...base,
        providerBaseTotal: 30,
        netItemsAfter: 23.99,
        netItemsBefore: () => 24,
      }),
    ).resolves.toBe(true);
  });
});
