import { ConfigService } from '@nestjs/config';
import { StoreType } from '@prisma/client';
import { CartService } from './cart.service';
import { PrismaService } from '../../prisma/prisma.service';
import { buildPersonalizationCore } from '../personalization/__fixtures__/personalization-service.factory';
import { TaxService } from '../taxes/tax.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { B2bService } from '../b2b/b2b.service';
import {
  CART_INSUFFICIENT_STOCK,
  cartLineStockRef,
  insufficientStockError,
  roomOnRow,
  unitsOnRow,
} from './cart-stock';

// The cart refuses a quantity above the stock of the row order creation
// would take from (cart-stock.ts): POST /cart/items and a quantity increase
// answer 400 CART_INSUFFICIENT_STOCK, a decrease is always allowed, and
// GET /cart lines carry `stock_available` when their row is tracked.

describe('cart-stock helpers', () => {
  const none = new Map<string, string>();

  it('cartLineStockRef picks the row order creation takes from', () => {
    expect(
      cartLineStockRef(
        { product_id: 'p1', variant_id: 'v1', quantity: 1 },
        none,
        false,
      ),
    ).toEqual({ kind: 'variant', id: 'v1' });
    expect(
      cartLineStockRef({ product_id: 'p1', quantity: 1 }, none, false),
    ).toEqual({ kind: 'product', id: 'p1' });
    expect(cartLineStockRef({ quantity: 1 }, none, false)).toBeNull();
  });

  it('an imported line holds stock only while the cut-over is in effect', () => {
    const base = new Map([['cp1', 'base1']]);
    const line = { custom_product_id: 'cp1', quantity: 1 };
    expect(cartLineStockRef(line, base, false)).toBeNull();
    expect(cartLineStockRef(line, base, true)).toEqual({
      kind: 'product',
      id: 'base1',
    });
    expect(
      cartLineStockRef({ ...line, variant_id: 'bv1' }, base, true),
    ).toEqual({ kind: 'variant', id: 'bv1' });
    // A client-sent product_id on an imported line is never the row.
    expect(
      cartLineStockRef({ ...line, product_id: 'other' }, base, true),
    ).toEqual({ kind: 'product', id: 'base1' });
    // Unknown custom product: no row.
    expect(cartLineStockRef(line, none, true)).toBeNull();
  });

  it('unitsOnRow sums the lines that sell the same row', () => {
    const lines = [
      { product_id: 'p1', variant_id: 'v1', quantity: 2 },
      { product_id: 'p1', variant_id: 'v1', quantity: 3 },
      { product_id: 'p1', variant_id: 'v2', quantity: 5 },
      { product_id: 'p1', quantity: 7 },
    ];
    expect(unitsOnRow({ kind: 'variant', id: 'v1' }, lines, none, false)).toBe(
      5,
    );
    expect(unitsOnRow({ kind: 'product', id: 'p1' }, lines, none, false)).toBe(
      7,
    );
  });

  it('roomOnRow never goes below 0', () => {
    expect(roomOnRow(8, 0)).toBe(8);
    expect(roomOnRow(8, 3)).toBe(5);
    expect(roomOnRow(8, 9)).toBe(0);
    expect(roomOnRow(-2, 0)).toBe(0);
  });

  it('insufficientStockError carries the code, the number and the ids', () => {
    expect(
      insufficientStockError({ product_id: 'p1', variant_id: 'v1' }, 8),
    ).toEqual({
      code: CART_INSUFFICIENT_STOCK,
      message: 'Only 8 in stock.',
      available: 8,
      product_id: 'p1',
      variant_id: 'v1',
    });
    expect(insufficientStockError({ custom_product_id: 'cp1' }, 0)).toEqual({
      code: CART_INSUFFICIENT_STOCK,
      message: 'This item is out of stock.',
      available: 0,
      custom_product_id: 'cp1',
    });
  });
});

type Row = {
  id: string;
  cart_id: string;
  product_id: string | null;
  variant_id: string | null;
  custom_product_id: string | null;
  bundle_offer_id: string | null;
  design_id: string | null;
  quantity: number;
  custom_fields: unknown;
};

type ProductSpec = {
  track_inventory: boolean;
  stock_quantity: number | null;
  creator_id?: string | null;
};

const row = (over: Partial<Row>): Row => ({
  id: 'i1',
  cart_id: 'cart1',
  product_id: 'p1',
  variant_id: null,
  custom_product_id: null,
  bundle_offer_id: null,
  design_id: null,
  quantity: 1,
  custom_fields: null,
  ...over,
});

function build(opts: {
  products?: Record<string, ProductSpec>;
  /** variant id → product id + stock (null = untracked). */
  variants?: Record<string, { product_id: string; stock: number | null }>;
  /** custom product id → base product id. */
  customProducts?: Record<string, string>;
  rows?: Row[];
  /** CUSTOM_LINE_STOCK_SINCE value (undefined = unset). */
  customLineStockSince?: string;
}) {
  const items = opts.rows ?? [];
  const productRow = (id: string) => {
    const p = opts.products?.[id];
    if (!p) return null;
    return {
      id,
      creator_id: p.creator_id === undefined ? 'c1' : p.creator_id,
      provider_id: null,
      base_price: 100,
      tax_class_id: null,
      tax_exempt: false,
      variant_option_config: null,
      max_per_order: null,
      track_inventory: p.track_inventory,
      stock_quantity: p.stock_quantity,
      translations: [{ locale: 'en', title: `Product ${id}` }],
      images: [],
      custom_fields: [],
      status: 'PUBLISHED',
    };
  };
  const variantRow = (id: string) => {
    const v = opts.variants?.[id];
    if (!v) return null;
    return {
      id,
      product_id: v.product_id,
      is_active: true,
      price_adjustment: 0,
      options: { size: id },
      stock_quantity: v.stock,
      images: [],
    };
  };
  const customRow = (id: string) => {
    const base = opts.customProducts?.[id];
    if (!base) return null;
    return {
      id,
      product_id: base,
      creator_id: 'c1',
      status: 'PUBLISHED',
      pricing_type: 'SINGLE',
      final_price: 150,
      margin_amount: null,
      translations: [{ locale: 'en', title: `Import ${id}` }],
      mockup_images: [],
      selected_variants: [],
      product: productRow(base),
    };
  };
  const cartRow = { id: 'cart1', customer_id: 'cust1', updated_at: new Date() };
  let nextId = 100;
  const prisma = {
    customer: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'cust1', user_id: 'u1' }),
      ),
    },
    cart: {
      findUnique: jest.fn(({ include }: { include?: { items?: true } }) =>
        Promise.resolve(include?.items ? { ...cartRow, items } : cartRow),
      ),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    product: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(productRow(where.id)),
      ),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    productVariant: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(variantRow(where.id)),
      ),
      findFirst: jest.fn(
        ({ where }: { where: { id: string; product_id?: string } }) => {
          const v = variantRow(where.id);
          return Promise.resolve(
            v && (!where.product_id || v.product_id === where.product_id)
              ? v
              : null,
          );
        },
      ),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    productCustomField: { findMany: jest.fn(() => Promise.resolve([])) },
    productMarketPrice: { findMany: jest.fn(() => Promise.resolve([])) },
    cartItem: {
      findFirst: jest.fn(({ where }: { where: Partial<Row> }) =>
        Promise.resolve(
          items.find((i) =>
            where.id
              ? i.id === where.id
              : (i.product_id ?? null) === (where.product_id ?? null) &&
                (i.variant_id ?? null) === (where.variant_id ?? null) &&
                (i.custom_product_id ?? null) ===
                  (where.custom_product_id ?? null),
          ) ?? null,
        ),
      ),
      findMany: jest.fn(() => Promise.resolve(items.map((i) => ({ ...i })))),
      create: jest.fn(({ data }: { data: Partial<Row> }) => {
        const created = row({ ...data, id: `i${nextId++}` });
        items.push(created);
        return Promise.resolve(created);
      }),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          const target = items.find((i) => i.id === where.id);
          if (target) Object.assign(target, data);
          return Promise.resolve(target);
        },
      ),
    },
    productImage: { findFirst: jest.fn(() => Promise.resolve(null)) },
    customProduct: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(customRow(where.id)),
      ),
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.flatMap((id) => {
            const cp = customRow(id);
            return cp ? [{ id: cp.id, product_id: cp.product_id }] : [];
          }),
        ),
      ),
    },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'SEK' })),
    },
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 's1',
          store_type: StoreType.MARKETPLACE,
          currency: 'SEK',
          tax_pricing_mode: 'INCLUSIVE',
          tax_basis: 'SHIPPING',
          tax_country: 'SE',
          oss_registered: false,
          use_platform_tax_rates: true,
          shipping_tax_class_id: null,
          display_prices_incl_tax: true,
        }),
      ),
    },
  };
  const tax = {
    contextFor: jest.fn(() => Promise.resolve({ pricingMode: 'INCLUSIVE' })),
    loadTaxData: jest.fn(() => Promise.resolve({})),
    computeTaxes: jest.fn((input: { lines: { amount: number }[] }) => ({
      items: input.lines.map(() => ({
        tax_rate_bp: 600,
        tax_amount: 0,
        tax_class_key: 'standard',
      })),
      headline_rate_bp: 600,
      tax_total: 0,
      tax_lines: [],
      tax_pricing_mode: 'INCLUSIVE',
      total: input.lines.reduce((s, l) => s + l.amount, 0),
    })),
  };
  const config = {
    get: jest.fn((key: string) =>
      key === 'CUSTOM_LINE_STOCK_SINCE' ? opts.customLineStockSince : undefined,
    ),
  };
  const service = new CartService(
    prisma as unknown as PrismaService,
    tax as unknown as TaxService,
    {
      resolve: jest.fn(() => Promise.resolve(null)),
    } as unknown as MarketsContextService,
    new MarketPricingService(prisma as unknown as PrismaService),
    {
      isEnabled: jest.fn(() => Promise.resolve(false)),
      resolveBuyerType: jest.fn(() => Promise.resolve('PERSON')),
    } as unknown as B2bService,
    buildPersonalizationCore(prisma).core,
    undefined,
    undefined,
    config as unknown as ConfigService,
  );
  return { service, prisma, items };
}

const stockError = (available: number, ids: Record<string, string>) => ({
  response: { code: CART_INSUFFICIENT_STOCK, available, ...ids },
});

type Line = { id: string; quantity: number; stock_available?: number };
const lineOf = (cart: { items: unknown[] }, id: string) =>
  (cart.items as Line[]).find((l) => l.id === id) as Line;

describe('CartService stock limit: own product without variants', () => {
  const tracked = { p1: { track_inventory: true, stock_quantity: 8 } };

  it('refuses an add over the stock (the reported case: 9 with 8 left)', async () => {
    const { service, prisma } = build({ products: tracked });
    await expect(
      service.addItem('u1', { product_id: 'p1', quantity: 9 }),
    ).rejects.toMatchObject(stockError(8, { product_id: 'p1' }));
    expect(prisma.cartItem.create).not.toHaveBeenCalled();
    expect(prisma.cartItem.update).not.toHaveBeenCalled();
  });

  it('accepts exactly the stock, and reports the room on the line', async () => {
    const { service, items } = build({ products: tracked });
    const cart = await service.addItem('u1', { product_id: 'p1', quantity: 8 });
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(8);
    expect(lineOf(cart, items[0].id).stock_available).toBe(8);
  });

  it('adding twice counts what is already in the cart', async () => {
    const { service, items } = build({ products: tracked });
    await service.addItem('u1', { product_id: 'p1', quantity: 5 });
    await expect(
      service.addItem('u1', { product_id: 'p1', quantity: 4 }),
    ).rejects.toMatchObject(stockError(8, { product_id: 'p1' }));
    expect(items[0].quantity).toBe(5);
    await service.addItem('u1', { product_id: 'p1', quantity: 3 });
    expect(items[0].quantity).toBe(8);
  });

  it('a sold-out product cannot be added (available 0)', async () => {
    const { service } = build({
      products: { p1: { track_inventory: true, stock_quantity: 0 } },
    });
    await expect(
      service.addItem('u1', { product_id: 'p1', quantity: 1 }),
    ).rejects.toMatchObject({
      response: {
        code: CART_INSUFFICIENT_STOCK,
        available: 0,
        message: 'This item is out of stock.',
      },
    });
  });

  it('an untracked product takes any quantity, reads no cart row and gets no new key', async () => {
    for (const product of [
      { track_inventory: false, stock_quantity: 3 },
      { track_inventory: true, stock_quantity: null },
    ]) {
      const { service, prisma, items } = build({ products: { p1: product } });
      const cart = await service.addItem('u1', {
        product_id: 'p1',
        quantity: 500,
      });
      expect(prisma.cartItem.findMany).not.toHaveBeenCalled();
      expect('stock_available' in lineOf(cart, items[0].id)).toBe(false);
    }
  });

  it('update: an increase over the stock is refused, up to the stock is accepted', async () => {
    const { service, items } = build({
      products: tracked,
      rows: [row({ id: 'i1', quantity: 2 })],
    });
    await expect(
      service.updateItem('u1', 'i1', { quantity: 9 }),
    ).rejects.toMatchObject(stockError(8, { product_id: 'p1' }));
    expect(items[0].quantity).toBe(2);
    const cart = await service.updateItem('u1', 'i1', { quantity: 8 });
    expect(items[0].quantity).toBe(8);
    expect(lineOf(cart, 'i1').stock_available).toBe(8);
  });

  it('update: a decrease is always allowed, even in a cart already over the stock', async () => {
    const { service, prisma, items } = build({
      products: { p1: { track_inventory: true, stock_quantity: 3 } },
      rows: [row({ id: 'i1', quantity: 10 })],
    });
    await service.updateItem('u1', 'i1', { quantity: 9 });
    expect(items[0].quantity).toBe(9);
    // No stock read of the cart rows for a decrease.
    expect(prisma.cartItem.findMany).not.toHaveBeenCalled();
  });

  it('update: an unchanged quantity is not checked', async () => {
    const { service, items } = build({
      products: { p1: { track_inventory: true, stock_quantity: 3 } },
      rows: [row({ id: 'i1', quantity: 10 })],
    });
    await service.updateItem('u1', 'i1', { quantity: 10 });
    expect(items[0].quantity).toBe(10);
  });
});

describe('CartService stock limit: variants', () => {
  const catalogue = {
    products: { p1: { track_inventory: true, stock_quantity: 40 } },
    variants: {
      v1: { product_id: 'p1', stock: 8 },
      v2: { product_id: 'p1', stock: 2 },
      vfree: { product_id: 'p1', stock: null },
    },
  };

  it('the variant row decides, not the product number', async () => {
    const { service } = build(catalogue);
    await expect(
      service.addItem('u1', {
        product_id: 'p1',
        variant_id: 'v2',
        quantity: 3,
      }),
    ).rejects.toMatchObject(
      stockError(2, { product_id: 'p1', variant_id: 'v2' }),
    );
  });

  it('an untracked variant takes any quantity (no fall back to the product)', async () => {
    const { service, items } = build(catalogue);
    const cart = await service.addItem('u1', {
      product_id: 'p1',
      variant_id: 'vfree',
      quantity: 100,
    });
    expect(items[0].quantity).toBe(100);
    expect('stock_available' in lineOf(cart, items[0].id)).toBe(false);
  });

  it('two lines of one variant share its stock (different personalization)', async () => {
    const { service, items } = build({
      ...catalogue,
      rows: [
        row({
          id: 'i1',
          variant_id: 'v1',
          quantity: 5,
          custom_fields: { f: 'A' },
        }),
        row({
          id: 'i2',
          variant_id: 'v1',
          quantity: 2,
          custom_fields: { f: 'B' },
        }),
      ],
    });
    // i1 may hold 8 - 2 = 6.
    await expect(
      service.updateItem('u1', 'i1', { quantity: 7 }),
    ).rejects.toMatchObject(
      stockError(6, { product_id: 'p1', variant_id: 'v1' }),
    );
    const cart = await service.updateItem('u1', 'i1', { quantity: 6 });
    expect(items[0].quantity).toBe(6);
    expect(lineOf(cart, 'i1').stock_available).toBe(6);
    expect(lineOf(cart, 'i2').stock_available).toBe(2);
    // An add of the same item counts both lines: 6 + 2 + 1 > 8.
    await expect(
      service.addItem('u1', {
        product_id: 'p1',
        variant_id: 'v1',
        quantity: 1,
      }),
    ).rejects.toMatchObject({ response: { code: CART_INSUFFICIENT_STOCK } });
  });

  it('another variant of the same product does not count', async () => {
    const { service, items } = build({
      ...catalogue,
      rows: [row({ id: 'i1', variant_id: 'v2', quantity: 2 })],
    });
    await service.addItem('u1', {
      product_id: 'p1',
      variant_id: 'v1',
      quantity: 8,
    });
    expect(items).toHaveLength(2);
  });
});

describe('CartService stock limit: imported (custom product) lines', () => {
  const catalogue = {
    products: {
      base1: { track_inventory: true, stock_quantity: 4, creator_id: null },
    },
    variants: { bv1: { product_id: 'base1', stock: 3 } },
    customProducts: { cp1: 'base1' },
  };

  it('cut-over unset: no limit and no new key (orders take nothing either)', async () => {
    const { service, items, prisma } = build(catalogue);
    const cart = await service.addItem('u1', {
      custom_product_id: 'cp1',
      quantity: 50,
    });
    expect(items[0].quantity).toBe(50);
    expect('stock_available' in lineOf(cart, items[0].id)).toBe(false);
    expect(prisma.cartItem.findMany).not.toHaveBeenCalled();
    await service.updateItem('u1', items[0].id, { quantity: 60 });
    expect(items[0].quantity).toBe(60);
  });

  it('cut-over in effect: the base product row bounds the line', async () => {
    const { service, items } = build({
      ...catalogue,
      customLineStockSince: '2020-01-01T00:00:00Z',
    });
    await expect(
      service.addItem('u1', { custom_product_id: 'cp1', quantity: 5 }),
    ).rejects.toMatchObject(stockError(4, { custom_product_id: 'cp1' }));
    const cart = await service.addItem('u1', {
      custom_product_id: 'cp1',
      quantity: 4,
    });
    expect(lineOf(cart, items[0].id).stock_available).toBe(4);
    await expect(
      service.updateItem('u1', items[0].id, { quantity: 5 }),
    ).rejects.toMatchObject(stockError(4, { custom_product_id: 'cp1' }));
  });

  it('cut-over in effect: the base variant row bounds a variant line', async () => {
    const { service } = build({
      ...catalogue,
      customLineStockSince: '2020-01-01T00:00:00Z',
    });
    await expect(
      service.addItem('u1', {
        custom_product_id: 'cp1',
        variant_id: 'bv1',
        quantity: 4,
      }),
    ).rejects.toMatchObject(
      stockError(3, { custom_product_id: 'cp1', variant_id: 'bv1' }),
    );
  });

  it('a cut-over in the future is not in effect yet', async () => {
    const { service, items } = build({
      ...catalogue,
      customLineStockSince: '2999-01-01T00:00:00Z',
    });
    await service.addItem('u1', { custom_product_id: 'cp1', quantity: 50 });
    expect(items[0].quantity).toBe(50);
  });
});
