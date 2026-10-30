import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { StoreType } from '@prisma/client';
import { StoreAppsService } from './store-apps.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';

// The service is exercised against a hand-rolled PrismaService mock that keeps
// StoreApp rows in memory, so enable/disable/setAvailable are checked by the
// rows they leave behind and the errors they raise.

type Row = {
  app_key: string;
  available: boolean;
  enabled: boolean;
  settings: unknown;
  enabled_at: Date | null;
  enabled_by: string | null;
};

const STORE_ID = 's1';
const CREATOR_ID = 'c1';
const USER_ID = 'u1';

function makePrisma(
  seed: Partial<Row>[],
  storeType: StoreType = StoreType.INDEPENDENT,
) {
  const rows = new Map<string, Row>(
    seed.map((r) => [
      r.app_key as string,
      {
        app_key: r.app_key as string,
        available: r.available ?? false,
        enabled: r.enabled ?? false,
        settings: r.settings ?? {},
        enabled_at: r.enabled_at ?? null,
        enabled_by: r.enabled_by ?? null,
      },
    ]),
  );
  const storeApp = {
    findMany: jest.fn(({ where }: { where: { store_id: string } }) =>
      Promise.resolve(
        where.store_id === STORE_ID
          ? [...rows.values()].map((r) => ({ ...r }))
          : [],
      ),
    ),
    update: jest.fn(
      ({
        where,
        data,
      }: {
        where: { store_id_app_key: { app_key: string } };
        data: Partial<Row>;
      }) => {
        const row = rows.get(where.store_id_app_key.app_key);
        if (!row) return Promise.reject(new Error('record not found'));
        Object.assign(row, data);
        return Promise.resolve({ ...row });
      },
    ),
    updateMany: jest.fn(
      ({
        where,
        data,
      }: {
        where: { app_key: { in: string[] }; enabled?: boolean };
        data: Partial<Row>;
      }) => {
        let count = 0;
        for (const key of where.app_key.in) {
          const row = rows.get(key);
          if (!row) continue;
          if (where.enabled !== undefined && row.enabled !== where.enabled)
            continue;
          Object.assign(row, data);
          count += 1;
        }
        return Promise.resolve({ count });
      },
    ),
    upsert: jest.fn(
      ({
        where,
        create,
        update,
      }: {
        where: { store_id_app_key: { app_key: string } };
        create: Partial<Row>;
        update: Partial<Row>;
      }) => {
        const key = where.store_id_app_key.app_key;
        const row = rows.get(key);
        if (row) Object.assign(row, update);
        else
          rows.set(key, {
            app_key: key,
            available: create.available ?? false,
            enabled: create.enabled ?? false,
            settings: {},
            enabled_at: null,
            enabled_by: null,
          });
        return Promise.resolve({ ...rows.get(key) });
      },
    ),
  };
  const prisma = {
    rows,
    storeApp,
    creator: {
      findUnique: jest.fn(({ where }: { where: { user_id: string } }) =>
        Promise.resolve(
          where.user_id === USER_ID
            ? { id: CREATOR_ID, store: { id: STORE_ID } }
            : null,
        ),
      ),
    },
    store: {
      // Public slug lookups go through findFirst (slug + is_active).
      findFirst: jest.fn(
        ({ where }: { where: { slug?: string; is_active?: boolean } }) =>
          Promise.resolve(
            where.slug === 'my-shop' && where.is_active !== false
              ? { id: STORE_ID }
              : null,
          ),
      ),
      findUnique: jest.fn(
        ({ where }: { where: { creator_id?: string; slug?: string } }) =>
          Promise.resolve(
            where.creator_id === CREATOR_ID || where.slug === 'my-shop'
              ? { id: STORE_ID, store_type: storeType }
              : null,
          ),
      ),
    },
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ storeApp }),
    ),
  };
  return prisma;
}

function makeRevalidation() {
  return { revalidateStoreById: jest.fn(() => Promise.resolve()) };
}

function build(
  seed: Partial<Row>[],
  storeType: StoreType = StoreType.INDEPENDENT,
) {
  const prisma = makePrisma(seed, storeType);
  const revalidation = makeRevalidation();
  const service = new StoreAppsService(
    prisma as unknown as PrismaService,
    revalidation as unknown as RevalidationService,
  );
  return { prisma, revalidation, service };
}

async function errorOf(p: Promise<unknown>): Promise<HttpException> {
  return (await p.catch((e: unknown) => e)) as HttpException;
}

describe('StoreAppsService', () => {
  describe('reads for a store without rows (today behaviour)', () => {
    it('answers disabled / null / {} everywhere', async () => {
      const { service } = build([]);
      await expect(service.isEnabled(STORE_ID, 'markets')).resolves.toBe(false);
      await expect(service.getSettings(STORE_ID, 'b2b')).resolves.toBeNull();
      await expect(service.storefrontApps(STORE_ID)).resolves.toEqual({});
    });

    it('lists every registry app as unavailable and not enablable', async () => {
      const { service } = build([]);
      const list = await service.list(USER_ID);
      expect(list.map((a) => a.key)).toEqual([
        'markets',
        'b2b',
        'invoices',
        'importer',
        'personalization',
        'production',
        'designer',
        'feeds',
        'zoho_mail',
      ]);
      for (const app of list) {
        expect(app).toMatchObject({
          available: false,
          enabled: false,
          settings: {},
          can_enable: false,
          blocked_reason: 'NOT_AVAILABLE',
        });
      }
    });
  });

  describe('isEnabled', () => {
    it('is true only when available AND enabled', async () => {
      const { service } = build([
        { app_key: 'markets', available: true, enabled: true },
        { app_key: 'b2b', available: true, enabled: false },
        { app_key: 'invoices', available: false, enabled: true },
      ]);
      await expect(service.isEnabled(STORE_ID, 'markets')).resolves.toBe(true);
      await expect(service.isEnabled(STORE_ID, 'b2b')).resolves.toBe(false);
      await expect(service.isEnabled(STORE_ID, 'invoices')).resolves.toBe(
        false,
      );
      await expect(service.storefrontApps(STORE_ID)).resolves.toEqual({
        markets: { enabled: true },
      });
    });

    it('caches the rows per store and drops the cache on a mutation', async () => {
      const { service, prisma } = build([
        { app_key: 'b2b', available: true, enabled: true },
      ]);
      await service.isEnabled(STORE_ID, 'b2b');
      await service.isEnabled(STORE_ID, 'markets');
      await service.getSettings(STORE_ID, 'b2b');
      expect(prisma.storeApp.findMany).toHaveBeenCalledTimes(1);

      await service.updateMine(USER_ID, 'b2b', { enabled: false });
      await expect(service.isEnabled(STORE_ID, 'b2b')).resolves.toBe(false);
    });

    it('treats a DB error on a miss as disabled without caching it', async () => {
      const { service, prisma } = build([
        { app_key: 'b2b', available: true, enabled: true },
      ]);
      prisma.storeApp.findMany.mockImplementationOnce(() =>
        Promise.reject(new Error('connection lost')),
      );
      await expect(service.isEnabled(STORE_ID, 'b2b')).resolves.toBe(false);
      // The next call hits the DB again and sees the real row.
      await expect(service.isEnabled(STORE_ID, 'b2b')).resolves.toBe(true);
      expect(prisma.storeApp.findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('enable', () => {
    it('refuses an app the admin has not made available', async () => {
      const { service, prisma } = build([]);
      const err = await errorOf(
        service.updateMine(USER_ID, 'b2b', { enabled: true }),
      );
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({
        code: 'STORE_APP_NOT_AVAILABLE',
      });
      expect(prisma.storeApp.update).not.toHaveBeenCalled();
    });

    it('refuses an independent-only app on a marketplace store', async () => {
      const { service } = build(
        [{ app_key: 'markets', available: true }],
        StoreType.MARKETPLACE,
      );
      const err = await errorOf(
        service.updateMine(USER_ID, 'markets', { enabled: true }),
      );
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        code: 'STORE_APP_REQUIRES_INDEPENDENT',
      });
      const list = await service.list(USER_ID);
      expect(list.find((a) => a.key === 'markets')).toMatchObject({
        can_enable: false,
        blocked_reason: 'REQUIRES_INDEPENDENT',
      });
      // b2b does not need an independent store.
      expect(list.find((a) => a.key === 'b2b')?.blocked_reason).toBe(
        'NOT_AVAILABLE',
      );
    });

    it('refuses importer while markets is not in effect', async () => {
      const { service } = build([
        { app_key: 'importer', available: true },
        { app_key: 'markets', available: true, enabled: false },
      ]);
      const err = await errorOf(
        service.updateMine(USER_ID, 'importer', { enabled: true }),
      );
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        code: 'STORE_APP_DEPENDENCY_MISSING',
      });
      const list = await service.list(USER_ID);
      expect(list.find((a) => a.key === 'importer')).toMatchObject({
        available: true,
        enabled: false,
        can_enable: false,
        blocked_reason: 'DEPENDENCY_MISSING',
      });
    });

    it('enables, stamps enabled_at/enabled_by, revalidates once and returns the full list', async () => {
      const { service, prisma, revalidation } = build([
        { app_key: 'markets', available: true },
        { app_key: 'importer', available: true },
      ]);
      const list = await service.updateMine(USER_ID, 'markets', {
        enabled: true,
      });
      expect(list.map((a) => a.key)).toEqual([
        'markets',
        'b2b',
        'invoices',
        'importer',
        'personalization',
        'production',
        'designer',
        'feeds',
        'zoho_mail',
      ]);
      const markets = list.find((a) => a.key === 'markets');
      expect(markets).toMatchObject({
        available: true,
        enabled: true,
        can_enable: true,
        blocked_reason: null,
      });
      expect(markets?.enabled_at).toBeInstanceOf(Date);
      // The sibling that depends on markets became enablable in the same list.
      expect(list.find((a) => a.key === 'importer')).toMatchObject({
        can_enable: true,
        blocked_reason: null,
      });
      expect(prisma.rows.get('markets')).toMatchObject({
        enabled: true,
        enabled_by: USER_ID,
      });
      expect(revalidation.revalidateStoreById).toHaveBeenCalledTimes(1);
      expect(revalidation.revalidateStoreById).toHaveBeenCalledWith(STORE_ID);
    });

    it('applies settings and the toggle together with a single revalidation', async () => {
      const { service, prisma, revalidation } = build([
        { app_key: 'b2b', available: true },
      ]);
      const list = await service.updateMine(USER_ID, 'b2b', {
        enabled: true,
        settings: { mode: 'x' },
      });
      expect(list.find((a) => a.key === 'b2b')).toMatchObject({
        enabled: true,
        settings: { mode: 'x' },
      });
      expect(prisma.storeApp.update).toHaveBeenCalledTimes(2);
      expect(revalidation.revalidateStoreById).toHaveBeenCalledTimes(1);
    });

    it('rejects an unknown app key with STORE_APP_UNKNOWN', async () => {
      const { service } = build([]);
      const err = await errorOf(
        service.updateMine(USER_ID, 'nope', { enabled: true }),
      );
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.getResponse()).toMatchObject({ code: 'STORE_APP_UNKNOWN' });
    });
  });

  describe('disable', () => {
    it('refuses markets while importer is enabled', async () => {
      const { service, prisma } = build([
        { app_key: 'markets', available: true, enabled: true },
        { app_key: 'importer', available: true, enabled: true },
      ]);
      const err = await errorOf(
        service.updateMine(USER_ID, 'markets', { enabled: false }),
      );
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        code: 'STORE_APP_DEPENDENCY_IN_USE',
      });
      expect(prisma.rows.get('markets')?.enabled).toBe(true);
    });

    it('disables (clearing enabled_at, keeping enabled_by) and is a no-op when already off', async () => {
      const { service, prisma, revalidation } = build([
        {
          app_key: 'b2b',
          available: true,
          enabled: true,
          enabled_at: new Date('2026-01-01T00:00:00Z'),
          enabled_by: USER_ID,
        },
      ]);
      await service.updateMine(USER_ID, 'b2b', { enabled: false });
      expect(prisma.rows.get('b2b')).toMatchObject({
        enabled: false,
        enabled_at: null,
        enabled_by: USER_ID,
      });
      expect(revalidation.revalidateStoreById).toHaveBeenCalledTimes(1);

      // Already off / never had a row: no write, no revalidation.
      await service.updateMine(USER_ID, 'b2b', { enabled: false });
      await service.updateMine(USER_ID, 'markets', { enabled: false });
      expect(prisma.storeApp.update).toHaveBeenCalledTimes(1);
      expect(revalidation.revalidateStoreById).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateSettings', () => {
    it('replaces the settings of an available app', async () => {
      const { service, prisma } = build([
        { app_key: 'b2b', available: true, settings: { a: 1 } },
      ]);
      const list = await service.updateMine(USER_ID, 'b2b', {
        settings: { b: 2 },
      });
      expect(list.find((a) => a.key === 'b2b')?.settings).toEqual({ b: 2 });
      expect(prisma.rows.get('b2b')?.settings).toEqual({ b: 2 });
    });

    it('refuses settings for an unavailable app', async () => {
      const { service } = build([]);
      const err = await errorOf(
        service.updateMine(USER_ID, 'b2b', { settings: { b: 2 } }),
      );
      expect(err.getResponse()).toMatchObject({
        code: 'STORE_APP_NOT_AVAILABLE',
      });
    });

    // b2b app: the per-app settings validator seam (settings-validators.ts).
    it('rejects malformed b2b settings with STORE_APP_SETTINGS_INVALID, leaving the row alone', async () => {
      const { service, prisma } = build([
        { app_key: 'b2b', available: true, settings: { allow_company: true } },
      ]);
      const err = await errorOf(
        service.updateMine(USER_ID, 'b2b', {
          settings: { default_buyer_type: 'ROBOT', org_number_countries: 'SE' },
        }),
      );
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        code: 'STORE_APP_SETTINGS_INVALID',
        message: expect.stringContaining('default_buyer_type') as string,
      });
      expect(prisma.rows.get('b2b')?.settings).toEqual({ allow_company: true });
      expect(prisma.storeApp.update).not.toHaveBeenCalled();
    });

    it('stores valid b2b settings and leaves other apps unvalidated', async () => {
      const { service, prisma } = build([
        { app_key: 'b2b', available: true },
        { app_key: 'markets', available: true },
      ]);
      const valid = {
        allow_company: true,
        default_buyer_type: 'COMPANY',
        require_vat_number: true,
        org_number_countries: ['SE', 'FI'],
      };
      await service.updateMine(USER_ID, 'b2b', { settings: valid });
      expect(prisma.rows.get('b2b')?.settings).toEqual(valid);
      await service.updateMine(USER_ID, 'markets', {
        settings: { default_buyer_type: 'ROBOT' },
      });
      expect(prisma.rows.get('markets')?.settings).toEqual({
        default_buyer_type: 'ROBOT',
      });
    });

    // invoices app (M3 §3.7): the second validator in the seam.
    it('rejects malformed invoices settings and stores valid ones', async () => {
      const { service, prisma } = build([
        { app_key: 'invoices', available: true },
      ]);
      const err = await errorOf(
        service.updateMine(USER_ID, 'invoices', {
          settings: { cod_issue_on: 'shipped', extra: 1 },
        }),
      );
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        code: 'STORE_APP_SETTINGS_INVALID',
        message: expect.stringContaining('cod_issue_on') as string,
      });
      expect(prisma.storeApp.update).not.toHaveBeenCalled();
      const valid = {
        auto_issue: false,
        cod_issue_on: 'created',
        attach_pdf_to_email: true,
        credit_on_cancel: false,
      };
      await service.updateMine(USER_ID, 'invoices', { settings: valid });
      expect(prisma.rows.get('invoices')?.settings).toEqual(valid);
    });
  });

  describe('admin', () => {
    it('lists every registry key with its availability', async () => {
      const { service } = build([{ app_key: 'b2b', available: true }]);
      const list = await service.adminList(CREATOR_ID);
      expect(list.map((a) => [a.key, a.available])).toEqual([
        ['markets', false],
        ['b2b', true],
        ['invoices', false],
        ['importer', false],
        ['personalization', false],
        ['production', false],
        ['designer', false],
        ['feeds', false],
        ['zoho_mail', false],
      ]);
      expect(list[3]).toMatchObject({
        requires_independent: true,
        depends_on: ['markets'],
      });
    });

    it('creates the row when making an app available', async () => {
      const { service, prisma, revalidation } = build([]);
      const list = await service.setAvailable(CREATOR_ID, 'b2b', true);
      expect(prisma.rows.get('b2b')).toMatchObject({
        available: true,
        enabled: false,
      });
      expect(list.find((a) => a.key === 'b2b')?.available).toBe(true);
      expect(revalidation.revalidateStoreById).toHaveBeenCalledWith(STORE_ID);
    });

    it('withdrawing also switches the app and its dependents off', async () => {
      const { service, prisma } = build([
        { app_key: 'markets', available: true, enabled: true },
        { app_key: 'importer', available: true, enabled: true },
      ]);
      await service.setAvailable(CREATOR_ID, 'markets', false);
      expect(prisma.rows.get('markets')).toMatchObject({
        available: false,
        enabled: false,
      });
      expect(prisma.rows.get('importer')).toMatchObject({
        available: true,
        enabled: false,
      });
    });

    it('reports an unknown creator as STORE_NOT_FOUND', async () => {
      const { service } = build([]);
      const err = await errorOf(service.adminList('other'));
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.getResponse()).toMatchObject({ code: 'STORE_NOT_FOUND' });
    });
  });

  describe('onStoreTypeChanged', () => {
    it('switches independent-only apps and their dependents off on a move to MARKETPLACE', async () => {
      const { service, prisma, revalidation } = build([
        { app_key: 'markets', available: true, enabled: true },
        { app_key: 'b2b', available: true, enabled: true },
        { app_key: 'invoices', available: true, enabled: true },
        { app_key: 'importer', available: true, enabled: true },
      ]);
      await service.onStoreTypeChanged(STORE_ID, StoreType.MARKETPLACE);
      expect(prisma.rows.get('markets')?.enabled).toBe(false);
      expect(prisma.rows.get('invoices')?.enabled).toBe(false);
      expect(prisma.rows.get('importer')?.enabled).toBe(false);
      expect(prisma.rows.get('b2b')?.enabled).toBe(true);
      expect(prisma.storeApp.updateMany).toHaveBeenCalledTimes(1);
      // Availability is kept so the creator can re-enable after a flip back.
      expect(prisma.rows.get('markets')?.available).toBe(true);
      expect(revalidation.revalidateStoreById).toHaveBeenCalledWith(STORE_ID);
    });

    it('does nothing on a move to INDEPENDENT', async () => {
      const { service, prisma } = build([
        { app_key: 'b2b', available: true, enabled: true },
      ]);
      await service.onStoreTypeChanged(STORE_ID, StoreType.INDEPENDENT);
      expect(prisma.storeApp.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('store resolution', () => {
    it('resolves a store by slug and by creator user', async () => {
      const { service } = build([]);
      await expect(service.storeIdBySlug('my-shop')).resolves.toBe(STORE_ID);
      await expect(service.storeIdBySlug('other')).resolves.toBeNull();
      // Inactive stores serve no app route by slug.
      const { service: inactive, prisma } = build([]);
      prisma.store.findFirst.mockResolvedValueOnce(null);
      await expect(inactive.storeIdBySlug('my-shop')).resolves.toBeNull();
      await expect(service.storeIdByUser(USER_ID)).resolves.toBe(STORE_ID);
      await expect(service.storeIdByUser('nobody')).resolves.toBeNull();
    });

    it('reports a creator without a store as STORE_NOT_FOUND', async () => {
      const { service } = build([]);
      const err = await errorOf(service.list('nobody'));
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.getResponse()).toMatchObject({ code: 'STORE_NOT_FOUND' });
    });
  });
});
