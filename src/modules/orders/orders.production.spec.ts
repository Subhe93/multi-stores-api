import { ConfigService } from '@nestjs/config';
import {
  FulfillerType,
  FulfillmentStatus,
  OrderStatus,
  StoreType,
  UserRole,
} from '@prisma/client';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PromotionsService } from '../promotions/promotions.service';
import { ShippingService } from '../shipping/shipping.service';
import { MailService } from '../mail/mail.service';
import { TaxService } from '../taxes/tax.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { B2bService } from '../b2b/b2b.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import type { CreateOrderDto } from './dto/order.dto';
import { ProductionTriggersService } from '../production/production-triggers.service';
import type { ProductionChecklistService } from '../production/production-checklist.service';

// M4.3 WP-B, OrdersService slot 2: the post-create checklist hook, the
// `?production=` list filter (both a no-op without the app, costing one
// cached isEnabled at most), and the explicit QC reject that may move a
// QUALITY_CHECK header back to MANUFACTURING.

const STORE_ID = 's1';

function positional(prisma: unknown, storeApps: unknown, mail?: unknown) {
  return [
    prisma as PrismaService,
    { validateCoupon: jest.fn() } as unknown as PromotionsService,
    {
      quoteForItems: jest.fn(() =>
        Promise.resolve({
          available: true,
          methods: [
            {
              id: 'std',
              name: 'Standard',
              type: 'STANDARD',
              cost: 49,
              estimated_days: { min: 2, max: 5 },
              free_shipping: false,
            },
          ],
        }),
      ),
    } as unknown as ShippingService,
    (mail ?? {
      dispatchOrderEmail: jest.fn(() => Promise.resolve()),
    }) as MailService,
    {
      contextFor: jest.fn(() => Promise.resolve({ pricingMode: 'INCLUSIVE' })),
      loadTaxData: jest.fn(() => Promise.resolve({})),
      computeTaxes: jest.fn(
        (input: { lines: { amount: number }[]; shipping_cost: number }) => ({
          items: input.lines.map(() => ({
            tax_rate_bp: 2500,
            tax_amount: 0,
            tax_class_key: 'standard',
          })),
          headline_rate_bp: 2500,
          tax_total: 0,
          tax_lines: [],
          tax_pricing_mode: 'INCLUSIVE',
          tax_basis_country: 'SE',
          shipping_tax_amount: 0,
          shipping_tax_rate_bp: 2500,
          total:
            input.lines.reduce((s, l) => s + l.amount, 0) + input.shipping_cost,
        }),
      ),
    } as unknown as TaxService,
    {
      resolve: jest.fn(() => Promise.resolve(null)),
    } as unknown as MarketsContextService,
    new MarketPricingService(prisma as PrismaService),
    { get: () => undefined } as unknown as ConfigService,
    new B2bService(storeApps as StoreAppsService),
  ] as const;
}

function makeCreatePrisma() {
  // No orderProductionCheck / Summary / Event delegates on purpose: any
  // access from the order flow would throw.
  const prisma = {
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: STORE_ID,
          slug: 'namez',
          store_type: StoreType.INDEPENDENT,
          creator_id: 'c1',
          currency: 'SEK',
          cod_enabled: true,
          is_active: true,
          language_config: { primary_locale: 'sv' },
          creator: {
            kustom_enabled: false,
            kustom_merchant_id: null,
            kustom_shared_secret: null,
          },
        }),
      ),
    },
    product: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'p1',
          creator_id: 'c1',
          provider_id: null,
          status: 'PUBLISHED',
          base_price: 299,
          tax_class_id: null,
          tax_exempt: false,
          track_inventory: false,
          stock_quantity: null,
        }),
      ),
    },
    productVariant: { findUnique: jest.fn(() => Promise.resolve(null)) },
    productMarketPrice: { findMany: jest.fn(() => Promise.resolve([])) },
    platformConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve({ default_currency: 'EUR', commission_value: 15 }),
      ),
    },
    customer: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'cust1', user_id: 'u1' }),
      ),
    },
    cart: { findUnique: jest.fn(() => Promise.resolve(null)) },
    cartItem: { deleteMany: jest.fn(() => Promise.resolve({ count: 1 })) },
    address: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'a1',
          country_code: 'SE',
          state: null,
          postal_code: '11123',
        }),
      ),
    },
    order: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'o1',
          ...data,
          items: [],
          timeline: [],
          address: {},
        }),
      ),
    },
    orderCommission: { create: jest.fn(() => Promise.resolve({})) },
    productCustomField: { findMany: jest.fn(() => Promise.resolve([])) },
    customProduct: { findMany: jest.fn(() => Promise.resolve([])) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  );
  return prisma;
}

function buildCreate(enabled: boolean, inject = true) {
  const prisma = makeCreatePrisma();
  const storeApps = {
    isEnabled: jest.fn((_s: string, key: string) =>
      Promise.resolve(key === 'production' ? enabled : false),
    ),
    getSettings: jest.fn(() => Promise.resolve(null)),
  };
  const checklist = { syncOrder: jest.fn(() => Promise.resolve()) };
  const triggers = new ProductionTriggersService(
    storeApps as unknown as StoreAppsService,
    checklist as unknown as ProductionChecklistService,
  );
  const service = new OrdersService(
    ...positional(prisma, storeApps),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined, // M4.1 personalization (C28: before production)
    inject ? triggers : undefined,
  );
  return { service, prisma, storeApps, checklist };
}

const DTO = {
  address_id: 'a1',
  store_id: STORE_ID,
  payment_method: 'COD',
} as CreateOrderDto;
const LINES = { lines: [{ product_id: 'p1', quantity: 1 }] };

const productionChecks = (calls: unknown[][]) =>
  calls.filter((c) => c[1] === 'production').length;

describe('OrdersService production hooks (M4.3 slot 2)', () => {
  describe('order creation', () => {
    it('app off: no checklist work, one isEnabled, no production table touched', async () => {
      const { service, storeApps, checklist } = buildCreate(false);
      await expect(
        service.create('u1', DTO, LINES as never),
      ).resolves.toMatchObject({ id: 'o1' });
      expect(productionChecks(storeApps.isEnabled.mock.calls)).toBe(1);
      expect(checklist.syncOrder).not.toHaveBeenCalled();
    });

    it('app on: generates the checklist right after the insert', async () => {
      const { service, checklist } = buildCreate(true);
      await service.create('u1', DTO, LINES as never);
      expect(checklist.syncOrder).toHaveBeenCalledWith('o1', STORE_ID);
    });

    it('a failing generation never fails the order', async () => {
      const { service, checklist } = buildCreate(true);
      checklist.syncOrder.mockRejectedValueOnce(new Error('db down'));
      await expect(
        service.create('u1', DTO, LINES as never),
      ).resolves.toMatchObject({ id: 'o1' });
    });

    it('without the optional service injected the flow is unchanged', async () => {
      const { service, storeApps } = buildCreate(true, false);
      await expect(
        service.create('u1', DTO, LINES as never),
      ).resolves.toMatchObject({ id: 'o1' });
      expect(productionChecks(storeApps.isEnabled.mock.calls)).toBe(0);
    });
  });

  describe('?production= list filter (findByCreator)', () => {
    function buildList(enabled: boolean) {
      const prisma = {
        creator: {
          findUnique: jest.fn(() =>
            Promise.resolve({ id: 'c1', store: { id: STORE_ID } }),
          ),
        },
        provider: {
          findUnique: jest.fn(() => Promise.resolve({ id: 'p1' })),
        },
        order: {
          findMany: jest.fn(() => Promise.resolve([])),
          count: jest.fn(() => Promise.resolve(0)),
        },
      };
      const triggers = {
        isEnabled: jest.fn(() => Promise.resolve(enabled)),
      };
      const service = new OrdersService(
        ...positional(prisma, { isEnabled: jest.fn() }),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined, // M4.1 personalization (C28: before production)
        triggers as unknown as ProductionTriggersService,
      );
      const whereOf = () =>
        (
          prisma.order.findMany.mock.calls[0] as unknown as [
            { where: Record<string, unknown> },
          ]
        )[0].where;
      return { service, prisma, triggers, whereOf };
    }

    it('app on + valid value: filters on the summary state of active orders', async () => {
      const { service, whereOf } = buildList(true);
      await service.findByRole(
        'u1',
        UserRole.CREATOR,
        1,
        20,
        undefined,
        undefined,
        undefined,
        'ready',
      );
      expect(whereOf()).toEqual({
        store_id: STORE_ID,
        AND: [
          {
            status: {
              in: ['CONFIRMED', 'PROCESSING', 'MANUFACTURING', 'QUALITY_CHECK'],
            },
            production_summary: { is: { state: { in: ['READY'] } } },
          },
        ],
      });
    });

    it('app off: the parameter is ignored (same where as before)', async () => {
      const { service, whereOf } = buildList(false);
      await service.findByRole(
        'u1',
        UserRole.CREATOR,
        1,
        20,
        undefined,
        undefined,
        undefined,
        'in_production',
      );
      expect(whereOf()).toEqual({ store_id: STORE_ID });
    });

    it('invalid values cost no isEnabled; providers ignore the parameter', async () => {
      const { service, triggers, whereOf } = buildList(true);
      await service.findByRole(
        'u1',
        UserRole.CREATOR,
        1,
        20,
        undefined,
        undefined,
        undefined,
        'bogus',
      );
      expect(triggers.isEnabled).not.toHaveBeenCalled();
      expect(whereOf()).toEqual({ store_id: STORE_ID });

      const p = buildList(true);
      await p.service.findByRole(
        'u1',
        UserRole.PROVIDER,
        1,
        20,
        undefined,
        undefined,
        undefined,
        'ready',
      );
      expect(p.triggers.isEnabled).not.toHaveBeenCalled();
      expect(p.whereOf()).toEqual({ items: { some: { fulfiller_id: 'p1' } } });
    });
  });

  describe('explicit QC reject → back to MANUFACTURING', () => {
    interface Item {
      id: string;
      fulfiller_id: string;
      fulfiller_type: FulfillerType;
      fulfillment_status: FulfillmentStatus;
    }

    function buildStatus(status: OrderStatus, items: Item[]) {
      const order = {
        id: 'o1',
        status,
        store_id: STORE_ID,
        payment_method: 'COD',
      };
      const timeline: { status: string; note?: string }[] = [];
      const prisma = {
        order: {
          findUnique: jest.fn(() => Promise.resolve({ ...order })),
          update: jest.fn(({ data }: { data: { status: OrderStatus } }) => {
            order.status = data.status;
            return Promise.resolve({ ...order });
          }),
        },
        orderItem: {
          findMany: jest.fn(() =>
            Promise.resolve(items.map((i) => ({ ...i }))),
          ),
          updateMany: jest.fn(
            ({
              where,
              data,
            }: {
              where: { fulfiller_id?: string; fulfiller_type?: FulfillerType };
              data: { fulfillment_status: FulfillmentStatus };
            }) => {
              const hit = items.filter(
                (i) =>
                  i.fulfiller_id === where.fulfiller_id &&
                  i.fulfiller_type === where.fulfiller_type,
              );
              hit.forEach(
                (i) => (i.fulfillment_status = data.fulfillment_status),
              );
              return Promise.resolve({ count: hit.length });
            },
          ),
        },
        orderTimeline: {
          create: jest.fn(
            ({ data }: { data: { status: string; note?: string } }) => {
              timeline.push(data);
              return Promise.resolve(data);
            },
          ),
        },
        orderCommission: { updateMany: jest.fn(() => Promise.resolve({})) },
      };
      const mail = { dispatchOrderEmail: jest.fn(() => Promise.resolve()) };
      const service = new OrdersService(...positional(prisma, {}, mail));
      jest
        .spyOn(
          service as unknown as {
            resolveFulfillerId: (u: string, r: UserRole) => Promise<string>;
          },
          'resolveFulfillerId',
        )
        .mockImplementation((_u, role) =>
          Promise.resolve(role === UserRole.PROVIDER ? 'pr1' : 'cr1'),
        );
      jest
        .spyOn(service, 'findById')
        .mockImplementation(() => Promise.resolve({ ...order } as never));
      return { service, order, items, timeline, mail };
    }

    const item = (
      id: string,
      who: 'cr1' | 'pr1',
      s: FulfillmentStatus,
    ): Item => ({
      id,
      fulfiller_id: who,
      fulfiller_type:
        who === 'pr1' ? FulfillerType.PROVIDER : FulfillerType.CREATOR,
      fulfillment_status: s,
    });

    it('provider reject on a QC order moves the items and the header back', async () => {
      const ctx = buildStatus(OrderStatus.QUALITY_CHECK, [
        item('i1', 'pr1', FulfillmentStatus.QUALITY_CHECK),
        item('i2', 'pr1', FulfillmentStatus.QUALITY_CHECK),
      ]);
      await ctx.service.updateStatus(
        'o1',
        { status: OrderStatus.MANUFACTURING, note: 'Rejected at QC' },
        'u2',
        UserRole.PROVIDER,
      );
      expect(
        ctx.items.every((i) => i.fulfillment_status === 'MANUFACTURING'),
      ).toBe(true);
      expect(ctx.order.status).toBe(OrderStatus.MANUFACTURING);
      expect(ctx.timeline.at(-1)).toMatchObject({
        status: OrderStatus.MANUFACTURING,
        note: 'Quality check rejected: back to manufacturing',
      });
      // MANUFACTURING sends no customer email.
      expect(ctx.mail.dispatchOrderEmail).not.toHaveBeenCalled();
    });

    it('the header stays QC while another line is still at QC or later', async () => {
      const ctx = buildStatus(OrderStatus.QUALITY_CHECK, [
        item('i1', 'pr1', FulfillmentStatus.QUALITY_CHECK),
        item('i2', 'cr1', FulfillmentStatus.SHIPPED),
      ]);
      await ctx.service.updateStatus(
        'o1',
        { status: OrderStatus.MANUFACTURING },
        'u2',
        UserRole.PROVIDER,
      );
      expect(ctx.items[0].fulfillment_status).toBe('MANUFACTURING');
      expect(ctx.order.status).toBe(OrderStatus.QUALITY_CHECK);
    });

    it('every other path keeps the never-backwards rule', async () => {
      // Not a QC order: MANUFACTURING on a SHIPPED header is not a reject.
      const shipped = buildStatus(OrderStatus.SHIPPED, [
        item('i1', 'cr1', FulfillmentStatus.SHIPPED),
      ]);
      await shipped.service.updateStatus(
        'o1',
        { status: OrderStatus.MANUFACTURING },
        'u1',
        UserRole.CREATOR,
      );
      expect(shipped.order.status).toBe(OrderStatus.SHIPPED);

      // QC order but a different target (PROCESSING) is not a reject.
      const qc = buildStatus(OrderStatus.QUALITY_CHECK, [
        item('i1', 'cr1', FulfillmentStatus.QUALITY_CHECK),
      ]);
      await qc.service.updateStatus(
        'o1',
        { status: OrderStatus.PROCESSING },
        'u1',
        UserRole.CREATOR,
      );
      expect(qc.order.status).toBe(OrderStatus.QUALITY_CHECK);
    });
  });
});
