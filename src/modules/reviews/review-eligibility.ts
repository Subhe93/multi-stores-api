import { OrderStatus, PaymentMethod, Prisma } from '@prisma/client';

// M171: which orders make their buyer a "verified buyer". One rule, spelled
// twice on purpose: as a Prisma filter (lookups always start from Order, by
// customer) and as a predicate over an already loaded order (review link,
// owner link creation). review-eligibility.spec.ts keeps the two in step.

/** Order statuses that never count as a purchase. */
export const REVIEW_EXCLUDED_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED,
];

/**
 * Orders of `storeId` that are real, paid purchases: not test, not trashed,
 * not cancelled / refunded, and paid (`payment_status = 'paid'`, or a COD
 * order that was delivered, the same "paid" rule as the invoices). A
 * refunded order has `payment_status = 'refunded'` and fails the paid clause.
 */
export function reviewEligibleOrderWhere(storeId: string) {
  return {
    store_id: storeId,
    is_test: false,
    deleted_at: null,
    status: { notIn: [...REVIEW_EXCLUDED_ORDER_STATUSES] },
    OR: [
      { payment_status: 'paid' },
      { payment_method: PaymentMethod.COD, status: OrderStatus.DELIVERED },
    ],
  } satisfies Prisma.OrderWhereInput;
}

/** The order columns the rule reads. */
export interface ReviewOrderFacts {
  store_id: string | null;
  status: OrderStatus;
  payment_status: string | null;
  payment_method: PaymentMethod;
  is_test: boolean;
  deleted_at: Date | null;
}

/** `reviewEligibleOrderWhere` for an order that is already loaded. */
export function isReviewEligibleOrder(
  order: ReviewOrderFacts,
  storeId: string,
): boolean {
  if (order.store_id !== storeId) return false;
  if (order.is_test || order.deleted_at) return false;
  if (REVIEW_EXCLUDED_ORDER_STATUSES.includes(order.status)) return false;
  return (
    order.payment_status === 'paid' ||
    (order.payment_method === PaymentMethod.COD &&
      order.status === OrderStatus.DELIVERED)
  );
}

/**
 * True when a review may not be (re)approved because its order is no longer
 * a real purchase: flagged test, trashed, or gone. A later refund / cancel
 * does not block (the buyer did receive the product).
 */
export function orderBlocksApproval(
  order: Pick<ReviewOrderFacts, 'is_test' | 'deleted_at'> | null | undefined,
): boolean {
  return !order || order.is_test || order.deleted_at !== null;
}

/** What a review is about: the creator's own product or a custom product. */
export interface ReviewTarget {
  kind: 'product' | 'custom_product';
  id: string;
}

/** The ProductReview / OrderItem column pair of a target. */
export function reviewTargetColumns(target: ReviewTarget): {
  product_id: string | null;
  custom_product_id: string | null;
} {
  return target.kind === 'product'
    ? { product_id: target.id, custom_product_id: null }
    : { product_id: null, custom_product_id: target.id };
}

/** Filter matching the target on ProductReview or OrderItem. */
export function reviewTargetWhere(
  target: ReviewTarget,
): { product_id: string } | { custom_product_id: string } {
  return target.kind === 'product'
    ? { product_id: target.id }
    : { custom_product_id: target.id };
}

/**
 * The customer's newest eligible order holding the target, with its first
 * matching line. Starts from Order (customer_id index); never a scan of
 * OrderItem by product (there is no index there).
 */
export function eligibleLineQuery(
  storeId: string,
  customerId: string,
  target: ReviewTarget,
) {
  const line = reviewTargetWhere(target);
  return {
    where: {
      customer_id: customerId,
      ...reviewEligibleOrderWhere(storeId),
      items: { some: line },
    },
    orderBy: [{ created_at: 'desc' as const }, { id: 'desc' as const }],
    select: {
      id: true,
      items: {
        where: line,
        orderBy: { id: 'asc' as const },
        take: 1,
        select: { id: true },
      },
    },
  } satisfies Prisma.OrderFindFirstArgs;
}
