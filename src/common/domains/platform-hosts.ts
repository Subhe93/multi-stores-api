/**
 * The platform's own hostnames (domain-move overlap, plans/domain-move/PLAN.md).
 *
 * During the move from the old apex to the new one both apexes serve the
 * platform side by side, so anything that asks "is this host ours?" checks
 * this LIST, while everything that GENERATES a link keeps following the
 * single primary `STOREFRONT_URL` / `DASHBOARD_URL` / `PUBLIC_API_URL`.
 *
 * The list = the host of `STOREFRONT_URL` (bare and `www.` forms, primary
 * first) + every entry of `PLATFORM_HOSTS` (comma separated; the legacy
 * `NEXT_PUBLIC_PLATFORM_HOSTS` name is still read) + `localhost`.
 * Hostnames only: lower-case, no port. Pure (no Nest / Prisma).
 */

/** Lower-case hostname (no port) of a URL or host string; null when unparsable. */
export function hostnameOf(value: string | undefined | null): string | null {
  const v = (value ?? '').trim().toLowerCase();
  if (!v) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(v) ? v : `http://${v}`);
    return url.hostname || null;
  } catch {
    return null;
  }
}

export interface PlatformHostsEnv {
  PLATFORM_HOSTS?: string;
  NEXT_PUBLIC_PLATFORM_HOSTS?: string;
  STOREFRONT_URL?: string;
}

/** Every hostname the platform is served on (primary first, `localhost` last). */
export function platformHosts(
  env: PlatformHostsEnv = process.env as PlatformHostsEnv,
): string[] {
  const out: string[] = [];
  const add = (h: string | null) => {
    if (h && !out.includes(h)) out.push(h);
  };
  const primary = hostnameOf(env.STOREFRONT_URL);
  if (primary) {
    const bare = primary.replace(/^www\./, '');
    add(primary);
    add(bare);
    if (bare !== 'localhost' && !/^\d+(\.\d+){3}$/.test(bare)) {
      add(`www.${bare}`);
    }
  }
  const list = env.PLATFORM_HOSTS || env.NEXT_PUBLIC_PLATFORM_HOSTS || '';
  for (const part of list.split(',')) add(hostnameOf(part));
  add('localhost');
  return out;
}

/** Exact platform host (marketing site / `www`)? `host` may carry a port. */
export function isPlatformHost(
  host: string,
  hosts: readonly string[],
): boolean {
  const h = hostnameOf(host);
  return h !== null && hosts.includes(h);
}

/**
 * `<label>.<platform host>` → the label (store slug or `<slug>--<key>`
 * preview label) and the platform host it hangs under; null for an exact
 * platform host or a foreign (custom) domain.
 */
export function platformSubdomainOf(
  host: string,
  hosts: readonly string[],
): { label: string; platformHost: string } | null {
  const h = hostnameOf(host);
  if (!h || hosts.includes(h)) return null;
  for (const platformHost of hosts) {
    if (h.endsWith(`.${platformHost}`)) {
      const label = h.slice(0, -(platformHost.length + 1)).split('.')[0] || '';
      return label ? { label, platformHost } : null;
    }
  }
  return null;
}
