import { compareHttp, parseArgs, reservoir, rng } from './storage-verify';

describe('storage-verify parseArgs', () => {
  it('defaults and --http validation', () => {
    expect(parseArgs([])).toMatchObject({
      scopes: ['media', 'private', 'invoices'],
      sample: 50,
      http: null,
    });
    expect(
      parseArgs([
        '--http=https://ms-api.example.com/',
        '--sample',
        '10',
        '--seed=7',
      ]),
    ).toMatchObject({
      http: 'https://ms-api.example.com',
      sample: 10,
      seed: 7,
    });
    expect(() => parseArgs(['--http=ms-api.example.com'])).toThrow(/origin/);
    expect(() => parseArgs(['--scope=nope'])).toThrow(/unknown scope/);
  });
});

describe('reservoir sampling', () => {
  it('keeps at most n items, deterministic per seed, every item possible', () => {
    const r = reservoir<number>(5, rng(42));
    for (let i = 0; i < 1000; i++) r.offer(i);
    expect(r.items).toHaveLength(5);
    expect(r.seen).toBe(1000);
    const r2 = reservoir<number>(5, rng(42));
    for (let i = 0; i < 1000; i++) r2.offer(i);
    expect(r2.items).toEqual(r.items);
    expect(r.items.some((v) => v >= 5)).toBe(true);
  });

  it('returns everything when the stream is smaller than n', () => {
    const r = reservoir<number>(5, rng(1));
    r.offer(1);
    r.offer(2);
    expect(r.items).toEqual([1, 2]);
  });
});

describe('compareHttp', () => {
  const local = { sha256: 'abc', size: 3 };
  it('passes when bytes and headers match the serving rules', () => {
    expect(
      compareHttp(
        'media',
        'uploads/products/a.webp',
        {
          status: 200,
          cacheControl: 'public, max-age=31536000, immutable',
          contentType: 'image/webp',
          contentDisposition: null,
          sha256: 'abc',
          size: 3,
        },
        local,
      ),
    ).toBeNull();
    expect(
      compareHttp(
        'media',
        'uploads/customer-previews/a.webp',
        {
          status: 200,
          cacheControl: 'max-age=86400, public',
          contentType: 'image/webp',
          contentDisposition: null,
          sha256: 'abc',
          size: 3,
        },
        local,
      ),
    ).toBeNull();
    expect(
      compareHttp(
        'media',
        'uploads/logos/l.svg',
        {
          status: 200,
          cacheControl: 'public, max-age=31536000, immutable',
          contentType: 'image/svg+xml; charset=utf-8',
          contentDisposition: 'attachment',
          sha256: 'abc',
          size: 3,
        },
        local,
      ),
    ).toBeNull();
  });

  it('reports every problem', () => {
    const p = compareHttp(
      'media',
      'uploads/logos/l.svg',
      {
        status: 200,
        cacheControl: 'no-cache',
        contentType: 'text/plain',
        contentDisposition: null,
        sha256: 'zzz',
        size: 4,
      },
      local,
    )!;
    expect(p).toMatch(/size 4 != 3/);
    expect(p).toMatch(/bytes differ/);
    expect(p).toMatch(/cache-control/);
    expect(p).toMatch(/content-type/);
    expect(p).toMatch(/content-disposition/);
    expect(
      compareHttp(
        'media',
        'uploads/x/y.webp',
        {
          status: 404,
          cacheControl: null,
          contentType: null,
          contentDisposition: null,
          sha256: '',
          size: 0,
        },
        local,
      ),
    ).toBe('HTTP 404');
  });
});
