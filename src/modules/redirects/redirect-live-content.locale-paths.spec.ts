import { RedirectsService } from './redirects.service';
import { livePathCandidate } from './redirect-live-content';
import { PrismaService } from '../../prisma/prisma.service';

// M156: a merchant redirect from `/de-at/<live slug>` shadows live content
// exactly like `/de/<live slug>`; stores without language-country paths
// behave as before (and pay no extra query).

const EU_PATHS = [
  { path: 'de-de', locale: 'de', country: 'DE', hreflang: ['de-DE', 'de'] },
  { path: 'de-at', locale: 'de', country: 'AT', hreflang: ['de-AT'] },
  { path: 'nl-be', locale: 'nl', country: 'BE', hreflang: ['nl-BE'] },
  { path: 'ar', locale: 'ar', country: null, hreflang: ['ar'] },
];

describe('livePathCandidate extraPrefixes (M156)', () => {
  it('strips a language-country first segment when listed', () => {
    expect(livePathCandidate('/de-at/products/x', ['de-at'])).toEqual({
      kind: 'product',
      slug: 'x',
    });
    expect(livePathCandidate('/de-at/about', ['de-at'])).toEqual({
      kind: 'page',
      slug: 'about',
    });
    expect(livePathCandidate('/de-at/collections/a', ['de-at'])).toEqual({
      kind: 'collection',
      segments: ['a'],
    });
    // A bare segment is still a page slug, as `/de` is today.
    expect(livePathCandidate('/de-at', ['de-at'])).toEqual({
      kind: 'page',
      slug: 'de-at',
    });
  });

  it('regression: without extra prefixes the result is the pre-M156 one', () => {
    expect(livePathCandidate('/de-at/products/x')).toBeNull();
    expect(livePathCandidate('/de-at/about')).toBeNull();
    expect(livePathCandidate('/de/products/x')).toEqual(
      livePathCandidate('/de/products/x', []),
    );
    expect(livePathCandidate('/fr-be/products/x', ['de-at'])).toBeNull();
  });
});

describe('RedirectsService language-country segments (M156)', () => {
  function build(markets: unknown[]) {
    const prisma = {
      market: { findMany: jest.fn(() => Promise.resolve(markets)) },
      store: {
        findUnique: jest.fn(() =>
          Promise.resolve({ creator_id: 'c1', store_type: 'INDEPENDENT' }),
        ),
      },
      productTranslation: {
        findMany: jest.fn(() => Promise.resolve([{ slug: 'x' }])),
      },
      staticPage: { findMany: jest.fn(() => Promise.resolve([])) },
      page: { findMany: jest.fn(() => Promise.resolve([])) },
    };
    return {
      prisma,
      svc: new RedirectsService(prisma as unknown as PrismaService),
    };
  }
  const eu = {
    default_locale: 'en',
    locales: ['de', 'ar'],
    countries: ['DE', 'AT', 'BE'],
    locale_paths: EU_PATHS,
  };

  it('lists the active paths over all markets (inactive rows left out)', async () => {
    const { svc } = build([
      {
        default_locale: 'sv',
        locales: ['en'],
        countries: ['SE'],
        locale_paths: null,
      },
      eu,
    ]);
    expect(await svc.storeLocalePathSegments('s1')).toEqual([
      'de-de',
      'de-at',
      'ar',
    ]);
  });

  it('a live product under /de-at/ is detected', async () => {
    const { svc } = build([eu]);
    const live = await svc.liveContentAt('s1', ['/de-at/products/x']);
    expect(live.get('/de-at/products/x')).toBe('product');
  });

  it('an inactive path (/nl-be/) is not a locale prefix', async () => {
    const { svc } = build([eu]);
    const live = await svc.liveContentAt('s1', ['/nl-be/products/x']);
    expect(live.size).toBe(0);
  });

  it('regression: paths without a country-shaped segment never read markets', async () => {
    const { svc, prisma } = build([eu]);
    const live = await svc.liveContentAt('s1', ['/de/products/x', '/about']);
    expect(live.get('/de/products/x')).toBe('product');
    expect(prisma.market.findMany).not.toHaveBeenCalled();
  });

  it('regression: a store without locale_paths keeps /de-at/x unmatched', async () => {
    const { svc } = build([{ ...eu, locale_paths: null }]);
    const live = await svc.liveContentAt('s1', ['/de-at/products/x']);
    expect(live.size).toBe(0);
  });
});
