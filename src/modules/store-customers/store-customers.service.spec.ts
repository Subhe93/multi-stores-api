import { Prisma, UserRole } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  CUSTOMERS_CSV_COLUMNS,
  StoreCustomersService,
  customersCsv,
  parseDateBound,
  type CustomerListRow,
  type CustomerStoreScope,
} from './store-customers.service';
import { countedOrderSql, storeAmountSql } from '../overview/overview-range';

const STORE: CustomerStoreScope = {
  id: 'store-a',
  slug: 'shop-a',
  name: 'Shop A',
  currency: 'SEK',
};

function customerRow(over: Record<string, unknown> = {}) {
  return {
    id: 'cust-1',
    first_name: 'Anna',
    last_name: 'Berg',
    phone: null,
    customer_type: null,
    company_name: null,
    org_number: null,
    vat_number: null,
    updated_at: new Date('2026-10-01T00:00:00Z'),
    user: {
      id: 'user-1',
      email: 'anna@example.com',
      role: UserRole.CUSTOMER,
      status: 'ACTIVE',
      store_id: 'store-a',
      created_at: new Date('2026-09-01T00:00:00Z'),
    },
    ...over,
  };
}

function build() {
  const prisma = {
    creator: { findUnique: jest.fn() },
    store: { findUnique: jest.fn(), findMany: jest.fn(() => []) },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'EUR' })),
    },
    customer: {
      findUnique: jest.fn(() => Promise.resolve(customerRow())),
      findMany: jest.fn(() => Promise.resolve([])),
      update: jest.fn(),
    },
    user: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(() =>
        Promise.resolve({
          id: 'user-new',
          email: 'new@example.com',
          role: UserRole.CUSTOMER,
        }),
      ),
      update: jest.fn(),
    },
    session: { deleteMany: jest.fn() },
    emailLog: { count: jest.fn(() => Promise.resolve(0)) },
    address: {
      findMany: jest.fn(() => Promise.resolve([])),
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
    order: {
      count: jest.fn(() => Promise.resolve(0)),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    storeCustomerTaxExemption: { findFirst: jest.fn(() => null) },
    $queryRaw: jest.fn(
      (..._args: unknown[]): Promise<unknown[]> => Promise.resolve([]),
    ),
  };
  const magicLinks = {
    issue: jest.fn(() => Promise.resolve('raw-token')),
    invalidateForUser: jest.fn(),
  };
  const links = {
    resolveStore: jest.fn(() =>
      Promise.resolve({
        id: 'store-a',
        slug: 'shop-a',
        name: 'Shop A',
        primaryLocale: 'sv',
        isActive: true,
        base: 'https://shop-a.example',
      }),
    ),
    accountLinks: jest.fn(() => ({
      magicUrl: 'https://shop-a.example/auth/magic#token=raw-token',
      loginUrl: 'https://shop-a.example/auth/login',
    })),
  };
  const credentials = { send: jest.fn(() => Promise.resolve()) };
  const auth = { forgotPassword: jest.fn(() => Promise.resolve({})) };
  const mail = { sendCustomerLoginLink: jest.fn(() => Promise.resolve()) };
  const service = new StoreCustomersService(
    prisma as unknown as PrismaService,
    magicLinks as never,
    links as never,
    credentials as never,
    auth as never,
    mail as never,
  );
  return { service, prisma, magicLinks, links, credentials, auth, mail };
}

/** The SQL text of every $queryRaw call. */
function sqlTexts(mock: jest.Mock): string[] {
  return mock.mock.calls.map((c: unknown[]) => (c[0] as Prisma.Sql).sql);
}

describe('StoreCustomersService', () => {
  describe('store resolution', () => {
    it('404 STORE_NOT_FOUND for a creator without a store', async () => {
      const { service, prisma } = build();
      prisma.creator.findUnique.mockResolvedValue({ store: null });
      await expect(service.storeForCreator('u')).rejects.toMatchObject({
        response: { code: 'STORE_NOT_FOUND' },
      });
    });

    it('marketplace stores use the platform currency (overview rule)', async () => {
      const { service, prisma } = build();
      prisma.creator.findUnique.mockResolvedValue({
        store: {
          id: 's',
          slug: 'm',
          name: 'M',
          store_type: 'MARKETPLACE',
          currency: 'SEK',
        },
      });
      await expect(service.storeForCreator('u')).resolves.toMatchObject({
        id: 's',
        currency: 'EUR',
      });
    });
  });

  describe('list', () => {
    it('reuses countedOrderSql + storeAmountSql and scopes by User.store_id', async () => {
      const { service, prisma } = build();
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ n: 0 }]);
      const r = await service.list(STORE, {});
      expect(r).toEqual({
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
      });
      const [rowsSql] = prisma.$queryRaw.mock.calls[0] as [Prisma.Sql];
      const counted = countedOrderSql('o');
      const amount = storeAmountSql(Prisma.sql`o.total`, 'SEK');
      expect(rowsSql.sql).toContain(counted.sql);
      expect(rowsSql.sql).toContain(amount.sql);
      expect(rowsSql.sql).toContain('o.store_id = u.store_id');
      expect(rowsSql.sql).toContain('u.store_id = ');
      expect(rowsSql.values).toContain('store-a');
      expect(rowsSql.values).toContain('SEK');
    });

    it('maps rows and clamps paging', async () => {
      const { service, prisma } = build();
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'c1',
            user_id: 'u1',
            first_name: 'A',
            last_name: 'B',
            email: 'a@x',
            phone: null,
            status: 'ACTIVE',
            customer_type: 'COMPANY',
            company_name: 'AB',
            store_id: 'store-a',
            orders_count: 2,
            total_spent: 149.999,
            last_order_at: new Date('2026-10-02T10:00:00Z'),
            created_at: new Date('2026-09-01T00:00:00Z'),
          },
        ])
        .mockResolvedValueOnce([{ n: 41 }]);
      const r = await service.list(STORE, { page: 2, limit: 500 });
      expect(r.meta).toEqual({ total: 41, page: 2, limit: 100, totalPages: 1 });
      expect(r.data[0]).toEqual({
        id: 'c1',
        user_id: 'u1',
        first_name: 'A',
        last_name: 'B',
        email: 'a@x',
        phone: null,
        status: 'ACTIVE',
        customer_type: 'COMPANY',
        company_name: 'AB',
        orders_count: 2,
        total_spent: 150,
        currency: 'SEK',
        last_order_at: '2026-10-02T10:00:00.000Z',
        created_at: '2026-09-01T00:00:00.000Z',
      });
    });

    it('sort keys map to fixed SQL; search wildcards are escaped', async () => {
      const { service, prisma } = build();
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ n: 0 }]);
      await service.list(STORE, {
        sort: 'total_spent',
        dir: 'asc',
        search: '50%_off',
        has_orders: 'true',
        customer_type: 'COMPANY',
      });
      const [rows] = sqlTexts(prisma.$queryRaw);
      expect(rows).toContain('ORDER BY COALESCE(a.total_spent, 0) ASC');
      expect(rows).toContain('a.orders_count > 0');
      expect(rows).toContain(`c.customer_type::text = 'COMPANY'`);
      const values = (prisma.$queryRaw.mock.calls[0] as [Prisma.Sql])[0].values;
      expect(values).toContain('%50\\%\\_off%');
    });

    it('admin list never sorts by total_spent (mixed currencies)', async () => {
      const { service, prisma } = build();
      prisma.$queryRaw.mockResolvedValue([]);
      await service.adminList({ sort: 'total_spent' });
      const [rows] = sqlTexts(prisma.$queryRaw);
      expect(rows).toContain('ORDER BY u.created_at DESC');
      expect(rows).toContain('u.store_id IS NOT NULL');
    });
  });

  describe('detail scoping', () => {
    it('404 CUSTOMER_NOT_FOUND for a customer of another store', async () => {
      const { service, prisma } = build();
      prisma.customer.findUnique.mockResolvedValue(
        customerRow({
          user: { ...customerRow().user, store_id: 'store-b' },
        }),
      );
      await expect(service.detail(STORE, 'cust-1')).rejects.toMatchObject({
        response: { code: 'CUSTOMER_NOT_FOUND' },
      });
      await expect(
        service.setStatus(STORE, 'cust-1', 'SUSPENDED'),
      ).rejects.toMatchObject({ response: { code: 'CUSTOMER_NOT_FOUND' } });
      await expect(
        service.sendLoginLink(STORE, 'cust-1'),
      ).rejects.toMatchObject({ response: { code: 'CUSTOMER_NOT_FOUND' } });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('404 for a staff profile', async () => {
      const { service, prisma } = build();
      prisma.customer.findUnique.mockResolvedValue(
        customerRow({
          user: { ...customerRow().user, role: UserRole.CREATOR },
        }),
      );
      await expect(service.detail(STORE, 'cust-1')).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('create', () => {
    it('409 AUTH_EMAIL_EXISTS when the store already has the email', async () => {
      const { service, prisma } = build();
      prisma.user.findFirst.mockResolvedValue({ id: 'x' } as never);
      await expect(
        service.create(STORE, { email: 'Anna@Example.com' }),
      ).rejects.toMatchObject({ response: { code: 'AUTH_EMAIL_EXISTS' } });
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: {
          store_id: 'store-a',
          email: { equals: 'anna@example.com', mode: 'insensitive' },
        },
        select: { id: true },
      });
    });

    it('409 on a unique race (P2002)', async () => {
      const { service, prisma } = build();
      prisma.user.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'x',
        }),
      );
      await expect(
        service.create(STORE, { email: 'a@b.se' }),
      ).rejects.toMatchObject({ response: { code: 'AUTH_EMAIL_EXISTS' } });
    });

    it('creates a store customer and mails credentials on the store domain', async () => {
      const { service, prisma, credentials } = build();
      prisma.customer.findUnique
        .mockResolvedValueOnce({ id: 'cust-new' } as never)
        .mockResolvedValue(customerRow({ id: 'cust-new' }));
      await service.create(STORE, {
        email: ' New@Example.com ',
        first_name: 'Nora',
      });
      const data = (prisma.user.create.mock.calls[0] as unknown[])[0] as {
        data: Record<string, unknown>;
      };
      expect(data.data).toMatchObject({
        email: 'new@example.com',
        role: 'CUSTOMER',
        status: 'ACTIVE',
        store_id: 'store-a',
      });
      expect(String(data.data.password_hash)).toMatch(/^\$2[aby]\$/);
      expect(credentials.send).toHaveBeenCalledWith(
        expect.objectContaining({
          store: { id: 'store-a', name: 'Shop A' },
          storeBase: 'https://shop-a.example',
          locale: 'sv',
          name: 'Nora',
        }),
      );
      const sent = (credentials.send.mock.calls[0] as unknown[])[0] as {
        password: string;
      };
      expect(sent.password).toHaveLength(16);
    });

    it('429 STORE_DAILY_EMAIL_LIMIT at 200 credential mails per store per 24 h; nothing is created', async () => {
      const { service, prisma, credentials } = build();
      prisma.emailLog.count.mockResolvedValue(200);
      const err = await service
        .create(STORE, { email: 'a@b.se' })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        status: 429,
        response: { code: 'STORE_DAILY_EMAIL_LIMIT' },
      });
      expect(prisma.emailLog.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          store_id: 'store-a',
          event: 'account_created',
        }),
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(credentials.send).not.toHaveBeenCalled();
    });

    it('the daily cap does not apply without credentials or for the admin', async () => {
      const { service, prisma } = build();
      prisma.emailLog.count.mockResolvedValue(10_000);
      prisma.customer.findUnique
        .mockResolvedValueOnce({ id: 'cust-new' } as never)
        .mockResolvedValueOnce(customerRow())
        .mockResolvedValueOnce({ id: 'cust-new' } as never)
        .mockResolvedValue(customerRow());
      await service.create(STORE, { email: 'a@b.se', send_credentials: false });
      await service.create(
        STORE,
        { email: 'c@d.se' },
        { enforceDailyLimit: false },
      );
      expect(prisma.user.create).toHaveBeenCalledTimes(2);
      expect(prisma.emailLog.count).not.toHaveBeenCalled();
    });

    it('send_credentials=false sends nothing', async () => {
      const { service, prisma, credentials } = build();
      prisma.customer.findUnique
        .mockResolvedValueOnce({ id: 'cust-new' } as never)
        .mockResolvedValue(customerRow());
      await service.create(STORE, {
        email: 'a@b.se',
        send_credentials: false,
      });
      expect(credentials.send).not.toHaveBeenCalled();
    });
  });

  describe('status and emails', () => {
    it('blocking revokes sessions and login tokens', async () => {
      const { service, prisma, magicLinks } = build();
      await expect(
        service.setStatus(STORE, 'cust-1', 'SUSPENDED'),
      ).resolves.toEqual({
        id: 'cust-1',
        user_id: 'user-1',
        status: 'SUSPENDED',
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { status: 'SUSPENDED', tokens_valid_after: expect.any(Date) },
      });
      expect(prisma.session.deleteMany).toHaveBeenCalledWith({
        where: { user_id: 'user-1' },
      });
      expect(magicLinks.invalidateForUser).toHaveBeenCalledWith('user-1');
    });

    it('unblocking does not touch sessions', async () => {
      const { service, prisma, magicLinks } = build();
      await service.setStatus(STORE, 'cust-1', 'ACTIVE');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { status: 'ACTIVE' },
      });
      expect(prisma.session.deleteMany).not.toHaveBeenCalled();
      expect(magicLinks.invalidateForUser).not.toHaveBeenCalled();
    });

    it('403 CUSTOMER_BANNED_BY_ADMIN: the owner cannot change a platform ban', async () => {
      const { service, prisma } = build();
      prisma.customer.findUnique.mockResolvedValue(
        customerRow({ user: { ...customerRow().user, status: 'BANNED' } }),
      );
      for (const status of ['ACTIVE', 'SUSPENDED'] as const) {
        const err = await service
          .setStatus(STORE, 'cust-1', status)
          .catch((e: unknown) => e);
        expect(err).toMatchObject({
          status: 403,
          response: { code: 'CUSTOMER_BANNED_BY_ADMIN' },
        });
      }
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('send-login-link: 429 STORE_DAILY_EMAIL_LIMIT at 300 per store per 24 h', async () => {
      const { service, prisma, magicLinks, mail } = build();
      prisma.emailLog.count.mockResolvedValue(300);
      const err = await service
        .sendLoginLink(STORE, 'cust-1')
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        status: 429,
        response: { code: 'STORE_DAILY_EMAIL_LIMIT' },
      });
      const where = (
        prisma.emailLog.count.mock.calls[0] as unknown as [
          { where: Record<string, unknown> },
        ]
      )[0].where;
      expect(where).toMatchObject({
        store_id: 'store-a',
        event: 'customer_login_link',
      });
      const since = (where.created_at as { gte: Date }).gte.getTime();
      expect(Math.abs(Date.now() - 24 * 3600 * 1000 - since)).toBeLessThan(
        5000,
      );
      expect(magicLinks.issue).not.toHaveBeenCalled();
      expect(mail.sendCustomerLoginLink).not.toHaveBeenCalled();

      prisma.emailLog.count.mockResolvedValue(299);
      await expect(service.sendLoginLink(STORE, 'cust-1')).resolves.toEqual({
        sent: true,
      });
    });

    it('send-login-link issues a store-scoped token and mails it', async () => {
      const { service, magicLinks, links, mail } = build();
      await expect(service.sendLoginLink(STORE, 'cust-1')).resolves.toEqual({
        sent: true,
      });
      expect(magicLinks.issue).toHaveBeenCalledWith('user-1', {
        storeId: 'store-a',
        ttlHours: 72,
      });
      expect(links.accountLinks).toHaveBeenCalledWith('raw-token', {
        role: 'CUSTOMER',
        storeBase: 'https://shop-a.example',
        locale: 'sv',
      });
      expect(mail.sendCustomerLoginLink).toHaveBeenCalledWith(
        'anna@example.com',
        expect.objectContaining({ name: 'Anna', expiresHours: 72 }),
        'sv',
        { storeId: 'store-a', storeName: 'Shop A' },
      );
    });

    it('send-password-reset reuses forgot-password with the store context', async () => {
      const { service, auth } = build();
      await service.sendPasswordReset(STORE, 'cust-1');
      expect(auth.forgotPassword).toHaveBeenCalledWith(
        'anna@example.com',
        'shop-a',
      );
    });

    it('400 CUSTOMER_NOT_ACTIVE for emails to a blocked customer', async () => {
      const { service, prisma, auth, mail } = build();
      prisma.customer.findUnique.mockResolvedValue(
        customerRow({ user: { ...customerRow().user, status: 'SUSPENDED' } }),
      );
      await expect(
        service.sendLoginLink(STORE, 'cust-1'),
      ).rejects.toMatchObject({ response: { code: 'CUSTOMER_NOT_ACTIVE' } });
      await expect(
        service.sendPasswordReset(STORE, 'cust-1'),
      ).rejects.toMatchObject({ response: { code: 'CUSTOMER_NOT_ACTIVE' } });
      expect(auth.forgotPassword).not.toHaveBeenCalled();
      expect(mail.sendCustomerLoginLink).not.toHaveBeenCalled();
    });
  });

  describe('bulk', () => {
    it('only touches customers of the store; reports the rest', async () => {
      const { service, prisma, mail } = build();
      prisma.customer.findMany.mockResolvedValue([
        {
          id: 'c1',
          first_name: 'A',
          user: { id: 'u1', email: 'a@x', status: 'ACTIVE' },
        },
        {
          id: 'c2',
          first_name: 'B',
          user: { id: 'u2', email: 'b@x', status: 'SUSPENDED' },
        },
      ] as never);
      const r = await service.bulk(STORE, {
        ids: ['c1', 'c2', 'foreign', 'c1'],
        action: 'send-login-link',
      });
      expect(prisma.customer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: { in: ['c1', 'c2', 'foreign'] },
            user: { role: 'CUSTOMER', store_id: 'store-a' },
          },
        }),
      );
      expect(r).toEqual({
        action: 'send-login-link',
        requested: 3,
        succeeded: ['c1'],
        skipped: [
          { id: 'c2', reason: 'not_active' },
          { id: 'foreign', reason: 'not_found' },
        ],
      });
      expect(mail.sendCustomerLoginLink).toHaveBeenCalledTimes(1);
    });

    it('block/unblock skip a BANNED customer (reason banned)', async () => {
      const { service, prisma } = build();
      prisma.customer.findMany.mockResolvedValue([
        {
          id: 'c1',
          first_name: 'A',
          user: { id: 'u1', email: 'a@x', status: 'BANNED' },
        },
        {
          id: 'c2',
          first_name: 'B',
          user: { id: 'u2', email: 'b@x', status: 'SUSPENDED' },
        },
      ] as never);
      for (const action of ['block', 'unblock'] as const) {
        prisma.user.update.mockClear();
        const r = await service.bulk(STORE, { ids: ['c1', 'c2'], action });
        expect(r.succeeded).toEqual(['c2']);
        expect(r.skipped).toEqual([{ id: 'c1', reason: 'banned' }]);
        expect(prisma.user.update).toHaveBeenCalledTimes(1);
        expect(prisma.user.update).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: 'u2' } }),
        );
      }
    });

    it('send-login-link stops at the daily cap (reason daily_limit)', async () => {
      const { service, prisma, mail } = build();
      prisma.emailLog.count.mockResolvedValue(298);
      prisma.customer.findMany.mockResolvedValue(
        ['c1', 'c2', 'c3', 'c4'].map((id) => ({
          id,
          first_name: id,
          user: { id: `u-${id}`, email: `${id}@x`, status: 'ACTIVE' },
        })) as never,
      );
      const r = await service.bulk(STORE, {
        ids: ['c1', 'c2', 'c3', 'c4'],
        action: 'send-login-link',
      });
      expect(r.succeeded).toEqual(['c1', 'c2']);
      expect(r.skipped).toEqual([
        { id: 'c3', reason: 'daily_limit' },
        { id: 'c4', reason: 'daily_limit' },
      ]);
      expect(mail.sendCustomerLoginLink).toHaveBeenCalledTimes(2);
      expect(prisma.emailLog.count).toHaveBeenCalledTimes(1);
    });

    it('block suspends and revokes', async () => {
      const { service, prisma, magicLinks } = build();
      prisma.customer.findMany.mockResolvedValue([
        {
          id: 'c1',
          first_name: 'A',
          user: { id: 'u1', email: 'a@x', status: 'ACTIVE' },
        },
      ] as never);
      const r = await service.bulk(STORE, { ids: ['c1'], action: 'block' });
      expect(r.succeeded).toEqual(['c1']);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { status: 'SUSPENDED', tokens_valid_after: expect.any(Date) },
      });
      expect(magicLinks.invalidateForUser).toHaveBeenCalledWith('u1');
    });
  });

  describe('update', () => {
    it('normalizes the B2B fields and clears blanks', async () => {
      const { service, prisma } = build();
      await service.update(STORE, 'cust-1', {
        first_name: 'Anna',
        phone: '',
        company_name: '  Acme   AB ',
        vat_number: 'se 5560 1234 5601',
        org_number: '',
        customer_type: 'COMPANY',
      });
      expect(prisma.customer.update).toHaveBeenCalledWith({
        where: { id: 'cust-1' },
        data: {
          first_name: 'Anna',
          phone: null,
          company_name: 'Acme AB',
          vat_number: 'SE556012345601',
          org_number: null,
          customer_type: 'COMPANY',
        },
      });
    });
  });
});

describe('customersCsv', () => {
  const row: CustomerListRow = {
    id: 'c1',
    user_id: 'u1',
    first_name: '=HYPERLINK("http://x")',
    last_name: '+cmd',
    email: '@evil@example.com',
    phone: '-123',
    status: 'ACTIVE',
    customer_type: null,
    company_name: 'Acme, "AB"',
    orders_count: 2,
    total_spent: 150,
    currency: 'SEK',
    last_order_at: null,
    created_at: '2026-09-01T00:00:00.000Z',
  };

  it('guards formulas, quotes commas and keeps amounts numeric', () => {
    const csv = customersCsv([row]);
    const [header, line] = csv.trim().split('\r\n');
    expect(header).toBe(CUSTOMERS_CSV_COLUMNS.join(','));
    expect(line).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(line).toContain(`,'+cmd,`);
    expect(line).toContain(`,'@evil@example.com,`);
    expect(line).toContain(`,'-123,`);
    expect(line).toContain(`,"Acme, ""AB""",`);
    expect(line).toContain(',2,150.00,SEK,');
  });
});

describe('parseDateBound', () => {
  it('day bounds are inclusive UTC days', () => {
    expect(parseDateBound('2026-10-01', 'from')?.toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
    expect(parseDateBound('2026-10-01', 'to')?.toISOString()).toBe(
      '2026-10-01T23:59:59.999Z',
    );
    expect(parseDateBound(undefined, 'to')).toBeNull();
    expect(() => parseDateBound('2026-13-45', 'from')).toThrow();
  });
});
