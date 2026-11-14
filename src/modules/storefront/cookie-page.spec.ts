import {
  COOKIE_POLICY_SLUGS,
  cookiePageWhere,
  resolveCookiePageSlug,
} from './cookie-page';

describe('resolveCookiePageSlug', () => {
  it('finds a v2 slug', () => {
    expect(resolveCookiePageSlug(['om-cookies'], [])).toBe('om-cookies');
  });

  it('falls back to a legacy slug', () => {
    expect(resolveCookiePageSlug([], ['om-oss', 'cookies'])).toBe('cookies');
  });

  it('prefers the list order, not the source order', () => {
    expect(resolveCookiePageSlug(['cookiepolicy'], ['om-cookies'])).toBe(
      'om-cookies',
    );
  });

  it('null for no match or empty slugs', () => {
    expect(resolveCookiePageSlug([null, 'kampanj'], ['om-oss'])).toBeNull();
    expect(resolveCookiePageSlug([], [])).toBeNull();
  });
});

describe('cookiePageWhere', () => {
  it('only published, visitor-facing pages under a cookie slug', () => {
    expect(cookiePageWhere('s1')).toEqual({
      store_id: 's1',
      type: { in: ['STATIC', 'LANDING'] },
      slug: { in: [...COOKIE_POLICY_SLUGS] },
      published_version_id: { not: null },
    });
  });

  it('keeps the slug list identical to the web storefront', () => {
    expect([...COOKIE_POLICY_SLUGS]).toEqual([
      'om-cookies',
      'cookies',
      'cookie-policy',
      'cookiepolicy',
    ]);
  });
});
