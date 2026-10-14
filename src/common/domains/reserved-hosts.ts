// Hosts a creator cannot claim as a store domain. Mirrors the storefront
// proxy's PLATFORM_HOSTNAMES so an attacker can't register e.g.
// "admin.iwings-digital.com" and intercept platform traffic. Both an exact
// match and any subdomain (`.endsWith('.' + host)`) are blocked.
const RESERVED_HOSTS = (
  process.env.PLATFORM_HOSTS ||
  process.env.NEXT_PUBLIC_PLATFORM_HOSTS ||
  'localhost,iwings-digital.com,www.iwings-digital.com'
)
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

export function isReservedDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase();
  return RESERVED_HOSTS.some((host) => d === host || d.endsWith('.' + host));
}

/** Lower-case hostname without port, whitespace or trailing dot. */
export function normalizeHostname(host: string): string {
  return host.trim().toLowerCase().split(':')[0].replace(/\.$/, '');
}

const HOSTNAME_REGEX =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function isValidHostname(host: string): boolean {
  return HOSTNAME_REGEX.test(host);
}
