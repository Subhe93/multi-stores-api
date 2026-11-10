// Order trash (M69, plans/order-trash/SPEC.md): pure helpers of the soft
// delete. The data access lives in OrdersService (deleteOrder / restoreOrder
// / setTestFlag); these decide, without the database, which orders may be
// trashed and whether a trashed order still holds stock.

import { OrderStatus, type UserRole } from '@prisma/client';

/** Who deletes / restores / flags an order (the request user). */
export interface TrashActor {
  id: string;
  email: string;
  role: UserRole;
}

/** Why an order cannot be deleted (409 ORDER_NOT_DELETABLE `reason`). */
export type NotDeletableReason = 'paid' | 'invoiced' | 'paid_out';

/** One skipped id of a bulk delete / restore. */
export interface BulkSkipped {
  id: string;
  code: string;
  reason?: NotDeletableReason;
}

export interface BulkTrashResult {
  deleted?: string[];
  restored?: string[];
  skipped: BulkSkipped[];
}

/**
 * Payment statuses of an order that was never paid. `null` is a legacy /
 * COD order that has not been collected yet.
 */
const NEVER_PAID_STATUSES: ReadonlyArray<string | null> = [
  null,
  'pending',
  'awaiting_payment',
  'failed',
  'cancelled',
];

/** Order statuses after which the stock was (or will be) handled elsewhere. */
const STOCK_RELEASED_STATUSES: ReadonlyArray<OrderStatus> = [
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED,
  OrderStatus.RETURNED,
];

export interface DeletableInput {
  is_test: boolean;
  payment_status: string | null;
  paid_at: Date | null;
  stripe_charge_id: string | null;
  kustom_capture_id: string | null;
  _count: { payouts: number; invoices: number };
}

/**
 * The deletable guard: null when the order may be trashed, else the reason.
 * A test order is always deletable. A real order only while no money moved:
 * never paid (payment_status), no paid_at / charge / capture, no payout and
 * no invoice (bookkeeping: paid orders are cancelled / refunded, never
 * deleted).
 */
export function deletableReason(
  order: DeletableInput,
): NotDeletableReason | null {
  if (order.is_test) return null;
  if (order._count.invoices > 0) return 'invoiced';
  if (order._count.payouts > 0) return 'paid_out';
  if (
    !NEVER_PAID_STATUSES.includes(order.payment_status) ||
    order.paid_at !== null ||
    order.stripe_charge_id !== null ||
    order.kustom_capture_id !== null
  ) {
    return 'paid';
  }
  return null;
}

/**
 * True while the order's lines are still taken out of stock. Stock is
 * decremented at creation and handed back by exactly one of: the failure
 * path (payment_status 'failed': abandonment sweep, declined payment,
 * released authorization) or the refund path (payment_status 'refunded');
 * a terminal status (CANCELLED / REFUNDED / RETURNED) is treated as handled
 * too, like the cancel path does, so the delete never restores twice.
 */
export function orderHoldsStock(order: {
  status: OrderStatus;
  payment_status: string | null;
}): boolean {
  if (STOCK_RELEASED_STATUSES.includes(order.status)) return false;
  return (
    order.payment_status !== 'failed' && order.payment_status !== 'refunded'
  );
}

/** `deleted_by` is for admins only: strip it from every other response. */
export function withoutDeletedBy<T>(order: T): T {
  if (!order || typeof order !== 'object' || !('deleted_by' in order)) {
    return order;
  }
  const { deleted_by: _d, ...rest } = order as T & { deleted_by?: unknown };
  void _d;
  return rest as T;
}

/** Timeline actor label of a trash action (`creator:<id>` / `admin:<id>`). */
export function trashActorLabel(actor: TrashActor): string {
  return `${actor.role.toLowerCase()}:${actor.id}`;
}
