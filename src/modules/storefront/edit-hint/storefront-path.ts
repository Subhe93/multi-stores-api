import { normalizeSlugForLookup } from '@multi-stores/core/slug';
import { SUPPORTED_LOCALES } from '../../markets/market.types';

/**
 * A public storefront URL path, classified the way the web app routes it
 * (multi-stores-web `proxy.ts` + `app/store/[storeSlug]/…`):
 *
 * - an optional leading locale segment (`/en/…`, `/sv/…`) is stripped;
 * - `/`                     → home (HOME builder page)
 * - `/products`             → catalog (CATALOG_TEMPLATE)
 * - `/products/<slug>`      → product page (any translated slug)
 * - `/collections`          → collections index
 * - `/collections/<a>/<b>`  → hierarchical collection page
 * - `/cart`, `/checkout/…`, `/account/…`, `/auth/…`, `/market-not-found`
 *                           → private / transactional pages (no edit button)
 * - `/<slug>`               → root STATIC / LANDING page (v2 or legacy)
 * - anything else (e.g. `/legal/<slug>`) → unknown.
 */
export type StorefrontRoute =
  | { kind: 'home' }
  | { kind: 'catalog' }
  | { kind: 'product'; slug: string }
  | { kind: 'collections' }
  | { kind: 'collection'; path: string[] }
  | { kind: 'page'; slug: string }
  | { kind: 'private' }
  | { kind: 'unknown' };

/** Top-level segments that never show an edit button (shopper-only pages). */
const PRIVATE_SEGMENTS = new Set([
  'cart',
  'checkout',
  'account',
  'auth',
  'market-not-found',
]);

/**
 * Mirrors RESERVED_SLUGS of the web's `[pageSlug]` route: a single segment
 * with one of these names is never a root page.
 */
const RESERVED_PAGE_SLUGS = new Set([
  'products',
  'cart',
  'checkout',
  'auth',
  'account',
  'collections',
  'p',
  'market-not-found',
]);

/** Upper bound on the accepted path; longer input is just "unknown". */
const MAX_PATH_LENGTH = 1024;

export function parseStorefrontPath(
  pathname: string | null | undefined,
): StorefrontRoute {
  if (typeof pathname !== 'string' || pathname.length > MAX_PATH_LENGTH) {
    return { kind: 'unknown' };
  }
  // Only the path part: a query or fragment never changes the route.
  const path = pathname.split(/[?#]/, 1)[0] ?? '';
  if (!path.startsWith('/')) return { kind: 'unknown' };

  let segments: string[];
  try {
    // The browser sends the percent-encoded path; Next.js decodes the route
    // params before the pages look them up, so decode the same way. Malformed
    // escapes make the path unknown.
    segments = path
      .split('/')
      .filter((s) => s.length > 0)
      .map((s) => decodeURIComponent(s));
  } catch {
    return { kind: 'unknown' };
  }
  // WP query context: slugs are matched in their stored form (NFC, lower
  // case; percent-decoding already done above).
  segments = segments.map((s) => normalizeSlugForLookup(s));

  if (
    segments.length > 0 &&
    (SUPPORTED_LOCALES as readonly string[]).includes(segments[0])
  ) {
    segments = segments.slice(1);
  }

  const [first, ...rest] = segments;
  if (first === undefined) return { kind: 'home' };
  if (PRIVATE_SEGMENTS.has(first)) return { kind: 'private' };

  if (first === 'products') {
    if (rest.length === 0) return { kind: 'catalog' };
    if (rest.length === 1) return { kind: 'product', slug: rest[0] };
    return { kind: 'unknown' };
  }

  if (first === 'collections') {
    return rest.length === 0
      ? { kind: 'collections' }
      : { kind: 'collection', path: rest };
  }

  if (rest.length === 0 && !RESERVED_PAGE_SLUGS.has(first)) {
    return { kind: 'page', slug: first };
  }
  return { kind: 'unknown' };
}

/** What the storefront button shows: drives its label ("Edit product", …). */
export type EditLabelKind = 'product' | 'collection' | 'page' | 'dashboard';

/** Response of `GET /storefront/:slug/edit-target`. */
export interface EditTargetResponse {
  /** Absolute dashboard URL to open, or null to hide the button. */
  edit_url: string | null;
  label_kind: EditLabelKind | null;
}

/** Joins the dashboard base URL (trailing slash tolerated) and a path. */
export function dashboardUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}
