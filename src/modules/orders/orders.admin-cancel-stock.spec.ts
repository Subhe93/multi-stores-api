import { ConfigService } from '@nestjs/config';
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
import { forBuyer } from './buyer-order-view';
import { forProvider } from './provider-order-view';

// An admin setting an order to CANCELLED / REFUNDED returns its stock once
// (timeline marker STOCK_RETURNED), and every other stock path knows about
// it: a payment failure or a Stripe refund arriving afterwards does not
// return it again, a late payment does not take it for a cancelled order,
// and moving the order back to a live status takes it again
// (STOCK_RETAKEN). Orders cancelled before the marker existed behave as
// they always did.
//
// The double keeps one order, its lines, the stock rows and the timeline in
// memory and evaluates the `where` of the conditional writes with SQL NULL
// semantics (NOT IN / <> never match NULL), so the claims are really
// exercised.

type Cond =
  | string
  | null
  | { in?: unknown[]; notIn?: unknown[]; not?: unknown; lt?: unknown };
type Where = { [key: string]: Cond | Where[] | undefined };

function matches(row: Record<string, unknown>, where: Where): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === 'OR') {
      if (!(cond as Where[]).some((w) => matches(row, w))) return false;
      continue;
    }
    const value = row[key];
    if (cond === null || typeof cond !== 'object') {
      if (value !== cond) return false;
      continue;
    }
    const c = cond as { in?: unknown[]; notIn?: unknown[]; not?: unknown };
    if (c.in && !c.in.includes(value)) return false;
    if (c.notIn && (value == null || c.notIn.includes(value))) return false;
    if ('not' in c && c.not !== null && (value == null || value === c.not)) {
      return false;
    }
  }
  return true;
}

type Line = {
  product_id: string | null;
  variant_id: string | null;
  custom_product_id?: string | null;
  quantity: number;
};

type World = {
  status: OrderStatus;
  payment_status: string | null;
  created_at?: Date;
  lines: Line[];
  products?: Record<
    string,
    {
      track_inventory: boolean;
      stock_quantity: number | null;
      creator_id?: string | null;
    }
  >;
  variants?: Record<
    string,
    { stock_quantity: number | null; product_id: string }
  >;
  /** custom product id → base product id. */
  customProducts?: Record<string, string>;
  /** Timeline rows the order already has (oldest first). */
  timeline?: { status: string; note?: string }[];
  config?: Record<string, string>;
};

function build(world: World) {
  const order: Record<string, unknown> = {
    id: 'o1',
    order_number: 'ORD-1',
    store_id: 's1',
    status: world.status,
    payment_status: world.payment_status,
    payment_method: 'STRIPE',
    total: 100,
    deleted_at: null,
    created_at: world.created_at ?? new Date('2026-11-01T10:00:00Z'),
    customer: { user_id: 'u1' },
  };
  const products = world.products ?? {};
  const variants = world.variants ?? {};
  const customProducts = world.customProducts ?? {};
  let clock = 0;
  const timeline: {
    status: string;
    note: string | null;
    created_at: number;
  }[] = (world.timeline ?? []).map((t) => ({
    status: t.status,
    note: t.note ?? null,
    created_at: clock++,
  }));

  const stockWrite =
    (table: Record<string, { stock_quantity: number | null }>) =>
    ({
      where,
      data,
    }: {
      where: {
        id: string;
        track_inventory?: boolean;
        stock_quantity?: { not?: null; gte?: number };
      };
      data: { stock_quantity: { increment?: number; decrement?: number } };
    }) => {
      const row = table[where.id] as
        | { stock_quantity: number | null; track_inventory?: boolean }
        | undefined;
      if (!row) return Promise.resolve({ count: 0 });
      if (where.track_inventory && row.track_inventory !== true) {
        return Promise.resolve({ count: 0 });
      }
      if (where.stock_quantity && row.stock_quantity === null) {
        return Promise.resolve({ count: 0 });
      }
      const gte = where.stock_quantity?.gte;
      if (gte !== undefined && (row.stock_quantity as number) < gte) {
        return Promise.resolve({ count: 0 });
      }
      row.stock_quantity =
        (row.stock_quantity as number) +
        (data.stock_quantity.increment ?? 0) -
        (data.stock_quantity.decrement ?? 0);
      return Promise.resolve({ count: 1 });
    };

  const prisma = {
    order: {
      findUnique: jest.fn(() => Promise.resolve({ ...order })),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        Object.assign(order, data);
        return Promise.resolve({ ...order });
      }),
      updateMany: jest.fn(
        ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
          if (!matches(order, where)) return Promise.resolve({ count: 0 });
          Object.assign(order, data);
          return Promise.resolve({ count: 1 });
        },
      ),
    },
    orderTimeline: {
      create: jest.fn(
        ({ data }: { data: { status: string; note?: string | null } }) => {
          timeline.push({
            status: data.status,
            note: data.note ?? null,
            created_at: clock++,
          });
          return Promise.resolve({});
        },
      ),
      findFirst: jest.fn(({ where }: { where: Where }) => {
        const { order_id: _o, ...rest } = where;
        const hit = [...timeline]
          .reverse()
          .find((t) => matches(t as Record<string, unknown>, rest));
        return Promise.resolve(hit ?? null);
      }),
      findMany: jest.fn(({ where }: { where: Where }) => {
        const { order_id: _o, created_at, ...rest } = where;
        const before = (created_at as { lt?: number } | undefined)?.lt;
        const hit = [...timeline]
          .reverse()
          .find(
            (t) =>
              matches(t as Record<string, unknown>, rest) &&
              (before === undefined || t.created_at < before),
          );
        return Promise.resolve(hit ? [hit] : []);
      }),
    },
    orderCommission: {
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    orderItem: {
      findMany: jest.fn(() =>
        Promise.resolve(
          world.lines.map((l) => {
            const base = l.custom_product_id
              ? customProducts[l.custom_product_id]
              : undefined;
            return {
              product_id: l.product_id,
              variant_id: l.variant_id,
              quantity: l.quantity,
              custom_product_id: l.custom_product_id ?? null,
              variant_options_snapshot: null,
              order: { created_at: order.created_at },
              custom_product: base
                ? { product_id: base, product: { ...products[base] } }
                : null,
              variant: l.variant_id
                ? {
                    stock_quantity: variants[l.variant_id].stock_quantity,
                    product: {
                      creator_id:
                        products[variants[l.variant_id].product_id]
                          ?.creator_id ?? 'c1',
                    },
                  }
                : null,
              product: l.product_id
                ? {
                    ...products[l.product_id],
                    creator_id: products[l.product_id]?.creator_id ?? 'c1',
                    sku: null,
                    translations: [],
                  }
                : null,
            };
          }),
        ),
      ),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    product: {
      updateMany: jest.fn(stockWrite(products)),
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(products[where.id] ?? null),
      ),
    },
    productVariant: {
      updateMany: jest.fn(stockWrite(variants)),
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(variants[where.id] ?? null),
      ),
    },
    store: { findUnique: jest.fn(() => Promise.resolve(null)) },
    notification: { create: jest.fn(() => Promise.resolve({})) },
    $executeRaw: jest.fn(() => Promise.resolve(1)),
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  const mail = { dispatchOrderEmail: jest.fn(() => Promise.resolve()) };
  const config = { get: jest.fn((key: string) => world.config?.[key]) };
  const service = new OrdersService(
    prisma as unknown as PrismaService,
    {} as PromotionsService,
    {} as ShippingService,
    mail as unknown as MailService,
    {} as TaxService,
    {} as MarketsContextService,
    {} as MarketPricingService,
    config as unknown as ConfigService,
    {} as B2bService,
    ...personalizationCoreArgs(prisma),
  );
  const internals = service as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  jest.spyOn(service, 'findById').mockResolvedValue({} as never);
  // Not part of the stock story: coupons and the Meta report.
  jest
    .spyOn(internals, 'releaseFailedOrderCoupon')
    .mockImplementation(() => Promise.resolve());
  jest
    .spyOn(internals, 'retakeOrderCoupon')
    .mockImplementation(() => Promise.resolve());
  jest.spyOn(internals, 'reportPurchaseToMeta').mockReturnValue(undefined);
  const revalidate = jest
    .spyOn(internals, 'revalidateStockMoves')
    .mockReturnValue(undefined);
  const admin = (status: OrderStatus) =>
    service.updateStatus('o1', { status }, 'admin1', UserRole.ADMIN);
  const markers = () =>
    timeline
      .map((t) => t.status)
      .filter((s) => s === 'STOCK_RETURNED' || s === 'STOCK_RETAKEN');
  return {
    service,
    prisma,
    order,
    products,
    variants,
    timeline,
    admin,
    markers,
    revalidate,
  };
}

const ownProduct = (stock: number | null = 5, track = true) => ({
  p1: { track_inventory: track, stock_quantity: stock, creator_id: 'c1' },
});
const oneOwnLine: Line[] = [
  { product_id: 'p1', variant_id: null, quantity: 2 },
];

describe('admin CANCELLED / REFUNDED returns the stock once', () => {
  it.each([OrderStatus.CANCELLED, OrderStatus.REFUNDED])(
    '%s on a paid live order: stock back, marker written, storefront refreshed',
    async (status) => {
      const b = build({
        status: OrderStatus.CONFIRMED,
        payment_status: 'paid',
        lines: oneOwnLine,
        products: ownProduct(5),
      });
      await b.admin(status);
      expect(b.order.status).toBe(status);
      expect(b.products.p1.stock_quantity).toBe(7);
      expect(b.markers()).toEqual(['STOCK_RETURNED']);
      expect(b.revalidate).toHaveBeenCalledTimes(1);
      expect(b.revalidate).toHaveBeenCalledWith([
        expect.objectContaining({ kind: 'product', id: 'p1', delta: 2 }),
      ]);
      // The status row of the change itself is still written.
      expect(b.timeline.map((t) => t.status)).toContain(status);
    },
  );

  it('cancel twice: the second request returns nothing', async () => {
    const b = build({
      status: OrderStatus.CONFIRMED,
      payment_status: 'paid',
      lines: oneOwnLine,
      products: ownProduct(5),
    });
    await b.admin(OrderStatus.CANCELLED);
    await b.admin(OrderStatus.CANCELLED);
    await b.admin(OrderStatus.REFUNDED);
    expect(b.products.p1.stock_quantity).toBe(7);
    expect(b.markers()).toEqual(['STOCK_RETURNED']);
  });

  it('two requests racing on the same read: only the one that claims returns', async () => {
    const b = build({
      status: OrderStatus.CONFIRMED,
      payment_status: 'paid',
      lines: oneOwnLine,
      products: ownProduct(5),
    });
    // Both requests read the order while it is still CONFIRMED.
    const stale = { ...b.order };
    b.prisma.order.findUnique.mockResolvedValue(stale as never);
    await Promise.all([
      b.admin(OrderStatus.CANCELLED),
      b.admin(OrderStatus.CANCELLED),
    ]);
    expect(b.products.p1.stock_quantity).toBe(7);
    expect(b.markers()).toEqual(['STOCK_RETURNED']);
  });

  it('an unpaid order with a NULL payment status is claimed too', async () => {
    const b = build({
      status: OrderStatus.PENDING,
      payment_status: null,
      lines: oneOwnLine,
      products: ownProduct(5),
    });
    await b.admin(OrderStatus.CANCELLED);
    expect(b.products.p1.stock_quantity).toBe(7);
    expect(b.markers()).toEqual(['STOCK_RETURNED']);
  });

  it.each(['failed', 'refunded'])(
    'payment already %s (stock already back): nothing more is returned',
    async (payment_status) => {
      const b = build({
        status: OrderStatus.PENDING,
        payment_status,
        lines: oneOwnLine,
        products: ownProduct(5),
      });
      await b.admin(OrderStatus.CANCELLED);
      expect(b.order.status).toBe(OrderStatus.CANCELLED);
      expect(b.products.p1.stock_quantity).toBe(5);
      expect(b.markers()).toEqual([]);
    },
  );

  it('RETURNED moves no stock, as before', async () => {
    const b = build({
      status: OrderStatus.DELIVERED,
      payment_status: 'paid',
      lines: oneOwnLine,
      products: ownProduct(5),
    });
    await b.admin(OrderStatus.RETURNED);
    expect(b.products.p1.stock_quantity).toBe(5);
    expect(b.markers()).toEqual([]);
    // ...and cancelling a RETURNED order afterwards moves none either.
    await b.admin(OrderStatus.CANCELLED);
    expect(b.products.p1.stock_quantity).toBe(5);
  });

  it('any other admin status is the plain write it always was', async () => {
    const b = build({
      status: OrderStatus.CONFIRMED,
      payment_status: 'paid',
      lines: oneOwnLine,
      products: ownProduct(5),
    });
    await b.admin(OrderStatus.PROCESSING);
    expect(b.prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { status: OrderStatus.PROCESSING },
    });
    expect(b.prisma.$transaction).not.toHaveBeenCalled();
    expect(b.products.p1.stock_quantity).toBe(5);
  });
});

describe('which rows get the stock back', () => {
  it('a variant line returns to the variant, not to the product', async () => {
    const b = build({
      status: OrderStatus.CONFIRMED,
      payment_status: 'paid',
      lines: [{ product_id: 'p1', variant_id: 'v1', quantity: 3 }],
      products: ownProduct(40),
      variants: { v1: { stock_quantity: 1, product_id: 'p1' } },
    });
    await b.admin(OrderStatus.CANCELLED);
    expect(b.variants.v1.stock_quantity).toBe(4);
    expect(b.products.p1.stock_quantity).toBe(40);
  });

  it('untracked rows are never written', async () => {
    const b = build({
      status: OrderStatus.CONFIRMED,
      payment_status: 'paid',
      lines: [
        { product_id: 'p1', variant_id: null, quantity: 2 },
        { product_id: 'p1', variant_id: 'v1', quantity: 1 },
      ],
      products: ownProduct(9, false),
      variants: { v1: { stock_quantity: null, product_id: 'p1' } },
    });
    await b.admin(OrderStatus.CANCELLED);
    expect(b.products.p1.stock_quantity).toBe(9);
    expect(b.variants.v1.stock_quantity).toBeNull();
    // The order is still claimed: the marker stands.
    expect(b.markers()).toEqual(['STOCK_RETURNED']);
  });

  const imported = (created_at: Date, since?: string): World => ({
    status: OrderStatus.CONFIRMED,
    payment_status: 'paid',
    created_at,
    lines: [
      {
        product_id: null,
        variant_id: null,
        custom_product_id: 'cp1',
        quantity: 2,
      },
    ],
    products: {
      base1: { track_inventory: true, stock_quantity: 10, creator_id: null },
    },
    customProducts: { cp1: 'base1' },
    config: since ? { CUSTOM_LINE_STOCK_SINCE: since } : undefined,
  });

  it('an imported line of an order after the cut-over returns the base stock', async () => {
    const b = build(
      imported(new Date('2026-11-21T00:00:00Z'), '2026-11-20T00:00:00Z'),
    );
    await b.admin(OrderStatus.CANCELLED);
    expect(b.products.base1.stock_quantity).toBe(12);
  });

  it('an imported line of an order before the cut-over returns nothing', async () => {
    const b = build(
      imported(new Date('2026-11-19T00:00:00Z'), '2026-11-20T00:00:00Z'),
    );
    await b.admin(OrderStatus.CANCELLED);
    expect(b.products.base1.stock_quantity).toBe(10);
  });

  it('an imported line with the cut-over unset returns nothing', async () => {
    const b = build(imported(new Date('2026-11-21T00:00:00Z')));
    await b.admin(OrderStatus.CANCELLED);
    expect(b.products.base1.stock_quantity).toBe(10);
  });
});

describe('the other stock paths know about the admin return', () => {
  it('cancel, then the abandonment sweep / a failure webhook: not returned twice', async () => {
    const b = build({
      status: OrderStatus.PENDING,
      payment_status: 'pending',
      lines: oneOwnLine,
      products: ownProduct(5),
    });
    await b.admin(OrderStatus.CANCELLED);
    expect(b.products.p1.stock_quantity).toBe(7);
    const res = await b.service.markOrderFailed('o1');
    expect(res?.changed).toBe(true);
    expect(b.order.payment_status).toBe('failed');
    expect(b.products.p1.stock_quantity).toBe(7);
  });

  it('cancel, then a full Stripe refund: not returned twice', async () => {
    const b = build({
      status: OrderStatus.CONFIRMED,
      payment_status: 'paid',
      lines: oneOwnLine,
      products: ownProduct(5),
    });
    await b.admin(OrderStatus.CANCELLED);
    const res = await b.service.markOrderRefunded('o1');
    expect(res?.changed).toBe(true);
    expect(b.order.payment_status).toBe('refunded');
    expect(b.products.p1.stock_quantity).toBe(7);
  });

  it('a failure / refund on a live order still returns the stock (unchanged)', async () => {
    const failed = build({
      status: OrderStatus.PENDING,
      payment_status: 'pending',
      lines: oneOwnLine,
      products: ownProduct(5),
    });
    await failed.service.markOrderFailed('o1');
    expect(failed.products.p1.stock_quantity).toBe(7);

    const refunded = build({
      status: OrderStatus.CONFIRMED,
      payment_status: 'paid',
      lines: oneOwnLine,
      products: ownProduct(5),
    });
    await refunded.service.markOrderRefunded('o1');
    expect(refunded.products.p1.stock_quantity).toBe(7);
  });

  it('legacy: an order cancelled before the marker existed is restocked by a later refund, as before', async () => {
    const b = build({
      status: OrderStatus.CANCELLED,
      payment_status: 'paid',
      lines: oneOwnLine,
      products: ownProduct(5),
      timeline: [{ status: 'CONFIRMED' }, { status: 'CANCELLED' }],
    });
    await b.service.markOrderRefunded('o1');
    expect(b.products.p1.stock_quantity).toBe(7);
  });

  it('legacy: an order cancelled before the marker existed is restocked by a later failure, as before', async () => {
    const b = build({
      status: OrderStatus.CANCELLED,
      payment_status: 'pending',
      lines: oneOwnLine,
      products: ownProduct(5),
      timeline: [{ status: 'CANCELLED' }],
    });
    await b.service.markOrderFailed('o1');
    expect(b.products.p1.stock_quantity).toBe(7);
  });

  it('cancel, sweep failure, then a late payment: the cancelled order takes no stock', async () => {
    const b = build({
      status: OrderStatus.PENDING,
      payment_status: 'pending',
      lines: oneOwnLine,
      products: ownProduct(5),
    });
    await b.admin(OrderStatus.CANCELLED);
    await b.service.markOrderFailed('o1');
    const res = await b.service.markOrderPaid('o1');
    expect(res?.changed).toBe(true);
    expect(b.order.payment_status).toBe('paid');
    expect(b.order.status).toBe(OrderStatus.CANCELLED);
    expect(b.products.p1.stock_quantity).toBe(7);
    expect(b.markers()).toEqual(['STOCK_RETURNED']);
    // ...and the refund that follows does not return it again.
    await b.service.markOrderRefunded('o1');
    expect(b.products.p1.stock_quantity).toBe(7);
  });

  it('a late payment on a failed live order still re-takes the stock (unchanged)', async () => {
    const b = build({
      status: OrderStatus.PENDING,
      payment_status: 'failed',
      lines: oneOwnLine,
      products: ownProduct(5),
    });
    await b.service.markOrderPaid('o1');
    expect(b.products.p1.stock_quantity).toBe(3);
    expect(b.markers()).toEqual([]);
  });

  it('cancel then a late payment without a failure in between: nothing moves', async () => {
    const b = build({
      status: OrderStatus.PENDING,
      payment_status: 'pending',
      lines: oneOwnLine,
      products: ownProduct(5),
    });
    await b.admin(OrderStatus.CANCELLED);
    await b.service.markOrderPaid('o1');
    expect(b.order.status).toBe(OrderStatus.CANCELLED);
    expect(b.products.p1.stock_quantity).toBe(7);
  });
});

describe('races with a late payment, a trash and a failing stock write', () => {
  // Columns the delete claim reads (the double's order row lacks them).
  const NEVER_CHARGED = {
    paid_at: null,
    stripe_charge_id: null,
    kustom_capture_id: null,
  };
  const pendingWorld = (): World => ({
    status: OrderStatus.PENDING,
    payment_status: 'awaiting_payment',
    lines: oneOwnLine,
    products: ownProduct(5),
  });

  it('a payment that read the order before the admin cancel: the live paid order holds its stock again', async () => {
    const b = build(pendingWorld());
    // The payment webhook read the order while it was still PENDING.
    const stale = { ...b.order };
    await b.admin(OrderStatus.CANCELLED);
    expect(b.products.p1.stock_quantity).toBe(7);
    b.prisma.order.findUnique.mockResolvedValueOnce(stale as never);
    const res = await b.service.markOrderPaid('o1', 'pi_1');
    expect(res?.changed).toBe(true);
    // The flip wrote the live status of the stale read over CANCELLED...
    expect(b.order.status).toBe(OrderStatus.CONFIRMED);
    expect(b.order.payment_status).toBe('paid');
    // ...so the units are taken again, once.
    expect(b.products.p1.stock_quantity).toBe(5);
    expect(b.markers()).toEqual(['STOCK_RETURNED', 'STOCK_RETAKEN']);
  });

  it('same race, stock sold meanwhile: nothing goes negative, the shortfall is flagged', async () => {
    const b = build(pendingWorld());
    const stale = { ...b.order };
    await b.admin(OrderStatus.CANCELLED);
    b.products.p1.stock_quantity = 1;
    b.prisma.order.findUnique.mockResolvedValueOnce(stale as never);
    const res = await b.service.markOrderPaid('o1', 'pi_1');
    expect(res).toMatchObject({ changed: true, stockShortfall: true });
    expect(b.products.p1.stock_quantity).toBe(1);
    expect(b.timeline.map((t) => t.status)).toContain('STOCK_SHORTFALL');
  });

  it('the admin cancel landed after the paid flip: the order stays cancelled and takes no stock', async () => {
    const b = build(pendingWorld());
    const stale = { ...b.order };
    await b.admin(OrderStatus.CANCELLED);
    b.prisma.order.findUnique
      // The read before the flip.
      .mockResolvedValueOnce(stale as never)
      // The read after it: the cancel is the last write.
      .mockResolvedValueOnce({ status: OrderStatus.CANCELLED } as never);
    await b.service.markOrderPaid('o1', 'pi_1');
    expect(b.products.p1.stock_quantity).toBe(7);
    expect(b.markers()).toEqual(['STOCK_RETURNED']);
  });

  it('a payment on a live order nobody cancelled moves no stock (unchanged)', async () => {
    const b = build(pendingWorld());
    await b.service.markOrderPaid('o1', 'pi_1');
    expect(b.order.status).toBe(OrderStatus.CONFIRMED);
    expect(b.products.p1.stock_quantity).toBe(5);
    expect(b.markers()).toEqual([]);
  });

  it('an order trashed after the admin read it: the cancel returns nothing (the delete did)', async () => {
    const b = build(pendingWorld());
    const stale = { ...b.order };
    // The owner's delete committed: deleted_at set, stock already returned.
    b.order.deleted_at = new Date();
    b.products.p1.stock_quantity = 7;
    b.prisma.order.findUnique.mockResolvedValueOnce(stale as never);
    await b.admin(OrderStatus.CANCELLED);
    expect(b.order.status).toBe(OrderStatus.CANCELLED);
    expect(b.products.p1.stock_quantity).toBe(7);
    expect(b.markers()).toEqual([]);
  });

  it('an order cancelled by an admin after the owner read it: the delete returns nothing (the cancel did)', async () => {
    const b = build(pendingWorld());
    Object.assign(b.order, NEVER_CHARGED);
    const stale = {
      ...b.order,
      is_test: false,
      paid_at: null,
      stripe_charge_id: null,
      kustom_capture_id: null,
      coupon_released_at: null,
      currency: 'SEK',
      _count: { payouts: 0, invoices: 0 },
    };
    await b.admin(OrderStatus.CANCELLED);
    expect(b.products.p1.stock_quantity).toBe(7);
    b.prisma.order.findUnique.mockResolvedValue(stale as never);
    await b.service.deleteOrder('o1', {
      id: 'admin1',
      email: 'admin@test',
      role: UserRole.ADMIN,
    });
    expect(b.order.deleted_at).toBeInstanceOf(Date);
    expect(b.products.p1.stock_quantity).toBe(7);
    const deleted = b.timeline.find((t) => t.status === 'DELETED');
    expect(deleted?.note ?? '').not.toContain('Stock was returned');
  });

  it('a delete of a live order nobody cancelled still returns the stock (unchanged)', async () => {
    const b = build(pendingWorld());
    Object.assign(b.order, NEVER_CHARGED);
    b.prisma.order.findUnique.mockResolvedValue({
      ...b.order,
      is_test: false,
      paid_at: null,
      stripe_charge_id: null,
      kustom_capture_id: null,
      coupon_released_at: null,
      currency: 'SEK',
      _count: { payouts: 0, invoices: 0 },
    } as never);
    await b.service.deleteOrder('o1', {
      id: 'admin1',
      email: 'admin@test',
      role: UserRole.ADMIN,
    });
    expect(b.products.p1.stock_quantity).toBe(7);
    expect(b.timeline.find((t) => t.status === 'DELETED')?.note).toBe(
      'Stock was returned',
    );
  });

  it('a stock write failing inside the cancel transaction fails the request: no email, no commission write-off', async () => {
    const b = build({
      status: OrderStatus.CONFIRMED,
      payment_status: 'paid',
      lines: oneOwnLine,
      products: ownProduct(5),
    });
    // A real transaction client is not the PrismaService itself.
    b.prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({ ...b.prisma }),
    );
    b.prisma.product.updateMany.mockRejectedValueOnce(
      new Error('deadlock detected') as never,
    );
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(b.admin(OrderStatus.CANCELLED)).rejects.toThrow(
      'deadlock detected',
    );
    quiet.mockRestore();
    expect(b.revalidate).not.toHaveBeenCalled();
    expect(b.prisma.orderCommission.updateMany).not.toHaveBeenCalled();
    expect(b.timeline.map((t) => t.status)).not.toContain(
      OrderStatus.CANCELLED,
    );
  });
});

describe('back to a live status', () => {
  it('an admin-cancelled order moved back takes the stock again (STOCK_RETAKEN)', async () => {
    const b = build({
      status: OrderStatus.CONFIRMED,
      payment_status: 'paid',
      lines: oneOwnLine,
      products: ownProduct(5),
    });
    await b.admin(OrderStatus.CANCELLED);
    expect(b.products.p1.stock_quantity).toBe(7);
    await b.admin(OrderStatus.CONFIRMED);
    expect(b.order.status).toBe(OrderStatus.CONFIRMED);
    expect(b.products.p1.stock_quantity).toBe(5);
    expect(b.markers()).toEqual(['STOCK_RETURNED', 'STOCK_RETAKEN']);
    // Cancelled again: returned again, once.
    await b.admin(OrderStatus.CANCELLED);
    expect(b.products.p1.stock_quantity).toBe(7);
    expect(b.markers()).toEqual([
      'STOCK_RETURNED',
      'STOCK_RETAKEN',
      'STOCK_RETURNED',
    ]);
  });

  it('stock no longer covers it: nothing goes negative, the shortfall is flagged', async () => {
    const b = build({
      status: OrderStatus.CONFIRMED,
      payment_status: 'paid',
      lines: oneOwnLine,
      products: ownProduct(5),
    });
    await b.admin(OrderStatus.CANCELLED);
    // The returned units were sold to someone else meanwhile.
    b.products.p1.stock_quantity = 1;
    await b.admin(OrderStatus.CONFIRMED);
    expect(b.products.p1.stock_quantity).toBe(1);
    expect(b.timeline.map((t) => t.status)).toContain('STOCK_SHORTFALL');
  });

  it('legacy cancelled order (no marker) moved back: no stock is taken, as before', async () => {
    const b = build({
      status: OrderStatus.CANCELLED,
      payment_status: 'paid',
      lines: oneOwnLine,
      products: ownProduct(5),
      timeline: [{ status: 'CANCELLED' }],
    });
    await b.admin(OrderStatus.CONFIRMED);
    expect(b.order.status).toBe(OrderStatus.CONFIRMED);
    expect(b.products.p1.stock_quantity).toBe(5);
    expect(b.markers()).toEqual([]);
  });

  it('CANCELLED to RETURNED is not a move back: nothing is taken', async () => {
    const b = build({
      status: OrderStatus.CONFIRMED,
      payment_status: 'paid',
      lines: oneOwnLine,
      products: ownProduct(5),
    });
    await b.admin(OrderStatus.CANCELLED);
    await b.admin(OrderStatus.RETURNED);
    expect(b.products.p1.stock_quantity).toBe(7);
    expect(b.markers()).toEqual(['STOCK_RETURNED']);
  });
});

describe('a full refund that later fails (revertRefund)', () => {
  it('admin REFUNDED, Stripe refund, refund fails: live again, stock taken once', async () => {
    const b = build({
      status: OrderStatus.CONFIRMED,
      payment_status: 'paid',
      lines: oneOwnLine,
      products: ownProduct(5),
      timeline: [{ status: 'CONFIRMED' }],
    });
    await b.admin(OrderStatus.REFUNDED);
    await b.service.markOrderRefunded('o1');
    expect(b.products.p1.stock_quantity).toBe(7);
    const res = await b.service.revertRefund('o1', 'Refund failed');
    expect(res).toEqual({ changed: true, status: OrderStatus.CONFIRMED });
    expect(b.products.p1.stock_quantity).toBe(5);
    expect(b.markers()).toEqual(['STOCK_RETURNED', 'STOCK_RETAKEN']);
  });

  it('admin CANCELLED, Stripe refund, refund fails: cancelled again, stock stays returned', async () => {
    const b = build({
      status: OrderStatus.CONFIRMED,
      payment_status: 'paid',
      lines: oneOwnLine,
      products: ownProduct(5),
      timeline: [{ status: 'CONFIRMED' }],
    });
    await b.admin(OrderStatus.CANCELLED);
    await b.service.markOrderRefunded('o1');
    const res = await b.service.revertRefund('o1', 'Refund failed');
    expect(res).toEqual({ changed: true, status: OrderStatus.CANCELLED });
    expect(b.products.p1.stock_quantity).toBe(7);
    expect(b.markers()).toEqual(['STOCK_RETURNED']);
  });

  it('no admin step: the refund restocks and the revert re-takes (unchanged)', async () => {
    const b = build({
      status: OrderStatus.CONFIRMED,
      payment_status: 'paid',
      lines: oneOwnLine,
      products: ownProduct(5),
      timeline: [{ status: 'CONFIRMED' }],
    });
    await b.service.markOrderRefunded('o1');
    expect(b.products.p1.stock_quantity).toBe(7);
    await b.service.revertRefund('o1', 'Refund failed');
    expect(b.products.p1.stock_quantity).toBe(5);
    expect(b.markers()).toEqual([]);
  });
});

describe('internal timeline rows stay with the creator and admins', () => {
  const timeline = [
    { id: 't1', status: 'CONFIRMED' },
    { id: 't2', status: 'STOCK_RETURNED' },
    { id: 't3', status: 'CANCELLED' },
    { id: 't4', status: 'STOCK_RETAKEN' },
    { id: 't5', status: 'TRANSFER_REVERSAL_DUE' },
    { id: 't6', status: 'TRANSFER_REVERSED' },
    { id: 't7', status: 'TRANSFER_REVERSAL_FAILED' },
    { id: 't8', status: 'PARTIALLY_REFUNDED' },
  ];
  const kept = ['t1', 't3', 't8'];

  it('a buyer does not see them', () => {
    const view = forBuyer({ id: 'o1', items: [], timeline });
    expect(view.timeline.map((t) => t.id)).toEqual(kept);
  });

  it('a provider does not see them', () => {
    const view = forProvider({ id: 'o1', items: [], timeline }, 'prov1', 0);
    expect(view.timeline.map((t) => t.id)).toEqual(kept);
  });

  it('an order without a timeline key keeps not having one', () => {
    expect('timeline' in forBuyer({ id: 'o1', items: [] })).toBe(false);
    expect('timeline' in forProvider({ id: 'o1', items: [] }, 'p', 0)).toBe(
      false,
    );
  });
});
