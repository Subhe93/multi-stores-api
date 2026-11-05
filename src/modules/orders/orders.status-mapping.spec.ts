import { ConfigService } from '@nestjs/config';
import {
  FulfillerType,
  FulfillmentStatus,
  OrderStatus,
  UserRole,
} from '@prisma/client';
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

// M4.3 WP-A: QUALITY_CHECK is its own fulfillment stage (rank 3, between
// MANUFACTURING and SHIPPED). Creator/provider updates and the admin cascade
// set it on items, and the order header follows the slowest item.

const CREATOR_FULFILLER = 'cr1';
const PROVIDER_FULFILLER = 'pr1';

interface Item {
  id: string;
  fulfiller_id: string;
  fulfiller_type: FulfillerType;
  fulfillment_status: FulfillmentStatus;
}

interface ItemWhere {
  fulfiller_id?: string;
  fulfiller_type?: FulfillerType;
  fulfillment_status?: { notIn: FulfillmentStatus[] };
}

// Honours the filters the service uses, including the `notIn` lock.
function matches(i: Item, where: ItemWhere) {
  return (
    (!where.fulfiller_id || i.fulfiller_id === where.fulfiller_id) &&
    (!where.fulfiller_type || i.fulfiller_type === where.fulfiller_type) &&
    !where.fulfillment_status?.notIn.includes(i.fulfillment_status)
  );
}

function build(status: OrderStatus, items: Item[]) {
  const order = { id: 'o1', status, store_id: 's1', payment_method: 'COD' };
  const timeline: { status: OrderStatus }[] = [];
  const prisma = {
    order: {
      findUnique: jest.fn(() => Promise.resolve({ ...order })),
      update: jest.fn(({ data }: { data: { status: OrderStatus } }) => {
        order.status = data.status;
        return Promise.resolve({ ...order });
      }),
    },
    orderItem: {
      findMany: jest.fn(() => Promise.resolve(items.map((i) => ({ ...i })))),
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(items.find((i) => i.id === where.id) ?? null),
      ),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: { fulfillment_status: FulfillmentStatus };
        }) => {
          const it = items.find((i) => i.id === where.id)!;
          it.fulfillment_status = data.fulfillment_status;
          return Promise.resolve({ ...it });
        },
      ),
      count: jest.fn(({ where }: { where: ItemWhere }) =>
        Promise.resolve(items.filter((i) => matches(i, where)).length),
      ),
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: ItemWhere;
          data: { fulfillment_status: FulfillmentStatus };
        }) => {
          const hit = items.filter((i) => matches(i, where));
          hit.forEach((i) => (i.fulfillment_status = data.fulfillment_status));
          return Promise.resolve({ count: hit.length });
        },
      ),
    },
    orderTimeline: {
      create: jest.fn(({ data }: { data: { status: OrderStatus } }) => {
        timeline.push(data);
        return Promise.resolve(data);
      }),
    },
    orderCommission: { updateMany: jest.fn(() => Promise.resolve({})) },
  };
  const mail = { dispatchOrderEmail: jest.fn(() => Promise.resolve()) };
  const service = new OrdersService(
    prisma as unknown as PrismaService,
    {} as PromotionsService,
    {} as ShippingService,
    mail as unknown as MailService,
    {} as TaxService,
    {} as MarketsContextService,
    {} as MarketPricingService,
    { get: () => undefined } as unknown as ConfigService,
    {} as B2bService,
    ...personalizationCoreArgs(prisma),
  );
  const internals = service as unknown as {
    resolveFulfillerId: (userId: string, role: UserRole) => Promise<string>;
  };
  jest
    .spyOn(internals, 'resolveFulfillerId')
    .mockImplementation((_u: string, role: UserRole) =>
      Promise.resolve(
        role === UserRole.PROVIDER ? PROVIDER_FULFILLER : CREATOR_FULFILLER,
      ),
    );
  jest
    .spyOn(service, 'findById')
    .mockImplementation(() => Promise.resolve({ ...order } as never));
  return { service, order, items, mail, timeline };
}

const creatorItem = (id: string, s: FulfillmentStatus): Item => ({
  id,
  fulfiller_id: CREATOR_FULFILLER,
  fulfiller_type: FulfillerType.CREATOR,
  fulfillment_status: s,
});
const providerItem = (id: string, s: FulfillmentStatus): Item => ({
  id,
  fulfiller_id: PROVIDER_FULFILLER,
  fulfiller_type: FulfillerType.PROVIDER,
  fulfillment_status: s,
});

describe('OrdersService QUALITY_CHECK status mapping (M4.3)', () => {
  it('creator choosing QC sets items and the order to QUALITY_CHECK', async () => {
    const ctx = build(OrderStatus.MANUFACTURING, [
      creatorItem('i1', FulfillmentStatus.MANUFACTURING),
      creatorItem('i2', FulfillmentStatus.MANUFACTURING),
    ]);
    await ctx.service.updateStatus(
      'o1',
      { status: OrderStatus.QUALITY_CHECK },
      'u1',
      UserRole.CREATOR,
    );
    expect(ctx.items.map((i) => i.fulfillment_status)).toEqual([
      FulfillmentStatus.QUALITY_CHECK,
      FulfillmentStatus.QUALITY_CHECK,
    ]);
    expect(ctx.order.status).toBe(OrderStatus.QUALITY_CHECK);
    // QC sends no customer email.
    expect(ctx.mail.dispatchOrderEmail).not.toHaveBeenCalled();
  });

  it('mixed order follows the slowest line: QC + MANUFACTURING stays MANUFACTURING', async () => {
    const ctx = build(OrderStatus.MANUFACTURING, [
      creatorItem('i1', FulfillmentStatus.MANUFACTURING),
      providerItem('i2', FulfillmentStatus.MANUFACTURING),
    ]);
    await ctx.service.updateStatus(
      'o1',
      { status: OrderStatus.QUALITY_CHECK },
      'u1',
      UserRole.CREATOR,
    );
    expect(ctx.items[0].fulfillment_status).toBe(
      FulfillmentStatus.QUALITY_CHECK,
    );
    // Provider line untouched by the creator update.
    expect(ctx.items[1].fulfillment_status).toBe(
      FulfillmentStatus.MANUFACTURING,
    );
    expect(ctx.order.status).toBe(OrderStatus.MANUFACTURING);
  });

  it('recompute of mixed QC/SHIPPED lines gives QUALITY_CHECK, then SHIPPED', async () => {
    const ctx = build(OrderStatus.MANUFACTURING, [
      creatorItem('i1', FulfillmentStatus.QUALITY_CHECK),
      providerItem('i2', FulfillmentStatus.MANUFACTURING),
    ]);
    await ctx.service.updateFulfillment(
      'o1',
      'i2',
      { fulfillment_status: FulfillmentStatus.SHIPPED },
      'u2',
      UserRole.PROVIDER,
    );
    expect(ctx.order.status).toBe(OrderStatus.QUALITY_CHECK);
    expect(ctx.mail.dispatchOrderEmail).not.toHaveBeenCalled();

    await ctx.service.updateFulfillment(
      'o1',
      'i1',
      { fulfillment_status: FulfillmentStatus.SHIPPED },
      'u1',
      UserRole.CREATOR,
    );
    expect(ctx.order.status).toBe(OrderStatus.SHIPPED);
    expect(ctx.mail.dispatchOrderEmail).toHaveBeenCalledWith(
      'o1',
      'order_shipped',
      expect.anything(),
    );
  });

  it('admin cascade to QUALITY_CHECK sets every item to QUALITY_CHECK', async () => {
    const ctx = build(OrderStatus.MANUFACTURING, [
      creatorItem('i1', FulfillmentStatus.MANUFACTURING),
      providerItem('i2', FulfillmentStatus.PROCESSING),
    ]);
    await ctx.service.updateStatus(
      'o1',
      { status: OrderStatus.QUALITY_CHECK },
      'admin',
      UserRole.ADMIN,
    );
    expect(ctx.order.status).toBe(OrderStatus.QUALITY_CHECK);
    expect(ctx.items.map((i) => i.fulfillment_status)).toEqual([
      FulfillmentStatus.QUALITY_CHECK,
      FulfillmentStatus.QUALITY_CHECK,
    ]);
  });

  it('legacy QC order with MANUFACTURING items is never pulled back', async () => {
    const ctx = build(OrderStatus.QUALITY_CHECK, [
      creatorItem('i1', FulfillmentStatus.MANUFACTURING),
      creatorItem('i2', FulfillmentStatus.MANUFACTURING),
    ]);
    await ctx.service.updateFulfillment(
      'o1',
      'i1',
      { fulfillment_status: FulfillmentStatus.MANUFACTURING },
      'u1',
      UserRole.CREATOR,
    );
    expect(ctx.order.status).toBe(OrderStatus.QUALITY_CHECK);
  });

  it('provider MANUFACTURING / SHIPPED / DELIVERED behave as before', async () => {
    const ctx = build(OrderStatus.PROCESSING, [
      providerItem('i1', FulfillmentStatus.PROCESSING),
    ]);
    await ctx.service.updateStatus(
      'o1',
      { status: OrderStatus.MANUFACTURING },
      'u2',
      UserRole.PROVIDER,
    );
    expect(ctx.items[0].fulfillment_status).toBe(
      FulfillmentStatus.MANUFACTURING,
    );
    expect(ctx.order.status).toBe(OrderStatus.MANUFACTURING);

    await ctx.service.updateStatus(
      'o1',
      { status: OrderStatus.SHIPPED },
      'u2',
      UserRole.PROVIDER,
    );
    expect(ctx.order.status).toBe(OrderStatus.SHIPPED);

    await ctx.service.updateStatus(
      'o1',
      { status: OrderStatus.DELIVERED },
      'u2',
      UserRole.PROVIDER,
    );
    expect(ctx.order.status).toBe(OrderStatus.DELIVERED);
  });

  it('admin cascade to MANUFACTURING still sets items to MANUFACTURING', async () => {
    const ctx = build(OrderStatus.PROCESSING, [
      creatorItem('i1', FulfillmentStatus.PROCESSING),
    ]);
    await ctx.service.updateStatus(
      'o1',
      { status: OrderStatus.MANUFACTURING },
      'admin',
      UserRole.ADMIN,
    );
    expect(ctx.items[0].fulfillment_status).toBe(
      FulfillmentStatus.MANUFACTURING,
    );
    expect(ctx.order.status).toBe(OrderStatus.MANUFACTURING);
  });
});

describe('OrdersService per-item fulfillment ownership + tracking', () => {
  it('rejects a provider updating an item fulfilled by another provider', async () => {
    const ctx = build(OrderStatus.MANUFACTURING, [
      providerItem('i1', FulfillmentStatus.MANUFACTURING),
      {
        id: 'i2',
        fulfiller_id: 'other-provider',
        fulfiller_type: FulfillerType.PROVIDER,
        fulfillment_status: FulfillmentStatus.MANUFACTURING,
      },
    ]);
    await expect(
      ctx.service.updateFulfillment(
        'o1',
        'i2',
        { fulfillment_status: FulfillmentStatus.SHIPPED, tracking_number: 'X' },
        'u2',
        UserRole.PROVIDER,
      ),
    ).rejects.toMatchObject({
      response: { code: 'ORDER_FULFILLMENT_NOT_OWNED' },
    });
    expect(ctx.items[1].fulfillment_status).toBe(
      FulfillmentStatus.MANUFACTURING,
    );
  });

  it('rejects a provider updating a creator-fulfilled item', async () => {
    const ctx = build(OrderStatus.MANUFACTURING, [
      creatorItem('i1', FulfillmentStatus.MANUFACTURING),
      providerItem('i2', FulfillmentStatus.MANUFACTURING),
    ]);
    await expect(
      ctx.service.updateFulfillment(
        'o1',
        'i1',
        { fulfillment_status: FulfillmentStatus.SHIPPED },
        'u2',
        UserRole.PROVIDER,
      ),
    ).rejects.toMatchObject({
      response: { code: 'ORDER_FULFILLMENT_NOT_OWNED' },
    });
    expect(ctx.items[0].fulfillment_status).toBe(
      FulfillmentStatus.MANUFACTURING,
    );
  });

  it('stores trimmed tracking on the own item and notes the carrier', async () => {
    const ctx = build(OrderStatus.MANUFACTURING, [
      providerItem('i1', FulfillmentStatus.MANUFACTURING),
      providerItem('i2', FulfillmentStatus.MANUFACTURING),
    ]);
    await ctx.service.updateFulfillment(
      'o1',
      'i2',
      {
        fulfillment_status: FulfillmentStatus.SHIPPED,
        tracking_number: '  TRK1 ',
        tracking_url: ' ',
        carrier: 'DHL',
      },
      'u2',
      UserRole.PROVIDER,
    );
    const prisma = (
      ctx.service as unknown as {
        prisma: { orderItem: { update: jest.Mock } };
      }
    ).prisma;
    expect(prisma.orderItem.update).toHaveBeenCalledWith({
      where: { id: 'i2', order_id: 'o1' },
      data: {
        fulfillment_status: FulfillmentStatus.SHIPPED,
        tracking_number: 'TRK1',
        tracking_url: undefined,
      },
    });
    // The entry keeps the header's current status, not SHIPPED.
    expect(ctx.timeline).toContainEqual(
      expect.objectContaining({
        status: OrderStatus.MANUFACTURING,
        note: 'Item shipped via DHL (TRK1)',
      }),
    );
    // The other own line is still in production, so the header waits.
    expect(ctx.order.status).toBe(OrderStatus.MANUFACTURING);
    expect(ctx.items[0].fulfillment_status).toBe(
      FulfillmentStatus.MANUFACTURING,
    );
  });

  describe('shipped / delivered lines never move backwards', () => {
    it('a provider QC reject moves only the unshipped line', async () => {
      const ctx = build(OrderStatus.QUALITY_CHECK, [
        providerItem('A', FulfillmentStatus.SHIPPED),
        providerItem('B', FulfillmentStatus.QUALITY_CHECK),
      ]);
      await ctx.service.updateStatus(
        'o1',
        { status: OrderStatus.MANUFACTURING },
        'u2',
        UserRole.PROVIDER,
      );
      expect(ctx.items.map((i) => i.fulfillment_status)).toEqual([
        FulfillmentStatus.SHIPPED,
        FulfillmentStatus.MANUFACTURING,
      ]);
    });

    it('owned lines that are all locked are a silent no-op', async () => {
      const ctx = build(OrderStatus.SHIPPED, [
        providerItem('A', FulfillmentStatus.DELIVERED),
      ]);
      await expect(
        ctx.service.updateStatus(
          'o1',
          { status: OrderStatus.SHIPPED },
          'u2',
          UserRole.PROVIDER,
        ),
      ).resolves.toBeDefined();
      expect(ctx.items[0].fulfillment_status).toBe(FulfillmentStatus.DELIVERED);
      expect(ctx.timeline).toHaveLength(0);
    });

    it('owning no lines still raises ORDER_NO_OWNED_ITEMS', async () => {
      const ctx = build(OrderStatus.PROCESSING, [
        creatorItem('A', FulfillmentStatus.PROCESSING),
      ]);
      await expect(
        ctx.service.updateStatus(
          'o1',
          { status: OrderStatus.MANUFACTURING },
          'u2',
          UserRole.PROVIDER,
        ),
      ).rejects.toMatchObject({
        response: { code: 'ORDER_NO_OWNED_ITEMS' },
      });
    });

    it('per-item: a fulfiller cannot move a shipped line back', async () => {
      const ctx = build(OrderStatus.SHIPPED, [
        providerItem('A', FulfillmentStatus.SHIPPED),
      ]);
      await expect(
        ctx.service.updateFulfillment(
          'o1',
          'A',
          { fulfillment_status: FulfillmentStatus.MANUFACTURING },
          'u2',
          UserRole.PROVIDER,
        ),
      ).rejects.toMatchObject({
        response: { code: 'ORDER_FULFILLMENT_BACKWARDS' },
      });
      expect(ctx.items[0].fulfillment_status).toBe(FulfillmentStatus.SHIPPED);
    });

    it('per-item: shipped → delivered is still allowed', async () => {
      const ctx = build(OrderStatus.SHIPPED, [
        providerItem('A', FulfillmentStatus.SHIPPED),
      ]);
      await ctx.service.updateFulfillment(
        'o1',
        'A',
        { fulfillment_status: FulfillmentStatus.DELIVERED },
        'u2',
        UserRole.PROVIDER,
      );
      expect(ctx.items[0].fulfillment_status).toBe(FulfillmentStatus.DELIVERED);
    });

    it('per-item: an admin may still move a delivered line back', async () => {
      const ctx = build(OrderStatus.DELIVERED, [
        providerItem('A', FulfillmentStatus.DELIVERED),
      ]);
      await ctx.service.updateFulfillment(
        'o1',
        'A',
        { fulfillment_status: FulfillmentStatus.SHIPPED },
        'admin',
        UserRole.ADMIN,
      );
      expect(ctx.items[0].fulfillment_status).toBe(FulfillmentStatus.SHIPPED);
    });
  });
});
