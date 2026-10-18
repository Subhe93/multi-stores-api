import 'reflect-metadata';
import { StoreType, UserRole } from '@prisma/client';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { StoreAppsController } from './store-apps.controller';
import { StoreAppsService } from './store-apps.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';

// GET /stores/admin/apps — the admin overview of every store with its apps.
// Prisma is mocked: the tests check the queries the service sends (filters,
// paging, a single batched StoreApp read) and how rows are merged with the
// registry defaults.

type StoreRow = {
  id: string;
  name: string;
  slug: string;
  store_type: StoreType;
  creator_id: string;
  creator: { display_name: string };
};

const STORES: StoreRow[] = [
  {
    id: 's1',
    name: 'Alpha',
    slug: 'alpha',
    store_type: StoreType.INDEPENDENT,
    creator_id: 'c1',
    creator: { display_name: 'Ann' },
  },
  {
    id: 's2',
    name: 'Beta',
    slug: 'beta',
    store_type: StoreType.MARKETPLACE,
    creator_id: 'c2',
    creator: { display_name: 'Bob' },
  },
];

const APP_ROWS = [
  {
    store_id: 's1',
    app_key: 'markets',
    available: true,
    enabled: true,
    settings: {},
    enabled_at: null,
  },
  {
    store_id: 's1',
    app_key: 'b2b',
    available: true,
    enabled: false,
    settings: {},
    enabled_at: null,
  },
];

function build(stores: StoreRow[] = STORES, total = stores.length) {
  const prisma = {
    store: {
      findMany: jest.fn(() => Promise.resolve(stores)),
      count: jest.fn(() => Promise.resolve(total)),
    },
    storeApp: {
      findMany: jest.fn(() => Promise.resolve(APP_ROWS)),
    },
  };
  const service = new StoreAppsService(
    prisma as unknown as PrismaService,
    { revalidateStoreById: jest.fn() } as unknown as RevalidationService,
  );
  return { prisma, service };
}

describe('StoreAppsService.adminOverview', () => {
  it('merges every registry app per store with defaults for missing rows', async () => {
    const { service } = build();
    const result = await service.adminOverview({});
    expect(result).toMatchObject({ total: 2, page: 1, limit: 20 });
    expect(result.items).toHaveLength(2);

    const [alpha, beta] = result.items;
    expect(alpha).toMatchObject({
      store_id: 's1',
      store_name: 'Alpha',
      store_slug: 'alpha',
      store_type: StoreType.INDEPENDENT,
      creator_id: 'c1',
      creator_name: 'Ann',
    });
    expect(alpha.apps.map((a) => a.key)).toEqual([
      'markets',
      'b2b',
      'invoices',
      'importer',
      'personalization',
      'production',
      'designer',
      'feeds',
    ]);
    expect(alpha.apps[0]).toMatchObject({
      key: 'markets',
      available: true,
      enabled: true,
      requires_independent: true,
    });
    expect(alpha.apps[1]).toMatchObject({
      key: 'b2b',
      available: true,
      enabled: false,
      requires_independent: false,
    });
    expect(alpha.apps[3]).toMatchObject({
      key: 'importer',
      available: false,
      enabled: false,
      depends_on: ['markets'],
    });
    // A store without rows gets the defaults for every app.
    expect(beta.apps).toHaveLength(8);
    for (const app of beta.apps) {
      expect(app).toMatchObject({ available: false, enabled: false });
    }
  });

  it('reads the app rows of the whole page in one query (no N+1)', async () => {
    const { service, prisma } = build();
    await service.adminOverview({});
    expect(prisma.storeApp.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.storeApp.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { store_id: { in: ['s1', 's2'] } },
      }),
    );
  });

  it('skips the app query when the page is empty', async () => {
    const { service, prisma } = build([], 0);
    const result = await service.adminOverview({ page: 3 });
    expect(result).toEqual({ items: [], total: 0, page: 3, limit: 20 });
    expect(prisma.storeApp.findMany).not.toHaveBeenCalled();
  });

  it('pages with skip/take and reports the total', async () => {
    const { service, prisma } = build(STORES, 42);
    const result = await service.adminOverview({ page: 3, limit: 10 });
    expect(result).toMatchObject({ total: 42, page: 3, limit: 10 });
    expect(prisma.store.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 }),
    );
  });

  it('filters by store type and searches name, slug and creator name', async () => {
    const { service, prisma } = build();
    await service.adminOverview({
      q: '  ann ',
      type: StoreType.MARKETPLACE,
    });
    const contains = { contains: 'ann', mode: 'insensitive' };
    const where = {
      store_type: StoreType.MARKETPLACE,
      OR: [
        { name: contains },
        { slug: contains },
        { creator: { display_name: contains } },
      ],
    };
    expect(prisma.store.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where }),
    );
    expect(prisma.store.count).toHaveBeenCalledWith({ where });
  });

  it('sends no filter when q is blank and type is absent', async () => {
    const { service, prisma } = build();
    await service.adminOverview({ q: '   ' });
    expect(prisma.store.count).toHaveBeenCalledWith({ where: {} });
  });
});

describe('StoreAppsController GET admin/apps', () => {
  it('is restricted to ADMIN', () => {
    const handler = Object.getOwnPropertyDescriptor(
      StoreAppsController.prototype,
      'adminOverview',
    )?.value as object;
    const roles: unknown = Reflect.getMetadata(ROLES_KEY, handler);
    expect(roles).toEqual([UserRole.ADMIN]);
  });
});
