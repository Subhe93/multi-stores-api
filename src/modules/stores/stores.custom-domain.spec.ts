import { StoresService } from './stores.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { OrdersService } from '../orders/orders.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsService } from '../markets/markets.service';
import { MarketsContextService } from '../markets/markets-context.service';
import type { RedirectsService } from '../redirects/redirects.service';
import { CorsOriginService } from '../../common/cors/cors-origin.service';

// Removing a store's legacy external domain (DELETE /stores/my/store/custom-domain
// and the admin variant), plus clearing it through PUT with null / ''.

function build(opts: {
  customDomain?: string | null;
  appOn?: boolean;
  marketRowActive?: boolean;
}) {
  const current = {
    id: 's1',
    slug: 'namez',
    store_type: 'INDEPENDENT',
    custom_domain:
      opts.customDomain === undefined ? 'resumely.net' : opts.customDomain,
  };
  const prisma = {
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    store: {
      findFirst: jest.fn((args: { where: Record<string, unknown> }) =>
        // The removeCustomDomain lookup is by creator; conflict checks miss.
        Promise.resolve('creator' in args.where ? current : null),
      ),
      findUnique: jest.fn(() => Promise.resolve(current)),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...current, ...args.data }),
      ),
    },
    storeDomain: {
      deleteMany: jest.fn(() => Promise.resolve({ count: 1 })),
      findFirst: jest.fn(() =>
        Promise.resolve(opts.marketRowActive ? { id: 'd1' } : null),
      ),
      findMany: jest.fn(() => Promise.resolve([])),
    },
  };
  const revalidation = {
    revalidateStoreBySlug: jest.fn(() => Promise.resolve()),
  };
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(Boolean(opts.appOn))),
  };
  const marketsContext = { invalidate: jest.fn() };
  const cors = { forget: jest.fn() };
  const service = new StoresService(
    prisma as unknown as PrismaService,
    revalidation as unknown as RevalidationService,
    {} as OrdersService,
    storeApps as unknown as StoreAppsService,
    {} as MarketsService,
    marketsContext as unknown as MarketsContextService,
    {
      versionFor: jest.fn(() => Promise.resolve(null)),
    } as unknown as RedirectsService,
    cors as unknown as CorsOriginService,
  );
  return { service, prisma, revalidation, marketsContext, cors };
}

describe('StoresService.removeCustomDomain', () => {
  it('clears the column and drops every cache that depends on it (app off)', async () => {
    const { service, prisma, revalidation, marketsContext, cors } = build({});
    const res = await service.removeCustomDomain('u1');

    expect(prisma.store.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { custom_domain: null },
    });
    // The inert mirror row from the markets backfill goes with it.
    expect(prisma.storeDomain.deleteMany).toHaveBeenCalledWith({
      where: { store_id: 's1', hostname: 'resumely.net' },
    });
    // Column update and row delete commit together.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(cors.forget).toHaveBeenCalledWith('resumely.net');
    expect(marketsContext.invalidate).toHaveBeenCalledWith('s1');
    expect(revalidation.revalidateStoreBySlug).toHaveBeenCalledWith('namez');
    expect(res).toMatchObject({
      removed: true,
      removed_domain: 'resumely.net',
      custom_domain: null,
      still_served_by_market: false,
      public_host: null,
      storefront_hosts: [],
    });
  });

  it('is allowed with the markets app on and leaves market rows alone', async () => {
    const { service, prisma, cors } = build({
      appOn: true,
      marketRowActive: true,
    });
    const res = await service.removeCustomDomain('u1');
    expect(prisma.store.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { custom_domain: null },
    });
    expect(prisma.storeDomain.deleteMany).not.toHaveBeenCalled();
    expect(cors.forget).toHaveBeenCalledWith('resumely.net');
    expect(res.still_served_by_market).toBe(true);
  });

  it('is idempotent when the store has no domain', async () => {
    const { service, prisma, revalidation } = build({ customDomain: null });
    const res = await service.removeCustomDomain('u1');
    expect(prisma.store.update).not.toHaveBeenCalled();
    expect(revalidation.revalidateStoreBySlug).not.toHaveBeenCalled();
    expect(res).toMatchObject({ removed: false, removed_domain: null });
  });

  it('404s when the creator has no store', async () => {
    const { service, prisma } = build({});
    prisma.store.findFirst.mockResolvedValueOnce(null as never);
    await expect(service.removeCustomDomain('u1')).rejects.toMatchObject({
      response: { code: 'STORE_NOT_FOUND' },
    });
  });

  it('admin variant clears by creator id', async () => {
    const { service, prisma, cors } = build({});
    const res = await service.adminRemoveCustomDomain('c1');
    expect(prisma.store.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { creator_id: 'c1' } }),
    );
    expect(prisma.store.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { custom_domain: null },
    });
    expect(cors.forget).toHaveBeenCalledWith('resumely.net');
    expect(res.removed).toBe(true);
  });
});

describe('StoresService.update clearing custom_domain', () => {
  it.each([[null], ['']])(
    'custom_domain %p is stored as NULL and caches are dropped',
    async (value) => {
      const { service, prisma, cors, marketsContext } = build({});
      await service.update('u1', {
        custom_domain: value as unknown as string,
      });
      expect(prisma.store.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { custom_domain: null } }),
      );
      expect(prisma.storeDomain.deleteMany).toHaveBeenCalledWith({
        where: { store_id: 's1', hostname: 'resumely.net' },
      });
      expect(cors.forget).toHaveBeenCalledWith('resumely.net');
      expect(marketsContext.invalidate).toHaveBeenCalledWith('s1');
    },
  );

  it('replacing the domain drops the old mirror row and both CORS answers', async () => {
    const { service, prisma, cors } = build({});
    await service.update('u1', { custom_domain: 'shop.namez.se' });
    expect(prisma.storeDomain.deleteMany).toHaveBeenCalledWith({
      where: { store_id: 's1', hostname: 'resumely.net' },
    });
    expect(cors.forget).toHaveBeenCalledWith('resumely.net');
    expect(cors.forget).toHaveBeenCalledWith('shop.namez.se');
  });

  it('a cache failure does not fail the request', async () => {
    const { service, cors } = build({});
    cors.forget.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(service.removeCustomDomain('u1')).resolves.toMatchObject({
      removed: true,
    });
  });

  it('an update that does not mention the domain has no domain side effects', async () => {
    const { service, prisma, cors } = build({});
    await service.update('u1', { name: 'Namez' });
    expect(prisma.storeDomain.deleteMany).not.toHaveBeenCalled();
    expect(cors.forget).not.toHaveBeenCalled();
  });

  it('re-saving the same domain keeps its mirror row', async () => {
    const { service, prisma, cors } = build({});
    await service.update('u1', { custom_domain: 'Resumely.net' });
    expect(prisma.storeDomain.deleteMany).not.toHaveBeenCalled();
    expect(cors.forget).not.toHaveBeenCalled();
  });

  it('PUT still refuses the field while the markets app is on', async () => {
    const { service } = build({ appOn: true });
    await expect(
      service.update('u1', { custom_domain: '' }),
    ).rejects.toMatchObject({
      response: { code: 'STORE_CUSTOM_DOMAIN_MANAGED_BY_MARKETS' },
    });
  });
});

describe('CorsOriginService.forget', () => {
  it('drops the cached answer for the host and its www twin', async () => {
    const prisma = {
      store: { findFirst: jest.fn(() => Promise.resolve({ id: 's1' })) },
    };
    const cors = new CorsOriginService(prisma as unknown as PrismaService);
    expect(await cors.isStoreOrigin('https://resumely.net')).toBe(true);
    expect(await cors.isStoreOrigin('https://www.resumely.net')).toBe(true);
    expect(prisma.store.findFirst).toHaveBeenCalledTimes(2);

    prisma.store.findFirst.mockResolvedValue(null as never);
    cors.forget('www.resumely.net');
    expect(await cors.isStoreOrigin('https://resumely.net')).toBe(false);
    expect(await cors.isStoreOrigin('https://www.resumely.net')).toBe(false);
  });
});
