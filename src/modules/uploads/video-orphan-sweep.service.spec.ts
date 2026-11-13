import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PrismaService } from '../../prisma/prisma.service';
import { PublicStorage } from '../storage/public-storage';
import { UploadsService } from './uploads.service';
import {
  VIDEO_ORPHAN_MIN_AGE_MS,
  VideoOrphanSweepService,
} from './video-orphan-sweep.service';

const OLD_ORPHAN = '/uploads/products/00000000-0000-4000-8000-000000000001.mp4';
const OLD_REFERENCED =
  '/uploads/products/00000000-0000-4000-8000-000000000002.mp4';
const OLD_POSTER =
  '/uploads/video-posters/00000000-0000-4000-8000-000000000004.webp';

describe('VideoOrphanSweepService', () => {
  let root: string;
  let tmp: string;
  let storage: PublicStorage;
  const savedTmp = process.env.UPLOAD_VIDEO_TMP_DIR;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sweep-root-'));
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sweep-tmp-'));
    process.env.UPLOAD_VIDEO_TMP_DIR = tmp;
    storage = PublicStorage.local(root);
    for (const url of [OLD_ORPHAN, OLD_REFERENCED]) {
      await storage.put('products', path.basename(url), Buffer.from('v'));
    }
    await storage.put(
      'video-posters',
      path.basename(OLD_POSTER),
      Buffer.from('p'),
    );
  });
  afterEach(async () => {
    if (savedTmp === undefined) delete process.env.UPLOAD_VIDEO_TMP_DIR;
    else process.env.UPLOAD_VIDEO_TMP_DIR = savedTmp;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /**
   * In-memory UploadedFile rows + a ProductVideo reference list. The
   * candidate query mirrors the SQL: video/mp4 or the video-posters folder,
   * older than the cutoff, not used by a ProductVideo row. `lockedKeys` are
   * rows a product save holds FOR SHARE (the claim skips them).
   */
  function setup(
    opts: {
      videoUrls?: string[];
      lockedKeys?: string[];
      backupRunning?: boolean | (() => boolean);
    } = {},
  ) {
    const now = new Date('2026-11-13T12:00:00Z');
    const old = new Date(now.getTime() - VIDEO_ORPHAN_MIN_AGE_MS - 1000);
    const fresh = new Date(now.getTime() - 60_000);
    const NEW_ORPHAN =
      '/uploads/products/00000000-0000-4000-8000-000000000003.mp4';
    const rows = [
      {
        key: OLD_ORPHAN,
        content_type: 'video/mp4',
        folder: 'products',
        created_at: old,
      },
      {
        key: OLD_REFERENCED,
        content_type: 'video/mp4',
        folder: 'products',
        created_at: old,
      },
      {
        key: NEW_ORPHAN,
        content_type: 'video/mp4',
        folder: 'products',
        created_at: fresh,
      },
      {
        key: OLD_POSTER,
        content_type: 'image/webp',
        folder: 'video-posters',
        created_at: old,
      },
      {
        key: '/uploads/products/x.webp',
        content_type: 'image/webp',
        folder: 'products',
        created_at: old,
      },
    ];
    const videoUrls = opts.videoUrls ?? [];
    const locked = new Set(opts.lockedKeys ?? []);
    const sqls: string[] = [];
    const backup = () =>
      typeof opts.backupRunning === 'function'
        ? opts.backupRunning()
        : !!opts.backupRunning;
    const query = jest.fn(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        sqls.push(sql);
        if (sql.includes('FROM "Backup" b')) {
          return Promise.resolve(backup() ? [{ running: 1 }] : []);
        }
        if (sql.includes('FOR UPDATE SKIP LOCKED')) {
          const key = values[0] as string;
          const exists = rows.some((r) => r.key === key);
          return Promise.resolve(exists && !locked.has(key) ? [{ key }] : []);
        }
        if (sql.includes('FROM "UploadedFile" uf')) {
          const [type, folder, cutoff] = values as [string, string, Date];
          return Promise.resolve(
            rows
              .filter(
                (r) =>
                  (r.content_type === type || r.folder === folder) &&
                  r.created_at < cutoff &&
                  !videoUrls.includes(r.key),
              )
              .map((r) => ({ key: r.key })),
          );
        }
        return Promise.resolve([]);
      },
    );
    const tx = {
      $queryRaw: query,
      uploadedFile: {
        deleteMany: jest.fn((q: { where: { key: string } }) => {
          const i = rows.findIndex((r) => r.key === q.where.key);
          if (i >= 0) rows.splice(i, 1);
          return Promise.resolve({ count: i >= 0 ? 1 : 0 });
        }),
      },
    };
    const prisma = {
      $queryRaw: query,
      $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;
    const uploads = new UploadsService(storage, prisma);
    return { now, rows, tx, prisma, uploads, sqls, NEW_ORPHAN };
  }

  it('deletes unreferenced videos and video posters older than 24 h; keeps referenced and newer ones', async () => {
    const { now, rows, prisma, uploads, NEW_ORPHAN } = setup({
      videoUrls: [OLD_REFERENCED],
    });
    const sweep = new VideoOrphanSweepService(prisma, uploads);
    const anywhere = jest.spyOn(uploads, 'isReferencedAnywhere');
    const out = await sweep.sweepOrphans(now);
    expect(out).toMatchObject({
      acquired: true,
      scanned: 2,
      deleted: 2,
      failed: 0,
    });
    expect(anywhere).toHaveBeenCalledWith(OLD_ORPHAN, expect.anything());
    expect(anywhere).toHaveBeenCalledWith(OLD_POSTER, expect.anything());
    expect(await storage.exists(OLD_ORPHAN)).toBe(false);
    expect(await storage.exists(OLD_POSTER)).toBe(false);
    expect(await storage.exists(OLD_REFERENCED)).toBe(true);
    // A plain product image is never a candidate.
    expect(rows.map((r) => r.key)).toEqual([
      OLD_REFERENCED,
      NEW_ORPHAN,
      '/uploads/products/x.webp',
    ]);
  });

  it('keeps a candidate that another source still references (image, page JSON, ...)', async () => {
    const { now, rows, prisma, uploads, tx } = setup();
    const base = tx.$queryRaw.getMockImplementation()!;
    tx.$queryRaw.mockImplementation(((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const sql = strings.join('?');
      if (sql.includes('FROM "ProductVideo" v WHERE')) {
        const found = (values[0] as string).endsWith(
          path.basename(OLD_REFERENCED),
        );
        return Promise.resolve(found ? [{ found: 1 }] : []);
      }
      return base(strings, ...values);
    }) as never);
    const out = await new VideoOrphanSweepService(prisma, uploads).sweepOrphans(
      now,
    );
    expect(out).toMatchObject({ scanned: 3, deleted: 2, kept: 1 });
    expect(await storage.exists(OLD_REFERENCED)).toBe(true);
    expect(rows.map((r) => r.key)).toContain(OLD_REFERENCED);
  });

  it('claims each candidate in its own short transaction and skips rows a save holds (FOR SHARE)', async () => {
    const { now, prisma, uploads, sqls } = setup({ lockedKeys: [OLD_ORPHAN] });
    const out = await new VideoOrphanSweepService(prisma, uploads).sweepOrphans(
      now,
    );
    expect(out).toMatchObject({ deleted: 2, kept: 1 });
    expect(await storage.exists(OLD_ORPHAN)).toBe(true);
    // One transaction per candidate; the candidate list is read outside.
    expect((prisma.$transaction as jest.Mock).mock.calls).toHaveLength(3);
    expect(
      sqls.filter((q) => q.includes('FOR UPDATE SKIP LOCKED')),
    ).toHaveLength(3);
  });

  it('does nothing while a backup runs, and stops when one starts', async () => {
    const busy = setup({ backupRunning: true });
    const out = await new VideoOrphanSweepService(
      busy.prisma,
      busy.uploads,
    ).sweepOrphans(busy.now);
    expect(out.acquired).toBe(false);
    expect(await storage.exists(OLD_ORPHAN)).toBe(true);

    // The backup starts after the first candidate.
    let checks = 0;
    const later = setup({ backupRunning: () => ++checks > 2 });
    const out2 = await new VideoOrphanSweepService(
      later.prisma,
      later.uploads,
    ).sweepOrphans(later.now);
    expect(out2).toMatchObject({ acquired: true, scanned: 1 });
  });

  it('keeps the row when storage refuses the delete, and never throws', async () => {
    const { now, rows, prisma, uploads } = setup();
    jest
      .spyOn(uploads, 'deleteStoredObject')
      .mockResolvedValue({ deleted: false, reason: 'denied' });
    const out = await new VideoOrphanSweepService(prisma, uploads).sweepOrphans(
      now,
    );
    expect(out.deleted).toBe(0);
    expect(rows.map((r) => r.key)).toContain(OLD_ORPHAN);

    (prisma.$transaction as jest.Mock).mockRejectedValue(new Error('db down'));
    await expect(
      new VideoOrphanSweepService(prisma, uploads).sweepOrphans(now),
    ).resolves.toMatchObject({ deleted: 0, failed: 3 });
  });

  it('temp sweep removes files older than 1 h only', async () => {
    const { prisma, uploads } = setup();
    const oldFile = path.join(tmp, 'old.upload');
    const newFile = path.join(tmp, 'new.upload');
    await fs.writeFile(oldFile, 'x');
    await fs.writeFile(newFile, 'x');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    await fs.utimes(oldFile, twoHoursAgo, twoHoursAgo);
    const removed = await new VideoOrphanSweepService(
      prisma,
      uploads,
    ).sweepTemp();
    expect(removed).toBe(1);
    expect(await fs.readdir(tmp)).toEqual(['new.upload']);
  });

  it('is not scheduled under NODE_ENV=test', () => {
    const { prisma, uploads } = setup();
    const sweep = new VideoOrphanSweepService(prisma, uploads);
    const spy = jest.spyOn(global, 'setInterval');
    sweep.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
