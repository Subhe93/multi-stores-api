/**
 * Order read rules as a plain function (M4.0 §8.2), extracted from
 * `OrdersService.userCanReadOrder` so new modules (customer upload downloads)
 * can apply exactly the same ownership checks. Orders and Invoices keep their
 * own copies for now; they can move here later without behaviour change.
 *
 * - ADMIN: every order.
 * - CUSTOMER: only their own orders (the buyer).
 * - PROVIDER: orders containing an item they fulfil.
 * - CREATOR: orders of their own store, or orders where they fulfil an item.
 * Anything else is denied.
 */
import { Prisma, PrismaClient, UserRole } from '@prisma/client';

/** The order fields the rules need. */
export interface OrderReadSubject {
  store_id: string | null;
  customer: { user_id: string } | null;
  items: { fulfiller_id: string | null }[];
}

/** Prisma `select` that loads an `OrderReadSubject`. */
export const ORDER_READ_SELECT = {
  store_id: true,
  customer: { select: { user_id: true } },
  items: { select: { fulfiller_id: true } },
} satisfies Prisma.OrderSelect;

export interface OrderReader {
  id?: string | null;
  role?: UserRole | null;
}

/** The parts of the Prisma client the rules read. */
export type OrderReadPrisma = Pick<PrismaClient, 'provider' | 'creator'>;

/**
 * Caches the fulfiller lookups of one reader, so checking several orders for
 * the same user costs one query per role.
 */
export function createOrderReadChecker(
  prisma: OrderReadPrisma,
  user: OrderReader,
): (order: OrderReadSubject) => Promise<boolean> {
  let provider: Promise<{ id: string } | null> | undefined;
  let creator:
    | Promise<{ id: string; store: { id: string } | null } | null>
    | undefined;

  return async (order: OrderReadSubject): Promise<boolean> => {
    if (!user?.id || !user.role) return false;
    const userId = user.id;
    switch (user.role) {
      case UserRole.ADMIN:
        return true;
      case UserRole.CUSTOMER:
        return order.customer?.user_id === userId;
      case UserRole.PROVIDER: {
        provider ??= prisma.provider.findUnique({
          where: { user_id: userId },
          select: { id: true },
        });
        const p = await provider;
        return !!p && order.items.some((i) => i.fulfiller_id === p.id);
      }
      case UserRole.CREATOR: {
        creator ??= prisma.creator.findUnique({
          where: { user_id: userId },
          select: { id: true, store: { select: { id: true } } },
        });
        const c = await creator;
        if (!c) return false;
        if (c.store && order.store_id === c.store.id) return true;
        // A creator fulfilling an item keeps access even when the order was
        // not placed through their store.
        return order.items.some((i) => i.fulfiller_id === c.id);
      }
      default:
        return false;
    }
  };
}

/** One-shot form of `createOrderReadChecker`. */
export function userCanReadOrder(
  prisma: OrderReadPrisma,
  order: OrderReadSubject,
  user: OrderReader,
): Promise<boolean> {
  return createOrderReadChecker(prisma, user)(order);
}
