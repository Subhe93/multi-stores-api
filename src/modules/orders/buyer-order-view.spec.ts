import { UserRole } from '@prisma/client';
import { forBuyer } from './buyer-order-view';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { personalizationCoreArgs } from '../personalization/__fixtures__/personalization-service.factory';
import { PromotionsService } from '../promotions/promotions.service';
import { ShippingService } from '../shipping/shipping.service';
import { MailService } from '../mail/mail.service';
import { TaxService } from '../taxes/tax.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { B2bService } from '../b2b/b2b.service';
import { buildOrderCreate } from './__fixtures__/order-create.harness';

// Supplier privacy: any visitor can become a customer through checkout, so
// the buyer's order payloads (create result, GET /orders/my, GET /orders/:id
// as CUSTOMER) carry no provider amounts, no commission and none of the
// supplier's catalogue internals (cost price, stock, SKUs, owner ids).
// Providers, creators and admins keep their views.

const fullProduct = (id: string) => ({
  id,
  provider_id: 'prov1',
  creator_id: null,
  base_price: 45,
  cost_price: 12,
  stock_quantity: 40,
  track_inventory: true,
  sku: 'NEWROJ-HOODIE',
  external_ref: 'woo:1',
  variant_option_config: null,
  translations: [{ locale: 'sv', title: 'Hoodie', slug: 'hoodie' }],
  images: [{ url: '/uploads/hoodie.webp', sort_order: 0 }],
});

/** One custom (imported) variant line and one own product line. */
function orderRow() {
  return {
    id: 'o1',
    order_number: 'MS-1',
    status: 'PENDING',
    total: 299,
    currency: 'SEK',
    customer_id: 'cust1',
    customer: { user_id: 'u-buyer', user: { email: 'b@x', status: 'ACTIVE' } },
    store_id: 's1',
    deleted_at: null,
    deleted_by: null,
    vat_validation: null,
    commission: {
      platform_amount: 30,
      provider_amount: 90,
      creator_amount: 100,
    },
    payouts: [{ id: 'po1', recipient_id: 'prov1', amount: 90 }],
    timeline: [],
    address: { id: 'a1' },
    market: null,
    items: [
      {
        id: 'i1',
        product_id: null,
        variant_id: 'v1',
        custom_product_id: 'cp1',
        quantity: 2,
        unit_price: 150,
        original_unit_price: null,
        total_price: 300,
        provider_base_amount: 90,
        fulfiller_id: 'prov1',
        fulfiller_type: 'PROVIDER',
        variant_options_snapshot: { size: 'M' },
        requires_shipping: true,
        tax_rate_bp: 2500,
        tax_amount: 60,
        custom_field_values: [],
        bundle_offer: null,
        product: null,
        variant: {
          id: 'v1',
          sku: 'NEWROJ-HOODIE-M',
          price_adjustment: 5,
          stock_quantity: 4,
          external_ref: 'woo:v1',
          options: { size: 'M' },
          images: [],
          product: fullProduct('base1'),
        },
        custom_product: {
          id: 'cp1',
          creator_id: 'c1',
          final_price: 150,
          margin_amount: null,
          translations: [{ locale: 'sv', title: 'Hoodie by C1', slug: 'h' }],
          mockup_images: [{ url: '/uploads/mockup.webp', sort_order: 0 }],
          product: fullProduct('base1'),
        },
      },
      {
        id: 'i2',
        product_id: 'own1',
        variant_id: null,
        custom_product_id: null,
        quantity: 1,
        unit_price: 49,
        total_price: 49,
        provider_base_amount: 0,
        fulfiller_id: 'c1',
        fulfiller_type: 'CREATOR',
        custom_field_values: [],
        bundle_offer: null,
        product: {
          ...fullProduct('own1'),
          provider_id: null,
          creator_id: 'c1',
        },
        variant: null,
        custom_product: null,
      },
    ],
  };
}

/** Keys that must never reach a buyer, anywhere in the payload. */
const BUYER_BLOCKLIST = [
  'provider_base_amount',
  'commission',
  'payouts',
  'base_price',
  'cost_price',
  'stock_quantity',
  'track_inventory',
  'price_adjustment',
  'external_ref',
  'provider_id',
  'NEWROJ-HOODIE',
];

function expectBuyerSafe(view: unknown) {
  const json = JSON.stringify(view);
  for (const key of BUYER_BLOCKLIST) expect(json).not.toContain(key);
}

describe('forBuyer', () => {
  it('removes the commission, payouts, provider amounts and catalogue internals', () => {
    const view = forBuyer(orderRow()) as unknown as ReturnType<typeof orderRow>;
    expectBuyerSafe(view);
    expect(view).not.toHaveProperty('commission');
    expect(view).not.toHaveProperty('payouts');
    expect(view.items[0]).not.toHaveProperty('provider_base_amount');
  });

  it('keeps every key the storefront and analytics read (receipt, order page, trackEvents)', () => {
    const view = forBuyer(orderRow()) as unknown as Record<string, unknown> & {
      items: Record<string, unknown>[];
    };
    expect(view).toMatchObject({
      id: 'o1',
      order_number: 'MS-1',
      total: 299,
      currency: 'SEK',
      timeline: [],
      address: { id: 'a1' },
    });
    expect(view.items[0]).toEqual({
      id: 'i1',
      product_id: null,
      variant_id: 'v1',
      custom_product_id: 'cp1',
      quantity: 2,
      unit_price: 150,
      original_unit_price: null,
      total_price: 300,
      fulfiller_id: 'prov1',
      fulfiller_type: 'PROVIDER',
      variant_options_snapshot: { size: 'M' },
      requires_shipping: true,
      tax_rate_bp: 2500,
      tax_amount: 60,
      custom_field_values: [],
      bundle_offer: null,
      product: null,
      variant: {
        id: 'v1',
        options: { size: 'M' },
        images: [],
        product: {
          id: 'base1',
          translations: [{ locale: 'sv', title: 'Hoodie', slug: 'hoodie' }],
          images: [{ url: '/uploads/hoodie.webp', sort_order: 0 }],
        },
      },
      custom_product: {
        id: 'cp1',
        translations: [{ locale: 'sv', title: 'Hoodie by C1', slug: 'h' }],
        mockup_images: [{ url: '/uploads/mockup.webp', sort_order: 0 }],
        product: {
          id: 'base1',
          translations: [{ locale: 'sv', title: 'Hoodie', slug: 'hoodie' }],
          images: [{ url: '/uploads/hoodie.webp', sort_order: 0 }],
        },
      },
    });
    expect(view.items[1]).toMatchObject({
      product_id: 'own1',
      variant: null,
      custom_product: null,
      product: {
        id: 'own1',
        translations: [{ locale: 'sv', title: 'Hoodie', slug: 'hoodie' }],
        images: [{ url: '/uploads/hoodie.webp', sort_order: 0 }],
      },
    });
  });

  it('a line without relations (create result) only loses provider_base_amount', () => {
    const view = forBuyer({
      id: 'o1',
      items: [
        { id: 'i1', product_id: 'p1', provider_base_amount: 9, unit_price: 20 },
      ],
    });
    expect(view).toEqual({
      id: 'o1',
      items: [{ id: 'i1', product_id: 'p1', unit_price: 20 }],
    });
  });

  it('null and non-object input pass through', () => {
    expect(forBuyer(null)).toBeNull();
    expect(forBuyer(undefined)).toBeUndefined();
  });
});

// ── OrdersService read paths ─────────────────────────────────────────────

function buildReads() {
  const prisma = {
    order: {
      findUnique: jest.fn(() => Promise.resolve(orderRow())),
      findMany: jest.fn(() => Promise.resolve([orderRow()])),
      count: jest.fn(() => Promise.resolve(1)),
    },
    customer: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'cust1', user: { store_id: 's1' } }),
      ),
    },
    provider: {
      findUnique: jest.fn(() => Promise.resolve({ id: 'prov1' })),
    },
    creator: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'c1', store: { id: 's1' } }),
      ),
    },
  };
  const service = new OrdersService(
    prisma as unknown as PrismaService,
    {} as PromotionsService,
    {} as ShippingService,
    {} as MailService,
    {} as TaxService,
    {} as MarketsContextService,
    {} as MarketPricingService,
    {} as ConfigService,
    {} as B2bService,
    ...personalizationCoreArgs(prisma),
  );
  return { service, prisma };
}

describe('buyer order payloads (OrdersService)', () => {
  it('GET /orders/my (findByCustomer): buyer-safe rows', async () => {
    const { service } = buildReads();
    const res = await service.findByCustomer('u-buyer');
    expect(res.data).toHaveLength(1);
    expectBuyerSafe(res);
    expect(res.data[0]).toMatchObject({
      id: 'o1',
      items: [
        {
          custom_product: { mockup_images: [{ url: '/uploads/mockup.webp' }] },
        },
        { product: { id: 'own1' } },
      ],
    });
  });

  it('GET /orders/:id as the buying CUSTOMER: buyer-safe', async () => {
    const { service } = buildReads();
    const res = await service.findById('o1', 'u-buyer', UserRole.CUSTOMER);
    expectBuyerSafe(res);
    expect(res).toMatchObject({ id: 'o1', total: 299 });
  });

  it('GET /orders/:id as PROVIDER keeps the provider amounts and the commission', async () => {
    const { service } = buildReads();
    const res = (await service.findById(
      'o1',
      'u-prov',
      UserRole.PROVIDER,
    )) as unknown as ReturnType<typeof orderRow>;
    expect(res.commission).toMatchObject({ provider_amount: 90 });
    expect(res.items[0]).toHaveProperty('provider_base_amount', 90);
  });

  it('GET /orders/:id as the store CREATOR keeps the provider amounts and the commission', async () => {
    const { service } = buildReads();
    const res = (await service.findById(
      'o1',
      'u-creator',
      UserRole.CREATOR,
    )) as unknown as ReturnType<typeof orderRow>;
    expect(res.commission).toMatchObject({ creator_amount: 100 });
    expect(res.items[0]).toHaveProperty('provider_base_amount', 90);
  });

  it('POST /orders result: no provider_base_amount on any line', async () => {
    const h = buildOrderCreate({
      products: {
        base1: {
          creator_id: null,
          provider_id: 'prov1',
          base_price: 45,
          track_inventory: true,
          stock_quantity: 40,
        },
        own1: {
          creator_id: 'c1',
          provider_id: null,
          base_price: 49,
          track_inventory: false,
          stock_quantity: null,
        },
      },
      customProducts: { cp1: { product_id: 'base1', final_price: 150 } },
    });
    const created = (await h.place([
      {
        product_id: null,
        variant_id: null,
        custom_product_id: 'cp1',
        quantity: 2,
      },
      { product_id: 'own1', variant_id: null, quantity: 1 },
    ])) as unknown as { items: Record<string, unknown>[] };
    // The row written still records what the provider is owed.
    const written = h.prisma.order.create.mock.calls[0][0].data.items
      .create as Record<string, unknown>[];
    expect(written[0].provider_base_amount).toBe(90);
    // The buyer's response does not.
    expect(created.items).toHaveLength(2);
    expect(JSON.stringify(created)).not.toContain('provider_base_amount');
    expect(created.items[0]).toMatchObject({
      custom_product_id: 'cp1',
      quantity: 2,
      unit_price: 150,
      total_price: 300,
    });
  });
});
