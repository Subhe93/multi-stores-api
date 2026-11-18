import { UserRole } from '@prisma/client';
import { forProvider } from './provider-order-view';
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

// Supplier privacy between providers: a marketplace order can mix lines of
// several providers. A provider reading such an order (its order list, the
// fulfiller list, the order detail) keeps its own lines in full, but never
// learns another provider's cost price, stock, SKU or amount, neither from
// the other lines nor from the commission split.

const product = (id: string, providerId: string, sku: string) => ({
  id,
  provider_id: providerId,
  creator_id: null,
  base_price: 45,
  cost_price: 12,
  stock_quantity: 40,
  track_inventory: true,
  sku,
  external_ref: `woo:${id}`,
  variant_option_config: null,
  translations: [{ locale: 'sv', title: `Title ${id}`, slug: id }],
  images: [{ url: `/uploads/${id}.webp`, sort_order: 0 }],
});

/**
 * NEWROJ (prov-newroj) and a competitor (prov-x) each fulfil one imported
 * line of the same order; the store creator fulfils an own line.
 */
function sharedOrder() {
  return {
    id: 'o1',
    order_number: 'MS-1',
    status: 'PENDING',
    total: 409,
    currency: 'SEK',
    customer_id: 'cust1',
    customer: { user_id: 'u-buyer', user: { email: 'b@x', status: 'ACTIVE' } },
    store_id: 's1',
    deleted_at: null,
    deleted_by: null,
    vat_validation: null,
    commission: {
      id: 'com1',
      platform_amount: 30,
      provider_amount: 130,
      creator_amount: 100,
      vat_amount: 80,
    },
    payouts: [
      { id: 'po1', recipient_id: 'prov-newroj', amount: 90 },
      { id: 'po2', recipient_id: 'prov-x', amount: 40 },
    ],
    timeline: [],
    address: { id: 'a1' },
    market: null,
    items: [
      {
        id: 'i-newroj',
        product_id: null,
        variant_id: 'v-newroj',
        custom_product_id: 'cp-newroj',
        quantity: 2,
        unit_price: 150,
        total_price: 300,
        provider_base_amount: 90,
        fulfiller_id: 'prov-newroj',
        fulfiller_type: 'PROVIDER',
        custom_field_values: [],
        bundle_offer: null,
        product: null,
        variant: {
          id: 'v-newroj',
          sku: 'NEWROJ-HOODIE-M',
          price_adjustment: 5,
          stock_quantity: 4,
          options: { size: 'M' },
          images: [],
          product: product('base-newroj', 'prov-newroj', 'NEWROJ-HOODIE'),
        },
        custom_product: {
          id: 'cp-newroj',
          creator_id: 'c1',
          final_price: 150,
          translations: [{ locale: 'sv', title: 'Hoodie', slug: 'h' }],
          mockup_images: [{ url: '/uploads/mockup.webp', sort_order: 0 }],
          product: product('base-newroj', 'prov-newroj', 'NEWROJ-HOODIE'),
        },
      },
      {
        id: 'i-x',
        product_id: null,
        variant_id: null,
        custom_product_id: 'cp-x',
        quantity: 1,
        unit_price: 60,
        total_price: 60,
        provider_base_amount: 40,
        fulfiller_id: 'prov-x',
        fulfiller_type: 'PROVIDER',
        custom_field_values: [],
        bundle_offer: null,
        product: null,
        variant: null,
        custom_product: {
          id: 'cp-x',
          creator_id: 'c1',
          final_price: 60,
          translations: [{ locale: 'sv', title: 'Mug', slug: 'm' }],
          mockup_images: [],
          product: product('base-x', 'prov-x', 'X-MUG'),
        },
      },
      {
        id: 'i-own',
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
        product: { ...product('own1', 'none', 'OWN-1'), provider_id: null },
        variant: null,
        custom_product: null,
      },
    ],
  };
}

type View = ReturnType<typeof sharedOrder>;

/** Nothing of NEWROJ's line may reach the competitor prov-x. */
function expectNoNewrojInternals(view: unknown) {
  const json = JSON.stringify(view);
  for (const needle of [
    'NEWROJ-HOODIE',
    'woo:base-newroj',
    '"provider_base_amount":90',
  ]) {
    expect(json).not.toContain(needle);
  }
  const line = (view as View).items.find((i) => i.id === 'i-newroj');
  const lineJson = JSON.stringify(line);
  for (const key of [
    'provider_base_amount',
    'base_price',
    'cost_price',
    'stock_quantity',
    'track_inventory',
    'price_adjustment',
    'sku',
  ]) {
    expect(lineJson).not.toContain(key);
  }
}

describe('forProvider', () => {
  it('keeps its own lines in full and shapes the other fulfillers lines like a receipt', () => {
    const view = forProvider(sharedOrder(), 'prov-x', 40);
    expectNoNewrojInternals(view);
    const own = view.items.find((i) => i.id === 'i-x');
    expect(own).toEqual(sharedOrder().items[1]);
    const foreign = view.items.find((i) => i.id === 'i-newroj');
    // What the dashboard shows of a foreign line stays.
    expect(foreign).toMatchObject({
      quantity: 2,
      unit_price: 150,
      total_price: 300,
      fulfiller_id: 'prov-newroj',
      fulfiller_type: 'PROVIDER',
      variant: { options: { size: 'M' } },
      custom_product: {
        translations: [{ title: 'Hoodie' }],
        mockup_images: [{ url: '/uploads/mockup.webp' }],
      },
    });
    // The creator's own line is not the provider's either.
    const creatorLine = view.items.find((i) => i.id === 'i-own');
    expect(JSON.stringify(creatorLine)).not.toContain('cost_price');
    expect(creatorLine).not.toHaveProperty('provider_base_amount');
  });

  it('shared order: provider_amount is its own share, platform and creator amounts are hidden', () => {
    const view = forProvider(sharedOrder(), 'prov-x', 40);
    expect(view.commission).toEqual({
      id: 'com1',
      platform_amount: null,
      provider_amount: 40,
      creator_amount: null,
      vat_amount: 80,
    });
  });

  it('single-provider order: the commission keeps its platform and creator amounts', () => {
    const order = sharedOrder();
    order.items = order.items.filter((i) => i.id !== 'i-newroj');
    order.commission.provider_amount = 40;
    const view = forProvider(order, 'prov-x', 40);
    expect(view.commission).toEqual({
      id: 'com1',
      platform_amount: 30,
      provider_amount: 40,
      creator_amount: 100,
      vat_amount: 80,
    });
  });

  it('no provider id: no own line and no commission', () => {
    const view = forProvider(sharedOrder(), null, null);
    expect(view.commission).toBeNull();
    expect(JSON.stringify(view)).not.toContain('provider_base_amount');
  });

  it('null commission and non-object input pass through', () => {
    const order = { ...sharedOrder(), commission: null };
    expect(forProvider(order, 'prov-x', null).commission).toBeNull();
    expect(forProvider(null, 'prov-x', 1)).toBeNull();
  });
});

// ── OrdersService read paths ─────────────────────────────────────────────

function buildReads() {
  const prisma = {
    order: {
      findUnique: jest.fn(() => Promise.resolve(sharedOrder())),
      findMany: jest.fn(() => Promise.resolve([sharedOrder()])),
      count: jest.fn(() => Promise.resolve(1)),
    },
    provider: {
      findUnique: jest.fn(() => Promise.resolve({ id: 'prov-x' })),
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

describe('provider order payloads (OrdersService)', () => {
  it('GET /orders/:id as the competing PROVIDER: no foreign line internals, own share only', async () => {
    const { service } = buildReads();
    const res = (await service.findById(
      'o1',
      'u-prov-x',
      UserRole.PROVIDER,
    )) as unknown as View & { my_share: number };
    expectNoNewrojInternals(res);
    expect(res.my_share).toBe(40);
    expect(res.commission).toMatchObject({
      provider_amount: 40,
      platform_amount: null,
      creator_amount: null,
    });
    // Its own line keeps what it fulfils by.
    expect(res.items.find((i) => i.id === 'i-x')).toHaveProperty(
      'provider_base_amount',
      40,
    );
    // Payouts were already scoped to the provider.
    expect(JSON.stringify(res.payouts)).not.toContain('po1');
  });

  it('GET /orders as PROVIDER (findByProvider): the same view on every row', async () => {
    const { service } = buildReads();
    const res = await service.findByRole('u-prov-x', UserRole.PROVIDER);
    expect(res.data).toHaveLength(1);
    expectNoNewrojInternals(res.data[0]);
    expect((res.data[0] as unknown as View).commission).toMatchObject({
      provider_amount: 40,
      platform_amount: null,
      creator_amount: null,
    });
  });

  it('GET /orders/fulfiller/:id as PROVIDER: the same view on every row', async () => {
    const { service } = buildReads();
    const res = await service.findByFulfiller(
      'prov-x',
      'u-prov-x',
      UserRole.PROVIDER,
    );
    expect(res.data).toHaveLength(1);
    expectNoNewrojInternals(res.data[0]);
  });

  it('the store CREATOR and ADMIN keep the whole order', async () => {
    const { service } = buildReads();
    const asCreator = (await service.findById(
      'o1',
      'u-creator',
      UserRole.CREATOR,
    )) as unknown as View;
    expect(asCreator.commission).toMatchObject({
      provider_amount: 130,
      platform_amount: 30,
      creator_amount: 100,
    });
    expect(asCreator.items[0]).toHaveProperty('provider_base_amount', 90);
    const asAdmin = (await service.findById(
      'o1',
      'u-admin',
      UserRole.ADMIN,
    )) as unknown as View;
    expect(asAdmin.items[1]).toHaveProperty('provider_base_amount', 40);
  });

  it('order reads never load cost_price or external_ref of nested products', async () => {
    const { service, prisma } = buildReads();
    await service.findById('o1', 'u-creator', UserRole.CREATOR);
    const include = (
      prisma.order.findUnique.mock.calls[0] as unknown as [
        { include: { items: { include: Record<string, unknown> } } },
      ]
    )[0].include.items.include as Record<
      string,
      { omit?: Record<string, boolean>; include?: Record<string, unknown> }
    >;
    const productOmit = { cost_price: true, external_ref: true };
    expect(include.product.omit).toEqual(productOmit);
    expect(include.variant.omit).toEqual({ external_ref: true });
    expect(
      (include.variant.include as { product: { omit: unknown } }).product.omit,
    ).toEqual(productOmit);
    expect(
      (include.custom_product.include as { product: { omit: unknown } }).product
        .omit,
    ).toEqual(productOmit);
  });
});
