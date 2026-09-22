/**
 * Pure origin matching for CORS_ALLOWED_ORIGINS. Kept free of Nest / Prisma
 * so it can be unit-tested and reasoned about on its own.
 *
 * An entry is either an exact origin ("https://iwings-digital.com") or a
 * wildcard origin whose host starts with "*." ("https://*.iwings-digital.com").
 * A wildcard matches exactly one subdomain level: "https://shop.iwings-
 * digital.com" yes, "https://a.b.iwings-digital.com" and the bare
 * "https://iwings-digital.com" no. Scheme and port must match in both forms
 * (a default port — 443 for https, 80 for http — equals an omitted one).
 */

interface ParsedOrigin {
  scheme: string;
  host: string;
  /** Effective port: explicit, or the scheme default. */
  port: string;
}

const DEFAULT_PORTS: Record<string, string> = { https: '443', http: '80' };

/** Lenient origin parser; unlike `new URL()` it tolerates "*." hosts. */
export function parseOrigin(value: string): ParsedOrigin | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/:?#]+)(?::(\d+))?\/?$/i.exec(
    value.trim(),
  );
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  const host = match[2].toLowerCase();
  const port = match[3] ?? DEFAULT_PORTS[scheme] ?? '';
  return { scheme, host, port };
}

/** Comma-separated env value → trimmed, non-empty entries. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/** Hostname of a request origin (lower-case), or null when unparsable. */
export function originHostname(origin: string): string | null {
  return parseOrigin(origin)?.host ?? null;
}

/**
 * Does `origin` match one of the configured entries? Exact entries compare
 * scheme + host + effective port case-insensitively; "*." entries match one
 * subdomain level. Entries that are not valid origins are ignored.
 */
export function matchesAllowedOrigin(
  origin: string,
  allowed: readonly string[],
): boolean {
  const request = parseOrigin(origin);
  if (!request) return false;
  for (const entry of allowed) {
    const pattern = parseOrigin(entry);
    if (!pattern) continue;
    if (pattern.scheme !== request.scheme || pattern.port !== request.port) {
      continue;
    }
    if (pattern.host.startsWith('*.')) {
      const suffix = pattern.host.slice(1); // ".iwings-digital.com"
      if (!request.host.endsWith(suffix)) continue;
      const label = request.host.slice(0, -suffix.length);
      if (label.length > 0 && !label.includes('.')) return true;
      continue;
    }
    if (pattern.host === request.host) return true;
  }
  return false;
}
