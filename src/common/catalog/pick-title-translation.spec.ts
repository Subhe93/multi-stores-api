import { pickTitleTranslation } from './pick-title-translation';

const rows = (...locales: string[]) =>
  locales.map((locale) => ({ locale, title: `t-${locale}` }));

describe('pickTitleTranslation', () => {
  it('returns undefined without rows', () => {
    expect(pickTitleTranslation([], 'de')).toBeUndefined();
    expect(pickTitleTranslation(null, 'de')).toBeUndefined();
  });

  it('exact locale wins', () => {
    expect(
      pickTitleTranslation(rows('sv', 'de', 'de-AT'), 'de-AT', 'sv')?.title,
    ).toBe('t-de-AT');
    expect(pickTitleTranslation(rows('sv', 'de'), 'de', 'sv')?.title).toBe(
      't-de',
    );
  });

  it('regional locale falls back to its base language', () => {
    expect(
      pickTitleTranslation(rows('sv', 'en', 'de'), 'de-AT', 'sv')?.title,
    ).toBe('t-de');
    expect(
      pickTitleTranslation(rows('sv', 'en', 'de'), 'de_at', 'sv')?.title,
    ).toBe('t-de');
  });

  it('a base locale matches a regional row', () => {
    expect(pickTitleTranslation(rows('sv', 'de-DE'), 'de', 'sv')?.title).toBe(
      't-de-DE',
    );
  });

  it('missing locale falls back to the store canonical language, not en', () => {
    expect(
      pickTitleTranslation(rows('en', 'sv', 'fr'), 'de', 'sv')?.title,
    ).toBe('t-sv');
  });

  it('then en, then the first row', () => {
    expect(pickTitleTranslation(rows('fr', 'en'), 'de', 'sv')?.title).toBe(
      't-en',
    );
    expect(pickTitleTranslation(rows('fr', 'it'), 'de', 'sv')?.title).toBe(
      't-fr',
    );
    expect(pickTitleTranslation(rows('fr', 'en'), undefined, null)?.title).toBe(
      't-en',
    );
  });

  it('compares case-insensitively', () => {
    expect(pickTitleTranslation(rows('sv', 'DE'), 'de', 'sv')?.title).toBe(
      't-DE',
    );
  });
});
