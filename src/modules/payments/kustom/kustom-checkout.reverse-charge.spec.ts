import { Logger } from '@nestjs/common';
import { Prisma, StoreType } from '@prisma/client';
import { KustomCheckoutService } from './kustom-checkout.service';
import { KustomClient } from './kustom.client';
import type { KustomService, StoreContext } from './kustom.service';
import type { OrdersService } from '../../orders/orders.service';
import type { MailService } from '../../mail/mail.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { MarketsContextService } from '../../markets/markets-context.service';
import { B2bService } from '../../b2b/b2b.service';
import { B2bTaxExemptionService } from '../../b2b/b2b-tax-exemption.service';
import {
  decideTaxExemption,
  type ExemptionInputs,
} from '../../b2b/reverse-charge';
import type { VatEvidence } from '../../b2b/b2b.types';
import type { ViesService } from '../../b2b/vies/vies.service';
import type { StoreAppsService } from '../../store-apps/store-apps.service';

// b2b app M2.5 in the session-first Kustom flow: the VAT number is checked
// against VIES only by createSession / updateSession; every re-price (incl.
// the address callback and the 3 s validation) re-takes the decision from
// the evidence stored on the session, for the destination Kustom reports.

jest.mock('./kustom.client', () => ({
  ...jest.requireActual<typeof import('./kustom.client')>('./kustom.client'),
  KustomClient: jest.fn(),
}));

const STORE_ID = 's1';

const storeCtx: StoreContext = {
  id: STORE_ID,
  slug: 'namez',
  customDomain: null,
  name: 'Store',
  termsPath: null,
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

function evidence(
  vat = 'DE123456789',
  status: VatEvidence['status'] = 'valid',
): VatEvidence {
  return {
    source: 'VIES',
    vat_number: vat,
    country_code: vat.slice(0, 2),
    status,
    valid: status === 'valid',
    name: status === 'valid' ? 'Muster GmbH' : null,
    address: null,
    request_identifier: 'req-1',
    requester: 'SE556036079301',
    checked_at: new Date().toISOString(),
    check_id: 'chk-1',
    error_code: null,
  };
}

interface QuoteOpts {
  countryCode: string | null;
  buyerType?: string;
  exemptionInputs?: ExemptionInputs | null;
}

/**
 * Stand-in for OrdersService.quoteLines: an SE store (INCLUSIVE, 'net'
 * reverse-charge pricing) selling one 125 SEK item at 25 %. It takes the
 * real decideTaxExemption() over the inputs it is handed, so the test sees
 * exactly what the Kustom service feeds the pricing.
 */
function quoteFor(opts: QuoteOpts) {
  const inputs = opts.exemptionInputs ?? null;
  const decision = decideTaxExemption({
    ctx: { registrant: 'STORE', taxCountry: 'SE' },
    destinationCountry: opts.countryCode,
    buyerType: opts.buyerType === 'COMPANY' ? 'COMPANY' : 'PERSON',
    inputs,
  });
  const exempt = decision.reason !== null;
  const unit = exempt ? 100 : 125;
  const tax = exempt ? 0 : 25;
  return {
    items: [
      {
        product_id: 'p1',
        variant_id: null,
        custom_product_id: null,
        bundle_offer_id: null,
        quantity: 1,
        unit_price: unit,
        original_unit_price: null,
        total_price: unit,
        tax_rate_bp: exempt ? 0 : 2500,
        tax_amount: tax,
        tax_class_key: null,
      },
    ],
    subtotal: unit,
    shipping_cost: 0,
    discount_amount: 0,
    total: unit,
    currency: 'SEK',
    tax_rate_bp: exempt ? 0 : 2500,
    tax_amount: tax,
    tax_lines: exempt
      ? [
          {
            label: 'Reverse charge',
            rate_bp: 0,
            taxable_amount: unit,
            tax_amount: 0,
            exempt_reason: decision.reason,
          },
        ]
      : [{ label: 'Moms', rate_bp: 2500, taxable_amount: 100, tax_amount: 25 }],
    tax_total: tax,
    tax_pricing_mode: 'INCLUSIVE' as const,
    tax_basis_country: opts.countryCode,
    shipping_tax_amount: 0,
    shipping_tax_rate_bp: 0,
    shipping: null,
    coupon: null,
    ...(inputs
      ? {
          tax_exempt_reason: decision.reason,
          tax_exemption: {
            reason: decision.reason,
            vat_number: inputs.vat?.vat_number ?? null,
            name: inputs.vat?.name ?? null,
            checked_at: inputs.vat?.checked_at ?? null,
            why: decision.reason ? null : decision.why,
          },
        }
      : {}),
  };
}

function build(
  opts: {
    reverseCharge?: boolean;
    session?: Record<string, unknown> | null;
    customer?: Record<string, unknown> | null;
    exemption?: Record<string, unknown> | null;
    existingUser?: Record<string, unknown> | null;
    vies?: VatEvidence['status'];
  } = {},
) {
  const rc = opts.reverseCharge ?? true;
  const prisma = {
    kustomCheckoutSession: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...data, kustom_order_id: null }),
      ),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...opts.session, ...data }),
      ),
      findUnique: jest.fn(() => Promise.resolve(opts.session ?? null)),
      updateMany: jest.fn((_args: unknown) => Promise.resolve({ count: 1 })),
      delete: jest.fn(() => Promise.resolve()),
      deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
    customer: {
      findUnique: jest.fn(() => Promise.resolve(opts.customer ?? null)),
      create: jest.fn(() => Promise.resolve({ id: 'c9' })),
    },
    user: {
      findUnique: jest.fn(() => Promise.resolve(opts.existingUser ?? null)),
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
    storeCustomerTaxExemption: {
      findFirst: jest.fn(
        (args: { where: { customer_id: string } }): Promise<unknown> =>
          Promise.resolve(
            opts.exemption &&
              opts.exemption.customer_id === args.where.customer_id
              ? opts.exemption
              : null,
          ),
      ),
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
  let lastTotal = 125;
  const orders = {
    quoteLines: jest.fn((_storeId: string, _lines: unknown, o: QuoteOpts) => {
      const quote = quoteFor(o);
      lastTotal = quote.total;
      return Promise.resolve(quote);
    }),
    // orders.create prices with the inputs it is handed; the stand-in
    // returns the total of the quote taken just before it.
    create: jest.fn((_userId: string, _dto: unknown, _opts: unknown) =>
      Promise.resolve({ id: 'o1', total: lastTotal, currency: 'SEK' }),
    ),
    validatedHostname: jest.fn(),
  };
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(true)),
    getSettings: jest.fn(() => Promise.resolve({ reverse_charge_enabled: rc })),
  };
  const b2b = new B2bService(storeApps as unknown as StoreAppsService);
  const vies = {
    check: jest.fn((vat: string, _opts?: unknown) =>
      Promise.resolve(evidence(vat.replace(/\s/g, ''), opts.vies ?? 'valid')),
    ),
    requesterFor: jest.fn(() => Promise.resolve('SE556036079301')),
  };
  const b2bTax = new B2bTaxExemptionService(
    prisma as unknown as PrismaService,
    b2b,
    vies as unknown as ViesService,
  );
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
    {
      resolve: jest.fn(() => Promise.resolve(null)),
    } as unknown as MarketsContextService,
    b2b,
    b2bTax,
  );
  return { service, prisma, orders, vies, createCheckout, updateCheckout };
}

const company = {
  customer_type: 'COMPANY',
  company_name: 'Muster GmbH',
  org_number: 'HRB 1234',
  vat_number: 'DE123456789',
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
    country_code: 'DE',
    region: null,
    postcode: null,
    purchase_country: 'SE',
    shipping_method_id: null,
    shipping_cost: null,
    kustom_order_id: 'k-1',
    order_id: null,
    market_id: null,
    hostname: null,
    buyer_type: 'COMPANY',
    company,
    vat_validation: evidence(),
    expires_at: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

const address = (country: string) => ({
  given_name: 'Max',
  family_name: 'Muster',
  email: 'max@example.com',
  street_address: 'Musterstr. 1',
  postal_code: '10115',
  city: 'Berlin',
  country,
});

const loggedIn = { id: 'c1', user: { id: 'u1', email: 'max@example.com' } };

type QuoteCall = [string, unknown, QuoteOpts];

describe('Kustom session-first + reverse charge: createSession', () => {
  it('checks the VAT number live (source kustom) and stores the evidence on the session', async () => {
    const { service, prisma, orders, vies } = build();
    const res = await service.createSession(null, {
      store_slug: 'namez',
      items: [{ product_id: 'p1', quantity: 1 }],
      buyer_type: 'COMPANY',
      company: {
        company_name: 'Muster GmbH',
        org_number: 'HRB 1234',
        vat_number: 'DE 123 456 789',
      },
    });
    expect(vies.check).toHaveBeenCalledTimes(1);
    expect(vies.check.mock.calls[0][1]).toMatchObject({
      source: 'kustom',
      mode: 'live',
    });
    const created = prisma.kustomCheckoutSession.create.mock.calls[0][0].data;
    expect(created.vat_validation).toMatchObject({
      vat_number: 'DE123456789',
      status: 'valid',
    });
    const quoteOpts = (orders.quoteLines.mock.calls[0] as QuoteCall)[2];
    expect(quoteOpts.exemptionInputs?.vat?.vat_number).toBe('DE123456789');
    // The default destination of an SEK store is SE: same country, VAT.
    expect(res.totals).toMatchObject({
      tax_exempt_reason: null,
      tax_exemption: { reason: null, why: 'SAME_COUNTRY' },
    });
    // Not exempt: no items key (response unchanged).
    expect(res.totals).not.toHaveProperty('items');
  });

  it('reverse charge off: no VIES call, no evidence, no tax_exemption keys', async () => {
    const { service, prisma, orders, vies } = build({ reverseCharge: false });
    const res = await service.createSession(null, {
      store_slug: 'namez',
      items: [{ product_id: 'p1', quantity: 1 }],
      buyer_type: 'COMPANY',
      company: {
        company_name: 'Muster GmbH',
        org_number: 'HRB 1234',
        vat_number: 'DE123456789',
      },
    });
    expect(vies.check).not.toHaveBeenCalled();
    const created = prisma.kustomCheckoutSession.create.mock.calls[0][0].data;
    expect(created).not.toHaveProperty('vat_validation');
    expect(
      (orders.quoteLines.mock.calls[0] as QuoteCall)[2].exemptionInputs,
    ).toBeNull();
    expect(res.totals).not.toHaveProperty('tax_exemption');
    expect(res.totals).not.toHaveProperty('tax_exempt_reason');
    expect(res.totals).not.toHaveProperty('items');
  });
});

describe('Kustom session-first + reverse charge: updateSession', () => {
  it('re-checks when the VAT number changes and prices with the new evidence', async () => {
    const { service, prisma, orders, vies } = build({
      session: sessionRow(),
    });
    const res = await service.updateSession('sess-1', {
      token: 'sf-token',
      buyer_type: 'COMPANY',
      company: {
        company_name: 'Muster GmbH',
        org_number: 'HRB 1234',
        vat_number: 'FR40303265045',
      },
    });
    expect(vies.check).toHaveBeenCalledTimes(1);
    const stored = prisma.kustomCheckoutSession.updateMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(stored.data.vat_validation).toMatchObject({
      vat_number: 'FR40303265045',
    });
    expect(
      (orders.quoteLines.mock.calls[0] as QuoteCall)[2].exemptionInputs?.vat
        ?.vat_number,
    ).toBe('FR40303265045');
    // Session destination DE, FR number: reverse charge (no country match
    // required, Shopify rule).
    expect(res.totals).toMatchObject({ tax_exempt_reason: 'REVERSE_CHARGE' });
    // Exempt session: the exact (netted) quoted lines are included.
    expect(res.totals?.items).toEqual([
      {
        product_id: 'p1',
        variant_id: null,
        custom_product_id: null,
        bundle_offer_id: null,
        quantity: 1,
        unit_price: 100,
        total: 100,
      },
    ]);
  });

  it('valid evidence older than 24 h is re-checked live', async () => {
    const old = {
      ...evidence(),
      checked_at: new Date(Date.now() - 25 * 3_600_000).toISOString(),
    };
    const { service, prisma, vies } = build({
      session: sessionRow({ vat_validation: old }),
    });
    await service.updateSession('sess-1', {
      token: 'sf-token',
      items: [{ product_id: 'p1', quantity: 2 }],
    });
    expect(vies.check).toHaveBeenCalledTimes(1);
    expect(vies.check.mock.calls[0][1]).toMatchObject({ mode: 'live' });
    const stored = prisma.kustomCheckoutSession.updateMany.mock.calls[0][0] as {
      data: { vat_validation?: { checked_at: string } };
    };
    expect(stored.data.vat_validation?.checked_at).not.toBe(old.checked_at);
  });

  it('an unchanged, valid number is not re-checked', async () => {
    const { service, prisma, vies } = build({ session: sessionRow() });
    await service.updateSession('sess-1', {
      token: 'sf-token',
      items: [{ product_id: 'p1', quantity: 2 }],
    });
    expect(vies.check).not.toHaveBeenCalled();
    const stored = prisma.kustomCheckoutSession.updateMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(stored.data).not.toHaveProperty('vat_validation');
  });

  it('switching to a person clears the evidence', async () => {
    const { service, prisma, vies } = build({ session: sessionRow() });
    await service.updateSession('sess-1', {
      token: 'sf-token',
      buyer_type: 'PERSON',
      company: null,
    });
    expect(vies.check).not.toHaveBeenCalled();
    const stored = prisma.kustomCheckoutSession.updateMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(stored.data.vat_validation).toBe(Prisma.DbNull);
  });
});

describe('Kustom session-first + reverse charge: callbacks', () => {
  it('address update re-prices with the session evidence; DE → SE re-adds the VAT', async () => {
    const { service, orders, vies } = build({
      session: sessionRow({ country_code: 'SE' }),
    });
    const toDe = await service.handleAddressUpdate('sess-1', 'cb-token', {
      shipping_address: address('DE'),
    });
    const toSe = await service.handleAddressUpdate('sess-1', 'cb-token', {
      shipping_address: address('SE'),
    });
    expect(vies.check).not.toHaveBeenCalled();
    const calls = orders.quoteLines.mock.calls as QuoteCall[];
    expect(calls[0][2]).toMatchObject({
      countryCode: 'DE',
      buyerType: 'COMPANY',
    });
    expect(calls[0][2].exemptionInputs?.vat?.status).toBe('valid');
    const body = (r: typeof toDe) =>
      (r as { body: { order_amount: number; order_tax_amount: number } }).body;
    expect(body(toDe)).toMatchObject({
      order_amount: 10000,
      order_tax_amount: 0,
    });
    expect(body(toSe).order_amount).toBe(12500);
    expect(body(toSe).order_tax_amount).toBeGreaterThan(0);
  });

  it('validation makes no VIES call and hands orders.create the same inputs as the quote', async () => {
    const { service, orders, vies } = build({
      session: sessionRow(),
      customer: loggedIn,
    });
    const res = await service.handleValidation('sess-1', 'cb-token', {
      order_id: 'k-1',
      order_amount: 10000,
      purchase_currency: 'SEK',
      customer: { type: 'organization', vat_id: 'DE123456789' },
      billing_address: { ...address('DE'), organization_name: 'Muster GmbH' },
      shipping_address: address('DE'),
    });
    expect(res).toEqual({ ok: true, body: { ok: true } });
    expect(vies.check).not.toHaveBeenCalled();
    const quoteInputs = (orders.quoteLines.mock.calls[0] as QuoteCall)[2]
      .exemptionInputs;
    const [, , createOpts] = orders.create.mock.calls[0] as [
      string,
      unknown,
      { exemptionInputs?: ExemptionInputs | null },
    ];
    expect(createOpts.exemptionInputs).toBe(quoteInputs);
    expect(createOpts.exemptionInputs?.vat).toMatchObject({
      vat_number: 'DE123456789',
      status: 'valid',
    });
  });

  it('a different customer.vat_id from Kustom keeps the validated number (and is logged)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { service, orders } = build({
      session: sessionRow(),
      customer: loggedIn,
    });
    const res = await service.handleValidation('sess-1', 'cb-token', {
      order_id: 'k-1',
      order_amount: 10000,
      purchase_currency: 'SEK',
      customer: { type: 'organization', vat_id: 'DE999999999' },
      billing_address: { ...address('DE'), organization_name: 'Muster GmbH' },
      shipping_address: address('DE'),
    });
    expect(res).toEqual({ ok: true, body: { ok: true } });
    const createDto = orders.create.mock.calls[0][1] as {
      company: { vat_number: string };
    };
    expect(createDto.company.vat_number).toBe('DE123456789');
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes('DE***9999')),
    ).toBe(true);
    // Masked: the full numbers never reach the log.
    expect(
      warn.mock.calls.some((c) => /DE999999999|DE123456789/.test(String(c[0]))),
    ).toBe(false);
    warn.mockRestore();
  });

  it('a destination flipped to the seller country rejects a stale RC amount', async () => {
    const { service, orders } = build({
      session: sessionRow(),
      customer: loggedIn,
    });
    const res = await service.handleValidation('sess-1', 'cb-token', {
      order_id: 'k-1',
      order_amount: 10000,
      purchase_currency: 'SEK',
      customer: { type: 'organization' },
      billing_address: { ...address('SE'), organization_name: 'Muster GmbH' },
      shipping_address: address('SE'),
    });
    expect(res).toMatchObject({ ok: false });
    expect((res as { redirectUrl: string }).redirectUrl).toContain(
      'reason=amount_changed',
    );
    expect(orders.create).not.toHaveBeenCalled();
  });

  it('a guest who resolves to an exempt account at validation is NOT exempted', async () => {
    const { service, orders, prisma } = build({
      session: sessionRow({
        customer_id: null,
        buyer_type: null,
        company: null,
        vat_validation: null,
      }),
      existingUser: {
        id: 'u9',
        email: 'max@example.com',
        role: 'CUSTOMER',
        customer: { id: 'c9' },
      },
      exemption: {
        id: 'ex1',
        customer_id: 'c9',
        kind: 'FULL',
        vat_number: null,
        note: null,
      },
    });
    const res = await service.handleValidation('sess-1', 'cb-token', {
      order_id: 'k-1',
      order_amount: 12500,
      purchase_currency: 'SEK',
      customer: { type: 'person' },
      billing_address: address('DE'),
      shipping_address: address('DE'),
    });
    expect(res).toEqual({ ok: true, body: { ok: true } });
    expect(prisma.storeCustomerTaxExemption.findFirst).not.toHaveBeenCalled();
    const [userId, , createOpts] = orders.create.mock.calls[0] as [
      string,
      unknown,
      { exemptionInputs?: ExemptionInputs | null },
    ];
    expect(userId).toBe('u9');
    expect(createOpts.exemptionInputs?.customerExemption).toBeNull();
  });

  it('the same exemption applies when the customer was known when the session opened', async () => {
    const { service, orders } = build({
      session: sessionRow({
        customer_id: 'c1',
        buyer_type: null,
        company: null,
        vat_validation: null,
      }),
      customer: loggedIn,
      exemption: {
        id: 'ex1',
        customer_id: 'c1',
        kind: 'FULL',
        vat_number: null,
        note: null,
      },
    });
    const res = await service.handleValidation('sess-1', 'cb-token', {
      order_id: 'k-1',
      order_amount: 10000,
      purchase_currency: 'SEK',
      customer: { type: 'person' },
      billing_address: address('SE'),
      shipping_address: address('SE'),
    });
    expect(res).toEqual({ ok: true, body: { ok: true } });
    const [, , createOpts] = orders.create.mock.calls[0] as [
      string,
      unknown,
      { exemptionInputs?: ExemptionInputs | null },
    ];
    expect(createOpts.exemptionInputs?.customerExemption).toMatchObject({
      kind: 'FULL',
    });
  });
});

describe('Kustom session-first + reverse charge: review fixes', () => {
  it('invalid stored evidence does not override the VAT number Kustom reports', async () => {
    const { service, orders } = build({
      session: sessionRow({
        vat_validation: evidence('DE123456789', 'invalid'),
      }),
      customer: loggedIn,
    });
    const res = await service.handleValidation('sess-1', 'cb-token', {
      order_id: 'k-1',
      order_amount: 12500,
      purchase_currency: 'SEK',
      customer: { type: 'organization', vat_id: 'FR40303265045' },
      billing_address: { ...address('DE'), organization_name: 'Muster GmbH' },
      shipping_address: address('DE'),
    });
    expect(res).toEqual({ ok: true, body: { ok: true } });
    const createDto = orders.create.mock.calls[0][1] as {
      company: { vat_number: string };
    };
    expect(createDto.company.vat_number).toBe('FR40303265045');
  });

  it('address callback with reverse charge off keeps the pre-M2.5 pricing path', async () => {
    const { service, orders, prisma } = build({
      reverseCharge: false,
      session: sessionRow({ vat_validation: null }),
    });
    const res = await service.handleAddressUpdate('sess-1', 'cb-token', {
      shipping_address: address('DE'),
      customer: { type: 'organization', vat_id: 'DE123456789' },
    });
    expect(res).toMatchObject({ ok: true });
    const opts = (orders.quoteLines.mock.calls[0] as QuoteCall)[2];
    expect(opts).not.toHaveProperty('buyerType');
    expect(opts.exemptionInputs).toBeNull();
    expect(prisma.storeCustomerTaxExemption.findFirst).not.toHaveBeenCalled();
  });
});
