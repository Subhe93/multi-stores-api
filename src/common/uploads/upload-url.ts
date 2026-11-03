/**
 * Pure helpers for public upload URLs (S3 storage project, SPEC.md "Database
 * rows keep their current values" + INVENTORY.md §2).
 *
 * The public URL shape of a media file is `/uploads/<folder>/<file>` on the
 * API host and its object key is the same path without the leading slash
 * (`uploads/<folder>/<file>`). Dashboard uploads stored ABSOLUTE API-host
 * URLs for years, so a value can be either form:
 *
 *   /uploads/products/abc.webp
 *   https://ms-api.example.com/uploads/products/abc.webp
 *   http://localhost:3001/uploads/products/abc.webp
 *
 * `normalizeUploadUrl` turns the absolute form into the relative one when the
 * host is one of OUR hosts (never touches foreign URLs, never touches text
 * that is not an upload URL). `extractUploadKey` maps either form to the
 * object key. Both are side-effect free and shared by the API (DTO
 * normalisation) and the ops scripts (`prisma/scripts/uploads-url-normalize.ts`,
 * `storage-migrate.ts`).
 */

/** Hosts that are always treated as ours (dev API). Compared lowercase. */
export const DEFAULT_UPLOAD_HOSTS: readonly string[] = ['localhost:3001'];

/** Absolute upload URL of one of the given hosts: `https://host/uploads/...`. */
const ABSOLUTE_RE = /^(https?):\/\/([^/?#\s]+)(\/uploads\/[^\s"'<>)]*)$/i;

/**
 * Embedded occurrences inside text/JSON (`src="https://host/uploads/x.webp"`,
 * `url(https://host/uploads/x.webp)`). The path part stops at characters that
 * end a URL in HTML/CSS/JSON.
 */
const EMBEDDED_RE = /https?:\/\/([^/?#\s"'<>)]+)(\/uploads\/[^\s"'<>)\\]*)/gi;

/** `/uploads/...` occurrences in any text (relative or absolute form). */
const PATH_SCAN_RE = /\/uploads\/[^\s"'<>)\\]+/g;

function normalizeHostList(hosts: readonly string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const h of DEFAULT_UPLOAD_HOSTS) out.add(h.toLowerCase());
  for (const raw of hosts ?? []) {
    const h = hostOf(raw);
    if (h) out.add(h);
  }
  return out;
}

/**
 * Host (lowercase, with port when present) of a host string or an origin URL:
 * `ms-api.example.com`, `https://ms-api.example.com/`, `localhost:3001`.
 */
export function hostOf(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  const m = /^(?:https?:\/\/)?([^/?#\s]+)/.exec(v);
  return m ? m[1] : null;
}

/**
 * Collapses an absolute `https://<our host>/uploads/...` to `/uploads/...`.
 * Everything else (relative paths, other hosts, plain text, empty) is
 * returned unchanged. Query string and fragment are dropped, since the
 * public files are immutable and never take parameters.
 */
export function normalizeUploadUrl(
  value: string,
  knownHosts: readonly string[] = [],
): string {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const m = ABSOLUTE_RE.exec(trimmed);
  if (!m) return value;
  const hosts = normalizeHostList(knownHosts);
  if (!hosts.has(m[2].toLowerCase())) return value;
  return stripQuery(m[3]);
}

/**
 * Rewrites every embedded absolute upload URL of our hosts inside free text
 * (HTML, CSS, a JSON document serialised as text). Returns the text and the
 * number of replacements. Whole-value URLs are handled too.
 */
export function normalizeUploadUrlsInText(
  text: string,
  knownHosts: readonly string[] = [],
): { text: string; changed: number } {
  if (typeof text !== 'string' || !text.includes('/uploads/')) {
    return { text, changed: 0 };
  }
  const hosts = normalizeHostList(knownHosts);
  let changed = 0;
  const out = text.replace(EMBEDDED_RE, (whole, host: string, p: string) => {
    if (!hosts.has(host.toLowerCase())) return whole;
    changed++;
    return p;
  });
  return { text: out, changed };
}

/**
 * Deep copy of a JSON value with every string leaf passed through
 * `normalizeUploadUrlsInText`. Object key order and non-string leaves are
 * preserved so an unchanged document serialises identically.
 */
export function normalizeUploadUrlsInJson<T>(
  value: T,
  knownHosts: readonly string[] = [],
): { value: T; changed: number } {
  let changed = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = normalizeUploadUrlsInText(v, knownHosts);
      changed += r.changed;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(inner);
      }
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, changed };
}

/**
 * Object key (`uploads/<folder>/<file>`) of a public upload URL, or null when
 * the value is not an upload URL. Accepts the relative form and the absolute
 * form; with `knownHosts` given, absolute URLs of other hosts are rejected
 * (without it, any host is accepted — used by the orphan report, where an
 * old host name must still count as a reference). Percent-encoding is
 * decoded, query/fragment dropped, and keys containing `..` or empty
 * segments are rejected.
 */
export function extractUploadKey(
  value: string,
  knownHosts?: readonly string[],
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  let pathPart: string | null = null;
  if (trimmed.startsWith('/uploads/')) {
    pathPart = trimmed;
  } else {
    const m = ABSOLUTE_RE.exec(trimmed);
    if (!m) return null;
    if (knownHosts && !normalizeHostList(knownHosts).has(m[2].toLowerCase())) {
      return null;
    }
    pathPart = m[3];
  }
  return keyFromPath(pathPart);
}

/**
 * Every object key referenced anywhere in a text blob (JSON, HTML); both
 * relative and absolute forms, any host. Deduplicated, in order of appearance.
 */
export function scanUploadKeys(text: string): string[] {
  if (typeof text !== 'string' || !text.includes('/uploads/')) return [];
  const seen = new Set<string>();
  for (const m of text.matchAll(PATH_SCAN_RE)) {
    const key = keyFromPath(m[0]);
    if (key) seen.add(key);
  }
  return [...seen];
}

function stripQuery(p: string): string {
  const cut = p.search(/[?#]/);
  return cut === -1 ? p : p.slice(0, cut);
}

function keyFromPath(p: string): string | null {
  let path = stripQuery(p);
  // JSON-escaped slashes (`\/uploads\/x`) never appear after JSON.parse, but a
  // raw scan over the serialised text may see a trailing backslash.
  path = path.replace(/\\+$/, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (!path.startsWith('/uploads/')) return null;
  const key = path.slice(1);
  const segments = key.split('/');
  if (segments.length < 3) return null; // uploads/<folder>/<file> at least
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  if (key.includes('\0')) return null;
  return key;
}
