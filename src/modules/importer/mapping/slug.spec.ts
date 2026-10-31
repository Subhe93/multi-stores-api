import { platformSlug } from './slug';

// Imported WordPress slugs: decoded, then the same WP sanitize_title port as
// every API write, applied to WP's own encoded form so what WP kept is kept.

describe('platformSlug', () => {
  it.each([
    ['kl%c3%a4der', 'kläder'], // WP stores it encoded; the accent is kept
    ['KL%C3%84DER', 'kläder'],
    ['kla%cc%88der', 'kläder'], // NFD octets -> NFC
    ['%d9%87%d8%af%d9%8a%d8%a9-%d9%84%d8%a3%d9%85%d9%8a', 'هدية-لأمي'],
    ['3d_presenter', '3d_presenter'],
    ['present-till-svarfar', 'present-till-svarfar'],
    ['Two Words', 'two-words'],
    ['rabatt-50%ab', 'rabatt-50ab'], // invalid escape: the '%' goes
  ])('%s -> %s', (raw, out) => {
    expect(platformSlug(raw)).toBe(out);
  });

  it('uses the id fallback when nothing remains', () => {
    expect(platformSlug('!!!', 'product-42')).toBe('product-42');
    expect(platformSlug('')).toBe('');
  });
});
