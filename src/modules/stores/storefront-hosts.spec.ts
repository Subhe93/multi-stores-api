import {
  computeStorefrontHosts,
  loadPublicHost,
  type StorefrontDomainRow,
} from './storefront-hosts';
import { StoresService } from './stores.service';

// GET /stores/my/store public_host / storefront_hosts: the dashboard builds
// every storefront link from public_host, so a market store must link to its
// default market's primary domain, not a retired legacy custom_domain.

const row = (
  hostname: string,
  over: Partial<StorefrontDomainRow> = {},
  market: Partial<StorefrontDomainRow['market']> = {},
): StorefrontDomainRow => ({
  hostname,
  is_primary: false,
  redirect_to: null,
  status: 'ACTIVE',
  ...over,
  market: { is_default: true, status: 'LIVE', ...market },
});

describe('computeStorefrontHosts', () => {
  it('prefers the default market primary domain over custom_domain', () => {
    const res = computeStorefrontHosts(
      'resumely.net',
      [
        row('www.namez.se', { redirect_to: 'namez.se' }),
        row('namez.shop', { is_primary: true }, { is_default: false }),
        row('namez.se', { is_primary: true }),
      ],
      true,
    );
    expect(res.public_host).toBe('namez.se');
    expect(res.storefront_hosts.sort()).toEqual(
      ['namez.se', 'namez.shop', 'resumely.net', 'www.namez.se'].sort(),
    );
  });

  it('ignores inactive domains and draft markets', () => {
    const res = computeStorefrontHosts(
      'legacy.example',
      [
        row('pending.example', { is_primary: true, status: 'VERIFIED' }),
        row('draft.example', { is_primary: true }, { status: 'DRAFT' }),
      ],
      true,
    );
    expect(res.public_host).toBe('legacy.example');
    expect(res.storefront_hosts).toEqual(['legacy.example']);
  });

  it('falls back to the primary of any live market', () => {
    const res = computeStorefrontHosts(
      null,
      [row('namez.shop', { is_primary: true }, { is_default: false })],
      true,
    );
    expect(res.public_host).toBe('namez.shop');
  });

  it('uses the first non-redirect host when the default has no primary', () => {
    const res = computeStorefrontHosts(
      null,
      [row('www.a.se', { redirect_to: 'a.se' }), row('a.se')],
      true,
    );
    expect(res.public_host).toBe('a.se');
  });

  it('no markets: custom_domain, else null', () => {
    expect(computeStorefrontHosts('Shop.Example.com', [], true)).toEqual({
      public_host: 'shop.example.com',
      storefront_hosts: ['shop.example.com'],
    });
    expect(computeStorefrontHosts(null, [], false)).toEqual({
      public_host: null,
      storefront_hosts: [],
    });
  });

  it('markets app off: StoreDomain rows are not served', () => {
    const res = computeStorefrontHosts(
      'legacy.example',
      [row('namez.se', { is_primary: true })],
      false,
    );
    expect(res).toEqual({
      public_host: 'legacy.example',
      storefront_hosts: ['legacy.example'],
    });
  });
});

describe('StoresService.findByCreator storefront hosts', () => {
  function build(appOn: boolean, domains: StorefrontDomainRow[]) {
    const prisma = {
      creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
      store: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            id: 's1',
            slug: 'namez-se',
            custom_domain: 'resumely.net',
          }),
        ),
      },
      storeDomain: { findMany: jest.fn(() => Promise.resolve(domains)) },
    };
    const storeApps = { isEnabled: jest.fn(() => Promise.resolve(appOn)) };
    const service = new StoresService(
      prisma as never,
      {} as never,
      {} as never,
      storeApps as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, prisma };
  }

  it('adds public_host + storefront_hosts and keeps existing fields', async () => {
    const { service } = build(true, [row('namez.se', { is_primary: true })]);
    const res = await service.findByCreator('u1');
    expect(res).toMatchObject({
      slug: 'namez-se',
      custom_domain: 'resumely.net',
      public_host: 'namez.se',
      storefront_hosts: ['namez.se', 'resumely.net'],
    });
  });

  it('skips the domain query when the markets app is off', async () => {
    const { service, prisma } = build(false, []);
    const res = await service.findByCreator('u1');
    expect(prisma.storeDomain.findMany).not.toHaveBeenCalled();
    expect(res.public_host).toBe('resumely.net');
  });
});

describe('loadPublicHost (customer-facing links)', () => {
  const deps = (enabled: boolean, rows: StorefrontDomainRow[]) => ({
    prisma: { storeDomain: { findMany: jest.fn(() => Promise.resolve(rows)) } },
    storeApps: { isEnabled: jest.fn(() => Promise.resolve(enabled)) },
  });
  const store = { id: 's1', custom_domain: 'resumely.net' };

  it('keeps custom_domain with the markets app off', async () => {
    const d = deps(false, [row('namez.se', { is_primary: true })]);
    await expect(loadPublicHost(d as never, store)).resolves.toBe(
      'resumely.net',
    );
    expect(d.prisma.storeDomain.findMany).not.toHaveBeenCalled();
  });

  it('prefers the default market primary host with the app on', async () => {
    const d = deps(true, [row('namez.se', { is_primary: true })]);
    await expect(loadPublicHost(d as never, store)).resolves.toBe('namez.se');
  });

  it('is null with neither, and treats a missing StoreAppsService as off', async () => {
    const d = deps(true, []);
    await expect(
      loadPublicHost(d as never, { id: 's1', custom_domain: null }),
    ).resolves.toBeNull();
    await expect(
      loadPublicHost(
        { prisma: d.prisma as never, storeApps: undefined },
        store,
      ),
    ).resolves.toBe('resumely.net');
  });
});
