import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { MarketStatus, Prisma } from '@prisma/client';
import { MarketsService } from './markets.service';
import { MarketsController } from './markets.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsContextService } from './markets-context.service';
import { FxService } from './fx.service';
import { DomainsService } from './domains.service';
import { MarketPricingService } from './market-pricing.service';
import { PaymentCheckService } from './payment-check.service';
import type { CreateMarketDto } from './dto/market.dto';
import type { PaymentCheck, PaymentProviderCheck } from './market.types';

// M157: MarketsService persists payment_methods (validated, sorted), clears
// it with null, keeps it when omitted, gates LIVE markets on the allowed
// methods only, and reports which methods the store offers.

const USER_ID = 'u1';
const STORE_ID = 's1';

type Row = Record<string, unknown> & {
  id: string;
  payment_methods: unknown;
  status: MarketStatus;
};

function market(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    store_id: STORE_ID,
    key: id,
    name: id,
    countries: ['DE', 'AT'],
    default_locale: 'en',
    locales: [],
    currency: 'EUR',
    is_default: false,
    is_x_default: false,
    status: MarketStatus.DRAFT,
    indexing: 'AUTO',
    price_rule: { mode: 'convert', source: 'manual', rate: 0.09 },
    payment_check: null,
    domains: [{ status: 'ACTIVE', redirect_to: null, hostname: 'x.test' }],
    locale_paths: null,
    payment_methods: null,
    ...over,
  };
}

function check(
  stripe: PaymentProviderCheck,
  kustom: PaymentProviderCheck,
): PaymentCheck {
  return { stripe, kustom, checked_at: '2026-11-21T00:00:00Z', details: {} };
}

/** Prisma writes DbNull as SQL NULL; the fake stores null. */
function stored(data: Record<string, unknown>): Record<string, unknown> {
  return data.payment_methods === Prisma.DbNull
    ? { ...data, payment_methods: null }
    : data;
}

interface StoreFixture {
  store_type: string;
  cod_enabled: boolean;
  stripe_keys: { status: string; livemode: boolean } | null;
  creator: Record<string, unknown>;
}

const KUSTOM_READY = {
  kustom_enabled: true,
  kustom_merchant_id: 'M1',
  kustom_shared_secret: 'enc',
};
const KUSTOM_OFF = {
  kustom_enabled: false,
  kustom_merchant_id: null,
  kustom_shared_secret: null,
};

function build(
  rows: Row[],
  opts: { check?: PaymentCheck; store?: StoreFixture } = {},
) {
  const prisma = {
    creator: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          store: {
            id: STORE_ID,
            slug: 'namez-se',
            name: 'Namez',
            creator_id: 'c1',
            store_type: 'INDEPENDENT',
            currency: 'SEK',
          },
        }),
      ),
    },
    store: {
      update: jest.fn(() => Promise.resolve({})),
      findUnique: jest.fn(() => Promise.resolve(opts.store ?? null)),
    },
    market: {
      findFirst: jest.fn(
        ({ where }: { where: { id?: string; countries?: unknown } }) =>
          // assertNoCountryOverlap asks for another LIVE market: none here.
          where.countries
            ? Promise.resolve(null)
            : Promise.resolve(rows.find((r) => r.id === where.id) ?? null),
      ),
      findUnique: jest.fn(() => Promise.resolve(null)),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Row }) => {
          const row = rows.find((r) => r.id === where.id)!;
          Object.assign(row, stored(data));
          return Promise.resolve(row);
        },
      ),
      create: jest.fn(({ data }: { data: Row }) => {
        const row = market(`m-${String(data.key)}`, stored(data));
        rows.push(row);
        return Promise.resolve(row);
      }),
    },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'SEK' })),
    },
    platformFxRate: { findUnique: jest.fn(() => Promise.resolve(null)) },
    storeLanguageConfig: { upsert: jest.fn(() => Promise.resolve({})) },
  };
  const ctx = { invalidate: jest.fn() };
  const checkMarket = jest.fn(() =>
    Promise.resolve(opts.check ?? check('ok', 'ok')),
  );
  const service = new MarketsService(
    prisma as unknown as PrismaService,
    { get: () => 'https://stores.platform.test' } as unknown as ConfigService,
    {
      revalidateStoreById: jest.fn(() => Promise.resolve()),
    } as unknown as RevalidationService,
    {} as StoreAppsService,
    ctx as unknown as MarketsContextService,
    new FxService(prisma as unknown as PrismaService),
    { toView: (d: unknown) => d } as unknown as DomainsService,
    {} as MarketPricingService,
    { checkMarket } as unknown as PaymentCheckService,
  );
  jest
    .spyOn(service, 'ensureDefaultMarket')
    .mockResolvedValue(undefined as never);
  return { service, prisma, ctx, checkMarket };
}

async function codeOf(p: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse() as Record<
      string,
      unknown
    >;
  }
  throw new Error('expected a BadRequestException');
}

const CREATE_DTO: CreateMarketDto = {
  key: 'eu',
  name: 'EU',
  countries: ['DE'],
  default_locale: 'en',
  locales: [],
  currency: 'EUR',
  price_rule: { mode: 'convert', source: 'manual', rate: 0.09 },
};

describe('MarketsService payment_methods (M157) — create / update / view', () => {
  it('create stores the sorted list; the view returns it', async () => {
    const rows: Row[] = [];
    const { service, prisma } = build(rows);
    const view = await service.create(USER_ID, {
      ...CREATE_DTO,
      payment_methods: ['kustom', 'card'],
    });
    const data = prisma.market.create.mock.calls[0][0].data;
    expect(data.payment_methods).toEqual(['card', 'kustom']);
    expect(view.payment_methods).toEqual(['card', 'kustom']);
  });

  it('create without the field (or null) leaves the column out; view null', async () => {
    for (const extra of [{}, { payment_methods: null }]) {
      const rows: Row[] = [];
      const { service, prisma } = build(rows);
      const view = await service.create(USER_ID, { ...CREATE_DTO, ...extra });
      const data = prisma.market.create.mock.calls[0][0].data;
      expect('payment_methods' in data).toBe(false);
      expect(view.payment_methods).toBeNull();
    }
  });

  it('create refuses an invalid list with the coded 400 (nothing written)', async () => {
    const { service, prisma } = build([]);
    const body = await codeOf(
      service.create(USER_ID, { ...CREATE_DTO, payment_methods: [] }),
    );
    expect(body).toEqual(
      expect.objectContaining({
        code: 'MARKET_PAYMENT_METHODS_INVALID',
        reason: 'empty',
      }),
    );
    expect(prisma.market.create).not.toHaveBeenCalled();
  });

  it('update: omitted -> untouched, no payment re-check', async () => {
    const rows = [market('m-eu', { payment_methods: ['card'] })];
    const { service, prisma, checkMarket } = build(rows);
    const view = await service.update(USER_ID, 'm-eu', { name: 'Europe' });
    const data = prisma.market.update.mock.calls[0][0].data;
    expect('payment_methods' in data).toBe(false);
    expect(checkMarket).not.toHaveBeenCalled();
    expect(view.payment_methods).toEqual(['card']);
  });

  it('update: null -> Prisma.DbNull (cleared, the store methods)', async () => {
    const rows = [market('m-eu', { payment_methods: ['card'] })];
    const { service, prisma } = build(rows);
    const view = await service.update(USER_ID, 'm-eu', {
      payment_methods: null,
    });
    const data = prisma.market.update.mock.calls.at(-1)![0].data;
    expect(data.payment_methods).toBe(Prisma.DbNull);
    expect(view.payment_methods).toBeNull();
  });

  it('update: a set value is validated (unknown / duplicate) before any write', async () => {
    const rows = [market('m-eu')];
    const { service, prisma } = build(rows);
    expect(
      await codeOf(
        service.update(USER_ID, 'm-eu', { payment_methods: ['card', 'card'] }),
      ),
    ).toEqual(expect.objectContaining({ reason: 'duplicate' }));
    expect(
      await codeOf(
        service.update(USER_ID, 'm-eu', { payment_methods: ['bitcoin'] }),
      ),
    ).toEqual(expect.objectContaining({ reason: 'unknown', value: 'bitcoin' }));
    expect(prisma.market.update).not.toHaveBeenCalled();
  });

  it('DRAFT market accepts a restriction whose provider is not ready', async () => {
    const rows = [market('m-eu')];
    const { service } = build(rows, { check: check('missing', 'missing') });
    const view = await service.update(USER_ID, 'm-eu', {
      payment_methods: ['card'],
    });
    expect(view.payment_methods).toEqual(['card']);
  });

  it('LIVE market narrowing to a provider that is not ok -> MARKET_PAYMENT_METHODS_NOT_READY, row unchanged, check stored', async () => {
    const rows = [market('m-eu', { status: MarketStatus.LIVE })];
    const failing = check('missing', 'ok');
    const { service, prisma, ctx } = build(rows, { check: failing });
    const body = await codeOf(
      service.update(USER_ID, 'm-eu', { payment_methods: ['card'] }),
    );
    expect(body.code).toBe('MARKET_PAYMENT_METHODS_NOT_READY');
    expect(prisma.market.update).toHaveBeenCalledTimes(1);
    expect(prisma.market.update.mock.calls[0][0].data).toEqual({
      payment_check: failing,
    });
    expect(rows[0].payment_methods).toBeNull();
    expect(ctx.invalidate).toHaveBeenCalled();
  });

  it('LIVE market narrowing to a ready provider passes (Namez SE: kustom only)', async () => {
    const rows = [
      market('m-se', {
        status: MarketStatus.LIVE,
        is_default: true,
        currency: 'SEK',
      }),
    ];
    const { service, checkMarket } = build(rows, {
      check: check('missing', 'ok'),
    });
    const view = await service.update(USER_ID, 'm-se', {
      payment_methods: ['kustom'],
    });
    expect(checkMarket).toHaveBeenCalledTimes(1);
    expect(view.payment_methods).toEqual(['kustom']);
  });

  it('LIVE market: sending the same set again does not re-run the check', async () => {
    const rows = [
      market('m-eu', {
        status: MarketStatus.LIVE,
        payment_methods: ['card', 'kustom'],
      }),
    ];
    const { service, checkMarket } = build(rows, {
      check: check('missing', 'missing'),
    });
    await service.update(USER_ID, 'm-eu', {
      payment_methods: ['kustom', 'card'],
    });
    expect(checkMarket).not.toHaveBeenCalled();
  });

  it('LIVE market without a restriction keeps MARKET_PAYMENT_CHECK_FAILED (regression)', async () => {
    const rows = [market('m-eu', { status: MarketStatus.LIVE })];
    const { service } = build(rows, { check: check('missing', 'missing') });
    const body = await codeOf(
      service.update(USER_ID, 'm-eu', { countries: ['DE', 'FR'] }),
    );
    expect(body.code).toBe('MARKET_PAYMENT_CHECK_FAILED');
  });

  it('LIVE market with a restriction: a country change is gated on the allowed methods', async () => {
    const rows = [
      market('m-eu', { status: MarketStatus.LIVE, payment_methods: ['card'] }),
    ];
    // Kustom ok but excluded: the change is refused with the new code.
    const { service } = build(rows, { check: check('missing', 'ok') });
    const body = await codeOf(
      service.update(USER_ID, 'm-eu', { countries: ['DE', 'FR'] }),
    );
    expect(body.code).toBe('MARKET_PAYMENT_METHODS_NOT_READY');
  });

  it('LIVE market: clearing the restriction is gated with the old rule', async () => {
    const rows = [
      market('m-eu', { status: MarketStatus.LIVE, payment_methods: ['card'] }),
    ];
    const { service } = build(rows, { check: check('missing', 'ok') });
    const view = await service.update(USER_ID, 'm-eu', {
      payment_methods: null,
    });
    expect(view.payment_methods).toBeNull();
  });

  it('toView: a malformed stored value reads as [] (fail-closed)', async () => {
    const rows = [market('m-eu', { payment_methods: { card: true } })];
    const { service } = build(rows);
    const view = await service.get(USER_ID, 'm-eu');
    expect(view.payment_methods).toEqual([]);
  });
});

describe('MarketsService.setStatus(LIVE) with payment_methods (M157)', () => {
  it('eu-like: card only, Stripe ok, Kustom missing -> LIVE', async () => {
    const rows = [market('m-eu', { payment_methods: ['card'] })];
    const { service } = build(rows, { check: check('ok', 'missing') });
    const view = await service.setStatus(USER_ID, 'm-eu', MarketStatus.LIVE);
    expect(view.status).toBe(MarketStatus.LIVE);
  });

  it('card only, Stripe missing, Kustom ok -> MARKET_PAYMENT_METHODS_NOT_READY', async () => {
    const rows = [market('m-eu', { payment_methods: ['card'] })];
    const { service } = build(rows, { check: check('missing', 'ok') });
    const body = await codeOf(
      service.setStatus(USER_ID, 'm-eu', MarketStatus.LIVE),
    );
    expect(body.code).toBe('MARKET_PAYMENT_METHODS_NOT_READY');
    expect(rows[0].status).toBe(MarketStatus.DRAFT);
  });

  it('cod only never goes LIVE', async () => {
    const rows = [market('m-eu', { payment_methods: ['cod'] })];
    const { service } = build(rows, { check: check('ok', 'ok') });
    const body = await codeOf(
      service.setStatus(USER_ID, 'm-eu', MarketStatus.LIVE),
    );
    expect(body.code).toBe('MARKET_PAYMENT_METHODS_NOT_READY');
  });

  it('unrestricted keeps MARKET_PAYMENT_CHECK_FAILED (regression)', async () => {
    const rows = [market('m-eu')];
    const { service } = build(rows, { check: check('missing', 'missing') });
    const body = await codeOf(
      service.setStatus(USER_ID, 'm-eu', MarketStatus.LIVE),
    );
    expect(body.code).toBe('MARKET_PAYMENT_CHECK_FAILED');
  });
});

describe('MarketsService.storePaymentMethods (M157)', () => {
  function storeOf(over: Partial<StoreFixture> = {}): StoreFixture {
    return {
      store_type: 'INDEPENDENT',
      cod_enabled: false,
      stripe_keys: null,
      creator: {
        stripe_account_type: null,
        stripe_charges_enabled: false,
        ...KUSTOM_OFF,
      },
      ...over,
    };
  }

  async function view(store: StoreFixture) {
    const { service } = build([], { store });
    return service.storePaymentMethods(USER_ID);
  }

  it('always three rows in contract order; nothing configured', async () => {
    const v = await view(storeOf());
    expect(v).toEqual({
      methods: [
        { method: 'card', available: false, reason: 'card_not_connected' },
        { method: 'kustom', available: false, reason: 'kustom_not_configured' },
        { method: 'cod', available: false, reason: 'cod_disabled' },
      ],
    });
  });

  it('own live key -> card available, no test_mode', async () => {
    const v = await view(
      storeOf({ stripe_keys: { status: 'ACTIVE', livemode: true } }),
    );
    expect(v.methods[0]).toEqual({
      method: 'card',
      available: true,
      reason: null,
    });
  });

  it('own TEST key only -> card available with test_mode', async () => {
    const v = await view(
      storeOf({ stripe_keys: { status: 'ACTIVE', livemode: false } }),
    );
    expect(v.methods[0]).toEqual({
      method: 'card',
      available: true,
      reason: null,
      test_mode: true,
    });
  });

  it('TEST key plus a ready Connect account -> no test_mode', async () => {
    const v = await view(
      storeOf({
        stripe_keys: { status: 'ACTIVE', livemode: false },
        creator: {
          stripe_account_type: 'standard',
          stripe_charges_enabled: true,
          ...KUSTOM_OFF,
        },
      }),
    );
    expect(v.methods[0]).toEqual({
      method: 'card',
      available: true,
      reason: null,
    });
  });

  it('revoked own key, no Connect -> card not connected', async () => {
    const v = await view(
      storeOf({ stripe_keys: { status: 'REVOKED', livemode: true } }),
    );
    expect(v.methods[0].available).toBe(false);
  });

  it('Standard Connect with charges -> card; Kustom ready; COD on', async () => {
    const v = await view(
      storeOf({
        cod_enabled: true,
        creator: {
          stripe_account_type: 'standard',
          stripe_charges_enabled: true,
          ...KUSTOM_READY,
        },
      }),
    );
    expect(v.methods.map((m) => [m.method, m.available, m.reason])).toEqual([
      ['card', true, null],
      ['kustom', true, null],
      ['cod', true, null],
    ]);
  });

  it('marketplace store -> every method not_independent', async () => {
    const v = await view(
      storeOf({
        store_type: 'MARKETPLACE',
        cod_enabled: true,
        stripe_keys: { status: 'ACTIVE', livemode: true },
        creator: {
          stripe_account_type: 'standard',
          stripe_charges_enabled: true,
          ...KUSTOM_READY,
        },
      }),
    );
    expect(v.methods.every((m) => !m.available)).toBe(true);
    expect(v.methods.every((m) => m.reason === 'not_independent')).toBe(true);
  });

  it('never returns ids, keys or secrets', async () => {
    const v = await view(
      storeOf({
        stripe_keys: { status: 'ACTIVE', livemode: true },
        creator: {
          stripe_account_id: 'acct_secret',
          stripe_account_type: 'standard',
          stripe_charges_enabled: true,
          ...KUSTOM_READY,
        },
      }),
    );
    const json = JSON.stringify(v);
    expect(json).not.toMatch(/acct_|M1|enc|merchant|secret|livemode/);
    for (const row of v.methods) {
      expect(Object.keys(row).sort()).toEqual(
        expect.arrayContaining(['available', 'method', 'reason']),
      );
      for (const k of Object.keys(row)) {
        expect(['method', 'available', 'reason', 'test_mode']).toContain(k);
      }
    }
  });
});

describe('MarketsController route order (M157)', () => {
  it('GET payment-methods is declared before GET :id', () => {
    const names = Object.getOwnPropertyNames(MarketsController.prototype);
    const proto = MarketsController.prototype as unknown as Record<
      string,
      object
    >;
    const pathOf = (n: string) =>
      Reflect.getMetadata(PATH_METADATA, proto[n]) as string | undefined;
    expect(pathOf('storePaymentMethods')).toBe('payment-methods');
    expect(pathOf('get')).toBe(':id');
    expect(names.indexOf('storePaymentMethods')).toBeGreaterThan(-1);
    expect(names.indexOf('storePaymentMethods')).toBeLessThan(
      names.indexOf('get'),
    );
  });
});
