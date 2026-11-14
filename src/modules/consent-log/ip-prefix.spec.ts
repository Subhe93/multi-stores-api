import { ipPrefix } from './ip-prefix';

describe('ipPrefix (consent log: never the raw address)', () => {
  it.each([
    ['203.0.113.77', '203.0.113.0'],
    ['10.1.2.3', '10.1.2.0'],
    ['  192.168.1.200 ', '192.168.1.0'],
  ])('IPv4 %s -> /24 %s', (ip, out) => {
    expect(ipPrefix(ip)).toBe(out);
  });

  it.each([
    ['2001:db8:85a3:8d3:1319:8a2e:370:7348', '2001:db8:85a3::'],
    ['2001:0DB8:0000:0042::1', '2001:db8:0::'],
    ['2a02:aa1::1', '2a02:aa1:0::'],
    ['::1', '0:0:0::'],
    ['fe80::1%eth0', 'fe80:0:0::'],
    ['[2001:db8:1:2::5]:443', '2001:db8:1::'],
  ])('IPv6 %s -> /48 %s', (ip, out) => {
    expect(ipPrefix(ip)).toBe(out);
  });

  it.each([
    ['::ffff:198.51.100.23', '198.51.100.0'],
    ['::FFFF:198.51.100.23', '198.51.100.0'],
    ['::ffff:c633:6417', '198.51.100.0'],
  ])('IPv4-mapped %s -> IPv4 /24 %s', (ip, out) => {
    expect(ipPrefix(ip)).toBe(out);
  });

  it.each([
    null,
    undefined,
    '',
    'garbage',
    '1.2.3',
    '999.1.1.1',
    '1:2:3',
    'a::b::c',
    'unknown',
  ])('unparsable %p -> null', (ip) => {
    expect(ipPrefix(ip)).toBeNull();
  });

  it('IPv4 with a port is cut to the /24', () => {
    expect(ipPrefix('203.0.113.9:51515')).toBe('203.0.113.0');
  });
});
