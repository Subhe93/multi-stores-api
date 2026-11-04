import {
  hostOf,
  MAX_REPORTS_PER_REQUEST,
  parseCspReports,
  stripUrl,
} from './csp-report.parser';

describe('csp-report parser', () => {
  it('strips query string and fragment from URLs', () => {
    expect(
      stripUrl('https://namez.se/auth/reset?token=SECRET#access=abc'),
    ).toBe('https://namez.se/auth/reset');
    expect(stripUrl('not a url?token=SECRET')).toBe('not a url');
    expect(stripUrl('data:image/png;base64,AAAA')).toBe('data');
  });

  it('reduces URLs to host, keeps keywords', () => {
    expect(hostOf('https://js.example.com/x.js?k=1')).toBe('js.example.com');
    expect(hostOf('http://localhost:3001/api')).toBe('localhost:3001');
    expect(hostOf('inline')).toBe('inline');
    expect(hostOf('eval')).toBe('eval');
    expect(hostOf('blob:https://a.com/uuid')).toBe('blob');
    expect(hostOf(undefined)).toBe('unknown');
  });

  it('parses the legacy application/csp-report format', () => {
    const [r] = parseCspReports({
      'csp-report': {
        'document-uri': 'https://app.shopsdoor.com/login?magic=SECRET',
        'blocked-uri': 'https://evil.example/x.js?t=1',
        'violated-directive': "script-src-elem 'self'",
        'effective-directive': 'script-src-elem',
        disposition: 'report',
        'source-file': 'https://app.shopsdoor.com/_next/a.js?x=1',
      },
    });
    expect(r).toEqual({
      directive: 'script-src-elem',
      blocked: 'evil.example',
      document: 'app.shopsdoor.com',
      disposition: 'report',
      blockedSample: 'https://evil.example/x.js',
      sourceSample: 'https://app.shopsdoor.com/_next/a.js',
    });
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('falls back to violated-directive and normalizes disposition', () => {
    const [r] = parseCspReports({
      'csp-report': {
        'document-uri': 'https://namez.se/',
        'blocked-uri': 'inline',
        'violated-directive': "style-src 'self'",
        disposition: 'weird',
      },
    });
    expect(r.directive).toBe('style-src');
    expect(r.blocked).toBe('inline');
    expect(r.disposition).toBe('report');
    expect(r.blockedSample).toBeNull();
  });

  it('parses the Reporting API (application/reports+json) format', () => {
    const reports = parseCspReports([
      {
        type: 'csp-violation',
        url: 'https://namez.se/checkout?session=SECRET',
        body: {
          documentURL: 'https://namez.se/checkout?session=SECRET',
          blockedURL: 'https://connect.facebook.net/en_US/fbevents.js',
          effectiveDirective: 'connect-src',
          disposition: 'enforce',
        },
      },
      { type: 'deprecation', body: { id: 'x' } },
      'garbage',
    ]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      directive: 'connect-src',
      blocked: 'connect.facebook.net',
      document: 'namez.se',
      disposition: 'enforce',
    });
  });

  it('caps the number of reports read per request', () => {
    const one = {
      type: 'csp-violation',
      body: { documentURL: 'https://a.com', blockedURL: 'inline' },
    };
    const list = Array.from({ length: 500 }, () => one);
    expect(parseCspReports(list)).toHaveLength(MAX_REPORTS_PER_REQUEST);
  });

  it('ignores unknown shapes and strips control characters', () => {
    expect(parseCspReports(null)).toEqual([]);
    expect(parseCspReports('x')).toEqual([]);
    expect(parseCspReports({ foo: 1 })).toEqual([]);
    const [r] = parseCspReports({
      'csp-report': {
        'document-uri': 'https://a.com',
        'blocked-uri': 'inl\nine\u0007',
        'effective-directive': 'script-src\nFAKE LOG LINE',
      },
    });
    expect(r.blocked).toBe('inl ine');
    expect(r.directive).toBe('script-src');
  });
});
