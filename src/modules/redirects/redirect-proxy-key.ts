import { createHash, timingSafeEqual } from 'crypto';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Shared secret of the web storefront proxy (env `REDIRECTS_PROXY_KEY`, set
 * on the API and the web). The proxy sends it as `x-proxy-key` on the
 * redirect map/resolve calls; a match lifts the per-IP throttle for those two
 * routes (every storefront request comes from the proxy's few IPs). Unset or
 * wrong = the normal per-IP throttle.
 */
export const REDIRECTS_PROXY_KEY_ENV = 'REDIRECTS_PROXY_KEY';
export const PROXY_KEY_HEADER = 'x-proxy-key';
/** Per-IP limit of the public redirect routes without the proxy key. */
export const REDIRECTS_PUBLIC_LIMIT = 120;

const digest = (v: string) => createHash('sha256').update(v, 'utf8').digest();

/** Timing-safe comparison of the header against the configured key. */
export function isTrustedProxyKey(
  header: unknown,
  configured: string | undefined = process.env[REDIRECTS_PROXY_KEY_ENV],
): boolean {
  if (!configured || configured.length < 16) return false;
  const value: unknown = Array.isArray(header)
    ? (header as unknown[])[0]
    : header;
  if (typeof value !== 'string' || value === '') return false;
  // Equal-length digests: no early exit on length or content.
  return timingSafeEqual(digest(value), digest(configured));
}

/** Throttle limit resolver: unlimited for the trusted proxy, else 120/min per IP. */
export function redirectsThrottleLimit(context: ExecutionContext): number {
  const req = context.switchToHttp().getRequest<Request>();
  return isTrustedProxyKey(req?.headers?.[PROXY_KEY_HEADER])
    ? Number.MAX_SAFE_INTEGER
    : REDIRECTS_PUBLIC_LIMIT;
}
