import { ConfigService } from '@nestjs/config';
import { OrderStatus, StoreType, UserRole } from '@prisma/client';
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
import { StoreAppsService } from '../store-apps/store-apps.service';
import type { CreateOrderDto } from './dto/order.dto';
import { InvoiceTriggersService } from '../invoices/invoice-triggers.service';
import type { InvoicesService } from '../invoices/invoices.service';

// Invoices app call sites in OrdersService (M3 §3.4): every lifecycle
// transition hands the trigger the store id it already loaded, and runs it
// before the email of that transition so the document can be attached.
// Without the injected service (existing positional constructors) nothing
// changes; with the app off the trigger costs no Prisma call.

const STORE_ID = 's1';
const CREATOR_ID = 'c1';

function makePrisma() {
  const product = {
    id: 'p1',
    creator_id: CREATOR_ID,
    provider_id: null,
    status: 'PUBLISHED',
    base_price: 299,
    tax_class_id: null,
    tax_exempt: false,
    track_inventory: false,
    stock_quantity: null,
  };
  return {
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: STORE_ID,
          slug: 'namez',
          store_type: StoreType.INDEPENDENT,
          creator_id: CREATOR_ID,
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
    product: { findUnique: jest.fn(() => Promise.resolve(product)) },
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
  };
}

function buildCreate(opts: {
  enabled: boolean;
  settings?: unknown;
  invoices?: InvoiceTriggersService;
}) {
  const prisma = makePrisma();
  const markets = { resolve: jest.fn(() => Promise.resolve(null)) };
  const marketPricing = new MarketPricingService(
    prisma as unknown as PrismaService,
  );
  const shipping = {
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
  };
  const promotions = { validateCoupon: jest.fn() };
  // Fixed engine result: 25 % inclusive on everything.
  const tax = {
    contextFor: jest.fn(() => Promise.resolve({ pricingMode: 'INCLUSIVE' })),
    loadTaxData: jest.fn(() => Promise.resolve({})),
    computeTaxes: jest.fn(
      (input: {
        ctx: { buyerType?: string };
        lines: { amount: number }[];
        shipping_cost: number;
        discount_amount: number;
      }) => {
        const total =
          input.lines.reduce((s, l) => s + l.amount, 0) +
          input.shipping_cost -
          input.discount_amount;
        const taxTotal = Math.round((total - total / 1.25) * 100) / 100;
        return {
          items: input.lines.map(() => ({
            tax_rate_bp: 2500,
            tax_amount: 0,
            tax_class_key: 'standard',
          })),
          headline_rate_bp: 2500,
          tax_total: taxTotal,
          tax_lines: [],
          tax_pricing_mode: 'INCLUSIVE',
          tax_basis_country: 'SE',
          shipping_tax_amount: 9.8,
          shipping_tax_rate_bp: 2500,
          total,
          display_mode: input.ctx.buyerType === 'COMPANY' ? 'excl' : 'incl',
          net_items: Math.round(((total - 49) / 1.25) * 100) / 100,
          net_shipping: 39.2,
          net_total: Math.round((total - taxTotal) * 100) / 100,
        };
      },
    ),
  };
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(opts.enabled)),
    getSettings: jest.fn(() =>
      Promise.resolve(opts.enabled ? (opts.settings ?? {}) : null),
    ),
  };
  const b2b = new B2bService(storeApps as unknown as StoreAppsService);
  const mail = { dispatchOrderEmail: jest.fn(() => Promise.resolve()) };
  const config = { get: () => 'https://stores.platform.test' };
  const service = new OrdersService(
    prisma as unknown as PrismaService,
    promotions as unknown as PromotionsService,
    shipping as unknown as ShippingService,
    mail as unknown as MailService,
    tax as unknown as TaxService,
    markets as unknown as MarketsContextService,
    marketPricing,
    config as unknown as ConfigService,
    b2b,
    ...personalizationCoreArgs(prisma),
    opts.invoices,
  );
  return { service, prisma, tax, storeApps, mail };
}

const lines = [{ product_id: 'p1', variant_id: null, quantity: 2 }];

type Fn = jest.Mock<Promise<unknown>, unknown[]>;

function triggersMock() {
  const ok = (): Fn => jest.fn(() => Promise.resolve(undefined));
  return {
    onOrderPaid: ok(),
    onCodOrderCreated: ok(),
    onStatusChanged: ok(),
    onFullRefund: ok(),
    onPartialRefund: ok(),
    onCancelled: ok(),
    onAuthorizationReleased: ok(),
  };
}

function lifecyclePrisma() {
  return {
    order: {
      findUnique: jest.fn((): Promise<unknown> => Promise.resolve(null)),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    orderTimeline: {
      create: jest.fn(() => Promise.resolve({})),
      findFirst: jest.fn((): Promise<unknown> => Promise.resolve(null)),
    },
    orderCommission: {
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    orderItem: {
      findMany: jest.fn((): Promise<unknown> => Promise.resolve([])),
      findFirst: jest.fn((): Promise<unknown> => Promise.resolve(null)),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
  };
}

function buildLifecycle(invoices?: unknown) {
  const prisma = lifecyclePrisma();
  const mail = { dispatchOrderEmail: jest.fn(() => Promise.resolve()) };
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
    invoices as InvoiceTriggersService | undefined,
  );
  const internals = service as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  jest.spyOn(internals, 'restoreOrderItemsStock').mockResolvedValue(undefined);
  jest.spyOn(internals, 'runShippedHooks').mockResolvedValue(undefined);
  jest.spyOn(service, 'findById').mockResolvedValue({} as never);
  return { service, prisma, mail };
}

/** Total number of Prisma calls made through a hand-rolled mock. */
function prismaCalls(prisma: Record<string, Record<string, jest.Mock>>) {
  return Object.values(prisma)
    .flatMap((model) => Object.values(model))
    .reduce((n, fn) => n + fn.mock.calls.length, 0);
}

const firstCall = (fn: jest.Mock) => fn.mock.invocationCallOrder[0];

const paidOrder = {
  id: 'o1',
  store_id: 's1',
  order_number: 'MS-1',
  status: OrderStatus.DELIVERED,
  payment_status: 'paid',
  payment_method: 'STRIPE',
  total: 100,
  currency: 'SEK',
  customer: { user_id: 'u1' },
};

describe('OrdersService invoices call sites', () => {
  it('COD create: onCodOrderCreated with the store id, before the confirmation email', async () => {
    const invoices = triggersMock();
    const { service, mail } = buildCreate({
      enabled: false,
      invoices: invoices as unknown as InvoiceTriggersService,
    });
    await service.create(
      'u1',
      {
        address_id: 'a1',
        store_id: STORE_ID,
        payment_method: 'COD',
      } as CreateOrderDto,
      { lines },
    );
    expect(invoices.onCodOrderCreated).toHaveBeenCalledTimes(1);
    expect(invoices.onCodOrderCreated).toHaveBeenCalledWith({
      id: 'o1',
      store_id: STORE_ID,
      payment_method: 'COD',
    });
    const confirmation =
      mail.dispatchOrderEmail.mock.invocationCallOrder[
        mail.dispatchOrderEmail.mock.calls.findIndex(
          (c) => (c as unknown[])[1] === 'order_confirmation',
        )
      ];
    expect(firstCall(invoices.onCodOrderCreated)).toBeLessThan(confirmation);
  });

  it('markOrderRefunded: onFullRefund before the refund email', async () => {
    const invoices = triggersMock();
    const { service, prisma, mail } = buildLifecycle(invoices);
    prisma.order.findUnique.mockResolvedValue(paidOrder);
    await service.markOrderRefunded('o1');
    expect(invoices.onFullRefund).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'o1', store_id: 's1' }),
    );
    expect(firstCall(invoices.onFullRefund)).toBeLessThan(
      firstCall(mail.dispatchOrderEmail),
    );
  });

  it('markOrderRefunded replay: no trigger', async () => {
    const invoices = triggersMock();
    const { service, prisma } = buildLifecycle(invoices);
    prisma.order.findUnique.mockResolvedValue({
      ...paidOrder,
      payment_status: 'refunded',
    });
    await service.markOrderRefunded('o1');
    expect(invoices.onFullRefund).not.toHaveBeenCalled();
  });

  it('recordPartialRefund: cumulative amount and the caller store id, no extra query', async () => {
    const invoices = triggersMock();
    const { service, prisma } = buildLifecycle(invoices);
    await service.recordPartialRefund('o1', 50, 'sek', 'Stripe', {
      cumulativeRefunded: 50,
      storeId: 's1',
    });
    expect(invoices.onPartialRefund).toHaveBeenCalledWith(
      { id: 'o1', store_id: 's1', currency: 'sek' },
      50,
    );
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('recordPartialRefund: a deduplicated timeline row still calls the (idempotent) trigger', async () => {
    const invoices = triggersMock();
    const { service, prisma } = buildLifecycle(invoices);
    prisma.orderTimeline.findFirst.mockResolvedValue({ id: 't1' });
    const res = await service.recordPartialRefund('o1', 50, 'SEK', 'Kustom', {
      cumulativeRefunded: 50,
      storeId: 's1',
    });
    expect(res.changed).toBe(false);
    expect(invoices.onPartialRefund).toHaveBeenCalledTimes(1);
  });

  it('recordPartialRefund without opts: unchanged behaviour, no trigger', async () => {
    const invoices = triggersMock();
    const { service, prisma } = buildLifecycle(invoices);
    const res = await service.recordPartialRefund('o1', 50, 'SEK');
    expect(res.changed).toBe(true);
    expect(invoices.onPartialRefund).not.toHaveBeenCalled();
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('recordPartialRefund with a cumulative amount but no store id reads it once', async () => {
    const invoices = triggersMock();
    const { service, prisma } = buildLifecycle(invoices);
    prisma.order.findUnique.mockResolvedValue({ store_id: 's9' });
    await service.recordPartialRefund('o1', 20, 'SEK', 'Stripe', {
      cumulativeRefunded: 20,
    });
    expect(prisma.order.findUnique).toHaveBeenCalledWith({
      where: { id: 'o1' },
      select: { store_id: true },
    });
    expect(invoices.onPartialRefund).toHaveBeenCalledWith(
      { id: 'o1', store_id: 's9', currency: 'SEK' },
      20,
    );
  });

  it('markAuthorizationReleased: store_id selected, onAuthorizationReleased after the flip', async () => {
    const invoices = triggersMock();
    const { service, prisma } = buildLifecycle(invoices);
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1',
      status: OrderStatus.CONFIRMED,
      payment_status: 'paid',
      store_id: 's1',
    });
    await service.markAuthorizationReleased('o1', 'expired');
    expect(prisma.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ store_id: true }) as object,
      }),
    );
    expect(invoices.onAuthorizationReleased).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'o1', store_id: 's1' }),
    );
    expect(invoices.onCancelled).not.toHaveBeenCalled();
    expect(firstCall(invoices.onAuthorizationReleased)).toBeGreaterThan(
      firstCall(prisma.order.updateMany),
    );
  });

  it('updateStatus (admin): onStatusChanged before the status email', async () => {
    const invoices = triggersMock();
    const { service, prisma, mail } = buildLifecycle(invoices);
    const order = {
      ...paidOrder,
      status: OrderStatus.SHIPPED,
      payment_method: 'COD',
    };
    prisma.order.findUnique.mockResolvedValue(order);
    await service.updateStatus(
      'o1',
      { status: OrderStatus.DELIVERED },
      'admin1',
      UserRole.ADMIN,
    );
    expect(invoices.onStatusChanged).toHaveBeenCalledWith(
      order,
      OrderStatus.SHIPPED,
      OrderStatus.DELIVERED,
    );
    expect(mail.dispatchOrderEmail).toHaveBeenCalledWith(
      'o1',
      'order_delivered',
    );
    expect(firstCall(invoices.onStatusChanged)).toBeLessThan(
      firstCall(mail.dispatchOrderEmail),
    );
  });

  it('recompute from items (COD delivered): onStatusChanged with store_id + payment_method before the email', async () => {
    const invoices = triggersMock();
    const { service, prisma, mail } = buildLifecycle(invoices);
    prisma.orderItem.findFirst.mockResolvedValue({
      id: 'i1',
      fulfiller_id: 'c1',
      fulfiller_type: 'CREATOR',
    });
    prisma.order.findUnique.mockResolvedValue({
      status: OrderStatus.SHIPPED,
      store_id: 's1',
      payment_method: 'COD',
    });
    prisma.orderItem.findMany.mockResolvedValue([
      { fulfillment_status: 'DELIVERED' },
    ]);
    await service.updateFulfillment(
      'o1',
      'i1',
      { fulfillment_status: 'DELIVERED' } as never,
      'admin1',
      UserRole.ADMIN,
    );
    expect(prisma.order.findUnique).toHaveBeenCalledWith({
      where: { id: 'o1' },
      select: { status: true, store_id: true, payment_method: true },
    });
    expect(invoices.onStatusChanged).toHaveBeenCalledWith(
      { id: 'o1', store_id: 's1', payment_method: 'COD' },
      OrderStatus.SHIPPED,
      OrderStatus.DELIVERED,
    );
    expect(mail.dispatchOrderEmail).toHaveBeenCalledWith(
      'o1',
      'order_delivered',
    );
    expect(firstCall(invoices.onStatusChanged)).toBeLessThan(
      firstCall(mail.dispatchOrderEmail),
    );
  });

  it('without the injected service every path still works', async () => {
    const { service, prisma } = buildLifecycle(undefined);
    prisma.order.findUnique.mockResolvedValue(paidOrder);
    await expect(service.markOrderRefunded('o1')).resolves.toMatchObject({
      changed: true,
    });
    await expect(
      service.recordPartialRefund('o1', 20, 'SEK', 'Stripe', {
        cumulativeRefunded: 20,
      }),
    ).resolves.toEqual({ changed: true });
    prisma.order.findUnique.mockResolvedValue({
      ...paidOrder,
      status: OrderStatus.CONFIRMED,
    });
    await expect(
      service.markAuthorizationReleased('o1', 'expired'),
    ).resolves.toEqual({ changed: true });
  });

  it('app off: the real trigger adds no Prisma call to any path', async () => {
    const run = async (withTriggers: boolean) => {
      const prisma = lifecyclePrisma();
      const storeApps = {
        isEnabled: jest.fn(() => Promise.resolve(false)),
        getSettings: jest.fn(() => Promise.resolve(null)),
      };
      const triggers = withTriggers
        ? new InvoiceTriggersService(
            storeApps as unknown as StoreAppsService,
            prisma as unknown as PrismaService,
            {} as InvoicesService,
          )
        : undefined;
      const { service } = buildLifecycle(triggers);
      // Swap in this run's Prisma mock (buildLifecycle made its own).
      (service as unknown as { prisma: unknown }).prisma = prisma;
      prisma.order.findUnique.mockResolvedValue({
        ...paidOrder,
        status: OrderStatus.CONFIRMED,
      });
      await service.markOrderRefunded('o1');
      await service.markAuthorizationReleased('o1', 'expired');
      await service.recordPartialRefund('o1', 20, 'SEK', 'Stripe', {
        cumulativeRefunded: 20,
        storeId: 's1',
      });
      return {
        calls: prismaCalls(
          prisma as unknown as Record<string, Record<string, jest.Mock>>,
        ),
        isEnabled: storeApps.isEnabled.mock.calls.length,
      };
    };
    const without = await run(false);
    const off = await run(true);
    expect(off.calls).toBe(without.calls);
    expect(off.isEnabled).toBe(3);
  });
});
