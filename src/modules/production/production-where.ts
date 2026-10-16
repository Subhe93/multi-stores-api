import { OrderStatus, Prisma } from '@prisma/client';

// The `?production=` filter of the creator orders list (M4.3 §3.8). Only
// meaningful with the production app; the caller ignores it otherwise.

export const PRODUCTION_FILTERS = [
  'in_production',
  'ready',
  'not_started',
] as const;
export type ProductionFilter = (typeof PRODUCTION_FILTERS)[number];

/** Order statuses in which production work can still happen. */
export const PRODUCTION_ACTIVE_STATUSES: OrderStatus[] = [
  OrderStatus.CONFIRMED,
  OrderStatus.PROCESSING,
  OrderStatus.MANUFACTURING,
  OrderStatus.QUALITY_CHECK,
];

export function isProductionFilter(value: unknown): value is ProductionFilter {
  return (
    typeof value === 'string' &&
    (PRODUCTION_FILTERS as readonly string[]).includes(value)
  );
}

export function productionWhere(
  filter: ProductionFilter,
): Prisma.OrderWhereInput {
  const states: Prisma.EnumProductionStateFilter['in'] =
    filter === 'ready'
      ? ['READY']
      : filter === 'not_started'
        ? ['NOT_STARTED']
        : ['NOT_STARTED', 'IN_PROGRESS'];
  return {
    status: { in: PRODUCTION_ACTIVE_STATUSES },
    production_summary: { is: { state: { in: states } } },
  };
}
