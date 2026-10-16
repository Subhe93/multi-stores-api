import { isIP } from 'net';

/**
 * Address policy of the SSRF-safe fetcher (M4.4 §7). Pure: the fetcher calls
 * `isDisallowedAddress` for every resolved address and for IP literals.
 */

/** IPv4 ranges that are never fetched (CIDR). */
export const BLOCKED_IPV4_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
] as const;

/**
 * IPv6 is allow-listed: only global unicast `2000::/3` may be fetched, minus
 * these ranges (transition mechanisms that tunnel/translate to arbitrary IPv4,
 * documentation and IETF special-purpose blocks). Ranges outside `2000::/3`
 * (loopback, ULA, link-local, multicast, NAT64 `64:ff9b::/96` and
 * `64:ff9b:1::/48`, IPv4-mapped `::ffff:0:0/96`, SIIT `::ffff:0:0:0/96`) are
 * refused by the allow-list and listed here for clarity.
 */
export const IPV6_GLOBAL_UNICAST = '2000::/3';
export const BLOCKED_IPV6_CIDRS = [
  '::/128',
  '::1/128',
  '::ffff:0:0/96',
  '::ffff:0:0:0/96',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
  // Inside 2000::/3:
  '2001::/32', // Teredo
  '2001::/23', // IETF protocol assignments (ORCHID, benchmarking, ...)
  '2001:db8::/32', // documentation
  '2002::/16', // 6to4
  '3fff::/20', // documentation (RFC 9637)
] as const;

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inIpv4Cidr(ip: number, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const b = ipv4ToInt(base)!;
  if (bits === 0) return true;
  const size = 2 ** (32 - bits);
  return Math.floor(ip / size) === Math.floor(b / size);
}

/** Expands an IPv6 address (with an optional embedded IPv4 tail) to 8 hextets; null when invalid. */
export function expandIpv6(input: string): number[] | null {
  let ip = input.toLowerCase();
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  let tail: number[] = [];
  const lastColon = ip.lastIndexOf(':');
  const maybeV4 = ip.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = ipv4ToInt(maybeV4);
    if (v4 === null) return null;
    tail = [Math.floor(v4 / 65536), v4 % 65536];
    ip = ip.slice(0, lastColon + 1) + (tail.length ? '0:0' : '');
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) =>
    s === ''
      ? []
      : s
          .split(':')
          .map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...rest].some((x) => Number.isNaN(x))) return null;
  let words: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    words = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    words = head;
  }
  if (words.length !== 8) return null;
  if (tail.length) {
    words[6] = tail[0];
    words[7] = tail[1];
  }
  return words;
}

function inIpv6Cidr(words: number[], cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const b = expandIpv6(base)!;
  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const take = Math.min(16, remaining);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((words[i] & mask) !== (b[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}

function ipv4Blocked(n: number): boolean {
  return BLOCKED_IPV4_CIDRS.some((c) => inIpv4Cidr(n, c));
}

/**
 * True when the address must not be fetched: private, loopback, link-local,
 * multicast, reserved and documentation IPv4 ranges; any IPv6 address outside
 * global unicast `2000::/3` (so every IPv4-mapped / -compatible / translated
 * form) or inside a blocked transition range; and anything that is not a
 * valid IP.
 */
export function isDisallowedAddress(address: string): boolean {
  const family = isIP(address.split('%')[0]);
  if (family === 4) {
    const n = ipv4ToInt(address);
    return n === null || ipv4Blocked(n);
  }
  if (family !== 6) return true;
  const words = expandIpv6(address);
  if (!words) return true;
  if (!inIpv6Cidr(words, IPV6_GLOBAL_UNICAST)) return true;
  return BLOCKED_IPV6_CIDRS.some((c) => inIpv6Cidr(words, c));
}
