/**
 * In-memory sliding-window counter for staff sign-ups (SPEC §2: 5 per IP per
 * hour). Only `POST /auth/register` with an `account_kind` goes through it;
 * storefront customer sign-ups keep the per-route 10/min throttle, so a
 * shop's customers behind one NAT are never capped at 5/h. Process-local by
 * design (one API instance runs at a time); keys are pruned on each hit.
 */
export const SIGNUP_RATE_LIMIT = 5;
export const SIGNUP_RATE_WINDOW_MS = 60 * 60 * 1000;

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Records an attempt for `key` and tells whether it is still within the
   * limit (false = refuse). A null key (unknown client) is never limited.
   */
  hit(key: string | null | undefined, now = Date.now()): boolean {
    if (!key) return true;
    const floor = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > floor);
    recent.push(now);
    this.hits.set(key, recent);
    // Opportunistic pruning so idle keys never pile up.
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) {
        if (!v.some((t) => t > floor)) this.hits.delete(k);
      }
    }
    return recent.length <= this.limit;
  }

  /** Attempts of `key` inside the window (without recording one). */
  count(key: string, now = Date.now()): number {
    const floor = now - this.windowMs;
    return (this.hits.get(key) ?? []).filter((t) => t > floor).length;
  }

  reset(): void {
    this.hits.clear();
  }
}

/**
 * The client address the way the throttler keys on it: `req.ip`, which
 * Express derives from the first X-Forwarded-For hop when TRUST_PROXY is set
 * (our nginx) and from the socket otherwise; falls back to the header / the
 * socket for non-Express callers.
 */
export function clientIp(
  req:
    | {
        ip?: string;
        headers?: Record<string, string | string[] | undefined>;
        socket?: { remoteAddress?: string };
      }
    | undefined,
): string | null {
  if (!req) return null;
  if (req.ip) return req.ip;
  const xff = req.headers?.['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return first || req.socket?.remoteAddress || null;
}
