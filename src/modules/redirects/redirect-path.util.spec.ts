import {
  fallbackRedirectPath,
  matchRedirect,
  normalizeRedirectPath,
  sanitizeRedirectTarget,
  shortlinkRedirectPath,
} from './redirect-path.util';

// M4.4 §6.2. These vectors are the contract for the web mirror
// (multi-stores-web/src/lib/redirects.ts): keep both in sync.

describe('normalizeRedirectPath', () => {
  it.each([
    ['/produkt/namnskylt', '/produkt/namnskylt'],
    ['/produkt/namnskylt/', '/produkt/namnskylt'],
    ['/Produkt/NamnSkylt', '/produkt/namnskylt'],
    ['//produkt///namnskylt//', '/produkt/namnskylt'],
    ['/produkt/namnskylt?utm=1#top', '/produkt/namnskylt'],
    ['/produkt/%C3%A4pple', '/produkt/äpple'],
    ['/produkt/%c3%84PPLE', '/produkt/äpple'],
    // NFD "a" + combining diaeresis is folded to the NFC "ä".
    ['/produkt/äpple', '/produkt/äpple'],
    // Invalid percent sequence: left as-is (then lower-cased).
    ['/produkt/%E0%A4%A', '/produkt/%e0%a4%a'],
    ['/', '/'],
    ['//', '/'],
    ['  /x/  ', '/x'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeRedirectPath(input)).toBe(expected);
  });

  it.each([
    'produkt/x',
    'https://namez.se/produkt/x',
    '',
    '?x=1',
    '/a\u0000b',
    '/%0a',
    '/' + 'a'.repeat(1024),
  ])('rejects %j', (input) => {
    expect(normalizeRedirectPath(input)).toBeNull();
  });

  it('accepts exactly 1024 characters', () => {
    const p = '/' + 'a'.repeat(1023);
    expect(normalizeRedirectPath(p)).toBe(p);
  });

  // M5 B17: the WordPress shortlink `/?p=<ID>` is the one query form that is
  // a key of its own; M5 B22: a `?` / `#` that only appears after decoding
  // is a literal path character, never a query.
  it.each([
    ['/?p=4256', '/?p=4256'],
    ['/?p=0042&utm_source=x', '/?p=42'],
    ['/?p=7#top', '/?p=7'],
    ['?p=42', '/?p=42'],
    ['/produkt/x/?p=42', '/produkt/x'],
    ['/produkt/a%3Fb', '/produkt/a%3fb'],
    ['/produkt/a%3Fb?utm=1', '/produkt/a%3fb'],
    ['/produkt/a%23b', '/produkt/a%23b'],
    ['/produkt/a?b', '/produkt/a'],
  ])('shortlink / literal query: %j → %j', (input, expected) => {
    expect(normalizeRedirectPath(input)).toBe(expected);
  });

  it('shortlinkRedirectPath only accepts a numeric id at the root', () => {
    expect(shortlinkRedirectPath('/?p=12')).toBe('/?p=12');
    expect(shortlinkRedirectPath('/?p=abc')).toBeNull();
    expect(shortlinkRedirectPath('/?page_id=12')).toBeNull();
    expect(shortlinkRedirectPath('/x/?p=12')).toBeNull();
  });
});

describe('fallbackRedirectPath', () => {
  it.each([
    ['/product-category/barn/page/2', '/product-category/barn'],
    ['/produkt/x/feed', '/produkt/x'],
    ['/produkt/x/amp', '/produkt/x'],
    ['/produkt/x/embed', '/produkt/x'],
    ['/feed', '/'],
    ['/embed', '/'],
    ['/page/3', '/'],
  ])('%j → %j', (input, expected) => {
    expect(fallbackRedirectPath(input)).toBe(expected);
  });

  it.each(['/produkt/x', '/page/x', '/produkt/feeds', '/produkt/x/page'])(
    'no fallback for %j',
    (input) => {
      expect(fallbackRedirectPath(input)).toBeNull();
    },
  );
});

describe('sanitizeRedirectTarget', () => {
  it.each([
    ['/products/namnskylt', '/products/namnskylt'],
    ['/collections/barn?sort=new', '/collections/barn?sort=new'],
    ['  /  ', '/'],
    ['/products/Äpple', '/products/Äpple'],
  ])('accepts %j', (input, expected) => {
    expect(sanitizeRedirectTarget(input)).toBe(expected);
  });

  it.each([
    'products/x',
    '//evil.example/x',
    'https://evil.example/',
    'javascript:alert(1)',
    '/\\evil.example',
    '/%2F%2Fevil.example', // decodes to ///evil.example
    '/a b',
    '/a\nb',
    '/' + 'a'.repeat(1024),
  ])('rejects %j', (input) => {
    expect(sanitizeRedirectTarget(input)).toBeNull();
  });
});

describe('matchRedirect', () => {
  const map = new Map<string, string>([
    ['/produkt/namnskylt', '/products/namnskylt'],
    ['/product-category/barn', '/collections/barn'],
  ]);

  it('exact match after normalisation', () => {
    expect(matchRedirect(map, '/Produkt/Namnskylt/?ref=x')).toBe(
      '/products/namnskylt',
    );
  });

  it('retries once without /page/<n>, /feed or /amp', () => {
    expect(matchRedirect(map, '/product-category/barn/page/4/')).toBe(
      '/collections/barn',
    );
    expect(matchRedirect(map, '/produkt/namnskylt/amp')).toBe(
      '/products/namnskylt',
    );
  });

  it('no match and invalid paths answer null', () => {
    expect(matchRedirect(map, '/produkt/other')).toBeNull();
    expect(matchRedirect(map, 'produkt/namnskylt')).toBeNull();
    expect(matchRedirect(map, '/produkt/namnskylt/page/2/feed')).toBeNull();
  });
});
