/*
 * Creator overview against the local dev Postgres: every raw SQL path of
 * OverviewService (KPIs, series, market / country / payment breakdowns,
 * top products, to-dos, low stock, setup) with real rows.
 *
 * Opt-in: runs only with OVERVIEW_DB_IT=1 and a DATABASE_URL on localhost /
 * 127.0.0.1 (never a remote database). Creates its own users / creator /
 * store / provider / products / orders tagged "overview-spec-<random>" and
 * deletes everything it created in afterAll.
 *
 * Fixture (T0 = start of today in Europe/Stockholm, store currency SEK):
 *   A  T0+1h   COD pending, PENDING          100 SEK  C1  own P1 x2   counted
 *   B  T0+2h   STRIPE paid, CONFIRMED     10 EUR fx 0.1 = 100 SEK  C2  custom x1 counted
 *   C  now-30m STRIPE awaiting_payment       999 SEK  C3                not counted (to-do)
 *   D  T0+4h   STRIPE failed, CANCELLED      500 SEK  C3                not counted
 *   E  T0-1d+1h KUSTOM paid, DELIVERED       200 SEK  C1  own P1 x1   counted
 *   I  T0-2d   STRIPE null status + paid_at   40 SEK  C3                counted (legacy)
 *   F  T0-10d  STRIPE refunded, REFUNDED     300 SEK  C2                not counted
 *   G  T0-10d  STRIPE paid, DELIVERED (NO)    50 SEK  C2                counted
 *   H  T0-200d COD paid, DELIVERED          1000 SEK  C3                counted
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import { OverviewService } from './overview.service';
import { resolveWindow } from './overview-range';

const url = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const describeDb =
  process.env.OVERVIEW_DB_IT === '1' && isLocal ? describe : describe.skip;

jest.setTimeout(60_000);

const TZ = 'Europe/Stockholm';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describeDb('OverviewService (local Postgres)', () => {
  const prisma = new PrismaClient();
  const tag = `overview-spec-${randomUUID().slice(0, 8)}`;
  const ids = {
    users: [] as string[],
    customers: [] as string[],
    orders: [] as string[],
    products: [] as string[],
    custom: [] as string[],
    category: '',
    store: '',
    creator: '',
    provider: '',
    creatorUser: '',
  };
  let marketsOn = false;
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(marketsOn)),
  };
  const service = () =>
    new OverviewService(
      prisma as unknown as PrismaService,
      storeApps as unknown as StoreAppsService,
    );

  const T0 = resolveWindow('today', TZ).from.getTime();
  const at = (ms: number) => new Date(ms);

  beforeAll(async () => {
    const user = async (role: 'CREATOR' | 'PROVIDER' | 'CUSTOMER') => {
      const u = await prisma.user.create({
        data: {
          email: `${tag}-${randomUUID().slice(0, 6)}@example.test`,
          password_hash: 'x',
          role,
        },
      });
      ids.users.push(u.id);
      return u.id;
    };
    ids.creatorUser = await user('CREATOR');
    const creator = await prisma.creator.create({
      data: {
        user_id: ids.creatorUser,
        display_name: tag,
        kustom_enabled: true,
        kustom_merchant_id: 'K-test',
      },
    });
    ids.creator = creator.id;
    const store = await prisma.store.create({
      data: {
        creator_id: creator.id,
        slug: tag,
        name: tag,
        store_type: 'INDEPENDENT',
        currency: 'SEK',
        language_config: {
          create: { primary_locale: 'sv', secondary_locales: ['en'] },
        },
      },
    });
    ids.store = store.id;
    const providerUser = await user('PROVIDER');
    const provider = await prisma.provider.create({
      data: { user_id: providerUser, company_name: tag, country: 'SE' },
    });
    ids.provider = provider.id;
    const category = await prisma.category.create({ data: { slug: tag } });
    ids.category = category.id;

    const product = async (
      title: string,
      data: {
        status?: 'PUBLISHED' | 'DRAFT';
        track?: boolean;
        stock?: number | null;
        variants?: (number | null)[];
        provider?: boolean;
      },
    ) => {
      const p = await prisma.product.create({
        data: {
          creator_id: data.provider ? null : ids.creator,
          provider_id: data.provider ? ids.provider : null,
          category_id: ids.category,
          product_type: 'TRADITIONAL',
          base_price: 50,
          status: data.status ?? 'PUBLISHED',
          track_inventory: data.track ?? false,
          stock_quantity: data.stock ?? null,
          translations: {
            create: [
              {
                locale: 'sv',
                title: `${title} sv`,
                description: '',
                slug: `${tag}-${title}-sv`,
              },
              {
                locale: 'en',
                title: `${title} en`,
                description: '',
                slug: `${tag}-${title}-en`,
              },
            ],
          },
          images: { create: [{ url: `/uploads/${title}.png`, sort_order: 0 }] },
          variants: data.variants
            ? {
                create: data.variants.map((s, i) => ({
                  options: { size: String(i) },
                  stock_quantity: s,
                })),
              }
            : undefined,
        },
      });
      ids.products.push(p.id);
      return p.id;
    };
    const p1 = await product('P1', { variants: [3, 10] }); // low via variant (3)
    await product('P2', { track: true, stock: 2 }); // low (2)
    await product('P3', { track: false, stock: 1 }); // untracked
    await product('P4', { variants: [null] }); // variant without a number
    await product('P5', { status: 'DRAFT', track: true, stock: 0 }); // draft
    const base = await product('BASE', { provider: true });
    const cp = await prisma.customProduct.create({
      data: {
        product_id: base,
        creator_id: ids.creator,
        status: 'PUBLISHED',
        translations: {
          create: [{ locale: 'sv', title: 'Custom sv', slug: `${tag}-cp` }],
        },
        mockup_images: { create: [{ url: '/uploads/cp.png' }] },
      },
    });
    ids.custom.push(cp.id);

    const customer = async (country: string) => {
      const uid = await user('CUSTOMER');
      const c = await prisma.customer.create({
        data: {
          user_id: uid,
          first_name: 'Test',
          last_name: country,
          addresses: {
            create: [
              {
                full_name: `Addr ${country}`,
                line1: 'x',
                city: 'x',
                postal_code: '1',
                country_code: country,
              },
            ],
          },
        },
        include: { addresses: true },
      });
      ids.customers.push(c.id);
      return { id: c.id, address: c.addresses[0].id };
    };
    const c1 = await customer('SE');
    const c2 = await customer('SE');
    const c3 = await customer('SE');
    const no = await prisma.address.create({
      data: {
        customer_id: c2.id,
        full_name: 'Norway',
        line1: 'x',
        city: 'x',
        postal_code: '1',
        country_code: 'NO',
      },
    });

    const order = async (
      name: string,
      d: {
        created: Date;
        total: number;
        currency?: string;
        fx?: number;
        method: 'COD' | 'STRIPE' | 'KUSTOM';
        payment: string | null;
        paidAt?: Date;
        status:
          | 'PENDING'
          | 'CONFIRMED'
          | 'DELIVERED'
          | 'CANCELLED'
          | 'REFUNDED';
        customer: { id: string; address: string };
        address?: string;
        items?: {
          product?: string;
          custom?: string;
          qty: number;
          total: number;
        }[];
        creatorAmount?: number;
      },
    ) => {
      const o = await prisma.order.create({
        data: {
          order_number: `${tag}-${name}`,
          customer_id: d.customer.id,
          address_id: d.address ?? d.customer.address,
          store_id: ids.store,
          status: d.status,
          subtotal: d.total,
          total: d.total,
          currency: d.currency ?? 'SEK',
          fx_rate_snapshot: d.fx ?? null,
          payment_method: d.method,
          payment_status: d.payment,
          paid_at: d.paidAt ?? null,
          created_at: d.created,
          items: d.items
            ? {
                create: d.items.map((it) => ({
                  product_id: it.product ?? null,
                  custom_product_id: it.custom ?? null,
                  quantity: it.qty,
                  unit_price: it.total / it.qty,
                  total_price: it.total,
                  fulfiller_type: 'CREATOR' as const,
                  fulfiller_id: ids.creator,
                })),
              }
            : undefined,
          commission:
            d.creatorAmount != null
              ? {
                  create: {
                    platform_amount: 0,
                    creator_amount: d.creatorAmount,
                    currency: d.currency ?? 'SEK',
                  },
                }
              : undefined,
        },
      });
      ids.orders.push(o.id);
    };
    await order('A', {
      created: at(T0 + HOUR),
      total: 100,
      method: 'COD',
      payment: 'pending',
      status: 'PENDING',
      customer: c1,
      items: [{ product: p1, qty: 2, total: 100 }],
      creatorAmount: 30,
    });
    await order('B', {
      created: at(T0 + 2 * HOUR),
      total: 10,
      currency: 'EUR',
      fx: 0.1,
      method: 'STRIPE',
      payment: 'paid',
      status: 'CONFIRMED',
      customer: c2,
      items: [{ custom: cp.id, qty: 1, total: 10 }],
    });
    await order('C', {
      created: at(Date.now() - 30 * 60_000),
      total: 999,
      method: 'STRIPE',
      payment: 'awaiting_payment',
      status: 'PENDING',
      customer: c3,
    });
    await order('D', {
      created: at(T0 + 4 * HOUR),
      total: 500,
      method: 'STRIPE',
      payment: 'failed',
      status: 'CANCELLED',
      customer: c3,
    });
    await order('E', {
      created: at(T0 - DAY + HOUR),
      total: 200,
      method: 'KUSTOM',
      payment: 'paid',
      status: 'DELIVERED',
      customer: c1,
      items: [{ product: p1, qty: 1, total: 200 }],
      creatorAmount: 20,
    });
    await order('I', {
      created: at(T0 - 2 * DAY + HOUR),
      total: 40,
      method: 'STRIPE',
      payment: null,
      paidAt: at(T0 - 2 * DAY + HOUR),
      status: 'DELIVERED',
      customer: c3,
    });
    await order('F', {
      created: at(T0 - 10 * DAY),
      total: 300,
      method: 'STRIPE',
      payment: 'refunded',
      status: 'REFUNDED',
      customer: c2,
    });
    await order('G', {
      created: at(T0 - 10 * DAY),
      total: 50,
      method: 'STRIPE',
      payment: 'paid',
      status: 'DELIVERED',
      customer: c2,
      address: no.id,
    });
    await order('H', {
      created: at(T0 - 200 * DAY),
      total: 1000,
      method: 'COD',
      payment: 'paid',
      status: 'DELIVERED',
      customer: c3,
    });
  });

  afterAll(async () => {
    try {
      await prisma.orderCommission.deleteMany({
        where: { order_id: { in: ids.orders } },
      });
      await prisma.order.deleteMany({ where: { id: { in: ids.orders } } });
      await prisma.customProduct.deleteMany({
        where: { id: { in: ids.custom } },
      });
      await prisma.product.deleteMany({ where: { id: { in: ids.products } } });
      if (ids.category)
        await prisma.category.deleteMany({ where: { id: ids.category } });
      if (ids.store)
        await prisma.store.deleteMany({ where: { id: ids.store } });
      // Users cascade to creator / provider / customer / addresses.
      await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('today: hourly series, KPIs, returning customers', async () => {
    const r = await service().getOverview(ids.creatorUser, 'today', TZ);
    expect(r.currency).toBe('SEK');
    expect(r.kpis.revenue).toEqual({ value: 200, previous: 200 });
    expect(r.kpis.orders).toEqual({ value: 2, previous: 1 });
    expect(r.kpis.aov).toEqual({ value: 100, previous: 200 });
    expect(r.kpis.items_sold).toEqual({ value: 3, previous: 1 });
    expect(r.kpis.customers).toEqual({ value: 2, previous: 1 });
    // C1 (E yesterday) and C2 (G 10 days ago) are returning today.
    expect(r.kpis.returning_customers).toEqual({ value: 2, previous: 0 });
    expect(r.kpis.earnings).toBeNull();
    expect(r.series).toHaveLength(24);
    expect(r.previous_series).toHaveLength(24);
    const day = r.series[0].t.slice(0, 10);
    expect(r.series.find((p) => p.t === `${day}T01:00`)).toEqual({
      t: `${day}T01:00`,
      revenue: 100,
      orders: 1,
    });
    expect(r.series.find((p) => p.t === `${day}T02:00`)?.revenue).toBe(100);
    expect(r.series.reduce((s, p) => s + p.revenue, 0)).toBe(200);
    expect(r.previous_series.reduce((s, p) => s + p.revenue, 0)).toBe(200);
  });

  it('7d: totals, breakdowns, top products, to-dos, low stock, setup', async () => {
    marketsOn = false;
    const r = await service().getOverview(ids.creatorUser, '7d', TZ);
    expect(r.kpis.revenue).toEqual({ value: 440, previous: 50 });
    expect(r.kpis.orders).toEqual({ value: 4, previous: 1 });
    expect(r.kpis.customers).toEqual({ value: 3, previous: 1 });
    expect(r.kpis.returning_customers).toEqual({ value: 2, previous: 0 });
    expect(r.series.reduce((s, p) => s + p.revenue, 0)).toBe(440);
    expect(r.previous_series.reduce((s, p) => s + p.orders, 0)).toBe(1);

    const statuses = Object.fromEntries(
      r.status_breakdown.map((s) => [s.status, s.count]),
    );
    expect(statuses).toEqual({
      PENDING: 2,
      CONFIRMED: 1,
      CANCELLED: 1,
      DELIVERED: 2,
    });

    expect(r.sales_by_market).toEqual([
      { key: 'SE', label: 'Sweden', revenue: 440, orders: 4 },
    ]);
    const methods = Object.fromEntries(
      r.payment_methods.map((m) => [m.method, [m.revenue, m.orders]]),
    );
    expect(methods).toEqual({
      KUSTOM: [200, 1],
      COD: [100, 1],
      STRIPE: [140, 2],
    });

    expect(r.top_products).toEqual([
      {
        id: ids.products[0],
        kind: 'own',
        title: 'P1 sv',
        image: '/uploads/P1.png',
        quantity: 3,
        revenue: 300,
      },
      {
        id: ids.custom[0],
        kind: 'custom',
        title: 'Custom sv',
        image: '/uploads/cp.png',
        quantity: 1,
        revenue: 100,
      },
    ]);

    expect(r.recent_orders).toHaveLength(6);
    expect(
      r.recent_orders.find((o) => o.order_number === `${tag}-B`),
    ).toMatchObject({
      total: 10,
      currency: 'EUR',
      payment_status: 'paid',
    });

    expect(r.todo).toEqual({
      unfulfilled_orders: 2,
      pending_payment_orders: 1,
      low_stock_products: 2,
      draft_products: 1,
      pending_review_products: 0,
    });
    expect(r.low_stock.map((l) => [l.title, l.stock])).toEqual([
      ['P2 sv', 2],
      ['P1 sv', 3],
    ]);
    expect(r.setup).toEqual({
      has_products: true,
      has_logo: false,
      has_payment: true,
      has_shipping: false,
      has_domain: false,
      has_published_theme: false,
    });
  });

  it('30d / 90d / 12m totals and previous periods', async () => {
    const s = service();
    const d30 = await s.getOverview(ids.creatorUser, '30d', TZ);
    expect(d30.kpis.revenue).toEqual({ value: 490, previous: 0 });
    expect(d30.sales_by_market).toEqual([
      { key: 'SE', label: 'Sweden', revenue: 440, orders: 4 },
      { key: 'NO', label: 'Norway', revenue: 50, orders: 1 },
    ]);
    const d90 = await s.getOverview(ids.creatorUser, '90d', TZ);
    expect(d90.kpis.revenue).toEqual({ value: 490, previous: 0 });
    expect(d90.series).toHaveLength(90);
    const m12 = await s.getOverview(ids.creatorUser, '12m', TZ);
    expect(m12.granularity).toBe('month');
    expect(m12.kpis.revenue).toEqual({ value: 1490, previous: 0 });
    expect(m12.kpis.orders.value).toBe(6);
    expect(m12.series.reduce((x, p) => x + p.revenue, 0)).toBe(1490);
  });

  it('another timezone buckets by its own calendar', async () => {
    const r = await service().getOverview(ids.creatorUser, '90d', 'Asia/Tokyo');
    expect(r.timezone).toBe('Asia/Tokyo');
    expect(r.kpis.revenue.value).toBe(490);
    // A (01:00 Stockholm) is 09:00 the same day in Tokyo; E (yesterday
    // 01:00 Stockholm) the day before.
    const local = (ms: number) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(ms);
    const aDay = local(T0 + HOUR);
    const eDay = local(T0 - DAY + HOUR);
    const point = (t: string) => r.series.find((p) => p.t === t);
    expect(point(aDay)).toEqual({ t: aDay, revenue: 200, orders: 2 });
    expect(point(eDay)).toEqual({ t: eDay, revenue: 200, orders: 1 });
  });

  it('markets app on: sales by market (no market = default market)', async () => {
    await prisma.market.create({
      data: {
        store_id: ids.store,
        key: 'default',
        name: 'Sverige',
        countries: ['SE'],
        default_locale: 'sv',
        currency: 'SEK',
        is_default: true,
      },
    });
    const eu = await prisma.market.create({
      data: {
        store_id: ids.store,
        key: 'eu',
        name: 'Europe',
        countries: ['DE'],
        default_locale: 'en',
        currency: 'EUR',
      },
    });
    await prisma.order.update({
      where: { order_number: `${tag}-B` },
      data: { market_id: eu.id },
    });
    marketsOn = true;
    try {
      const r = await service().getOverview(ids.creatorUser, '7d', TZ);
      expect(r.sales_by_market).toEqual([
        { key: 'default', label: 'Sverige', revenue: 340, orders: 3 },
        { key: 'eu', label: 'Europe', revenue: 100, orders: 1 },
      ]);
    } finally {
      marketsOn = false;
    }
  });

  it('marketplace store: earnings from creator commissions', async () => {
    await prisma.store.update({
      where: { id: ids.store },
      data: { store_type: 'MARKETPLACE' },
    });
    const r = await service().getOverview(ids.creatorUser, '7d', TZ);
    expect(r.store_type).toBe('MARKETPLACE');
    // A (30) + E (20); SEK amounts without a rate are kept as is.
    expect(r.kpis.earnings).toEqual({ value: 50, previous: 0 });
    expect(r.todo.pending_review_products).toBe(0);
  });
});
