import {
  fallbackRedirectPath,
  matchRedirect,
  normalizeRedirectPath,
  sanitizeRedirectTarget,
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
});

describe('fallbackRedirectPath', () => {
  it.each([
    ['/product-category/barn/page/2', '/product-category/barn'],
    ['/produkt/x/feed', '/produkt/x'],
    ['/produkt/x/amp', '/produkt/x'],
    ['/feed', '/'],
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
