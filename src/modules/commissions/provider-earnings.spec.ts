import { FulfillerType, OrderStatus } from '@prisma/client';
import {
  CSV_MAX_ROWS,
  ProviderEarningsService,
  SUMMARY_BATCH,
  ProviderOrderRow,
  computeProviderLine,
  maskTransferId,
  rangeWhere,
  summarizeProviderLines,
} from './provider-earnings.service';
import { PROVIDER_LINE_STATUSES } from './dto/provider-earnings.dto';
import type { PrismaService } from '../../prisma/prisma.service';

const ME = 'prov-me';
const OTHER = 'prov-other';

function row(over: Partial<ProviderOrderRow> = {}): ProviderOrderRow {
  return {
    id: 'o1',
    order_number: 'MS-1',
    created_at: new Date('2026-11-02T10:00:00Z'),
    currency: 'EUR',
    status: OrderStatus.CONFIRMED,
    payment_status: 'paid',
    store_id: 's1',
    stripe_charge_id: null,
    stripe_payment_id: 'pi_1',
    stripe_account_id: null,
    items: [{ fulfiller_id: ME, provider_base_amount: 40, quantity: 2 }],
    commission: { provider_amount: 34 },
    payouts: [],
    ...over,
  };
}

function build(rows: ProviderOrderRow[], providerByUser = { u1: ME }) {
  const prisma = {
    provider: {
      findUnique: jest.fn(({ where }: { where: { user_id: string } }) =>
        Promise.resolve(
          (providerByUser as Record<string, string>)[where.user_id]
            ? {
                id: (providerByUser as Record<string, string>)[where.user_id],
              }
            : null,
        ),
      ),
    },
    order: {
      findMany: jest.fn(() => Promise.resolve(rows)),
      count: jest.fn(() => Promise.resolve(rows.length)),
    },
    orderPayout: {
      findMany: jest.fn(() => Promise.resolve([])),
      count: jest.fn(() => Promise.resolve(0)),
    },
    store: {
      findMany: jest.fn(() => Promise.resolve([{ id: 's1', name: 'Shop' }])),
    },
  };
  const service = new ProviderEarningsService(
    prisma as unknown as PrismaService,
  );
  return { prisma, service };
}

describe('computeProviderLine', () => {
  it('splits the provider pool by base, ignoring the other provider share', () => {
    const line = computeProviderLine(
      row({
        items: [
          { fulfiller_id: ME, provider_base_amount: 30, quantity: 1 },
          { fulfiller_id: OTHER, provider_base_amount: 10, quantity: 3 },
        ],
        commission: { provider_amount: 34 },
      }),
      ME,
    );
    // 3400 * 30/40 = 2550 minor units.
    expect(line.amountMinor).toBe(2550);
    expect(line.grossMinor).toBe(3000);
    expect(line.itemsCount).toBe(1);
    expect(line.status).toBe('pending');
  });

  it('uses the payout ledger amount once transferred', () => {
    const line = computeProviderLine(
      row({
        payouts: [
          {
            status: 'paid',
            amount: 33.99,
            stripe_transfer_id: 'tr_123',
            updated_at: new Date(),
          },
        ],
      }),
      ME,
    );
    expect(line.status).toBe('transferred');
    expect(line.amountMinor).toBe(3399);
    expect(line.transferredMinor).toBe(3399);
  });

  it('classifies by precedence', () => {
    const paidPayout = [
      {
        status: 'paid',
        amount: 34,
        stripe_transfer_id: 'tr_1',
        updated_at: new Date(),
      },
    ];
    expect(
      computeProviderLine(
        row({ status: OrderStatus.REFUNDED, payouts: paidPayout }),
        ME,
      ).status,
    ).toBe('refunded');
    expect(
      computeProviderLine(row({ payment_status: 'refunded' }), ME).status,
    ).toBe('refunded');
    expect(
      computeProviderLine(row({ status: OrderStatus.CANCELLED }), ME).status,
    ).toBe('cancelled');
    expect(
      computeProviderLine(
        row({
          payouts: [{ ...paidPayout[0], status: 'failed' }],
        }),
        ME,
      ).status,
    ).toBe('failed');
    expect(
      computeProviderLine(row({ payment_status: 'awaiting_payment' }), ME)
        .status,
    ).toBe('unpaid');
    // COD: delivered means collected.
    expect(
      computeProviderLine(
        row({ payment_status: 'pending', status: OrderStatus.DELIVERED }),
        ME,
      ).status,
    ).toBe('pending');
  });

  it('marks paid orders without a platform charge as offline', () => {
    const noCharge = { stripe_charge_id: null, stripe_payment_id: null };
    // Kustom / any paid order without a Stripe charge.
    expect(computeProviderLine(row(noCharge), ME).status).toBe('offline');
    // COD delivered.
    expect(
      computeProviderLine(
        row({
          ...noCharge,
          payment_status: 'pending',
          status: OrderStatus.DELIVERED,
        }),
        ME,
      ).status,
    ).toBe('offline');
    // Direct charge on the creator's own account.
    expect(
      computeProviderLine(row({ stripe_account_id: 'acct_1' }), ME).status,
    ).toBe('offline');
    // Own Stripe key / direct-route orders never reach platform payouts,
    // even without a connected-account snapshot.
    expect(
      computeProviderLine(row({ payment_route: 'OWN_KEY' }), ME).status,
    ).toBe('offline');
    expect(
      computeProviderLine(row({ payment_route: 'CONNECT_DIRECT' }), ME).status,
    ).toBe('offline');
    expect(
      computeProviderLine(row({ payment_route: 'PLATFORM' }), ME).status,
    ).toBe('pending');
    // A charge id alone is enough for a platform transfer.
    expect(
      computeProviderLine(
        row({ stripe_payment_id: null, stripe_charge_id: 'ch_1' }),
        ME,
      ).status,
    ).toBe('pending');
    // Not collected yet stays unpaid; refunds still win.
    expect(
      computeProviderLine(
        row({ ...noCharge, payment_status: 'awaiting_payment' }),
        ME,
      ).status,
    ).toBe('unpaid');
    expect(
      computeProviderLine(
        row({ ...noCharge, status: OrderStatus.REFUNDED }),
        ME,
      ).status,
    ).toBe('refunded');
  });

  it('handles zero-decimal currencies in whole units', () => {
    const line = computeProviderLine(
      row({
        currency: 'JPY',
        items: [{ fulfiller_id: ME, provider_base_amount: 1000, quantity: 1 }],
        commission: { provider_amount: 850 },
      }),
      ME,
    );
    expect(line.amountMinor).toBe(850);
  });
});

describe('summarizeProviderLines', () => {
  it('never mixes currencies', () => {
    const out = summarizeProviderLines([
      computeProviderLine(row({ currency: 'EUR' }), ME),
      computeProviderLine(row({ currency: 'sek' }), ME),
      computeProviderLine(row({ currency: 'SEK' }), ME),
    ]);
    expect(out.map((b) => b.currency)).toEqual(['SEK', 'EUR']);
    expect(out[0]).toMatchObject({ orders: 2, earned: 68, pending: 68 });
    expect(out[1]).toMatchObject({ orders: 1, earned: 34, gross: 40 });
  });

  it('writes refunded orders off and surfaces transfers already sent', () => {
    const transferred = {
      status: 'paid',
      amount: 34,
      stripe_transfer_id: 'tr_abc',
      updated_at: new Date(),
    };
    const out = summarizeProviderLines([
      computeProviderLine(row({ payouts: [transferred] }), ME),
      computeProviderLine(
        row({ status: OrderStatus.REFUNDED, payouts: [transferred] }),
        ME,
      ),
      computeProviderLine(row({ status: OrderStatus.RETURNED }), ME),
      computeProviderLine(row({ status: OrderStatus.CANCELLED }), ME),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      // Cancelled orders are not counted.
      orders: 3,
      refunded_orders: 2,
      earned: 34,
      pending: 0,
      transferred: 68,
      refunded: 68,
      refunded_after_transfer: 34,
      gross: 120,
    });
  });
});

describe('summarizeProviderLines offline', () => {
  it('counts offline in earned but not in pending', () => {
    const out = summarizeProviderLines([
      computeProviderLine(row(), ME),
      computeProviderLine(
        row({ stripe_payment_id: null, stripe_charge_id: null }),
        ME,
      ),
    ]);
    expect(out[0]).toMatchObject({
      orders: 2,
      earned: 68,
      pending: 34,
      offline: 34,
      transferred: 0,
    });
  });
});

describe('helpers', () => {
  it('masks transfer ids to the tail', () => {
    expect(maskTransferId('tr_1PqRsTuVwXyZ12')).toBe('tr_…wXyZ12');
    expect(maskTransferId(null)).toBeNull();
  });

  it('treats a date-only `to` as inclusive', () => {
    const r = rangeWhere({ from: '2026-11-01', to: '2026-11-30' });
    expect(r?.gte?.toString()).toBe(new Date('2026-11-01').toString());
    expect((r?.lt as Date).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(rangeWhere({})).toBeUndefined();
  });
});

describe('ProviderEarningsService', () => {
  it('scopes every query to the caller provider (ownership)', async () => {
    const { service, prisma } = build([row()]);
    await service.summary('u1', {});
    expect(prisma.provider.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: 'u1' } }),
    );
    const args = (prisma.order.findMany.mock.calls[0] as unknown[])[0] as {
      where: { items: unknown };
      select: { payouts: { where: unknown } };
    };
    expect(args.where.items).toEqual({
      some: { fulfiller_type: FulfillerType.PROVIDER, fulfiller_id: ME },
    });
    expect(args.select.payouts.where).toEqual({
      recipient_type: FulfillerType.PROVIDER,
      recipient_id: ME,
    });
  });

  it('returns nothing for a user without a provider row', async () => {
    const { service, prisma } = build([row()]);
    expect(await service.summary('stranger', {})).toEqual({ by_currency: [] });
    const lines = await service.lines('stranger', {});
    expect(lines.data).toEqual([]);
    const payouts = await service.payouts('stranger', {});
    expect(payouts.data).toEqual([]);
    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expect(prisma.orderPayout.findMany).not.toHaveBeenCalled();
  });

  it('scopes payouts to the provider recipient', async () => {
    const { service, prisma } = build([]);
    prisma.orderPayout.findMany.mockResolvedValueOnce([
      {
        id: 'p1',
        order_id: 'o1',
        amount: 34,
        currency: 'eur',
        status: 'paid',
        stripe_transfer_id: 'tr_1PqRsTuVwXyZ12',
        error: 'stale',
        created_at: new Date(),
        updated_at: new Date(),
        order: {
          order_number: 'MS-1',
          status: OrderStatus.REFUNDED,
          payment_status: 'refunded',
        },
      },
    ] as never);
    prisma.orderPayout.count.mockResolvedValueOnce(41 as never);
    const res = await service.payouts('u1', { page: 3, limit: 20 });
    const args = (
      prisma.orderPayout.findMany.mock.calls[0] as unknown[]
    )[0] as {
      where: unknown;
      skip: number;
      take: number;
    };
    expect(args.where).toEqual({
      recipient_type: FulfillerType.PROVIDER,
      recipient_id: ME,
    });
    expect(args.skip).toBe(40);
    expect(args.take).toBe(20);
    expect(res.meta).toEqual({ total: 41, page: 3, limit: 20, totalPages: 3 });
    expect(res.data[0]).toMatchObject({
      currency: 'EUR',
      stripe_transfer_id: 'tr_…wXyZ12',
      error: null,
      order_refunded: true,
    });
  });

  it('paginates lines with a capped limit and stable order', async () => {
    const { service, prisma } = build([row()]);
    prisma.order.count.mockResolvedValueOnce(250 as never);
    const res = await service.lines('u1', { page: 2, limit: 500 });
    const args = (prisma.order.findMany.mock.calls[0] as unknown[])[0] as {
      skip: number;
      take: number;
      orderBy: unknown;
    };
    expect(args.take).toBe(100);
    expect(args.skip).toBe(100);
    expect(args.orderBy).toEqual([{ created_at: 'desc' }, { id: 'desc' }]);
    expect(res.meta).toEqual({
      total: 250,
      page: 2,
      limit: 100,
      totalPages: 3,
    });
    expect(res.data[0]).toMatchObject({
      order_number: 'MS-1',
      store: { id: 's1', name: 'Shop' },
      items_count: 2,
      gross: 40,
      amount: 34,
      currency: 'EUR',
      status: 'pending',
    });
  });

  it('adds the status twin and the currency to the lines filter', async () => {
    const { service, prisma } = build([]);
    await service.lines('u1', { status: 'refunded', currency: 'sek' });
    const args = (prisma.order.findMany.mock.calls[0] as unknown[])[0] as {
      where: { AND: [{ currency: unknown }, unknown] };
    };
    expect(args.where.AND[0].currency).toEqual({
      equals: 'SEK',
      mode: 'insensitive',
    });
    expect(args.where.AND[1]).toEqual({
      OR: [
        { status: { in: [OrderStatus.REFUNDED, OrderStatus.RETURNED] } },
        { payment_status: 'refunded' },
      ],
    });
  });

  it('has a SQL filter for every line status', () => {
    const { service } = build([]);
    for (const s of PROVIDER_LINE_STATUSES) {
      expect(service.statusWhere(ME, s)).toBeTruthy();
    }
  });

  it('folds the summary in keyset batches equal to the full fold', async () => {
    const total = SUMMARY_BATCH * 2 + 7;
    const rows = Array.from({ length: total }, (_, i) =>
      row({
        id: `o${String(i).padStart(6, '0')}`,
        currency: i % 3 === 0 ? 'SEK' : 'EUR',
        status: i % 7 === 0 ? OrderStatus.REFUNDED : OrderStatus.CONFIRMED,
        stripe_payment_id: i % 5 === 0 ? null : 'pi_1',
      }),
    );
    const { service, prisma } = build([]);
    prisma.order.findMany.mockImplementation(((args: {
      where: { AND?: [unknown, { id: { gt: string } }] };
      take: number;
    }) => {
      const gt = args.where.AND?.[1]?.id.gt;
      return Promise.resolve(
        rows.filter((r) => !gt || r.id > gt).slice(0, args.take),
      );
    }) as never);
    const res = await service.summary('u1', {});
    expect(prisma.order.findMany).toHaveBeenCalledTimes(3);
    for (const call of prisma.order.findMany.mock.calls as unknown[][]) {
      const a = call[0] as { take: number; orderBy: unknown };
      expect(a.take).toBe(SUMMARY_BATCH);
      expect(a.orderBy).toEqual({ id: 'asc' });
    }
    expect(res.by_currency).toEqual(
      summarizeProviderLines(rows.map((r) => computeProviderLine(r, ME))),
    );
  });

  it('flags a CSV that hit the row cap with a marker row', async () => {
    const rows = Array.from({ length: CSV_MAX_ROWS + 1 }, (_, i) =>
      row({ id: `o${i}` }),
    );
    const { service, prisma } = build([]);
    prisma.order.findMany.mockImplementation(((args: {
      skip?: number;
      take: number;
    }) =>
      Promise.resolve(
        rows.slice(args.skip ?? 0, (args.skip ?? 0) + args.take),
      )) as never);
    const { csv, truncated } = await service.linesCsv('u1', {});
    expect(truncated).toBe(true);
    const lines = csv.trim().split('\r\n');
    // Header + cap + marker.
    expect(lines).toHaveLength(CSV_MAX_ROWS + 2);
    expect(lines[lines.length - 1]).toBe(
      `Truncated at ${CSV_MAX_ROWS} rows — narrow the date range,,,,,,,,`,
    );
  });

  it('splits the pending and offline filters on the platform charge', () => {
    const { service } = build([]);
    const json = (x: unknown) => JSON.stringify(x);
    expect(json(service.statusWhere(ME, 'pending'))).toContain(
      '"stripe_account_id":null',
    );
    expect(json(service.statusWhere(ME, 'offline'))).toContain(
      '"stripe_account_id":{"not":null}',
    );
    // OWN_KEY / CONNECT_DIRECT routes are offline, legacy null stays pending.
    expect(json(service.statusWhere(ME, 'offline'))).toContain(
      '"payment_route":{"in":["OWN_KEY","CONNECT_DIRECT"]}',
    );
    expect(json(service.statusWhere(ME, 'pending'))).toContain(
      '"payment_route":{"notIn":["OWN_KEY","CONNECT_DIRECT"]}',
    );
    expect(json(service.statusWhere(ME, 'pending'))).toContain(
      '"payment_route":null',
    );
  });

  it('exports CSV in batches with the same filters', async () => {
    const { service } = build([row({ store_id: 's1', order_number: '=MS-9' })]);
    const { csv, truncated } = await service.linesCsv('u1', {});
    expect(truncated).toBe(false);
    const [header, first] = csv.trim().split('\r\n');
    expect(header).toBe(
      'order_number,date,store,items,gross,amount,currency,status,transfer_id',
    );
    // Formula-looking cells are neutralized.
    expect(first).toBe("'=MS-9,2026-11-02,Shop,2,40.00,34.00,EUR,pending,");
  });
});
