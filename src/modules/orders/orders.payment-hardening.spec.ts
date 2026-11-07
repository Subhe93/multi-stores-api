import { ConfigService } from '@nestjs/config';
import { OrderStatus, PaymentMethod } from '@prisma/client';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { personalizationCoreArgs } from '../personalization/__fixtures__/personalization-service.factory';
import { PromotionsService } from '../promotions/promotions.service';
import { ShippingService } from '../shipping/shipping.service';
import { MailService } from '../mail/mail.service';
import { TaxService } from '../taxes/tax.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { B2bService } from '../b2b/b2b.service';

// Payment hardening of OrdersService (own-key audit 2026-11-07): the
// abandonment sweep asks the payment checker before releasing a Stripe
// order, a late payment never drives stock negative, a failed order hands
// its coupon back (and a late payment takes it again), a failed full
// refund is reverted, and partial-refund rows are written under a lock.

type Fn = jest.Mock;

function makePrisma() {
  const prisma = {
    order: {
      findUnique: jest.fn((): Promise<unknown> => Promise.resolve(null)),
      findMany: jest.fn((): Promise<unknown> => Promise.resolve([])),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    orderTimeline: {
      create: jest.fn(() => Promise.resolve({})),
      findFirst: jest.fn((): Promise<unknown> => Promise.resolve(null)),
      findMany: jest.fn((): Promise<unknown> => Promise.resolve([])),
    },
    orderCommission: {
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    orderItem: {
      findMany: jest.fn((): Promise<unknown> => Promise.resolve([])),
    },
    product: {
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      findUnique: jest.fn((): Promise<unknown> => Promise.resolve(null)),
    },
    productVariant: {
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      findUnique: jest.fn((): Promise<unknown> => Promise.resolve(null)),
    },
    promotionUsage: {
      findMany: jest.fn((): Promise<unknown> => Promise.resolve([])),
      deleteMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    promotion: {
      update: jest.fn(() => Promise.resolve({})),
    },
    store: {
      findUnique: jest.fn((): Promise<unknown> =>
        Promise.resolve({ creator: { user_id: 'owner' } }),
      ),
    },
    notification: { create: jest.fn(() => Promise.resolve({})) },
    lockKeys: [] as string[],
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({
      ...prisma,
      $executeRaw: (_s: unknown, key: string) => {
        prisma.lockKeys.push(key);
        return Promise.resolve(1);
      },
    }),
  );
  return prisma;
}

function build() {
  const prisma = makePrisma();
  const promotions = { releaseRedemption: jest.fn(() => Promise.resolve()) };
  const mail = { dispatchOrderEmail: jest.fn(() => Promise.resolve()) };
  const service = new OrdersService(
    prisma as unknown as PrismaService,
    promotions as unknown as PromotionsService,
    {} as ShippingService,
    mail as unknown as MailService,
    {} as TaxService,
    {} as MarketsContextService,
    {} as MarketPricingService,
    {} as ConfigService,
    {} as B2bService,
    ...personalizationCoreArgs(prisma as never),
  );
  const internals = service as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  return { service, internals, prisma, promotions };
}

const order = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  order_number: 'MS-1',
  store_id: 's1',
  status: OrderStatus.PENDING,
  payment_status: 'awaiting_payment',
  customer: { user_id: 'u1' },
  ...over,
});

const HOUR = 60 * 60 * 1000;
const stale = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  store_id: 's1',
  // Past the 2 h window, well inside the 48 h hard cap.
  created_at: new Date(Date.now() - 3 * HOUR),
  payment_processing_at: null,
  payment_method: PaymentMethod.STRIPE,
  payment_route: 'OWN_KEY',
  stripe_account_id: null,
  stripe_payment_id: 'pi_1',
  stripe_key_fingerprint: 'fp',
  ...over,
});

describe('OrdersService abandonment sweep', () => {
  it('skips processing orders in the query and asks the checker first', async () => {
    const b = build();
    const checker: Fn = jest.fn(() => Promise.resolve('keep'));
    b.service.registerAbandonedPaymentChecker(checker);
    b.prisma.order.findMany.mockResolvedValueOnce([stale()]);
    const fail = jest.spyOn(b.service, 'markOrderFailed');
    await b.internals.releaseExpiredAwaitingPaymentOrders();
    const where = (
      b.prisma.order.findMany.mock.calls[0] as unknown as [
        { where: Record<string, unknown> },
      ]
    )[0].where;
    expect(where.payment_processing_at).toBeNull();
    expect(checker).toHaveBeenCalledWith(expect.objectContaining({ id: 'o1' }), {
      hardCap: false,
      processingExpired: false,
    });
    expect(fail).not.toHaveBeenCalled();

    // A kept order is not re-checked on the next run (no starvation).
    b.prisma.order.findMany.mockResolvedValueOnce([]);
    await b.internals.releaseExpiredAwaitingPaymentOrders();
    const where2 = (
      b.prisma.order.findMany.mock.calls[2] as unknown as [
        { where: { id?: { notIn: string[] } } },
      ]
    )[0].where;
    expect(where2.id).toEqual({ notIn: ['o1'] });
  });

  it("fails only on the checker's 'fail'; 'paid' leaves the order alone", async () => {
    const b = build();
    const fail = jest
      .spyOn(b.service, 'markOrderFailed')
      .mockResolvedValue(null);
    b.service.registerAbandonedPaymentChecker(
      jest.fn((o: { id: string }) =>
        Promise.resolve(o.id === 'o1' ? 'fail' : 'paid'),
      ),
    );
    b.prisma.order.findMany.mockResolvedValueOnce([
      stale(),
      stale({ id: 'o2' }),
    ]);
    await b.internals.releaseExpiredAwaitingPaymentOrders();
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledWith('o1', expect.any(String));
  });

  it('a checker error keeps the order; orders without an intent / COD still fail', async () => {
    const b = build();
    const fail = jest
      .spyOn(b.service, 'markOrderFailed')
      .mockResolvedValue(null);
    b.service.registerAbandonedPaymentChecker(
      jest.fn(() => Promise.reject(new Error('boom'))),
    );
    b.prisma.order.findMany.mockResolvedValueOnce([
      stale(),
      stale({ id: 'o2', stripe_payment_id: null }),
      stale({ id: 'o3', payment_method: PaymentMethod.COD }),
    ]);
    await b.internals.releaseExpiredAwaitingPaymentOrders();
    expect(fail.mock.calls.map((c) => c[0])).toEqual(['o2', 'o3']);
  });

  it('past 48 h the checker runs with hardCap; its error no longer keeps the order', async () => {
    const b = build();
    const fail = jest
      .spyOn(b.service, 'markOrderFailed')
      .mockResolvedValue(null);
    const checker: Fn = jest.fn(() => Promise.reject(new Error('stripe down')));
    b.service.registerAbandonedPaymentChecker(checker);
    b.prisma.order.findMany.mockResolvedValueOnce([
      stale({ created_at: new Date(Date.now() - 49 * HOUR) }),
    ]);
    await b.internals.releaseExpiredAwaitingPaymentOrders();
    expect(checker).toHaveBeenCalledWith(expect.anything(), {
      hardCap: true,
      processingExpired: false,
    });
    expect(fail).toHaveBeenCalledWith(
      'o1',
      expect.stringContaining('maximum time'),
    );
  });

  it('a processing payment is kept up to 21 days, then checked with processingExpired', async () => {
    const b = build();
    const fail = jest
      .spyOn(b.service, 'markOrderFailed')
      .mockResolvedValue(null);
    const checker: Fn = jest.fn(() => Promise.resolve('fail'));
    b.service.registerAbandonedPaymentChecker(checker);
    // First query (not processing) is empty; second: processing past 21 days.
    b.prisma.order.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        stale({
          created_at: new Date(Date.now() - 22 * 24 * HOUR),
          payment_processing_at: new Date(Date.now() - 7.5 * 24 * HOUR),
        }),
      ]);
    await b.internals.releaseExpiredAwaitingPaymentOrders();
    const where = (
      b.prisma.order.findMany.mock.calls[1] as unknown as [
        { where: { payment_processing_at: unknown; created_at: { lt: Date } } },
      ]
    )[0].where;
    expect(where.payment_processing_at).toEqual({ not: null });
    expect(Date.now() - where.created_at.lt.getTime()).toBeGreaterThanOrEqual(
      21 * 24 * HOUR - 1000,
    );
    expect(checker).toHaveBeenCalledWith(expect.anything(), {
      hardCap: true,
      processingExpired: true,
    });
    expect(fail).toHaveBeenCalledWith('o1', expect.any(String));

    // A processing order younger than 21 days is never released.
    const b2 = build();
    const fail2 = jest
      .spyOn(b2.service, 'markOrderFailed')
      .mockResolvedValue(null);
    await b2.internals.releaseAbandonedOrder(
      stale({
        created_at: new Date(Date.now() - 3 * 24 * HOUR),
        payment_processing_at: new Date(),
      }),
      Date.now(),
    );
    expect(fail2).not.toHaveBeenCalled();
  });

  it("checkout awaits the release of the customer's OWN stale orders only", async () => {
    const b = build();
    const fail = jest
      .spyOn(b.service, 'markOrderFailed')
      .mockResolvedValue(null);
    b.prisma.order.findMany.mockResolvedValueOnce([
      stale({ payment_method: PaymentMethod.COD, stripe_payment_id: null }),
    ]);
    await b.internals.releaseCustomerStaleOrders('cust1');
    const args = (
      b.prisma.order.findMany.mock.calls[0] as unknown as [
        { where: { AND: Record<string, unknown>[] }; take: number },
      ]
    )[0];
    expect(args.where.AND).toContainEqual({ customer_id: 'cust1' });
    expect(args.take).toBeLessThanOrEqual(5);
    expect(fail).toHaveBeenCalledWith('o1', expect.any(String));
  });

  it('one run at a time per instance', async () => {
    const b = build();
    let release!: () => void;
    b.prisma.order.findMany.mockImplementationOnce(
      () => new Promise((r) => (release = () => r([]))),
    );
    const first = b.internals.releaseExpiredAwaitingPaymentOrders();
    await b.internals.releaseExpiredAwaitingPaymentOrders();
    expect(b.prisma.order.findMany).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});

describe('OrdersService late payment after a release', () => {
  const items = [
    { product_id: 'p1', variant_id: null, quantity: 2, product: { sku: 'SKU-1' } },
    { product_id: 'p2', variant_id: 'v2', quantity: 1, product: { sku: 'SKU-2' } },
  ];

  it('re-takes stock only where it still covers the line; flags + notifies a shortfall', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(
      order({ payment_status: 'failed' }),
    );
    b.prisma.orderItem.findMany.mockResolvedValue(items);
    // p1 has only 1 left (needs 2); v2 is fine.
    b.prisma.product.updateMany.mockResolvedValueOnce({ count: 0 });
    b.prisma.product.findUnique.mockResolvedValueOnce({
      stock_quantity: 1,
      track_inventory: true,
    });
    const res = await b.service.markOrderPaid('o1', 'pi_1');
    expect(res).toMatchObject({ changed: true, stockShortfall: true });
    // Guarded decrement: never below zero.
    expect(b.prisma.product.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'p1',
        track_inventory: true,
        stock_quantity: { not: null, gte: 2 },
      },
      data: { stock_quantity: { decrement: 2 } },
    });
    expect(b.prisma.productVariant.updateMany).toHaveBeenCalledWith({
      where: { id: 'v2', stock_quantity: { not: null, gte: 1 } },
      data: { stock_quantity: { decrement: 1 } },
    });
    expect(b.prisma.orderTimeline.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'STOCK_SHORTFALL',
        note: expect.stringContaining('2 x SKU-1'),
      }),
    });
    expect(b.prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        user_id: 'owner',
        type: 'order_stock_shortfall',
      }),
    });
  });

  it('an untracked product is not a shortfall', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(
      order({ payment_status: 'failed' }),
    );
    b.prisma.orderItem.findMany.mockResolvedValue([items[0]]);
    b.prisma.product.updateMany.mockResolvedValueOnce({ count: 0 });
    b.prisma.product.findUnique.mockResolvedValueOnce({
      stock_quantity: null,
      track_inventory: false,
    });
    const res = await b.service.markOrderPaid('o1', 'pi_1');
    expect(res).toMatchObject({ stockShortfall: false });
    expect(b.prisma.notification.create).not.toHaveBeenCalled();
  });

  it('a normal payment touches neither stock nor coupons', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(order());
    await b.service.markOrderPaid('o1', 'pi_1');
    expect(b.prisma.orderItem.findMany).not.toHaveBeenCalled();
    expect(b.prisma.promotion.update).not.toHaveBeenCalled();
  });
});

describe('OrdersService coupon on failure', () => {
  it('markOrderFailed hands the redemption back once; the usage row stays', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(order());
    b.prisma.promotionUsage.findMany.mockResolvedValue([
      { promotion_id: 'promo1' },
    ]);
    await b.service.markOrderFailed('o1');
    expect(b.prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', coupon_released_at: null },
      data: { coupon_released_at: expect.any(Date) },
    });
    expect(b.promotions.releaseRedemption).toHaveBeenCalledWith('promo1');
    expect(b.prisma.promotionUsage.deleteMany).not.toHaveBeenCalled();
  });

  it('Kustom abandon after markOrderFailed: no second decrement, rows kept', async () => {
    const b = build();
    b.prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });
    b.prisma.promotionUsage.findMany.mockResolvedValue([
      { id: 'pu1', promotion_id: 'promo1' },
    ]);
    await b.service.releaseOrderCoupon('o1');
    expect(b.prisma.promotionUsage.deleteMany).not.toHaveBeenCalled();
    expect(b.promotions.releaseRedemption).not.toHaveBeenCalled();
  });

  it('Kustom abandon then late payment: the redemption is counted again', async () => {
    const b = build();
    b.prisma.promotionUsage.findMany.mockResolvedValue([
      { id: 'pu1', promotion_id: 'promo1' },
    ]);
    // Release (first claim of coupon_released_at): one decrement, rows kept.
    await b.service.releaseOrderCoupon('o1');
    expect(b.promotions.releaseRedemption).toHaveBeenCalledTimes(1);
    expect(b.prisma.promotionUsage.deleteMany).not.toHaveBeenCalled();
    // Late Kustom push on the failed order: the kept row is counted again.
    b.prisma.order.findUnique.mockResolvedValue(
      order({ payment_status: 'failed' }),
    );
    await b.service.markOrderPaid('o1', undefined, 'Kustom');
    expect(b.prisma.promotion.update).toHaveBeenCalledTimes(1);
    expect(b.prisma.promotion.update).toHaveBeenCalledWith({
      where: { id: 'promo1' },
      data: { usage_count: { increment: 1 } },
    });
    // A second (replayed) re-take finds no released marker: no double count.
    b.prisma.order.updateMany.mockResolvedValue({ count: 0 });
    await b.internals.retakeOrderCoupon('o1');
    expect(b.prisma.promotion.update).toHaveBeenCalledTimes(1);
  });

  it('a late payment takes the redemption again', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(
      order({ payment_status: 'failed' }),
    );
    b.prisma.promotionUsage.findMany.mockResolvedValue([
      { promotion_id: 'promo1' },
    ]);
    await b.service.markOrderPaid('o1', 'pi_1');
    expect(b.prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', coupon_released_at: { not: null } },
      data: { coupon_released_at: null },
    });
    expect(b.prisma.promotion.update).toHaveBeenCalledWith({
      where: { id: 'promo1' },
      data: { usage_count: { increment: 1 } },
    });
  });
});

describe('OrdersService refunds', () => {
  it('revertRefund: back to paid with the pre-refund status; stock re-taken', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(
      order({ payment_status: 'refunded', status: OrderStatus.REFUNDED }),
    );
    b.prisma.orderTimeline.findFirst.mockResolvedValueOnce({
      created_at: new Date('2026-11-05'),
    });
    b.prisma.orderTimeline.findMany.mockResolvedValueOnce([
      { status: OrderStatus.SHIPPED },
    ]);
    const res = await b.service.revertRefund('o1', 'refund failed');
    expect(res).toEqual({ changed: true, status: OrderStatus.SHIPPED });
    expect(b.prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', payment_status: 'refunded' },
      data: { payment_status: 'paid', status: OrderStatus.SHIPPED },
    });
    expect(b.prisma.orderTimeline.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'REFUND_REVERTED' }),
    });
    expect(b.prisma.orderItem.findMany).toHaveBeenCalled();
  });

  it('revertRefund is a no-op for an order that is not refunded', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(order({ payment_status: 'paid' }));
    expect(await b.service.revertRefund('o1', 'x')).toEqual({ changed: false });
    expect(b.prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('recordPartialRefund checks + inserts under a per-order advisory lock', async () => {
    const b = build();
    await b.service.recordPartialRefund('o1', 50, 'sek');
    expect(b.prisma.lockKeys).toEqual(['order_refund:o1']);
    expect(b.prisma.orderTimeline.create).toHaveBeenCalledTimes(1);
  });
});
