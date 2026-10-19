import type { NextFunction, Request, Response } from 'express';

/**
 * Baseline security headers set on every API response (no helmet).
 *
 * X-Frame-Options is skipped on routes that serve resources meant to be
 * fetched or embedded cross-origin (fonts, print/proof files, invoice PDFs,
 * feeds, static uploads); framing a resource is harmless and some viewers
 * (PDF in an <iframe>/<object>) break with DENY. Routes keep full control:
 * a header already present on the response is never overridden here, and
 * route handlers run after this middleware so their own setHeader() wins.
 */
export const FRAMEABLE_RESOURCE_PATTERNS: readonly RegExp[] = [
  /^\/uploads\//, // static uploads (express.static)
  /^\/api\/uploads\/customer\/[^/]+\/original(?:$|[?/])/, // customer upload originals
  /^\/api\/designer\/fonts\//, // public designer font files
  /^\/api\/designer\/assets\//, // public designer assets (template images)
  /^\/api\/designer\/files\//, // token-signed designer files
  /^\/api\/designer\/my\/orders\/[^/]+\/items\/[^/]+\/(?:print|originals)(?:$|[?/])/, // print files + originals
  /^\/api\/invoices\/documents\/[^/]+\/pdf(?:$|[?/])/, // invoice PDF downloads
  /^\/api\/feeds\//, // Google XML / Facebook CSV feeds
];

const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

export interface SecurityHeadersInput {
  /** Request path without the query string (`req.path`). */
  path: string;
  /**
   * Whether the request arrived over HTTPS. Pass Express's `req.secure`: it
   * already honours `trust proxy` (TRUST_PROXY) and reads X-Forwarded-Proto.
   */
  secure: boolean;
}

export function isFrameableResourcePath(path: string): boolean {
  return FRAMEABLE_RESOURCE_PATTERNS.some((re) => re.test(path));
}

/** Pure: which headers to add for a request. Order is not significant. */
export function securityHeadersFor(
  input: SecurityHeadersInput,
): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
  if (input.secure) headers['Strict-Transport-Security'] = HSTS_VALUE;
  if (!isFrameableResourcePath(input.path)) {
    headers['X-Frame-Options'] = 'DENY';
  }
  return headers;
}

/** Minimal response surface so the function can be unit-tested without Express. */
export interface HeaderSink {
  getHeader(name: string): unknown;
  setHeader(name: string, value: string): unknown;
}

/** Applies `securityHeadersFor` without overriding a header already set. */
export function applySecurityHeaders(
  input: SecurityHeadersInput,
  res: HeaderSink,
): void {
  const headers = securityHeadersFor(input);
  for (const name of Object.keys(headers)) {
    if (res.getHeader(name) !== undefined) continue;
    res.setHeader(name, headers[name]);
  }
}

/**
 * Express middleware. Register with `app.use()` BEFORE `useStaticAssets` so
 * `/uploads/*` responses pass through it too.
 */
export function securityHeadersMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Behind a proxy `req.secure` is true only when `trust proxy` is set and
  // X-Forwarded-Proto says https — exactly the TRUST_PROXY semantics we want.
  applySecurityHeaders({ path: req.path, secure: req.secure }, res);
  next();
}
