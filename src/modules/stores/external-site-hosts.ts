import { BadRequestException } from '@nestjs/common';
import { isReservedDomain } from '../../common/domains/reserved-hosts';

// ── External site return (headless booking P3, PLAN §7 R-D4) ────────────────
// A store with its own website (e.g. primatrafikskola.se in front of a
// ShopsDoor booking store) may send the shopper back there after payment.
// Both URLs live in `Store.checkout_settings` and are open-redirect targets,
// so they are checked on write, on read and (in the web app) on render:
//   - https only, default port only, no userinfo, a real DNS host name;
//   - `return_url` may carry `{order_number}` (and nothing else) outside the
//     host part;
//   - the `return_url` host must equal the `external_site_url` host or its
//     `www.` twin. No registrable-domain fallback and no Public Suffix List:
//     `evil.co.uk` never matches `shop.example.co.uk`.

export const EXTERNAL_URL_ERROR_CODE = 'CHECKOUT_EXTERNAL_URL_NOT_ALLOWED';

/** The only placeholder `return_url` may contain. */
export const ORDER_NUMBER_PLACEHOLDER = '{order_number}';

/** The two URL keys the parser validates. */
export type ExternalUrlKey = 'external_site_url' | 'return_url';

export type ExternalUrlField =
  | ExternalUrlKey
  // The focused storefront switch: only `external_site_url_required`.
  | 'external_focus';

export type ExternalUrlRejectReason =
  | 'invalid_url'
  | 'too_long'
  | 'https_required'
  | 'userinfo_not_allowed'
  | 'port_not_allowed'
  | 'host_not_allowed'
  | 'placeholder_not_allowed'
  | 'external_site_url_required'
  // The external site is the platform, a subdomain of it (store subdomains
  // included), or one of the hosts that serve this very store.
  | 'store_host_not_allowed';

export const MAX_EXTERNAL_URL_LENGTH = 500;

// Stand-in for the placeholder while the URL is parsed, so the WHATWG parser
// does not percent-encode the braces; swapped back after normalization.
const PLACEHOLDER_SENTINEL = 'zzorderxnumberzz';
const PLACEHOLDER_RE = /\{[^{}]*\}/g;
const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Thrown for every rule violation; `field` + `reason` drive the dashboard. */
export class ExternalUrlRejected extends BadRequestException {
  constructor(
    readonly field: ExternalUrlField,
    readonly reason: ExternalUrlRejectReason,
  ) {
    super({
      code: EXTERNAL_URL_ERROR_CODE,
      message: `${field} is not allowed (${reason})`,
      field,
      reason,
    });
  }
}

/** True for a public DNS host name (not an IP literal, not single-label). */
function isDnsHostName(hostname: string): boolean {
  if (!hostname || hostname.length > 253) return false;
  if (hostname.startsWith('[') || IPV4_RE.test(hostname)) return false;
  const labels = hostname.split('.');
  if (labels.length < 2) return false;
  // The top-level label is never all digits (rules out odd IPv4 spellings).
  if (/^\d+$/.test(labels[labels.length - 1])) return false;
  return labels.every((l) => HOST_LABEL_RE.test(l));
}

/**
 * Validates and normalizes an external URL. Throws `ExternalUrlRejected`.
 * With `allowPlaceholder` (return_url) `{order_number}` may appear in the
 * path, query or fragment; any other `{...}` token is refused.
 */
export function parseExternalReturnUrl(
  raw: unknown,
  field: ExternalUrlField,
  allowPlaceholder = field === 'return_url',
): string {
  if (typeof raw !== 'string')
    throw new ExternalUrlRejected(field, 'invalid_url');
  const value = raw.trim();
  if (!value) throw new ExternalUrlRejected(field, 'invalid_url');
  if (value.length > MAX_EXTERNAL_URL_LENGTH)
    throw new ExternalUrlRejected(field, 'too_long');
  // Whitespace and control characters are never part of a real link.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f\\]/.test(value))
    throw new ExternalUrlRejected(field, 'invalid_url');
  if (!/^https:\/\//i.test(value))
    throw new ExternalUrlRejected(field, 'https_required');
  if (value.toLowerCase().includes(PLACEHOLDER_SENTINEL))
    throw new ExternalUrlRejected(field, 'invalid_url');

  // The authority (userinfo@host:port) must never carry a placeholder.
  const authority = value.slice('https://'.length).split(/[/?#]/, 1)[0];
  if (/[{}]/.test(authority))
    throw new ExternalUrlRejected(field, 'placeholder_not_allowed');

  const tokens = value.match(PLACEHOLDER_RE) ?? [];
  for (const token of tokens) {
    if (!allowPlaceholder || token !== ORDER_NUMBER_PLACEHOLDER)
      throw new ExternalUrlRejected(field, 'placeholder_not_allowed');
  }
  const swapped = value
    .split(ORDER_NUMBER_PLACEHOLDER)
    .join(PLACEHOLDER_SENTINEL);
  // A stray brace outside a well-formed token.
  if (/[{}]/.test(swapped))
    throw new ExternalUrlRejected(field, 'placeholder_not_allowed');

  let url: URL;
  try {
    url = new URL(swapped);
  } catch {
    throw new ExternalUrlRejected(field, 'invalid_url');
  }
  if (url.protocol !== 'https:')
    throw new ExternalUrlRejected(field, 'https_required');
  if (url.username || url.password || authority.includes('@'))
    throw new ExternalUrlRejected(field, 'userinfo_not_allowed');
  // The parser drops an explicit :443, so any remaining port is not 443.
  if (url.port) throw new ExternalUrlRejected(field, 'port_not_allowed');
  if (!isDnsHostName(url.hostname))
    throw new ExternalUrlRejected(field, 'host_not_allowed');

  return url.href.split(PLACEHOLDER_SENTINEL).join(ORDER_NUMBER_PLACEHOLDER);
}

/** Non-throwing variant for stored values: null when the URL is not valid. */
export function tryParseExternalReturnUrl(
  raw: unknown,
  field: ExternalUrlField,
): string | null {
  try {
    return parseExternalReturnUrl(raw, field);
  } catch {
    return null;
  }
}

/** Host name of a URL whose placeholder (if any) sits outside the host. */
function hostOf(url: string): string | null {
  try {
    return new URL(
      url.split(ORDER_NUMBER_PLACEHOLDER).join(PLACEHOLDER_SENTINEL),
    ).hostname;
  } catch {
    return null;
  }
}

/**
 * The hosts a return target may use: the `external_site_url` host and its
 * `www.` twin (`example.se` <-> `www.example.se`). Empty when the site URL
 * is missing or invalid.
 */
export function externalSiteHosts(
  externalSiteUrl: string | null | undefined,
): string[] {
  if (!externalSiteUrl) return [];
  const host = hostOf(externalSiteUrl);
  if (!host) return [];
  const twin = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
  return isDnsHostName(twin) ? [host, twin] : [host];
}

/** True when `url` points at the external site host (or its `www.` twin). */
export function isExternalHostAllowed(
  url: string,
  externalSiteUrl: string | null | undefined,
): boolean {
  const host = hostOf(url);
  return host !== null && externalSiteHosts(externalSiteUrl).includes(host);
}

/**
 * The external site must be a site of its own: never a platform host or a
 * subdomain of one (every store subdomain included). The focused storefront
 * redirects its browsing pages to this URL, so a platform host could loop.
 * Checked on write only; the platform host list is read at call time.
 */
export function assertExternalSiteNotPlatformHost(
  externalSiteUrl: string,
): void {
  const host = hostOf(externalSiteUrl);
  if (host && isReservedDomain(host))
    throw new ExternalUrlRejected(
      'external_site_url',
      'store_host_not_allowed',
    );
}

/**
 * Refuses an external site whose host (or `www.` twin) is one of the hosts
 * that serve this very store (custom domain, market domains).
 */
export function assertExternalSiteNotStoreHost(
  externalSiteUrl: string,
  storeHosts: readonly string[],
): void {
  const own = new Set(
    storeHosts.map((h) => h.trim().toLowerCase().replace(/\.$/, '')),
  );
  if (externalSiteHosts(externalSiteUrl).some((h) => own.has(h)))
    throw new ExternalUrlRejected(
      'external_site_url',
      'store_host_not_allowed',
    );
}

/** Throws `CHECKOUT_EXTERNAL_URL_NOT_ALLOWED` unless the host is allowed. */
export function assertExternalHostAllowed(
  url: string,
  externalSiteUrl: string | null | undefined,
  field: ExternalUrlField = 'return_url',
): void {
  if (!externalSiteUrl)
    throw new ExternalUrlRejected(field, 'external_site_url_required');
  if (!isExternalHostAllowed(url, externalSiteUrl))
    throw new ExternalUrlRejected(field, 'host_not_allowed');
}
