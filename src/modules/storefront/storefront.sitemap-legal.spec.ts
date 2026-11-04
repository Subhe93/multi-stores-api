import { StoreType } from '@prisma/client';
import { StorefrontService } from './storefront.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import type { MarketPricingService } from '../markets/market-pricing.service';
import type { TaxService } from '../taxes/tax.service';

// Store legal pages (plans/store-legal-pages/SPEC.md): an INDEPENDENT store's
// sitemap lists all four /legal/{slug} URLs with a non-null lastmod (the web
// sitemap needs a date): the own page's date, else the store's updated_at for
// template-backed slugs. Legal-kind pages are not listed again under /{slug}.

const STORE_UPDATED = new Date('2026-10-20T00:00:00Z');
const PAGE_PUBLISHED = new Date('2026-11-02T00:00:00Z');

function build(storeType: StoreType) {
  const privacy = {
    id: 'p1',
    type: 'STATIC',
    slug: 'privacy-policy',
    static_kind: 'PRIVACY_POLICY',
    published_version_id: 'v1',
    updated_at: new Date('2026-11-01T00:00:00Z'),
    translations: [{ locale: 'sv', title: 'Integritetspolicy' }],
    published_version: { published_at: PAGE_PUBLISHED },
  };
  const about = {
    id: 'p2',
    type: 'STATIC',
    slug: 'om-oss',
    static_kind: null,
    published_version_id: 'v2',
    updated_at: new Date('2026-09-01T00:00:00Z'),
    translations: [],
    published_version: { published_at: new Date('2026-09-01T00:00:00Z') },
  };
  const prisma = {
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 's1',
          slug: 'anna',
          status: 'LIVE',
          store_type: storeType,
          updated_at: STORE_UPDATED,
          creator: { id: 'c1' },
          language_config: { primary_locale: 'sv', secondary_locales: [] },
        }),
      ),
    },
    creatorCategory: { findMany: jest.fn(() => Promise.resolve([])) },
    product: { findMany: jest.fn(() => Promise.resolve([])) },
    customProduct: { findMany: jest.fn(() => Promise.resolve([])) },
    // Both the sitemap page query and the legal loader read here; the
    // legal loader filters by static_kind, so it only gets the legal row.
    page: {
      findMany: jest.fn((args: { where: { static_kind?: unknown } }) =>
        Promise.resolve(args.where.static_kind ? [privacy] : [privacy, about]),
      ),
    },
    staticPage: { findMany: jest.fn(() => Promise.resolve([])) },
    legalPage: {
      findMany: jest.fn(() =>
        Promise.resolve([
          { slug: 'privacy', updated_at: new Date(0) },
          { slug: 'terms', updated_at: new Date(0) },
        ]),
      ),
    },
    $queryRaw: jest.fn(() =>
      Promise.resolve([
        {
          id: 'v1',
          section_count: 1,
          titles: [{ locale: 'sv', title: 'Integritetspolicy' }],
        },
      ]),
    ),
  };
  const markets = { resolve: jest.fn(() => Promise.resolve(null)) };
  const service = new StorefrontService(
    prisma as unknown as PrismaService,
    {} as StoreAppsService,
    markets as unknown as MarketsContextService,
    {} as MarketPricingService,
    {} as TaxService,
  );
  return { service, prisma };
}

describe('StorefrontService.getSitemapData legal pages', () => {
  it('INDEPENDENT: 4 slugs, own page date or the store date (never null)', async () => {
    const { service } = build(StoreType.INDEPENDENT);
    const data = await service.getSitemapData('anna');
    expect(data.legal_pages).toEqual([
      { slug: 'privacy', lastmod: PAGE_PUBLISHED },
      { slug: 'terms', lastmod: STORE_UPDATED },
      { slug: 'refund', lastmod: STORE_UPDATED },
      { slug: 'shipping', lastmod: STORE_UPDATED },
    ]);
    for (const p of data.legal_pages) expect(p.lastmod).toBeInstanceOf(Date);
    // The legal-kind page is served at /legal/privacy, not again at /{slug}.
    const staticSlugs = (data.static_pages as { slug: string }[]).map(
      (p) => p.slug,
    );
    expect(staticSlugs).toEqual(['om-oss']);
  });

  it('MARKETPLACE: the platform legal pages, unchanged', async () => {
    const { service, prisma } = build(StoreType.MARKETPLACE);
    const data = await service.getSitemapData('anna');
    expect(data.legal_pages).toEqual([
      { slug: 'privacy', lastmod: new Date(0) },
      { slug: 'terms', lastmod: new Date(0) },
    ]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
