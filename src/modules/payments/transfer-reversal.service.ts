import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FulfillerType, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  fromStripeAmount,
  toStripeAmount,
} from '../../common/money/currency.util';
import {
  PAYOUT_REVERSED,
  TRANSFER_REVERSAL_DUE,
  TRANSFER_REVERSAL_ENV,
  TRANSFER_REVERSAL_FAILED,
  TRANSFER_REVERSED,
  refundedPercent,
  reversalDelta,
  reversalIdempotencyKey,
  reversalTarget,
  transferReversalEnabled,
} from './transfer-reversal';

/**
 * Transfer reversal after a refund (marketplace card orders).
 *
 * A refund is paid from the platform balance, while the supplier and the
 * influencer store already received their share through transfers. This
 * service is called after every refund sync of a PLATFORM-route order and
 * does two separate things:
 *
 * 1. BOOKKEEPING, always (whatever the switch says): what should be
 *    reversed is recorded on the order timeline (TRANSFER_REVERSAL_DUE, no
 *    recipient amounts: the store owner reads the timeline and must not
 *    learn the supplier's share) and every ACTIVE admin gets a notification
 *    with the per-recipient amounts. Recorded once per refunded total.
 *
 * 2. EXECUTION, only with TRANSFER_REVERSAL_ON_REFUND=on (unset = off): the
 *    transfers are reversed on Stripe, pro rata to the refunded share. The
 *    switch is off by default because a reversal moves real money out of a
 *    recipient's Stripe balance and none of it could be exercised against
 *    Stripe when it was written (see the list in docs/OPERATIONS.md).
 *
 * Safety of the execution:
 * - idempotent: each step reads the transfer from Stripe and reverses only
 *   `target - amount_reversed`; the idempotency key names the state and the
 *   target, so a retried webhook replays the same call;
 * - never more than was transferred: the target is capped at the transfer
 *   amount, and Stripe's own `amount_reversed` is the ledger (a reversal
 *   made by hand in Stripe is counted);
 * - one order at a time: the read-compute-reverse sequence runs under a
 *   per-order advisory lock, so two refund events cannot both reverse from
 *   the same stale reading;
 * - a failure never breaks the refund handling: it is recorded
 *   (TRANSFER_REVERSAL_FAILED + admin notification) and retried by the next
 *   sync of the order (the admin "Verify payment" action);
 * - a refund that fails afterwards never re-sends a transfer: the admin is
 *   told so.
 */

/** The two Stripe calls a reversal needs (the platform account). */
export interface TransferPort {
  retrieve(id: string): Promise<{
    id: string;
    amount: number;
    amount_reversed?: number | null;
    currency: string;
  }>;
  createReversal(
    id: string,
    params: { amount: number; metadata?: Record<string, string> },
    options: { idempotencyKey: string },
  ): Promise<unknown>;
}

export interface RefundedOrderRef {
  id: string;
  order_number: string;
}

/** The live refund state of the order's charge (minor units). */
export interface RefundState {
  refundedMinor: number;
  /** 0 when Stripe did not say (nothing can then be prorated). */
  capturedMinor: number;
  /** Charge (= order) currency. */
  currency: string;
}

export interface ReversalDue {
  recipient_type: FulfillerType;
  recipient_id: string;
  transfer_id: string;
  /** Total to reverse for this refunded total, in the payout currency. */
  due: number;
  currency: string;
}

export interface ReversalOutcome {
  /** What should be reversed in total for the refunded total. */
  due: ReversalDue[];
  /** True when the DUE row and the admin notifications were written now. */
  recorded: boolean;
  /** True when the Stripe calls ran (the switch is on). */
  executed: boolean;
  /** Transfers a reversal was created for in this run. */
  reversed: { transfer_id: string; amount: number; full: boolean }[];
  failed: { transfer_id: string; message: string }[];
}

type PayoutRow = {
  id: string;
  recipient_type: FulfillerType;
  recipient_id: string;
  stripe_transfer_id: string | null;
  amount: Prisma.Decimal | number;
  currency: string;
  status: string;
};

type Db = Prisma.TransactionClient | PrismaService;

const LOCK_TIMEOUT_MS = 60_000;

@Injectable()
export class TransferReversalService {
  private readonly logger = new Logger(TransferReversalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Whether reversals are really executed on Stripe. Read on every call. */
  get enabled(): boolean {
    let raw: unknown;
    try {
      raw = this.config.get<string>(TRANSFER_REVERSAL_ENV);
    } catch {
      raw = undefined;
    }
    return transferReversalEnabled(raw);
  }

  /**
   * After a refund sync of a PLATFORM-route order. `stripe` is only called
   * when the switch is on and there is something to look at.
   */
  async onRefundSynced(
    order: RefundedOrderRef,
    refund: RefundState,
    stripe: () => Promise<TransferPort>,
  ): Promise<ReversalOutcome> {
    const outcome: ReversalOutcome = {
      due: [],
      recorded: false,
      executed: false,
      reversed: [],
      failed: [],
    };
    const refunded = Math.max(0, Math.trunc(refund.refundedMinor || 0));
    const captured = Math.max(0, Math.trunc(refund.capturedMinor || 0));
    const full = captured > 0 && refunded >= captured;

    const book = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, order.id);
      const payouts = await this.payoutsOf(tx, order.id);
      if (payouts.length === 0) return { due: [] as ReversalDue[], any: false };

      // A refund that failed after its bookkeeping: nothing is due any more
      // and what was reversed is not sent again.
      const reversedPayouts = payouts.filter(
        (p) => p.status === PAYOUT_REVERSED,
      );
      if (refunded === 0 || (!full && reversedPayouts.length > 0)) {
        await this.recordRefundReverted(tx, order, reversedPayouts.length);
      }
      if (refunded === 0) return { due: [] as ReversalDue[], any: true };

      const due: ReversalDue[] = [];
      for (const p of payouts) {
        if (p.status !== 'paid' || !p.stripe_transfer_id) continue;
        const ledgerMinor = toStripeAmount(Number(p.amount), p.currency);
        const dueMinor = reversalTarget(ledgerMinor, refunded, captured);
        if (dueMinor <= 0) continue;
        due.push({
          recipient_type: p.recipient_type,
          recipient_id: p.recipient_id,
          transfer_id: p.stripe_transfer_id,
          due: fromStripeAmount(dueMinor, p.currency),
          currency: p.currency.toUpperCase(),
        });
      }
      if (due.length === 0) return { due, any: true };

      const code = refund.currency.toUpperCase();
      const note = `Transfers to reverse after refunds of ${fromStripeAmount(
        refunded,
        refund.currency,
      )} ${code} in total (${refundedPercent(refunded, captured)}% of the payment): ${due.length} transfer(s)`;
      const recorded = await this.recordOnce(tx, order.id, note);
      if (recorded) {
        const names = await this.recipientNames(tx, due);
        const lines = due.map(
          (d) =>
            `${names.get(`${d.recipient_type}:${d.recipient_id}`) ?? d.recipient_type.toLowerCase()} ${d.due} ${d.currency} (transfer ${d.transfer_id})`,
        );
        await this.notifyAdmins(
          tx,
          'order_transfer_reversal_due',
          'Refund: transfers to reverse',
          `Order ${order.order_number}: ${fromStripeAmount(refunded, refund.currency)} ${code} of ${fromStripeAmount(captured, refund.currency)} ${code} was refunded. To reverse in total: ${lines.join('; ')}. ${
            this.enabled
              ? 'Automatic reversal is on: the transfers are reversed now.'
              : 'Automatic reversal is off: reverse them in the Stripe dashboard.'
          }`,
          {
            order_id: order.id,
            refunded: fromStripeAmount(refunded, refund.currency),
            captured: fromStripeAmount(captured, refund.currency),
            currency: code,
            recipients: due.map((d) => ({ ...d })),
          },
        );
      }
      return { due, any: true, recorded };
    });
    outcome.due = book.due;
    outcome.recorded = book.recorded === true;

    if (!this.enabled || outcome.due.length === 0) return outcome;
    outcome.executed = true;
    try {
      await this.execute(order, refunded, captured, stripe, outcome);
    } catch (err) {
      // The lock / transaction itself failed (timeout, connection). What
      // Stripe already did stays done and is read back by the next sync.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Transfer reversal of order ${order.id} did not finish: ${message}`,
      );
      outcome.failed.push({ transfer_id: '*', message });
    }
    if (outcome.failed.length > 0) {
      await this.recordFailures(order, outcome.failed);
    }
    return outcome;
  }

  /** The Stripe side: one transfer at a time, under the per-order lock. */
  private async execute(
    order: RefundedOrderRef,
    refunded: number,
    captured: number,
    stripe: () => Promise<TransferPort>,
    outcome: ReversalOutcome,
  ): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        await this.lock(tx, order.id);
        // Read again under the lock: an earlier run may have finished some.
        const payouts = (await this.payoutsOf(tx, order.id)).filter(
          (p) => p.status === 'paid' && !!p.stripe_transfer_id,
        );
        if (payouts.length === 0) return;
        const port = await stripe();
        for (const p of payouts) {
          const transferId = p.stripe_transfer_id as string;
          try {
            const transfer = await port.retrieve(transferId);
            const already = transfer.amount_reversed ?? 0;
            const step = reversalDelta(transfer, refunded, captured);
            if (step.delta > 0) {
              await port.createReversal(
                transferId,
                {
                  amount: step.delta,
                  metadata: { order_id: order.id, reason: 'refund' },
                },
                {
                  idempotencyKey: reversalIdempotencyKey(
                    transferId,
                    already,
                    step.target,
                  ),
                },
              );
              outcome.reversed.push({
                transfer_id: transferId,
                amount: step.delta,
                full: step.full,
              });
              await tx.orderTimeline.create({
                data: {
                  order_id: order.id,
                  status: TRANSFER_REVERSED,
                  note: `Transfer to ${recipientWord(p.recipient_type)} reversed ${
                    step.full ? 'in full' : 'in part'
                  } after a refund`,
                  actor: 'system',
                },
              });
            }
            // Also when nothing was left to do: a transfer somebody
            // reversed in full by hand is `reversed` in the ledger too.
            if (step.full) {
              await tx.orderPayout.update({
                where: { id: p.id },
                data: { status: PAYOUT_REVERSED },
              });
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.error(
              `Transfer reversal failed for order ${order.id}, transfer ${transferId}: ${message}`,
            );
            outcome.failed.push({ transfer_id: transferId, message });
          }
        }
      },
      { timeout: LOCK_TIMEOUT_MS, maxWait: 10_000 },
    );
  }

  private async lock(tx: Prisma.TransactionClient, orderId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`order_transfer_reversal:${orderId}`}))`;
  }

  /** Payouts that have (or had) a transfer: paid and reversed ones. */
  private payoutsOf(db: Db, orderId: string): Promise<PayoutRow[]> {
    return db.orderPayout.findMany({
      where: {
        order_id: orderId,
        stripe_transfer_id: { not: null },
        status: { in: ['paid', PAYOUT_REVERSED] },
      },
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        recipient_type: true,
        recipient_id: true,
        stripe_transfer_id: true,
        amount: true,
        currency: true,
        status: true,
      },
    });
  }

  /**
   * Writes the DUE row unless it is the order's latest one already, so each
   * refunded total is recorded once (a replayed event finds its own note),
   * while the same total after a failed refund is recorded again.
   */
  private async recordOnce(
    db: Db,
    orderId: string,
    note: string,
  ): Promise<boolean> {
    const latest = await db.orderTimeline.findFirst({
      where: { order_id: orderId, status: TRANSFER_REVERSAL_DUE },
      orderBy: { created_at: 'desc' },
      select: { note: true },
    });
    if (latest?.note === note) return false;
    await db.orderTimeline.create({
      data: {
        order_id: orderId,
        status: TRANSFER_REVERSAL_DUE,
        note,
        actor: 'system',
      },
    });
    return true;
  }

  /**
   * A refund failed after transfer reversals were recorded (or made): the
   * earlier notices no longer apply and nothing is transferred again.
   */
  private async recordRefundReverted(
    db: Db,
    order: RefundedOrderRef,
    reversedCount: number,
  ): Promise<void> {
    const earlier = await db.orderTimeline.findFirst({
      where: {
        order_id: order.id,
        status: { in: [TRANSFER_REVERSAL_DUE, TRANSFER_REVERSED] },
      },
      select: { id: true },
    });
    if (!earlier && reversedCount === 0) return;
    const note =
      reversedCount > 0
        ? `A refund failed in Stripe: ${reversedCount} transfer(s) reversed for it are not sent again automatically`
        : 'A refund failed in Stripe: the transfer reversals recorded for it are no longer due';
    if (!(await this.recordOnce(db, order.id, note))) return;
    await this.notifyAdmins(
      db,
      'order_transfer_reversal_due',
      'Refund failed after transfer reversal',
      `Order ${order.order_number}: a refund failed in Stripe. ${
        reversedCount > 0
          ? `${reversedCount} transfer(s) were already reversed for it and are NOT sent again automatically: pay those recipients by hand if they are still owed.`
          : 'No transfer was reversed for it.'
      } Earlier reversal notices of this order no longer apply.`,
      { order_id: order.id, reversed_transfers: reversedCount },
    );
  }

  private async recordFailures(
    order: RefundedOrderRef,
    failed: { transfer_id: string; message: string }[],
  ): Promise<void> {
    try {
      const note = `Transfer reversal failed for ${failed.length} transfer(s): ${failed
        .map((f) => f.message)
        .join('; ')
        .slice(0, 400)}`;
      const existing = await this.prisma.orderTimeline.findFirst({
        where: { order_id: order.id, status: TRANSFER_REVERSAL_FAILED, note },
        select: { id: true },
      });
      // A redelivered event with the same failure does not notify again.
      if (existing) return;
      await this.prisma.orderTimeline.create({
        data: {
          order_id: order.id,
          status: TRANSFER_REVERSAL_FAILED,
          note,
          actor: 'system',
        },
      });
      await this.notifyAdmins(
        this.prisma,
        'order_transfer_reversal_failed',
        'Transfer reversal failed',
        `Order ${order.order_number}: ${failed
          .map((f) => `transfer ${f.transfer_id}: ${f.message}`)
          .join('; ')
          .slice(
            0,
            600,
          )}. Run "Verify payment" on the order to retry, or reverse it in the Stripe dashboard.`,
        {
          order_id: order.id,
          transfers: failed.map((f) => f.transfer_id),
        },
      );
    } catch (err) {
      this.logger.error(
        `Could not record the failed transfer reversal of order ${order.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** "supplier <name>" / "store <name>" per recipient, for the admin text. */
  private async recipientNames(
    db: Db,
    due: ReversalDue[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ids = (type: FulfillerType) =>
      due.filter((d) => d.recipient_type === type).map((d) => d.recipient_id);
    const providerIds = ids(FulfillerType.PROVIDER);
    const creatorIds = ids(FulfillerType.CREATOR);
    if (providerIds.length) {
      const rows = await db.provider.findMany({
        where: { id: { in: providerIds } },
        select: { id: true, company_name: true },
      });
      for (const r of rows) {
        out.set(
          `${FulfillerType.PROVIDER}:${r.id}`,
          `supplier ${r.company_name}`,
        );
      }
    }
    if (creatorIds.length) {
      const rows = await db.creator.findMany({
        where: { id: { in: creatorIds } },
        select: { id: true, display_name: true },
      });
      for (const r of rows) {
        out.set(`${FulfillerType.CREATOR}:${r.id}`, `store ${r.display_name}`);
      }
    }
    return out;
  }

  private async notifyAdmins(
    db: Db,
    type: string,
    title: string,
    body: string,
    data: Prisma.InputJsonValue,
  ): Promise<void> {
    const admins = await db.user.findMany({
      where: { role: UserRole.ADMIN, status: 'ACTIVE' },
      select: { id: true },
    });
    if (admins.length === 0) return;
    await db.notification.createMany({
      data: admins.map((a) => ({ user_id: a.id, type, title, body, data })),
    });
  }
}

/** Timeline wording without names or amounts (the store owner reads it). */
function recipientWord(type: FulfillerType): string {
  return type === FulfillerType.PROVIDER ? 'a supplier' : 'the store';
}
