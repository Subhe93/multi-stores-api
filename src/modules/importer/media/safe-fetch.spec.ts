import { Readable } from 'stream';
import { expandIpv6, isDisallowedAddress } from './ip-policy';
import {
  SafeFetcher,
  type DnsLookup,
  type Transport,
  type TransportRequest,
} from './safe-fetch';
import { sniffImage } from './sniff';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

describe('ip-policy', () => {
  it.each([
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '64:ff9b::7f00:1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::127.0.0.1',
    // Transition / translation ranges (M4.4 fixer B): 6to4, NAT64, Teredo, SIIT, mapped.
    '2002:7f00:1::1',
    '2002:5db8:d822::1',
    '64:ff9b:1::a00:1',
    '2001:0:4136:e378::1',
    '2001:2::1',
    '::ffff:0:a00:1',
    '::ffff:93.184.216.34',
    '3fff::1',
    '4000::1',
    'not-an-ip',
    '',
  ])('blocks %s', (ip) => expect(isDisallowedAddress(ip)).toBe(true));

  it.each([
    '93.184.216.34',
    '1.1.1.1',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001:80b::200e',
    '2001:4860:4860::8888',
  ])('allows %s', (ip) => expect(isDisallowedAddress(ip)).toBe(false));

  it('expands IPv6 with an embedded IPv4 tail', () => {
    expect(expandIpv6('::ffff:1.2.3.4')).toEqual([
      0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304,
    ]);
    expect(expandIpv6('1::2::3')).toBeNull();
  });
});

describe('sniffImage', () => {
  it('accepts jpeg/png/gif/webp and rejects svg/html', () => {
    expect(sniffImage(JPEG)).toBe('jpeg');
    expect(sniffImage(PNG)).toBe('png');
    expect(sniffImage(Buffer.from('GIF89a....'))).toBe('gif');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(
      sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBeNull();
    expect(sniffImage(Buffer.from('<!doctype html><img>'))).toBeNull();
  });
});

interface Route {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | Buffer[];
}

function stubs(
  routes: Record<string, Route>,
  dns: Record<string, string[]> = {},
) {
  const requests: TransportRequest[] = [];
  const lookup: DnsLookup = (host) =>
    Promise.resolve(
      (dns[host] ?? ['93.184.216.34']).map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4,
      })),
    );
  const transport: Transport = (req) => {
    requests.push(req);
    const r = routes[req.url.toString()] ?? { status: 404 };
    const chunks = Array.isArray(r.body) ? r.body : r.body ? [r.body] : [];
    return Promise.resolve({
      status: r.status,
      headers: r.headers ?? {},
      body: Readable.from(chunks),
      destroy: () => undefined,
    });
  };
  return { requests, lookup, transport };
}

const policy = { siteHost: 'namez.se', aliases: ['3dnamez.se'] };
const IMG = 'https://namez.se/wp-content/uploads/2026/01/a.jpg';

describe('SafeFetcher (SSRF guard)', () => {
  it('fetches an uploads image, pinned to the vetted address, with the importer UA and no cookies/auth', async () => {
    const s = stubs({ [IMG]: { status: 200, body: JPEG } });
    const f = new SafeFetcher(policy, {
      lookup: s.lookup,
      transport: s.transport,
      allowPrivate: false,
    });
    const res = await f.get(IMG, { maxBytes: 1024, purpose: 'media' });
    expect(res.status).toBe(200);
    expect(res.body.equals(JPEG)).toBe(true);
    expect(s.requests[0].address).toBe('93.184.216.34');
    expect(s.requests[0].headers['User-Agent']).toBe('MultiStoresImporter/1.0');
    expect(s.requests[0].headers.Authorization).toBeUndefined();
    expect(s.requests[0].headers.Cookie).toBeUndefined();
  });

  it('rewrites alias hosts and upgrades http to https', async () => {
    const s = stubs({ [IMG]: { status: 200, body: JPEG } });
    const f = new SafeFetcher(policy, {
      lookup: s.lookup,
      transport: s.transport,
      allowPrivate: false,
    });
    await f.get('http://3dnamez.se/wp-content/uploads/2026/01/a.jpg', {
      maxBytes: 1024,
      purpose: 'media',
    });
    expect(s.requests[0].url.toString()).toBe(IMG);
  });

  it.each([
    ['another host', 'https://evil.example/wp-content/uploads/a.jpg'],
    ['port 8443', 'https://namez.se:8443/wp-content/uploads/a.jpg'],
    ['userinfo', 'https://user:pw@namez.se/wp-content/uploads/a.jpg'],
    ['path outside uploads', 'https://namez.se/wp-config.php'],
    [
      'encoded traversal',
      'https://namez.se/wp-content/uploads/..%2f..%2fwp-config.php',
    ],
    ['file scheme', 'file:///etc/passwd'],
    ['IP literal host', 'https://127.0.0.1/wp-content/uploads/a.jpg'],
  ])('rejects %s', async (_n, url) => {
    const s = stubs({});
    const f = new SafeFetcher(policy, {
      lookup: s.lookup,
      transport: s.transport,
      allowPrivate: false,
    });
    await expect(
      f.get(url, { maxBytes: 1024, purpose: 'media' }),
    ).rejects.toMatchObject({ code: 'IMPORT_MEDIA_HOST_NOT_ALLOWED' });
    expect(s.requests).toHaveLength(0);
  });

  it.each([
    ['private IPv4', ['10.0.0.5']],
    ['loopback IPv6', ['::1']],
    ['mapped ::ffff:127.0.0.1', ['::ffff:127.0.0.1']],
    ['mixed public + private answers', ['93.184.216.34', '192.168.0.10']],
    ['metadata address', ['169.254.169.254']],
  ])('rejects DNS answers: %s', async (_n, addrs) => {
    const s = stubs({}, { 'namez.se': addrs });
    const f = new SafeFetcher(policy, {
      lookup: s.lookup,
      transport: s.transport,
      allowPrivate: false,
    });
    await expect(
      f.get(IMG, { maxBytes: 1024, purpose: 'media' }),
    ).rejects.toMatchObject({ code: 'IMPORT_MEDIA_PRIVATE_ADDRESS' });
    expect(s.requests).toHaveLength(0);
  });

  it('IMPORTER_ALLOW_PRIVATE_HOSTS lifts the address check only outside production', async () => {
    const env = { ...process.env };
    try {
      process.env.IMPORTER_ALLOW_PRIVATE_HOSTS = '1';
      process.env.NODE_ENV = 'production';
      const s = stubs(
        { [IMG]: { status: 200, body: JPEG } },
        { 'namez.se': ['127.0.0.1'] },
      );
      await expect(
        new SafeFetcher(policy, {
          lookup: s.lookup,
          transport: s.transport,
        }).get(IMG, { maxBytes: 64, purpose: 'media' }),
      ).rejects.toMatchObject({ code: 'IMPORT_MEDIA_PRIVATE_ADDRESS' });
      process.env.NODE_ENV = 'development';
      await expect(
        new SafeFetcher(policy, {
          lookup: s.lookup,
          transport: s.transport,
        }).get(IMG, { maxBytes: 64, purpose: 'media' }),
      ).resolves.toMatchObject({ status: 200 });
    } finally {
      process.env = env;
    }
  });

  it('follows a redirect on the same host and re-vets every hop', async () => {
    const next = 'https://namez.se/wp-content/uploads/2026/01/b.jpg';
    const s = stubs({
      [IMG]: {
        status: 301,
        headers: { location: '/wp-content/uploads/2026/01/b.jpg' },
      },
      [next]: { status: 200, body: JPEG },
    });
    const f = new SafeFetcher(policy, {
      lookup: s.lookup,
      transport: s.transport,
      allowPrivate: false,
    });
    const res = await f.get(IMG, { maxBytes: 1024, purpose: 'media' });
    expect(res.url).toBe(next);
    expect(s.requests).toHaveLength(2);
  });

  it('rejects a redirect to another host or to a private address', async () => {
    const s1 = stubs({
      [IMG]: {
        status: 302,
        headers: { location: 'https://evil.example/wp-content/uploads/x.jpg' },
      },
    });
    await expect(
      new SafeFetcher(policy, {
        lookup: s1.lookup,
        transport: s1.transport,
        allowPrivate: false,
      }).get(IMG, { maxBytes: 64, purpose: 'media' }),
    ).rejects.toMatchObject({ code: 'IMPORT_MEDIA_HOST_NOT_ALLOWED' });

    let calls = 0;
    const s2 = stubs({
      [IMG]: {
        status: 302,
        headers: { location: IMG.replace('a.jpg', 'c.jpg') },
      },
    });
    const rebinding: DnsLookup = () =>
      Promise.resolve([
        { address: calls++ === 0 ? '93.184.216.34' : '10.1.1.1', family: 4 },
      ]);
    await expect(
      new SafeFetcher(policy, {
        lookup: rebinding,
        transport: s2.transport,
        allowPrivate: false,
      }).get(IMG, { maxBytes: 64, purpose: 'media' }),
    ).rejects.toMatchObject({ code: 'IMPORT_MEDIA_PRIVATE_ADDRESS' });
  });

  it('caps redirects at 3', async () => {
    const routes: Record<string, Route> = {};
    for (let i = 0; i < 5; i++)
      routes[`https://namez.se/wp-content/uploads/r${i}.jpg`] = {
        status: 302,
        headers: { location: `/wp-content/uploads/r${i + 1}.jpg` },
      };
    const s = stubs(routes);
    const f = new SafeFetcher(policy, {
      lookup: s.lookup,
      transport: s.transport,
      allowPrivate: false,
    });
    await expect(
      f.get('https://namez.se/wp-content/uploads/r0.jpg', {
        maxBytes: 64,
        purpose: 'media',
      }),
    ).rejects.toMatchObject({
      code: 'IMPORT_MEDIA_FETCH_FAILED',
      message: 'Too many redirects',
    });
    expect(s.requests).toHaveLength(4);
  });

  it('enforces maxBytes with and without Content-Length', async () => {
    const big = Buffer.alloc(100, 1);
    const s1 = stubs({
      [IMG]: { status: 200, headers: { 'content-length': '100' }, body: big },
    });
    await expect(
      new SafeFetcher(policy, {
        lookup: s1.lookup,
        transport: s1.transport,
        allowPrivate: false,
      }).get(IMG, { maxBytes: 50, purpose: 'media' }),
    ).rejects.toMatchObject({ code: 'IMPORT_MEDIA_TOO_LARGE' });
    const s2 = stubs({
      [IMG]: { status: 200, body: [big.subarray(0, 40), big.subarray(40)] },
    });
    await expect(
      new SafeFetcher(policy, {
        lookup: s2.lookup,
        transport: s2.transport,
        allowPrivate: false,
      }).get(IMG, { maxBytes: 50, purpose: 'media' }),
    ).rejects.toMatchObject({ code: 'IMPORT_MEDIA_TOO_LARGE' });
  });

  it('truncate: returns only the first maxBytes when a server ignores Range', async () => {
    const big = Buffer.alloc(100, 7);
    const s = stubs({
      [IMG]: {
        status: 200,
        headers: { 'content-length': '100' },
        body: [big.subarray(0, 30), big.subarray(30)],
      },
    });
    const res = await new SafeFetcher(policy, {
      lookup: s.lookup,
      transport: s.transport,
      allowPrivate: false,
    }).get(IMG, { maxBytes: 50, purpose: 'media', truncate: true });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(50);
  });

  it('sends Basic auth only for REST requests', async () => {
    const url = 'https://namez.se/wp-json/wc/v3/settings/general';
    const s = stubs({ [url]: { status: 200, body: Buffer.from('{}') } });
    const f = new SafeFetcher(policy, {
      lookup: s.lookup,
      transport: s.transport,
      allowPrivate: false,
    });
    await f.get(url, {
      maxBytes: 64,
      purpose: 'rest',
      auth: { user: 'ck', pass: 'cs' },
    });
    expect(s.requests[0].headers.Authorization).toBe(
      `Basic ${Buffer.from('ck:cs').toString('base64')}`,
    );
    await expect(
      f.get(url, {
        maxBytes: 64,
        purpose: 'media',
        auth: { user: 'ck', pass: 'cs' },
      }),
    ).rejects.toMatchObject({ code: 'IMPORT_MEDIA_HOST_NOT_ALLOWED' });
  });

  it('times out a hanging transport (total timeout)', async () => {
    const hanging: Transport = () => new Promise(() => undefined);
    const f = new SafeFetcher(policy, {
      lookup: stubs({}).lookup,
      transport: hanging,
      totalTimeoutMs: 30,
      allowPrivate: false,
    });
    await expect(
      f.get(IMG, { maxBytes: 64, purpose: 'media' }),
    ).rejects.toMatchObject({ code: 'IMPORT_MEDIA_FETCH_FAILED' });
  });
});
