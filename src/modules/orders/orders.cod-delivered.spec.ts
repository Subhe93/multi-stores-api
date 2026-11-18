import { ConfigService } from '@nestjs/config';
import {
  FulfillmentStatus,
  OrderStatus,
  StoreType,
  UserRole,
} from '@prisma/client';
import { COD_COLLECTED_NOTE, OrdersService } from './orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { personalizationCoreArgs } from '../personalization/__fixtures__/personalization-service.factory';
import { PromotionsService } from '../promotions/promotions.service';
import { ShippingService } from '../shipping/shipping.service';
import { MailService } from '../mail/mail.service';
import { TaxService } from '../taxes/tax.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { B2bService } from '../b2b/b2b.service';

// A cash-on-delivery order of an INDEPENDENT store is paid when it is
// DELIVERED (the cash was collected at the door): payment_status 'paid',
// paid_at set, one timeline row PAID. Both DELIVERED paths (admin status,
// fulfiller items) do it, once, after the invoice trigger and before the
// status email. Card orders, marketplace stores and orders that are not
// pending are untouched.

type World = {
  storeType: StoreType | null;
  payment_method: string;
  payment_status: string | null;
  status: OrderStatus;
};

function build(world: World) {
  const order: Record<string, unknown> = {
    id: 'o1',
    order_number: 'ORD-1',
    store_id: 's1',
    status: world.status,
    payment_method: world.payment_method,
    payment_status: world.payment_status,
    paid_at: null,
    requires_shipping: true,
    deleted_at: null,
  };
  const calls: string[] = [];
  const timeline: { status: string; note: string | null }[] = [];
  const matches = (where: Record<string, unknown>) => {
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'OR') {
        const any = (cond as Record<string, unknown>[]).some((w) =>
          Object.entries(w).every(([k, v]) => order[k] === v),
        );
        if (!any) return false;
      } else if (order[key] !== cond) return false;
    }
    return true;
  };
  const prisma = {
    order: {
      findUnique: jest.fn(() => Promise.resolve({ ...order })),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        Object.assign(order, data);
        return Promise.resolve({ ...order });
      }),
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if (!matches(where)) return Promise.resolve({ count: 0 });
          Object.assign(order, data);
          return Promise.resolve({ count: 1 });
        },
      ),
    },
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          world.storeType ? { store_type: world.storeType } : null,
        ),
      ),
    },
    orderTimeline: {
      create: jest.fn(
        ({ data }: { data: { status: string; note?: string | null } }) => {
          timeline.push({ status: data.status, note: data.note ?? null });
          if (data.status === 'PAID') calls.push('paid');
          return Promise.resolve({});
        },
      ),
      findFirst: jest.fn((): Promise<unknown> => Promise.resolve(null)),
    },
    orderCommission: {
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    orderItem: {
      findMany: jest.fn(
        (): Promise<unknown> =>
          Promise.resolve([
            { fulfillment_status: FulfillmentStatus.DELIVERED },
          ]),
      ),
      findFirst: jest.fn((): Promise<unknown> => Promise.resolve(null)),
      count: jest.fn(() => Promise.resolve(1)),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
  };
  const mail = {
    dispatchOrderEmail: jest.fn(() => {
      calls.push('email');
      return Promise.resolve();
    }),
  };
  const invoices = {
    onStatusChanged: jest.fn(() => {
      // The invoice is issued while the order still reads as it did.
      calls.push(`invoice:${String(order.payment_status)}`);
      return Promise.resolve();
    }),
  };
  const service = new OrdersService(
    prisma as unknown as PrismaService,
    {} as PromotionsService,
    {} as ShippingService,
    mail as unknown as MailService,
    {} as TaxService,
    {} as MarketsContextService,
    {} as MarketPricingService,
    {} as ConfigService,
    {} as B2bService,
    ...personalizationCoreArgs(prisma),
  );
  // The invoices app trigger (a trailing optional constructor argument).
  (service as unknown as { invoices: unknown }).invoices = invoices;
  const internals = service as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  jest.spyOn(internals, 'resolveFulfillerId').mockResolvedValue('c1');
  jest.spyOn(internals, 'runShippedHooks').mockResolvedValue(undefined);
  jest.spyOn(service, 'findById').mockResolvedValue({} as never);
  const reportToMeta = jest
    .spyOn(internals, 'reportPurchaseToMeta')
    .mockResolvedValue(undefined);
  const admin = (status: OrderStatus) =>
    service.updateStatus('o1', { status }, 'admin1', UserRole.ADMIN);
  const fulfiller = (status: OrderStatus) =>
    service.updateStatus('o1', { status }, 'u-creator', UserRole.CREATOR);
  const paidRows = () => timeline.filter((t) => t.status === 'PAID');
  return { order, prisma, calls, admin, fulfiller, paidRows, reportToMeta };
}

const codIndependent = (over: Partial<World> = {}): World => ({
  storeType: StoreType.INDEPENDENT,
  payment_method: 'COD',
  payment_status: 'pending',
  status: OrderStatus.SHIPPED,
  ...over,
});

describe('COD order of an INDEPENDENT store is paid on delivery', () => {
  it('admin DELIVERED: paid, paid_at set, one PAID row, after the invoice and before the email', async () => {
    const b = build(codIndependent());
    await b.admin(OrderStatus.DELIVERED);
    expect(b.order.status).toBe(OrderStatus.DELIVERED);
    expect(b.order.payment_status).toBe('paid');
    expect(b.order.paid_at).toBeInstanceOf(Date);
    expect(b.paidRows()).toEqual([
      { status: 'PAID', note: COD_COLLECTED_NOTE },
    ]);
    // Invoice issued while still pending, then paid, then the email.
    expect(b.calls).toEqual(['invoice:pending', 'paid', 'email']);
    // Not a second purchase report, and the status is not moved.
    expect(b.reportToMeta).not.toHaveBeenCalled();
  });

  it('fulfiller path (items reach DELIVERED): the same, once', async () => {
    const b = build(codIndependent());
    await b.fulfiller(OrderStatus.DELIVERED);
    expect(b.order.status).toBe(OrderStatus.DELIVERED);
    expect(b.order.payment_status).toBe('paid');
    expect(b.order.paid_at).toBeInstanceOf(Date);
    expect(b.paidRows()).toHaveLength(1);
    expect(b.calls).toEqual(['invoice:pending', 'paid', 'email']);
  });

  it('a legacy COD order without a payment status is paid too', async () => {
    const b = build(codIndependent({ payment_status: null }));
    await b.admin(OrderStatus.DELIVERED);
    expect(b.order.payment_status).toBe('paid');
    expect(b.paidRows()).toHaveLength(1);
  });

  it('DELIVERED set twice: marked once', async () => {
    const b = build(codIndependent());
    await b.admin(OrderStatus.DELIVERED);
    const firstPaidAt = b.order.paid_at;
    await b.admin(OrderStatus.DELIVERED);
    expect(b.paidRows()).toHaveLength(1);
    expect(b.order.paid_at).toBe(firstPaidAt);
  });

  it('any status before DELIVERED leaves the payment pending', async () => {
    const b = build(codIndependent({ status: OrderStatus.PROCESSING }));
    await b.admin(OrderStatus.SHIPPED);
    expect(b.order.payment_status).toBe('pending');
    expect(b.paidRows()).toHaveLength(0);
    expect(b.prisma.store.findUnique).not.toHaveBeenCalled();
  });
});

describe('everything else is untouched', () => {
  it('a COD order of a MARKETPLACE store (historical) keeps its state', async () => {
    const b = build(codIndependent({ storeType: StoreType.MARKETPLACE }));
    await b.admin(OrderStatus.DELIVERED);
    expect(b.order.status).toBe(OrderStatus.DELIVERED);
    expect(b.order.payment_status).toBe('pending');
    expect(b.order.paid_at).toBeNull();
    expect(b.paidRows()).toHaveLength(0);

    const f = build(codIndependent({ storeType: StoreType.MARKETPLACE }));
    await f.fulfiller(OrderStatus.DELIVERED);
    expect(f.order.payment_status).toBe('pending');
  });

  it('a card order is never touched (no store read at all)', async () => {
    const b = build(
      codIndependent({ payment_method: 'STRIPE', payment_status: 'paid' }),
    );
    await b.admin(OrderStatus.DELIVERED);
    expect(b.prisma.store.findUnique).not.toHaveBeenCalled();
    expect(b.paidRows()).toHaveLength(0);
    expect(b.order.paid_at).toBeNull();
  });

  it.each(['failed', 'refunded', 'paid'])(
    'a COD order whose payment is %s is not rewritten',
    async (payment_status) => {
      const b = build(codIndependent({ payment_status }));
      await b.admin(OrderStatus.DELIVERED);
      expect(b.order.payment_status).toBe(payment_status);
      expect(b.order.paid_at).toBeNull();
      expect(b.paidRows()).toHaveLength(0);
    },
  );

  it('an order whose store is gone is left alone', async () => {
    const b = build(codIndependent({ storeType: null }));
    await b.admin(OrderStatus.DELIVERED);
    expect(b.order.payment_status).toBe('pending');
  });
});
