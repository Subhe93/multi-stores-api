import { CommissionsService } from './commissions.service';
import { PrismaService } from '../../prisma/prisma.service';

// GET /commissions/summary for the creator of a MARKETPLACE store: the
// creator's amount of a cash-on-delivery order never passes through the
// platform (no payout), so it is reported as `offline` and leaves `pending`
// and `by_currency[].paid`. Earned totals are unchanged. An INDEPENDENT
// store and the provider role answer exactly as before.

type Row = {
  id: string;
  creator_amount: number;
  provider_amount: number;
  platform_amount: number;
  vat_amount: number;
  currency: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  created_at: Date;
  order: { payment_method: string; items?: unknown[] };
};

/** The summary answer, with its additive keys. */
type Summary = {
  total_earnings: number;
  this_month: number;
  pending: number;
  total_orders: number;
  offline?: number;
  by_currency?: Record<string, unknown>[];
};

const old = new Date('2020-01-01T00:00:00Z');

const row = (
  id: string,
  payment_method: string,
  status: Row['status'],
  creator_amount: number,
  currency = 'EUR',
): Row => ({
  id,
  creator_amount,
  provider_amount: 50,
  platform_amount: 5,
  vat_amount: 0,
  currency,
  status,
  created_at: old,
  order: { payment_method, items: [] },
});

function setup(storeType: string | undefined, rows: Row[]) {
  const prisma = {
    provider: { findUnique: jest.fn(() => Promise.resolve({ id: 'prov1' })) },
    creator: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'c1',
          store: { id: 's1', ...(storeType ? { store_type: storeType } : {}) },
        }),
      ),
    },
    orderCommission: {
      findMany: jest.fn(() => Promise.resolve(rows)),
    },
  };
  const service = new CommissionsService(prisma as unknown as PrismaService);
  const svc = {
    getSummary: (userId: string, role: 'provider' | 'creator') =>
      service.getSummary(userId, role) as Promise<Summary>,
  };
  const findArgs = () =>
    (
      prisma.orderCommission.findMany.mock.calls[0] as unknown as [
        Record<string, unknown>,
      ]
    )[0];
  return { svc, prisma, findArgs };
}

const mixed = (): Row[] => [
  row('cod-delivered', 'COD', 'COMPLETED', 10),
  row('cod-pending', 'COD', 'PENDING', 20),
  row('cod-processing', 'COD', 'PROCESSING', 3),
  row('cod-failed', 'COD', 'FAILED', 40),
  row('card-delivered', 'STRIPE', 'COMPLETED', 100),
  row('card-pending', 'STRIPE', 'PENDING', 200),
  row('cod-sek', 'COD', 'COMPLETED', 7, 'SEK'),
];

describe('creator summary of a MARKETPLACE store', () => {
  it('COD amounts are offline: out of pending and out of paid', async () => {
    const { svc, findArgs } = setup('MARKETPLACE', mixed());
    const res = await svc.getSummary('u-creator', 'creator');
    // Earned totals count everything, as before (the supplier side counts
    // offline as earned too).
    expect(res.total_earnings).toBe(380);
    expect(res.total_orders).toBe(7);
    // Delivered, pending and processing COD; the FAILED one is written off.
    expect(res.offline).toBe(40);
    // Only the card order is still pending.
    expect(res.pending).toBe(200);
    expect(res.by_currency).toEqual([
      {
        currency: 'EUR',
        orders: 6,
        total_earnings: 373,
        pending: 200,
        paid: 100,
        offline: 33,
      },
      {
        currency: 'SEK',
        orders: 1,
        total_earnings: 7,
        pending: 0,
        paid: 0,
        offline: 7,
      },
    ]);
    // The payment method is read with the rows (one query).
    expect(findArgs().include).toEqual({
      order: { select: { payment_method: true } },
    });
  });

  it('no COD order at all: offline is 0 and the rest is as before', async () => {
    const { svc } = setup('MARKETPLACE', [
      row('card-delivered', 'STRIPE', 'COMPLETED', 100),
      row('card-pending', 'STRIPE', 'PENDING', 200),
    ]);
    const res = await svc.getSummary('u-creator', 'creator');
    expect(res.offline).toBe(0);
    expect(res.pending).toBe(200);
    expect(res.by_currency).toEqual([
      {
        currency: 'EUR',
        orders: 2,
        total_earnings: 300,
        pending: 200,
        paid: 100,
        offline: 0,
      },
    ]);
  });
});

describe('unchanged summaries', () => {
  it('INDEPENDENT store: COD is the store own revenue, no offline key, same query', async () => {
    const { svc, findArgs } = setup('INDEPENDENT', mixed());
    const res = await svc.getSummary('u-creator', 'creator');
    expect('offline' in res).toBe(false);
    expect(res.total_earnings).toBe(380);
    expect(res.pending).toBe(220);
    expect(res.by_currency).toEqual([
      {
        currency: 'EUR',
        orders: 6,
        total_earnings: 373,
        pending: 220,
        paid: 110,
      },
      { currency: 'SEK', orders: 1, total_earnings: 7, pending: 0, paid: 7 },
    ]);
    expect(Object.keys(findArgs())).toEqual(['where']);
  });

  it('provider role: no offline key, COD rows counted as before', async () => {
    const { svc } = setup('MARKETPLACE', []);
    const res = await svc.getSummary('u-prov', 'provider');
    expect('offline' in res).toBe(false);
    expect(res).toEqual({
      total_earnings: 0,
      this_month: 0,
      pending: 0,
      total_orders: 0,
      by_currency: [],
    });
  });

  it('a creator without a store: the empty answer it always was', async () => {
    const { svc, prisma } = setup('MARKETPLACE', []);
    prisma.creator.findUnique.mockResolvedValue({ id: 'c1' } as never);
    expect(await svc.getSummary('u-creator', 'creator')).toEqual({
      total_earnings: 0,
      this_month: 0,
      pending: 0,
      total_orders: 0,
    });
  });
});
