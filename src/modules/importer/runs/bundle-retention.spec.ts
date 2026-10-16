/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- in-memory Prisma fake rows are untyped in tests */
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createFakePrisma,
  MemoryPrivateStorage,
} from '../__fixtures__/fake-prisma';
import { isValidPrivateStorageKey } from '../../../common/storage/private-file-storage';
import {
  bundleDir,
  readBundleDirectory,
  snapshotKey,
  storeBundleFiles,
  StorageBundleReader,
  validateBundleFiles,
} from './bundle-store';
import { ImporterRetentionTask } from './importer-retention.task';

const STORE = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const file = (name: string, text = 'x') => ({
  originalname: name,
  buffer: Buffer.from(text),
  size: text.length,
});

describe('bundle store', () => {
  it('stores allowlisted files under importer/<store>/bundles/<run>/ and reads them back', async () => {
    const storage = new MemoryPrivateStorage();
    const stored = await storeBundleFiles(storage, STORE, RUN, [
      file('posts.tsv', 'a'),
      file('postmeta.tsv', 'b'),
    ]);
    expect(stored.bundle_key).toBe(`${bundleDir(STORE, RUN)}/index.json`);
    for (const k of storage.files.keys())
      expect(isValidPrivateStorageKey(k)).toBe(true);
    expect(isValidPrivateStorageKey(snapshotKey(STORE, RUN))).toBe(true);
    expect(
      isValidPrivateStorageKey(`importer/${STORE}/bundles/${RUN}/../../x.tsv`),
    ).toBe(false);
    const reader = new StorageBundleReader(storage, stored.bundle_key);
    expect(await reader.list()).toEqual(['postmeta.tsv', 'posts.tsv']);
    expect(await reader.readText('posts.tsv')).toBe('a');
    await expect(reader.readText('terms.tsv')).rejects.toMatchObject({
      code: 'IMPORT_BUNDLE_MISSING_FILE',
    });
  });

  it('validates uploads: required files, duplicates, path tricks, archives', async () => {
    await expect(
      validateBundleFiles([file('posts.tsv')]),
    ).rejects.toMatchObject({
      response: { code: 'IMPORT_BUNDLE_MISSING_FILE' },
    });
    await expect(
      validateBundleFiles([
        file('posts.tsv'),
        file('POSTS.tsv'),
        file('postmeta.tsv'),
      ]),
    ).rejects.toMatchObject({
      response: { code: 'IMPORT_BUNDLE_UNEXPECTED_FILE' },
    });
    await expect(
      validateBundleFiles([file('../posts.tsv'), file('postmeta.tsv')]),
    ).resolves.toBeUndefined();
    await expect(
      validateBundleFiles([file('bundle.zip')]),
    ).rejects.toMatchObject({
      response: { code: 'IMPORT_BUNDLE_INVALID_ARCHIVE' },
    });
  });

  it('server directories only below IMPORTER_BUNDLE_DIR_ROOT', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bundles-'));
    mkdirSync(join(root, 'namez'));
    writeFileSync(join(root, 'namez', 'posts.tsv'), 'p');
    writeFileSync(join(root, 'namez', 'evil.sh'), 'rm');
    const prev = process.env.IMPORTER_BUNDLE_DIR_ROOT;
    try {
      delete process.env.IMPORTER_BUNDLE_DIR_ROOT;
      await expect(readBundleDirectory('namez')).rejects.toMatchObject({
        response: { code: 'IMPORT_BUNDLE_MISSING_FILE' },
      });
      process.env.IMPORTER_BUNDLE_DIR_ROOT = root;
      expect(
        (await readBundleDirectory('namez')).map((f) => f.originalname),
      ).toEqual(['posts.tsv']);
      await expect(readBundleDirectory('..')).rejects.toMatchObject({
        response: { code: 'IMPORT_BUNDLE_MISSING_FILE' },
      });
    } finally {
      if (prev === undefined) delete process.env.IMPORTER_BUNDLE_DIR_ROOT;
      else process.env.IMPORTER_BUNDLE_DIR_ROOT = prev;
    }
  });
});

describe('importer.bundles retention task (C22)', () => {
  it('deletes bundle files and snapshots 30 days after a run finished; run rows after 180 days', async () => {
    const db = createFakePrisma();
    const storage = new MemoryPrivateStorage();
    const now = new Date('2026-12-31T00:00:00Z');
    const old = await storeBundleFiles(storage, STORE, RUN, [
      file('posts.tsv'),
      file('postmeta.tsv'),
    ]);
    await storage.write(snapshotKey(STORE, RUN), Buffer.from('gz'));
    db.importRun.rows.push(
      {
        id: RUN,
        store_id: STORE,
        status: 'COMPLETED',
        bundle_key: old.bundle_key,
        snapshot_key: snapshotKey(STORE, RUN),
        finished_at: new Date('2026-11-01T00:00:00Z'),
        updated_at: new Date('2026-11-01T00:00:00Z'),
      },
      {
        id: 'fresh',
        store_id: STORE,
        status: 'COMPLETED',
        bundle_key: 'k',
        snapshot_key: null,
        finished_at: new Date('2026-12-20T00:00:00Z'),
        updated_at: now,
      },
      {
        id: 'active',
        store_id: STORE,
        status: 'RUNNING',
        bundle_key: 'k2',
        snapshot_key: null,
        finished_at: null,
        updated_at: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 'ancient',
        store_id: STORE,
        status: 'ROLLED_BACK',
        bundle_key: null,
        snapshot_key: null,
        finished_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      },
    );
    const retention = { registerTask: jest.fn() };
    const task = new ImporterRetentionTask(
      db as never,
      storage,
      retention as never,
    );
    task.onModuleInit();
    expect(retention.registerTask).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'importer.bundles' }),
    );

    const dry = await task.run(now, { dryRun: true, limit: 100 });
    expect(dry.details).toMatchObject({ bundles: 1, runs: 1 });
    expect(storage.files.size).toBe(4);

    const res = await task.run(now, { dryRun: false, limit: 100 });
    expect(res.details).toMatchObject({ bundles: 1, files: 4, runs: 1 });
    expect(storage.files.size).toBe(0);
    expect(db.importRun.rows.map((r: any) => r.id).sort()).toEqual(
      ['active', 'fresh', RUN].sort(),
    );
    expect(db.importRun.rows.find((r: any) => r.id === RUN)).toMatchObject({
      bundle_key: null,
      snapshot_key: null,
    });
  });
});
