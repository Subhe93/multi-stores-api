import { isIP } from 'net';

/**
 * Truncates a client address for the consent log (consent v2 §5.2): IPv4 to
 * its /24 (`a.b.c.0`), IPv6 to its /48 (first three hextets + `::`), an
 * IPv4-mapped IPv6 address as IPv4. Anything unparsable gives null. The raw
 * address is never stored.
 */
export function ipPrefix(ip: string | null | undefined): string | null {
  if (typeof ip !== 'string') return null;
  let v = ip.trim();
  if (!v) return null;
  // "[::1]:443" / "1.2.3.4:5678" forms are not produced by Express, but be safe.
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracket) v = bracket[1];
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(v);
  if (v4port) v = v4port[1];
  // Zone id ("fe80::1%eth0") is local information only.
  v = v.split('%')[0];

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v);
  if (mapped) v = mapped[1];

  const kind = isIP(v);
  if (kind === 4) {
    const parts = v.split('.');
    return `${Number(parts[0])}.${Number(parts[1])}.${Number(parts[2])}.0`;
  }
  if (kind === 6) {
    const hextets = expandIpv6(v);
    if (!hextets) return null;
    // A mapped address written in hex ("::ffff:102:304") is still IPv4.
    if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
      const a = hextets[6] >> 8;
      const b = hextets[6] & 0xff;
      const c = hextets[7] >> 8;
      return `${a}.${b}.${c}.0`;
    }
    return `${hextets
      .slice(0, 3)
      .map((h) => h.toString(16))
      .join(':')}::`;
  }
  return null;
}

/** Eight 16-bit groups of a valid IPv6 address (embedded IPv4 tail allowed). */
function expandIpv6(v: string): number[] | null {
  let s = v.toLowerCase();
  // Embedded IPv4 tail ("64:ff9b::1.2.3.4") becomes two hextets.
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    s =
      s.slice(0, tail.index) +
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...rest];
  if (groups.length !== 8) return null;
  const out = groups.map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN,
  );
  return out.some((n) => Number.isNaN(n)) ? null : out;
}
