import { BRAND_NAME_MAX, sanitizeBrandName, sanitizeThemeSeo } from './theme-seo';

// M166 F: the public `theme.seo.brandName` guard.
describe('sanitizeThemeSeo', () => {
  it('passes other seo keys through unchanged', () => {
    const seo = { metaTitle: 'T', metaDescription: 'D', extra: { a: 1 } };
    expect(sanitizeThemeSeo(seo)).toEqual(seo);
  });

  it('trims a valid brand name and keeps it', () => {
    expect(sanitizeThemeSeo({ metaTitle: 'T', brandName: '  Namez  ' })).toEqual({ metaTitle: 'T', brandName: 'Namez' });
  });

  it('drops non-string, empty and whitespace-only brand names', () => {
    for (const brandName of [42, null, {}, ['Namez'], '', '   ', '\n\t']) {
      expect(sanitizeThemeSeo({ metaTitle: 'T', brandName })).toEqual({ metaTitle: 'T' });
    }
  });

  it('removes control characters and caps the length', () => {
    expect(sanitizeBrandName('Na\u0000me\nZ\u200b')).toBe('Na me Z');
    const long = 'x'.repeat(500);
    expect(sanitizeBrandName(long)).toHaveLength(BRAND_NAME_MAX);
    // Code points, not UTF-16 units: an emoji is never cut in half.
    const emoji = '😀'.repeat(80);
    expect(Array.from(sanitizeBrandName(emoji)!)).toHaveLength(BRAND_NAME_MAX);
  });

  it('non-object input is an empty object (as before)', () => {
    expect(sanitizeThemeSeo(undefined)).toEqual({});
    expect(sanitizeThemeSeo('x')).toEqual({});
    expect(sanitizeThemeSeo([1])).toEqual({});
  });
});
