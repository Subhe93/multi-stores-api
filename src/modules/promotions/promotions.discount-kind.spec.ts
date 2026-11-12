import { BadRequestException } from '@nestjs/common';
import { PromotionsService, discountKindOf } from './promotions.service';

describe('coupon discount kind', () => {
  it('reads COUPON as percentage unless discount_kind is fixed', () => {
    expect(discountKindOf('COUPON', {})).toBe('percentage');
    expect(discountKindOf('COUPON', null)).toBe('percentage');
    expect(discountKindOf('COUPON', { discount_kind: 'fixed' })).toBe('fixed');
    expect(discountKindOf('PERCENTAGE', { discount_kind: 'fixed' })).toBe('percentage');
    expect(discountKindOf('FIXED_AMOUNT', {})).toBe('fixed');
    expect(discountKindOf('FREE_SHIPPING', {})).toBeNull();
  });

  const promo = (over: Record<string, unknown>) => ({
    id: 'p1',
    creator_id: null,
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
  const serviceFor = (row: Record<string, unknown>) =>
    new PromotionsService(
      { promotion: { findUnique: async () => row } } as never,
      {} as never,
      {} as never,
    );

  it('applies a percentage coupon as a share of the subtotal', async () => {
    const r = await serviceFor(promo({ value: 20 })).validateCoupon({
      coupon_code: 'X',
      store_id: 's',
      subtotal: 500,
    });
    expect(r.discount_kind).toBe('percentage');
    expect(r.discount_amount).toBe(100);
  });

  it('applies a fixed coupon as an amount, capped at the subtotal', async () => {
    const svc = serviceFor(promo({ value: 100, conditions: { discount_kind: 'fixed' } }));
    const r = await svc.validateCoupon({ coupon_code: 'X', store_id: 's', subtotal: 500 });
    expect(r.discount_kind).toBe('fixed');
    expect(r.discount_amount).toBe(100);
    const small = await svc.validateCoupon({ coupon_code: 'X', store_id: 's', subtotal: 60 });
    expect(small.discount_amount).toBe(60);
  });

  it('rejects a percentage over 100 but allows a fixed amount over 100', async () => {
    const svc = new PromotionsService(
      { promotion: { create: async (a: unknown) => a } } as never,
      {} as never,
      {} as never,
    );
    const base = { level: 'CREATOR_TO_CUSTOMER', starts_at: '2026-01-01' } as const;
    await expect(
      svc.create('u', 'ADMIN' as never, { ...base, type: 'COUPON', value: 150 } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create('u', 'ADMIN' as never, {
        ...base,
        type: 'COUPON',
        value: 150,
        conditions: { discount_kind: 'fixed' },
      } as never),
    ).resolves.toBeDefined();
    await expect(
      svc.create('u', 'ADMIN' as never, {
        ...base,
        type: 'COUPON',
        value: 10,
        conditions: { discount_kind: 'bogus' },
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
