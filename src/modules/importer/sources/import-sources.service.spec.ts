import type { ImportSource } from '@prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { CryptoService } from '../../../common/crypto/crypto.service';
import type { PrivateStorage } from '../../../common/storage/private-file-storage';
import {
  ImportSourcesService,
  cleanSettings,
  isValidUploadsPath,
} from './import-sources.service';
import { ImporterCreatorController } from '../importer-creator.controller';
import type { ImportRunsService } from '../runs/import-runs.service';

// M4.4 fixer B: a host change drops the saved key and the verification,
// uploads_path is validated, and run creation checks the source kind first.

function source(over: Partial<ImportSource> = {}): ImportSource {
  return {
    id: 'src1',
    store_id: 's1',
    kind: 'WC_REST',
    name: 'Shop',
    site_host: 'old.example',
    host_aliases: [],
    settings: {},
    credentials_enc: 'enc:ck:cs',
    last_verified_at: new Date(1000),
    created_at: new Date(0),
    updated_at: new Date(0),
    ...over,
  } as ImportSource;
}

function setup(cur: ImportSource) {
  const update = jest.fn(({ data }: { data: Partial<ImportSource> }) =>
    Promise.resolve({ ...cur, ...data }),
  );
  const prisma = {
    importSource: {
      findFirst: jest.fn(() => Promise.resolve(cur)),
      update,
    },
  };
  const crypto = { encrypt: jest.fn((v: string) => `enc:${v}`) };
  const svc = new ImportSourcesService(
    prisma as unknown as PrismaService,
    crypto as unknown as CryptoService,
    {} as PrivateStorage,
  );
  const data = () =>
    (
      update.mock.calls[0] as unknown[] as [{ data: Record<string, unknown> }]
    )[0].data;
  return { svc, data };
}

describe('ImportSourcesService.update host change', () => {
  it('clears the credentials and the verification when site_host changes', async () => {
    const { svc, data } = setup(source());
    const view = await svc.update('s1', 'src1', {
      site_url: 'https://new.example',
    });
    expect(data()).toMatchObject({
      site_host: 'new.example',
      credentials_enc: null,
      last_verified_at: null,
    });
    expect(view.has_credentials).toBe(false);
    expect(view.last_verified_at).toBeNull();
  });

  it('keeps new keys sent with the host change (verification reset)', async () => {
    const { svc, data } = setup(source());
    await svc.update('s1', 'src1', {
      site_url: 'new.example',
      consumer_key: 'ck2',
      consumer_secret: 'cs2',
    });
    expect(data()).toMatchObject({
      credentials_enc: 'enc:ck2:cs2',
      last_verified_at: null,
    });
  });

  it('leaves the credentials alone when the host stays the same', async () => {
    const { svc, data } = setup(source());
    await svc.update('s1', 'src1', {
      site_url: 'https://OLD.example/',
      name: 'Renamed',
    });
    expect(data()).not.toHaveProperty('credentials_enc');
    expect(data()).not.toHaveProperty('last_verified_at');
  });
});

describe('uploads_path validation', () => {
  it.each([
    '/wp-content/uploads/',
    '/wp-content/uploads',
    '/media/',
    '/a/b-c_d/',
  ])('accepts %s', (v) => expect(isValidUploadsPath(v)).toBe(true));

  it.each([
    '/',
    '//evil.example/',
    '/wp-content/../wp-config.php',
    '/media',
    'media/',
    'https://evil.example/',
    '/a?b/',
    '/a/../b/',
    '/wp-content/uploads?x=1',
    '/a b/',
  ])('rejects %s', (v) => expect(isValidUploadsPath(v)).toBe(false));

  it('cleanSettings refuses a bad uploads_path (IMPORT_SOURCE_SETTINGS_INVALID)', () => {
    let thrown: unknown;
    try {
      cleanSettings({ uploads_path: '/' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({
      response: { code: 'IMPORT_SOURCE_SETTINGS_INVALID' },
    });
    expect(cleanSettings({ uploads_path: ' /wp-content/uploads/ ' })).toEqual({
      uploads_path: '/wp-content/uploads/',
    });
  });

  it('update validates settings too', async () => {
    const { svc } = setup(source({ kind: 'WP_BUNDLE' }));
    await expect(
      svc.update('s1', 'src1', { settings: { uploads_path: '/../' } }),
    ).rejects.toMatchObject({
      response: { code: 'IMPORT_SOURCE_SETTINGS_INVALID' },
    });
  });
});

describe('POST importer/my/runs source kind', () => {
  it('a WC_REST source fails with IMPORT_SOURCE_KIND_UNSUPPORTED before the empty-files check', async () => {
    const { svc } = setup(source({ kind: 'WC_REST' }));
    const runs = {
      storeIdForCreator: jest.fn(() => Promise.resolve('s1')),
      create: jest.fn(),
    };
    const ctrl = new ImporterCreatorController(
      svc,
      runs as unknown as ImportRunsService,
    );
    await expect(
      ctrl.createRun('u1', { source_id: 'src1' }, undefined),
    ).rejects.toMatchObject({
      response: { code: 'IMPORT_SOURCE_KIND_UNSUPPORTED' },
    });
    expect(runs.create).not.toHaveBeenCalled();
  });

  it('a bundle source without files still answers IMPORT_BUNDLE_MISSING_FILE', async () => {
    const { svc } = setup(source({ kind: 'WP_BUNDLE' }));
    const runs = {
      storeIdForCreator: jest.fn(() => Promise.resolve('s1')),
      create: jest.fn(),
    };
    const ctrl = new ImporterCreatorController(
      svc,
      runs as unknown as ImportRunsService,
    );
    await expect(
      ctrl.createRun('u1', { source_id: 'src1' }, { files: [] }),
    ).rejects.toMatchObject({
      response: { code: 'IMPORT_BUNDLE_MISSING_FILE' },
    });
  });
});
