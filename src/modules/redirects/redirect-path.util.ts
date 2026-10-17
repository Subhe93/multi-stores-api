// Path normalisation for store redirects (M4.4 §6.2). Pure; mirrored in the
// web storefront (`multi-stores-web/src/lib/redirects.ts`) — keep the two in
// sync, the vectors in redirect-path.util.spec.ts are the contract.

export const REDIRECT_PATH_MAX = 1024;

/** Proxy switches to per-path `resolve` above this many active rows. */
export const REDIRECT_MAP_MAX_ENTRIES = 20_000;

export const REDIRECT_STATUS_CODES = [301, 302, 307, 308] as const;
export type RedirectStatusCode = (typeof REDIRECT_STATUS_CODES)[number];

// Trailing segments WordPress serves for the same resource (pagination,
// feeds, AMP, oEmbed). Tried once when there is no exact match.
const FALLBACK_SUFFIX = /\/(?:page\/\d+|feed|amp|embed)$/;

/**
 * WordPress shortlink `/?p=<ID>` (M5 B17): the only query form that is part
 * of a matching key. The key is `/?p=<id>` verbatim; every other query is
 * dropped.
 */
const SHORTLINK_RE = /^\/?\?p=(\d{1,12})(?:[&#]|$)/;

/** Percent-decode; an invalid sequence leaves the input unchanged. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The `/?p=<id>` key of a shortlink request, or null. */
export function shortlinkRedirectPath(input: string): string | null {
  const m = SHORTLINK_RE.exec(input.trim());
  return m ? `/?p=${Number(m[1])}` : null;
}

/**
 * Normalised matching key of a request path or a stored `from_path`:
 * query and fragment dropped (except the `/?p=<id>` shortlink, kept as its
 * own key), percent-decoded (safely), NFC, lower-case, `//` collapsed,
 * trailing `/` removed (except on root). A `?` or `#` that only appears
 * after decoding (`%3F`, `%23`) is a literal path character and is kept
 * encoded (`%3f`, `%23`) so the key never reads as a query (M5 B22). Returns
 * null for input that is not a path (no leading `/`, control characters,
 * too long).
 */
export function normalizeRedirectPath(input: string): string | null {
  if (typeof input !== 'string') return null;
  let path = input.trim();
  const shortlink = shortlinkRedirectPath(path);
  if (shortlink) return shortlink;
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  if (!path.startsWith('/')) return null;
  path = safeDecode(path)
    .normalize('NFC')
    .toLowerCase()
    .replace(/\?/g, '%3f')
    .replace(/#/g, '%23');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path.length > REDIRECT_PATH_MAX) return null;
  return path;
}

/**
 * The single retry key for a normalised path: a trailing `/page/<n>`,
 * `/feed` or `/amp` removed. Null when the path has no such suffix.
 */
export function fallbackRedirectPath(normalized: string): string | null {
  if (!FALLBACK_SUFFIX.test(normalized)) return null;
  const stripped = normalized.replace(FALLBACK_SUFFIX, '');
  return stripped === '' ? '/' : stripped;
}

/**
 * Validated `to_path`: an absolute path on the same host (query/fragment
 * allowed). Rejects schemes, protocol-relative `//host`, backslashes (which
 * browsers treat as `/`), whitespace and control characters. Returns the
 * trimmed value or null.
 */
export function sanitizeRedirectTarget(input: string): string | null {
  if (typeof input !== 'string') return null;
  const to = input.trim();
  if (!to.startsWith('/') || to.startsWith('//')) return null;
  if (to.length > REDIRECT_PATH_MAX) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\s\u0000-\u001f\u007f]/.test(to)) return null;
  // A decoded `//` or `\` at the start would still be read as another host
  // by some clients after the redirect.
  const decoded = safeDecode(to);
  if (decoded.startsWith('//') || decoded.startsWith('/\\')) return null;
  return to;
}

/** Matching key of a target (its path part), for chain/loop detection. */
export function targetKey(to: string): string | null {
  return normalizeRedirectPath(to);
}

/** True when the target carries a query string or fragment (a `/?p=` shortlink counts). */
export function targetHasQuery(to: string): boolean {
  return /[?#]/.test(to);
}

export function isRedirectStatusCode(
  code: unknown,
): code is RedirectStatusCode {
  return (REDIRECT_STATUS_CODES as readonly unknown[]).includes(code);
}

/**
 * Reference lookup of a request path in a `from → value` map: exact key
 * first, then the fallback key once. Production code does not call it: the
 * API's `RedirectsService.findMatch` runs the same two keys as one SQL query
 * and the web mirror (`matchRedirectMap` in `multi-stores-web/src/lib/
 * redirects.ts`) implements the same steps over its cached map. The spec
 * vectors of redirect-path.util.spec.ts pin this order for all three.
 */
export function matchRedirect<T>(
  map: ReadonlyMap<string, T>,
  requestPath: string,
): T | null {
  const key = normalizeRedirectPath(requestPath);
  if (key === null) return null;
  const exact = map.get(key);
  if (exact !== undefined) return exact;
  const fallback = fallbackRedirectPath(key);
  if (fallback === null) return null;
  return map.get(fallback) ?? null;
}
