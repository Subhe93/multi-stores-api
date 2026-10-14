import { HttpException } from '@nestjs/common';
import { MarketsContextService } from './markets-context.service';
import { FxService } from './fx.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';

// resolve() is the one entry point every hook calls; what is pinned down
// here is the contract its callers rely on: null while the app is off, the
// default market without a key, LIVE gating with a key, the effective rate
// and the cache drop after a mutation.

const STORE_ID = 's1';

type MarketSeed = {
  id: string;
  key: string;
  currency: string;
  is_default?: boolean;
  status?: 'DRAFT' | 'LIVE';
  price_rule?: unknown;
  domains?: { hostname: string; is_primary: boolean; redirect_to?: string }[];
  locales?: string[];
  default_locale?: string;
};

function makePrisma(
  markets: MarketSeed[],
  fxRows: Record<string, number> = {},
) {
  const rows = markets.map((m) => ({
    id: m.id,
    key: m.key,
    name: m.key.toUpperCase(),
    countries: [],
    default_locale: m.default_locale ?? 'sv',
    locales: m.locales ?? [],
    currency: m.currency,
    is_default: m.is_default ?? false,
    status: m.status ?? 'LIVE',
    price_rule: m.price_rule ?? { mode: 'convert', source: 'manual', rate: 1 },
    domains: (m.domains ?? []).map((d) => ({
      hostname: d.hostname,
      is_primary: d.is_primary,
      redirect_to: d.redirect_to ?? null,
    })),
  }));
  return {
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({ store_type: 'INDEPENDENT', currency: 'SEK' }),
      ),
    },
    market: { findMany: jest.fn(() => Promise.resolve(rows)) },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'EUR' })),
    },
    platformFxRate: {
      findUnique: jest.fn(
        ({
          where,
        }: {
          where: { base_quote: { base: string; quote: string } };
        }) => {
          const k = `${where.base_quote.base}:${where.base_quote.quote}`;
          return Promise.resolve(k in fxRows ? { rate: fxRows[k] } : null);
        },
      ),
    },
    storeDomain: { findUnique: jest.fn() },
  };
}

function build(
  markets: MarketSeed[],
  opts: { enabled?: boolean; fx?: Record<string, number> } = {},
) {
  const prisma = makePrisma(markets, opts.fx);
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(opts.enabled ?? true)),
  };
  const fx = new FxService(prisma as unknown as PrismaService);
  const service = new MarketsContextService(
    prisma as unknown as PrismaService,
    storeApps as unknown as StoreAppsService,
    fx,
  );
  return { service, prisma, storeApps };
}

const defaultMarket: MarketSeed = {
  id: 'm-default',
  key: 'default',
  currency: 'SEK',
  is_default: true,
  domains: [{ hostname: 'namez.se', is_primary: true }],
  locales: ['en', 'sv'],
};

describe('MarketsContextService.resolve', () => {
  it('is null while the app is off, without touching the markets table', async () => {
    const { service, prisma } = build([defaultMarket], { enabled: false });
    expect(await service.resolve(STORE_ID)).toBeNull();
    expect(await service.resolve(STORE_ID, 'eu')).toBeNull();
    expect(await service.listLive(STORE_ID)).toBeNull();
    expect(prisma.market.findMany).not.toHaveBeenCalled();
  });

  it('answers the default market without a key, bound to the store currency', async () => {
    const { service } = build([{ ...defaultMarket, currency: 'EUR' }]);
    const ctx = await service.resolve(STORE_ID);
    expect(ctx).toMatchObject({
      key: 'default',
      isDefault: true,
      currency: 'SEK',
      storeCurrency: 'SEK',
      rate: 1,
      primaryHostname: 'namez.se',
      hostnames: ['namez.se'],
    });
    // The default locale is never repeated in the secondary list.
    expect(ctx?.locales).toEqual(['en']);
  });

  it('404s an unknown key and a DRAFT key', async () => {
    const { service } = build([
      defaultMarket,
      { id: 'm-eu', key: 'eu', currency: 'EUR', status: 'DRAFT' },
    ]);
    await expect(service.resolve(STORE_ID, 'nope')).rejects.toMatchObject({
      response: { code: 'MARKET_NOT_FOUND' },
    });
    await expect(service.resolve(STORE_ID, 'eu')).rejects.toMatchObject({
      response: { code: 'MARKET_NOT_LIVE' },
    });
  });

  it('rate is 1 when the market prices in the store currency', async () => {
    const { service } = build([
      defaultMarket,
      {
        id: 'm-no',
        key: 'no',
        currency: 'SEK',
        price_rule: { mode: 'convert', source: 'platform' },
      },
    ]);
    expect((await service.resolve(STORE_ID, 'no'))?.rate).toBe(1);
  });

  it('uses the manual rate, or the platform table (direct or inverse)', async () => {
    const { service } = build(
      [
        defaultMarket,
        {
          id: 'm-eu',
          key: 'eu',
          currency: 'EUR',
          price_rule: { mode: 'convert', source: 'manual', rate: 0.09 },
        },
        {
          id: 'm-dk',
          key: 'dk',
          currency: 'DKK',
          price_rule: { mode: 'convert', source: 'platform' },
        },
        {
          id: 'm-no',
          key: 'no',
          currency: 'NOK',
          price_rule: { mode: 'convert', source: 'platform' },
        },
      ],
      { fx: { 'SEK:DKK': 0.65, 'NOK:SEK': 1.02 } },
    );
    expect((await service.resolve(STORE_ID, 'eu'))?.rate).toBe(0.09);
    expect((await service.resolve(STORE_ID, 'dk'))?.rate).toBe(0.65);
    expect((await service.resolve(STORE_ID, 'no'))?.rate).toBeCloseTo(1 / 1.02);
  });

  it('throws MARKET_FX_RATE_MISSING for a convert rule without a rate', async () => {
    const { service } = build([
      defaultMarket,
      {
        id: 'm-eu',
        key: 'eu',
        currency: 'EUR',
        price_rule: { mode: 'convert', source: 'platform' },
      },
    ]);
    const err = await service.resolve(STORE_ID, 'eu').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getResponse()).toMatchObject({
      code: 'MARKET_FX_RATE_MISSING',
    });
  });

  it('fixed mode without a rate resolves with rate null (products need overrides)', async () => {
    const { service } = build([
      defaultMarket,
      {
        id: 'm-eu',
        key: 'eu',
        currency: 'EUR',
        price_rule: { mode: 'fixed' },
      },
    ]);
    expect((await service.resolve(STORE_ID, 'eu'))?.rate).toBeNull();
  });

  it('lists LIVE markets only, default first, as public routes', async () => {
    const { service } = build([
      {
        id: 'm-eu',
        key: 'eu',
        currency: 'EUR',
        status: 'LIVE',
        domains: [{ hostname: 'namez.shop', is_primary: true }],
      },
      { id: 'm-dk', key: 'dk', currency: 'DKK', status: 'DRAFT' },
      defaultMarket,
    ]);
    const routes = await service.listLive(STORE_ID);
    expect(routes?.map((r) => r.key)).toEqual(['default', 'eu']);
    expect(routes?.[0]).toEqual({
      key: 'default',
      name: 'DEFAULT',
      default_locale: 'sv',
      locales: ['en'],
      countries: [],
      currency: 'SEK',
      is_default: true,
      primary_hostname: 'namez.se',
      status: 'LIVE',
    });
    expect(routes?.[1].primary_hostname).toBe('namez.shop');
  });

  it('never advertises a LIVE non-default market without an ACTIVE canonical host', async () => {
    const { service } = build([
      defaultMarket,
      { id: 'm-eu', key: 'eu', currency: 'SEK', status: 'LIVE', domains: [] },
      {
        id: 'm-dk',
        key: 'dk',
        currency: 'SEK',
        status: 'LIVE',
        // Only a redirecting host: nothing canonical to link to.
        domains: [
          {
            hostname: 'www.namez.dk',
            is_primary: false,
            redirect_to: 'namez.dk',
          },
        ],
      },
      {
        id: 'm-no',
        key: 'no',
        currency: 'SEK',
        status: 'LIVE',
        domains: [
          {
            hostname: 'www.namez.no',
            is_primary: false,
            redirect_to: 'namez.no',
          },
          { hostname: 'namez.no', is_primary: false },
        ],
      },
    ]);
    const routes = await service.listLive(STORE_ID);
    expect(routes?.map((r) => r.key)).toEqual(['default', 'no']);
    // The canonical host skips the redirecting one.
    expect(routes?.[1].primary_hostname).toBe('namez.no');
    // resolve() by key still works for such a market (served via by-domain
    // only when a host is ACTIVE); it is just not advertised.
    expect((await service.resolve(STORE_ID, 'eu'))?.primaryHostname).toBeNull();
  });

  it('listLive survives a market whose platform rate is gone (rate null, still routed)', async () => {
    const { service } = build(
      [
        defaultMarket,
        {
          id: 'm-eu',
          key: 'eu',
          currency: 'EUR',
          price_rule: { mode: 'convert', source: 'platform' },
          domains: [{ hostname: 'namez.shop', is_primary: true }],
        },
        {
          id: 'm-dk',
          key: 'dk',
          currency: 'DKK',
          price_rule: { mode: 'convert', source: 'platform' },
          domains: [{ hostname: 'namez.dk', is_primary: true }],
        },
      ],
      { fx: { 'SEK:DKK': 0.65 } },
    );
    const routes = await service.listLive(STORE_ID);
    expect(routes?.map((r) => r.key)).toEqual(['default', 'eu', 'dk']);
    expect(routes?.[1].primary_hostname).toBe('namez.shop');
    // The broken market itself still refuses to price at checkout.
    await expect(service.resolve(STORE_ID, 'eu')).rejects.toMatchObject({
      response: { code: 'MARKET_FX_RATE_MISSING' },
    });
    expect((await service.resolve(STORE_ID, 'dk'))?.rate).toBe(0.65);
  });

  it('invalidateAll drops every store (platform FX rates changed)', async () => {
    const { service, prisma } = build([defaultMarket]);
    await service.resolve(STORE_ID);
    await service.resolve('s2');
    expect(prisma.market.findMany).toHaveBeenCalledTimes(2);
    service.invalidateAll();
    await service.resolve(STORE_ID);
    await service.resolve('s2');
    expect(prisma.market.findMany).toHaveBeenCalledTimes(4);
  });

  it('caches per store until invalidated', async () => {
    const { service, prisma } = build([defaultMarket]);
    await service.resolve(STORE_ID);
    await service.resolve(STORE_ID, 'default');
    await service.listLive(STORE_ID);
    expect(prisma.market.findMany).toHaveBeenCalledTimes(1);
    service.invalidate(STORE_ID);
    await service.resolve(STORE_ID);
    expect(prisma.market.findMany).toHaveBeenCalledTimes(2);
  });

  it('a DB failure degrades to "no market" for that call and is not cached', async () => {
    const { service, prisma } = build([defaultMarket]);
    prisma.market.findMany.mockRejectedValueOnce(new Error('connection lost'));
    expect(await service.resolve(STORE_ID)).toBeNull();
    expect((await service.resolve(STORE_ID))?.key).toBe('default');
  });
});
