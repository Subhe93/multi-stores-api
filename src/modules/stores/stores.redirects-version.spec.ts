import { StoresService } from './stores.service';
import { MarketsPublicController } from '../markets/markets-public.controller';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RedirectsService } from '../redirects/redirects.service';
import type { MarketsContextService } from '../markets/markets-context.service';

// M4.4 D17: the proxy host lookups carry `redirects_version` only for stores
// with active redirects. Stores without any keep the exact previous answer.

function redirects(version: string | null) {
  return {
    versionFor: jest.fn(() => Promise.resolve(version)),
  } as unknown as RedirectsService & { versionFor: jest.Mock };
}

function storesService(version: string | null) {
  const prisma = {
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 's1', slug: 'legacy', is_active: true }),
      ),
    },
  };
  const marketsContext = { byHostname: jest.fn(() => Promise.resolve(null)) };
  const r = redirects(version);
  const service = new StoresService(
    prisma as unknown as PrismaService,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    marketsContext as unknown as MarketsContextService,
    r,
  );
  return { service, r };
}

describe('StoresService.findSlugByCustomDomain redirects_version', () => {
  it('no redirects: the answer is unchanged (no key)', async () => {
    const { service, r } = storesService(null);
    expect(await service.findSlugByCustomDomain('shop.legacy.com')).toEqual({
      slug: 'legacy',
    });
    expect(r.versionFor).toHaveBeenCalledWith('s1');
  });

  it('with redirects: adds the version', async () => {
    const { service } = storesService('3-abc');
    expect(await service.findSlugByCustomDomain('shop.legacy.com')).toEqual({
      slug: 'legacy',
      redirects_version: '3-abc',
    });
  });

  it('unknown host still 404s without asking for a version', async () => {
    const { service, r } = storesService('3-abc');
    (
      service as unknown as { prisma: { store: { findUnique: jest.Mock } } }
    ).prisma.store.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.findSlugByCustomDomain('nope.com'),
    ).rejects.toMatchObject({
      response: { code: 'STORE_NOT_FOUND' },
    });
    expect(r.versionFor).not.toHaveBeenCalled();
  });
});

describe('MarketsPublicController.marketContext redirects_version', () => {
  function ctrl(version: string | null, appOn: boolean) {
    const prisma = {
      store: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            id: 's1',
            is_active: true,
            custom_domain: 'resumely.net',
          }),
        ),
      },
    };
    const markets = {
      resolve: jest.fn(() =>
        Promise.resolve(
          appOn
            ? {
                id: 'm1',
                key: 'default',
                name: 'Default',
                countries: ['SE'],
                defaultLocale: 'sv',
                locales: [],
                currency: 'SEK',
                storeCurrency: 'SEK',
                rate: 1,
                priceRule: { mode: 'convert', source: 'manual', rate: 1 },
                isDefault: true,
                indexing: 'AUTO',
                status: 'LIVE',
                primaryHostname: null,
                hostnames: [],
              }
            : null,
        ),
      ),
      listLive: jest.fn(() => Promise.resolve([])),
    };
    return new MarketsPublicController(
      prisma as unknown as PrismaService,
      markets as unknown as MarketsContextService,
      redirects(version),
    );
  }

  it('app off, no redirects: exactly {enabled:false}', async () => {
    expect(await ctrl(null, false).marketContext('namez')).toEqual({
      enabled: false,
    });
  });

  it('app off with redirects: {enabled:false, redirects_version}', async () => {
    expect(await ctrl('1-x', false).marketContext('namez')).toEqual({
      enabled: false,
      redirects_version: '1-x',
    });
  });

  it('app on with redirects: the version rides along', async () => {
    const res = await ctrl('1-x', true).marketContext('namez');
    expect(res).toMatchObject({ enabled: true, redirects_version: '1-x' });
  });

  it('app on without redirects: no key', async () => {
    const res = await ctrl(null, true).marketContext('namez');
    expect(res.enabled).toBe(true);
    expect('redirects_version' in res).toBe(false);
  });

  it('app on: the legacy custom_domain rides along (M6.1); app off: not present', async () => {
    const on = await ctrl(null, true).marketContext('namez');
    expect(on).toMatchObject({ enabled: true, custom_domain: 'resumely.net' });
    const off = await ctrl(null, false).marketContext('namez');
    expect('custom_domain' in off).toBe(false);
  });
});
