import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus, PricingType, UserRole } from '@prisma/client';
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
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { KustomCheckoutService } from '../payments/kustom/kustom-checkout.service';
import {
  buildOrderCreate,
  type HarnessProduct,
  type HarnessVariant,
} from './__fixtures__/order-create.harness';
import { CUSTOM_LINE_STOCK_ENV } from './custom-line-stock';

// Imported products and provider stock: a creator's CustomProduct sells a
// provider's base product. From the cut-over (CUSTOM_LINE_STOCK_SINCE) on,
// its order line takes the provider's stock at sale exactly like an own
// product, gives it back on failure / release / refund / trash and takes it
// again on a late payment or a reverted refund. Orders placed before the
// cut-over took nothing, so they never give anything back (the old code
// inflated provider stock that way).

const PAST = '2026-01-01T00:00:00Z';
const FUTURE = '2999-01-01T00:00:00Z';
const PROVIDER_ID = 'prov1';
const BASE = { id: 'base', creator_id: null, provider_id: PROVIDER_ID };

/** The background refresh is not awaited by the flow: let it finish. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const revalidationMock = () => ({
  revalidateStoresOfProduct: jest.fn<Promise<void>, [unknown]>(() =>
    Promise.resolve(),
  ),
});

const baseProduct = (
  stock: number | null,
  track_inventory = true,
): HarnessProduct => ({
  creator_id: null,
  provider_id: PROVIDER_ID,
  base_price: 45,
  track_inventory,
  stock_quantity: stock,
});
const ownProduct = (stock: number | null): HarnessProduct => ({
  creator_id: 'c1',
  provider_id: null,
  base_price: 49,
  track_inventory: stock !== null,
  stock_quantity: stock,
});
const baseVariant = (stock: number | null): HarnessVariant => ({
  product_id: 'base',
  stock_quantity: stock,
});

const customLine = (quantity: number, variant_id: string | null = null) => ({
  product_id: null,
  variant_id,
  custom_product_id: 'cp1',
  quantity,
});
const ownLine = (quantity: number) => ({
  product_id: 'own1',
  variant_id: null,
  quantity,
});

function createWith(
  since: string | undefined,
  rows: {
    products?: Record<string, HarnessProduct>;
    variants?: Record<string, HarnessVariant>;
  },
  revalidation?: ReturnType<typeof revalidationMock> | RevalidationService,
) {
  return buildOrderCreate({
    products: rows.products,
    variants: rows.variants,
    customProducts: {
      cp1: {
        product_id: 'base',
        pricing_type: PricingType.SINGLE,
        final_price: 150,
      },
    },
    config: { [CUSTOM_LINE_STOCK_ENV]: since },
    revalidation,
  });
}

// ── Order creation ─────────────────────────────────────────────────────────

describe('order creation: an imported line takes the provider stock', () => {
  it('variantless line on a tracked base (5, qty 2): the conditional decrement of own products', async () => {
    const h = createWith(PAST, { products: { base: baseProduct(5) } });
    await expect(h.place([customLine(2)])).resolves.toMatchObject({
      id: 'o1',
    });
    expect(h.prisma.product.updateMany).toHaveBeenCalledWith({
      where: { id: 'base', track_inventory: true, stock_quantity: { gte: 2 } },
      data: { stock_quantity: { decrement: 2 } },
    });
    expect(h.products.get('base')?.stock_quantity).toBe(3);
  });

  it('a line with a base variant decrements that variant only', async () => {
    const h = createWith(PAST, {
      products: { base: baseProduct(null, false) },
      variants: { vb: baseVariant(4) },
    });
    await h.place([customLine(2, 'vb')]);
    expect(h.prisma.productVariant.updateMany).toHaveBeenCalledWith({
      where: { id: 'vb', stock_quantity: { gte: 2 } },
      data: { stock_quantity: { decrement: 2 } },
    });
    expect(h.prisma.product.updateMany).not.toHaveBeenCalled();
    expect(h.variants.get('vb')?.stock_quantity).toBe(2);
  });

  it('a product_id sent with the line is never stored', async () => {
    const h = createWith(PAST, { products: { base: baseProduct(5) } });
    await h.place([{ ...customLine(1), product_id: 'victim' }]);
    const data = h.prisma.order.create.mock.calls[0][0].data;
    expect(data.items.create[0]).toMatchObject({
      product_id: null,
      custom_product_id: 'cp1',
    });
    // The stock came from the base product, never from the sent id.
    expect(h.prisma.product.updateMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.product.updateMany.mock.calls[0][0].where.id).toBe('base');
  });

  describe('the decision and created_at share one clock', () => {
    const NOW = new Date('2026-11-20T03:10:00.000Z');
    beforeEach(() => {
      jest.useFakeTimers({
        now: NOW.getTime(),
        doNotFake: [
          'nextTick',
          'setImmediate',
          'clearImmediate',
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'queueMicrotask',
        ],
      });
    });
    afterEach(() => jest.useRealTimers());

    it('placed exactly at the cut-over: takes stock, created_at is that moment', async () => {
      const h = createWith('2026-11-20T03:10:00Z', {
        products: { base: baseProduct(5) },
      });
      await h.place([customLine(1)]);
      expect(h.products.get('base')?.stock_quantity).toBe(4);
      const data = h.prisma.order.create.mock.calls[0][0].data;
      expect(data.created_at).toEqual(NOW);
    });

    it('placed one millisecond before it: takes nothing', async () => {
      const h = createWith('2026-11-20T03:10:00.001Z', {
        products: { base: baseProduct(5) },
      });
      await h.place([customLine(1)]);
      expect(h.prisma.product.updateMany).not.toHaveBeenCalled();
      expect(h.prisma.order.create.mock.calls[0][0].data.created_at).toEqual(
        NOW,
      );
    });
  });

  it('short stock: ORDER_INSUFFICIENT_STOCK; the own line taken first is handed back, no order', async () => {
    const h = createWith(PAST, {
      products: { own1: ownProduct(3), base: baseProduct(1) },
    });
    await expect(h.place([ownLine(1), customLine(2)])).rejects.toMatchObject({
      response: { code: 'ORDER_INSUFFICIENT_STOCK' },
    });
    expect(h.products.get('own1')?.stock_quantity).toBe(3);
    expect(h.products.get('base')?.stock_quantity).toBe(1);
    expect(h.prisma.order.create).not.toHaveBeenCalled();
  });

  it('a failed insert hands the base row back', async () => {
    const h = createWith(PAST, {
      products: { base: baseProduct(null, false) },
      variants: { vb: baseVariant(2) },
    });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    h.prisma.order.create.mockRejectedValueOnce(new Error('insert failed'));
    await expect(h.place([customLine(2, 'vb')])).rejects.toThrow(
      'insert failed',
    );
    log.mockRestore();
    expect(h.variants.get('vb')?.stock_quantity).toBe(2);
    expect(h.prisma.productVariant.update).toHaveBeenCalledWith({
      where: { id: 'vb' },
      data: { stock_quantity: { increment: 2 } },
    });
  });

  it.each([
    ['track_inventory false', baseProduct(5, false)],
    ['stock null', baseProduct(null, true)],
  ])('an untracked base product (%s) is never written', async (_l, base) => {
    const h = createWith(PAST, { products: { base } });
    await h.place([customLine(3)]);
    expect(h.prisma.product.updateMany).not.toHaveBeenCalled();
  });

  it('an untracked base variant (stock null) is never written', async () => {
    const h = createWith(PAST, {
      products: { base: baseProduct(9) },
      variants: { vb: baseVariant(null) },
    });
    await h.place([customLine(3, 'vb')]);
    expect(h.prisma.productVariant.updateMany).not.toHaveBeenCalled();
    // A variant line never falls back to the product's stock.
    expect(h.prisma.product.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['unset', undefined],
    ['in the future', FUTURE],
    ['invalid', 'tomorrow'],
  ])(
    'the cut-over %s: imported lines take nothing, own lines still do',
    async (_l, since) => {
      const h = createWith(since, {
        products: { own1: ownProduct(3), base: baseProduct(5) },
        variants: { vb: baseVariant(5) },
      });
      await h.place([ownLine(1), customLine(1), customLine(1, 'vb')]);
      expect(h.products.get('own1')?.stock_quantity).toBe(2);
      expect(h.products.get('base')?.stock_quantity).toBe(5);
      expect(h.variants.get('vb')?.stock_quantity).toBe(5);
      expect(h.prisma.productVariant.updateMany).not.toHaveBeenCalled();
    },
  );

  it('the cut-over is read once per service', async () => {
    const h = createWith(PAST, { products: { base: baseProduct(9) } });
    await h.place([customLine(1)]);
    await h.place([customLine(1)]);
    const reads = h.config.get.mock.calls.filter(
      (c) => c[0] === CUSTOM_LINE_STOCK_ENV,
    );
    expect(reads).toHaveLength(1);
  });
});

describe('two stores reselling one base product share its stock', () => {
  function twoStores(variantStock: number, revalidation?: unknown) {
    // One shared row object: both doubles read and write the same stock.
    const shared = {
      products: { base: baseProduct(null, false) },
      variants: { vb: baseVariant(variantStock) },
    };
    const make = (store: { id: string; creator_id: string; slug: string }) =>
      buildOrderCreate({
        ...shared,
        customProducts: {
          cp1: { product_id: 'base', final_price: 150 },
        },
        config: { [CUSTOM_LINE_STOCK_ENV]: PAST },
        store,
        revalidation: revalidation as RevalidationService | undefined,
      });
    return {
      a: make({ id: 'sA', creator_id: 'cA', slug: 'shop-a' }),
      b: make({ id: 'sB', creator_id: 'cB', slug: 'shop-b' }),
      shared,
    };
  }

  it('both decrement the same base variant', async () => {
    const { a, b, shared } = twoStores(5);
    await a.place([customLine(2, 'vb')]);
    await b.place([customLine(1, 'vb')]);
    expect(shared.variants.vb.stock_quantity).toBe(2);
    expect(a.prisma.productVariant.updateMany.mock.calls[0][0].where.id).toBe(
      'vb',
    );
    expect(b.prisma.productVariant.updateMany.mock.calls[0][0].where.id).toBe(
      'vb',
    );
  });

  it('the last unit: the second store gets ORDER_INSUFFICIENT_STOCK', async () => {
    const { a, b, shared } = twoStores(1);
    await expect(a.place([customLine(1, 'vb')])).resolves.toMatchObject({
      id: 'o1',
    });
    await expect(b.place([customLine(1, 'vb')])).rejects.toMatchObject({
      response: { code: 'ORDER_INSUFFICIENT_STOCK' },
    });
    expect(shared.variants.vb.stock_quantity).toBe(0);
    expect(b.prisma.order.create).not.toHaveBeenCalled();
  });

  it('the sale of the last unit refreshes the provider base product', async () => {
    const revalidation = revalidationMock();
    const { a } = twoStores(1, revalidation);
    await a.place([customLine(1, 'vb')]);
    await settle();
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledTimes(1);
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledWith(BASE);
  });

  it('the real RevalidationService reaches BOTH reselling stores', async () => {
    const lookups = {
      customProduct: {
        findMany: jest.fn(() =>
          Promise.resolve([{ creator_id: 'cA' }, { creator_id: 'cB' }]),
        ),
      },
      store: {
        findMany: jest.fn(() =>
          Promise.resolve([{ slug: 'shop-a' }, { slug: 'shop-b' }]),
        ),
        findUnique: jest.fn(() => Promise.resolve(null)),
      },
    };
    const revalidation = new RevalidationService(
      lookups as unknown as PrismaService,
    );
    const bySlug = jest
      .spyOn(revalidation, 'revalidateStoreBySlug')
      .mockImplementation(() => Promise.resolve());
    const { a } = twoStores(1, revalidation);
    await a.place([customLine(1, 'vb')]);
    await settle();
    await settle();
    expect(lookups.customProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { product_id: 'base' } }),
    );
    expect(bySlug.mock.calls.map((c) => c[0]).sort()).toEqual([
      'shop-a',
      'shop-b',
    ]);
    expect(lookups.store.findUnique).not.toHaveBeenCalled();
  });

  it('500 -> 499 does not refresh', async () => {
    const revalidation = revalidationMock();
    const { a } = twoStores(500, revalidation);
    await a.place([customLine(1, 'vb')]);
    await settle();
    expect(revalidation.revalidateStoresOfProduct).not.toHaveBeenCalled();
  });
});

describe('quote and Kustom', () => {
  it('a quote never takes stock for an imported line', async () => {
    const h = createWith(PAST, {
      products: { base: baseProduct(5) },
      variants: { vb: baseVariant(5) },
    });
    await expect(
      h.quote([customLine(2), customLine(1, 'vb')]),
    ).resolves.toBeDefined();
    expect(h.prisma.product.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.productVariant.updateMany).not.toHaveBeenCalled();
  });

  it('a Kustom validation refused for a short imported line answers out_of_stock', async () => {
    const h = createWith(PAST, { products: { base: baseProduct(0) } });
    const err = await h.place([customLine(1)]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    const kustom = Object.create(KustomCheckoutService.prototype) as {
      reasonFor(e: unknown): string;
    };
    expect(kustom.reasonFor(err)).toBe('out_of_stock');
  });
});

// ── Stock returned / taken again by an existing order ─────────────────────

type Rows = Record<string, number | null>;

function buildFlow(
  since: string | undefined,
  rows: { variants?: Rows; products?: Rows } = {},
  revalidation?: ReturnType<typeof revalidationMock>,
) {
  const variants = new Map(Object.entries(rows.variants ?? {}));
  const products = new Map(Object.entries(rows.products ?? {}));
  type StockWrite = {
    where: { id: string; stock_quantity?: { gte?: number } };
    data: { stock_quantity: { decrement?: number; increment?: number } };
  };
  const write = (table: Map<string, number | null>) =>
    jest.fn(({ where, data }: StockWrite) => {
      const have = table.get(where.id);
      if (have == null) return Promise.resolve({ count: 0 });
      const gte = where.stock_quantity?.gte;
      if (gte !== undefined && have < gte) return Promise.resolve({ count: 0 });
      table.set(
        where.id,
        have +
          (data.stock_quantity.increment ?? 0) -
          (data.stock_quantity.decrement ?? 0),
      );
      return Promise.resolve({ count: 1 });
    });
  const ownerOf = (id: string) =>
    id === 'base' || id === 'vb'
      ? BASE
      : { id, creator_id: 'c1', provider_id: null };
  const tables = {
    order: {
      findUnique: jest.fn((): Promise<unknown> => Promise.resolve(null)),
      findMany: jest.fn((): Promise<unknown> => Promise.resolve([])),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    orderTimeline: {
      create: jest.fn((): Promise<unknown> => Promise.resolve({})),
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
      updateMany: write(products),
      findUnique: jest.fn((): Promise<unknown> => Promise.resolve(null)),
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in
            .filter((id) => products.has(id))
            .map((id) => ({
              ...ownerOf(id),
              id,
              track_inventory: products.get(id) != null,
              stock_quantity: products.get(id) ?? null,
            })),
        ),
      ),
    },
    productVariant: {
      updateMany: write(variants),
      findUnique: jest.fn((): Promise<unknown> => Promise.resolve(null)),
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in
            .filter((id) => variants.has(id))
            .map((id) => ({
              id,
              stock_quantity: variants.get(id) ?? null,
              product: ownerOf(id),
            })),
        ),
      ),
    },
    promotionUsage: {
      findMany: jest.fn((): Promise<unknown> => Promise.resolve([])),
    },
    promotion: { update: jest.fn(() => Promise.resolve({})) },
    store: {
      findUnique: jest.fn(
        (): Promise<unknown> =>
          Promise.resolve({ creator: { user_id: 'owner' } }),
      ),
    },
    notification: { create: jest.fn(() => Promise.resolve({})) },
  };
  const tx = { ...tables };
  const prisma = {
    ...tables,
    $transaction: jest.fn(
      (fn: (client: unknown) => Promise<unknown>): Promise<unknown> => fn(tx),
    ),
  };
  const config = {
    get: jest.fn((key: string) =>
      key === CUSTOM_LINE_STOCK_ENV ? since : undefined,
    ),
  };
  const service = new OrdersService(
    prisma as unknown as PrismaService,
    {
      releaseRedemption: jest.fn(() => Promise.resolve()),
    } as unknown as PromotionsService,
    {} as ShippingService,
    {
      dispatchOrderEmail: jest.fn(() => Promise.resolve()),
    } as unknown as MailService,
    {} as TaxService,
    {} as MarketsContextService,
    {} as MarketPricingService,
    config as unknown as ConfigService,
    {} as B2bService,
    ...personalizationCoreArgs(prisma as never),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    revalidation as unknown as RevalidationService | undefined,
  );
  jest
    .spyOn(service, 'findById')
    .mockImplementation((id: string) => Promise.resolve({ id } as never));
  return { service, prisma, variants, products };
}

const unpaid = (over: Record<string, unknown> = {}) => ({
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
  customer: { user_id: 'u1' },
  _count: { payouts: 0, invoices: 0 },
  ...over,
});

const NEW_ORDER = new Date('2026-06-01T10:00:00Z');
const OLD_ORDER = new Date('2025-06-01T10:00:00Z');

/** An imported line as the one order-item query loads it. */
const customVariantItem = (created_at: Date, quantity = 2) => ({
  product_id: null,
  variant_id: 'vb',
  quantity,
  custom_product_id: 'cp1',
  variant_options_snapshot: { size: 'M' },
  order: { created_at },
  custom_product: {
    product_id: 'base',
    product: { stock_quantity: null, track_inventory: false },
  },
  variant: { stock_quantity: 0, product: { creator_id: null } },
  product: null,
});
const customProductItem = (
  created_at: Date,
  quantity = 2,
  crafted: string | null = null,
) => ({
  product_id: crafted,
  variant_id: null,
  quantity,
  custom_product_id: 'cp1',
  variant_options_snapshot: null,
  order: { created_at },
  custom_product: {
    product_id: 'base',
    product: { stock_quantity: 0, track_inventory: true },
  },
  variant: null,
  product: crafted
    ? { stock_quantity: 7, track_inventory: true, creator_id: 'c9', sku: null }
    : null,
});
const ownProductItem = (created_at: Date, quantity = 1) => ({
  product_id: 'own1',
  variant_id: null,
  quantity,
  custom_product_id: null,
  variant_options_snapshot: null,
  order: { created_at },
  custom_product: null,
  variant: null,
  product: {
    stock_quantity: 0,
    track_inventory: true,
    creator_id: 'c1',
    sku: 'OWN',
  },
});

const ADMIN = { id: 'admin-1', email: 'admin@test', role: UserRole.ADMIN };

/** Each return path, on an order that still holds its stock. */
const RETURN_PATHS: [
  string,
  Record<string, unknown>,
  (s: OrdersService) => Promise<unknown>,
][] = [
  ['markOrderFailed', {}, (s) => s.markOrderFailed('o1')],
  [
    'markAuthorizationReleased',
    { status: OrderStatus.CONFIRMED, payment_status: 'paid' },
    (s) => s.markAuthorizationReleased('o1', 'authorization expired'),
  ],
  [
    'markOrderRefunded',
    { status: OrderStatus.CONFIRMED, payment_status: 'paid' },
    (s) => s.markOrderRefunded('o1'),
  ],
  ['trash (deleteOrder)', {}, (s) => s.deleteOrder('o1', ADMIN)],
];

describe('a NEW order (created after the cut-over) gives the provider stock back', () => {
  it.each(RETURN_PATHS)(
    '%s: the base variant and the base product get their units back',
    async (_label, over, run) => {
      const b = buildFlow(PAST, {
        variants: { vb: 0 },
        products: { base: 0, victim: 7 },
      });
      b.prisma.order.findUnique.mockResolvedValue(unpaid(over));
      b.prisma.orderItem.findMany.mockResolvedValue([
        customVariantItem(NEW_ORDER, 2),
        // A legacy line that stored a client-chosen product_id.
        customProductItem(NEW_ORDER, 3, 'victim'),
      ]);
      await run(b.service);
      expect(b.variants.get('vb')).toBe(2);
      expect(b.products.get('base')).toBe(3);
      // Never the product the client named.
      expect(b.products.get('victim')).toBe(7);
    },
  );

  it('the return refreshes every store of the provider base product', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(PAST, { variants: { vb: 0 } }, revalidation);
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.orderItem.findMany.mockResolvedValue([
      customVariantItem(NEW_ORDER, 1),
    ]);
    await b.service.markOrderFailed('o1');
    await settle();
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledWith(BASE);
  });

  it('markOrderPaid after a failure takes it again', async () => {
    const b = buildFlow(PAST, { variants: { vb: 5 }, products: { base: 5 } });
    b.prisma.order.findUnique.mockResolvedValue(
      unpaid({ payment_status: 'failed' }),
    );
    b.prisma.orderItem.findMany.mockResolvedValue([
      customVariantItem(NEW_ORDER, 2),
      customProductItem(NEW_ORDER, 1),
    ]);
    await expect(b.service.markOrderPaid('o1', 'pi_1')).resolves.toMatchObject({
      changed: true,
      stockShortfall: false,
    });
    expect(b.variants.get('vb')).toBe(3);
    expect(b.products.get('base')).toBe(4);
  });

  it('revertRefund takes it again', async () => {
    const b = buildFlow(PAST, { variants: { vb: 5 } });
    b.prisma.order.findUnique.mockResolvedValue(
      unpaid({ status: OrderStatus.REFUNDED, payment_status: 'refunded' }),
    );
    b.prisma.orderItem.findMany.mockResolvedValue([
      customVariantItem(NEW_ORDER, 2),
    ]);
    await expect(
      b.service.revertRefund('o1', 'refund failed'),
    ).resolves.toMatchObject({ changed: true });
    expect(b.variants.get('vb')).toBe(3);
  });

  it('the order lines are loaded in the one query, with what the decision needs', async () => {
    const b = buildFlow(PAST, { variants: { vb: 0 } });
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.orderItem.findMany.mockResolvedValue([
      customVariantItem(NEW_ORDER),
    ]);
    await b.service.markOrderFailed('o1');
    expect(b.prisma.orderItem.findMany).toHaveBeenCalledTimes(1);
    const [args] = b.prisma.orderItem.findMany.mock.calls[0] as unknown as [
      { where: unknown; select: Record<string, unknown> },
    ];
    expect(args.where).toEqual({ order_id: 'o1' });
    expect(args.select).toMatchObject({
      custom_product_id: true,
      variant_options_snapshot: true,
      order: { select: { created_at: true } },
      custom_product: {
        select: {
          product_id: true,
          product: {
            select: { stock_quantity: true, track_inventory: true },
          },
        },
      },
      variant: {
        select: {
          stock_quantity: true,
          product: { select: { creator_id: true } },
        },
      },
    });
  });
});

describe('an OLD order (before the cut-over, or with it unset) gives nothing back', () => {
  it.each([
    ['created before the cut-over', PAST, OLD_ORDER],
    ['the cut-over unset', undefined, NEW_ORDER],
  ])('%s', async (_label, since, createdAt) => {
    for (const [, over, run] of RETURN_PATHS) {
      const b = buildFlow(since, {
        variants: { vb: 0 },
        products: { base: 0, own1: 0, victim: 7 },
      });
      b.prisma.order.findUnique.mockResolvedValue(unpaid(over));
      b.prisma.orderItem.findMany.mockResolvedValue([
        customVariantItem(createdAt, 2),
        customProductItem(createdAt, 3, 'victim'),
        ownProductItem(createdAt, 1),
      ]);
      await run(b.service);
      // The imported lines took nothing, so nothing comes back...
      expect(b.variants.get('vb')).toBe(0);
      expect(b.products.get('base')).toBe(0);
      expect(b.products.get('victim')).toBe(7);
      // ...while the own line of the same order is returned as always.
      expect(b.products.get('own1')).toBe(1);
    }
  });

  it('a late payment or a reverted refund takes nothing again', async () => {
    const paid = buildFlow(PAST, {
      variants: { vb: 5 },
      products: { base: 5 },
    });
    paid.prisma.order.findUnique.mockResolvedValue(
      unpaid({ payment_status: 'failed' }),
    );
    paid.prisma.orderItem.findMany.mockResolvedValue([
      customVariantItem(OLD_ORDER, 2),
      customProductItem(OLD_ORDER, 1),
    ]);
    await paid.service.markOrderPaid('o1', 'pi_1');
    expect(paid.variants.get('vb')).toBe(5);
    expect(paid.products.get('base')).toBe(5);

    const reverted = buildFlow(PAST, { variants: { vb: 5 } });
    reverted.prisma.order.findUnique.mockResolvedValue(
      unpaid({ status: OrderStatus.REFUNDED, payment_status: 'refunded' }),
    );
    reverted.prisma.orderItem.findMany.mockResolvedValue([
      customVariantItem(OLD_ORDER, 2),
    ]);
    await reverted.service.revertRefund('o1', 'refund failed');
    expect(reverted.variants.get('vb')).toBe(5);
  });
});

describe('untracked rows are never written by a return', () => {
  it('an untracked base variant / product stays untouched', async () => {
    const b = buildFlow(PAST, {
      variants: { vb: null },
      products: { base: null },
    });
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.orderItem.findMany.mockResolvedValue([
      customVariantItem(NEW_ORDER, 2),
      customProductItem(NEW_ORDER, 1),
    ]);
    await b.service.markOrderFailed('o1');
    expect(b.variants.get('vb')).toBeNull();
    expect(b.products.get('base')).toBeNull();
  });
});
