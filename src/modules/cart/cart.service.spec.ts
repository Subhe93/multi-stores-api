import { StoreType } from '@prisma/client';
import { CartService } from './cart.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TaxService } from '../taxes/tax.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { B2bService } from '../b2b/b2b.service';
import type { MarketContext } from '../markets/market-context';

// GET /cart with the b2b app (D1/D2, watch list 1): `?buyer=company` must
// not change the response of a store without the app - no `b2b` key, no
// per-line `tax_rate_bp` - and with the app on the two are added without
// touching the existing figures.

const product = {
  id: 'p1',
  creator_id: 'c1',
  base_price: 125,
  tax_class_id: null,
  tax_exempt: false,
  variant_option_config: null,
  translations: [{ locale: 'en', title: 'Tee' }],
  images: [],
  custom_fields: [],
};

function makePrisma(priceRows: unknown[] = []) {
  const cartRow = { id: 'cart1', customer_id: 'cust1' };
  const items = [
    {
      id: 'i1',
      cart_id: 'cart1',
      product_id: 'p1',
      variant_id: null,
      custom_product_id: null,
      bundle_offer_id: null,
      quantity: 2,
      custom_fields: null,
    },
  ];
  return {
    customer: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'cust1', user_id: 'u1' }),
      ),
    },
    cart: {
      findUnique: jest.fn(({ include }: { include?: { items?: true } }) =>
        Promise.resolve(include?.items ? { ...cartRow, items } : cartRow),
      ),
    },
    product: {
      findUnique: jest.fn(() => Promise.resolve(product)),
      findMany: jest.fn(() => Promise.resolve([product])),
    },
    productVariant: { findUnique: jest.fn(() => Promise.resolve(null)) },
    productMarketPrice: {
      findMany: jest.fn(() => Promise.resolve(priceRows)),
    },
    cartItem: {
      findFirst: jest.fn(({ where }: { where: { id?: string } }) =>
        Promise.resolve(where.id ? items[0] : null),
      ),
      create: jest.fn(() => Promise.resolve({})),
      update: jest.fn(() => Promise.resolve({})),
    },
    productImage: { findFirst: jest.fn(() => Promise.resolve(null)) },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'EUR' })),
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
}

function build(opts: {
  enabled: boolean;
  buyerType?: 'PERSON' | 'COMPANY';
  market?: MarketContext | null;
  priceRows?: unknown[];
}) {
  const prisma = makePrisma(opts.priceRows);
  const tax = {
    contextFor: jest.fn(() => Promise.resolve({ pricingMode: 'INCLUSIVE' })),
    loadTaxData: jest.fn(() => Promise.resolve({})),
    computeTaxes: jest.fn(
      (input: { ctx: { buyerType?: string }; lines: { amount: number }[] }) => {
        const total = input.lines.reduce((s, l) => s + l.amount, 0);
        return {
          items: input.lines.map(() => ({
            tax_rate_bp: 2500,
            tax_amount: 50,
            tax_class_key: 'standard',
          })),
          headline_rate_bp: 2500,
          tax_total: 50,
          tax_lines: [
            {
              label: 'VAT',
              rate_bp: 2500,
              taxable_amount: 200,
              tax_amount: 50,
            },
          ],
          tax_pricing_mode: 'INCLUSIVE',
          total,
          display_mode: input.ctx.buyerType === 'COMPANY' ? 'excl' : 'incl',
          net_items: 200,
          net_shipping: 0,
          net_total: 200,
        };
      },
    ),
  };
  const markets = {
    resolve: jest.fn(() => Promise.resolve(opts.market ?? null)),
  };
  const b2b = {
    isEnabled: jest.fn(() => Promise.resolve(opts.enabled)),
    resolveBuyerType: jest.fn(() =>
      Promise.resolve(opts.buyerType ?? 'PERSON'),
    ),
  };
  const service = new CartService(
    prisma as unknown as PrismaService,
    tax as unknown as TaxService,
    markets as unknown as MarketsContextService,
    new MarketPricingService(prisma as unknown as PrismaService),
    b2b as unknown as B2bService,
  );
  return { service, tax, b2b, prisma };
}

describe('CartService.getCart with the b2b app', () => {
  it('app off: ?buyer=company yields exactly the pre-app response', async () => {
    const { service, b2b, tax } = build({ enabled: false });
    const plain = await service.getCart('u1');
    const company = await service.getCart(
      'u1',
      undefined,
      undefined,
      'company',
    );
    expect(company).toEqual(plain);
    expect('b2b' in plain).toBe(false);
    expect('tax_rate_bp' in plain.items[0]).toBe(false);
    expect(plain).toMatchObject({
      tax_rate_bp: 2500,
      tax_total: 50,
      total_with_tax: 250,
      tax_estimated: true,
    });
    expect(b2b.resolveBuyerType).not.toHaveBeenCalled();
    const ctx = (tax.computeTaxes.mock.calls.at(-1) as [{ ctx: object }])[0]
      .ctx;
    expect('buyerType' in ctx).toBe(false);
  });

  it('app on + company: per-line rate and the b2b block, other figures unchanged', async () => {
    const off = await build({ enabled: false }).service.getCart('u1');
    const { service, b2b, tax } = build({
      enabled: true,
      buyerType: 'COMPANY',
    });
    const cart = await service.getCart('u1', undefined, undefined, 'company');
    expect(b2b.resolveBuyerType).toHaveBeenCalledWith('s1', 'COMPANY');
    expect(cart.b2b).toEqual({
      display_mode: 'excl',
      net_items: 200,
      net_shipping: 0,
      net_total: 200,
    });
    expect(cart.items[0]).toMatchObject({ tax_rate_bp: 2500, price: 125 });
    const { b2b: _b, items, ...rest } = cart;
    void _b;
    const { items: offItems, ...offRest } = off;
    expect(rest).toEqual(offRest);
    expect(
      (items as unknown as Record<string, unknown>[]).map(
        ({ tax_rate_bp: _r, ...i }) => i,
      ),
    ).toEqual(offItems);
    const ctx = (
      tax.computeTaxes.mock.calls.at(-1) as [{ ctx: { buyerType?: string } }]
    )[0].ctx;
    expect(ctx.buyerType).toBe('COMPANY');
  });

  it('app on without ?buyer: person view, b2b block in incl mode', async () => {
    const { service, b2b } = build({ enabled: true });
    const cart = await service.getCart('u1');
    expect(b2b.resolveBuyerType).toHaveBeenCalledWith('s1', null);
    expect(cart.b2b?.display_mode).toBe('incl');
    expect(cart.items[0]).toMatchObject({ tax_rate_bp: 2500 });
  });
});

// Markets app: a product switched off in the request's market cannot be
// added (CART_ITEM_NOT_AVAILABLE_IN_MARKET) and an existing line for it is
// flagged `unavailable_in_market` and left out of the totals. Without a
// market the response carries no such key.
const eu: MarketContext = {
  id: 'm-eu',
  key: 'eu',
  name: 'EU',
  countries: ['DE'],
  defaultLocale: 'en',
  locales: [],
  currency: 'EUR',
  storeCurrency: 'SEK',
  rate: 0.1,
  priceRule: { mode: 'convert', rounding: { increment: 0, ending: 'none' } },
  isDefault: false,
  status: 'LIVE',
  primaryHostname: null,
  hostnames: [],
};
const hiddenRow = {
  product_id: 'p1',
  market_id: 'm-eu',
  variant_id: null,
  price: null,
  compare_at_price: null,
  available: false,
};

describe('CartService with the markets app', () => {
  it('add of a product hidden in the market -> 400 CART_ITEM_NOT_AVAILABLE_IN_MARKET', async () => {
    const { service, prisma } = build({
      enabled: false,
      market: eu,
      priceRows: [hiddenRow],
    });
    await expect(
      service.addItem('u1', { product_id: 'p1', quantity: 1 }, 'en', 'eu'),
    ).rejects.toMatchObject({
      response: {
        code: 'CART_ITEM_NOT_AVAILABLE_IN_MARKET',
        message: 'Tee is not available in this market.',
      },
    });
    expect(prisma.cartItem.create).not.toHaveBeenCalled();
  });

  it('update of a line hidden in the market -> 400', async () => {
    const { service, prisma } = build({
      enabled: false,
      market: eu,
      priceRows: [hiddenRow],
    });
    await expect(
      service.updateItem('u1', 'i1', { quantity: 3 }, 'en', 'eu'),
    ).rejects.toMatchObject({
      response: { code: 'CART_ITEM_NOT_AVAILABLE_IN_MARKET' },
    });
    expect(prisma.cartItem.update).not.toHaveBeenCalled();
  });

  it('add of a product visible in the market is accepted and priced there', async () => {
    const { service, prisma } = build({ enabled: false, market: eu });
    const cart = await service.addItem(
      'u1',
      { product_id: 'p1', quantity: 1 },
      'en',
      'eu',
    );
    expect(prisma.cartItem.create).toHaveBeenCalled();
    expect(cart.items[0]).toMatchObject({ price: 12.5, currency: 'EUR' });
    expect('unavailable_in_market' in cart.items[0]).toBe(false);
    expect(cart.total_with_tax).toBe(25);
  });

  it('getCart flags a hidden line and leaves it out of the totals', async () => {
    const { service, tax } = build({
      enabled: false,
      market: eu,
      priceRows: [hiddenRow],
    });
    const cart = await service.getCart('u1', 'en', 'eu');
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]).toMatchObject({ unavailable_in_market: true });
    expect(cart.total_with_tax).toBe(0);
    const lines = (
      tax.computeTaxes.mock.calls.at(-1) as [{ lines: { amount: number }[] }]
    )[0].lines;
    expect(lines.map((l) => l.amount)).toEqual([0]);
  });

  it('app off / no market: add and getCart unchanged, no new key', async () => {
    const { service, prisma } = build({ enabled: false });
    const cart = await service.addItem('u1', { product_id: 'p1', quantity: 1 });
    expect(prisma.cartItem.create).toHaveBeenCalled();
    expect(prisma.productMarketPrice.findMany).not.toHaveBeenCalled();
    expect('unavailable_in_market' in cart.items[0]).toBe(false);
    expect(cart).toMatchObject({ total_with_tax: 250 });
    expect(cart.items[0]).toMatchObject({ price: 125, currency: 'EUR' });
  });
});
