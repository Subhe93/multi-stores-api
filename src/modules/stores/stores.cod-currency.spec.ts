import { StoresService } from './stores.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { OrdersService } from '../orders/orders.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsService } from '../markets/markets.service';
import { MarketsContextService } from '../markets/markets-context.service';
import type { RedirectsService } from '../redirects/redirects.service';

// Cash on delivery is an INDEPENDENT-store setting (cod-policy.ts): the API
// refuses to switch it on for a MARKETPLACE store, an admin type switch to
// MARKETPLACE writes it off, and every owner payload carries the effective
// flag. The same payloads carry `effective_currency`, the currency the
// store's orders are really priced in.

type Row = {
  id: string;
  slug: string;
  store_type: 'MARKETPLACE' | 'INDEPENDENT';
  currency: string | null;
  cod_enabled: boolean;
  custom_domain: string | null;
  checkout_settings: null;
};

function build(
  row: Partial<Row>,
  platformCurrency: string | null | undefined = 'EUR',
) {
  const stored: Row = {
    id: 's1',
    slug: 'shop',
    store_type: 'MARKETPLACE',
    currency: null,
    cod_enabled: false,
    custom_domain: null,
    checkout_settings: null,
    ...row,
  };
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    store: {
      findUnique: jest.fn(() => Promise.resolve({ ...stored })),
      findFirst: jest.fn(() => Promise.resolve(null)),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...stored, ...args.data }),
      ),
    },
    order: { findMany: jest.fn(() => Promise.resolve([])) },
    platformConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve(
          platformCurrency === undefined
            ? null
            : { default_currency: platformCurrency },
        ),
      ),
    },
  };
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(false)),
    onStoreTypeChanged: jest.fn(() => Promise.resolve()),
  };
  const service = new StoresService(
    prisma as unknown as PrismaService,
    {
      revalidateStoreBySlug: jest.fn(() => Promise.resolve()),
    } as unknown as RevalidationService,
    {} as OrdersService,
    storeApps as unknown as StoreAppsService,
    {} as MarketsService,
    { invalidate: jest.fn() } as unknown as MarketsContextService,
    {
      versionFor: jest.fn(() => Promise.resolve(null)),
    } as unknown as RedirectsService,
  );
  return { service, prisma };
}

const writtenData = (prisma: {
  store: { update: jest.Mock };
}): Record<string, unknown> =>
  (
    prisma.store.update.mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ]
  )[0].data;

describe('cash on delivery is refused on a marketplace store', () => {
  it('owner: enabling on a MARKETPLACE store is a 400 and nothing is written', async () => {
    const { service, prisma } = build({ store_type: 'MARKETPLACE' });
    await expect(
      service.update('u1', { cod_enabled: true }),
    ).rejects.toMatchObject({
      response: {
        code: 'STORE_COD_MARKETPLACE_NOT_ALLOWED',
        message: 'Cash on delivery is not available for marketplace stores.',
      },
    });
    expect(prisma.store.update).not.toHaveBeenCalled();
  });

  it('owner: switching it off is always accepted', async () => {
    const { service, prisma } = build({
      store_type: 'MARKETPLACE',
      cod_enabled: true,
    });
    const out = await service.update('u1', { cod_enabled: false });
    expect(writtenData(prisma)).toEqual({ cod_enabled: false });
    expect(out.cod_enabled).toBe(false);
  });

  it('owner: an INDEPENDENT store enables it exactly as before', async () => {
    const { service, prisma } = build({ store_type: 'INDEPENDENT' });
    const out = await service.update('u1', { cod_enabled: true });
    expect(writtenData(prisma)).toEqual({ cod_enabled: true });
    expect(out.cod_enabled).toBe(true);
  });

  it('owner: an update that does not mention the flag is untouched', async () => {
    const { service, prisma } = build({
      store_type: 'MARKETPLACE',
      cod_enabled: true,
    });
    const out = await service.update('u1', { name: 'Shop' });
    expect('cod_enabled' in writtenData(prisma)).toBe(false);
    // The stored true still reads as false.
    expect(out.cod_enabled).toBe(false);
  });

  it('admin: enabling on a MARKETPLACE store is refused', async () => {
    const { service, prisma } = build({ store_type: 'MARKETPLACE' });
    await expect(
      service.adminUpdateByCreatorId('c1', { cod_enabled: true }),
    ).rejects.toMatchObject({
      response: { code: 'STORE_COD_MARKETPLACE_NOT_ALLOWED' },
    });
    expect(prisma.store.update).not.toHaveBeenCalled();
  });

  it('admin: enabling while switching the store to MARKETPLACE is refused', async () => {
    const { service, prisma } = build({ store_type: 'INDEPENDENT' });
    await expect(
      service.adminUpdateByCreatorId('c1', {
        cod_enabled: true,
        store_type: 'MARKETPLACE',
      } as never),
    ).rejects.toMatchObject({
      response: { code: 'STORE_COD_MARKETPLACE_NOT_ALLOWED' },
    });
    expect(prisma.store.update).not.toHaveBeenCalled();
  });

  it('admin: a switch to MARKETPLACE writes the flag off', async () => {
    const { service, prisma } = build({
      store_type: 'INDEPENDENT',
      cod_enabled: true,
    });
    const out = await service.adminUpdateByCreatorId('c1', {
      store_type: 'MARKETPLACE',
    } as never);
    expect(writtenData(prisma)).toMatchObject({
      store_type: 'MARKETPLACE',
      cod_enabled: false,
    });
    expect(out.cod_enabled).toBe(false);
  });

  it('admin: a switch to INDEPENDENT may enable it and does not force it off', async () => {
    const a = build({ store_type: 'MARKETPLACE' });
    await a.service.adminUpdateByCreatorId('c1', {
      store_type: 'INDEPENDENT',
      cod_enabled: true,
    } as never);
    expect(writtenData(a.prisma)).toMatchObject({ cod_enabled: true });

    const b = build({ store_type: 'MARKETPLACE' });
    await b.service.adminUpdateByCreatorId('c1', {
      store_type: 'INDEPENDENT',
    } as never);
    expect('cod_enabled' in writtenData(b.prisma)).toBe(false);
  });

  it('admin: an INDEPENDENT store enables it as before', async () => {
    const { service, prisma } = build({ store_type: 'INDEPENDENT' });
    await service.adminUpdateByCreatorId('c1', { cod_enabled: true });
    expect(writtenData(prisma)).toEqual({ cod_enabled: true });
  });

  it('admin read: a stored true on a MARKETPLACE row reads as false', async () => {
    const { service } = build({ store_type: 'MARKETPLACE', cod_enabled: true });
    expect((await service.findByCreatorId('c1')).cod_enabled).toBe(false);
  });
});

describe('effective_currency on the owner payloads', () => {
  it('MARKETPLACE with a stale row currency: the platform currency', async () => {
    const { service } = build(
      { store_type: 'MARKETPLACE', currency: 'SEK' },
      'EUR',
    );
    const admin = await service.findByCreatorId('c1');
    expect(admin.effective_currency).toBe('EUR');
    // The raw column is not rewritten.
    expect(admin.currency).toBe('SEK');
    const owner = await service.findByCreator('u1');
    expect(owner.effective_currency).toBe('EUR');
    expect(owner.currency).toBe('SEK');
  });

  it('INDEPENDENT with its own currency: that currency', async () => {
    const { service } = build(
      { store_type: 'INDEPENDENT', currency: 'SEK' },
      'EUR',
    );
    expect((await service.findByCreatorId('c1')).effective_currency).toBe(
      'SEK',
    );
    expect((await service.findByCreator('u1')).effective_currency).toBe('SEK');
  });

  it('INDEPENDENT with an unsupported or empty currency: the platform currency', async () => {
    const unsupported = build(
      { store_type: 'INDEPENDENT', currency: 'XXX' },
      'EUR',
    );
    expect(
      (await unsupported.service.findByCreatorId('c1')).effective_currency,
    ).toBe('EUR');
    const empty = build({ store_type: 'INDEPENDENT', currency: null }, 'SEK');
    expect(
      (await empty.service.findByCreatorId('c1')).effective_currency,
    ).toBe('SEK');
  });

  it('no platform config row: EUR', async () => {
    const { service } = build({ store_type: 'MARKETPLACE' }, undefined);
    expect((await service.findByCreatorId('c1')).effective_currency).toBe(
      'EUR',
    );
  });

  it('both update routes answer with it', async () => {
    const { service } = build(
      { store_type: 'MARKETPLACE', currency: 'SEK' },
      'EUR',
    );
    expect(
      (await service.update('u1', { name: 'Shop' })).effective_currency,
    ).toBe('EUR');
    expect(
      (await service.adminUpdateByCreatorId('c1', { name: 'Shop' }))
        .effective_currency,
    ).toBe('EUR');
  });
});
