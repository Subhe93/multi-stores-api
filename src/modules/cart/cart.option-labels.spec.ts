import { StoreType } from '@prisma/client';
import { CartService } from './cart.service';
import { PrismaService } from '../../prisma/prisma.service';
import { buildPersonalizationCore } from '../personalization/__fixtures__/personalization-service.factory';
import { TaxService } from '../taxes/tax.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { B2bService } from '../b2b/b2b.service';

// M159: the signed-in cart line label (`variant`) uses the option labels of
// the cart locale; without labels (or in the primary locale) it is exactly
// today's canonical "name: value / name: value" text.

const DE = {
  names: { Färg: 'Farbe' },
  values: { Färg: { Svart: 'Schwarz' } },
};

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

const PRODUCTS: Record<string, Record<string, unknown>> = {
  mug: {
    ...baseProduct,
    id: 'mug',
    base_price: 100,
    translations: [
      { locale: 'sv', title: 'Mugg', variant_option_labels: null },
      { locale: 'de', title: 'Tasse', variant_option_labels: DE },
    ],
  },
  plain: {
    ...baseProduct,
    id: 'plain',
    base_price: 100,
    translations: [{ locale: 'sv', title: 'Mugg' }],
  },
};

const VARIANTS: Record<string, Record<string, unknown>> = {
  vm: {
    id: 'vm',
    product_id: 'mug',
    options: { Färg: 'Svart', Storlek: 'M' },
    price_adjustment: 0,
    stock_quantity: null,
    images: [],
  },
  vp: {
    id: 'vp',
    product_id: 'plain',
    options: { Färg: 'Svart', Storlek: 'M' },
    price_adjustment: 0,
    stock_quantity: null,
    images: [],
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
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(VARIANTS[where.id] ?? null),
      ),
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

describe('CartService variant label (M159)', () => {
  const lines = [
    row('i1', { product_id: 'mug', variant_id: 'vm' }),
    row('i2', { product_id: 'plain', variant_id: 'vp' }),
  ];

  it('de: translated names / values, canonical fallback per part', async () => {
    const { service } = build(lines);
    const cart = await service.getCart('u1', 'de');
    expect(cart.items[0]).toMatchObject({
      variant: 'Farbe: Schwarz / Storlek: M',
    });
    expect(cart.items[1]).toMatchObject({
      variant: 'Färg: Svart / Storlek: M',
    });
  });

  it('sv (primary) and products without labels: the exact current text', async () => {
    const { service } = build(lines);
    const cart = await service.getCart('u1', 'sv');
    expect(cart.items[0]).toMatchObject({
      variant: 'Färg: Svart / Storlek: M',
    });
    expect(cart.items[1]).toMatchObject({
      variant: 'Färg: Svart / Storlek: M',
    });
  });
});
