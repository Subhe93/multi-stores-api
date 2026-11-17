import { StoreType } from '@prisma/client';
import { CartService } from './cart.service';
import { PrismaService } from '../../prisma/prisma.service';
import { buildPersonalizationCore } from '../personalization/__fixtures__/personalization-service.factory';
import { TaxService } from '../taxes/tax.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { B2bService } from '../b2b/b2b.service';

// GET /cart for products that require no shipping (services / digital
// products): the line carries `requires_shipping: false`, and the cart does
// too when it has lines and none of them requires shipping. A cart of
// physical products answers exactly as before (no new key).

const baseProduct = {
  creator_id: 'c1',
  tax_class_id: null,
  tax_exempt: false,
  variant_option_config: null,
  max_per_order: null,
  images: [],
  custom_fields: [],
  status: 'PUBLISHED',
};

/** `physical` has no flag at all, like a row read through an old mock. */
const PRODUCTS: Record<string, Record<string, unknown>> = {
  physical: {
    ...baseProduct,
    id: 'physical',
    base_price: 100,
    translations: [{ locale: 'en', title: 'T-shirt' }],
  },
  flagged: {
    ...baseProduct,
    id: 'flagged',
    base_price: 50,
    requires_shipping: true,
    translations: [{ locale: 'en', title: 'Mug' }],
  },
  service: {
    ...baseProduct,
    id: 'service',
    base_price: 900,
    requires_shipping: false,
    translations: [{ locale: 'en', title: 'Course' }],
  },
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

const row = (id: string, over: Partial<Row>): Row => ({
  id,
  cart_id: 'cart1',
  product_id: null,
  variant_id: null,
  custom_product_id: null,
  bundle_offer_id: null,
  quantity: 1,
  custom_fields: null,
  ...over,
});

function build(
  rows: Row[],
  opts: { customBase?: Record<string, unknown> } = {},
) {
  const cartRow = { id: 'cart1', customer_id: 'cust1', updated_at: new Date() };
  const prisma = {
    customer: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'cust1', user_id: 'u1' }),
      ),
    },
    cart: {
      findUnique: jest.fn(({ include }: { include?: { items?: true } }) =>
        Promise.resolve(include?.items ? { ...cartRow, items: rows } : cartRow),
      ),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    product: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(PRODUCTS[where.id] ?? null),
      ),
      findMany: jest.fn(() => Promise.resolve(Object.values(PRODUCTS))),
    },
    productVariant: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    productCustomField: { findMany: jest.fn(() => Promise.resolve([])) },
    productMarketPrice: { findMany: jest.fn(() => Promise.resolve([])) },
    cartItem: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    productImage: { findFirst: jest.fn(() => Promise.resolve(null)) },
    customProduct: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          opts.customBase
            ? {
                id: 'cp1',
                creator_id: 'c1',
                pricing_type: 'SINGLE',
                final_price: 250,
                margin_amount: null,
                translations: [{ locale: 'en', title: 'Resold item' }],
                mockup_images: [],
                selected_variants: [],
                product: {
                  ...baseProduct,
                  id: 'base1',
                  base_price: 200,
                  provider_id: 'prov1',
                  translations: [{ locale: 'en', title: 'Base item' }],
                  ...opts.customBase,
                },
              }
            : null,
        ),
      ),
      findMany: jest.fn(() => Promise.resolve([])),
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
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
  };
  const tax = {
    contextFor: jest.fn(() => Promise.resolve({ pricingMode: 'INCLUSIVE' })),
    loadTaxData: jest.fn(() => Promise.resolve({})),
    computeTaxes: jest.fn((input: { lines: { amount: number }[] }) => ({
      items: input.lines.map(() => ({
        tax_rate_bp: 2500,
        tax_amount: 0,
        tax_class_key: 'standard',
      })),
      headline_rate_bp: 2500,
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

describe('CartService requires_shipping keys', () => {
  it('cart of physical products: no key on the lines or the cart', async () => {
    const { service } = build([
      row('i1', { product_id: 'physical' }),
      row('i2', { product_id: 'flagged' }),
    ]);
    const cart = await service.getCart('u1');
    expect(cart.items).toHaveLength(2);
    for (const item of cart.items) {
      expect('requires_shipping' in item).toBe(false);
    }
    expect('requires_shipping' in cart).toBe(false);
  });

  it('only services: false on every line and on the cart', async () => {
    const { service } = build([
      row('i1', { product_id: 'service', quantity: 2 }),
    ]);
    const cart = await service.getCart('u1');
    expect(cart.items[0]).toMatchObject({ requires_shipping: false });
    expect(cart).toMatchObject({ requires_shipping: false });
  });

  it('mixed cart: false on the service line only, no cart key', async () => {
    const { service } = build([
      row('i1', { product_id: 'physical' }),
      row('i2', { product_id: 'service' }),
    ]);
    const cart = await service.getCart('u1');
    expect('requires_shipping' in cart.items[0]).toBe(false);
    expect(cart.items[1]).toMatchObject({ requires_shipping: false });
    expect('requires_shipping' in cart).toBe(false);
  });

  it('empty cart: no key', async () => {
    const { service } = build([]);
    const cart = await service.getCart('u1');
    expect(cart.items).toEqual([]);
    expect('requires_shipping' in cart).toBe(false);
  });

  it('a line whose product is gone keeps the default (no key)', async () => {
    const { service } = build([row('i1', { product_id: 'deleted' })]);
    const cart = await service.getCart('u1');
    expect('requires_shipping' in cart.items[0]).toBe(false);
    expect('requires_shipping' in cart).toBe(false);
  });

  it('a custom product inherits the flag of its base product', async () => {
    const off = build([row('i1', { custom_product_id: 'cp1' })], {
      customBase: { requires_shipping: false },
    });
    const cartOff = await off.service.getCart('u1');
    expect(cartOff.items[0]).toMatchObject({ requires_shipping: false });
    expect(cartOff).toMatchObject({ requires_shipping: false });

    const on = build([row('i1', { custom_product_id: 'cp1' })], {
      customBase: {},
    });
    const cartOn = await on.service.getCart('u1');
    expect('requires_shipping' in cartOn.items[0]).toBe(false);
    expect('requires_shipping' in cartOn).toBe(false);
  });
});
