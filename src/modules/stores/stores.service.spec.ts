import { StoresService } from './stores.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { OrdersService } from '../orders/orders.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsService } from '../markets/markets.service';
import { MarketsContextService } from '../markets/markets-context.service';
import type { MarketContext } from '../markets/market-context';
import type { RedirectsService } from '../redirects/redirects.service';

// findSlugByCustomDomain is what the storefront proxy calls for every
// custom host, so its legacy answer must not move for a store without the
// markets app, while a store with it on gets the market route (§3.2, D4).

const ctx = (
  key: string,
  over: Partial<MarketContext> = {},
): MarketContext => ({
  id: `m-${key}`,
  key,
  name: key,
  countries: ['SE'],
  defaultLocale: 'sv',
  locales: ['en'],
  currency: 'SEK',
  storeCurrency: 'SEK',
  rate: 1,
  priceRule: { mode: 'convert', source: 'manual', rate: 1 },
  isDefault: key === 'default',
  status: 'LIVE',
  noindex: false,
  primaryHostname: 'namez.se',
  hostnames: ['namez.se'],
  ...over,
});

function build(opts: {
  domainRow?: {
    status: 'PENDING' | 'VERIFIED' | 'ACTIVE';
    marketStatus?: 'DRAFT' | 'LIVE';
    marketKey?: string;
    redirect_to?: string | null;
    custom_domain?: string | null;
    is_active?: boolean;
  } | null;
  appOn?: boolean;
  legacyStore?: { slug: string; is_active: boolean } | null;
}) {
  const prisma = {
    store: {
      findUnique: jest.fn(() => Promise.resolve(opts.legacyStore ?? null)),
    },
  };
  const d = opts.domainRow;
  const marketsContext = {
    byHostname: jest.fn(() =>
      Promise.resolve(
        d
          ? {
              id: 'd1',
              store_id: 's1',
              hostname: 'namez.se',
              status: d.status,
              redirect_to: d.redirect_to ?? null,
              market: {
                key: d.marketKey ?? 'default',
                status: d.marketStatus ?? 'LIVE',
              },
              store: {
                slug: 'namez',
                is_active: d.is_active ?? true,
                custom_domain:
                  d.custom_domain === undefined ? 'namez.se' : d.custom_domain,
              },
            }
          : null,
      ),
    ),
    resolve: jest.fn((_storeId: string, key?: string) =>
      Promise.resolve(opts.appOn ? ctx(key ?? 'default') : null),
    ),
    listLive: jest.fn(() =>
      Promise.resolve(
        opts.appOn ? [{ key: 'default', is_default: true }] : null,
      ),
    ),
  };
  const service = new StoresService(
    prisma as unknown as PrismaService,
    {} as RevalidationService,
    {} as OrdersService,
    {} as StoreAppsService,
    {} as MarketsService,
    marketsContext as unknown as MarketsContextService,
    // M5 B18: the redirects service is required; no active redirects here.
    {
      versionFor: jest.fn(() => Promise.resolve(null)),
    } as unknown as RedirectsService,
  );
  return { service, prisma, marketsContext };
}

describe('StoresService.findSlugByCustomDomain', () => {
  it('app off, no StoreDomain row: the legacy custom_domain lookup, slug only', async () => {
    const { service, prisma } = build({
      domainRow: null,
      legacyStore: { slug: 'legacy', is_active: true },
    });
    expect(await service.findSlugByCustomDomain('Shop.Legacy.com:443')).toEqual(
      {
        slug: 'legacy',
      },
    );
    expect(prisma.store.findUnique).toHaveBeenCalledWith({
      where: { custom_domain: 'shop.legacy.com' },
      select: { id: true, slug: true, is_active: true },
    });
  });

  it('app off, migrated row equal to custom_domain: slug only (no market keys)', async () => {
    const { service } = build({
      domainRow: { status: 'ACTIVE' },
      appOn: false,
    });
    const res = await service.findSlugByCustomDomain('namez.se');
    expect(res).toEqual({ slug: 'namez' });
    expect('market' in res).toBe(false);
  });

  it('app off, row no longer matching custom_domain: falls through to the legacy lookup', async () => {
    const miss = build({
      domainRow: { status: 'ACTIVE', custom_domain: null },
      appOn: false,
    });
    await expect(
      miss.service.findSlugByCustomDomain('namez.se'),
    ).rejects.toMatchObject({
      response: { code: 'STORE_NOT_FOUND' },
    });
    expect(miss.prisma.store.findUnique).toHaveBeenCalledWith({
      where: { custom_domain: 'namez.se' },
      select: { id: true, slug: true, is_active: true },
    });
    // Another store still owning the host as its legacy custom_domain wins.
    const hit = build({
      domainRow: { status: 'ACTIVE', custom_domain: null },
      appOn: false,
      legacyStore: { slug: 'other', is_active: true },
    });
    expect(await hit.service.findSlugByCustomDomain('namez.se')).toEqual({
      slug: 'other',
    });
  });

  it('app on, ACTIVE row of a LIVE market: slug + market + markets', async () => {
    const { service } = build({
      domainRow: { status: 'ACTIVE', marketKey: 'se' },
      appOn: true,
    });
    const res = await service.findSlugByCustomDomain('namez.se');
    expect(res.slug).toBe('namez');
    expect(res.market).toMatchObject({
      key: 'se',
      currency: 'SEK',
      primary_hostname: 'namez.se',
      status: 'LIVE',
    });
    expect(res.markets).toHaveLength(1);
    expect('redirect_to' in res).toBe(false);
  });

  it('app on, PENDING/VERIFIED row or DRAFT market: not served by the market, legacy lookup decides', async () => {
    for (const domainRow of [
      { status: 'PENDING' as const },
      { status: 'VERIFIED' as const },
      { status: 'ACTIVE' as const, marketStatus: 'DRAFT' as const },
    ]) {
      const miss = build({ domainRow, appOn: true });
      await expect(
        miss.service.findSlugByCustomDomain('namez.se'),
      ).rejects.toMatchObject({
        response: { code: 'STORE_NOT_FOUND' },
      });
      const hit = build({
        domainRow,
        appOn: true,
        legacyStore: { slug: 'legacy', is_active: true },
      });
      const res = await hit.service.findSlugByCustomDomain('namez.se');
      expect(res).toEqual({ slug: 'legacy' });
      expect('market' in res).toBe(false);
    }
  });

  it('passes redirect_to through for a www host', async () => {
    const { service } = build({
      domainRow: { status: 'ACTIVE', redirect_to: 'namez.se' },
      appOn: true,
    });
    expect(
      (await service.findSlugByCustomDomain('www.namez.se')).redirect_to,
    ).toBe('namez.se');
  });

  it('an inactive store is 404 on both paths', async () => {
    const { service, marketsContext } = build({
      domainRow: { status: 'ACTIVE', is_active: false },
      appOn: true,
    });
    await expect(
      service.findSlugByCustomDomain('namez.se'),
    ).rejects.toMatchObject({
      response: { code: 'STORE_NOT_FOUND' },
    });
    expect(marketsContext.resolve).not.toHaveBeenCalled();
  });
});
