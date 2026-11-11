import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { OrderStatus, StoreType } from '@prisma/client';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { CreateOrderDto } from './dto/order.dto';
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
import type { MetaConversionsService } from '../meta-capi/meta-conversions.service';
import type { StorefrontGateService } from '../storefront/storefront-gate.service';

// Meta Conversions API call sites in the order flow: the optional `tracking`
// body field is stored on the order with the request IP / user agent, and
// the server-side Purchase is fired (never awaited, never able to fail the
// flow) when an order becomes confirmed: a COD order at creation, any other
// order when markOrderPaid actually flips it.

const STORE_ID = 's1';
const CREATOR_ID = 'c1';

type SendPurchase = jest.Mock<Promise<unknown>, [string]>;

function metaMock(impl?: () => Promise<unknown>): {
  sendPurchase: SendPurchase;
} {
  return {
    sendPurchase: jest.fn<Promise<unknown>, [string]>(
      impl ?? (() => Promise.resolve({ sent: true })),
    ),
  };
}

function buildCreate(meta?: { sendPurchase: SendPurchase }) {
  const product = {
    id: 'p1',
    creator_id: CREATOR_ID,
    provider_id: null,
    status: 'PUBLISHED',
    base_price: 299,
    tax_class_id: null,
    tax_exempt: false,
    track_inventory: false,
    stock_quantity: null,
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
    product: { findUnique: jest.fn(() => Promise.resolve(product)) },
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
    meta as unknown as MetaConversionsService | undefined,
  );
  return { service, prisma, mail };
}

const lines = [{ product_id: 'p1', variant_id: null, quantity: 2 }];

function createData(prisma: ReturnType<typeof buildCreate>['prisma']) {
  return (
    prisma.order.create.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ]
  )[0].data;
}

function buildPaid(meta?: { sendPurchase: SendPurchase }) {
  const prisma = {
    order: {
      findUnique: jest.fn((): Promise<unknown> => Promise.resolve(null)),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    orderTimeline: { create: jest.fn(() => Promise.resolve({})) },
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
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    meta as unknown as MetaConversionsService | undefined,
  );
  return { service, prisma };
}

const unpaidOrder = {
  id: 'o1',
  store_id: STORE_ID,
  status: OrderStatus.PENDING,
  payment_status: 'awaiting_payment',
  payment_method: 'STRIPE',
  deleted_at: null,
  customer: { user_id: 'u1' },
};

describe('order creation: tracking context', () => {
  const context = {
    fbp: 'fb.1.1700000000000.123456789',
    source_url: 'https://shop.example.com/checkout',
    ip: '203.0.113.7',
    user_agent: 'Mozilla/5.0',
  };

  it('stores the context on the order', async () => {
    const { service, prisma } = buildCreate();
    await service.create(
      'u1',
      { address_id: 'a1', store_id: STORE_ID, payment_method: 'STRIPE' },
      { lines, trackingContext: context },
    );
    expect(createData(prisma).tracking_context).toEqual(context);
  });

  it('writes nothing when the request carried no context', async () => {
    const { service, prisma } = buildCreate();
    await service.create(
      'u1',
      { address_id: 'a1', store_id: STORE_ID, payment_method: 'STRIPE' },
      { lines },
    );
    expect('tracking_context' in createData(prisma)).toBe(false);
  });

  it('POST /orders: the controller joins the body field with the request IP and user agent', async () => {
    const create = jest.fn((..._args: unknown[]) => Promise.resolve({}));
    const controller = new OrdersController(
      { create } as unknown as OrdersService,
      { preLiveCheck: () => undefined } as unknown as StorefrontGateService,
    );
    const dto = {
      address_id: 'a1',
      store_id: STORE_ID,
      tracking: {
        fbp: 'fb.1.1700000000000.123456789',
        source_url: 'https://shop.example.com/checkout',
      },
    } as CreateOrderDto;
    await controller.create('u1', dto, {
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    });
    expect(create).toHaveBeenCalledWith('u1', dto, {
      trackingContext: context,
    });

    // Without the body field nothing is kept (not even the IP).
    create.mockClear();
    const bare = { address_id: 'a1', store_id: STORE_ID } as CreateOrderDto;
    await controller.create('u1', bare, {
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    });
    expect(create).toHaveBeenCalledWith('u1', bare, {});
  });
});

describe('CreateOrderDto.tracking', () => {
  // Same options as the global ValidationPipe (main.ts).
  async function errorsFor(body: Record<string, unknown>): Promise<string[]> {
    const errors = await validate(
      plainToInstance(CreateOrderDto, {
        address_id: 'a1',
        store_id: STORE_ID,
        ...body,
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    return errors.map((e) => e.property);
  }

  it('is optional and accepts fbp / fbc / source_url', async () => {
    expect(await errorsFor({})).toEqual([]);
    expect(await errorsFor({ tracking: {} })).toEqual([]);
    expect(await errorsFor({ tracking: null })).toEqual([]);
    expect(
      await errorsFor({
        tracking: {
          fbp: 'fb.1.1700000000000.123456789',
          fbc: 'fb.1.1700000000000.AbCdEf',
          source_url: 'https://shop.example.com/checkout',
        },
      }),
    ).toEqual([]);
    expect(await errorsFor({ tracking: { fbp: 'x'.repeat(500) } })).toEqual([]);
    // A long fbclid-derived cookie is accepted (and dropped later), never a 400.
    expect(await errorsFor({ tracking: { fbc: `fb.1.1700000000000.${'x'.repeat(900)}` } })).toEqual([]);
  });

  it('rejects unknown keys, non-strings and absurdly long values', async () => {
    for (const bad of [
      { tracking: { ip: '1.2.3.4' } },
      { tracking: { fbp: 12 } },
      { tracking: { fbc: 'x'.repeat(4097) } },
      { tracking: { source_url: ['a'] } },
      { tracking: 'fb.1.2.3' },
    ]) {
      expect(await errorsFor(bad)).toEqual(['tracking']);
    }
  });
});

describe('server-side Purchase trigger', () => {
  it('COD order: fired once at creation', async () => {
    const meta = metaMock();
    const { service } = buildCreate(meta);
    await service.create(
      'u1',
      { address_id: 'a1', store_id: STORE_ID, payment_method: 'COD' },
      { lines },
    );
    expect(meta.sendPurchase).toHaveBeenCalledTimes(1);
    expect(meta.sendPurchase).toHaveBeenCalledWith('o1');
  });

  it('online payment: not fired at creation (the order is not confirmed yet)', async () => {
    const meta = metaMock();
    const { service } = buildCreate(meta);
    await service.create(
      'u1',
      { address_id: 'a1', store_id: STORE_ID, payment_method: 'STRIPE' },
      { lines },
    );
    expect(meta.sendPurchase).not.toHaveBeenCalled();
  });

  it('markOrderPaid: fired once when the flip happened', async () => {
    const meta = metaMock();
    const { service, prisma } = buildPaid(meta);
    prisma.order.findUnique.mockResolvedValue(unpaidOrder);
    const res = await service.markOrderPaid('o1', 'pi_1');
    expect(res).toMatchObject({ changed: true });
    expect(meta.sendPurchase).toHaveBeenCalledTimes(1);
    expect(meta.sendPurchase).toHaveBeenCalledWith('o1');
    // After the paid flip and its timeline row were written.
    expect(meta.sendPurchase.mock.invocationCallOrder[0]).toBeGreaterThan(
      prisma.orderTimeline.create.mock.invocationCallOrder[0],
    );
  });

  it('markOrderPaid replay (already paid, or lost the race): not fired', async () => {
    const meta = metaMock();
    const paid = buildPaid(meta);
    paid.prisma.order.findUnique.mockResolvedValue({
      ...unpaidOrder,
      payment_status: 'paid',
    });
    expect(await paid.service.markOrderPaid('o1', 'pi_1')).toMatchObject({
      changed: false,
    });

    const raced = buildPaid(meta);
    raced.prisma.order.findUnique.mockResolvedValue(unpaidOrder);
    raced.prisma.order.updateMany.mockResolvedValue({ count: 0 });
    expect(await raced.service.markOrderPaid('o1', 'pi_1')).toMatchObject({
      changed: false,
    });
    expect(meta.sendPurchase).not.toHaveBeenCalled();
  });

  it('a rejecting or throwing sender never fails the payment flow', async () => {
    const rejecting = metaMock(() => Promise.reject(new Error('meta down')));
    const a = buildPaid(rejecting);
    a.prisma.order.findUnique.mockResolvedValue(unpaidOrder);
    await expect(a.service.markOrderPaid('o1', 'pi_1')).resolves.toMatchObject({
      changed: true,
    });

    const throwing = metaMock(() => {
      throw new Error('sync failure');
    });
    const b = buildPaid(throwing);
    b.prisma.order.findUnique.mockResolvedValue(unpaidOrder);
    await expect(b.service.markOrderPaid('o1', 'pi_1')).resolves.toMatchObject({
      changed: true,
    });
    // Let the swallowed rejection settle: no unhandled rejection.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('is not awaited: the flow returns while the request is still pending', async () => {
    let release: (() => void) | undefined;
    const meta = metaMock(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const { service, prisma } = buildPaid(meta);
    prisma.order.findUnique.mockResolvedValue(unpaidOrder);
    await expect(service.markOrderPaid('o1', 'pi_1')).resolves.toMatchObject({
      changed: true,
    });
    expect(release).toBeDefined();
    release?.();
  });

  it('without the service wired nothing happens', async () => {
    const { service, prisma } = buildPaid();
    prisma.order.findUnique.mockResolvedValue(unpaidOrder);
    await expect(service.markOrderPaid('o1', 'pi_1')).resolves.toMatchObject({
      changed: true,
    });
  });
});
