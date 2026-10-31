import { UserRole } from '@prisma/client';
import { AccountLinksService, safeLocale } from './account-links.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ConfigService } from '@nestjs/config';
import type { StoreAppsService } from '../store-apps/store-apps.service';

function build(opts: {
  store?: Record<string, unknown> | null;
  marketsEnabled?: boolean;
  domain?: Record<string, unknown> | null;
  domains?: Record<string, unknown>[];
  env?: Record<string, string>;
}) {
  const prisma = {
    store: { findUnique: jest.fn(() => Promise.resolve(opts.store ?? null)) },
    storeDomain: {
      findFirst: jest.fn(() => Promise.resolve(opts.domain ?? null)),
      findMany: jest.fn(() => Promise.resolve(opts.domains ?? [])),
    },
  };
  const env: Record<string, string | undefined> = {
    STOREFRONT_URL: 'https://stores.example.com',
    DASHBOARD_URL: 'https://dash.example.com/',
    ...opts.env,
  };
  const config = { get: jest.fn((k: string) => env[k]) };
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(opts.marketsEnabled === true)),
  };
  const service = new AccountLinksService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    storeApps as unknown as StoreAppsService,
  );
  return { service, prisma, storeApps };
}

const store = {
  id: 's1',
  slug: 'namez',
  name: 'Namez',
  custom_domain: null,
  is_active: true,
  language_config: { primary_locale: 'sv' },
};

describe('AccountLinksService', () => {
  it('resolves the slug subdomain of a store without a custom domain', async () => {
    const { service } = build({ store });
    await expect(service.resolveStore('namez')).resolves.toEqual({
      id: 's1',
      slug: 'namez',
      name: 'Namez',
      primaryLocale: 'sv',
      isActive: true,
      base: 'https://namez.stores.example.com',
    });
  });

  it('prefers the custom domain', async () => {
    const { service } = build({
      store: { ...store, custom_domain: 'namez.se' },
    });
    const ctx = await service.resolveStore('namez');
    expect(ctx?.base).toBe('https://namez.se');
  });

  it('falls back to the default market primary host over a retired custom domain', async () => {
    const { service } = build({
      store: { ...store, custom_domain: 'resumely.net' },
      marketsEnabled: true,
      domains: [
        {
          hostname: 'namez.se',
          is_primary: true,
          redirect_to: null,
          status: 'ACTIVE',
          market: { is_default: true, status: 'LIVE' },
        },
      ],
    });
    expect((await service.resolveStore('namez'))?.base).toBe(
      'https://namez.se',
    );
    // An unknown request host also falls back to the public host.
    expect((await service.resolveStore('namez', 'evil.com'))?.base).toBe(
      'https://namez.se',
    );
  });

  it('keeps the custom domain when the markets app is off', async () => {
    const { service, prisma } = build({
      store: { ...store, custom_domain: 'resumely.net' },
      marketsEnabled: false,
    });
    expect((await service.resolveStore('namez'))?.base).toBe(
      'https://resumely.net',
    );
    expect(prisma.storeDomain.findMany).not.toHaveBeenCalled();
  });

  it('honours a market hostname only when it is an ACTIVE domain of the store', async () => {
    const ok = build({
      store: { ...store, custom_domain: 'namez.se' },
      marketsEnabled: true,
      domain: { id: 'd1' },
    });
    expect(
      (await ok.service.resolveStore('namez', 'Namez.SHOP:443'))?.base,
    ).toBe('https://namez.shop');
    expect(ok.prisma.storeDomain.findFirst).toHaveBeenCalledWith({
      where: { store_id: 's1', hostname: 'namez.shop', status: 'ACTIVE' },
      select: { id: true },
    });

    const foreign = build({
      store: { ...store, custom_domain: 'namez.se' },
      marketsEnabled: true,
      domain: null,
    });
    expect(
      (await foreign.service.resolveStore('namez', 'evil.com'))?.base,
    ).toBe('https://namez.se');

    const off = build({ store, marketsEnabled: false, domain: { id: 'd1' } });
    expect((await off.service.resolveStore('namez', 'namez.shop'))?.base).toBe(
      'https://namez.stores.example.com',
    );
  });

  it('gives no base for an inactive store and null for an unknown one', async () => {
    const { service } = build({ store: { ...store, is_active: false } });
    expect((await service.resolveStore('namez'))?.base).toBeNull();
    const none = build({ store: null });
    await expect(none.service.resolveStore('nope')).resolves.toBeNull();
    await expect(none.service.resolveStore(undefined)).resolves.toBeNull();
  });

  it('builds customer links on the store origin', () => {
    const { service } = build({});
    expect(
      service.accountLinks('tok_-1', {
        role: UserRole.CUSTOMER,
        storeBase: 'https://namez.se/',
        locale: 'sv',
      }),
    ).toEqual({
      magicUrl: 'https://namez.se/auth/magic#token=tok_-1',
      loginUrl: 'https://namez.se/auth/login',
    });
  });

  it('builds customer links on the platform [locale] tree without a store', () => {
    const { service } = build({});
    expect(
      service.accountLinks('tok', { role: UserRole.CUSTOMER, locale: 'ar' }),
    ).toEqual({
      magicUrl: 'https://stores.example.com/ar/auth/magic#token=tok',
      loginUrl: 'https://stores.example.com/ar/auth/login',
    });
    expect(
      service.accountLinks('tok', {
        role: UserRole.CUSTOMER,
        locale: '../evil',
      }).loginUrl,
    ).toBe('https://stores.example.com/en/auth/login');
  });

  it.each([UserRole.CREATOR, UserRole.PROVIDER, UserRole.ADMIN])(
    'sends %s to the dashboard',
    (role) => {
      const { service } = build({});
      expect(
        service.accountLinks('tok', {
          role,
          storeBase: 'https://namez.se',
        }),
      ).toEqual({
        magicUrl: 'https://dash.example.com/auth/magic#token=tok',
        loginUrl: 'https://dash.example.com/auth/login',
      });
    },
  );

  it('falls back to the local dashboard URL', () => {
    const { service } = build({ env: { DASHBOARD_URL: '' } });
    expect(service.dashboardUrl()).toBe('http://localhost:3002');
  });

  it('safeLocale accepts only supported locales', () => {
    expect(safeLocale('SV')).toBe('sv');
    expect(safeLocale('xx')).toBe('en');
    expect(safeLocale(null)).toBe('en');
  });
});
