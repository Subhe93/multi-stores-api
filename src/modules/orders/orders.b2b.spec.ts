import { ConfigService } from '@nestjs/config';
import { StoreType } from '@prisma/client';
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
import type { CreateOrderDto } from './dto/order.dto';

// The b2b hooks of order pricing and creation (D1, D3, D4), exercised through
// quoteLines() / create() with a hand-rolled Prisma mock and a real
// B2bService over a stubbed StoreAppsService. The tax engine is stubbed to
// a fixed result so the assertions are about keys and snapshot columns:
// with the app off nothing in the quote or the insert may change.

const STORE_ID = 's1';
const CREATOR_ID = 'c1';

function makePrisma() {
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
  return {
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
}

function build(opts: { enabled: boolean; settings?: unknown }) {
  const prisma = makePrisma();
  const markets = { resolve: jest.fn(() => Promise.resolve(null)) };
  const marketPricing = new MarketPricingService(
    prisma as unknown as PrismaService,
  );
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
  const promotions = { validateCoupon: jest.fn() };
  // Fixed engine result: 25 % inclusive on everything.
  const tax = {
    contextFor: jest.fn(() => Promise.resolve({ pricingMode: 'INCLUSIVE' })),
    loadTaxData: jest.fn(() => Promise.resolve({})),
    computeTaxes: jest.fn(
      (input: {
        ctx: { buyerType?: string };
        lines: { amount: number }[];
        shipping_cost: number;
        discount_amount: number;
      }) => {
        const total =
          input.lines.reduce((s, l) => s + l.amount, 0) +
          input.shipping_cost -
          input.discount_amount;
        const taxTotal = Math.round((total - total / 1.25) * 100) / 100;
        return {
          items: input.lines.map(() => ({
            tax_rate_bp: 2500,
            tax_amount: 0,
            tax_class_key: 'standard',
          })),
          headline_rate_bp: 2500,
          tax_total: taxTotal,
          tax_lines: [],
          tax_pricing_mode: 'INCLUSIVE',
          tax_basis_country: 'SE',
          shipping_tax_amount: 9.8,
          shipping_tax_rate_bp: 2500,
          total,
          display_mode: input.ctx.buyerType === 'COMPANY' ? 'excl' : 'incl',
          net_items: Math.round(((total - 49) / 1.25) * 100) / 100,
          net_shipping: 39.2,
          net_total: Math.round((total - taxTotal) * 100) / 100,
        };
      },
    ),
  };
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(opts.enabled)),
    getSettings: jest.fn(() =>
      Promise.resolve(opts.enabled ? (opts.settings ?? {}) : null),
    ),
  };
  const b2b = new B2bService(storeApps as unknown as StoreAppsService);
  const mail = { dispatchOrderEmail: jest.fn(() => Promise.resolve()) };
  const config = { get: () => 'https://stores.platform.test' };
  const service = new OrdersService(
    prisma as unknown as PrismaService,
    promotions as unknown as PromotionsService,
    shipping as unknown as ShippingService,
    mail as unknown as MailService,
    tax as unknown as TaxService,
    markets as unknown as MarketsContextService,
    marketPricing,
    config as unknown as ConfigService,
    b2b,
    ...personalizationCoreArgs(prisma),
  );
  return { service, prisma, tax, storeApps };
}

const lines = [{ product_id: 'p1', variant_id: null, quantity: 2 }];

const lastCtx = (tax: { computeTaxes: jest.Mock }) =>
  (tax.computeTaxes.mock.calls.at(-1) as [{ ctx: { buyerType?: string } }])[0]
    .ctx;

describe('OrdersService.quoteLines with the b2b app', () => {
  it('app off: no b2b key, and a COMPANY request prices exactly like a person', async () => {
    const { service, tax } = build({ enabled: false });
    const person = await service.quoteLines(STORE_ID, lines, {
      countryCode: 'SE',
    });
    const company = await service.quoteLines(STORE_ID, lines, {
      countryCode: 'SE',
      buyerType: 'COMPANY',
    });
    expect('b2b' in person).toBe(false);
    expect(company).toEqual(person);
    expect(person.total).toBe(647);
    expect('buyerType' in lastCtx(tax)).toBe(false);
  });

  it('app on + COMPANY: b2b block present, every other figure unchanged', async () => {
    const off = await build({ enabled: false }).service.quoteLines(
      STORE_ID,
      lines,
      { countryCode: 'SE' },
    );
    const { service, tax } = build({ enabled: true });
    const quote = await service.quoteLines(STORE_ID, lines, {
      countryCode: 'SE',
      buyerType: 'COMPANY',
    });
    expect(quote.b2b).toEqual({
      display_mode: 'excl',
      net_items: 478.4,
      net_shipping: 39.2,
      net_total: 517.6,
    });
    const { b2b: _b2b, ...rest } = quote;
    void _b2b;
    expect(rest).toEqual(off);
    expect(lastCtx(tax).buyerType).toBe('COMPANY');
  });

  it('app on + person (default): b2b block in incl mode, no buyerType in the context', async () => {
    const { service, tax } = build({ enabled: true });
    const quote = await service.quoteLines(STORE_ID, lines, {
      countryCode: 'SE',
    });
    expect(quote.b2b?.display_mode).toBe('incl');
    expect('buyerType' in lastCtx(tax)).toBe(false);
  });

  it('app on but allow_company=false: a COMPANY request is priced as a person', async () => {
    const { service, tax } = build({
      enabled: true,
      settings: { allow_company: false },
    });
    const quote = await service.quoteLines(STORE_ID, lines, {
      countryCode: 'SE',
      buyerType: 'COMPANY',
    });
    expect(quote.b2b?.display_mode).toBe('incl');
    expect('buyerType' in lastCtx(tax)).toBe(false);
  });
});

describe('OrdersService.create with the b2b app', () => {
  const baseDto = {
    address_id: 'a1',
    store_id: STORE_ID,
    payment_method: 'COD',
  } as CreateOrderDto;
  const company = {
    company_name: 'Neronet Academy AB',
    org_number: '5560360793',
    vat_number: 'se556677889901',
    buyer_reference: 'Anna',
  };

  it('COMPANY: the snapshot columns are written and the response carries b2b', async () => {
    const { service, prisma } = build({ enabled: true });
    const order = await service.create(
      'u1',
      { ...baseDto, buyer_type: 'COMPANY', company },
      { lines },
    );
    const data = (prisma.order.create.mock.calls[0] as [{ data: unknown }])[0]
      .data;
    expect(data).toMatchObject({
      customer_type: 'COMPANY',
      company_name: 'Neronet Academy AB',
      org_number: '556036-0793',
      vat_number: 'SE556677889901',
      buyer_reference: 'Anna',
      total: 647,
    });
    expect((order as { b2b?: unknown }).b2b).toEqual({
      display_mode: 'excl',
      net_items: 478.4,
      net_shipping: 39.2,
      net_total: 517.6,
    });
  });

  it('person (app on): no snapshot columns in the insert, b2b block in incl mode', async () => {
    const { service, prisma } = build({ enabled: true });
    const order = await service.create('u1', baseDto, { lines });
    const data = (
      prisma.order.create.mock.calls[0] as [{ data: Record<string, unknown> }]
    )[0].data;
    for (const key of [
      'customer_type',
      'company_name',
      'org_number',
      'vat_number',
      'buyer_reference',
    ]) {
      expect(key in data).toBe(false);
    }
    expect(
      (order as { b2b?: { display_mode: string } }).b2b?.display_mode,
    ).toBe('incl');
  });

  it('app off: the insert and the response are exactly the pre-app ones', async () => {
    const insertOf = async (enabled: boolean) => {
      const { service, prisma } = build({ enabled });
      const order = await service.create('u1', baseDto, { lines });
      const data = (
        prisma.order.create.mock.calls[0] as [{ data: Record<string, unknown> }]
      )[0].data;
      // Drop what differs per call by construction (generated number,
      // random token, timestamps); every other column must be identical.
      const stable = Object.fromEntries(
        Object.entries(data).filter(
          ([k, v]) =>
            !(v instanceof Date) &&
            !['order_number', 'kustom_push_token'].includes(k),
        ),
      );
      return { order, stable };
    };
    const off = await insertOf(false);
    const personOn = await insertOf(true);
    expect('customer_type' in off.stable).toBe(false);
    expect('b2b' in off.order).toBe(false);
    expect(off.stable).toEqual(personOn.stable);
  });

  it('buyer_type COMPANY while the app is off is refused (B2B_COMPANY_NOT_ALLOWED)', async () => {
    const { service, prisma } = build({ enabled: false });
    await expect(
      service.create(
        'u1',
        { ...baseDto, buyer_type: 'COMPANY', company },
        { lines },
      ),
    ).rejects.toMatchObject({
      response: { code: 'B2B_COMPANY_NOT_ALLOWED' },
    });
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('an invalid organisation number is refused before anything is written', async () => {
    const { service, prisma } = build({ enabled: true });
    await expect(
      service.create(
        'u1',
        {
          ...baseDto,
          buyer_type: 'COMPANY',
          company: { ...company, org_number: '559123-4567' },
        },
        { lines },
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'B2B_ORG_NUMBER_INVALID',
        message: expect.stringContaining('NNNNNN-NNNN') as string,
      },
    });
    await expect(
      service.create('u1', { ...baseDto, buyer_type: 'COMPANY' }, { lines }),
    ).rejects.toMatchObject({
      response: { code: 'B2B_COMPANY_NAME_REQUIRED' },
    });
    expect(prisma.order.create).not.toHaveBeenCalled();
  });
});
