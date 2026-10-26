import { Prisma, StoreType } from '@prisma/client';
import { KustomCheckoutService } from './kustom-checkout.service';
import { KustomClient } from './kustom.client';
import { withMarket, type StoreContext } from './kustom.service';
import type { KustomService } from './kustom.service';
import type { OrdersService } from '../../orders/orders.service';
import type { MailService } from '../../mail/mail.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { MarketsContextService } from '../../markets/markets-context.service';
import type { MarketContext } from '../../markets/market-context';
import { B2bService } from '../../b2b/b2b.service';
import type { StoreAppsService } from '../../store-apps/store-apps.service';

// The market wiring of the session-first flow (M1-DESIGN §3.5): with a
// market the session snapshots market_id and the validated host, is priced
// in the market (quoteLines gets the key), defaults to the market's first
// country and language, and its merchant URLs land on the market host.
// Without one, every value is what the pre-markets code produced.

jest.mock('./kustom.client', () => ({
  ...jest.requireActual<typeof import('./kustom.client')>('./kustom.client'),
  KustomClient: jest.fn(),
}));

const STORE_ID = 's1';

const euMarket: MarketContext = {
  id: 'm-eu',
  key: 'eu',
  name: 'Europe',
  countries: ['DE', 'FR'],
  defaultLocale: 'en',
  locales: ['de'],
  currency: 'EUR',
  storeCurrency: 'SEK',
  rate: 0.1,
  priceRule: { mode: 'convert', source: 'manual', rate: 0.1 },
  isDefault: false,
  indexing: 'AUTO',
  status: 'LIVE',
  primaryHostname: 'namez.shop',
  hostnames: ['namez.shop', 'www.namez.shop'],
};

const storeCtx: StoreContext = {
  id: STORE_ID,
  slug: 'namez',
  customDomain: null,
  store_type: StoreType.INDEPENDENT,
  is_active: true,
  primaryLocale: 'sv',
  currency: 'SEK',
  creator: {
    id: 'c1',
    kustom_enabled: true,
    kustom_merchant_id: 'PK1',
    kustom_shared_secret: 'enc',
    kustom_environment: 'playground',
  },
  market: null,
};

function quoteFor(currency: string) {
  return {
    items: [
      {
        product_id: 'p1',
        variant_id: null,
        custom_product_id: null,
        bundle_offer_id: null,
        quantity: 1,
        unit_price: currency === 'EUR' ? 29.9 : 299,
        original_unit_price: null,
        total_price: currency === 'EUR' ? 29.9 : 299,
        tax_rate_bp: 0,
        tax_amount: 0,
        tax_class_key: null,
      },
    ],
    subtotal: currency === 'EUR' ? 29.9 : 299,
    shipping_cost: 0,
    discount_amount: 0,
    total: currency === 'EUR' ? 29.9 : 299,
    currency,
    tax_rate_bp: 0,
    tax_amount: 0,
    tax_lines: [],
    tax_total: 0,
    tax_pricing_mode: 'INCLUSIVE' as const,
    tax_basis_country: null,
    shipping_tax_amount: 0,
    shipping_tax_rate_bp: 0,
    shipping: null,
    coupon: null,
  };
}

/**
 * `b2b` switches the b2b app on for the store (a real B2bService over a
 * mocked StoreAppsService, so validation / normalisation run for real);
 * `session` is the stored row the validation / update paths load.
 */
function build(
  market: MarketContext | null,
  opts: {
    b2b?: boolean;
    session?: Record<string, unknown> | null;
    customer?: Record<string, unknown> | null;
    /** Designer app: a DesignerCartService double (8th, optional param). */
    designerCart?: Record<string, unknown>;
  } = {},
) {
  const sessions: Record<string, unknown>[] = [];
  const prisma = {
    kustomCheckoutSession: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, kustom_order_id: null };
        sessions.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...(sessions[0] ?? opts.session), ...data }),
      ),
      findUnique: jest.fn(() => Promise.resolve(opts.session ?? null)),
      updateMany: jest.fn((_args: unknown) => Promise.resolve({ count: 1 })),
      delete: jest.fn(() => Promise.resolve()),
      deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
    customer: {
      findUnique: jest.fn(() => Promise.resolve(opts.customer ?? null)),
    },
    address: {
      findFirst: jest.fn((_args: unknown) => Promise.resolve(null)),
      create: jest.fn((_args: unknown) => Promise.resolve({ id: 'a1' })),
    },
    order: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      update: jest.fn(() => Promise.resolve({})),
    },
    $transaction: jest.fn(() => Promise.resolve([])),
    product: {
      findMany: jest.fn(() =>
        Promise.resolve([
          { id: 'p1', translations: [{ locale: 'en', title: 'Tee' }] },
        ]),
      ),
    },
    customProduct: { findMany: jest.fn(() => Promise.resolve([])) },
    productVariant: { findMany: jest.fn(() => Promise.resolve([])) },
  };
  const bases = {
    storefrontBase: 'https://stores.example.com',
    apiBase: 'https://api.example.com',
  };
  const kustom = {
    loadStoreContextBySlug: jest.fn(() => Promise.resolve({ ...storeCtx })),
    loadStoreContext: jest.fn(() => Promise.resolve({ ...storeCtx })),
    safeTokenEqual: (a: string | null | undefined, b: string) =>
      Boolean(a) && a === b,
    credentialsFor: jest.fn(() =>
      Promise.resolve({
        merchantId: 'PK1',
        sharedSecret: 's',
        environment: 'playground',
        partnerId: null,
      }),
    ),
    requirePublicUrls: jest.fn(() => bases),
    urls: jest.fn(() => bases),
    toHttpException: jest.fn((err: unknown) => err),
  };
  const orders = {
    quoteLines: jest.fn(
      (
        _storeId: string,
        _lines: unknown,
        opts: { marketKey?: string | null },
      ) => Promise.resolve(quoteFor(opts.marketKey ? 'EUR' : 'SEK')),
    ),
    validatedHostname: jest.fn(
      (m: MarketContext, _slug: string, host?: string | null) =>
        host && m.hostnames.includes(host) ? host : m.primaryHostname,
    ),
    create: jest.fn((_userId: string, _dto: unknown, _opts: unknown) =>
      Promise.resolve({ id: 'o1', total: 299, currency: 'SEK' }),
    ),
  };
  const b2b = new B2bService({
    isEnabled: jest.fn(() => Promise.resolve(opts.b2b === true)),
    getSettings: jest.fn(() => Promise.resolve(null)),
  } as unknown as StoreAppsService);
  const markets = { resolve: jest.fn(() => Promise.resolve(market)) };
  const createCheckout = jest.fn((payload: Record<string, unknown>) =>
    Promise.resolve({
      ...payload,
      order_id: 'k-1',
      html_snippet: '<div/>',
      status: 'checkout_incomplete',
    }),
  );
  const updateCheckout = jest.fn(
    (_id: string, payload: Record<string, unknown>) =>
      Promise.resolve({
        ...payload,
        order_id: 'k-1',
        html_snippet: '<div/>',
        status: 'checkout_incomplete',
      }),
  );
  (KustomClient as unknown as jest.Mock).mockImplementation(() => ({
    createCheckout,
    updateCheckout,
  }));
  const service = new KustomCheckoutService(
    prisma as unknown as PrismaService,
    kustom as unknown as KustomService,
    orders as unknown as OrdersService,
    {} as MailService,
    markets as unknown as MarketsContextService,
    b2b,
    undefined,
    opts.designerCart as never,
  );
  return {
    service,
    prisma,
    orders,
    markets,
    createCheckout,
    updateCheckout,
    sessions,
  };
}

const dto = {
  store_slug: 'namez',
  items: [{ product_id: 'p1', quantity: 1 }],
};

describe('withMarket', () => {
  it('overlays host, locale and currency; untouched without a market', () => {
    expect(withMarket(storeCtx, null)).toBe(storeCtx);
    expect(withMarket(storeCtx, { market: euMarket })).toMatchObject({
      customDomain: 'namez.shop',
      primaryLocale: 'en',
      currency: 'EUR',
      market: euMarket,
    });
    expect(
      withMarket(storeCtx, {
        market: euMarket,
        hostname: 'www.namez.shop',
        locale: 'de',
        currency: 'eur',
      }),
    ).toMatchObject({
      customDomain: 'www.namez.shop',
      primaryLocale: 'de',
      currency: 'EUR',
    });
    // A market without an ACTIVE host keeps the legacy custom domain.
    expect(
      withMarket(
        { ...storeCtx, customDomain: 'legacy.se' },
        { market: { ...euMarket, primaryHostname: null, hostnames: [] } },
      ).customDomain,
    ).toBe('legacy.se');
  });
});

describe('KustomCheckoutService.createSession with a market', () => {
  it('snapshots market_id + validated host, prices in the market and targets the market host', async () => {
    const { service, prisma, orders, markets, createCheckout } =
      build(euMarket);
    const res = await service.createSession(null, {
      ...dto,
      market_key: 'eu',
      hostname: 'www.namez.shop',
    });

    expect(markets.resolve).toHaveBeenCalledWith(STORE_ID, 'eu');
    expect(orders.validatedHostname).toHaveBeenCalledWith(
      euMarket,
      'namez',
      'www.namez.shop',
    );
    const created = prisma.kustomCheckoutSession.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      store_id: STORE_ID,
      market_id: 'm-eu',
      hostname: 'www.namez.shop',
      currency: 'EUR',
      locale: null,
      // The market's first country, not the currency's home market.
      country_code: 'DE',
    });

    expect(orders.quoteLines).toHaveBeenCalledWith(
      STORE_ID,
      expect.any(Array),
      expect.objectContaining({
        marketKey: 'eu',
        countryCode: 'DE',
        // No session locale: the market's default, not the store's.
        locale: 'en',
      }),
    );

    const payload = createCheckout.mock.calls[0][0] as {
      purchase_country: string;
      purchase_currency: string;
      merchant_urls: Record<string, string>;
    };
    expect(payload.purchase_country).toBe('DE');
    expect(payload.purchase_currency).toBe('EUR');
    expect(payload.merchant_urls.checkout).toMatch(
      /^https:\/\/www\.namez\.shop\/checkout\?kustom_session=/,
    );
    expect(payload.merchant_urls.push).toMatch(
      /^https:\/\/api\.example\.com\/api\/payments\/kustom\/checkout\/push\?/,
    );
    expect(res.totals?.currency).toBe('EUR');
  });

  it('a foreign host is replaced by the market primary; dto.locale wins over the market default', async () => {
    const { service, prisma, orders } = build(euMarket);
    await service.createSession(null, {
      ...dto,
      market_key: 'eu',
      hostname: 'evil.example',
      locale: 'de',
    });
    expect(
      prisma.kustomCheckoutSession.create.mock.calls[0][0].data,
    ).toMatchObject({
      hostname: 'namez.shop',
      locale: 'de',
      market_id: 'm-eu',
    });
    expect(orders.quoteLines).toHaveBeenCalledWith(
      STORE_ID,
      expect.any(Array),
      expect.objectContaining({ marketKey: 'eu', locale: 'de' }),
    );
  });

  it('refuses a market whose currency Kustom cannot process', async () => {
    const { service, prisma } = build({
      ...euMarket,
      key: 'tr',
      currency: 'TRY',
      countries: ['TR'],
    });
    await expect(
      service.createSession(null, { ...dto, market_key: 'tr' }),
    ).rejects.toMatchObject({
      response: { code: 'ORDER_KUSTOM_UNAVAILABLE' },
    });
    expect(prisma.kustomCheckoutSession.create).not.toHaveBeenCalled();
  });
});

describe('KustomCheckoutService.createSession without the markets app', () => {
  it('behaves exactly as before: store currency, currency home country, no market columns', async () => {
    const { service, prisma, orders, createCheckout } = build(null);
    await service.createSession(null, dto);
    const created = prisma.kustomCheckoutSession.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ currency: 'SEK', country_code: 'SE' });
    expect(created).not.toHaveProperty('market_id');
    expect(created).not.toHaveProperty('hostname');
    expect(orders.validatedHostname).not.toHaveBeenCalled();
    expect(orders.quoteLines).toHaveBeenCalledWith(
      STORE_ID,
      expect.any(Array),
      expect.objectContaining({ marketKey: null, locale: 'sv' }),
    );
    const payload = createCheckout.mock.calls[0][0] as {
      purchase_currency: string;
      merchant_urls: Record<string, string>;
    };
    expect(payload.purchase_currency).toBe('SEK');
    expect(payload.merchant_urls.checkout).toMatch(
      /^https:\/\/stores\.example\.com\/store\/namez\/checkout\?kustom_session=/,
    );
  });
});

// ── b2b app ────────────────────────────────────────────────────────────────

const companyPrefill = {
  company_name: 'Prefill AB',
  org_number: '556737-0431',
  vat_number: 'SE556737043101',
  buyer_reference: null,
};

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    store_id: STORE_ID,
    customer_id: 'c1',
    token: 'sf-token',
    callback_token: 'cb-token',
    status: 'open',
    locale: null,
    currency: 'SEK',
    items: [{ product_id: 'p1', quantity: 1 }],
    coupon_code: null,
    notes: null,
    country_code: 'SE',
    region: null,
    postcode: null,
    purchase_country: 'SE',
    shipping_method_id: null,
    shipping_cost: null,
    kustom_order_id: 'k-1',
    order_id: null,
    market_id: null,
    hostname: null,
    buyer_type: null,
    company: null,
    expires_at: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

const kustomAddress = {
  given_name: 'Anna',
  family_name: 'Svensson',
  email: 'anna@example.com',
  street_address: 'Sturegatan 6',
  postal_code: '114 35',
  city: 'Stockholm',
  country: 'SE',
};

const loggedIn = { id: 'c1', user: { id: 'u1', email: 'anna@example.com' } };

// A logged-in customer with a saved Swedish address (customerPrefill).
const savedAddressCustomer = {
  ...loggedIn,
  phone: null,
  company_name: null,
  org_number: null,
  vat_number: null,
  addresses: [
    {
      full_name: 'Anna Svensson',
      line1: 'Sturegatan 6',
      line2: null,
      city: 'Stockholm',
      state: null,
      postal_code: '114 35',
      country_code: 'SE',
      phone: null,
      company_name: null,
      org_number: null,
      buyer_reference: null,
    },
  ],
};

describe('KustomCheckoutService.createSession with the b2b app', () => {
  it('without the app: no buyer columns, no customer-type option, no b2b totals', async () => {
    const { service, prisma, orders, createCheckout } = build(null);
    const res = await service.createSession(null, {
      ...dto,
      buyer_type: 'PERSON',
    });
    const created = prisma.kustomCheckoutSession.create.mock.calls[0][0].data;
    expect(created).not.toHaveProperty('buyer_type');
    expect(created).not.toHaveProperty('company');
    expect(orders.quoteLines.mock.calls[0][2]).not.toHaveProperty('buyerType');
    const payload = createCheckout.mock.calls[0][0] as {
      options: Record<string, unknown>;
    };
    expect(payload.options).not.toHaveProperty('allowed_customer_types');
    expect(payload).not.toHaveProperty('customer');
    expect(res.totals).not.toHaveProperty('b2b');
  });

  it('app on + COMPANY: snapshots the validated company, prices as a company and prefills Kustom', async () => {
    const { service, prisma, orders, createCheckout } = build(null, {
      b2b: true,
    });
    await service.createSession(null, {
      ...dto,
      buyer_type: 'COMPANY',
      company: {
        company_name: ' Neronet  Academy AB ',
        org_number: '5567370431',
        vat_number: 'se 5567370431 01',
        buyer_reference: 'Anna',
      },
    });
    const created = prisma.kustomCheckoutSession.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      buyer_type: 'COMPANY',
      company: {
        customer_type: 'COMPANY',
        company_name: 'Neronet Academy AB',
        org_number: '556737-0431',
        vat_number: 'SE556737043101',
        buyer_reference: 'Anna',
      },
    });
    expect(orders.quoteLines).toHaveBeenCalledWith(
      STORE_ID,
      expect.any(Array),
      expect.objectContaining({ buyerType: 'COMPANY' }),
    );
    const payload = createCheckout.mock.calls[0][0];
    expect(payload.options).toMatchObject({
      allowed_customer_types: ['person', 'organization'],
    });
    expect(payload.customer).toEqual({
      type: 'organization',
      organization_registration_id: '556737-0431',
      vat_id: 'SE556737043101',
    });
  });

  it('a COMPANY request on a store without the app is refused', async () => {
    const { service, prisma } = build(null);
    await expect(
      service.createSession(null, { ...dto, buyer_type: 'COMPANY' }),
    ).rejects.toMatchObject({ response: { code: 'B2B_COMPANY_NOT_ALLOWED' } });
    expect(prisma.kustomCheckoutSession.create).not.toHaveBeenCalled();
  });

  it('app on + company with a prefilled address: strict format → B2B_* 400', async () => {
    const { service, prisma } = build(null, {
      b2b: true,
      customer: savedAddressCustomer,
    });
    await expect(
      service.createSession('u1', {
        ...dto,
        buyer_type: 'COMPANY',
        company: { company_name: 'X AB', org_number: '559123-4568' },
      }),
    ).rejects.toMatchObject({
      response: { code: 'B2B_ORG_NUMBER_INVALID' },
    });
    expect(prisma.kustomCheckoutSession.create).not.toHaveBeenCalled();
  });

  it('app on + company without a prefilled address: presence-only (a Finnish number on an SE store passes)', async () => {
    const { service, prisma } = build(null, { b2b: true });
    await service.createSession(null, {
      ...dto,
      buyer_type: 'COMPANY',
      company: { company_name: 'Oy Suomi Ab', org_number: '1234567-8' },
    });
    const created = prisma.kustomCheckoutSession.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      buyer_type: 'COMPANY',
      company: { company_name: 'Oy Suomi Ab', org_number: '1234567-8' },
    });

    const { service: s2, prisma: p2 } = build(null, { b2b: true });
    await expect(
      s2.createSession(null, {
        ...dto,
        buyer_type: 'COMPANY',
        company: { company_name: 'X AB', org_number: '  ' },
      }),
    ).rejects.toMatchObject({
      response: { code: 'B2B_ORG_NUMBER_REQUIRED' },
    });
    expect(p2.kustomCheckoutSession.create).not.toHaveBeenCalled();
  });

  it('app on + PERSON: option only, no customer object', async () => {
    const { service, prisma, createCheckout } = build(null, { b2b: true });
    await service.createSession(null, { ...dto, buyer_type: 'PERSON' });
    const created = prisma.kustomCheckoutSession.create.mock.calls[0][0].data;
    expect(created).not.toHaveProperty('buyer_type');
    const payload = createCheckout.mock.calls[0][0];
    expect(payload.options).toMatchObject({
      allowed_customer_types: ['person', 'organization'],
    });
    expect(payload).not.toHaveProperty('customer');
  });
});

describe('KustomCheckoutService.updateSession with the b2b app', () => {
  it('buyer_type PERSON + company null re-prices as a person and clears the snapshot', async () => {
    const session = sessionRow({
      buyer_type: 'COMPANY',
      company: { ...companyPrefill, customer_type: 'COMPANY' },
    });
    const { service, prisma, orders, updateCheckout } = build(null, {
      b2b: true,
      session,
    });
    await service.updateSession('sess-1', {
      token: 'sf-token',
      buyer_type: 'PERSON',
      company: null,
    });
    expect(orders.quoteLines.mock.calls[0][2]).not.toHaveProperty('buyerType');
    const payload = updateCheckout.mock.calls[0][1];
    expect(payload).not.toHaveProperty('customer');
    expect(payload.options).toMatchObject({
      allowed_customer_types: ['person', 'organization'],
    });
    const stored = prisma.kustomCheckoutSession.updateMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(stored.data.buyer_type).toBeNull();
    expect(stored.data.company).toBe(Prisma.DbNull);
  });

  it('buyer_type COMPANY with a company re-prices as a company', async () => {
    const { service, prisma, orders, updateCheckout } = build(null, {
      b2b: true,
      session: sessionRow(),
    });
    await service.updateSession('sess-1', {
      token: 'sf-token',
      buyer_type: 'COMPANY',
      company: {
        company_name: 'Neronet Academy AB',
        org_number: '556737-0431',
      },
    });
    expect(orders.quoteLines.mock.calls[0][2]).toMatchObject({
      buyerType: 'COMPANY',
    });
    const payload = updateCheckout.mock.calls[0][1];
    expect(payload.customer).toEqual({
      type: 'organization',
      organization_registration_id: '556737-0431',
    });
    const stored = prisma.kustomCheckoutSession.updateMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(stored.data).toMatchObject({
      buyer_type: 'COMPANY',
      company: { company_name: 'Neronet Academy AB' },
    });
  });

  it('a COMPANY request on a store without the app is refused', async () => {
    const { service } = build(null, { session: sessionRow() });
    await expect(
      service.updateSession('sess-1', {
        token: 'sf-token',
        buyer_type: 'COMPANY',
      }),
    ).rejects.toMatchObject({ response: { code: 'B2B_COMPANY_NOT_ALLOWED' } });
  });
});

describe('KustomCheckoutService.handleValidation with the b2b app', () => {
  const body = {
    order_id: 'k-1',
    order_amount: 29900,
    purchase_currency: 'SEK',
    billing_address: kustomAddress,
    shipping_address: kustomAddress,
  };

  it('organisation body → orders.create gets COMPANY + the company Kustom reported (VAT from the prefill)', async () => {
    const { service, prisma, orders } = build(null, {
      b2b: true,
      session: sessionRow({
        buyer_type: 'COMPANY',
        company: { ...companyPrefill, customer_type: 'COMPANY' },
      }),
      customer: loggedIn,
    });
    const res = await service.handleValidation('sess-1', 'cb-token', {
      ...body,
      customer: {
        type: 'organization',
        organization_registration_id: '556036-0793',
      },
      billing_address: {
        ...kustomAddress,
        organization_name: 'Kustom Org AB',
        buyer_reference: 'PO-4711',
      },
    });
    expect(res).toEqual({ ok: true, body: { ok: true } });
    const company = {
      company_name: 'Kustom Org AB',
      org_number: '556036-0793',
      vat_number: 'SE556737043101',
      buyer_reference: 'PO-4711',
    };
    expect(orders.create).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ buyer_type: 'COMPANY', company }),
      expect.objectContaining({
        companySnapshot: { customer_type: 'COMPANY', ...company },
      }),
    );
    expect(orders.quoteLines.mock.calls[0][2]).toMatchObject({
      buyerType: 'COMPANY',
    });
    const address = prisma.address.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(address.data).toMatchObject({
      company_name: 'Kustom Org AB',
      org_number: '556036-0793',
      buyer_reference: 'PO-4711',
    });
    expect(prisma.address.findFirst.mock.calls[0][0]).toMatchObject({
      where: { company_name: 'Kustom Org AB', org_number: '556036-0793' },
    });
  });

  it('organisation flow without any name or number → a person order', async () => {
    const { service, orders } = build(null, {
      b2b: true,
      session: sessionRow(),
      customer: loggedIn,
    });
    const res = await service.handleValidation('sess-1', 'cb-token', {
      ...body,
      customer: { type: 'organization' },
    });
    expect(res).toEqual({ ok: true, body: { ok: true } });
    const createDto = orders.create.mock.calls[0][1] as Record<string, unknown>;
    expect(createDto).not.toHaveProperty('buyer_type');
    expect(createDto).not.toHaveProperty('company');
  });

  it('a malformed organisation number is stored as reported, never a 400', async () => {
    const { service, orders } = build(null, {
      b2b: true,
      session: sessionRow(),
      customer: loggedIn,
    });
    const res = await service.handleValidation('sess-1', 'cb-token', {
      ...body,
      customer: { type: 'organization', organization_registration_id: 'ABC' },
      billing_address: { ...kustomAddress, organization_name: 'Odd AB' },
    });
    expect(res).toEqual({ ok: true, body: { ok: true } });
    const createDto = orders.create.mock.calls[0][1] as Record<string, unknown>;
    expect(createDto.buyer_type).toBe('COMPANY');
    expect(createDto.company).toMatchObject({
      company_name: 'Odd AB',
      org_number: 'ABC',
    });
  });

  it('person body → no b2b keys anywhere', async () => {
    const { service, prisma, orders } = build(null, {
      b2b: true,
      session: sessionRow({
        buyer_type: 'COMPANY',
        company: { ...companyPrefill, customer_type: 'COMPANY' },
      }),
      customer: loggedIn,
    });
    await service.handleValidation('sess-1', 'cb-token', {
      ...body,
      customer: { type: 'person' },
    });
    const [, createDto, createOpts] = orders.create.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(createDto).not.toHaveProperty('buyer_type');
    expect(createDto).not.toHaveProperty('company');
    expect(createOpts).not.toHaveProperty('companySnapshot');
    expect(orders.quoteLines.mock.calls[0][2]).not.toHaveProperty('buyerType');
    const address = prisma.address.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(address.data).toMatchObject({
      company_name: null,
      org_number: null,
      buyer_reference: null,
    });
  });

  it('without the app an organisation body is stored as a person', async () => {
    const { service, orders } = build(null, {
      session: sessionRow(),
      customer: loggedIn,
    });
    await service.handleValidation('sess-1', 'cb-token', {
      ...body,
      customer: { type: 'organization', organization_registration_id: '1' },
    });
    const createDto = orders.create.mock.calls[0][1] as Record<string, unknown>;
    expect(createDto).not.toHaveProperty('buyer_type');
    expect(createDto).not.toHaveProperty('company');
  });
});

describe('KustomCheckoutService designer ownership (M4.2 fixes)', () => {
  const D1 = '99999999-9999-4999-8999-999999999991';

  it('verifies the raw lines (with tokens) before storing; verified lines are marked', async () => {
    const designerCart = {
      verifySessionDesigns: jest.fn(() => Promise.resolve(new Set([D1]))),
    };
    const { service, prisma, orders } = build(null, { designerCart });
    await service.createSession(null, {
      store_slug: 'namez',
      items: [
        { product_id: 'p1', quantity: 1, design_id: D1, design_token: 'tok' },
        { product_id: 'p2', quantity: 1 },
      ],
    } as never);
    expect(designerCart.verifySessionDesigns).toHaveBeenCalledWith(
      STORE_ID,
      [
        expect.objectContaining({ design_id: D1, design_token: 'tok' }),
        expect.objectContaining({ product_id: 'p2', design_id: null }),
      ],
      null,
      [],
    );
    const items = prisma.kustomCheckoutSession.create.mock.calls[0][0].data
      .items as Record<string, unknown>[];
    // The token is never stored; the verification is.
    expect(items[0]).toMatchObject({ design_id: D1, design_verified: true });
    expect(items[0]).not.toHaveProperty('design_token');
    expect(items[1]).not.toHaveProperty('design_verified');
    // Order-bound quote: only the verified designs are priced.
    expect(orders.quoteLines).toHaveBeenCalledWith(
      STORE_ID,
      expect.any(Array),
      expect.objectContaining({
        designOwnership: { customerId: null, verifiedDesignIds: [D1] },
      }),
    );
  });

  it('an unverifiable design fails the session create (nothing stored)', async () => {
    const designerCart = {
      verifySessionDesigns: jest.fn(() =>
        Promise.reject(new Error('DESIGNER_DESIGN_FORBIDDEN')),
      ),
    };
    const { service, prisma } = build(null, { designerCart });
    await expect(
      service.createSession(null, {
        store_slug: 'namez',
        items: [{ product_id: 'p1', quantity: 1, design_id: D1 }],
      } as never),
    ).rejects.toThrow('DESIGNER_DESIGN_FORBIDDEN');
    expect(prisma.kustomCheckoutSession.create).not.toHaveBeenCalled();
  });

  it('no design lines: no verification call, lines stored as before', async () => {
    const designerCart = { verifySessionDesigns: jest.fn() };
    const { service, prisma } = build(null, { designerCart });
    await service.createSession(null, dto);
    expect(designerCart.verifySessionDesigns).not.toHaveBeenCalled();
    expect(
      prisma.kustomCheckoutSession.create.mock.calls[0][0].data.items,
    ).toEqual([
      {
        product_id: 'p1',
        custom_product_id: null,
        variant_id: null,
        bundle_offer_id: null,
        quantity: 1,
        custom_fields: null,
      },
    ]);
  });
});
