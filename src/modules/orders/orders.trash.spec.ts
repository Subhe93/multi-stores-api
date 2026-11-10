import { ConfigService } from '@nestjs/config';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { OrderStatus, UserRole } from '@prisma/client';
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
import type { SecurityAuditService } from '../security/security-audit.service';
import {
  deletableReason,
  orderHoldsStock,
  withoutDeletedBy,
} from './order-trash';

// Order trash (M69, plans/order-trash/SPEC.md): the deletable guard matrix,
// the delete side effects (stock + coupon back, timeline, audit), restore,
// bulk partial results, the admin test flag and the `deleted=1` list filter.

type Fn = jest.Mock;

const ADMIN = { id: 'admin-1', email: 'admin@test', role: UserRole.ADMIN };
const CREATOR = { id: 'user-c1', email: 'c1@test', role: UserRole.CREATOR };

function makePrisma() {
  const prisma = {
    order: {
      findUnique: jest.fn((): Promise<unknown> => Promise.resolve(null)),
      findMany: jest.fn((): Promise<unknown> => Promise.resolve([])),
      count: jest.fn(() => Promise.resolve(0)),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    orderTimeline: {
      create: jest.fn(() => Promise.resolve({})),
    },
    orderItem: {
      findMany: jest.fn((): Promise<unknown> => Promise.resolve([])),
    },
    product: { updateMany: jest.fn(() => Promise.resolve({ count: 1 })) },
    productVariant: {
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    promotionUsage: {
      findMany: jest.fn((): Promise<unknown> => Promise.resolve([])),
    },
    promotion: { update: jest.fn(() => Promise.resolve({})) },
    creator: {
      findUnique: jest.fn(
        (): Promise<unknown> =>
          Promise.resolve({ id: 'cr1', store: { id: 's1' } }),
      ),
    },
    $transaction: jest.fn(),
  };
  // The transaction client is the same double: every write is visible.
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(prisma),
  );
  return prisma;
}

function build() {
  const prisma = makePrisma();
  const promotions = { releaseRedemption: jest.fn(() => Promise.resolve()) };
  const mail = { dispatchOrderEmail: jest.fn(() => Promise.resolve()) };
  const audit = { record: jest.fn(() => Promise.resolve()) };
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
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    audit as unknown as SecurityAuditService,
  );
  // The handlers end with findById (a wide include); the detail is not
  // under test here, so it echoes the id.
  const findById = jest
    .spyOn(service, 'findById')
    .mockImplementation((id: string) => Promise.resolve({ id } as never));
  return { service, prisma, promotions, mail, audit, findById };
}

/** A real, never-paid card order of store s1 (deletable). */
const order = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  order_number: 'MS-1',
  store_id: 's1',
  status: OrderStatus.PENDING,
  payment_status: 'awaiting_payment',
  paid_at: null,
  stripe_charge_id: null,
  kustom_capture_id: null,
  coupon_released_at: null,
  is_test: false,
  total: 299,
  currency: 'SEK',
  deleted_at: null,
  deleted_by: null,
  _count: { payouts: 0, invoices: 0 },
  ...over,
});

const timelineRows = (prisma: ReturnType<typeof makePrisma>) =>
  (prisma.orderTimeline.create as Fn).mock.calls.map(
    (c: [{ data: Record<string, unknown> }]) => c[0].data,
  );

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return (
      e as { getResponse: () => { code: string; reason?: string } }
    ).getResponse();
  }
};

describe('deletable guard (deletableReason)', () => {
  it.each([
    ['never paid, pending', { payment_status: 'pending' }, null],
    [
      'never paid, awaiting_payment',
      { payment_status: 'awaiting_payment' },
      null,
    ],
    ['failed payment', { payment_status: 'failed' }, null],
    ['cancelled payment', { payment_status: 'cancelled' }, null],
    ['legacy null payment status', { payment_status: null }, null],
    ['paid', { payment_status: 'paid' }, 'paid'],
    ['refunded', { payment_status: 'refunded' }, 'paid'],
    ['paid_at set', { paid_at: new Date() }, 'paid'],
    ['stripe charge', { stripe_charge_id: 'ch_1' }, 'paid'],
    ['kustom capture', { kustom_capture_id: 'cap_1' }, 'paid'],
    ['has invoice', { _count: { payouts: 0, invoices: 1 } }, 'invoiced'],
    ['has payout', { _count: { payouts: 1, invoices: 0 } }, 'paid_out'],
    [
      'invoiced wins over paid_out',
      { _count: { payouts: 1, invoices: 1 } },
      'invoiced',
    ],
    [
      'test order, even when paid',
      { is_test: true, payment_status: 'paid', paid_at: new Date() },
      null,
    ],
    [
      'test order with a payout',
      { is_test: true, _count: { payouts: 1, invoices: 0 } },
      null,
    ],
  ])('%s → %s', (_label, over, expected) => {
    expect(deletableReason(order(over))).toBe(expected);
  });
});

describe('orderHoldsStock', () => {
  it('holds while live and not failed / refunded', () => {
    expect(orderHoldsStock(order())).toBe(true);
    expect(orderHoldsStock(order({ payment_status: 'pending' }))).toBe(true);
    expect(orderHoldsStock(order({ payment_status: 'failed' }))).toBe(false);
    expect(orderHoldsStock(order({ payment_status: 'refunded' }))).toBe(false);
    expect(orderHoldsStock(order({ status: OrderStatus.CANCELLED }))).toBe(
      false,
    );
    expect(orderHoldsStock(order({ status: OrderStatus.REFUNDED }))).toBe(
      false,
    );
    expect(orderHoldsStock(order({ status: OrderStatus.RETURNED }))).toBe(
      false,
    );
  });

  it('withoutDeletedBy strips only that field', () => {
    expect(withoutDeletedBy({ id: 'o1', deleted_by: 'u' })).toEqual({
      id: 'o1',
    });
    expect(withoutDeletedBy(null)).toBeNull();
  });
});

describe('OrdersService.deleteOrder', () => {
  it('trashes a never-paid order: claim, timeline, stock + coupon back, audit, no mail', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(order());
    b.prisma.orderItem.findMany.mockResolvedValue([
      { product_id: 'p1', variant_id: null, quantity: 2 },
      { product_id: 'p2', variant_id: 'v1', quantity: 1 },
    ]);
    b.prisma.promotionUsage.findMany.mockResolvedValue([
      { promotion_id: 'promo1' },
    ]);

    const res = await b.service.deleteOrder('o1', CREATOR, 'duplicate', {
      ip: '1.1.1.1',
      userAgent: 'jest',
    });
    expect(res).toEqual({ id: 'o1' });

    // The claim sets deleted_at / deleted_by only on a live row.
    const claim = (b.prisma.order.updateMany as Fn).mock.calls[0][0];
    expect(claim.where).toEqual({
      id: 'o1',
      deleted_at: null,
      paid_at: null,
      stripe_charge_id: null,
      kustom_capture_id: null,
      payment_status: 'awaiting_payment',
    });
    expect(claim.data.deleted_by).toBe('user-c1');
    expect(claim.data.deleted_at).toBeInstanceOf(Date);
    expect(b.prisma.$transaction).toHaveBeenCalledTimes(1);

    const rows = timelineRows(b.prisma);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      order_id: 'o1',
      status: 'DELETED',
      actor: 'creator:user-c1',
    });
    expect(rows[0].note).toBe('duplicate — Stock was returned');

    // Stock back (held: PENDING / awaiting_payment).
    expect(b.prisma.product.updateMany).toHaveBeenCalledTimes(1);
    expect(b.prisma.productVariant.updateMany).toHaveBeenCalledTimes(1);
    expect((b.prisma.product.updateMany as Fn).mock.calls[0][0].data).toEqual({
      stock_quantity: { increment: 2 },
    });

    // Coupon redemption handed back (coupon_released_at claim + release).
    const couponClaim = (b.prisma.order.updateMany as Fn).mock.calls[1][0];
    expect(couponClaim.where).toEqual({ id: 'o1', coupon_released_at: null });
    expect(b.promotions.releaseRedemption).toHaveBeenCalledWith('promo1');

    expect(b.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'order.deleted',
        actor: { id: 'user-c1', email: 'c1@test', role: UserRole.CREATOR },
        targetType: 'order',
        targetId: 'o1',
        targetLabel: 'MS-1',
        fields: expect.arrayContaining([
          'order_number: MS-1',
          'total: 299 SEK',
          'is_test: false',
          'store_id: s1',
        ]),
        meta: { ip: '1.1.1.1', userAgent: 'jest' },
      }),
    );
    expect(b.mail.dispatchOrderEmail).not.toHaveBeenCalled();
    expect(b.findById).toHaveBeenCalledWith('o1', 'user-c1', UserRole.CREATOR);
  });

  it('does not restore stock of a failed order (already returned) and skips a released coupon', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(
      order({ payment_status: 'failed', coupon_released_at: new Date() }),
    );
    b.prisma.orderItem.findMany.mockResolvedValue([
      { product_id: 'p1', variant_id: null, quantity: 2 },
    ]);
    await b.service.deleteOrder('o1', ADMIN);
    expect(b.prisma.product.updateMany).not.toHaveBeenCalled();
    expect(b.prisma.promotionUsage.findMany).not.toHaveBeenCalled();
    const rows = timelineRows(b.prisma);
    expect(rows[0]).toMatchObject({
      status: 'DELETED',
      actor: 'admin:admin-1',
    });
    expect(rows[0].note).toBeNull();
  });

  it('does not restore stock of a cancelled order', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(
      order({ status: OrderStatus.CANCELLED, payment_status: 'pending' }),
    );
    b.prisma.orderItem.findMany.mockResolvedValue([
      { product_id: 'p1', variant_id: null, quantity: 2 },
    ]);
    await b.service.deleteOrder('o1', ADMIN);
    expect(b.prisma.product.updateMany).not.toHaveBeenCalled();
  });

  it('409 ORDER_NOT_DELETABLE with the reason for a paid real order; nothing is written', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(
      order({ payment_status: 'paid', paid_at: new Date() }),
    );
    const err = await code(b.service.deleteOrder('o1', ADMIN));
    expect(err).toMatchObject({ code: 'ORDER_NOT_DELETABLE', reason: 'paid' });
    expect(b.prisma.order.updateMany).not.toHaveBeenCalled();
    expect(b.prisma.orderTimeline.create).not.toHaveBeenCalled();
    expect(b.audit.record).not.toHaveBeenCalled();

    b.prisma.order.findUnique.mockResolvedValue(
      order({ _count: { payouts: 0, invoices: 1 } }),
    );
    expect(await code(b.service.deleteOrder('o1', ADMIN))).toMatchObject({
      code: 'ORDER_NOT_DELETABLE',
      reason: 'invoiced',
    });
    b.prisma.order.findUnique.mockResolvedValue(
      order({ _count: { payouts: 2, invoices: 0 } }),
    );
    expect(await code(b.service.deleteOrder('o1', ADMIN))).toMatchObject({
      code: 'ORDER_NOT_DELETABLE',
      reason: 'paid_out',
    });
  });

  it('a paid test order is deletable', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(
      order({
        is_test: true,
        payment_status: 'paid',
        paid_at: new Date(),
        stripe_charge_id: 'ch_1',
      }),
    );
    await expect(b.service.deleteOrder('o1', ADMIN)).resolves.toEqual({
      id: 'o1',
    });
    expect(b.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: expect.arrayContaining(['is_test: true']),
      }),
    );
  });

  it('409 ORDER_ALREADY_DELETED on a trashed order, and when the claim loses a race', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(
      order({ deleted_at: new Date(), deleted_by: 'x' }),
    );
    expect(await code(b.service.deleteOrder('o1', ADMIN))).toMatchObject({
      code: 'ORDER_ALREADY_DELETED',
    });

    // The claim misses and the re-read shows another delete won.
    b.prisma.order.findUnique
      .mockResolvedValueOnce(order())
      .mockResolvedValueOnce(order({ deleted_at: new Date() }));
    b.prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await code(b.service.deleteOrder('o1', ADMIN))).toMatchObject({
      code: 'ORDER_ALREADY_DELETED',
    });
    expect(b.prisma.orderTimeline.create).not.toHaveBeenCalled();
  });

  it('the claim is optimistic on the guard columns: a payment landing between guard and claim → 409 ORDER_NOT_DELETABLE paid', async () => {
    const b = build();
    b.prisma.order.findUnique
      .mockResolvedValueOnce(order())
      // Re-read after the missed claim: the webhook paid it meanwhile.
      .mockResolvedValueOnce(
        order({ payment_status: 'paid', paid_at: new Date() }),
      );
    b.prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });
    const err = await code(b.service.deleteOrder('o1', ADMIN));
    expect(err).toMatchObject({ code: 'ORDER_NOT_DELETABLE', reason: 'paid' });
    const claim = (b.prisma.order.updateMany as Fn).mock.calls[0][0];
    expect(claim.where).toEqual({
      id: 'o1',
      deleted_at: null,
      paid_at: null,
      stripe_charge_id: null,
      kustom_capture_id: null,
      payment_status: 'awaiting_payment',
    });
    expect(b.prisma.orderTimeline.create).not.toHaveBeenCalled();
    expect(b.prisma.product.updateMany).not.toHaveBeenCalled();
    expect(b.audit.record).not.toHaveBeenCalled();
  });

  it('a test order claims on deleted_at only (paid test orders are deletable)', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(
      order({ is_test: true, payment_status: 'paid', paid_at: new Date() }),
    );
    await b.service.deleteOrder('o1', ADMIN);
    const claim = (b.prisma.order.updateMany as Fn).mock.calls[0][0];
    expect(claim.where).toEqual({ id: 'o1', deleted_at: null });
  });

  it('a creator may only trash orders of their own store (foreign → 404); admin any', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(order({ store_id: 's2' }));
    await expect(b.service.deleteOrder('o1', CREATOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(await code(b.service.deleteOrder('o1', CREATOR))).toMatchObject({
      code: 'ORDER_NOT_FOUND',
    });
    expect(b.prisma.order.updateMany).not.toHaveBeenCalled();
    await expect(b.service.deleteOrder('o1', ADMIN)).resolves.toBeTruthy();

    // A creator without a store, and an unknown id.
    b.prisma.creator.findUnique.mockResolvedValueOnce({
      id: 'cr1',
      store: null,
    });
    expect(await code(b.service.deleteOrder('o1', CREATOR))).toMatchObject({
      code: 'ORDER_NOT_FOUND',
    });
    b.prisma.order.findUnique.mockResolvedValueOnce(null);
    expect(await code(b.service.deleteOrder('nope', ADMIN))).toMatchObject({
      code: 'ORDER_NOT_FOUND',
    });
  });

  it('other roles never reach the order', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(order());
    await expect(
      b.service.deleteOrder('o1', {
        id: 'u',
        email: 'u@test',
        role: UserRole.PROVIDER,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(b.prisma.order.findUnique).not.toHaveBeenCalled();
  });
});

describe('OrdersService.restoreOrder', () => {
  it('clears the trash fields, writes RESTORED (stock note) and audits; stock is not re-taken', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(
      order({ deleted_at: new Date(), deleted_by: 'admin-1' }),
    );
    await expect(b.service.restoreOrder('o1', CREATOR)).resolves.toEqual({
      id: 'o1',
    });
    const flip = (b.prisma.order.updateMany as Fn).mock.calls[0][0];
    expect(flip.where).toEqual({ id: 'o1', deleted_at: { not: null } });
    expect(flip.data).toEqual({ deleted_at: null, deleted_by: null });
    expect(timelineRows(b.prisma)[0]).toEqual({
      order_id: 'o1',
      status: 'RESTORED',
      note: 'Restored. Stock was returned on delete; adjust manually.',
      actor: 'creator:user-c1',
    });
    expect(b.prisma.product.updateMany).not.toHaveBeenCalled();
    expect(b.prisma.productVariant.updateMany).not.toHaveBeenCalled();
    expect(b.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'order.restored', targetId: 'o1' }),
    );
  });

  it('a failed order restores with a plain note (no stock moved on delete)', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(
      order({ deleted_at: new Date(), payment_status: 'failed' }),
    );
    await b.service.restoreOrder('o1', ADMIN);
    expect(timelineRows(b.prisma)[0].note).toBe('Restored.');
  });

  it('409 ORDER_NOT_DELETED on a live order and on a lost race', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(order());
    expect(await code(b.service.restoreOrder('o1', ADMIN))).toMatchObject({
      code: 'ORDER_NOT_DELETED',
    });
    b.prisma.order.findUnique.mockResolvedValue(
      order({ deleted_at: new Date() }),
    );
    b.prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await code(b.service.restoreOrder('o1', ADMIN))).toMatchObject({
      code: 'ORDER_NOT_DELETED',
    });
    expect(b.audit.record).not.toHaveBeenCalled();
  });
});

describe('bulk delete / restore', () => {
  it('reports per id: deleted ones, and skipped ones with code + reason; a failure never blocks the rest', async () => {
    const b = build();
    const rows: Record<string, unknown> = {
      a: order({ id: 'a' }),
      b: order({ id: 'b', payment_status: 'paid', paid_at: new Date() }),
      c: order({ id: 'c', deleted_at: new Date() }),
      d: order({ id: 'd', store_id: 's2' }),
      e: order({ id: 'e', is_test: true, payment_status: 'paid' }),
    };
    (b.prisma.order.findUnique as jest.Mock).mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(rows[where.id] ?? null),
    );
    const res = await b.service.bulkDeleteOrders(
      ['a', 'b', 'c', 'd', 'e', 'zz', 'a'],
      CREATOR,
      'cleanup',
    );
    expect(res).toEqual({
      deleted: ['a', 'e'],
      skipped: [
        { id: 'b', code: 'ORDER_NOT_DELETABLE', reason: 'paid' },
        { id: 'c', code: 'ORDER_ALREADY_DELETED' },
        { id: 'd', code: 'ORDER_NOT_FOUND' },
        { id: 'zz', code: 'ORDER_NOT_FOUND' },
      ],
    });
    // One transaction per trashed order; the detail is not loaded in bulk.
    expect(b.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(b.findById).not.toHaveBeenCalled();
    expect(b.audit.record).toHaveBeenCalledTimes(2);
    expect(timelineRows(b.prisma).map((r) => r.note)).toEqual([
      'cleanup — Stock was returned',
      'cleanup — Stock was returned',
    ]);
  });

  it('an unexpected error is reported as ORDER_TRASH_FAILED, not thrown', async () => {
    const b = build();
    b.prisma.order.findUnique
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(order({ id: 'b' }));
    const res = await b.service.bulkDeleteOrders(['a', 'b'], ADMIN);
    expect(res).toEqual({
      deleted: ['b'],
      skipped: [{ id: 'a', code: 'ORDER_TRASH_FAILED' }],
    });
  });

  it('bulk restore: restored + skipped (not deleted / foreign)', async () => {
    const b = build();
    const rows: Record<string, unknown> = {
      a: order({ id: 'a', deleted_at: new Date() }),
      b: order({ id: 'b' }),
      c: order({ id: 'c', deleted_at: new Date(), store_id: 's2' }),
    };
    (b.prisma.order.findUnique as jest.Mock).mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(rows[where.id] ?? null),
    );
    const res = await b.service.bulkRestoreOrders(['a', 'b', 'c'], CREATOR);
    expect(res).toEqual({
      restored: ['a'],
      skipped: [
        { id: 'b', code: 'ORDER_NOT_DELETED' },
        { id: 'c', code: 'ORDER_NOT_FOUND' },
      ],
    });
  });
});

describe('OrdersService.setTestFlag (admin)', () => {
  it('flags the order, writes TEST_FLAG and audits; removing it likewise', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(
      order({ _count: { invoices: 0 } }),
    );
    await b.service.setTestFlag('o1', true, ADMIN);
    expect(b.prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { is_test: true },
    });
    expect(timelineRows(b.prisma)[0]).toEqual({
      order_id: 'o1',
      status: 'TEST_FLAG',
      note: 'Marked as test',
      actor: 'admin:admin-1',
    });
    expect(b.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'order.test_flag',
        fields: ['is_test: false → true'],
      }),
    );

    b.prisma.order.findUnique.mockResolvedValue(
      order({ is_test: true, _count: { invoices: 0 } }),
    );
    await b.service.setTestFlag('o1', false, ADMIN);
    expect(timelineRows(b.prisma)[1].note).toBe('Test flag removed');
  });

  it('is idempotent: no write when the flag already has that value', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(
      order({ is_test: true, _count: { invoices: 0 } }),
    );
    await expect(b.service.setTestFlag('o1', true, ADMIN)).resolves.toEqual({
      id: 'o1',
    });
    expect(b.prisma.order.update).not.toHaveBeenCalled();
    expect(b.prisma.orderTimeline.create).not.toHaveBeenCalled();
    expect(b.audit.record).not.toHaveBeenCalled();
  });

  it('409 ORDER_DELETED on a trashed order, 409 ORDER_INVOICED when flagging an invoiced order, 404 unknown', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(
      order({ deleted_at: new Date(), _count: { invoices: 0 } }),
    );
    expect(await code(b.service.setTestFlag('o1', true, ADMIN))).toMatchObject({
      code: 'ORDER_DELETED',
    });
    b.prisma.order.findUnique.mockResolvedValue(
      order({ _count: { invoices: 1 } }),
    );
    await expect(
      b.service.setTestFlag('o1', true, ADMIN),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await code(b.service.setTestFlag('o1', true, ADMIN))).toMatchObject({
      code: 'ORDER_INVOICED',
    });
    // Removing the flag from an invoiced order is fine.
    b.prisma.order.findUnique.mockResolvedValue(
      order({ is_test: true, _count: { invoices: 1 } }),
    );
    await expect(b.service.setTestFlag('o1', false, ADMIN)).resolves.toEqual({
      id: 'o1',
    });
    b.prisma.order.findUnique.mockResolvedValue(null);
    expect(await code(b.service.setTestFlag('x', true, ADMIN))).toMatchObject({
      code: 'ORDER_NOT_FOUND',
    });
  });
});

describe('trashed orders are frozen', () => {
  it('updateStatus → 409 ORDER_DELETED before any write', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(
      order({ deleted_at: new Date() }),
    );
    expect(
      await code(
        b.service.updateStatus(
          'o1',
          { status: OrderStatus.SHIPPED },
          'admin-1',
          UserRole.ADMIN,
        ),
      ),
    ).toMatchObject({ code: 'ORDER_DELETED' });
    expect(b.prisma.order.update).not.toHaveBeenCalled();
  });

  it('a late payment restores the trashed order first, then re-takes stock and coupon', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(
      order({ deleted_at: new Date(), customer: { user_id: 'u1' } }),
    );
    b.prisma.orderItem.findMany.mockResolvedValue([]);
    const res = await b.service.markOrderPaid('o1', 'pi_1');
    expect(res?.changed).toBe(true);
    const calls = (b.prisma.order.updateMany as Fn).mock.calls.map(
      (c: [{ where: unknown }]) => c[0].where,
    );
    // Restore claim first, then the paid flip, then the coupon re-take.
    expect(calls[0]).toEqual({ id: 'o1', deleted_at: { not: null } });
    expect(calls[1]).toEqual({
      id: 'o1',
      payment_status: { not: 'paid' },
      deleted_at: null,
    });
    expect(calls[2]).toEqual({ id: 'o1', coupon_released_at: { not: null } });
    const rows = timelineRows(b.prisma);
    expect(rows[0]).toEqual({
      order_id: 'o1',
      status: 'RESTORED',
      note: 'Restored: payment arrived',
      actor: 'system',
    });
    expect(rows[1]).toMatchObject({ status: 'PAID' });
  });

  it('a trashed CANCELLED order paid late re-takes the coupon but not the stock', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(
      order({
        deleted_at: new Date(),
        status: OrderStatus.CANCELLED,
        customer: { user_id: 'u1' },
      }),
    );
    const res = await b.service.markOrderPaid('o1', 'pi_1');
    expect(res?.changed).toBe(true);
    expect(b.prisma.orderItem.findMany).not.toHaveBeenCalled();
    const calls = (b.prisma.order.updateMany as Fn).mock.calls.map(
      (c: [{ where: unknown }]) => c[0].where,
    );
    expect(calls[2]).toEqual({ id: 'o1', coupon_released_at: { not: null } });
  });

  it('delete landing between the read and the paid flip: the flip misses, the order is restored and flipped again', async () => {
    const b = build();
    b.prisma.order.findUnique
      // Live at the first read…
      .mockResolvedValueOnce(order({ customer: { user_id: 'u1' } }))
      // …trashed by the time the flip ran (re-read).
      .mockResolvedValueOnce(
        order({ deleted_at: new Date(), customer: { user_id: 'u1' } }),
      );
    b.prisma.order.updateMany
      .mockResolvedValueOnce({ count: 0 }) // paid flip misses (deleted_at set)
      .mockResolvedValueOnce({ count: 1 }) // restore claim
      .mockResolvedValueOnce({ count: 1 }) // paid flip
      .mockResolvedValueOnce({ count: 1 }); // coupon re-take
    b.prisma.orderItem.findMany.mockResolvedValue([]);
    const res = await b.service.markOrderPaid('o1', 'pi_1');
    expect(res?.changed).toBe(true);
    const calls = (b.prisma.order.updateMany as Fn).mock.calls.map(
      (c: [{ where: unknown }]) => c[0].where,
    );
    expect(calls).toEqual([
      { id: 'o1', payment_status: { not: 'paid' }, deleted_at: null },
      { id: 'o1', deleted_at: { not: null } },
      { id: 'o1', payment_status: { not: 'paid' }, deleted_at: null },
      { id: 'o1', coupon_released_at: { not: null } },
    ]);
    const rows = timelineRows(b.prisma);
    expect(rows.map((r) => r.status)).toEqual(['RESTORED', 'PAID']);
    expect(rows[0].note).toBe('Restored: payment arrived');
  });

  it('a missed flip on an order paid by a concurrent delivery is a no-op (no restore, no timeline)', async () => {
    const b = build();
    b.prisma.order.findUnique
      .mockResolvedValueOnce(order({ customer: { user_id: 'u1' } }))
      .mockResolvedValueOnce(
        order({ payment_status: 'paid', customer: { user_id: 'u1' } }),
      );
    b.prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await b.service.markOrderPaid('o1', 'pi_1');
    expect(res?.changed).toBe(false);
    expect(b.prisma.order.updateMany).toHaveBeenCalledTimes(1);
    expect(b.prisma.orderTimeline.create).not.toHaveBeenCalled();
  });

  it('defensive: an order that is paid AND trashed is restored on the next payment event', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue(
      order({
        payment_status: 'paid',
        deleted_at: new Date(),
        customer: { user_id: 'u1' },
      }),
    );
    const res = await b.service.markOrderPaid('o1', 'pi_1');
    expect(res?.changed).toBe(false);
    expect((b.prisma.order.updateMany as Fn).mock.calls[0][0].where).toEqual({
      id: 'o1',
      deleted_at: { not: null },
    });
    expect(timelineRows(b.prisma)[0]).toMatchObject({ status: 'RESTORED' });
  });
});

describe('list filter deleted=1 and visibility', () => {
  it('creator list: default live only, deleted=true only trashed', async () => {
    const b = build();
    await b.service.findByRole('user-c1', UserRole.CREATOR, 1, 20);
    let where = (b.prisma.order.findMany as Fn).mock.calls[0][0].where;
    expect(where).toMatchObject({ store_id: 's1', deleted_at: null });

    await b.service.findByRole(
      'user-c1',
      UserRole.CREATOR,
      1,
      20,
      OrderStatus.PENDING,
      undefined,
      undefined,
      undefined,
      true,
    );
    where = (b.prisma.order.findMany as Fn).mock.calls[1][0].where;
    expect(where).toMatchObject({
      store_id: 's1',
      deleted_at: { not: null },
      status: OrderStatus.PENDING,
    });
    expect((b.prisma.order.count as Fn).mock.calls[1][0].where).toEqual(where);
  });

  it('admin list honours the flag; provider list never shows trashed orders', async () => {
    const b = build();
    await b.service.findAll(1, 20, undefined, undefined, undefined, true);
    expect(
      (b.prisma.order.findMany as Fn).mock.calls[0][0].where.deleted_at,
    ).toEqual({ not: null });
    await b.service.findAll();
    expect(
      (b.prisma.order.findMany as Fn).mock.calls[1][0].where.deleted_at,
    ).toBeNull();
  });

  it('customer list excludes trashed orders', async () => {
    const b = build();
    const prisma = b.prisma as unknown as Record<string, unknown>;
    prisma.customer = {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'c1', user: { store_id: 's1' } }),
      ),
    };
    await b.service.findByCustomer('u1');
    expect(
      (b.prisma.order.findMany as Fn).mock.calls[0][0].where,
    ).toMatchObject({ customer_id: 'c1', deleted_at: null });
  });

  it('the abandonment sweep skips trashed orders', async () => {
    const b = build();
    const internals = b.service as unknown as Record<
      string,
      (...a: unknown[]) => Promise<unknown>
    >;
    await internals.runAbandonedSweep();
    const [stale, processing] = (b.prisma.order.findMany as Fn).mock.calls.map(
      (c: [{ where: Record<string, unknown> }]) => c[0].where,
    );
    expect(stale.deleted_at).toBeNull();
    expect(processing.deleted_at).toBeNull();
  });
});
