import {
  extractUploadKey,
  hostOf,
  normalizeUploadUrl,
  normalizeUploadUrlsInJson,
  normalizeUploadUrlsInText,
  scanUploadKeys,
} from './upload-url';

const HOSTS = ['ms-api.shopsdoor.com', 'https://api.example.com/'];

describe('normalizeUploadUrl', () => {
  it('collapses absolute URLs of known hosts to relative', () => {
    expect(
      normalizeUploadUrl(
        'https://ms-api.shopsdoor.com/uploads/products/a.webp',
        HOSTS,
      ),
    ).toBe('/uploads/products/a.webp');
    expect(
      normalizeUploadUrl('https://API.example.com/uploads/logos/x.svg', HOSTS),
    ).toBe('/uploads/logos/x.svg');
  });

  it('always treats localhost:3001 as ours', () => {
    expect(
      normalizeUploadUrl('http://localhost:3001/uploads/avatars/u.webp'),
    ).toBe('/uploads/avatars/u.webp');
  });

  it('leaves relative paths, foreign hosts and plain text alone', () => {
    expect(normalizeUploadUrl('/uploads/products/a.webp', HOSTS)).toBe(
      '/uploads/products/a.webp',
    );
    expect(
      normalizeUploadUrl(
        'https://cdn.other.com/uploads/products/a.webp',
        HOSTS,
      ),
    ).toBe('https://cdn.other.com/uploads/products/a.webp');
    expect(normalizeUploadUrl('Hello world', HOSTS)).toBe('Hello world');
    expect(normalizeUploadUrl('', HOSTS)).toBe('');
    expect(
      normalizeUploadUrl(
        'https://ms-api.shopsdoor.com/api/designer/assets/x.png',
        HOSTS,
      ),
    ).toBe('https://ms-api.shopsdoor.com/api/designer/assets/x.png');
  });

  it('drops query string and fragment', () => {
    expect(
      normalizeUploadUrl(
        'https://ms-api.shopsdoor.com/uploads/products/a.webp?v=2#x',
        HOSTS,
      ),
    ).toBe('/uploads/products/a.webp');
  });

  it('does not rewrite a different port of a known host', () => {
    expect(
      normalizeUploadUrl('http://localhost:3002/uploads/products/a.webp'),
    ).toBe('http://localhost:3002/uploads/products/a.webp');
  });
});

describe('normalizeUploadUrlsInText', () => {
  it('rewrites embedded occurrences and counts them', () => {
    const r = normalizeUploadUrlsInText(
      '<img src="https://ms-api.shopsdoor.com/uploads/page-blocks/a.webp"> ' +
        'background:url(https://ms-api.shopsdoor.com/uploads/store-hero/b.webp) ' +
        'keep https://cdn.other.com/uploads/c.webp',
      HOSTS,
    );
    expect(r.changed).toBe(2);
    expect(r.text).toBe(
      '<img src="/uploads/page-blocks/a.webp"> background:url(/uploads/store-hero/b.webp) keep https://cdn.other.com/uploads/c.webp',
    );
  });

  it('is a no-op without /uploads/', () => {
    expect(normalizeUploadUrlsInText('nothing here', HOSTS)).toEqual({
      text: 'nothing here',
      changed: 0,
    });
  });
});

describe('normalizeUploadUrlsInJson', () => {
  it('walks nested objects and arrays, preserving shape and key order', () => {
    const doc = {
      hero: {
        image: 'https://ms-api.shopsdoor.com/uploads/store-hero/h.webp',
        title: 'Welcome',
        count: 3,
        enabled: true,
        nothing: null,
      },
      gallery: [
        { url: 'https://ms-api.shopsdoor.com/uploads/page-blocks/1.webp' },
        { url: '/uploads/page-blocks/2.webp' },
        'https://other.com/uploads/x.webp',
      ],
      html: '<p><img src="http://localhost:3001/uploads/page-blocks/3.webp"></p>',
    };
    const r = normalizeUploadUrlsInJson(doc, HOSTS);
    expect(r.changed).toBe(3);
    expect(r.value).toEqual({
      hero: {
        image: '/uploads/store-hero/h.webp',
        title: 'Welcome',
        count: 3,
        enabled: true,
        nothing: null,
      },
      gallery: [
        { url: '/uploads/page-blocks/1.webp' },
        { url: '/uploads/page-blocks/2.webp' },
        'https://other.com/uploads/x.webp',
      ],
      html: '<p><img src="/uploads/page-blocks/3.webp"></p>',
    });
    expect(Object.keys(r.value.hero)).toEqual(Object.keys(doc.hero));
    // Input is not mutated.
    expect(doc.hero.image).toBe(
      'https://ms-api.shopsdoor.com/uploads/store-hero/h.webp',
    );
  });

  it('serialises identically when nothing changes', () => {
    const doc = { a: [1, { b: '/uploads/x/y.webp' }], c: 'text' };
    const r = normalizeUploadUrlsInJson(doc, HOSTS);
    expect(r.changed).toBe(0);
    expect(JSON.stringify(r.value)).toBe(JSON.stringify(doc));
  });

  it('handles scalars and null at the root', () => {
    expect(normalizeUploadUrlsInJson(null, HOSTS)).toEqual({
      value: null,
      changed: 0,
    });
    expect(normalizeUploadUrlsInJson(5, HOSTS)).toEqual({
      value: 5,
      changed: 0,
    });
  });
});

describe('extractUploadKey', () => {
  it('maps relative and absolute forms to the object key', () => {
    expect(extractUploadKey('/uploads/products/a.webp')).toBe(
      'uploads/products/a.webp',
    );
    expect(
      extractUploadKey('https://old-host.example/uploads/products/a.webp?x=1'),
    ).toBe('uploads/products/a.webp');
    expect(
      extractUploadKey(
        'https://ms-api.shopsdoor.com/uploads/template-imports/st/f.png',
        HOSTS,
      ),
    ).toBe('uploads/template-imports/st/f.png');
  });

  it('rejects foreign hosts when knownHosts is given', () => {
    expect(
      extractUploadKey('https://cdn.other.com/uploads/products/a.webp', HOSTS),
    ).toBeNull();
  });

  it('rejects non-upload values and traversal', () => {
    expect(extractUploadKey('plain text')).toBeNull();
    expect(extractUploadKey('/api/designer/assets/x.png')).toBeNull();
    expect(extractUploadKey('/uploads/../etc/passwd')).toBeNull();
    expect(extractUploadKey('/uploads/products/')).toBeNull();
    expect(extractUploadKey('/uploads/onlyfolder')).toBeNull();
    expect(extractUploadKey('/uploads/products/%E0%A4%A')).toBeNull();
  });

  it('decodes percent-encoding', () => {
    expect(extractUploadKey('/uploads/products/caf%C3%A9.webp')).toBe(
      'uploads/products/café.webp',
    );
  });
});

describe('scanUploadKeys', () => {
  it('finds every reference in a JSON blob, deduplicated', () => {
    const json = JSON.stringify({
      a: 'https://ms-api.shopsdoor.com/uploads/page-blocks/1.webp',
      b: '/uploads/page-blocks/1.webp',
      c: '<img src="/uploads/page-blocks/2.webp">',
      d: 'css url(/uploads/store-hero/3.webp)',
      e: '/api/designer/assets/no.png',
    });
    expect(scanUploadKeys(json)).toEqual([
      'uploads/page-blocks/1.webp',
      'uploads/page-blocks/2.webp',
      'uploads/store-hero/3.webp',
    ]);
  });

  it('returns [] when nothing is referenced', () => {
    expect(scanUploadKeys('{"a":1}')).toEqual([]);
  });
});

describe('hostOf', () => {
  it('extracts a lowercase host from a host or origin', () => {
    expect(hostOf('MS-API.shopsdoor.com')).toBe('ms-api.shopsdoor.com');
    expect(hostOf('https://api.example.com/')).toBe('api.example.com');
    expect(hostOf('http://localhost:3001')).toBe('localhost:3001');
    expect(hostOf('  ')).toBeNull();
  });
});
