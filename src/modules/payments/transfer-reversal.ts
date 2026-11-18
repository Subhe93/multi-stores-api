// Transfer reversal after a refund: the pure arithmetic.
//
// A marketplace card order is charged on the platform account and split
// with Stripe transfers to the supplier(s) and the influencer store
// (PaymentsService.issueOrderTransfers). When the customer is refunded, the
// platform pays the refund from its own balance, so the share already sent
// to the recipients has to come back: each transfer is reversed pro rata.
//
// Rules (all in integer minor units, no floating point):
// - fraction = succeeded refunds / captured amount of the charge, never
//   above 1. Both are in the charge currency, so the fraction has no unit
//   and applies to a transfer in any (settlement) currency.
// - target = what should be reversed of one transfer in total:
//   the whole transfer for a full refund, else floor(amount x fraction).
//   Rounding down: a recipient is never asked for more than its share.
// - delta = min(target, amount) - amount_reversed: what is still to reverse
//   NOW. `amount_reversed` is read from Stripe, which is the ledger of
//   truth, so a webhook retry, a replayed event or a reversal somebody made
//   by hand in Stripe can never lead to reversing more than the target, and
//   the target is never more than the transfer.

/** Env switch: only the exact value `on` executes reversals on Stripe. */
export const TRANSFER_REVERSAL_ENV = 'TRANSFER_REVERSAL_ON_REFUND';

export function transferReversalEnabled(raw: unknown): boolean {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'on';
}

export const TRANSFER_REVERSAL_DUE = 'TRANSFER_REVERSAL_DUE';
export const TRANSFER_REVERSED = 'TRANSFER_REVERSED';
export const TRANSFER_REVERSAL_FAILED = 'TRANSFER_REVERSAL_FAILED';

/** OrderPayout.status of a transfer that was reversed in full. */
export const PAYOUT_REVERSED = 'reversed';

const isCount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/**
 * Total that should be reversed of a transfer of `amount` (minor units)
 * once `refunded` of `captured` (minor units of the charge) went back.
 * 0 for anything that is not a clean non-negative integer.
 */
export function reversalTarget(
  amount: number,
  refunded: number,
  captured: number,
): number {
  if (!isCount(amount) || !isCount(refunded) || !isCount(captured)) return 0;
  if (amount === 0 || refunded === 0 || captured === 0) return 0;
  if (refunded >= captured) return amount;
  // BigInt: amount x refunded can exceed 2^53 for large zero-decimal sums.
  return Number((BigInt(amount) * BigInt(refunded)) / BigInt(captured));
}

/**
 * What is still to reverse now of one transfer, given what Stripe says was
 * already reversed. Never negative, and `alreadyReversed + delta` never
 * exceeds the transfer amount.
 */
export function reversalDelta(
  transfer: { amount: number; amount_reversed?: number | null },
  refunded: number,
  captured: number,
): { target: number; delta: number; reversedAfter: number; full: boolean } {
  const amount = isCount(transfer.amount) ? transfer.amount : 0;
  const already = isCount(transfer.amount_reversed)
    ? transfer.amount_reversed
    : 0;
  const target = Math.min(reversalTarget(amount, refunded, captured), amount);
  const delta = Math.max(0, target - already);
  const reversedAfter = already + delta;
  return {
    target,
    delta,
    reversedAfter,
    full: amount > 0 && reversedAfter >= amount,
  };
}

/**
 * Idempotency key of one reversal step: the transfer, what was reversed
 * before the step and the total after it. A retry of the same step (same
 * state, same target) replays the same Stripe call; a later step (more was
 * refunded, so the state or the target differ) gets a new key.
 */
export function reversalIdempotencyKey(
  transferId: string,
  alreadyReversed: number,
  target: number,
): string {
  return `trrev_${transferId}_${alreadyReversed}_${target}`;
}

/** Refunded share of the payment in whole percent (for notes), 1 to 100. */
export function refundedPercent(refunded: number, captured: number): number {
  if (!isCount(refunded) || !isCount(captured) || captured === 0) return 100;
  if (refunded >= captured) return 100;
  return Math.max(1, Math.floor((refunded * 100) / captured));
}
