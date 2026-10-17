import { ConfigService } from '@nestjs/config';
import { StoreType, TaxBasis, TaxPricingMode } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { personalizationCoreArgs } from '../personalization/__fixtures__/personalization-service.factory';
import { PromotionsService } from '../promotions/promotions.service';
import { ShippingService } from '../shipping/shipping.service';
import { MailService } from '../mail/mail.service';
import {
  TaxService,
  computeTaxes,
  type TaxContext,
  type TaxData,
} from '../taxes/tax.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { B2bService } from '../b2b/b2b.service';
import { B2bTaxExemptionService } from '../b2b/b2b-tax-exemption.service';
import { ViesService } from '../b2b/vies/vies.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import type { VatEvidence } from '../b2b/b2b.types';
import type { CreateOrderDto } from './dto/order.dto';

// b2b app M2.5: reverse charge through quoteLines() / create(), with the
// REAL tax engine (SE store, 25 % inclusive), a real B2bService and
// B2bTaxExemptionService, and a stubbed ViesService (no network).

const STORE_ID = 's1';

const DATA: TaxData = {
  classes: [
    {
      id: 'std',
      store_id: null,
      key: 'standard',
      name: { en: 'Standard' },
      is_default: true,
    },
  ],
  rates: [
    {
      id: 'r-se',
      store_id: null,
      tax_class_id: 'std',
      country: 'SE',
      region: null,
      postcode_pattern: null,
      rate_bp: 2500,
      label: { en: 'VAT', sv: 'Moms' },
      priority: 0,
      applies_to_shipping: true,
      is_active: true,
    },
    {
      id: 'r-de',
      store_id: null,
      tax_class_id: 'std',
      country: 'DE',
      region: null,
      postcode_pattern: null,
      rate_bp: 1900,
      label: { en: 'VAT' },
      priority: 0,
      applies_to_shipping: true,
      is_active: true,
    },
  ],
};

function seCtx(over: Partial<TaxContext> = {}): TaxContext {
  return {
    registrant: 'STORE',
    storeId: STORE_ID,
    rateStoreId: STORE_ID,
    taxCountry: 'SE',
    pricingMode: TaxPricingMode.INCLUSIVE,
    basis: TaxBasis.SHIPPING,
    ossRegistered: false,
    usePlatformRates: true,
    shippingTaxClassId: null,
    displayPricesInclTax: true,
    ...over,
  };
}

function evidence(status: VatEvidence['status']): VatEvidence {
  return {
    source: 'VIES',
    vat_number: 'DE123456789',
    country_code: 'DE',
    status,
    valid: status === 'valid',
    name: status === 'valid' ? 'Muster GmbH' : null,
    address: null,
    request_identifier: 'WAPI-1',
    requester: 'SE556036079301',
    checked_at: '2026-10-15T09:12:00.000Z',
    check_id: 'chk-1',
    error_code: status === 'unavailable' ? 'MS_UNAVAILABLE' : null,
  };
}

function makePrisma(addressCountry: string) {
  const product = {
    id: 'p1',
    creator_id: 'c1',
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
          creator_id: 'c1',
          currency: 'SEK',
          cod_enabled: true,
          is_active: true,
          language_config: { primary_locale: 'en' },
          creator: {
            kustom_enabled: false,
            kustom_merchant_id: null,
            kustom_shared_secret: null,
          },
        }),
      ),
    },
    product: {
      findUnique: jest.fn(() => Promise.resolve(product)),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    productVariant: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    productMarketPrice: { findMany: jest.fn(() => Promise.resolve([])) },
    platformConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve({ default_currency: 'SEK', commission_value: 15 }),
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
          country_code: addressCountry,
          state: null,
          postal_code: '10115',
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
    storeCustomerTaxExemption: {
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
  };
}

function build(
  opts: {
    enabled?: boolean;
    settings?: Record<string, unknown>;
    vies?: VatEvidence['status'];
    addressCountry?: string;
    ctx?: Partial<TaxContext>;
    withExemptionService?: boolean;
    exemption?: { id: string; kind: 'FULL' | 'REVERSE_CHARGE' } | null;
  } = {},
) {
  const prisma = makePrisma(opts.addressCountry ?? 'DE');
  if (opts.exemption) {
    prisma.storeCustomerTaxExemption.findFirst.mockResolvedValue({
      ...opts.exemption,
      vat_number: null,
      note: null,
    } as never);
  }
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
          {
            id: 'exp',
            name: 'Express',
            type: 'EXPRESS',
            cost: 99,
            estimated_days: { min: 1, max: 1 },
            free_shipping: false,
          },
        ],
      }),
    ),
  };
  const promotions = {
    validateCoupon: jest.fn(() =>
      Promise.resolve({
        promotion_id: 'promo1',
        type: 'PERCENTAGE',
        value: 10,
        discount_amount: 59.8,
        free_shipping: false,
      }),
    ),
    claimRedemption: jest.fn(() => Promise.resolve('reserved')),
    releaseRedemption: jest.fn(() => Promise.resolve()),
    recordUsage: jest.fn(() => Promise.resolve()),
  };
  const tax = {
    contextFor: jest.fn(() => Promise.resolve(seCtx(opts.ctx))),
    loadTaxData: jest.fn(() => Promise.resolve(DATA)),
    computeTaxes: jest.fn(computeTaxes),
  };
  const enabled = opts.enabled ?? true;
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(enabled)),
    getSettings: jest.fn(() =>
      Promise.resolve(
        enabled
          ? { reverse_charge_enabled: true, ...(opts.settings ?? {}) }
          : null,
      ),
    ),
  };
  const b2b = new B2bService(storeApps as unknown as StoreAppsService);
  const vies = {
    check: jest.fn(() => Promise.resolve(evidence(opts.vies ?? 'valid'))),
    requesterFor: jest.fn(() => Promise.resolve('SE556036079301')),
  };
  const b2bTax = new B2bTaxExemptionService(
    prisma as unknown as PrismaService,
    b2b,
    vies as unknown as ViesService,
  );
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
    undefined,
    opts.withExemptionService === false ? undefined : b2bTax,
  );
  return { service, prisma, vies, promotions, shipping, tax };
}

const lines = [{ product_id: 'p1', variant_id: null, quantity: 2 }];
const company = {
  company_name: 'Muster GmbH',
  org_number: 'HRB 12345',
  vat_number: 'de 123 456 789',
};
const companyQuote = {
  countryCode: 'DE',
  buyerType: 'COMPANY',
  vatNumber: 'DE123456789',
};

describe('OrdersService.quoteLines with reverse charge', () => {
  it('app off: byte-identical to a service without the exemption service', async () => {
    const before = await build({
      enabled: false,
      withExemptionService: false,
    }).service.quoteLines(STORE_ID, lines, companyQuote);
    const { service, vies } = build({ enabled: false });
    const after = await service.quoteLines(STORE_ID, lines, companyQuote);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after).not.toHaveProperty('tax_exempt_reason');
    expect(after).not.toHaveProperty('tax_exemption');
    expect(vies.check).not.toHaveBeenCalled();
  });

  it('b2b on, reverse charge off: byte-identical to M2', async () => {
    const settings = { reverse_charge_enabled: false };
    const before = await build({
      settings,
      withExemptionService: false,
    }).service.quoteLines(STORE_ID, lines, companyQuote);
    const { service, vies } = build({ settings });
    const after = await service.quoteLines(STORE_ID, lines, companyQuote);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after.tax_lines.every((l) => !('exempt_reason' in l))).toBe(true);
    expect(vies.check).not.toHaveBeenCalled();
  });

  it('cached-valid DE company: net prices, 0 tax, netted shipping methods', async () => {
    const { service, vies, shipping } = build();
    const quote = await service.quoteLines(STORE_ID, lines, companyQuote);
    expect(vies.check).toHaveBeenCalledWith(
      'DE123456789',
      expect.objectContaining({ mode: 'cached', source: 'quote' }),
    );
    expect(quote.items[0]).toMatchObject({
      unit_price: 239.2,
      total_price: 478.4,
      tax_rate_bp: 0,
      tax_amount: 0,
    });
    expect(quote.subtotal).toBe(478.4);
    expect(quote.shipping_cost).toBe(39.2);
    expect(
      quote.shipping && quote.shipping.available
        ? quote.shipping.methods.map((m) => m.cost)
        : null,
    ).toEqual([39.2, 79.2]);
    expect(quote.total).toBe(517.6);
    expect(quote.tax_total).toBe(0);
    expect(quote.shipping_tax_rate_bp).toBe(0);
    expect(quote.tax_lines).toEqual([
      {
        label: 'Reverse charge',
        rate_bp: 0,
        taxable_amount: 517.6,
        tax_amount: 0,
        exempt_reason: 'REVERSE_CHARGE',
      },
    ]);
    expect(quote.tax_exempt_reason).toBe('REVERSE_CHARGE');
    expect(quote.tax_exemption).toEqual({
      reason: 'REVERSE_CHARGE',
      vat_number: 'DE123456789',
      name: 'Muster GmbH',
      checked_at: '2026-10-15T09:12:00.000Z',
      why: null,
    });
    expect(quote.b2b).toEqual({
      display_mode: 'excl',
      net_items: 478.4,
      net_shipping: 39.2,
      net_total: 517.6,
    });
    // Free-shipping thresholds still see the gross subtotal.
    expect(shipping.quoteForItems).toHaveBeenCalledWith(
      expect.objectContaining({ subtotal: 598 }),
    );
  });

  it("'gross' pricing: unchanged prices, VAT 0 (Shopify)", async () => {
    const { service } = build({
      settings: { reverse_charge_pricing: 'gross' },
    });
    const quote = await service.quoteLines(STORE_ID, lines, companyQuote);
    expect(quote.items[0].unit_price).toBe(299);
    expect(quote.subtotal).toBe(598);
    expect(quote.shipping_cost).toBe(49);
    expect(quote.total).toBe(647);
    expect(quote.tax_total).toBe(0);
    expect(quote.tax_exempt_reason).toBe('REVERSE_CHARGE');
  });

  it('coupon minimum on gross, discount scaled to the net subtotal', async () => {
    const { service, promotions } = build();
    const quote = await service.quoteLines(STORE_ID, lines, {
      ...companyQuote,
      couponCode: 'TEN',
    });
    expect(promotions.validateCoupon).toHaveBeenCalledWith(
      expect.objectContaining({ subtotal: 598 }),
    );
    expect(quote.discount_amount).toBe(47.84);
    expect(quote.coupon?.discount_amount).toBe(47.84);
    expect(quote.total).toBe(Math.round((478.4 + 39.2 - 47.84) * 100) / 100);
    expect(quote.tax_total).toBe(0);
  });

  it('the coupon block carries the same net discount as the quote (smoke: 39.80 gross -> 31.84)', async () => {
    const { service, promotions } = build();
    promotions.validateCoupon.mockResolvedValueOnce({
      promotion_id: 'promo1',
      type: 'FIXED',
      value: 39.8,
      discount_amount: 39.8,
      free_shipping: false,
    });
    const quote = await service.quoteLines(STORE_ID, lines, {
      ...companyQuote,
      couponCode: 'FIXED',
    });
    expect(quote.discount_amount).toBe(31.84);
    expect(quote.coupon?.discount_amount).toBe(31.84);
    // Without reverse charge the coupon block stays the gross amount.
    const se = build();
    se.promotions.validateCoupon.mockResolvedValueOnce({
      promotion_id: 'promo1',
      type: 'FIXED',
      value: 39.8,
      discount_amount: 39.8,
      free_shipping: false,
    });
    const taxed = await se.service.quoteLines(STORE_ID, lines, {
      ...companyQuote,
      countryCode: 'SE',
      couponCode: 'FIXED',
    });
    expect(taxed.discount_amount).toBe(39.8);
    expect(taxed.coupon?.discount_amount).toBe(39.8);
  });

  it('VIES unavailable / SE destination: VAT charged, why reported', async () => {
    const down = await build({ vies: 'unavailable' }).service.quoteLines(
      STORE_ID,
      lines,
      companyQuote,
    );
    expect(down.tax_total).toBeGreaterThan(0);
    expect(down.tax_exempt_reason).toBeNull();
    expect(down.tax_exemption?.why).toBe('VAT_UNAVAILABLE');
    const se = await build().service.quoteLines(STORE_ID, lines, {
      ...companyQuote,
      countryCode: 'SE',
    });
    expect(se.tax_exemption?.why).toBe('SAME_COUNTRY');
    expect(se.items[0].unit_price).toBe(299);
  });

  it('a guest quote never looks up customer exemptions', async () => {
    const { service, prisma } = build();
    await service.quoteLines(STORE_ID, lines, companyQuote);
    expect(prisma.storeCustomerTaxExemption.findFirst).not.toHaveBeenCalled();
  });

  it('a person never triggers VIES even with a number', async () => {
    const { service, vies } = build();
    const quote = await service.quoteLines(STORE_ID, lines, {
      countryCode: 'DE',
      vatNumber: 'DE123456789',
    });
    expect(vies.check).not.toHaveBeenCalled();
    expect(quote.tax_exemption?.why).toBe('PERSON');
  });
});

describe('OrdersService.create with reverse charge', () => {
  const baseDto = {
    address_id: 'a1',
    store_id: STORE_ID,
    payment_method: 'COD',
  } as CreateOrderDto;

  it('cart checkout: VIES live, snapshot columns written', async () => {
    const { service, prisma, vies } = build();
    (prisma as unknown as { cart: unknown }).cart = {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'cart1',
          items: [
            {
              id: 'ci1',
              product_id: 'p1',
              variant_id: null,
              custom_product_id: null,
              bundle_offer_id: null,
              quantity: 2,
              custom_fields: null,
            },
          ],
        }),
      ),
    };
    (prisma as unknown as { cartItem: unknown }).cartItem = {
      deleteMany: jest.fn(() => Promise.resolve({})),
    };
    (prisma as unknown as { order: { findMany: unknown } }).order.findMany =
      jest.fn(() => Promise.resolve([]));
    await service.create('u1', {
      ...baseDto,
      buyer_type: 'COMPANY',
      company,
      expect_reverse_charge: true,
    } as CreateOrderDto);
    expect(vies.check).toHaveBeenCalledWith(
      'DE123456789',
      expect.objectContaining({ mode: 'live', source: 'order' }),
    );
    const data = (
      prisma.order.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data).toMatchObject({
      subtotal: 478.4,
      shipping_cost: 39.2,
      total: 517.6,
      tax_amount: 0,
      tax_rate_bp: 0,
      shipping_tax_rate_bp: 0,
      shipping_tax_amount: 0,
      tax_exempt_reason: 'REVERSE_CHARGE',
      vat_number: 'DE123456789',
      customer_type: 'COMPANY',
    });
    expect(data.vat_validation).toMatchObject({
      source: 'VIES',
      vat_number: 'DE123456789',
      request_identifier: 'WAPI-1',
      seller_country: 'SE',
      destination_country: 'DE',
      vat_country_matches_destination: true,
    });
    const items = (data.items as { create: Record<string, unknown>[] }).create;
    expect(items[0]).toMatchObject({
      unit_price: 239.2,
      total_price: 478.4,
      tax_rate_bp: 0,
      tax_amount: 0,
    });
  });

  it('expect_reverse_charge while VIES is down: 409 before any claim', async () => {
    const { service, promotions, prisma } = build({ vies: 'unavailable' });
    const err = await service
      .create(
        'u1',
        {
          ...baseDto,
          buyer_type: 'COMPANY',
          company,
          coupon_code: 'TEN',
          expect_reverse_charge: true,
          // Kustom-style snapshot with explicit inputs (VIES down).
        } as CreateOrderDto,
        {
          lines,
          exemptionInputs: {
            settings: {
              allow_company: true,
              default_buyer_type: 'PERSON',
              require_vat_number: false,
              org_number_countries: ['SE'],
              reverse_charge_enabled: true,
              reverse_charge_pricing: 'net',
              vies_requester_vat: null,
            },
            vat: evidence('unavailable'),
            customerExemption: null,
          },
        },
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'B2B_REVERSE_CHARGE_NOT_CONFIRMED',
      why: 'VAT_UNAVAILABLE',
    });
    expect(promotions.claimRedemption).not.toHaveBeenCalled();
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('snapshot checkout without inputs never calls VIES and stays taxed', async () => {
    const { service, prisma, vies } = build();
    await service.create(
      'u1',
      { ...baseDto, buyer_type: 'COMPANY', company } as CreateOrderDto,
      { lines },
    );
    expect(vies.check).not.toHaveBeenCalled();
    const data = (
      prisma.order.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data).not.toHaveProperty('tax_exempt_reason');
    expect(Number(data.tax_amount)).toBeGreaterThan(0);
  });

  it('customer FULL exemption (known customer): CUSTOMER_EXEMPT, any destination', async () => {
    const { service, prisma } = build({
      addressCountry: 'SE',
      exemption: { id: 'ex1', kind: 'FULL' },
    });
    const response = await service.create(
      'u1',
      { ...baseDto } as CreateOrderDto,
      {
        lines,
        exemptionInputs: await new B2bTaxExemptionService(
          prisma as unknown as PrismaService,
          new B2bService({
            isEnabled: () => Promise.resolve(true),
            getSettings: () =>
              Promise.resolve({ reverse_charge_enabled: true }),
          } as unknown as StoreAppsService),
          {} as ViesService,
        ).prepare(STORE_ID, {
          buyerType: 'PERSON',
          customerId: 'cust1',
          mode: 'stored',
        }),
      },
    );
    const data = (
      prisma.order.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data).toMatchObject({
      tax_exempt_reason: 'CUSTOMER_EXEMPT',
      tax_amount: 0,
      subtotal: 478.4,
    });
    expect(data.vat_validation).toMatchObject({
      source: 'MANUAL',
      exemption_id: 'ex1',
      exemption_kind: 'FULL',
    });
    // M2: the merchant's note is never copied into the order evidence...
    expect(data.vat_validation).not.toHaveProperty('note');
    // ...and the customer-facing response carries no internal ids.
    const shown = (response as { vat_validation?: Record<string, unknown> })
      .vat_validation;
    expect(shown).toMatchObject({
      source: 'MANUAL',
      exemption_kind: 'FULL',
      status: 'valid',
    });
    for (const k of [
      'exemption_id',
      'check_id',
      'note',
      'requester',
      'address',
    ]) {
      expect(shown).not.toHaveProperty(k);
    }
    expect(data.tax_lines).toEqual([
      {
        label: 'VAT exempt',
        rate_bp: 0,
        taxable_amount: 517.6,
        tax_amount: 0,
        exempt_reason: 'CUSTOMER_EXEMPT',
      },
    ]);
  });

  it('L4: expect_reverse_charge on a customer-exempt order: 409 why CUSTOMER_EXEMPT', async () => {
    const { service, prisma } = build({
      addressCountry: 'SE',
      exemption: { id: 'ex1', kind: 'FULL' },
    });
    const inputs = await new B2bTaxExemptionService(
      prisma as unknown as PrismaService,
      new B2bService({
        isEnabled: () => Promise.resolve(true),
        getSettings: () => Promise.resolve({ reverse_charge_enabled: true }),
      } as unknown as StoreAppsService),
      {} as ViesService,
    ).prepare(STORE_ID, {
      buyerType: 'PERSON',
      customerId: 'cust1',
      mode: 'stored',
    });
    const err = await service
      .create(
        'u1',
        { ...baseDto, expect_reverse_charge: true } as CreateOrderDto,
        { lines, exemptionInputs: inputs },
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'B2B_REVERSE_CHARGE_NOT_CONFIRMED',
      why: 'CUSTOMER_EXEMPT',
    });
  });

  it('M2: GET /orders/my strips internal evidence fields', async () => {
    const { service, prisma } = build();
    (prisma as unknown as { order: Record<string, unknown> }).order.findMany =
      jest.fn(() =>
        Promise.resolve([
          {
            id: 'o1',
            items: [],
            vat_validation: {
              source: 'VIES',
              vat_number: 'DE123456789',
              status: 'valid',
              valid: true,
              check_id: 'chk-1',
              requester: 'SE556036079301',
              address: 'Musterstr. 1',
              note: 'legacy',
              exemption_id: 'ex1',
              request_identifier: 'WAPI-1',
            },
          },
          { id: 'o2', items: [], vat_validation: null },
        ]),
      );
    (prisma as unknown as { order: Record<string, unknown> }).order.count =
      jest.fn(() => Promise.resolve(2));
    const res = await service.findByCustomer('u1');
    const [rc, plain] = res.data as unknown as {
      vat_validation: Record<string, unknown> | null;
    }[];
    expect(rc.vat_validation).toEqual({
      source: 'VIES',
      vat_number: 'DE123456789',
      status: 'valid',
      valid: true,
      request_identifier: 'WAPI-1',
    });
    expect(plain.vat_validation).toBeNull();
  });

  it('app off: the insert carries no new columns', async () => {
    const { service, prisma } = build({ enabled: false });
    await service.create('u1', { ...baseDto } as CreateOrderDto, { lines });
    const data = (
      prisma.order.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data).not.toHaveProperty('tax_exempt_reason');
    expect(data).not.toHaveProperty('vat_validation');
  });
});
