import { createHash, timingSafeEqual } from 'crypto';

/**
 * Who may act on a design (M4.2 fixer B, guest token after claim).
 *
 * A design is created with a guest token (`X-Design-Token`, stored as
 * `access_token_hash`). Once it has a `customer_id` (created while logged in,
 * or claimed when a logged-in customer adds it to the cart), the token alone
 * no longer grants access: only that customer's JWT does. Otherwise a token
 * left in a shared browser, a log or a forwarded link would keep full edit
 * and re-claim rights over a design that now belongs to an account.
 *
 * Chosen over clearing `access_token_hash` on claim because the column is
 * NOT NULL (clearing needs a migration) and because this rule also covers
 * designs created while logged in and every claim path, present or future.
 *
 * Returns how access is granted, or null when it is not.
 */
export type DesignAccessGrant = 'customer' | 'token' | null;

export function designAccessGrant(
  design: { customer_id: string | null; access_token_hash: string | null },
  access: { customerId: string | null; token: string | null },
): DesignAccessGrant {
  if (design.customer_id) {
    return access.customerId && access.customerId === design.customer_id
      ? 'customer'
      : null;
  }
  return designTokenMatches(design.access_token_hash, access.token)
    ? 'token'
    : null;
}

/** True when `access` may read/edit/claim `design` (see designAccessGrant). */
export function canAccessDesign(
  design: { customer_id: string | null; access_token_hash: string | null },
  access: { customerId: string | null; token: string | null },
): boolean {
  return designAccessGrant(design, access) !== null;
}

/** sha256 of a guest token (hex), the stored form (`access_token_hash`). */
export function hashDesignToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time check of a presented guest token against the stored sha256
 * hex hash. The one token comparison of the designer module (designs,
 * cart and access checks all use it).
 */
export function designTokenMatches(
  storedHash: string | null | undefined,
  token: string | null | undefined,
): boolean {
  if (!storedHash || typeof token !== 'string' || !token) return false;
  if (token.length > 256) return false;
  const a = Buffer.from(hashDesignToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
