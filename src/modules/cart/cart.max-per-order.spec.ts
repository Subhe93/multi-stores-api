import { StoreType } from '@prisma/client';
import { CartService } from './cart.service';
import { PrismaService } from '../../prisma/prisma.service';
import { buildPersonalizationCore } from '../personalization/__fixtures__/personalization-service.factory';
import { TaxService } from '../taxes/tax.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { B2bService } from '../b2b/b2b.service';
import {
  assertLineLimits,
  assertMaxPerOrder,
  CART_MAX_PER_ORDER,
  effectiveMax,
  lineLimitOf,
  readMaxPerOrder,
} from './max-per-order';

// Headless booking B2: Product.max_per_order caps the units of one product
// per cart / order, summed across its lines. null = unlimited, and a cart
// without limited products behaves (and answers) exactly as before.

describe('max-per-order helpers', () => {
  it('readMaxPerOrder keeps positive integers only', () => {
    expect(readMaxPerOrder(2)).toBe(2);
    for (const v of [null, undefined, 0, -1, 1.5, '2', NaN]) {
      expect(readMaxPerOrder(v)).toBeNull();
    }
  });

  it('lineLimitOf: null without a limit', () => {
    expect(lineLimitOf({ id: 'p1', max_per_order: null })).toBeNull();
    expect(lineLimitOf({ id: 'p1' })).toBeNull();
    expect(lineLimitOf({ id: 'p1', max_per_order: 3 })).toEqual({
      productId: 'p1',
      max: 3,
    });
  });

  it('assertMaxPerOrder throws the coded 400 with params', () => {
    expect(() => assertMaxPerOrder('p1', 2, 2)).not.toThrow();
    expect(() => assertMaxPerOrder('p1', 99, null)).not.toThrow();
    expect(() => assertMaxPerOrder('p1', 3, 2)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: CART_MAX_PER_ORDER,
          params: { max: 2, product_id: 'p1' },
        }),
      }),
    );
  });

  it('assertLineLimits sums lines of the same product only', () => {
    const l = { productId: 'p1', max: 2 };
    expect(() =>
      assertLineLimits([
        { limit: l, quantity: 1 },
        { limit: null, quantity: 50 },
        { limit: { productId: 'p2', max: 1 }, quantity: 1 },
        { limit: l, quantity: 1 },
      ]),
    ).not.toThrow();
    expect(() =>
      assertLineLimits([
        { limit: l, quantity: 2 },
        { limit: l, quantity: 1 },
      ]),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: CART_MAX_PER_ORDER }),
      }),
    );
    expect(() =>
      assertLineLimits([{ limit: null, quantity: 999 }]),
    ).not.toThrow();
  });

  it('effectiveMax: min of stock and limit, floored to the step', () => {
    expect(effectiveMax(null, null)).toBeNull();
    expect(effectiveMax(5, null)).toBe(5);
    expect(effectiveMax(null, 3)).toBe(3);
    expect(effectiveMax(5, 3)).toBe(3);
    expect(effectiveMax(7, 9, 2)).toBe(6);
    expect(effectiveMax(1, 9, 2)).toBe(0);
    expect(effectiveMax(-3, 2)).toBe(0);
  });
});

const baseProduct = {
  id: 'p1',
  creator_id: 'c1',
  base_price: 100,
  tax_class_id: null,
  tax_exempt: false,
  variant_option_config: null,
  translations: [{ locale: 'en', title: 'Kurs 2026-12-01 09:00' }],
  images: [],
  custom_fields: [],
  status: 'PUBLISHED',
};

type Row = {
  id: string;
  cart_id: string;
  product_id: string | null;
  variant_id: string | null;
  custom_product_id: string | null;
  bundle_offer_id: string | null;
  quantity: number;
  custom_fields: unknown;
};

function build(maxPerOrder: number | null, rows: Row[] = []) {
  const product = { ...baseProduct, max_per_order: maxPerOrder };
  const items = rows;
  const cartRow = {
    id: 'cart1',
    customer_id: 'cust1',
    updated_at: new Date(),
  };
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
      findUnique: jest.fn(() => Promise.resolve(product)),
      findMany: jest.fn(() => Promise.resolve([product])),
    },
    productVariant: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    productCustomField: { findMany: jest.fn(() => Promise.resolve([])) },
    productMarketPrice: { findMany: jest.fn(() => Promise.resolve([])) },
    cartItem: {
      findFirst: jest.fn(({ where }: { where: { id?: string } }) =>
        Promise.resolve(
          where.id ? (items.find((i) => i.id === where.id) ?? null) : null,
        ),
      ),
      findMany: jest.fn(({ where }: { where: { id?: { not: string } } }) =>
        Promise.resolve(
          items.filter((i) => !i.custom_product_id && i.id !== where.id?.not),
        ),
      ),
      create: jest.fn(() => Promise.resolve({})),
      update: jest.fn(() => Promise.resolve({})),
    },
    productImage: { findFirst: jest.fn(() => Promise.resolve(null)) },
    customProduct: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'SEK' })),
    },
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 's1',
          store_type: StoreType.INDEPENDENT,
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
  );
  return { service, prisma };
}

const row = (over: Partial<Row>): Row => ({
  id: 'i1',
  cart_id: 'cart1',
  product_id: 'p1',
  variant_id: null,
  custom_product_id: null,
  bundle_offer_id: null,
  quantity: 1,
  custom_fields: null,
  ...over,
});

describe('CartService max_per_order (B2b)', () => {
  it('null = unlimited: no cart rows read, add as before, no new key', async () => {
    const { service, prisma } = build(null, [row({ quantity: 40 })]);
    const cart = await service.addItem('u1', {
      product_id: 'p1',
      quantity: 60,
    });
    expect(prisma.cartItem.findMany).not.toHaveBeenCalled();
    expect(
      prisma.cartItem.create.mock.calls.length +
        prisma.cartItem.update.mock.calls.length,
    ).toBe(1);
    expect('max_per_order' in cart.items[0]).toBe(false);
  });

  it('refuses the third unit of a product limited to 2 (sum across lines)', async () => {
    const { service, prisma } = build(2, [
      row({ id: 'i1', quantity: 1, custom_fields: { f1: 'A' } }),
      row({ id: 'i2', quantity: 1, custom_fields: { f1: 'B' } }),
    ]);
    await expect(
      service.addItem('u1', { product_id: 'p1', quantity: 1 }),
    ).rejects.toMatchObject({
      response: {
        code: CART_MAX_PER_ORDER,
        params: { max: 2, product_id: 'p1' },
      },
    });
    expect(prisma.cartItem.create).not.toHaveBeenCalled();
    expect(prisma.cartItem.update).not.toHaveBeenCalled();
  });

  it('a refused add never reaches the designer step (no design claimed)', async () => {
    const { prisma } = build(1, [row({ quantity: 1 })]);
    const designerCart = { resolveCartLine: jest.fn(() => Promise.resolve(null)) };
    const tax = {
      contextFor: jest.fn(() => Promise.resolve({ pricingMode: 'INCLUSIVE' })),
    };
    const service = new CartService(
      prisma as unknown as PrismaService,
      tax as unknown as TaxService,
      { resolve: jest.fn(() => Promise.resolve(null)) } as unknown as MarketsContextService,
      new MarketPricingService(prisma as unknown as PrismaService),
      {
        isEnabled: jest.fn(() => Promise.resolve(false)),
        resolveBuyerType: jest.fn(() => Promise.resolve('PERSON')),
      } as unknown as B2bService,
      buildPersonalizationCore(prisma).core,
      undefined,
      designerCart as unknown as ConstructorParameters<typeof CartService>[7],
    );
    await expect(
      service.addItem('u1', { product_id: 'p1', quantity: 1 }),
    ).rejects.toMatchObject({ response: { code: CART_MAX_PER_ORDER } });
    expect(designerCart.resolveCartLine).not.toHaveBeenCalled();
  });

  it('accepts up to the limit and exposes max_per_order on the line', async () => {
    const { service, prisma } = build(2, [row({ quantity: 1 })]);
    const cart = await service.addItem('u1', { product_id: 'p1', quantity: 1 });
    expect(
      prisma.cartItem.create.mock.calls.length +
        prisma.cartItem.update.mock.calls.length,
    ).toBe(1);
    expect(cart.items[0]).toMatchObject({ max_per_order: 2 });
  });

  it('custom-product lines do not count towards the limit', async () => {
    const built = build(2, [
      row({
        id: 'c1',
        product_id: null,
        custom_product_id: 'cp1',
        quantity: 5,
      }),
    ]);
    await expect(
      built.service.addItem('u1', { product_id: 'p1', quantity: 2 }),
    ).resolves.toBeDefined();
    // The custom line is filtered out by the query.
    expect(built.prisma.cartItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          cart_id: 'cart1',
          custom_product_id: null,
        }),
      }),
    );
  });

  it('update: raising the quantity over the limit is refused', async () => {
    const { service, prisma } = build(2, [
      row({ id: 'i1', quantity: 1 }),
      row({ id: 'i2', quantity: 1, custom_fields: { f1: 'B' } }),
    ]);
    await expect(
      service.updateItem('u1', 'i1', { quantity: 2 }),
    ).rejects.toMatchObject({ response: { code: CART_MAX_PER_ORDER } });
    expect(prisma.cartItem.update).not.toHaveBeenCalled();
  });

  it('update: lowering the quantity is allowed even over the limit', async () => {
    const { service, prisma } = build(2, [row({ id: 'i1', quantity: 5 })]);
    await service.updateItem('u1', 'i1', { quantity: 4 });
    expect(prisma.cartItem.findMany).not.toHaveBeenCalled();
    expect(prisma.cartItem.update).toHaveBeenCalled();
  });

  it('update within the limit is accepted', async () => {
    const { service, prisma } = build(3, [
      row({ id: 'i1', quantity: 1 }),
      row({ id: 'i2', quantity: 1, custom_fields: { f1: 'B' } }),
    ]);
    await service.updateItem('u1', 'i1', { quantity: 2 });
    expect(prisma.cartItem.update).toHaveBeenCalled();
  });
});

describe('CartService activity touch (GD1)', () => {
  it('a fresh cart is not written; a stale one is refreshed once', async () => {
    const fresh = build(null);
    await fresh.service.addItem('u1', { product_id: 'p1', quantity: 1 });
    expect(fresh.prisma.cart.updateMany).not.toHaveBeenCalled();

    const stale = build(null);
    stale.prisma.cart.findUnique.mockImplementation((({
      include,
    }: {
      include?: { items?: true };
    }) =>
      Promise.resolve({
        id: 'cart1',
        customer_id: 'cust1',
        updated_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
        ...(include?.items ? { items: [] } : {}),
      })) as never);
    await stale.service.addItem('u1', { product_id: 'p1', quantity: 1 });
    expect(stale.prisma.cart.updateMany).toHaveBeenCalledTimes(1);
    expect(stale.prisma.cart.updateMany).toHaveBeenCalledWith({
      where: { id: 'cart1' },
      data: { updated_at: expect.any(Date) },
    });
  });
});
