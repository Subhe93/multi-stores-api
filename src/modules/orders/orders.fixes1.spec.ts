import { ConfigService } from '@nestjs/config';
import { PaymentMethod, StoreType } from '@prisma/client';
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
import {
  unavailableEntry,
  unavailableOrderItems,
} from './cart-items-availability';

// FIXES-1 (2026-11-08): items 4 (owner pre-live checkout) and 5 (deleted /
// unavailable products answer 409 CART_ITEMS_UNAVAILABLE), exercised through
// quoteLines() with a hand-rolled Prisma mock and a no-tax engine.

const STORE_ID = 's1';
const CREATOR_ID = 'c1';

type Row = Record<string, unknown>;

function build(
  opts: {
    status?: string;
    keys?: { status: string; livemode: boolean } | null;
    products?: Record<string, Row | null>;
  } = {},
) {
  const status = opts.status ?? 'LIVE';
  const base = {
    creator_id: CREATOR_ID,
    provider_id: null,
    status: 'PUBLISHED',
    base_price: 100,
    tax_class_id: null,
    tax_exempt: false,
    track_inventory: false,
    stock_quantity: null,
  };
  const products: Record<string, Row | null> = {
    p1: { id: 'p1', ...base },
    ...opts.products,
  };
  const prisma = {
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: STORE_ID,
          slug: 'shop',
          store_type: StoreType.INDEPENDENT,
          creator_id: CREATOR_ID,
          currency: 'SEK',
          cod_enabled: true,
          is_active: status === 'LIVE',
          status,
          language_config: { primary_locale: 'en' },
          creator: {
            kustom_enabled: false,
            kustom_merchant_id: null,
            kustom_shared_secret: null,
          },
        }),
      ),
    },
    storeStripeKeys: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          opts.keys === undefined
            ? { status: 'ACTIVE', livemode: false }
            : opts.keys,
        ),
      ),
    },
    product: {
      findUnique: jest.fn((args: { where: { id: string } }) =>
        Promise.resolve(products[args.where.id] ?? null),
      ),
    },
    productCustomField: { findMany: jest.fn(() => Promise.resolve([])) },
    productVariant: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    customProduct: { findUnique: jest.fn(() => Promise.resolve(null)) },
    productMarketPrice: { findMany: jest.fn(() => Promise.resolve([])) },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'SEK' })),
    },
  };
  const markets = { resolve: jest.fn(() => Promise.resolve(null)) };
  const shipping = {
    quoteForItems: jest.fn(() =>
      Promise.resolve({
        available: true,
        methods: [
          {
            id: 'std',
            name: 'Standard',
            type: 'STANDARD',
            cost: 0,
            estimated_days: { min: 1, max: 2 },
            free_shipping: false,
          },
        ],
      }),
    ),
  };
  const tax = {
    contextFor: jest.fn(() => Promise.resolve({})),
    loadTaxData: jest.fn(() => Promise.resolve({})),
    computeTaxes: jest.fn(
      (input: {
        lines: { amount: number }[];
        shipping_cost: number;
        discount_amount: number;
        currency: string;
      }) => ({
        items: input.lines.map(() => ({
          tax_rate_bp: 0,
          tax_amount: 0,
          tax_class_key: null,
        })),
        headline_rate_bp: 0,
        tax_total: 0,
        tax_lines: [],
        tax_pricing_mode: 'INCLUSIVE',
        tax_basis_country: null,
        shipping_tax_amount: 0,
        shipping_tax_rate_bp: 0,
        total:
          input.lines.reduce((s, l) => s + l.amount, 0) +
          input.shipping_cost -
          input.discount_amount,
        currency: input.currency,
      }),
    ),
  };
  const b2b = {
    isEnabled: jest.fn(() => Promise.resolve(false)),
    resolveBuyerType: jest.fn(() => Promise.resolve('PERSON' as const)),
  };
  const service = new OrdersService(
    prisma as unknown as PrismaService,
    {} as PromotionsService,
    shipping as unknown as ShippingService,
    {} as MailService,
    tax as unknown as TaxService,
    markets as unknown as MarketsContextService,
    new MarketPricingService(prisma as unknown as PrismaService),
    { get: () => undefined } as unknown as ConfigService,
    b2b as unknown as B2bService,
    ...personalizationCoreArgs(prisma),
  );
  return { service, prisma };
}

type LoadOrderStore = (
  storeId: string,
  marketKey?: string | null,
  buyerType?: string | null,
  preview?: boolean,
  preLive?: {
    viewer?: (s: { id: string; status: string }) => Promise<boolean>;
    paymentMethod?: PaymentMethod;
  },
) => Promise<{ preLiveTest: boolean }>;

const loadOrderStore = (service: OrdersService): LoadOrderStore =>
  (service as unknown as { loadOrderStore: LoadOrderStore }).loadOrderStore.bind(
    service,
  );

const line = (product_id: string, id?: string) => ({
  ...(id ? { id } : {}),
  product_id,
  variant_id: null,
  quantity: 1,
});

describe('FIXES-1 item 5 — CART_ITEMS_UNAVAILABLE', () => {
  it('a quote names every deleted / archived / foreign line in one 409', async () => {
    const { service } = build({
      products: {
        'p-archived': {
          id: 'p-archived',
          creator_id: CREATOR_ID,
          status: 'ARCHIVED',
          base_price: 1,
        },
        'p-foreign': {
          id: 'p-foreign',
          creator_id: 'someone-else',
          status: 'PUBLISHED',
          base_price: 1,
        },
      },
    });
    const err = await service
      .quoteLines(
        STORE_ID,
        [line('p1'), line('p-gone'), line('p-archived'), line('p-foreign')],
        { countryCode: 'SE', lineIds: [undefined, 'row-2'] },
      )
      .catch((e: unknown) => e);
    expect((err as { getStatus(): number }).getStatus()).toBe(409);
    expect((err as { getResponse(): unknown }).getResponse()).toEqual({
      code: 'CART_ITEMS_UNAVAILABLE',
      message: expect.any(String),
      unavailable: [
        { product_id: 'p-gone', line_id: 'row-2' },
        { product_id: 'p-archived' },
        { product_id: 'p-foreign' },
      ],
    });
  });

  it('is answered without a destination (load-time availability check)', async () => {
    const { service } = build();
    await expect(
      service.quoteLines(STORE_ID, [line('p-gone')], { countryCode: null }),
    ).rejects.toMatchObject({
      response: {
        code: 'CART_ITEMS_UNAVAILABLE',
        unavailable: [{ product_id: 'p-gone' }],
      },
    });
  });

  it('a logged-in quote without lines checks the server cart rows', async () => {
    const { service, prisma } = build();
    (prisma as unknown as { customer: unknown }).customer = {
      findUnique: jest.fn(() =>
        Promise.resolve({
          user: { role: 'CUSTOMER', store_id: STORE_ID },
          cart: { items: [line('p-gone', 'cart-row-1')] },
        }),
      ),
    };
    await expect(
      service.quote('u1', { store_id: STORE_ID }),
    ).rejects.toMatchObject({
      response: {
        code: 'CART_ITEMS_UNAVAILABLE',
        unavailable: [{ product_id: 'p-gone', line_id: 'cart-row-1' }],
      },
    });
  });

  it('available lines still quote normally', async () => {
    const { service } = build();
    const quote = await service.quoteLines(STORE_ID, [line('p1')], {
      countryCode: 'SE',
    });
    expect(quote.total).toBe(100);
  });

  it('order items: deleted (FKs nulled) / archived / disabled variant are unavailable', () => {
    expect(
      unavailableOrderItems([
        { product_id: 'p1', variant_id: null, custom_product_id: null, product: { status: 'PUBLISHED' } },
        { product_id: null, variant_id: null, custom_product_id: null },
        { product_id: 'p2', variant_id: null, custom_product_id: null, product: { status: 'DRAFT' } },
        { product_id: 'p3', variant_id: 'v3', custom_product_id: null, product: { status: 'PUBLISHED' }, variant: { is_active: false } },
        { product_id: null, variant_id: null, custom_product_id: 'cp1', custom_product: { status: 'ARCHIVED' } },
        // Relations / ids not loaded (undefined) are never judged.
        {},
      ]),
    ).toEqual([
      {},
      { product_id: 'p2' },
      { product_id: 'p3', variant_id: 'v3' },
      { custom_product_id: 'cp1' },
    ]);
    expect(unavailableEntry({ id: 'r1', variant_id: 'v1' })).toEqual({
      variant_id: 'v1',
      line_id: 'r1',
    });
  });
});

describe('FIXES-1 item 4 — owner pre-live checkout', () => {
  const owner = () => jest.fn(() => Promise.resolve(true));

  it('a LIVE store is never a pre-live test order', async () => {
    const { service } = build();
    const viewer = owner();
    const ctx = await loadOrderStore(service)(STORE_ID, null, null, undefined, {
      viewer,
      paymentMethod: PaymentMethod.STRIPE,
    });
    expect(ctx.preLiveTest).toBe(false);
    expect(viewer).not.toHaveBeenCalled();
  });

  it('public visitors keep 409 STORE_NOT_LIVE on a non-LIVE store', async () => {
    const { service } = build({ status: 'DRAFT' });
    await expect(
      service.quoteLines(STORE_ID, [line('p1')], { countryCode: 'SE' }),
    ).rejects.toMatchObject({ response: { code: 'STORE_NOT_LIVE' } });
  });

  it('the owner viewer quotes a non-LIVE store with an ACTIVE TEST own key', async () => {
    const { service } = build({ status: 'DRAFT' });
    const viewer = owner();
    const quote = await service.quoteLines(STORE_ID, [line('p1')], {
      countryCode: 'SE',
      preLiveViewer: viewer,
    });
    expect(quote.total).toBe(100);
    expect(viewer).toHaveBeenCalledWith({ id: STORE_ID, status: 'DRAFT' });
  });

  it('order creation: STRIPE on the TEST key is a test order; COD / Kustom are refused', async () => {
    const { service } = build({ status: 'PENDING_REVIEW' });
    const load = loadOrderStore(service);
    const stripe = await load(STORE_ID, null, null, undefined, {
      viewer: owner(),
      paymentMethod: PaymentMethod.STRIPE,
    });
    expect(stripe.preLiveTest).toBe(true);
    for (const paymentMethod of [PaymentMethod.COD, PaymentMethod.KUSTOM]) {
      await expect(
        load(STORE_ID, null, null, undefined, { viewer: owner(), paymentMethod }),
      ).rejects.toMatchObject({ response: { code: 'STORE_NOT_LIVE' } });
    }
  });

  it('a live own key, no key, or a non-owner viewer stay refused', async () => {
    for (const keys of [
      { status: 'ACTIVE', livemode: true },
      { status: 'NEEDS_RECONNECT', livemode: false },
      null,
    ]) {
      const { service } = build({ status: 'DRAFT', keys });
      await expect(
        service.quoteLines(STORE_ID, [line('p1')], {
          countryCode: 'SE',
          preLiveViewer: owner(),
        }),
      ).rejects.toMatchObject({ response: { code: 'STORE_NOT_LIVE' } });
    }
    const { service } = build({ status: 'DRAFT' });
    await expect(
      service.quoteLines(STORE_ID, [line('p1')], {
        countryCode: 'SE',
        preLiveViewer: jest.fn(() => Promise.resolve(false)),
      }),
    ).rejects.toMatchObject({ response: { code: 'STORE_NOT_LIVE' } });
  });
});
