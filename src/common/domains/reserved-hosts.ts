// Hosts a creator cannot claim as a store domain. Mirrors the storefront
// proxy's platform host list so an attacker can't register e.g.
// "admin.<platform apex>" and intercept platform traffic. Both an exact
// match and any subdomain (`.endsWith('.' + host)`) are blocked.
//
// The list comes from `platformHosts()`: the host of STOREFRONT_URL (bare +
// www), every entry of PLATFORM_HOSTS (old + new apex during a domain move)
// and localhost. No hardcoded apex.
import { platformHosts } from './platform-hosts';

const RESERVED_HOSTS = platformHosts();

/** Pure form: is `domain` one of `hosts` or a subdomain of one? */
export function isReservedDomainFor(
  domain: string,
  hosts: readonly string[],
): boolean {
  const d = domain.trim().toLowerCase();
  return hosts.some((host) => d === host || d.endsWith('.' + host));
}

export function isReservedDomain(domain: string): boolean {
  return isReservedDomainFor(domain, RESERVED_HOSTS);
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
