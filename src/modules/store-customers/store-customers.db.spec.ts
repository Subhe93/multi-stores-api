/*
 * Customers list / detail / CSV / admin list against the local dev Postgres:
 * the raw SQL of StoreCustomersService with real rows, so the aggregates are
 * checked against the overview rules (countedOrderSql + storeAmountSql).
 *
 * Opt-in: runs only with STORE_CUSTOMERS_DB_IT=1 and a DATABASE_URL on
 * localhost / 127.0.0.1 (never a remote database). Creates its own rows
 * tagged "store-customers-spec-<random>" and deletes them in afterAll.
 *
 * Fixture (store A: INDEPENDENT, SEK; store B: another store):
 *   C1 (A)  STRIPE paid CONFIRMED         100 SEK   counted
 *           COD pending PENDING            50 SEK   counted
 *           STRIPE failed CANCELLED       500 SEK   not counted
 *           STRIPE awaiting_payment       999 SEK   not counted
 *           STRIPE paid, but in store B   700 SEK   not counted (foreign store)
 *   C2 (A)  STRIPE paid  10 EUR fx 0.1  = 100 SEK   counted
 *           STRIPE refunded REFUNDED      300 SEK   not counted
 *           null status + paid_at          40 SEK   counted (legacy)
 *   C3 (A)  no orders
 *   D1 (B)  STRIPE paid                    80 SEK   (store B customer)
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { StoreCustomersService } from './store-customers.service';

const url = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const describeDb =
  process.env.STORE_CUSTOMERS_DB_IT === '1' && isLocal
    ? describe
    : describe.skip;

jest.setTimeout(60_000);

const DAY = 24 * 3_600_000;

describeDb('StoreCustomersService (local Postgres)', () => {
  const prisma = new PrismaClient();
  const tag = `store-customers-spec-${randomUUID().slice(0, 8)}`;
  const ids = {
    staff: [] as string[],
    customerUsers: [] as string[],
    orders: [] as string[],
    stores: [] as string[],
  };
  const c: Record<string, string> = {};
  let storeA = '';
  let storeB = '';
  let creatorUserA = '';

  const service = () =>
    new StoreCustomersService(
      prisma as unknown as PrismaService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

  beforeAll(async () => {
    const staff = async () => {
      const u = await prisma.user.create({
        data: {
          email: `${tag}-${randomUUID().slice(0, 6)}@example.test`,
          password_hash: 'x',
          role: 'CREATOR',
        },
      });
      ids.staff.push(u.id);
      return u.id;
    };
    const store = async (suffix: string) => {
      const userId = await staff();
      const creator = await prisma.creator.create({
        data: { user_id: userId, display_name: `${tag}-${suffix}` },
      });
      const s = await prisma.store.create({
        data: {
          creator_id: creator.id,
          slug: `${tag}-${suffix}`,
          name: `Store ${suffix}`,
          store_type: 'INDEPENDENT',
          currency: 'SEK',
        },
      });
      ids.stores.push(s.id);
      return { storeId: s.id, userId };
    };
    const a = await store('a');
    storeA = a.storeId;
    creatorUserA = a.userId;
    storeB = (await store('b')).storeId;

    const customer = async (
      key: string,
      storeId: string,
      first: string,
      createdAt: Date,
    ) => {
      const u = await prisma.user.create({
        data: {
          email: `${key}-${tag}@example.test`,
          password_hash: 'x',
          role: 'CUSTOMER',
          status: 'ACTIVE',
          store_id: storeId,
          created_at: createdAt,
          customer: {
            create: {
              first_name: first,
              last_name: key.toUpperCase(),
              addresses: {
                create: [
                  {
                    full_name: first,
                    line1: 'x',
                    city: 'x',
                    postal_code: '1',
                    country_code: 'SE',
                    is_default: true,
                  },
                ],
              },
            },
          },
        },
        include: { customer: { include: { addresses: true } } },
      });
      ids.customerUsers.push(u.id);
      c[key] = u.customer!.id;
      c[`${key}_addr`] = u.customer!.addresses[0].id;
    };
    const now = Date.now();
    await customer('c1', storeA, 'Anna', new Date(now - 30 * DAY));
    await customer('c2', storeA, 'Bertil', new Date(now - 20 * DAY));
    await customer('c3', storeA, 'Cecilia', new Date(now - 10 * DAY));
    await customer('d1', storeB, 'Dora', new Date(now - 5 * DAY));

    let n = 0;
    const order = async (
      key: string,
      storeId: string,
      d: {
        total: number;
        currency?: string;
        fx?: number;
        method: 'COD' | 'STRIPE';
        payment: string | null;
        paidAt?: Date;
        status: 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'REFUNDED';
        daysAgo: number;
      },
    ) => {
      const o = await prisma.order.create({
        data: {
          order_number: `${tag}-${++n}`,
          customer_id: c[key],
          address_id: c[`${key}_addr`],
          store_id: storeId,
          status: d.status,
          subtotal: d.total,
          total: d.total,
          currency: d.currency ?? 'SEK',
          fx_rate_snapshot: d.fx ?? null,
          payment_method: d.method,
          payment_status: d.payment,
          paid_at: d.paidAt ?? null,
          created_at: new Date(now - d.daysAgo * DAY),
        },
      });
      ids.orders.push(o.id);
    };
    await order('c1', storeA, {
      total: 100,
      method: 'STRIPE',
      payment: 'paid',
      status: 'CONFIRMED',
      daysAgo: 3,
    });
    await order('c1', storeA, {
      total: 50,
      method: 'COD',
      payment: 'pending',
      status: 'PENDING',
      daysAgo: 1,
    });
    await order('c1', storeA, {
      total: 500,
      method: 'STRIPE',
      payment: 'failed',
      status: 'CANCELLED',
      daysAgo: 0.5,
    });
    await order('c1', storeA, {
      total: 999,
      method: 'STRIPE',
      payment: 'awaiting_payment',
      status: 'PENDING',
      daysAgo: 0.1,
    });
    await order('c1', storeB, {
      total: 700,
      method: 'STRIPE',
      payment: 'paid',
      status: 'CONFIRMED',
      daysAgo: 0.2,
    });
    await order('c2', storeA, {
      total: 10,
      currency: 'EUR',
      fx: 0.1,
      method: 'STRIPE',
      payment: 'paid',
      status: 'CONFIRMED',
      daysAgo: 2,
    });
    await order('c2', storeA, {
      total: 300,
      method: 'STRIPE',
      payment: 'refunded',
      status: 'REFUNDED',
      daysAgo: 4,
    });
    await order('c2', storeA, {
      total: 40,
      method: 'STRIPE',
      payment: null,
      paidAt: new Date(now - 6 * DAY),
      status: 'CONFIRMED',
      daysAgo: 6,
    });
    await order('d1', storeB, {
      total: 80,
      method: 'STRIPE',
      payment: 'paid',
      status: 'CONFIRMED',
      daysAgo: 1,
    });
  });

  afterAll(async () => {
    try {
      await prisma.order.deleteMany({ where: { id: { in: ids.orders } } });
      // Customer users first: User.store_id is ON DELETE RESTRICT.
      await prisma.user.deleteMany({
        where: { id: { in: ids.customerUsers } },
      });
      await prisma.store.deleteMany({ where: { id: { in: ids.stores } } });
      await prisma.user.deleteMany({ where: { id: { in: ids.staff } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('lists only the store customers with overview-rule aggregates', async () => {
    const svc = service();
    const store = await svc.storeForCreator(creatorUserA);
    expect(store.currency).toBe('SEK');
    const r = await svc.list(store, { sort: 'email', dir: 'asc' });
    expect(r.meta).toEqual({ total: 3, page: 1, limit: 20, totalPages: 1 });
    const byId = new Map(r.data.map((row) => [row.id, row]));
    expect(byId.has(c.d1)).toBe(false);
    expect(byId.get(c.c1)).toMatchObject({
      orders_count: 2,
      total_spent: 150,
      currency: 'SEK',
      first_name: 'Anna',
    });
    // 10 EUR at fx 0.1 = 100 SEK, + legacy paid_at 40; refund not counted.
    expect(byId.get(c.c2)).toMatchObject({ orders_count: 2, total_spent: 140 });
    expect(byId.get(c.c3)).toMatchObject({
      orders_count: 0,
      total_spent: 0,
      last_order_at: null,
    });
  });

  it('sorts by total_spent and filters by has_orders / search / date', async () => {
    const svc = service();
    const store = await svc.storeForCreator(creatorUserA);
    const spent = await svc.list(store, { sort: 'total_spent', dir: 'desc' });
    expect(spent.data.map((r) => r.id)).toEqual([c.c1, c.c2, c.c3]);
    const none = await svc.list(store, { has_orders: 'false' });
    expect(none.data.map((r) => r.id)).toEqual([c.c3]);
    expect(none.meta.total).toBe(1);
    const some = await svc.list(store, { has_orders: 'true' });
    expect(some.meta.total).toBe(2);
    const search = await svc.list(store, { search: 'berti' });
    expect(search.data.map((r) => r.id)).toEqual([c.c2]);
    const recent = await svc.list(store, {
      from: new Date(Date.now() - 15 * 86_400_000).toISOString().slice(0, 10),
    });
    expect(recent.data.map((r) => r.id)).toEqual([c.c3]);
    const paged = await svc.list(store, {
      sort: 'name',
      dir: 'asc',
      limit: 2,
      page: 2,
    });
    expect(paged.data.map((r) => r.id)).toEqual([c.c3]);
    expect(paged.meta).toEqual({ total: 3, page: 2, limit: 2, totalPages: 2 });
  });

  it('detail: stats, recent orders of this store only, addresses', async () => {
    const svc = service();
    const store = await svc.storeForCreator(creatorUserA);
    const d = await svc.detail(store, c.c1);
    expect(d.stats).toMatchObject({
      orders_count: 2,
      total_spent: 150,
      average_order: 75,
      all_orders_count: 4,
      currency: 'SEK',
    });
    expect(d.recent_orders).toHaveLength(4);
    expect(d.addresses).toHaveLength(1);
    await expect(svc.detail(store, c.d1)).rejects.toMatchObject({
      response: { code: 'CUSTOMER_NOT_FOUND' },
    });
  });

  it('CSV export carries the same rows', async () => {
    const svc = service();
    const store = await svc.storeForCreator(creatorUserA);
    const csv = await svc.exportCsv(store, { sort: 'total_spent' });
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain(',2,150.00,SEK,');
  });

  it('admin list: every store, store column, per-store totals', async () => {
    const svc = service();
    const all = await svc.adminList({ search: tag });
    const mine = all.data.filter((r) => Object.values(c).includes(r.id));
    expect(mine).toHaveLength(4);
    const d1 = mine.find((r) => r.id === c.d1)!;
    expect(d1.store).toEqual({ id: storeB, name: 'Store b', slug: `${tag}-b` });
    expect(d1.total_spent).toBe(80);
    expect(mine.find((r) => r.id === c.c1)!.total_spent).toBe(150);
    const onlyB = await svc.adminList({ store_id: storeB, search: tag });
    expect(onlyB.data.map((r) => r.id)).toEqual([c.d1]);
    const detail = await svc.adminDetail(c.d1);
    expect(detail.store.id).toBe(storeB);
    expect(storeA).not.toBe(storeB);
  });
});
