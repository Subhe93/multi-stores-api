import { SetMetadata } from '@nestjs/common';

export const VERIFIED_ACCOUNT_KEY = 'verifiedAccount';

/** How VerifiedAccountGuard decides whether a request is a locked action. */
export interface VerifiedAccountOptions {
  /**
   * Lock only when one of these body fields is present (defined). Without
   * `fields` / `when` every request to the route is locked.
   */
  fields?: string[];
  /** Extra predicate on the request (params, body); locks when true. */
  when?: (req: { params?: Record<string, string>; body?: unknown }) => boolean;
}

/**
 * Marks a route as a locked action for unverified (PENDING) staff accounts:
 * VerifiedAccountGuard answers 403 ACCOUNT_EMAIL_UNVERIFIED there (SPEC §2).
 * Must run after AuthGuard('jwt').
 */
export const VerifiedAccount = (options: VerifiedAccountOptions = {}) =>
  SetMetadata(VERIFIED_ACCOUNT_KEY, options);
