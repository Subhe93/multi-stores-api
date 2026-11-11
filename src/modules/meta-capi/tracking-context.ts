import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Browser context the storefront may send with a checkout request (POST
 * /orders, POST /payments/kustom/checkout/session) as the optional body field
 * `tracking`. Never required. The storefront sends it only when the visitor
 * allowed marketing cookies (or the store does not ask for consent): for a
 * store with `consent_required`, an order WITHOUT a stored context is never
 * reported to Meta from the server.
 */
export class TrackingContextDto {
  // The length cap here is only a body-size guard: a long value (an `_fbc`
  // built from a long `fbclid`) must never fail a checkout with a 400.
  // `buildTrackingContext` drops anything over 500 chars or malformed.

  // Meta browser id cookie (`_fbp`, "fb.1.<ms>.<random>").
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  fbp?: string;

  // Meta click id cookie (`_fbc`, "fb.1.<ms>.<fbclid>").
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  fbc?: string;

  // Page the purchase is made on (the checkout URL).
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  source_url?: string;
}

/** What is stored on Order.tracking_context / KustomCheckoutSession.tracking_context. */
export interface TrackingContext {
  fbp?: string;
  fbc?: string;
  source_url?: string;
  ip?: string;
  user_agent?: string;
}

const MAX_VALUE = 500;
const MAX_IP = 64;

function cleanString(value: unknown, max = MAX_VALUE): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return v && v.length <= max ? v : undefined;
}

/** Meta cookie values are "fb.<n>.<ms>.<id>"; anything else is dropped. */
function cleanFbCookie(value: unknown): string | undefined {
  const v = cleanString(value);
  return v && /^fb\.\d+\.\d+\.\S+$/.test(v) ? v : undefined;
}

function cleanHttpUrl(value: unknown): string | undefined {
  const v = cleanString(value);
  if (!v) return undefined;
  try {
    const url = new URL(v);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? v
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The context to store for a checkout request, or null when the body carried
 * no `tracking` field (so the request IP / user agent are never kept on their
 * own). Malformed values are dropped, never rejected: tracking must not be
 * able to fail a checkout.
 */
export function buildTrackingContext(
  tracking: TrackingContextDto | null | undefined,
  meta: { ip?: string | null; userAgent?: string | null },
): TrackingContext | null {
  if (tracking === null || tracking === undefined) return null;
  const out: TrackingContext = {};
  const fbp = cleanFbCookie(tracking.fbp);
  const fbc = cleanFbCookie(tracking.fbc);
  const sourceUrl = cleanHttpUrl(tracking.source_url);
  const ip = cleanString(meta.ip, MAX_IP);
  const userAgent = cleanString(meta.userAgent);
  if (fbp) out.fbp = fbp;
  if (fbc) out.fbc = fbc;
  if (sourceUrl) out.source_url = sourceUrl;
  if (ip) out.ip = ip;
  if (userAgent) out.user_agent = userAgent;
  return out;
}

/** Reads a stored context back (null for anything that is not an object). */
export function readTrackingContext(raw: unknown): TrackingContext | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: TrackingContext = {};
  const fbp = cleanFbCookie(r.fbp);
  const fbc = cleanFbCookie(r.fbc);
  const sourceUrl = cleanHttpUrl(r.source_url);
  const ip = cleanString(r.ip, MAX_IP);
  const userAgent = cleanString(r.user_agent);
  if (fbp) out.fbp = fbp;
  if (fbc) out.fbc = fbc;
  if (sourceUrl) out.source_url = sourceUrl;
  if (ip) out.ip = ip;
  if (userAgent) out.user_agent = userAgent;
  return out;
}
