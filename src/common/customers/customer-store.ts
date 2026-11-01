import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

/**
 * Per-store customer accounts: a CUSTOMER user belongs to exactly one store
 * (User.store_id). Every customer-facing request that names a store (order
 * create/quote, cart lines, Kustom checkout, designer routes, B2B lookups)
 * must name the customer's own store; anything else is refused with
 * 403 CUSTOMER_STORE_MISMATCH. Staff accounts are never restricted here.
 */
export const CUSTOMER_STORE_MISMATCH = 'CUSTOMER_STORE_MISMATCH';

export function customerStoreMismatch(): ForbiddenException {
  return new ForbiddenException({
    code: CUSTOMER_STORE_MISMATCH,
    message: 'This account belongs to another store.',
  });
}

/** The account fields the rule reads (a User row or a RequestUser). */
export interface CustomerStoreAccount {
  role: UserRole | string;
  store_id?: string | null;
  storeId?: string | null;
}

/** The store a customer account belongs to (null for staff / unknown). */
export function accountStoreId(
  account: CustomerStoreAccount | null | undefined,
): string | null {
  if (!account) return null;
  return account.store_id ?? account.storeId ?? null;
}

/**
 * True when `account` may act on `storeId`: always for staff and guests,
 * and for a customer only when the store is its own.
 */
export function customerMayUseStore(
  account: CustomerStoreAccount | null | undefined,
  storeId: string | null | undefined,
): boolean {
  if (!account || account.role !== UserRole.CUSTOMER) return true;
  const own = accountStoreId(account);
  return !!own && !!storeId && own === storeId;
}

/** 403 CUSTOMER_STORE_MISMATCH unless `customerMayUseStore`. */
export function assertCustomerStore(
  account: CustomerStoreAccount | null | undefined,
  storeId: string | null | undefined,
): void {
  if (!customerMayUseStore(account, storeId)) throw customerStoreMismatch();
}
