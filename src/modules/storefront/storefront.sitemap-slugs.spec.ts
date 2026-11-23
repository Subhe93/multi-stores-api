import { StoreType } from '@prisma/client';
import { StorefrontService } from './storefront.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import type { MarketPricingService } from '../markets/market-pricing.service';
import type { TaxService } from '../taxes/tax.service';

// M161 A: with a market, the sitemap product row carries the slug of EVERY
// translation (alternates point at the locales of other markets too), not
// only the requested market's locales. M165: `id` and `slugs` are sent with
// and without a market (product link references).

const UPDATED = new Date('2026-11-01T00:00:00Z');

function build(market: unknown) {
  const product = {
    id: 'p1',
    updated_at: UPDATED,
    translations: [
      { locale: 'sv', slug: 'studentskylt-med-guldtext' },
      { locale: 'en', slug: 'student-sign-with-gold-text' },
      { locale: 'de', slug: 'abschlussschild-mit-goldschrift' },
      { locale: 'fr', slug: '' },
    ],
  };
  const prisma = {
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 's1',
          slug: 'namez-se',
          status: 'LIVE',
          store_type: StoreType.INDEPENDENT,
          updated_at: UPDATED,
          creator: { id: 'c1' },
          language_config: { primary_locale: 'sv', secondary_locales: ['en'] },
        }),
      ),
    },
    productMarketPrice: { findMany: jest.fn(() => Promise.resolve([])) },
    creatorCategory: { findMany: jest.fn(() => Promise.resolve([])) },
    product: { findMany: jest.fn(() => Promise.resolve([product])) },
    customProduct: { findMany: jest.fn(() => Promise.resolve([])) },
    page: { findMany: jest.fn(() => Promise.resolve([])) },
    staticPage: { findMany: jest.fn(() => Promise.resolve([])) },
    legalPage: { findMany: jest.fn(() => Promise.resolve([])) },
    $queryRaw: jest.fn(() => Promise.resolve([])),
  };
  const markets = {
    resolve: jest.fn(() => Promise.resolve(market)),
    listLive: jest.fn(() => Promise.resolve([])),
  };
  const service = new StorefrontService(
    prisma as unknown as PrismaService,
    {} as StoreAppsService,
    markets as unknown as MarketsContextService,
    {} as MarketPricingService,
    {} as TaxService,
  );
  return { service, prisma };
}

describe('StorefrontService.getSitemapData product slugs (M161 A)', () => {
  it('market eu (en + de): includes the sv slug of the other market', async () => {
    const { service } = build({
      id: 'm-eu',
      key: 'eu',
      countries: ['DE', 'AT'],
      defaultLocale: 'en',
      locales: ['de'],
    });
    const data = await service.getSitemapData('namez-se', 'eu');
    const [row] = data.products as {
      slug: string;
      slugs?: Record<string, string>;
    }[];
    expect(row.slug).toBe('student-sign-with-gold-text');
    expect(row.slugs).toEqual({
      sv: 'studentskylt-med-guldtext',
      en: 'student-sign-with-gold-text',
      de: 'abschlussschild-mit-goldschrift',
    });
  });

  it('market default (sv only): includes the en and de slugs', async () => {
    const { service } = build({
      id: 'm-se',
      key: 'default',
      countries: ['SE'],
      defaultLocale: 'sv',
      locales: [],
    });
    const data = await service.getSitemapData('namez-se', 'default');
    const [row] = data.products as { slugs?: Record<string, string> }[];
    expect(Object.keys(row.slugs ?? {}).sort()).toEqual(['de', 'en', 'sv']);
  });

  it('no market (M165): id and slugs on every product', async () => {
    const { service } = build(null);
    const data = await service.getSitemapData('namez-se');
    const [row] = data.products as Record<string, unknown>[];
    expect(row).toEqual({
      id: 'p1',
      slug: 'studentskylt-med-guldtext',
      slugs: {
        sv: 'studentskylt-med-guldtext',
        en: 'student-sign-with-gold-text',
        de: 'abschlussschild-mit-goldschrift',
      },
      lastmod: UPDATED,
    });
  });

  it('market (M165): id on every product, hidden products still left out', async () => {
    const { service, prisma } = build({
      id: 'm-eu',
      key: 'eu',
      countries: ['DE'],
      defaultLocale: 'en',
      locales: [],
    });
    const data = await service.getSitemapData('namez-se', 'eu');
    expect((data.products[0] as { id: string }).id).toBe('p1');
    prisma.productMarketPrice.findMany.mockImplementation(
      () => Promise.resolve([{ product_id: 'p1' }]) as never,
    );
    const hidden = await service.getSitemapData('namez-se', 'eu');
    expect(hidden.products).toEqual([]);
  });
});
