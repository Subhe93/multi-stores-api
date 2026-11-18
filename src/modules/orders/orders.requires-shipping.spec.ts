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

// Products that require no shipping (services / digital products, Shopify
// "Physical product" off). Only the literal `false` on the product switches
// shipping off; a cart of physical products quotes, creates and moves
// through its statuses exactly as before (no new key anywhere).

const STORE_ID = 's1';
const CREATOR_ID = 'c1';

const baseProduct = {
  creator_id: CREATOR_ID,
  provider_id: null,
  status: 'PUBLISHED',
  tax_class_id: null,
  tax_exempt: false,
  track_inventory: false,
  stock_quantity: null,
};

/** p1 = physical (no flag at all, like a mocked / old row), svc = service. */
const PRODUCTS: Record<string, Record<string, unknown>> = {
  p1: { ...baseProduct, id: 'p1', base_price: 300 },
  p2: { ...baseProduct, id: 'p2', base_price: 100, requires_shipping: true },
  svc: { ...baseProduct, id: 'svc', base_price: 500, requires_shipping: false },
};

function makePrisma() {
  return {
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: STORE_ID,
          slug: 'prima',
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
    product: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(PRODUCTS[where.id] ?? null),
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

const STANDARD = {
  id: 'std',
  name: 'Standard',
  type: 'DELIVERY',
  cost: 49,
  estimated_days: { min: 2, max: 5 },
  free_shipping: false,
};

function build() {
  const prisma = makePrisma();
  const markets = { resolve: jest.fn(() => Promise.resolve(null)) };
  const marketPricing = new MarketPricingService(
    prisma as unknown as PrismaService,
  );
  const shipping = {
    quoteForItems: jest.fn((_dto: Record<string, unknown>) =>
      Promise.resolve({ available: true, methods: [{ ...STANDARD }] }),
    ),
  };
  const promotions = { validateCoupon: jest.fn() };
  // Fixed engine result: the total is lines + shipping - discount.
  const tax = {
    contextFor: jest.fn(() => Promise.resolve({ pricingMode: 'INCLUSIVE' })),
    loadTaxData: jest.fn(() => Promise.resolve({})),
    computeTaxes: jest.fn(
      (input: {
        lines: { amount: number }[];
        shipping_cost: number;
        discount_amount: number;
      }) => {
        const total =
          input.lines.reduce((s, l) => s + l.amount, 0) +
          input.shipping_cost -
          input.discount_amount;
        return {
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
          shipping_tax_rate_bp: input.shipping_cost > 0 ? 2500 : 0,
          total,
          display_mode: 'incl',
          net_items: total,
          net_shipping: 0,
          net_total: total,
        };
      },
    ),
  };
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(false)),
    getSettings: jest.fn(() => Promise.resolve(null)),
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
  );
  return { service, prisma, shipping, tax, promotions };
}

const line = (product_id: string, quantity: number) => ({
  product_id,
  variant_id: null,
  quantity,
});

const codOrder = (extra: Partial<CreateOrderDto> = {}) =>
  ({
    address_id: 'a1',
    store_id: STORE_ID,
    payment_method: 'COD',
    ...extra,
  }) as CreateOrderDto;

/** The `data` object create() handed to prisma.order.create. */
function createData(prisma: ReturnType<typeof makePrisma>) {
  const data = prisma.order.create.mock.calls[0][0].data;
  const items = (data.items as { create: Record<string, unknown>[] }).create;
  return { data, items };
}

describe('quote: cart where no line requires shipping', () => {
  it('never asks the shipping service and carries the keys', async () => {
    const { service, shipping } = build();
    const quote = await service.quoteLines(STORE_ID, [line('svc', 2)], {
      countryCode: 'SE',
    });
    expect(shipping.quoteForItems).not.toHaveBeenCalled();
    expect(quote.requires_shipping).toBe(false);
    expect(quote.items[0].requires_shipping).toBe(false);
    expect(quote.shipping).toEqual({
      available: true,
      cost: 0,
      estimated_days: null,
      method: null,
      methods: [],
    });
    expect(quote.shipping_cost).toBe(0);
    expect(quote.shipping_method_id).toBeNull();
    expect(quote.shipping_method_name).toBeNull();
    expect(quote.shipping_method_type).toBeNull();
    expect(quote.subtotal).toBe(1000);
    expect(quote.total).toBe(1000);
  });

  it('ignores a shipping method id sent by the client', async () => {
    const { service, shipping } = build();
    const quote = await service.quoteLines(STORE_ID, [line('svc', 1)], {
      countryCode: 'SE',
      shippingMethodId: 'stale-method',
    });
    expect(shipping.quoteForItems).not.toHaveBeenCalled();
    expect(quote.shipping_method_id).toBeNull();
    expect(quote.shipping_cost).toBe(0);
  });

  it('without a country the shipping block stays null', async () => {
    const { service, shipping } = build();
    const quote = await service.quoteLines(STORE_ID, [line('svc', 1)], {
      countryCode: null,
    });
    expect(shipping.quoteForItems).not.toHaveBeenCalled();
    expect(quote.shipping).toBeNull();
    expect(quote.requires_shipping).toBe(false);
  });

  it('accepts a free-shipping coupon, which has no effect', async () => {
    const { service, promotions } = build();
    promotions.validateCoupon.mockResolvedValue({
      promotion_id: 'promo1',
      type: 'FREE_SHIPPING',
      value: 0,
      discount_amount: 0,
      free_shipping: true,
    });
    const quote = await service.quoteLines(STORE_ID, [line('svc', 1)], {
      countryCode: 'SE',
      couponCode: 'FREESHIP',
    });
    expect(quote.coupon).toEqual(
      expect.objectContaining({ free_shipping: true }),
    );
    expect(quote.shipping_cost).toBe(0);
    expect(quote.total).toBe(500);
  });
});

describe('quote: mixed cart', () => {
  it('quotes shipping for the shippable lines only, with the full subtotal', async () => {
    const { service, shipping, promotions } = build();
    promotions.validateCoupon.mockResolvedValue({
      promotion_id: 'promo1',
      type: 'FIXED',
      value: 0,
      discount_amount: 0,
      free_shipping: false,
    });
    const quote = await service.quoteLines(
      STORE_ID,
      [line('p1', 2), line('svc', 3)],
      { countryCode: 'SE', couponCode: 'ANY' },
    );
    expect(shipping.quoteForItems).toHaveBeenCalledTimes(1);
    expect(shipping.quoteForItems.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        product_ids: ['p1'],
        item_count: 2,
        // 2 x 300 + 3 x 500: the free threshold sees the whole cart.
        subtotal: 2100,
        country_code: 'SE',
        // The ids are the shippable lines: no second filter by product.
        lines_prefiltered: true,
      }),
    );
    // The coupon still validates against every line.
    expect(promotions.validateCoupon).toHaveBeenCalledWith(
      expect.objectContaining({
        item_count: 5,
        product_ids: ['p1', 'svc'],
      }),
    );
    expect('requires_shipping' in quote).toBe(false);
    expect('requires_shipping' in quote.items[0]).toBe(false);
    expect(quote.items[1].requires_shipping).toBe(false);
    expect(quote.shipping_cost).toBe(49);
    expect(quote.shipping_method_id).toBe('std');
    expect(quote.total).toBe(2149);
  });

  it('keeps "unavailable" for a country the shippable lines cannot reach', async () => {
    const { service, shipping } = build();
    shipping.quoteForItems.mockResolvedValue({
      available: false,
      message: 'Shipping not available to this country',
      methods: [],
    } as never);
    const quote = await service.quoteLines(
      STORE_ID,
      [line('p1', 1), line('svc', 1)],
      { countryCode: 'US' },
    );
    expect(quote.shipping).toEqual({
      available: false,
      message: 'Shipping not available to this country',
    });
  });
});

describe('quote and create: cart of physical products (unchanged)', () => {
  it('quote: same shipping inputs and no new key', async () => {
    const { service, shipping } = build();
    const quote = await service.quoteLines(
      STORE_ID,
      [line('p1', 2), line('p2', 1)],
      { countryCode: 'SE' },
    );
    expect(shipping.quoteForItems.mock.calls[0][0]).toEqual({
      product_ids: ['p1', 'p2'],
      country_code: 'SE',
      item_count: 3,
      subtotal: 700,
      locale: 'sv',
      // Internal marker (not a payload key): the lines are already filtered.
      lines_prefiltered: true,
    });
    expect('requires_shipping' in quote).toBe(false);
    for (const item of quote.items) {
      expect('requires_shipping' in item).toBe(false);
    }
    expect(quote.shipping_cost).toBe(49);
  });

  it('create: no requires_shipping key on the order or its lines', async () => {
    const { service, prisma } = build();
    await service.create('u1', codOrder(), {
      lines: [line('p1', 2), line('p2', 1)],
    });
    const { data, items } = createData(prisma);
    expect('requires_shipping' in data).toBe(false);
    for (const item of items) {
      expect('requires_shipping' in item).toBe(false);
    }
    expect(data.shipping_method_id).toBe('std');
    expect(data.shipping_cost).toBe(49);
  });

  it('create: a stale shipping method id is still rejected', async () => {
    const { service } = build();
    await expect(
      service.create('u1', codOrder({ shipping_method_id: 'stale' }), {
        lines: [line('p1', 1)],
      }),
    ).rejects.toMatchObject({
      response: { code: 'ORDER_SHIPPING_METHOD_INVALID' },
    });
  });
});

describe('create: snapshot on the order and its lines', () => {
  it('no line requires shipping: order and lines store false, no method', async () => {
    const { service, prisma, shipping } = build();
    await service.create('u1', codOrder(), { lines: [line('svc', 2)] });
    const { data, items } = createData(prisma);
    expect(shipping.quoteForItems).not.toHaveBeenCalled();
    expect(data.requires_shipping).toBe(false);
    expect(items).toHaveLength(1);
    expect(items[0].requires_shipping).toBe(false);
    expect(data.shipping_cost).toBe(0);
    expect(data.shipping_method_id).toBeNull();
    expect(data.shipping_method_name).toBeNull();
    expect(data.shipping_method_type).toBeNull();
    // The billing address is still the order's address.
    expect(data.address_id).toBe('a1');
    expect(data.total).toBe(1000);
  });

  it('no line requires shipping: a stale method id is ignored, not rejected', async () => {
    const { service, prisma } = build();
    await service.create('u1', codOrder({ shipping_method_id: 'stale' }), {
      lines: [line('svc', 1)],
    });
    const { data } = createData(prisma);
    expect(data.shipping_method_id).toBeNull();
    expect(data.requires_shipping).toBe(false);
  });

  it('mixed cart: the order requires shipping, each line keeps its own value', async () => {
    const { service, prisma } = build();
    await service.create('u1', codOrder(), {
      lines: [line('p1', 1), line('svc', 1)],
    });
    const { data, items } = createData(prisma);
    expect('requires_shipping' in data).toBe(false);
    expect('requires_shipping' in items[0]).toBe(false);
    expect(items[1].requires_shipping).toBe(false);
    expect(data.shipping_method_id).toBe('std');
    expect(data.shipping_cost).toBe(49);
  });
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

function lifecyclePrisma() {
  const prisma = {
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
      count: jest.fn(() => Promise.resolve(1)),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
  };
  // The admin cancel claims the order and returns its stock in a transaction.
  return Object.assign(prisma, {
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
  });
}

function buildLifecycle() {
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
  );
  const internals = service as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  // The real runShippedHooks runs the registered hooks: count them.
  const shippedHook = jest.fn(() => Promise.resolve());
  service.registerShippedHook(shippedHook);
  jest.spyOn(internals, 'resolveFulfillerId').mockResolvedValue('c1');
  jest.spyOn(service, 'findById').mockResolvedValue({} as never);
  return { service, prisma, mail, shippedHook };
}

const orderRow = (status: OrderStatus, requiresShipping?: boolean) => ({
  id: 'o1',
  store_id: 's1',
  status,
  payment_method: 'COD',
  deleted_at: null,
  ...(requiresShipping === undefined
    ? {}
    : { requires_shipping: requiresShipping }),
});

describe('lifecycle: order that requires no shipping (admin path)', () => {
  it('DELIVERED from PROCESSING: order_fulfilled email, shipped hooks once, commission as today', async () => {
    const { service, prisma, mail, shippedHook } = buildLifecycle();
    prisma.order.findUnique.mockResolvedValue(
      orderRow(OrderStatus.PROCESSING, false),
    );
    await service.updateStatus(
      'o1',
      { status: OrderStatus.DELIVERED },
      'admin1',
      UserRole.ADMIN,
    );
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { status: OrderStatus.DELIVERED },
    });
    expect(prisma.orderCommission.updateMany).toHaveBeenCalledWith({
      where: { order_id: 'o1' },
      data: { status: 'COMPLETED' },
    });
    expect(shippedHook).toHaveBeenCalledTimes(1);
    expect(shippedHook).toHaveBeenCalledWith('o1');
    expect(mail.dispatchOrderEmail).toHaveBeenCalledTimes(1);
    expect(mail.dispatchOrderEmail).toHaveBeenCalledWith(
      'o1',
      'order_fulfilled',
    );
  });

  it('DELIVERED from SHIPPED: the shipped hooks already ran, not again', async () => {
    const { service, prisma, mail, shippedHook } = buildLifecycle();
    prisma.order.findUnique.mockResolvedValue(
      orderRow(OrderStatus.SHIPPED, false),
    );
    await service.updateStatus(
      'o1',
      { status: OrderStatus.DELIVERED },
      'admin1',
      UserRole.ADMIN,
    );
    expect(shippedHook).not.toHaveBeenCalled();
    expect(mail.dispatchOrderEmail).toHaveBeenCalledWith(
      'o1',
      'order_fulfilled',
    );
  });

  it('SHIPPED (bulk action / API client): stored, hooks run, no email', async () => {
    const { service, prisma, mail, shippedHook } = buildLifecycle();
    prisma.order.findUnique.mockResolvedValue(
      orderRow(OrderStatus.PROCESSING, false),
    );
    await service.updateStatus(
      'o1',
      { status: OrderStatus.SHIPPED },
      'admin1',
      UserRole.ADMIN,
    );
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { status: OrderStatus.SHIPPED },
    });
    expect(shippedHook).toHaveBeenCalledTimes(1);
    expect(mail.dispatchOrderEmail).not.toHaveBeenCalled();
  });

  it('notify_customer false: fulfilled without an email', async () => {
    const { service, prisma, mail, shippedHook } = buildLifecycle();
    prisma.order.findUnique.mockResolvedValue(
      orderRow(OrderStatus.CONFIRMED, false),
    );
    await service.updateStatus(
      'o1',
      { status: OrderStatus.DELIVERED, notify_customer: false },
      'admin1',
      UserRole.ADMIN,
    );
    expect(shippedHook).toHaveBeenCalledTimes(1);
    expect(mail.dispatchOrderEmail).not.toHaveBeenCalled();
  });

  it('DELIVERED on a cancelled order runs no shipped hook', async () => {
    const { service, prisma, shippedHook } = buildLifecycle();
    prisma.order.findUnique.mockResolvedValue(
      orderRow(OrderStatus.CANCELLED, false),
    );
    await service.updateStatus(
      'o1',
      { status: OrderStatus.DELIVERED },
      'admin1',
      UserRole.ADMIN,
    );
    expect(shippedHook).not.toHaveBeenCalled();
  });

  it('notify_customer false does not silence a cancellation email', async () => {
    const { service, prisma, mail } = buildLifecycle();
    prisma.order.findUnique.mockResolvedValue(
      orderRow(OrderStatus.CONFIRMED, false),
    );
    await service.updateStatus(
      'o1',
      { status: OrderStatus.CANCELLED, notify_customer: false },
      'admin1',
      UserRole.ADMIN,
    );
    expect(mail.dispatchOrderEmail).toHaveBeenCalledWith(
      'o1',
      'order_cancelled',
      { reason: undefined },
    );
  });
});

describe('lifecycle: order that requires no shipping (fulfiller path)', () => {
  function fulfillerSetup(status: OrderStatus, requiresShipping?: boolean) {
    const built = buildLifecycle();
    // updateStatus reads the whole row; the recompute reads its select.
    built.prisma.order.findUnique.mockResolvedValue(
      orderRow(status, requiresShipping),
    );
    built.prisma.orderItem.findMany.mockResolvedValue([
      { fulfillment_status: 'DELIVERED' },
    ]);
    return built;
  }

  it('creator marks as fulfilled: header DELIVERED, hooks once, order_fulfilled', async () => {
    const { service, prisma, mail, shippedHook } = fulfillerSetup(
      OrderStatus.PROCESSING,
      false,
    );
    await service.updateStatus(
      'o1',
      { status: OrderStatus.DELIVERED },
      'creator-user',
      UserRole.CREATOR,
    );
    expect(prisma.order.findUnique).toHaveBeenCalledWith({
      where: { id: 'o1' },
      select: {
        status: true,
        store_id: true,
        payment_method: true,
        requires_shipping: true,
      },
    });
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { status: OrderStatus.DELIVERED },
    });
    expect(shippedHook).toHaveBeenCalledTimes(1);
    expect(mail.dispatchOrderEmail).toHaveBeenCalledTimes(1);
    expect(mail.dispatchOrderEmail).toHaveBeenCalledWith(
      'o1',
      'order_fulfilled',
    );
  });

  it('creator marks as fulfilled with notify_customer false: no email', async () => {
    const { service, mail, shippedHook } = fulfillerSetup(
      OrderStatus.PROCESSING,
      false,
    );
    await service.updateStatus(
      'o1',
      { status: OrderStatus.DELIVERED, notify_customer: false },
      'creator-user',
      UserRole.CREATOR,
    );
    expect(shippedHook).toHaveBeenCalledTimes(1);
    expect(mail.dispatchOrderEmail).not.toHaveBeenCalled();
  });

  it('per-item fulfilment reaching DELIVERED: hooks once, order_fulfilled', async () => {
    const { service, prisma, mail, shippedHook } = fulfillerSetup(
      OrderStatus.CONFIRMED,
      false,
    );
    prisma.orderItem.findFirst.mockResolvedValue({
      id: 'i1',
      fulfiller_id: 'c1',
      fulfiller_type: 'CREATOR',
    });
    await service.updateFulfillment(
      'o1',
      'i1',
      { fulfillment_status: 'DELIVERED' } as never,
      'admin1',
      UserRole.ADMIN,
    );
    expect(shippedHook).toHaveBeenCalledTimes(1);
    expect(mail.dispatchOrderEmail).toHaveBeenCalledWith(
      'o1',
      'order_fulfilled',
    );
  });

  it('per-item fulfilment with notify_customer false: fulfilled without an email', async () => {
    const { service, prisma, mail, shippedHook } = fulfillerSetup(
      OrderStatus.CONFIRMED,
      false,
    );
    prisma.orderItem.findFirst.mockResolvedValue({
      id: 'i1',
      fulfiller_id: 'c1',
      fulfiller_type: 'CREATOR',
    });
    await service.updateFulfillment(
      'o1',
      'i1',
      { fulfillment_status: 'DELIVERED', notify_customer: false } as never,
      'admin1',
      UserRole.ADMIN,
    );
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { status: OrderStatus.DELIVERED },
    });
    // The capture-on-fulfilment hook does not depend on the email.
    expect(shippedHook).toHaveBeenCalledTimes(1);
    expect(mail.dispatchOrderEmail).not.toHaveBeenCalled();
  });
});

describe('lifecycle: order that requires shipping (unchanged)', () => {
  it.each([
    ['column true', true],
    ['column missing (old row / mock)', undefined],
  ])(
    'admin DELIVERED straight from PROCESSING (%s): order_delivered, no shipped hook',
    async (_label, flag) => {
      const { service, prisma, mail, shippedHook } = buildLifecycle();
      prisma.order.findUnique.mockResolvedValue(
        orderRow(OrderStatus.PROCESSING, flag),
      );
      await service.updateStatus(
        'o1',
        { status: OrderStatus.DELIVERED },
        'admin1',
        UserRole.ADMIN,
      );
      expect(shippedHook).not.toHaveBeenCalled();
      expect(mail.dispatchOrderEmail).toHaveBeenCalledTimes(1);
      expect(mail.dispatchOrderEmail).toHaveBeenCalledWith(
        'o1',
        'order_delivered',
      );
    },
  );

  it('admin SHIPPED: hooks once and the shipped email with tracking', async () => {
    const { service, prisma, mail, shippedHook } = buildLifecycle();
    prisma.order.findUnique.mockResolvedValue(
      orderRow(OrderStatus.PROCESSING, true),
    );
    prisma.orderItem.findFirst.mockResolvedValue({
      tracking_number: 'SE1',
      tracking_url: null,
    });
    await service.updateStatus(
      'o1',
      { status: OrderStatus.SHIPPED },
      'admin1',
      UserRole.ADMIN,
    );
    expect(shippedHook).toHaveBeenCalledTimes(1);
    expect(mail.dispatchOrderEmail).toHaveBeenCalledWith(
      'o1',
      'order_shipped',
      {
        trackingNumber: 'SE1',
        trackingUrl: undefined,
      },
    );
  });

  it('notify_customer false also skips the shipped email of a shipping order', async () => {
    const { service, prisma, mail, shippedHook } = buildLifecycle();
    prisma.order.findUnique.mockResolvedValue(
      orderRow(OrderStatus.PROCESSING, true),
    );
    await service.updateStatus(
      'o1',
      { status: OrderStatus.SHIPPED, notify_customer: false },
      'admin1',
      UserRole.ADMIN,
    );
    expect(shippedHook).toHaveBeenCalledTimes(1);
    expect(mail.dispatchOrderEmail).not.toHaveBeenCalled();
  });

  it('fulfiller DELIVERED straight from PROCESSING: order_delivered, no shipped hook', async () => {
    const { service, prisma, mail, shippedHook } = buildLifecycle();
    prisma.order.findUnique.mockResolvedValue(
      orderRow(OrderStatus.PROCESSING, true),
    );
    prisma.orderItem.findMany.mockResolvedValue([
      { fulfillment_status: 'DELIVERED' },
    ]);
    await service.updateStatus(
      'o1',
      { status: OrderStatus.DELIVERED },
      'creator-user',
      UserRole.CREATOR,
    );
    expect(shippedHook).not.toHaveBeenCalled();
    expect(mail.dispatchOrderEmail).toHaveBeenCalledWith(
      'o1',
      'order_delivered',
    );
  });
});
