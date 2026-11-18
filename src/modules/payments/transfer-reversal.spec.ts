import type { ConfigService } from '@nestjs/config';
import { PaymentsService } from './payments.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CryptoService } from '../../common/crypto/crypto.service';
import type { OrdersService } from '../orders/orders.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { MailService } from '../mail/mail.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import {
  TransferReversalService,
  type TransferPort,
} from './transfer-reversal.service';
import {
  refundedPercent,
  reversalDelta,
  reversalIdempotencyKey,
  reversalTarget,
  transferReversalEnabled,
} from './transfer-reversal';

// Transfer reversal after a refund. Everything here runs on doubles: the
// Stripe side is an in-memory transfer ledger that behaves like Stripe
// where it matters for safety (amount_reversed is the truth, an idempotency
// key replays the first answer, a reversal above what is left is refused).
// Nothing in this file has been exercised against Stripe itself.

describe('reversal arithmetic', () => {
  it('reversalTarget: pro rata, rounded down, whole transfer for a full refund', () => {
    expect(reversalTarget(5000, 3000, 10000)).toBe(1500);
    expect(reversalTarget(5000, 6000, 10000)).toBe(3000);
    expect(reversalTarget(5000, 10000, 10000)).toBe(5000);
    // More refunded than captured never exceeds the transfer.
    expect(reversalTarget(5000, 12000, 10000)).toBe(5000);
    // Rounds down: 3333 x 1 / 3 = 1111.
    expect(reversalTarget(3333, 1, 3)).toBe(1111);
    expect(reversalTarget(1, 1, 3)).toBe(0);
  });

  it('reversalTarget: nothing for zero, negative, fractional or unknown input', () => {
    for (const [a, r, c] of [
      [0, 10, 100],
      [100, 0, 100],
      [100, 10, 0],
      [-5, 10, 100],
      [100, -1, 100],
      [100.5, 10, 100],
      [100, Number.NaN, 100],
    ]) {
      expect(reversalTarget(a, r, c)).toBe(0);
    }
  });

  it('reversalTarget: exact for sums beyond 2^53 when multiplied', () => {
    // 9e12 x 8e12 overflows a double; BigInt keeps it exact.
    expect(reversalTarget(9_000_000_000_001, 8_000_000_000_000, 9e12)).toBe(
      8_000_000_000_000,
    );
  });

  it('reversalDelta: only what is still missing, never negative, never above the transfer', () => {
    expect(
      reversalDelta({ amount: 5000, amount_reversed: 0 }, 3000, 10000),
    ).toEqual({ target: 1500, delta: 1500, reversedAfter: 1500, full: false });
    // 60% after 30% was done: the difference.
    expect(
      reversalDelta({ amount: 5000, amount_reversed: 1500 }, 6000, 10000),
    ).toEqual({ target: 3000, delta: 1500, reversedAfter: 3000, full: false });
    // Replay of the same state: nothing.
    expect(
      reversalDelta({ amount: 5000, amount_reversed: 3000 }, 6000, 10000),
    ).toMatchObject({ delta: 0, full: false });
    // Somebody reversed more by hand: nothing, and no negative step.
    expect(
      reversalDelta({ amount: 5000, amount_reversed: 4000 }, 6000, 10000),
    ).toMatchObject({ delta: 0, reversedAfter: 4000, full: false });
    // Full refund: the rest, and the transfer is then reversed in full.
    expect(
      reversalDelta({ amount: 5000, amount_reversed: 3000 }, 10000, 10000),
    ).toEqual({ target: 5000, delta: 2000, reversedAfter: 5000, full: true });
    // Already reversed in full by hand.
    expect(
      reversalDelta({ amount: 5000, amount_reversed: 5000 }, 3000, 10000),
    ).toMatchObject({ delta: 0, full: true });
    // Missing amount_reversed reads as 0.
    expect(reversalDelta({ amount: 100 }, 50, 100)).toMatchObject({
      delta: 50,
    });
  });

  it('reversalDelta: for every state, reversed + delta stays within the transfer', () => {
    for (const amount of [1, 7, 100, 4999]) {
      for (const already of [0, 1, 50, amount]) {
        for (const [refunded, captured] of [
          [1, 3],
          [1, 1],
          [999, 1000],
          [5, 4],
        ]) {
          const step = reversalDelta(
            { amount, amount_reversed: Math.min(already, amount) },
            refunded,
            captured,
          );
          expect(step.delta).toBeGreaterThanOrEqual(0);
          expect(step.reversedAfter).toBeLessThanOrEqual(amount);
        }
      }
    }
  });

  it('idempotency key names the transfer, the state before and the target', () => {
    expect(reversalIdempotencyKey('tr_1', 0, 1500)).toBe('trrev_tr_1_0_1500');
    expect(reversalIdempotencyKey('tr_1', 1500, 3000)).toBe(
      'trrev_tr_1_1500_3000',
    );
  });

  it('refundedPercent and the switch', () => {
    expect(refundedPercent(3000, 10000)).toBe(30);
    expect(refundedPercent(1, 10000)).toBe(1);
    expect(refundedPercent(10000, 10000)).toBe(100);
    expect(refundedPercent(5, 0)).toBe(100);
    expect(transferReversalEnabled('on')).toBe(true);
    expect(transferReversalEnabled(' ON ')).toBe(true);
    for (const off of [undefined, null, '', 'off', 'true', '1', 'yes', 1]) {
      expect(transferReversalEnabled(off)).toBe(false);
    }
  });
});

// ── Service on doubles ──────────────────────────────────────────────────────

type Payout = {
  id: string;
  recipient_type: 'PROVIDER' | 'CREATOR';
  recipient_id: string;
  stripe_transfer_id: string | null;
  amount: number;
  currency: string;
  status: string;
  created_at: number;
};

type StripeTransfer = {
  amount: number;
  amount_reversed: number;
  currency: string;
};

/** In-memory transfers with Stripe's safety rules. */
function fakeStripe(transfers: Record<string, StripeTransfer>) {
  const seenKeys = new Map<string, number>();
  const calls: { id: string; amount: number; key: string }[] = [];
  const port: TransferPort & {
    retrieve: jest.Mock;
    createReversal: jest.Mock;
  } = {
    retrieve: jest.fn((id: string) => {
      const t = transfers[id];
      if (!t) return Promise.reject(new Error(`No such transfer: ${id}`));
      return Promise.resolve({ id, ...t });
    }),
    createReversal: jest.fn(
      (
        id: string,
        params: { amount: number },
        options: { idempotencyKey: string },
      ) => {
        calls.push({ id, amount: params.amount, key: options.idempotencyKey });
        // Same key: Stripe replays the first answer, nothing moves again.
        if (seenKeys.has(options.idempotencyKey)) {
          return Promise.resolve({ id: `trr_replay` });
        }
        const t = transfers[id];
        if (
          params.amount <= 0 ||
          t.amount_reversed + params.amount > t.amount
        ) {
          return Promise.reject(
            new Error(
              'Reversal amount exceeds the amount left on the transfer',
            ),
          );
        }
        seenKeys.set(options.idempotencyKey, params.amount);
        t.amount_reversed += params.amount;
        return Promise.resolve({ id: `trr_${calls.length}` });
      },
    ),
  };
  return { port, calls, transfers };
}

function build(opts: {
  enabled?: string;
  payouts: Partial<Payout>[];
  transfers?: Record<string, StripeTransfer>;
  admins?: string[];
}) {
  const payouts: Payout[] = opts.payouts.map((p, i) => ({
    id: `po${i + 1}`,
    recipient_type: 'PROVIDER',
    recipient_id: `prov${i + 1}`,
    stripe_transfer_id: `tr_${i + 1}`,
    amount: 50,
    currency: 'EUR',
    status: 'paid',
    created_at: i,
    ...p,
  }));
  let clock = 0;
  const timeline: { status: string; note: string; created_at: number }[] = [];
  const notifications: {
    user_id: string;
    type: string;
    title: string;
    body: string;
    data: unknown;
  }[] = [];
  const statusMatches = (
    row: { status: string },
    cond: string | { in: string[] } | undefined,
  ) =>
    cond === undefined ||
    (typeof cond === 'string'
      ? row.status === cond
      : cond.in.includes(row.status));
  const prisma = {
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
    $executeRaw: jest.fn(() => Promise.resolve(1)),
    orderPayout: {
      findMany: jest.fn(({ where }: { where: { status: { in: string[] } } }) =>
        Promise.resolve(
          payouts
            .filter(
              (p) =>
                !!p.stripe_transfer_id && where.status.in.includes(p.status),
            )
            .map((p) => ({ ...p })),
        ),
      ),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Partial<Payout> }) => {
          Object.assign(payouts.find((p) => p.id === where.id) as Payout, data);
          return Promise.resolve({});
        },
      ),
    },
    orderTimeline: {
      findFirst: jest.fn(
        ({
          where,
        }: {
          where: { status?: string | { in: string[] }; note?: string };
        }) =>
          Promise.resolve(
            [...timeline]
              .reverse()
              .find(
                (t) =>
                  statusMatches(t, where.status) &&
                  (where.note === undefined || t.note === where.note),
              ) ?? null,
          ),
      ),
      create: jest.fn(
        ({ data }: { data: { status: string; note: string } }) => {
          timeline.push({
            status: data.status,
            note: data.note,
            created_at: clock++,
          });
          return Promise.resolve({});
        },
      ),
    },
    user: {
      findMany: jest.fn(() =>
        Promise.resolve(
          (opts.admins ?? ['admin1', 'admin2']).map((id) => ({ id })),
        ),
      ),
    },
    notification: {
      createMany: jest.fn(
        ({ data }: { data: (typeof notifications)[number][] }) => {
          notifications.push(...data);
          return Promise.resolve({ count: data.length });
        },
      ),
    },
    provider: {
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.map((id) => ({ id, company_name: `Print ${id}` })),
        ),
      ),
    },
    creator: {
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in.map((id) => ({ id, display_name: `Shop ${id}` })),
        ),
      ),
    },
  };
  const config = {
    get: jest.fn((key: string) =>
      key === 'TRANSFER_REVERSAL_ON_REFUND' ? opts.enabled : undefined,
    ),
  };
  const stripe = fakeStripe(opts.transfers ?? {});
  const stripeFactory = jest.fn(() => Promise.resolve(stripe.port));
  const service = new TransferReversalService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
  );
  const order = { id: 'o1', order_number: 'ORD-1' };
  const sync = (
    refundedMinor: number,
    capturedMinor = 10000,
    currency = 'eur',
  ) =>
    service.onRefundSynced(
      order,
      { refundedMinor, capturedMinor, currency },
      stripeFactory,
    );
  const rows = (status: string) => timeline.filter((t) => t.status === status);
  return {
    service,
    prisma,
    payouts,
    timeline,
    notifications,
    stripe,
    stripeFactory,
    sync,
    rows,
  };
}

/** Supplier 50.00 + store 20.00 of a 100.00 EUR order, same currency. */
const twoRecipients = () => ({
  payouts: [
    { recipient_type: 'PROVIDER' as const, recipient_id: 'prov1', amount: 50 },
    { recipient_type: 'CREATOR' as const, recipient_id: 'c1', amount: 20 },
  ],
  transfers: {
    tr_1: { amount: 5000, amount_reversed: 0, currency: 'eur' },
    tr_2: { amount: 2000, amount_reversed: 0, currency: 'eur' },
  },
});

describe('switch off (default): bookkeeping only', () => {
  it('records what is due and tells the admins, without a single Stripe call', async () => {
    const b = build(twoRecipients());
    const out = await b.sync(3000);
    expect(out.executed).toBe(false);
    expect(out.recorded).toBe(true);
    expect(out.due).toEqual([
      {
        recipient_type: 'PROVIDER',
        recipient_id: 'prov1',
        transfer_id: 'tr_1',
        due: 15,
        currency: 'EUR',
      },
      {
        recipient_type: 'CREATOR',
        recipient_id: 'c1',
        transfer_id: 'tr_2',
        due: 6,
        currency: 'EUR',
      },
    ]);
    // No Stripe client is even resolved.
    expect(b.stripeFactory).not.toHaveBeenCalled();
    expect(b.stripe.port.retrieve).not.toHaveBeenCalled();
    expect(b.stripe.port.createReversal).not.toHaveBeenCalled();
    expect(b.payouts.map((p) => p.status)).toEqual(['paid', 'paid']);

    // One timeline row, with no recipient amount in it (the store owner
    // reads the timeline and must not learn the supplier's share).
    expect(b.rows('TRANSFER_REVERSAL_DUE')).toHaveLength(1);
    const note = b.rows('TRANSFER_REVERSAL_DUE')[0].note;
    expect(note).toContain('30 EUR');
    expect(note).toContain('30%');
    expect(note).toContain('2 transfer(s)');
    expect(note).not.toMatch(/\b15\b|\b6\b|Print|Shop|tr_/);

    // One notification per active admin, with the per-recipient amounts.
    expect(b.notifications.map((n) => n.user_id)).toEqual(['admin1', 'admin2']);
    const n = b.notifications[0];
    expect(n.type).toBe('order_transfer_reversal_due');
    expect(n.body).toContain('ORD-1');
    expect(n.body).toContain('supplier Print prov1 15 EUR (transfer tr_1)');
    expect(n.body).toContain('store Shop c1 6 EUR (transfer tr_2)');
    expect(n.body).toContain('Automatic reversal is off');
    expect(n.data).toMatchObject({
      order_id: 'o1',
      refunded: 30,
      captured: 100,
      currency: 'EUR',
    });
  });

  it('one note per refunded total: a replayed event adds nothing, a larger total adds one', async () => {
    const b = build(twoRecipients());
    await b.sync(3000);
    const replay = await b.sync(3000);
    expect(replay.recorded).toBe(false);
    expect(b.rows('TRANSFER_REVERSAL_DUE')).toHaveLength(1);
    expect(b.notifications).toHaveLength(2);

    await b.sync(6000);
    await b.sync(6000);
    await b.sync(10000);
    expect(b.rows('TRANSFER_REVERSAL_DUE')).toHaveLength(3);
    expect(b.notifications).toHaveLength(6);
    expect(b.stripe.port.createReversal).not.toHaveBeenCalled();
    // Full refund: the whole transfers are due.
    expect(b.notifications[5].body).toContain('50 EUR (transfer tr_1)');
    expect(b.notifications[5].body).toContain('20 EUR (transfer tr_2)');
  });

  it('nothing to record for an order without paid transfers', async () => {
    const none = build({ payouts: [] });
    expect((await none.sync(3000)).due).toEqual([]);
    expect(none.timeline).toHaveLength(0);
    expect(none.notifications).toHaveLength(0);

    // A failed payout never sent a transfer.
    const failed = build({
      payouts: [{ status: 'failed', stripe_transfer_id: null }],
    });
    await failed.sync(3000);
    expect(failed.timeline).toHaveLength(0);
  });
});

describe('switch on: reversals on (the double of) Stripe', () => {
  const on = () => build({ ...twoRecipients(), enabled: 'on' });

  it('partial 30%, then 60%, then full: each step reverses only the difference', async () => {
    const b = on();
    await b.sync(3000);
    expect(b.stripe.calls).toEqual([
      { id: 'tr_1', amount: 1500, key: 'trrev_tr_1_0_1500' },
      { id: 'tr_2', amount: 600, key: 'trrev_tr_2_0_600' },
    ]);
    expect(b.payouts.map((p) => p.status)).toEqual(['paid', 'paid']);

    await b.sync(6000);
    expect(b.stripe.calls.slice(2)).toEqual([
      { id: 'tr_1', amount: 1500, key: 'trrev_tr_1_1500_3000' },
      { id: 'tr_2', amount: 600, key: 'trrev_tr_2_600_1200' },
    ]);

    await b.sync(10000);
    expect(b.stripe.calls.slice(4)).toEqual([
      { id: 'tr_1', amount: 2000, key: 'trrev_tr_1_3000_5000' },
      { id: 'tr_2', amount: 800, key: 'trrev_tr_2_1200_2000' },
    ]);
    // Exactly what was transferred came back, not a cent more.
    expect(b.stripe.transfers.tr_1.amount_reversed).toBe(5000);
    expect(b.stripe.transfers.tr_2.amount_reversed).toBe(2000);
    expect(b.payouts.map((p) => p.status)).toEqual(['reversed', 'reversed']);
    // Timeline: a row per real reversal, without amounts or names.
    const reversed = b.rows('TRANSFER_REVERSED').map((t) => t.note);
    expect(reversed).toHaveLength(6);
    expect(reversed[0]).toBe(
      'Transfer to a supplier reversed in part after a refund',
    );
    expect(reversed[5]).toBe(
      'Transfer to the store reversed in full after a refund',
    );
    expect(b.notifications[0].body).toContain('Automatic reversal is on');
  });

  it('the same event replayed: no further reversal', async () => {
    const b = on();
    await b.sync(3000);
    await b.sync(3000);
    await b.sync(3000);
    expect(b.stripe.calls).toHaveLength(2);
    expect(b.stripe.transfers.tr_1.amount_reversed).toBe(1500);
    expect(b.rows('TRANSFER_REVERSED')).toHaveLength(2);
    expect(b.rows('TRANSFER_REVERSAL_DUE')).toHaveLength(1);

    // After the full refund too: a fully reversed payout is not read again.
    await b.sync(10000);
    const callsAfterFull = b.stripe.calls.length;
    const retrievesAfterFull = b.stripe.port.retrieve.mock.calls.length;
    await b.sync(10000);
    expect(b.stripe.calls).toHaveLength(callsAfterFull);
    expect(b.stripe.port.retrieve.mock.calls).toHaveLength(retrievesAfterFull);
  });

  it('two deliveries reading the same state use the same idempotency key (Stripe replays)', async () => {
    const b = on();
    // The second delivery still sees amount_reversed 0 (stale read).
    b.stripe.port.retrieve.mockImplementation((id: string) =>
      Promise.resolve({ id, ...b.stripe.transfers[id], amount_reversed: 0 }),
    );
    await b.sync(3000);
    await b.sync(3000);
    expect(b.stripe.calls.map((c) => c.key)).toEqual([
      'trrev_tr_1_0_1500',
      'trrev_tr_2_0_600',
      'trrev_tr_1_0_1500',
      'trrev_tr_2_0_600',
    ]);
    // The replayed keys moved nothing.
    expect(b.stripe.transfers.tr_1.amount_reversed).toBe(1500);
    expect(b.stripe.transfers.tr_2.amount_reversed).toBe(600);
  });

  it('a transfer already reversed by hand in Stripe is counted, never reversed again', async () => {
    const b = on();
    // The admin reversed 40.00 of the supplier transfer by hand.
    b.stripe.transfers.tr_1.amount_reversed = 4000;
    await b.sync(6000);
    // Supplier: target 30.00 is already covered. Store: 12.00.
    expect(b.stripe.calls).toEqual([
      { id: 'tr_2', amount: 1200, key: 'trrev_tr_2_0_1200' },
    ]);
    expect(b.stripe.transfers.tr_1.amount_reversed).toBe(4000);

    // Reversed in full by hand: the ledger follows, with no Stripe write.
    b.stripe.transfers.tr_1.amount_reversed = 5000;
    await b.sync(6000);
    expect(b.stripe.calls).toHaveLength(1);
    expect(b.payouts[0].status).toBe('reversed');
    expect(b.payouts[1].status).toBe('paid');
  });

  it('zero-decimal currency: integer amounts, rounded down', async () => {
    const b = build({
      enabled: 'on',
      payouts: [{ amount: 1000, currency: 'JPY' }],
      transfers: {
        tr_1: { amount: 1000, amount_reversed: 0, currency: 'jpy' },
      },
    });
    // 333 of 1000 JPY refunded.
    const out = await b.sync(333, 1000, 'jpy');
    expect(out.due[0]).toMatchObject({ due: 333, currency: 'JPY' });
    expect(b.stripe.calls).toEqual([
      { id: 'tr_1', amount: 333, key: 'trrev_tr_1_0_333' },
    ]);
    expect(b.rows('TRANSFER_REVERSAL_DUE')[0].note).toContain('333 JPY');
  });

  it('settlement currency differs from the order currency: the share applies to the transfer as Stripe holds it', async () => {
    // Order in SEK (supplier 500.00 SEK in the ledger), settled in USD:
    // the transfer is 47.31 USD.
    const b = build({
      enabled: 'on',
      payouts: [{ amount: 500, currency: 'SEK' }],
      transfers: {
        tr_1: { amount: 4731, amount_reversed: 0, currency: 'usd' },
      },
    });
    const out = await b.sync(30000, 100000, 'sek');
    // Bookkeeping in the ledger currency.
    expect(out.due[0]).toMatchObject({ due: 150, currency: 'SEK' });
    // Reversal in the transfer's own units: floor(4731 x 0.3) = 1419.
    expect(b.stripe.calls).toEqual([
      { id: 'tr_1', amount: 1419, key: 'trrev_tr_1_0_1419' },
    ]);
    await b.sync(100000, 100000, 'sek');
    expect(b.stripe.transfers.tr_1.amount_reversed).toBe(4731);
  });

  it('a Stripe failure is recorded and does not throw; the next sync retries it', async () => {
    const b = on();
    b.stripe.port.createReversal.mockRejectedValueOnce(
      new Error('Insufficient funds in the connected account'),
    );
    const out = await b.sync(3000);
    expect(out.failed).toEqual([
      {
        transfer_id: 'tr_1',
        message: 'Insufficient funds in the connected account',
      },
    ]);
    // The other recipient was still handled.
    expect(b.stripe.transfers.tr_2.amount_reversed).toBe(600);
    expect(b.stripe.transfers.tr_1.amount_reversed).toBe(0);
    expect(b.rows('TRANSFER_REVERSAL_FAILED')).toHaveLength(1);
    const failure = b.notifications.filter(
      (n) => n.type === 'order_transfer_reversal_failed',
    );
    expect(failure.map((n) => n.user_id)).toEqual(['admin1', 'admin2']);
    expect(failure[0].body).toContain('tr_1');
    expect(failure[0].body).toContain('Verify payment');

    // Retry (the admin "Verify payment" action re-runs the sync).
    const retry = await b.sync(3000);
    expect(retry.failed).toEqual([]);
    expect(b.stripe.transfers.tr_1.amount_reversed).toBe(1500);
  });

  it('the same failure redelivered does not notify again', async () => {
    const b = on();
    b.stripe.port.createReversal.mockRejectedValue(new Error('boom'));
    await b.sync(3000);
    await b.sync(3000);
    expect(b.rows('TRANSFER_REVERSAL_FAILED')).toHaveLength(1);
    expect(
      b.notifications.filter(
        (n) => n.type === 'order_transfer_reversal_failed',
      ),
    ).toHaveLength(2);
  });

  it('a lost lock / transaction never throws out of the refund handling', async () => {
    const b = on();
    // Bookkeeping commits, the execution transaction cannot start.
    b.prisma.$transaction
      .mockImplementationOnce((fn: (tx: unknown) => unknown) => fn(b.prisma))
      .mockImplementationOnce(() => Promise.reject(new Error('tx timeout')));
    const out = await b.sync(3000);
    expect(out.failed).toEqual([{ transfer_id: '*', message: 'tx timeout' }]);
    expect(b.rows('TRANSFER_REVERSAL_FAILED')).toHaveLength(1);
  });

  it('only the exact value "on" executes', async () => {
    for (const value of ['true', '1', 'yes', 'off', '']) {
      const b = build({ ...twoRecipients(), enabled: value });
      const out = await b.sync(3000);
      expect(out.executed).toBe(false);
      expect(b.stripeFactory).not.toHaveBeenCalled();
    }
  });
});

describe('a refund that fails afterwards', () => {
  it('switch off: the notes are withdrawn once; nothing was reversed', async () => {
    const b = build(twoRecipients());
    await b.sync(3000);
    await b.sync(0);
    await b.sync(0);
    const due = b.rows('TRANSFER_REVERSAL_DUE').map((t) => t.note);
    expect(due).toHaveLength(2);
    expect(due[1]).toContain('no longer due');
    const last = b.notifications[b.notifications.length - 1];
    expect(last.title).toBe('Refund failed after transfer reversal');
    expect(last.body).toContain('No transfer was reversed');
    expect(b.notifications).toHaveLength(4);
    // The same total refunded again later is recorded again.
    await b.sync(3000);
    expect(b.rows('TRANSFER_REVERSAL_DUE')).toHaveLength(3);
  });

  it('switch on, full refund reversed then failed: no transfer is sent again and the admin is told', async () => {
    const b = build({ ...twoRecipients(), enabled: 'on' });
    await b.sync(10000);
    expect(b.payouts.map((p) => p.status)).toEqual(['reversed', 'reversed']);
    const calls = b.stripe.calls.length;
    await b.sync(0);
    expect(b.stripe.calls).toHaveLength(calls);
    expect(b.payouts.map((p) => p.status)).toEqual(['reversed', 'reversed']);
    const last = b.notifications[b.notifications.length - 1];
    expect(last.body).toContain('2 transfer(s) were already reversed');
    expect(last.body).toContain('NOT sent again automatically');
    expect(b.rows('TRANSFER_REVERSAL_DUE').map((t) => t.note)[1]).toContain(
      'not sent again automatically',
    );
  });

  it('nothing refunded and no earlier bookkeeping: silent', async () => {
    const b = build(twoRecipients());
    await b.sync(0);
    expect(b.timeline).toHaveLength(0);
    expect(b.notifications).toHaveLength(0);
  });
});

// ── PaymentsService wiring ──────────────────────────────────────────────────

type Internals = Record<string, (...args: unknown[]) => Promise<unknown>>;

function buildPayments(opts: {
  order: Record<string, unknown>;
  charge: Record<string, unknown>;
  markChanged?: boolean;
}) {
  const prisma = {
    order: {
      findFirst: jest.fn((): Promise<unknown> => Promise.resolve(opts.order)),
      findUnique: jest.fn((): Promise<unknown> => Promise.resolve(opts.order)),
    },
    store: { findUnique: jest.fn(() => Promise.resolve(null)) },
  };
  const orders = {
    recordPartialRefund: jest.fn(() => Promise.resolve({ changed: true })),
    markOrderRefunded: jest.fn(() =>
      Promise.resolve({ changed: opts.markChanged !== false }),
    ),
    revertRefund: jest.fn(() => Promise.resolve({ changed: true })),
  };
  const stripe = {
    charges: { retrieve: jest.fn(() => Promise.resolve(opts.charge)) },
    refunds: { list: jest.fn(() => Promise.resolve(null)) },
    transfers: { retrieve: jest.fn(), createReversal: jest.fn() },
  };
  const reversal = {
    onRefundSynced: jest.fn(
      (_order: unknown, _refund: unknown, _stripe: () => Promise<unknown>) =>
        Promise.resolve({}),
    ),
  };
  const service = new PaymentsService(
    {} as ConfigService,
    prisma as unknown as PrismaService,
    {} as CryptoService,
    orders as unknown as OrdersService,
    {
      create: jest.fn(() => Promise.resolve()),
    } as unknown as NotificationsService,
    {} as MailService,
    {} as MarketsContextService,
    undefined,
    undefined,
    undefined,
    reversal as unknown as TransferReversalService,
  );
  const internals = service as unknown as Internals;
  jest.spyOn(internals, 'requireStripe').mockResolvedValue(stripe);
  return { service: internals, orders, stripe, reversal };
}

const platformOrder = {
  id: 'o1',
  order_number: 'ORD-1',
  payment_status: 'paid',
  store_id: 's1',
  stripe_account_id: null,
  payment_route: 'PLATFORM',
  stripe_payment_id: 'pi_1',
};
const charge = (over: Record<string, unknown>) => ({
  id: 'ch_1',
  payment_intent: 'pi_1',
  currency: 'eur',
  amount: 10000,
  amount_captured: 10000,
  refunded: false,
  amount_refunded: 0,
  ...over,
});

describe('PaymentsService: the refund sync calls the reversal service', () => {
  it('partial refund: after the refund is recorded, with the live totals', async () => {
    const b = buildPayments({
      order: platformOrder,
      charge: charge({ amount_refunded: 3000 }),
    });
    await b.service.onChargeRefunded({ id: 'ch_1', payment_intent: 'pi_1' });
    expect(b.reversal.onRefundSynced).toHaveBeenCalledTimes(1);
    expect(b.reversal.onRefundSynced.mock.calls[0].slice(0, 2)).toEqual([
      { id: 'o1', order_number: 'ORD-1' },
      { refundedMinor: 3000, capturedMinor: 10000, currency: 'eur' },
    ]);
    expect(
      b.orders.recordPartialRefund.mock.invocationCallOrder[0],
    ).toBeLessThan(b.reversal.onRefundSynced.mock.invocationCallOrder[0]);
    // PaymentsService itself never touches transfers.
    expect(b.stripe.transfers.retrieve).not.toHaveBeenCalled();
    expect(b.stripe.transfers.createReversal).not.toHaveBeenCalled();
  });

  it('full refund: after markOrderRefunded, and also on a replayed event', async () => {
    const first = buildPayments({
      order: platformOrder,
      charge: charge({ refunded: true, amount_refunded: 10000 }),
    });
    await first.service.onChargeRefunded({
      id: 'ch_1',
      payment_intent: 'pi_1',
    });
    expect(first.reversal.onRefundSynced.mock.calls[0][1]).toEqual({
      refundedMinor: 10000,
      capturedMinor: 10000,
      currency: 'eur',
    });
    expect(
      first.orders.markOrderRefunded.mock.invocationCallOrder[0],
    ).toBeLessThan(first.reversal.onRefundSynced.mock.invocationCallOrder[0]);

    const replay = buildPayments({
      order: { ...platformOrder, payment_status: 'refunded' },
      charge: charge({ refunded: true, amount_refunded: 10000 }),
      markChanged: false,
    });
    await replay.service.onChargeRefunded({
      id: 'ch_1',
      payment_intent: 'pi_1',
    });
    expect(replay.reversal.onRefundSynced).toHaveBeenCalledTimes(1);
  });

  it('a refund that failed (nothing refunded any more) still syncs, so the bookkeeping is withdrawn', async () => {
    const b = buildPayments({
      order: { ...platformOrder, payment_status: 'refunded' },
      charge: charge({ amount_refunded: 0 }),
    });
    await b.service.onChargeRefunded({ id: 'ch_1', payment_intent: 'pi_1' });
    expect(b.orders.revertRefund).toHaveBeenCalled();
    expect(b.reversal.onRefundSynced.mock.calls[0][1]).toMatchObject({
      refundedMinor: 0,
    });
  });

  it('the Stripe port handed over is the platform client, built only on demand', async () => {
    const b = buildPayments({
      order: platformOrder,
      charge: charge({ amount_refunded: 3000 }),
    });
    await b.service.onChargeRefunded({ id: 'ch_1', payment_intent: 'pi_1' });
    const factory = b.reversal.onRefundSynced.mock.calls[0][2];
    const port = (await factory()) as TransferPort;
    await port.retrieve('tr_1');
    await port.createReversal('tr_1', { amount: 5 }, { idempotencyKey: 'k' });
    expect(b.stripe.transfers.retrieve).toHaveBeenCalledWith('tr_1');
    expect(b.stripe.transfers.createReversal).toHaveBeenCalledWith(
      'tr_1',
      { amount: 5 },
      { idempotencyKey: 'k' },
    );
  });

  it.each([
    [
      'a direct charge on a connected account',
      { stripe_account_id: 'acct_1', payment_route: 'CONNECT_DIRECT' },
    ],
    [
      'a legacy direct charge (no route column)',
      { stripe_account_id: 'acct_1', payment_route: null },
    ],
  ])('%s is never touched', async (_name, over) => {
    for (const refunded of [3000, 10000]) {
      const b = buildPayments({
        order: { ...platformOrder, ...over },
        charge: charge({
          amount_refunded: refunded,
          refunded: refunded === 10000,
        }),
      });
      await b.service.onChargeRefunded({ id: 'ch_1', payment_intent: 'pi_1' });
      expect(b.reversal.onRefundSynced).not.toHaveBeenCalled();
    }
  });

  it('an own-key order is never touched', async () => {
    const b = buildPayments({
      order: { ...platformOrder, payment_route: 'OWN_KEY' },
      charge: charge({ amount_refunded: 3000 }),
    });
    // The own-key client of the order (no platform client involved).
    jest.spyOn(b.service, 'stripeForOrder').mockResolvedValue({
      route: 'OWN_KEY',
      storeId: 's1',
      stripe: b.stripe,
      opts: undefined,
    });
    await b.service.onChargeRefunded({ id: 'ch_1', payment_intent: 'pi_1' });
    expect(b.orders.recordPartialRefund).toHaveBeenCalled();
    expect(b.reversal.onRefundSynced).not.toHaveBeenCalled();
  });

  it('without the service wired (lean specs) the refund flow is what it was', async () => {
    const b = buildPayments({
      order: platformOrder,
      charge: charge({ refunded: true, amount_refunded: 10000 }),
    });
    (b.service as unknown as { transferReversal: unknown }).transferReversal =
      undefined;
    await expect(
      b.service.onChargeRefunded({ id: 'ch_1', payment_intent: 'pi_1' }),
    ).resolves.toBeUndefined();
    expect(b.orders.markOrderRefunded).toHaveBeenCalled();
  });
});

describe('PaymentsService.issueOrderTransfers: a reversed payout is never sent again', () => {
  it('skips a recipient whose payout is paid or reversed, and still pays a new one', async () => {
    const statuses: Record<string, string | undefined> = {
      prov1: 'reversed',
      c1: undefined,
    };
    const prisma = {
      order: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            id: 'o1',
            store_id: 's1',
            currency: 'EUR',
            stripe_charge_id: 'ch_1',
            stripe_account_id: null,
            payment_route: 'PLATFORM',
            items: [
              {
                fulfiller_type: 'PROVIDER',
                fulfiller_id: 'prov1',
                provider_base_amount: 50,
              },
            ],
            commission: { provider_amount: 50, creator_amount: 20 },
          }),
        ),
      },
      orderPayout: {
        findUnique: jest.fn(
          ({
            where,
          }: {
            where: {
              order_id_recipient_type_recipient_id: { recipient_id: string };
            };
          }) => {
            const status =
              statuses[where.order_id_recipient_type_recipient_id.recipient_id];
            return Promise.resolve(status ? { status } : null);
          },
        ),
        upsert: jest.fn(() => Promise.resolve({})),
      },
      provider: {
        findMany: jest.fn(() =>
          Promise.resolve([{ id: 'prov1', stripe_account_id: 'acct_p' }]),
        ),
      },
      store: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            creator: { id: 'c1', stripe_account_id: 'acct_c' },
          }),
        ),
      },
    };
    const stripe = {
      charges: {
        retrieve: jest.fn(() =>
          Promise.resolve({
            amount: 10000,
            balance_transaction: { currency: 'eur', amount: 10000 },
          }),
        ),
      },
      transfers: { create: jest.fn(() => Promise.resolve({ id: 'tr_new' })) },
    };
    const service = new PaymentsService(
      {} as ConfigService,
      prisma as unknown as PrismaService,
      {} as CryptoService,
      {} as OrdersService,
      {} as NotificationsService,
      {} as MailService,
      {} as MarketsContextService,
    ) as unknown as Internals;
    jest.spyOn(service, 'requireStripe').mockResolvedValue(stripe);
    await service.issueOrderTransfers('o1');
    // The supplier's reversed transfer is not re-sent; the store is paid.
    expect(stripe.transfers.create).toHaveBeenCalledTimes(1);
    expect(
      (
        stripe.transfers.create.mock.calls[0] as unknown as [
          { destination: string },
        ]
      )[0].destination,
    ).toBe('acct_c');
  });
});
