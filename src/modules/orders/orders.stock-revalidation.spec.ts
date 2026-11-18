import { ConfigService } from '@nestjs/config';
import {
  OrderStatus,
  PaymentMethod,
  StoreType,
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
import { StoreAppsService } from '../store-apps/store-apps.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import {
  LOW_STOCK_DISPLAY_THRESHOLD,
  isStockChangeVisible,
  isStockMoveVisible,
  loadedStockBefore,
  netStockMoves,
} from './stock-visibility';

// Stock is part of the storefront product payload ("sold out", disabled
// variant values, the "(7)" count, the quantity cap). Every stock write an
// ORDER makes refreshes the stores that show the product, after the write
// committed and only when a buyer can see the change; it is never awaited
// by the order / payment flow and can never fail it.

const STORE_ID = 's1';
const CREATOR_ID = 'c1';

/** The background refresh is not awaited by the flow: let it finish. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function revalidationMock(impl?: () => Promise<void>) {
  return {
    revalidateStoresOfProduct: jest.fn<Promise<void>, [unknown]>(
      impl ?? (() => Promise.resolve()),
    ),
  };
}

type Revalidation = ReturnType<typeof revalidationMock>;

const own = (id: string) => ({
  id,
  creator_id: CREATOR_ID,
  provider_id: null,
});

describe('isStockChangeVisible', () => {
  it('the threshold is the one the storefront prints the count at', () => {
    expect(LOW_STOCK_DISPLAY_THRESHOLD).toBe(10);
  });

  it.each([
    ['reaches 0 (sold out)', 1, 0, true],
    ['reaches 0 from far above', 40, 0, true],
    ['leaves 0 (restocked by a return)', 0, 1, true],
    ['leaves 0 to far above', 0, 40, true],
    ['500 -> 499 (invisible)', 500, 499, false],
    ['12 -> 11 (still no count shown)', 12, 11, false],
    ['11 -> 10 (the count appears)', 11, 10, true],
    ['10 -> 9 (the count changes)', 10, 9, true],
    ['10 -> 11 (the count disappears)', 10, 11, true],
    ['9 -> 10', 9, 10, true],
    ['11 -> 12', 11, 12, false],
    ['a late payment drove it negative', 0, -1, true],
    ['no change', 5, 5, false],
    ['untracked before', null, 5, false],
    ['untracked after', 5, null, false],
    ['untracked', null, null, false],
  ])('%s', (_label, from, to, visible) => {
    expect(isStockChangeVisible(from, to)).toBe(visible);
  });

  it('netStockMoves adds the lines of one row', () => {
    const net = netStockMoves([
      { kind: 'variant', id: 'v1', delta: -1 },
      { kind: 'variant', id: 'v1', delta: -2 },
      { kind: 'product', id: 'p1', delta: 4 },
    ]);
    expect([...net.variant]).toEqual([['v1', -3]]);
    expect([...net.product]).toEqual([['p1', 4]]);
  });

  it.each([
    // now, delta, before, visible
    ['a sale read after the commit: 11 -> 10', 10, -1, undefined, true],
    ['a sale of a well-stocked row', 499, -1, undefined, false],
    ['a return read alone: 10 -> 11', 11, 1, undefined, true],
    // Two returns landed together: both read 12, so each sees 11 -> 12.
    [
      'a return that read the final count, no loaded stock',
      12,
      1,
      undefined,
      false,
    ],
    ['the same return, loaded at 10 before its write', 12, 1, 10, true],
    ['the same return, loaded at 11', 12, 1, 11, false],
    ['sold out when loaded, far above when read', 30, 12, 0, true],
    ['well stocked when loaded and when read', 500, 1, 498, false],
  ])('isStockMoveVisible: %s', (_label, now, delta, before, visible) => {
    expect(isStockMoveVisible(now, delta, before)).toBe(visible);
  });

  it('loadedStockBefore keeps the first loaded value of a row, tracked only', () => {
    const before = loadedStockBefore([
      { kind: 'variant', id: 'v1', delta: 1, before: 10 },
      { kind: 'variant', id: 'v1', delta: 1, before: 10 },
      { kind: 'variant', id: 'v2', delta: 1 },
      { kind: 'product', id: 'p1', delta: 2, before: null },
      { kind: 'product', id: 'p2', delta: 2, before: 0 },
    ]);
    expect([...before.variant]).toEqual([['v1', 10]]);
    expect([...before.product]).toEqual([['p2', 0]]);
  });
});

// ── Order creation ─────────────────────────────────────────────────────────

/**
 * `stock`: per product id, the tracked stock BEFORE the order (absent or
 * null = untracked). The double keeps the count, so the conditional
 * decrement, the restore and the read after the commit see the same rows.
 * `variantStock`: the same per variant id; a variant `v1` belongs to the
 * (untracked) product `p-v1`.
 */
function buildCreate(
  revalidation: Revalidation | undefined,
  stock: Record<string, number | null>,
  variantStock: Record<string, number | null> = {},
) {
  const stockNow = new Map<string, number | null>(Object.entries(stock));
  const variantNow = new Map<string, number | null>(
    Object.entries(variantStock),
  );
  const productRow = (id: string) => ({
    ...own(id),
    status: 'PUBLISHED',
    base_price: 100,
    tax_class_id: null,
    tax_exempt: false,
    track_inventory: stockNow.get(id) != null,
    stock_quantity: stockNow.get(id) ?? null,
  });
  type StockWrite = {
    where: { id: string; stock_quantity?: { gte: number } };
    data: { stock_quantity: { decrement?: number; increment?: number } };
  };
  const prisma = {
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
    product: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(productRow(where.id)),
      ),
      // The conditional decrement of create().
      updateMany: jest.fn(({ where, data }: StockWrite) => {
        const have = stockNow.get(where.id);
        const qty = data.stock_quantity.decrement ?? 0;
        if (have == null || have < qty) return Promise.resolve({ count: 0 });
        stockNow.set(where.id, have - qty);
        return Promise.resolve({ count: 1 });
      }),
      // restoreStock() of a failed insert.
      update: jest.fn(({ where, data }: StockWrite) => {
        const have = stockNow.get(where.id) ?? 0;
        stockNow.set(where.id, have + (data.stock_quantity.increment ?? 0));
        return Promise.resolve({});
      }),
      // The read after the commit.
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.map((id) => {
            const row = productRow(id);
            return {
              id,
              creator_id: row.creator_id,
              provider_id: row.provider_id,
              track_inventory: row.track_inventory,
              stock_quantity: row.stock_quantity,
            };
          }),
        ),
      ),
    },
    productVariant: {
      findUnique: jest.fn(
        ({ where }: { where: { id: string } }): Promise<unknown> =>
          Promise.resolve(
            variantNow.has(where.id)
              ? {
                  id: where.id,
                  product_id: `p-${where.id}`,
                  is_active: true,
                  price_adjustment: 0,
                  options: {},
                  stock_quantity: variantNow.get(where.id) ?? null,
                  product: productRow(`p-${where.id}`),
                }
              : null,
          ),
      ),
      // The conditional decrement of create().
      updateMany: jest.fn(({ where, data }: StockWrite) => {
        const have = variantNow.get(where.id);
        const qty = data.stock_quantity.decrement ?? 0;
        if (have == null || have < qty) return Promise.resolve({ count: 0 });
        variantNow.set(where.id, have - qty);
        return Promise.resolve({ count: 1 });
      }),
      // restoreStock() of a failed insert.
      update: jest.fn(({ where, data }: StockWrite) => {
        const have = variantNow.get(where.id) ?? 0;
        variantNow.set(where.id, have + (data.stock_quantity.increment ?? 0));
        return Promise.resolve({});
      }),
      // The read after the commit.
      findMany: jest.fn(
        ({ where }: { where: { id: { in: string[] } } }): Promise<unknown> =>
          Promise.resolve(
            where.id.in
              .filter((id) => variantNow.has(id))
              .map((id) => ({
                id,
                stock_quantity: variantNow.get(id) ?? null,
                product: own(`p-${id}`),
              })),
          ),
      ),
    },
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
      create: jest.fn(
        ({ data }: { data: Record<string, unknown> }): Promise<unknown> =>
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
          shipping_tax_rate_bp: 2500,
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
  const mail = { dispatchOrderEmail: jest.fn(() => Promise.resolve()) };
  const service = new OrdersService(
    prisma as unknown as PrismaService,
    { validateCoupon: jest.fn() } as unknown as PromotionsService,
    shipping as unknown as ShippingService,
    mail as unknown as MailService,
    tax as unknown as TaxService,
    {
      resolve: jest.fn(() => Promise.resolve(null)),
    } as unknown as MarketsContextService,
    new MarketPricingService(prisma as unknown as PrismaService),
    { get: () => 'https://stores.platform.test' } as unknown as ConfigService,
    new B2bService(storeApps as unknown as StoreAppsService),
    ...personalizationCoreArgs(prisma),
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
  const place = (
    lines: {
      product_id: string;
      variant_id: string | null;
      quantity: number;
    }[],
  ) =>
    service.create(
      'u1',
      { address_id: 'a1', store_id: STORE_ID, payment_method: 'STRIPE' },
      { lines },
    );
  return { service, prisma, place, stockNow, variantNow };
}

const line = (product_id: string, quantity = 1) => ({
  product_id,
  variant_id: null,
  quantity,
});
const variantLine = (variant_id: string, quantity = 1) => ({
  product_id: `p-${variant_id}`,
  variant_id,
  quantity,
});

describe('order creation: storefront refresh after the stock decrement', () => {
  it('the last unit sold (1 -> 0) refreshes the stores of the product', async () => {
    const revalidation = revalidationMock();
    const b = buildCreate(revalidation, { p1: 1 });
    await b.place([line('p1')]);
    await settle();
    expect(b.stockNow.get('p1')).toBe(0);
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledTimes(1);
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledWith(
      own('p1'),
    );
  });

  it('500 -> 499 does not refresh (a busy store keeps its cache)', async () => {
    const revalidation = revalidationMock();
    const b = buildCreate(revalidation, { p1: 500 });
    await b.place([line('p1')]);
    await settle();
    expect(b.stockNow.get('p1')).toBe(499);
    expect(revalidation.revalidateStoresOfProduct).not.toHaveBeenCalled();
  });

  it.each([
    ['11 -> 10', 11, 1],
    ['10 -> 9', 10, 1],
    ['40 -> 3 in one line', 40, 37],
  ])('%s refreshes (the count is shown)', async (_label, before, qty) => {
    const revalidation = revalidationMock();
    const b = buildCreate(revalidation, { p1: before });
    await b.place([line('p1', qty)]);
    await settle();
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledWith(
      own('p1'),
    );
  });

  it('12 -> 11 does not refresh', async () => {
    const revalidation = revalidationMock();
    const b = buildCreate(revalidation, { p1: 12 });
    await b.place([line('p1')]);
    await settle();
    expect(revalidation.revalidateStoresOfProduct).not.toHaveBeenCalled();
  });

  it('an untracked product is never written, read or refreshed', async () => {
    const revalidation = revalidationMock();
    const b = buildCreate(revalidation, { p1: null });
    await b.place([line('p1', 3)]);
    await settle();
    expect(b.prisma.product.updateMany).not.toHaveBeenCalled();
    expect(b.prisma.product.findMany).not.toHaveBeenCalled();
    expect(revalidation.revalidateStoresOfProduct).not.toHaveBeenCalled();
  });

  it('the stock is read once, after the order row was written', async () => {
    const revalidation = revalidationMock();
    const b = buildCreate(revalidation, { p1: 2, p2: 5 });
    await b.place([line('p1'), line('p2')]);
    await settle();
    expect(b.prisma.product.findMany).toHaveBeenCalledTimes(1);
    expect(
      b.prisma.product.findMany.mock.invocationCallOrder[0],
    ).toBeGreaterThan(b.prisma.order.create.mock.invocationCallOrder[0]);
    expect(b.prisma.productVariant.findMany).not.toHaveBeenCalled();
  });

  it('several lines of one store: asked once per product whose change shows, no throw', async () => {
    const revalidation = revalidationMock();
    const b = buildCreate(revalidation, { p1: 2, p2: 5, p3: 900 });
    await expect(
      b.place([line('p1', 2), line('p2'), line('p3')]),
    ).resolves.toMatchObject({ id: 'o1' });
    await settle();
    const asked = revalidation.revalidateStoresOfProduct.mock.calls.map(
      (c) => (c[0] as { id: string }).id,
    );
    expect(asked.sort()).toEqual(['p1', 'p2']);
  });

  it('two lines of the same product count as one move', async () => {
    const revalidation = revalidationMock();
    const b = buildCreate(revalidation, { p1: 12 });
    // 12 -> 11 -> 10: neither line alone reaches the threshold from 12.
    await b.place([line('p1'), line('p1')]);
    await settle();
    expect(b.stockNow.get('p1')).toBe(10);
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledTimes(1);
  });

  it('a rejecting or throwing refresh never fails the order', async () => {
    const rejecting = revalidationMock(() =>
      Promise.reject(new Error('storefront down')),
    );
    const a = buildCreate(rejecting, { p1: 1, p2: 1 });
    await expect(a.place([line('p1'), line('p2')])).resolves.toMatchObject({
      id: 'o1',
    });
    await settle();
    // One failing product does not stop the next one.
    expect(rejecting.revalidateStoresOfProduct).toHaveBeenCalledTimes(2);

    const throwing = revalidationMock(() => {
      throw new Error('sync failure');
    });
    const b = buildCreate(throwing, { p1: 1 });
    await expect(b.place([line('p1')])).resolves.toMatchObject({ id: 'o1' });
    await settle();
    expect(throwing.revalidateStoresOfProduct).toHaveBeenCalledTimes(1);
  });

  it('a failing stock read never fails the order', async () => {
    const revalidation = revalidationMock();
    const b = buildCreate(revalidation, { p1: 1 });
    b.prisma.product.findMany.mockRejectedValueOnce(new Error('db gone'));
    await expect(b.place([line('p1')])).resolves.toMatchObject({ id: 'o1' });
    await settle();
    expect(revalidation.revalidateStoresOfProduct).not.toHaveBeenCalled();
  });

  it('is not awaited: the order answers while the stock read is pending', async () => {
    const revalidation = revalidationMock();
    const b = buildCreate(revalidation, { p1: 1 });
    let release: ((rows: never[]) => void) | undefined;
    b.prisma.product.findMany.mockImplementationOnce(
      () => new Promise<never[]>((resolve) => (release = resolve)),
    );
    await expect(b.place([line('p1')])).resolves.toMatchObject({ id: 'o1' });
    expect(release).toBeDefined();
    expect(revalidation.revalidateStoresOfProduct).not.toHaveBeenCalled();
    release?.([]);
    await settle();
  });

  // The decrement of create() is committed on its own, before the order
  // row. When the order then fails, the units are handed back; a page
  // rendered in between may have cached "sold out", so the hand-back
  // refreshes too (and only when that state could be seen).
  it('the order insert fails: the last unit is handed back and the store refreshed', async () => {
    const revalidation = revalidationMock();
    const b = buildCreate(revalidation, { p1: 1 });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    b.prisma.order.create.mockRejectedValueOnce(new Error('insert failed'));
    await expect(b.place([line('p1')])).rejects.toThrow('insert failed');
    await settle();
    log.mockRestore();
    expect(b.stockNow.get('p1')).toBe(1);
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledTimes(1);
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledWith(
      own('p1'),
    );
    // Read after the hand-back, never before it.
    expect(
      b.prisma.product.findMany.mock.invocationCallOrder[0],
    ).toBeGreaterThan(b.prisma.product.update.mock.invocationCallOrder[0]);
  });

  it('the order insert fails on a well-stocked product: nothing is refreshed', async () => {
    const revalidation = revalidationMock();
    const b = buildCreate(revalidation, { p1: 500 });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    b.prisma.order.create.mockRejectedValueOnce(new Error('insert failed'));
    await expect(b.place([line('p1')])).rejects.toThrow('insert failed');
    await settle();
    log.mockRestore();
    expect(b.stockNow.get('p1')).toBe(500);
    expect(revalidation.revalidateStoresOfProduct).not.toHaveBeenCalled();
  });

  it('the order insert fails and the refresh fails too: the original error is kept', async () => {
    const revalidation = revalidationMock(() => {
      throw new Error('sync failure');
    });
    const b = buildCreate(revalidation, { p1: 1 });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    b.prisma.order.create.mockRejectedValueOnce(new Error('insert failed'));
    await expect(b.place([line('p1')])).rejects.toThrow('insert failed');
    await settle();
    log.mockRestore();
    expect(b.stockNow.get('p1')).toBe(1);
  });

  it('a hand-back that fails itself is not refreshed (the stock did not come back)', async () => {
    const revalidation = revalidationMock();
    const b = buildCreate(revalidation, { p1: 1 });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    b.prisma.order.create.mockRejectedValueOnce(new Error('insert failed'));
    b.prisma.product.update.mockRejectedValueOnce(new Error('db gone'));
    await expect(b.place([line('p1')])).rejects.toThrow('insert failed');
    await settle();
    log.mockRestore();
    expect(b.stockNow.get('p1')).toBe(0);
    expect(b.prisma.product.findMany).not.toHaveBeenCalled();
    expect(revalidation.revalidateStoresOfProduct).not.toHaveBeenCalled();
  });

  it('a later line is sold out: the unit taken for the first line is handed back and refreshed', async () => {
    const revalidation = revalidationMock();
    const b = buildCreate(revalidation, { p1: 1, p2: 0 });
    // p1 is taken (1 -> 0), then p2 turns out to be gone: p1 is handed back.
    await expect(b.place([line('p1'), line('p2')])).rejects.toMatchObject({
      response: { code: 'ORDER_INSUFFICIENT_STOCK' },
    });
    await settle();
    expect(b.stockNow.get('p1')).toBe(1);
    expect(b.prisma.order.create).not.toHaveBeenCalled();
    const asked = revalidation.revalidateStoresOfProduct.mock.calls.map(
      (c) => (c[0] as { id: string }).id,
    );
    // Only the row that really moved; p2 was never written.
    expect(asked).toEqual(['p1']);
  });

  it('sold out for this buyer on the only line: nothing moved, nothing is read or refreshed', async () => {
    const revalidation = revalidationMock();
    const b = buildCreate(revalidation, { p1: 0 });
    await expect(b.place([line('p1')])).rejects.toMatchObject({
      response: { code: 'ORDER_INSUFFICIENT_STOCK' },
    });
    await settle();
    expect(b.stockNow.get('p1')).toBe(0);
    expect(b.prisma.product.update).not.toHaveBeenCalled();
    expect(b.prisma.product.findMany).not.toHaveBeenCalled();
    expect(revalidation.revalidateStoresOfProduct).not.toHaveBeenCalled();
  });

  it('a variant line: the last unit of a variant (1 -> 0) refreshes its product', async () => {
    const revalidation = revalidationMock();
    const b = buildCreate(revalidation, {}, { v1: 1 });
    await expect(b.place([variantLine('v1')])).resolves.toMatchObject({
      id: 'o1',
    });
    await settle();
    expect(b.variantNow.get('v1')).toBe(0);
    // The variant row is written, never its (untracked) product.
    expect(b.prisma.product.updateMany).not.toHaveBeenCalled();
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledTimes(1);
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledWith(
      own('p-v1'),
    );
  });

  it('a variant line: 500 -> 499 and an untracked variant do not refresh', async () => {
    const revalidation = revalidationMock();
    const b = buildCreate(revalidation, {}, { v1: 500, v2: null });
    await b.place([variantLine('v1'), variantLine('v2', 3)]);
    await settle();
    expect(b.variantNow.get('v1')).toBe(499);
    expect(b.prisma.productVariant.updateMany).toHaveBeenCalledTimes(1);
    expect(revalidation.revalidateStoresOfProduct).not.toHaveBeenCalled();
  });

  it('a variant line whose order insert fails: the variant is handed back and refreshed', async () => {
    const revalidation = revalidationMock();
    const b = buildCreate(revalidation, {}, { v1: 1 });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    b.prisma.order.create.mockRejectedValueOnce(new Error('insert failed'));
    await expect(b.place([variantLine('v1')])).rejects.toThrow('insert failed');
    await settle();
    log.mockRestore();
    expect(b.variantNow.get('v1')).toBe(1);
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledWith(
      own('p-v1'),
    );
  });

  it('without the service wired the order works and nothing is read', async () => {
    const b = buildCreate(undefined, { p1: 1 });
    await expect(b.place([line('p1')])).resolves.toMatchObject({ id: 'o1' });
    await settle();
    expect(b.prisma.product.findMany).not.toHaveBeenCalled();
  });
});

// ── Payment / status paths that put stock back or take it again ────────────

/** Tracked rows of the double: id -> stock now (null = untracked). */
type Rows = Record<string, number | null>;

function buildFlow(
  revalidation: Revalidation | RevalidationService | undefined,
  rows: { variants?: Rows; products?: Rows } = {},
  owners: Record<
    string,
    { id: string; creator_id: string | null; provider_id: string | null }
  > = {},
) {
  const variants = new Map(Object.entries(rows.variants ?? {}));
  const products = new Map(Object.entries(rows.products ?? {}));
  // A variant `v1` belongs to product `p-v1` unless `owners` says otherwise.
  const ownerOf = (variantId: string) =>
    owners[variantId] ?? own(`p-${variantId}`);
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
              ...(owners[id] ?? own(id)),
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
  // The transaction client is its own object (as in Prisma), so a refresh
  // issued inside the transaction would be told apart from one after it.
  const tx = { ...tables };
  const prisma = {
    ...tables,
    $transaction: jest.fn(
      (fn: (client: unknown) => Promise<unknown>): Promise<unknown> => fn(tx),
    ),
  };
  const mail = { dispatchOrderEmail: jest.fn(() => Promise.resolve()) };
  const service = new OrdersService(
    prisma as unknown as PrismaService,
    {
      releaseRedemption: jest.fn(() => Promise.resolve()),
    } as unknown as PromotionsService,
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
    undefined,
    undefined,
    revalidation as unknown as RevalidationService | undefined,
  );
  jest
    .spyOn(service, 'findById')
    .mockImplementation((id: string) => Promise.resolve({ id } as never));
  const internals = service as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  return { service, internals, prisma, tx, variants, products };
}

const unpaid = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  order_number: 'MS-1',
  store_id: STORE_ID,
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

const variantItem = (variant_id: string, quantity = 1) => ({
  product_id: null,
  variant_id,
  quantity,
  product: null,
});
const productItem = (product_id: string, quantity = 1) => ({
  product_id,
  variant_id: null,
  quantity,
  product: { sku: null },
});

describe('stock put back by an order: storefront refresh', () => {
  it('markOrderFailed: a sold-out variant is back (0 -> 1), its store is refreshed', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, { variants: { v1: 0 } });
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.orderItem.findMany.mockResolvedValue([variantItem('v1')]);
    await expect(b.service.markOrderFailed('o1')).resolves.toMatchObject({
      changed: true,
    });
    await settle();
    expect(b.variants.get('v1')).toBe(1);
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledTimes(1);
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledWith(
      own('p-v1'),
    );
  });

  it('markOrderFailed: 499 -> 500 does not refresh', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, { products: { p1: 499 } });
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.orderItem.findMany.mockResolvedValue([productItem('p1')]);
    await b.service.markOrderFailed('o1');
    await settle();
    expect(b.products.get('p1')).toBe(500);
    expect(revalidation.revalidateStoresOfProduct).not.toHaveBeenCalled();
  });

  it('markOrderFailed: 10 -> 11 refreshes (the printed count goes away)', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, { products: { p1: 10 } });
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.orderItem.findMany.mockResolvedValue([productItem('p1')]);
    await b.service.markOrderFailed('o1');
    await settle();
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledWith(
      own('p1'),
    );
  });

  it('an untracked variant / product is not written, read or refreshed', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, {
      variants: { v1: null },
      products: { p1: null },
    });
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.orderItem.findMany.mockResolvedValue([
      variantItem('v1', 3),
      productItem('p1', 2),
    ]);
    await b.service.markOrderFailed('o1');
    await settle();
    expect(b.prisma.productVariant.findMany).not.toHaveBeenCalled();
    expect(b.prisma.product.findMany).not.toHaveBeenCalled();
    expect(revalidation.revalidateStoresOfProduct).not.toHaveBeenCalled();
  });

  it('several lines: one variant and one product of the store, each asked once', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, {
      variants: { v1: 0, v2: 300 },
      products: { p1: 4 },
    });
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.orderItem.findMany.mockResolvedValue([
      variantItem('v1'),
      variantItem('v2'),
      productItem('p1'),
    ]);
    await b.service.markOrderFailed('o1');
    await settle();
    const asked = revalidation.revalidateStoresOfProduct.mock.calls.map(
      (c) => (c[0] as { id: string }).id,
    );
    expect(asked.sort()).toEqual(['p-v1', 'p1']);
  });

  it('two variants of ONE product: the product is asked once', async () => {
    const revalidation = revalidationMock();
    const shirt = own('shirt');
    const b = buildFlow(
      revalidation,
      { variants: { red: 0, blue: 0 } },
      { red: shirt, blue: shirt },
    );
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.orderItem.findMany.mockResolvedValue([
      variantItem('red'),
      variantItem('blue'),
    ]);
    await b.service.markOrderFailed('o1');
    await settle();
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledTimes(1);
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledWith(shirt);
  });

  it('markOrderRefunded: the returned unit lifts "sold out"', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, { products: { p1: 0 } });
    b.prisma.order.findUnique.mockResolvedValue(
      unpaid({ status: OrderStatus.CONFIRMED, payment_status: 'paid' }),
    );
    b.prisma.orderItem.findMany.mockResolvedValue([productItem('p1')]);
    await expect(b.service.markOrderRefunded('o1')).resolves.toMatchObject({
      changed: true,
    });
    await settle();
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledWith(
      own('p1'),
    );
  });

  it('markAuthorizationReleased (Kustom): the returned unit lifts "sold out"', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, { variants: { v1: 0 } });
    b.prisma.order.findUnique.mockResolvedValue(
      unpaid({ status: OrderStatus.CONFIRMED, payment_status: 'paid' }),
    );
    b.prisma.orderItem.findMany.mockResolvedValue([variantItem('v1')]);
    await expect(
      b.service.markAuthorizationReleased('o1', 'authorization expired'),
    ).resolves.toEqual({ changed: true });
    await settle();
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledWith(
      own('p-v1'),
    );
  });

  it('a replayed event (the flip misses) writes and refreshes nothing', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, { variants: { v1: 0 } });
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.order.updateMany.mockResolvedValue({ count: 0 });
    b.prisma.orderItem.findMany.mockResolvedValue([variantItem('v1')]);
    await expect(b.service.markOrderFailed('o1')).resolves.toMatchObject({
      changed: false,
    });
    await settle();
    expect(b.variants.get('v1')).toBe(0);
    expect(revalidation.revalidateStoresOfProduct).not.toHaveBeenCalled();
  });

  it('the abandonment sweep releases an expired order: its store is refreshed', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, { variants: { v1: 0 } });
    b.prisma.order.findMany.mockResolvedValueOnce([
      {
        id: 'o1',
        store_id: STORE_ID,
        created_at: new Date(Date.now() - 3 * 60 * 60 * 1000),
        payment_processing_at: null,
        payment_method: PaymentMethod.COD,
        payment_route: null,
        stripe_account_id: null,
        stripe_payment_id: null,
        stripe_key_fingerprint: null,
      },
    ]);
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.orderItem.findMany.mockResolvedValue([variantItem('v1')]);
    await b.internals.releaseExpiredAwaitingPaymentOrders();
    await settle();
    expect(b.variants.get('v1')).toBe(1);
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledWith(
      own('p-v1'),
    );
  });

  // Two orders of one variant are released together (the sweep, a bulk
  // trash): stock 10 -> 11 -> 12. Both reads after the commit may see 12,
  // so each would judge "11 -> 12" (invisible) and "In stock (10)" would
  // stay cached. The stock loaded with the order lines settles it.
  it('returns landing together: the stock loaded before the write decides (10, read as 12)', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, { variants: { v1: 10 } });
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.orderItem.findMany.mockResolvedValue([
      { ...variantItem('v1'), variant: { stock_quantity: 10 } },
    ]);
    // The other order's return landed before this order's read.
    b.prisma.productVariant.findMany.mockResolvedValueOnce([
      { id: 'v1', stock_quantity: 12, product: own('p-v1') },
    ]);
    await b.service.markOrderFailed('o1');
    await settle();
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledTimes(1);
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledWith(
      own('p-v1'),
    );
  });

  it('returns landing together on a product: sold out when loaded, 30 when read', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, { products: { p1: 0 } });
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.orderItem.findMany.mockResolvedValue([
      {
        ...productItem('p1', 12),
        product: { sku: null, stock_quantity: 0, track_inventory: true },
      },
    ]);
    b.prisma.product.findMany.mockResolvedValueOnce([
      { ...own('p1'), track_inventory: true, stock_quantity: 30 },
    ]);
    await b.service.markOrderFailed('o1');
    await settle();
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledWith(
      own('p1'),
    );
  });

  it('a return loaded above the threshold and read above it does not refresh', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, { variants: { v1: 11 } });
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.orderItem.findMany.mockResolvedValue([
      { ...variantItem('v1'), variant: { stock_quantity: 11 } },
    ]);
    b.prisma.productVariant.findMany.mockResolvedValueOnce([
      { id: 'v1', stock_quantity: 13, product: own('p-v1') },
    ]);
    await b.service.markOrderFailed('o1');
    await settle();
    expect(revalidation.revalidateStoresOfProduct).not.toHaveBeenCalled();
  });

  it('the order lines are loaded with their stock in the one query the return already made', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, { variants: { v1: 0 } });
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.orderItem.findMany.mockResolvedValue([variantItem('v1')]);
    await b.service.markOrderFailed('o1');
    await settle();
    expect(b.prisma.orderItem.findMany).toHaveBeenCalledTimes(1);
    expect(b.prisma.orderItem.findMany).toHaveBeenCalledWith({
      where: { order_id: 'o1' },
      select: {
        product_id: true,
        variant_id: true,
        quantity: true,
        variant: { select: { stock_quantity: true } },
        product: { select: { stock_quantity: true, track_inventory: true } },
      },
    });
  });

  it('a failing refresh or stock read never fails the payment flow', async () => {
    const rejecting = revalidationMock(() =>
      Promise.reject(new Error('storefront down')),
    );
    const a = buildFlow(rejecting, { variants: { v1: 0 } });
    a.prisma.order.findUnique.mockResolvedValue(unpaid());
    a.prisma.orderItem.findMany.mockResolvedValue([variantItem('v1')]);
    await expect(a.service.markOrderFailed('o1')).resolves.toMatchObject({
      changed: true,
    });
    await settle();
    expect(rejecting.revalidateStoresOfProduct).toHaveBeenCalledTimes(1);

    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, { variants: { v1: 0 } });
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.orderItem.findMany.mockResolvedValue([variantItem('v1')]);
    b.prisma.productVariant.findMany.mockRejectedValueOnce(new Error('db'));
    await expect(b.service.markOrderFailed('o1')).resolves.toMatchObject({
      changed: true,
    });
    await settle();
    expect(revalidation.revalidateStoresOfProduct).not.toHaveBeenCalled();
  });
});

describe('stock taken again by an order: storefront refresh', () => {
  it('markOrderPaid on a released order re-takes the last unit (1 -> 0)', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, { variants: { v1: 1 } });
    b.prisma.order.findUnique.mockResolvedValue(
      unpaid({ payment_status: 'failed' }),
    );
    b.prisma.orderItem.findMany.mockResolvedValue([variantItem('v1')]);
    await expect(b.service.markOrderPaid('o1', 'pi_1')).resolves.toMatchObject({
      changed: true,
      stockShortfall: false,
    });
    await settle();
    expect(b.variants.get('v1')).toBe(0);
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledTimes(1);
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledWith(
      own('p-v1'),
    );
  });

  it('markOrderPaid on an order that kept its stock moves nothing', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, { variants: { v1: 1 } });
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.orderItem.findMany.mockResolvedValue([variantItem('v1')]);
    await b.service.markOrderPaid('o1', 'pi_1');
    await settle();
    expect(b.variants.get('v1')).toBe(1);
    expect(revalidation.revalidateStoresOfProduct).not.toHaveBeenCalled();
  });

  it('a short line takes nothing and refreshes nothing', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, { products: { p1: 1 } });
    b.prisma.order.findUnique.mockResolvedValue(
      unpaid({ payment_status: 'failed' }),
    );
    b.prisma.orderItem.findMany.mockResolvedValue([productItem('p1', 2)]);
    b.prisma.product.findUnique.mockResolvedValue({
      stock_quantity: 1,
      track_inventory: true,
    });
    await expect(b.service.markOrderPaid('o1', 'pi_1')).resolves.toMatchObject({
      stockShortfall: true,
    });
    await settle();
    expect(b.products.get('p1')).toBe(1);
    expect(revalidation.revalidateStoresOfProduct).not.toHaveBeenCalled();
  });

  it('revertRefund re-takes the stock (5 -> 4)', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, { products: { p1: 5 } });
    b.prisma.order.findUnique.mockResolvedValue(
      unpaid({ status: OrderStatus.REFUNDED, payment_status: 'refunded' }),
    );
    b.prisma.orderItem.findMany.mockResolvedValue([productItem('p1')]);
    await expect(
      b.service.revertRefund('o1', 'refund failed'),
    ).resolves.toMatchObject({ changed: true });
    await settle();
    expect(b.products.get('p1')).toBe(4);
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledWith(
      own('p1'),
    );
  });
});

describe('order trash: the stock return of the delete transaction', () => {
  const ADMIN = { id: 'admin-1', email: 'admin@test', role: UserRole.ADMIN };

  it('refreshes after the transaction committed', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, { variants: { v1: 0 } });
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.orderItem.findMany.mockResolvedValue([variantItem('v1')]);
    let committed = false;
    b.prisma.$transaction.mockImplementationOnce(
      async (fn: (client: unknown) => Promise<unknown>) => {
        const result = await fn(b.tx);
        // Nothing was read or refreshed inside the transaction.
        expect(b.prisma.productVariant.findMany).not.toHaveBeenCalled();
        committed = true;
        return result;
      },
    );
    await b.service.deleteOrder('o1', ADMIN);
    await settle();
    expect(committed).toBe(true);
    expect(b.variants.get('v1')).toBe(1);
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledTimes(1);
    expect(revalidation.revalidateStoresOfProduct).toHaveBeenCalledWith(
      own('p-v1'),
    );
  });

  it('the transaction rolls back: nothing is read or refreshed', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, { variants: { v1: 0 } });
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.orderItem.findMany.mockResolvedValue([variantItem('v1')]);
    // The stock write ran inside the transaction, then the commit failed.
    b.prisma.$transaction.mockImplementationOnce(
      async (fn: (client: unknown) => Promise<unknown>) => {
        await fn(b.tx);
        throw new Error('could not serialize access');
      },
    );
    await expect(b.service.deleteOrder('o1', ADMIN)).rejects.toThrow(
      'could not serialize access',
    );
    await settle();
    expect(b.prisma.productVariant.updateMany).toHaveBeenCalledTimes(1);
    expect(b.prisma.productVariant.findMany).not.toHaveBeenCalled();
    expect(revalidation.revalidateStoresOfProduct).not.toHaveBeenCalled();
  });

  it('a lost claim (paid meanwhile) returns no stock and refreshes nothing', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, { variants: { v1: 0 } });
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.order.updateMany.mockResolvedValue({ count: 0 });
    b.prisma.orderItem.findMany.mockResolvedValue([variantItem('v1')]);
    await expect(b.service.deleteOrder('o1', ADMIN)).rejects.toMatchObject({
      response: { code: 'ORDER_NOT_DELETABLE' },
    });
    await settle();
    expect(b.variants.get('v1')).toBe(0);
    expect(revalidation.revalidateStoresOfProduct).not.toHaveBeenCalled();
  });

  it('an order that no longer holds stock returns none', async () => {
    const revalidation = revalidationMock();
    const b = buildFlow(revalidation, { variants: { v1: 0 } });
    b.prisma.order.findUnique.mockResolvedValue(
      unpaid({ payment_status: 'failed' }),
    );
    b.prisma.orderItem.findMany.mockResolvedValue([variantItem('v1')]);
    await b.service.deleteOrder('o1', ADMIN);
    await settle();
    expect(b.prisma.productVariant.updateMany).not.toHaveBeenCalled();
    expect(revalidation.revalidateStoresOfProduct).not.toHaveBeenCalled();
  });
});

describe('a provider base product reaches every reselling store', () => {
  it('the real RevalidationService refreshes each reseller slug once', async () => {
    const base = { id: 'base', creator_id: null, provider_id: 'prov1' };
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
    // The order line carries a variant of the provider's base product.
    const b = buildFlow(
      revalidation,
      { variants: { 'base-v': 0 } },
      { 'base-v': base },
    );
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.orderItem.findMany.mockResolvedValue([variantItem('base-v', 2)]);
    await b.service.markOrderFailed('o1');
    await settle();
    expect(b.variants.get('base-v')).toBe(2);
    expect(lookups.customProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { product_id: 'base' } }),
    );
    expect(bySlug.mock.calls.map((c) => c[0]).sort()).toEqual([
      'shop-a',
      'shop-b',
    ]);
    // Not the creator path: a base product has no creator store.
    expect(lookups.store.findUnique).not.toHaveBeenCalled();
  });

  it('a creator product reaches its own store', async () => {
    const lookups = {
      customProduct: { findMany: jest.fn(() => Promise.resolve([])) },
      store: {
        findMany: jest.fn(() => Promise.resolve([])),
        findUnique: jest.fn(() => Promise.resolve({ slug: 'namez' })),
      },
    };
    const revalidation = new RevalidationService(
      lookups as unknown as PrismaService,
    );
    const bySlug = jest
      .spyOn(revalidation, 'revalidateStoreBySlug')
      .mockImplementation(() => Promise.resolve());
    const b = buildFlow(revalidation, { products: { p1: 0 } });
    b.prisma.order.findUnique.mockResolvedValue(unpaid());
    b.prisma.orderItem.findMany.mockResolvedValue([productItem('p1')]);
    await b.service.markOrderFailed('o1');
    await settle();
    expect(lookups.store.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { creator_id: CREATOR_ID } }),
    );
    expect(bySlug).toHaveBeenCalledTimes(1);
    expect(bySlug).toHaveBeenCalledWith('namez');
    expect(lookups.customProduct.findMany).not.toHaveBeenCalled();
  });
});
