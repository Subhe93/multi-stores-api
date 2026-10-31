import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Prisma, UserRole } from '@prisma/client';
import { ROLES_KEY } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import { OverviewController } from './overview.controller';
import { OverviewService } from './overview.service';

type Rows = Record<string, unknown>[];

interface FakeOpts {
  storeType?: 'INDEPENDENT' | 'MARKETPLACE';
  storeCurrency?: string | null;
  timezone?: string | null;
  kpiRows?: Rows;
  seriesRows?: Rows;
  marketsEnabled?: boolean;
  noStore?: boolean;
}

/** Minimal Prisma fake: raw queries are told apart by a marker in the SQL. */
function makeService(opts: FakeOpts = {}) {
  const raw: Prisma.Sql[] = [];
  const queryRaw = jest.fn((sql: Prisma.Sql) => {
    raw.push(sql);
    const text = sql.sql;
    if (text.includes('AS cur')) return Promise.resolve(opts.kpiRows ?? []);
    if (text.includes('to_char('))
      return Promise.resolve(opts.seriesRows ?? []);
    if (text.includes('AS unfulfilled'))
      return Promise.resolve([{ unfulfilled: 3, pending: 1 }]);
    if (text.includes('UPPER(a.country_code)'))
      return Promise.resolve([
        { country: 'SE', revenue: 900, orders: 3 },
        { country: 'NO', revenue: 100, orders: 1 },
      ]);
    if (text.includes('o.market_id,'))
      return Promise.resolve([
        { market_id: 'm-se', revenue: 500, orders: 2 },
        { market_id: null, revenue: 50, orders: 1 },
      ]);
    return Promise.resolve([]);
  });
  const prisma = {
    $queryRaw: queryRaw,
    creator: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          opts.noStore
            ? { id: 'cr1', store: null }
            : {
                id: 'cr1',
                stripe_charges_enabled: false,
                stripe_payouts_enabled: true,
                kustom_enabled: true,
                kustom_merchant_id: 'K1',
                store: {
                  id: 's1',
                  store_type: opts.storeType ?? 'INDEPENDENT',
                  currency:
                    opts.storeCurrency === undefined
                      ? 'SEK'
                      : opts.storeCurrency,
                  logo_url: '/uploads/logo.png',
                  custom_domain: null,
                  cod_enabled: false,
                  language_config: { primary_locale: 'sv' },
                  legal_profiles:
                    opts.timezone === undefined
                      ? []
                      : [{ timezone: opts.timezone }],
                },
              },
        ),
      ),
    },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'EUR' })),
    },
    order: {
      groupBy: jest.fn(() =>
        Promise.resolve([
          { status: 'PROCESSING', _count: { _all: 2 } },
          { status: 'DELIVERED', _count: { _all: 5 } },
        ]),
      ),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    product: {
      count: jest.fn(() => Promise.resolve(2)),
      findFirst: jest.fn(() => Promise.resolve({ id: 'p1' })),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    customProduct: {
      count: jest.fn(() => Promise.resolve(1)),
      findFirst: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    shippingZone: { findFirst: jest.fn(() => Promise.resolve(null)) },
    storeDomain: { findFirst: jest.fn(() => Promise.resolve({ id: 'd1' })) },
    page: { findFirst: jest.fn(() => Promise.resolve({ id: 'home' })) },
    market: {
      findMany: jest.fn(() =>
        Promise.resolve([
          { id: 'm-se', key: 'se', name: 'Sweden', is_default: false },
          { id: 'm-def', key: 'default', name: 'Global', is_default: true },
        ]),
      ),
    },
  };
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(opts.marketsEnabled ?? false)),
  };
  const service = new OverviewService(
    prisma as unknown as PrismaService,
    storeApps as unknown as StoreAppsService,
  );
  return { service, prisma, raw, queryRaw };
}

describe('OverviewService', () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: Date.parse('2026-10-31T12:00:00Z') });
  });
  afterAll(() => jest.useRealTimers());

  it('merges current / previous KPIs and derives AOV', async () => {
    const { service } = makeService({
      kpiRows: [
        {
          cur: true,
          revenue: 1000.004,
          orders: 4,
          items: 6,
          customers: 3,
          returning: 1,
          earnings: 1000,
        },
        {
          cur: false,
          revenue: 300,
          orders: 3,
          items: 3,
          customers: 3,
          returning: 0,
          earnings: 300,
        },
      ],
    });
    const res = await service.getOverview('u1', '7d');
    expect(res.kpis.revenue).toEqual({ value: 1000, previous: 300 });
    expect(res.kpis.orders).toEqual({ value: 4, previous: 3 });
    expect(res.kpis.aov).toEqual({ value: 250, previous: 100 });
    expect(res.kpis.items_sold).toEqual({ value: 6, previous: 3 });
    expect(res.kpis.returning_customers).toEqual({ value: 1, previous: 0 });
    // INDEPENDENT store: no marketplace earnings.
    expect(res.kpis.earnings).toBeNull();
    expect(res.store_type).toBe('INDEPENDENT');
    expect(res.currency).toBe('SEK');
  });

  it('AOV is 0 and KPIs are 0 with no orders; marketplace returns earnings', async () => {
    const { service } = makeService({ storeType: 'MARKETPLACE' });
    const res = await service.getOverview('u1');
    expect(res.range).toBe('30d');
    expect(res.kpis.aov).toEqual({ value: 0, previous: 0 });
    expect(res.kpis.earnings).toEqual({ value: 0, previous: 0 });
    // Marketplace stores stay on the platform currency.
    expect(res.currency).toBe('EUR');
  });

  it('zero-fills both series to the same length from the bucket rows', async () => {
    const { service } = makeService({
      seriesRows: [
        { t: '2026-10-31', revenue: 399, orders: 1 },
        { t: '2026-10-20', revenue: 100, orders: 2 },
      ],
    });
    const res = await service.getOverview('u1', '7d');
    expect(res.granularity).toBe('day');
    expect(res.series).toHaveLength(7);
    expect(res.previous_series).toHaveLength(7);
    expect(res.series[6]).toEqual({ t: '2026-10-31', revenue: 399, orders: 1 });
    expect(res.series[0]).toEqual({ t: '2026-10-25', revenue: 0, orders: 0 });
    expect(res.previous_series.find((p) => p.t === '2026-10-20')).toEqual({
      t: '2026-10-20',
      revenue: 100,
      orders: 2,
    });
  });

  it('binds the timezone, store currency and bounds as parameters', async () => {
    const { service, raw } = makeService();
    const res = await service.getOverview('u1', 'today', 'Asia/Dubai');
    expect(res.timezone).toBe('Asia/Dubai');
    const series = raw.find((s) => s.sql.includes('to_char('))!;
    expect(series.sql).not.toContain('Asia/Dubai');
    expect(series.values).toEqual(
      expect.arrayContaining([
        'hour',
        'Asia/Dubai',
        'YYYY-MM-DD"T"HH24:00',
        'SEK',
        's1',
      ]),
    );
  });

  it('defaults the timezone to the store legal profile', async () => {
    const { service } = makeService({ timezone: 'Europe/Berlin' });
    const res = await service.getOverview('u1', '7d');
    expect(res.timezone).toBe('Europe/Berlin');
    expect(res.from).toBe('2026-10-25T00:00:00+02:00');
  });

  it('rejects an invalid tz / range before touching orders', async () => {
    const { service, queryRaw } = makeService();
    await expect(service.getOverview('u1', '7d', 'Bad/Zone')).rejects.toThrow(
      'tz must be',
    );
    await expect(service.getOverview('u1', 'week')).rejects.toThrow('range');
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('404s when the creator has no store', async () => {
    const { service } = makeService({ noStore: true });
    await expect(service.getOverview('u1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('caches per store + range + tz for 60 s', async () => {
    const { service, queryRaw } = makeService();
    await service.getOverview('u1', '7d');
    const calls = queryRaw.mock.calls.length;
    await service.getOverview('u1', '7d');
    expect(queryRaw.mock.calls.length).toBe(calls);
    await service.getOverview('u1', '30d');
    expect(queryRaw.mock.calls.length).toBeGreaterThan(calls);
    jest.advanceTimersByTime(61_000);
    const before = queryRaw.mock.calls.length;
    await service.getOverview('u1', '7d');
    expect(queryRaw.mock.calls.length).toBeGreaterThan(before);
  });

  it('sales by country without the markets app, by market with it', async () => {
    const plain = await makeService().service.getOverview('u1', '7d');
    expect(plain.sales_by_market).toEqual([
      { key: 'SE', label: 'Sweden', revenue: 900, orders: 3 },
      { key: 'NO', label: 'Norway', revenue: 100, orders: 1 },
    ]);
    const markets = await makeService({
      marketsEnabled: true,
    }).service.getOverview('u1', '7d');
    // An order without a market is attributed to the default market.
    expect(markets.sales_by_market).toEqual([
      { key: 'se', label: 'Sweden', revenue: 500, orders: 2 },
      { key: 'default', label: 'Global', revenue: 50, orders: 1 },
    ]);
  });

  it('todo, status breakdown and setup', async () => {
    const res = await makeService().service.getOverview('u1', '7d');
    expect(res.status_breakdown[0]).toEqual({ status: 'DELIVERED', count: 5 });
    expect(res.todo).toEqual({
      unfulfilled_orders: 3,
      pending_payment_orders: 1,
      low_stock_products: 0,
      draft_products: 3,
      // Independent store: no review queue.
      pending_review_products: 0,
    });
    expect(res.setup).toEqual({
      has_products: true,
      has_logo: true,
      has_payment: true, // Kustom configured
      has_shipping: false,
      has_domain: true, // ACTIVE StoreDomain
      has_published_theme: true,
    });
  });
});

describe('OverviewController', () => {
  it('is creator-only behind JWT + RolesGuard', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      OverviewController,
    ) as unknown[];
    expect(guards).toEqual(expect.arrayContaining([RolesGuard]));
    expect(guards).toHaveLength(2);
    expect(Reflect.getMetadata(ROLES_KEY, OverviewController)).toEqual([
      UserRole.CREATOR,
    ]);
  });
});
