import { ConflictException } from '@nestjs/common';
import type { StoreStatus } from '@prisma/client';

/**
 * Public gate of the commerce paths (SPEC §3): cart, checkout and order
 * creation refuse a store that is not LIVE with 409 STORE_NOT_LIVE.
 * `Store.is_active` is derived from `Store.status` (true only for LIVE), so
 * callers that already load `is_active` can judge with it.
 */
export const STORE_NOT_LIVE = {
  code: 'STORE_NOT_LIVE',
  message: 'This store is not open for orders right now.',
} as const;

export function storeNotLive(): ConflictException {
  return new ConflictException(STORE_NOT_LIVE);
}

/** True when a loaded store row (or null) must be refused by the gate. */
export function storeClosed(
  store: { is_active?: boolean; status?: string } | null | undefined,
): boolean {
  if (!store) return false;
  if (store.status !== undefined) return store.status !== 'LIVE';
  return store.is_active === false;
}

/**
 * Owner pre-live checkout (FIXES-1 item 4): whether the storefront viewer of
 * the request (`X-Storefront-Viewer`) may use the checkout of `store` while it
 * is not LIVE: its owner (a previewable status) or an admin. Never throws.
 */
export type PreLiveViewerCheck = (store: {
  id: string;
  status: StoreStatus;
}) => Promise<boolean>;
