import { BadRequestException } from '@nestjs/common';
import { PromotionsService } from './promotions.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import type { MarketContext } from '../markets/market-context';

// SEK base store with an EUR market at a round 0.1 rate, so conversions are
// easy to read: 100 SEK = 10 EUR.
const eur: MarketContext = {
  id: 'm-eu',
  key: 'eu',
  name: 'EU',
  countries: ['DE'],
  defaultLocale: 'en',
  locales: [],
  currency: 'EUR',
  storeCurrency: 'SEK',
  rate: 0.1,
  priceRule: { mode: 'convert', source: 'manual', rate: 0.1 } as never,
  isDefault: false,
  indexing: 'AUTO' as never,
  status: 'LIVE',
  primaryHostname: 'namez.shop',
  hostnames: ['namez.shop'],
};

const promo = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  coupon_code: 'SUMMER20',
  creator_id: 'c1',
  provider_id: null,
  type: 'COUPON',
  value: 20,
  conditions: {},
  status: 'ACTIVE',
  starts_at: new Date(Date.now() - 1000),
  expires_at: null,
  usage_limit: null,
  usage_count: 0,
  ...over,
});

function serviceFor(
  row: Record<string, unknown> | null,
  opts: {
    storeCreator?: string;
    market?: MarketContext | null;
    storeType?: 'INDEPENDENT' | 'MARKETPLACE';
  } = {},
) {
  const prisma = {
    promotion: { findUnique: () => Promise.resolve(row) },
    store: {
      // An INDEPENDENT store (Namez) unless a test says otherwise; the
      // marketplace provider-cost floor is covered in its own spec.
      findUnique: () =>
        Promise.resolve({
          creator_id: opts.storeCreator ?? 'c1',
          store_type: opts.storeType ?? 'INDEPENDENT',
        }),
    },
  };
  const marketsContext = {
    resolve: () => Promise.resolve(opts.market ?? null),
  };
  return new PromotionsService(
    prisma as never,
    marketsContext as never,
    new MarketPricingService({} as never),
    {} as never,
  );
}

const base = { coupon_code: 'SUMMER20', store_id: 's1', product_id: 'prod-a' };

const expectInvalid = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BadRequestException);
  expect((err as BadRequestException).getStatus()).toBe(400);
  expect((err as BadRequestException).getResponse()).toEqual({
    code: 'PROMOTION_COUPON_INVALID',
    message: 'Invalid coupon code',
  });
};

describe('PromotionsService.previewCoupon', () => {
  it('previews a percentage coupon and its discount on the line', async () => {
    const r = await serviceFor(promo()).previewCoupon({
      ...base,
      line_amount: 299,
    });
    expect(r).toEqual({
      code: 'SUMMER20',
      discount_kind: 'percentage',
      percent: 20,
      amount: null,
      free_shipping: false,
      applies: true,
      min_amount: null,
      min_quantity: null,
      min_met: true,
      discount_amount: 59.8,
      below_cost: false,
    });
  });

  it('previews a fixed coupon capped at the line amount', async () => {
    const svc = serviceFor(
      promo({ value: 100, conditions: { discount_kind: 'fixed' } }),
    );
    const r = await svc.previewCoupon({ ...base, line_amount: 500 });
    expect(r.discount_kind).toBe('fixed');
    expect(r.percent).toBeNull();
    expect(r.amount).toBe(100);
    expect(r.discount_amount).toBe(100);
    const small = await svc.previewCoupon({ ...base, line_amount: 60 });
    expect(small.discount_amount).toBe(60);
  });

  it('applies a targeted coupon only to its products', async () => {
    const svc = serviceFor(promo({ conditions: { product_ids: ['prod-a'] } }));
    const hit = await svc.previewCoupon({ ...base, line_amount: 100 });
    expect(hit.applies).toBe(true);
    expect(hit.discount_amount).toBe(20);

    const miss = await svc.previewCoupon({
      ...base,
      product_id: 'prod-b',
      line_amount: 100,
    });
    expect(miss.applies).toBe(false);
    expect(miss.discount_amount).toBeNull();
    expect(miss.percent).toBe(20);
  });

  it('reports minimums as met, not met, or unknown', async () => {
    const svc = serviceFor(
      promo({ conditions: { min_amount: 500, min_quantity: 2 } }),
    );
    const unknown = await svc.previewCoupon({ ...base, line_amount: 100 });
    expect(unknown.min_amount).toBe(500);
    expect(unknown.min_quantity).toBe(2);
    expect(unknown.min_met).toBeNull();
    expect(unknown.discount_amount).toBeNull();

    const notMet = await svc.previewCoupon({
      ...base,
      line_amount: 100,
      cart_subtotal: 499,
      item_count: 3,
    });
    expect(notMet.min_met).toBe(false);
    expect(notMet.discount_amount).toBeNull();

    // A zero subtotal is a real figure (not "not sent") and fails the minimum.
    const zero = await svc.previewCoupon({
      ...base,
      cart_subtotal: 0,
      item_count: 0,
    });
    expect(zero.min_met).toBe(false);

    const qtyShort = await svc.previewCoupon({
      ...base,
      cart_subtotal: 600,
      item_count: 1,
    });
    expect(qtyShort.min_met).toBe(false);

    const met = await svc.previewCoupon({
      ...base,
      line_amount: 100,
      cart_subtotal: 500,
      item_count: 2,
    });
    expect(met.min_met).toBe(true);
    expect(met.discount_amount).toBe(20);
  });

  it('treats a coupon without minimums as met even with no cart figures', async () => {
    const r = await serviceFor(promo()).previewCoupon(base);
    expect(r.min_met).toBe(true);
    expect(r.discount_amount).toBeNull(); // no line_amount sent
  });

  it('converts amounts and thresholds to the market currency', async () => {
    const fixed = serviceFor(
      promo({
        value: 100,
        conditions: { discount_kind: 'fixed', min_amount: 500 },
      }),
      { market: eur },
    );
    const r = await fixed.previewCoupon({
      ...base,
      market: 'eu',
      line_amount: 30,
      cart_subtotal: 50,
    });
    expect(r.amount).toBe(10);
    expect(r.min_amount).toBe(50);
    expect(r.min_met).toBe(true);
    expect(r.discount_amount).toBe(10);

    // 49.99 EUR = 499.9 SEK < 500 SEK: compared in base like the cart is.
    const short = await fixed.previewCoupon({
      ...base,
      market: 'eu',
      line_amount: 30,
      cart_subtotal: 49.99,
    });
    expect(short.min_met).toBe(false);

    const pct = serviceFor(promo({ value: 20 }), { market: eur });
    const p = await pct.previewCoupon({
      ...base,
      market: 'eu',
      line_amount: 25,
    });
    expect(p.percent).toBe(20);
    expect(p.amount).toBeNull();
    expect(p.discount_amount).toBe(5);
  });

  it('reports free shipping coupons', async () => {
    const r = await serviceFor(
      promo({ type: 'FREE_SHIPPING', value: 0 }),
    ).previewCoupon({ ...base, line_amount: 100 });
    expect(r.free_shipping).toBe(true);
    expect(r.discount_kind).toBeNull();
    expect(r.discount_amount).toBeNull();
  });

  it('answers one uniform invalid error for every unusable code', async () => {
    await expectInvalid(serviceFor(null).previewCoupon(base));
    await expectInvalid(
      serviceFor(promo({ status: 'PAUSED' })).previewCoupon(base),
    );
    await expectInvalid(
      serviceFor(
        promo({ starts_at: new Date(Date.now() + 86_400_000) }),
      ).previewCoupon(base),
    );
    await expectInvalid(
      serviceFor(
        promo({ expires_at: new Date(Date.now() - 1000) }),
      ).previewCoupon(base),
    );
    await expectInvalid(
      serviceFor(promo({ usage_limit: 5, usage_count: 5 })).previewCoupon(base),
    );
    await expectInvalid(
      serviceFor(promo({ creator_id: null, provider_id: 'pv1' })).previewCoupon(
        base,
      ),
    );
    // Another store's coupon: invalid, never applies:false.
    await expectInvalid(
      serviceFor(promo(), { storeCreator: 'c-other' }).previewCoupon(base),
    );
  });
});

describe('PromotionsService.validateCoupon minimum errors', () => {
  const svc = serviceFor(
    promo({ conditions: { min_amount: 500, min_quantity: 2 } }),
  );
  const dto = { coupon_code: 'SUMMER20', store_id: 's1' };

  it('codes a min_amount failure and keeps the 400', async () => {
    const err = await svc
      .validateCoupon({ ...dto, subtotal: 499, item_count: 5 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getStatus()).toBe(400);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'PROMOTION_COUPON_MIN_AMOUNT',
    });
  });

  it('codes a min_quantity failure and keeps the 400', async () => {
    const err = await svc
      .validateCoupon({ ...dto, subtotal: 600, item_count: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'PROMOTION_COUPON_MIN_QUANTITY',
    });
  });

  it('passes the same coupons as before', async () => {
    await expect(
      svc.validateCoupon({ ...dto, subtotal: 500, item_count: 2 }),
    ).resolves.toMatchObject({ valid: true, discount_amount: 100 });
    // Unchanged: figures that are not sent (or zero) skip the minimum check.
    await expect(svc.validateCoupon(dto)).resolves.toMatchObject({
      valid: true,
    });
    await expect(
      svc.validateCoupon({ ...dto, subtotal: 0, item_count: 0 }),
    ).resolves.toMatchObject({ valid: true, discount_amount: 0 });
  });

  it("reports another store's coupon as invalid (like an unknown code)", async () => {
    const other = serviceFor(promo(), { storeCreator: 'c-other' });
    await expect(
      other.validateCoupon({ ...dto, subtotal: 100 }),
    ).rejects.toMatchObject({
      response: {
        code: 'PROMOTION_COUPON_INVALID',
        message: 'Invalid coupon code',
      },
    });
    // Also when that foreign coupon is inactive or expired: same answer.
    await expect(
      serviceFor(promo({ status: 'PAUSED' }), {
        storeCreator: 'c-other',
      }).validateCoupon({ ...dto, subtotal: 100 }),
    ).rejects.toMatchObject({ response: { code: 'PROMOTION_COUPON_INVALID' } });
  });

  it('keeps NOT_APPLICABLE for product targeting only', async () => {
    const targeted = serviceFor(
      promo({ conditions: { product_ids: ['prod-a'] } }),
    );
    await expect(
      targeted.validateCoupon({
        ...dto,
        subtotal: 100,
        product_ids: ['prod-b'],
      }),
    ).rejects.toMatchObject({
      response: { code: 'PROMOTION_COUPON_NOT_APPLICABLE' },
    });
  });
});

describe('PromotionsService.validateCoupon targeting fields', () => {
  const dto = { coupon_code: 'SUMMER20', store_id: 's1' };

  it('reports a targeted coupon and its product ids', async () => {
    const svc = serviceFor(
      promo({ conditions: { product_ids: ['prod-a', 'prod-c'] } }),
    );
    // Every cart line is targeted: the amount equals a whole-cart amount,
    // yet the answer still says the coupon is targeted.
    const r = await svc.validateCoupon({
      ...dto,
      subtotal: 100,
      product_ids: ['prod-a'],
      line_totals: [{ product_id: 'prod-a', amount: 100 }],
    });
    expect(r).toMatchObject({
      discount_amount: 20,
      targeted: true,
      product_ids: ['prod-a', 'prod-c'],
    });
  });

  it('reports an untargeted coupon with no product ids', async () => {
    const r = await serviceFor(promo()).validateCoupon({
      ...dto,
      subtotal: 100,
    });
    expect(r).toMatchObject({ targeted: false, product_ids: [] });
  });
});
