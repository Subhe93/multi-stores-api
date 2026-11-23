import { isUsableSlug, productLinkSlug } from './product-link-slug';

// Same fixture table as the web `productLinkSlug` spec
// (multi-stores-web/src/lib/productPaths.spec.ts, M163/M164).
const full = [
  { locale: 'sv', slug: 'studentskylt-med-guldtext' },
  { locale: 'en', slug: 'student-sign-with-gold-text' },
  { locale: 'de', slug: 'abschlussschild-mit-goldschrift' },
];
const noEn = [
  { locale: 'sv', slug: '3d-bokstav-med-namn' },
  { locale: 'de', slug: '3d-buchstabe-mit-namen' },
];
const degenerateDe = [
  { locale: 'sv', slug: 'tavla-med-namn' },
  { locale: 'en', slug: 'name-board' },
  { locale: 'de', slug: '-' },
];
const none = [
  { locale: 'sv', slug: '' },
  { locale: 'en', slug: null },
  { locale: 'de', slug: '--' },
];

describe('isUsableSlug', () => {
  it('needs a letter or digit in any script', () => {
    expect(isUsableSlug('a')).toBe(true);
    expect(isUsableSlug('هدية')).toBe(true);
    expect(isUsableSlug('3')).toBe(true);
    expect(isUsableSlug('-')).toBe(false);
    expect(isUsableSlug('')).toBe(false);
    expect(isUsableSlug(null)).toBe(false);
  });
});

describe('productLinkSlug (M164)', () => {
  it('own locale first', () => {
    expect(productLinkSlug(full, 'de', 'en')).toBe('abschlussschild-mit-goldschrift');
    expect(productLinkSlug(full, 'sv', 'en')).toBe('studentskylt-med-guldtext');
  });

  it('then the fallback locale', () => {
    expect(productLinkSlug(noEn, 'en', 'sv')).toBe('3d-bokstav-med-namn');
    expect(productLinkSlug(degenerateDe, 'de', 'en')).toBe('name-board');
    expect(productLinkSlug(degenerateDe, 'fr', 'sv')).toBe('tavla-med-namn');
  });

  it('then the first usable slug in locale order, whatever the row order', () => {
    expect(productLinkSlug(noEn, 'en', 'fr')).toBe('3d-buchstabe-mit-namen');
    expect(productLinkSlug([...noEn].reverse(), 'en', 'fr')).toBe('3d-buchstabe-mit-namen');
    expect(productLinkSlug(noEn, 'en', null)).toBe('3d-buchstabe-mit-namen');
  });

  it('a fallback list is tried in order (market default, then primary)', () => {
    expect(productLinkSlug(noEn, 'en', ['fr', 'sv'])).toBe('3d-bokstav-med-namn');
    expect(productLinkSlug(noEn, 'en', [null, 'de'])).toBe('3d-buchstabe-mit-namen');
  });

  it('null when nothing is usable', () => {
    expect(productLinkSlug(none, 'sv', 'en')).toBeNull();
    expect(productLinkSlug([], 'sv', 'en')).toBeNull();
    expect(productLinkSlug(null, 'sv', 'en')).toBeNull();
  });
});
