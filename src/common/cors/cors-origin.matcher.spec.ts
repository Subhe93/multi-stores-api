import {
  matchesAllowedOrigin,
  originHostname,
  parseAllowedOrigins,
  parseOrigin,
} from './cors-origin.matcher';

describe('cors-origin.matcher', () => {
  const allowed = parseAllowedOrigins(
    ' https://iwings-digital.com, https://*.iwings-digital.com ,https://ms-dash.iwings-digital.com,http://localhost:3000,',
  );

  it('parses the comma list, trimming blanks and empty entries', () => {
    expect(allowed).toEqual([
      'https://iwings-digital.com',
      'https://*.iwings-digital.com',
      'https://ms-dash.iwings-digital.com',
      'http://localhost:3000',
    ]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });

  it('parses origins with default and explicit ports', () => {
    expect(parseOrigin('https://Shop.Example.com')).toEqual({
      scheme: 'https',
      host: 'shop.example.com',
      port: '443',
    });
    expect(parseOrigin('http://localhost:3000/')).toEqual({
      scheme: 'http',
      host: 'localhost',
      port: '3000',
    });
    expect(parseOrigin('not an origin')).toBeNull();
    expect(parseOrigin('https://a.com/path')).toBeNull();
    expect(originHostname('HTTPS://WWW.SHOP.COM')).toBe('www.shop.com');
    expect(originHostname('null')).toBeNull();
  });

  it('matches exact origins case-insensitively', () => {
    expect(matchesAllowedOrigin('https://iwings-digital.com', allowed)).toBe(
      true,
    );
    expect(matchesAllowedOrigin('https://IWINGS-DIGITAL.com', allowed)).toBe(
      true,
    );
    expect(
      matchesAllowedOrigin('https://iwings-digital.com:443', allowed),
    ).toBe(true);
    expect(matchesAllowedOrigin('http://iwings-digital.com', allowed)).toBe(
      false,
    );
    expect(
      matchesAllowedOrigin('https://iwings-digital.com:8443', allowed),
    ).toBe(false);
    expect(matchesAllowedOrigin('http://localhost:3000', allowed)).toBe(true);
    expect(matchesAllowedOrigin('http://localhost:3001', allowed)).toBe(false);
  });

  it('matches wildcard entries for exactly one subdomain level', () => {
    expect(
      matchesAllowedOrigin('https://shop.iwings-digital.com', allowed),
    ).toBe(true);
    expect(
      matchesAllowedOrigin('https://ms-dash.iwings-digital.com', allowed),
    ).toBe(true);
    expect(
      matchesAllowedOrigin('https://a.b.iwings-digital.com', allowed),
    ).toBe(false);
    expect(
      matchesAllowedOrigin('http://shop.iwings-digital.com', allowed),
    ).toBe(false);
    // The wildcard alone never matches the apex or look-alike hosts.
    expect(
      matchesAllowedOrigin('https://iwings-digital.com', [
        'https://*.iwings-digital.com',
      ]),
    ).toBe(false);
    expect(
      matchesAllowedOrigin('https://evil-iwings-digital.com', allowed),
    ).toBe(false);
    expect(
      matchesAllowedOrigin('https://shop.iwings-digital.com.evil.io', allowed),
    ).toBe(false);
  });

  it('ignores malformed entries and origins', () => {
    expect(matchesAllowedOrigin('https://x.com', ['garbage', ''])).toBe(false);
    expect(matchesAllowedOrigin('garbage', allowed)).toBe(false);
    expect(matchesAllowedOrigin('', allowed)).toBe(false);
  });
});
