import { HttpException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import {
  THROTTLER_LIMIT,
  THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { of } from 'rxjs';
import type { PrismaService } from '../../prisma/prisma.service';
import { PublicStorage } from '../storage/public-storage';
import { VideoUploadInterceptor } from './upload-limit.interceptor';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { buildMp4 } from './__fixtures__/mp4-builder';

const user = (role: UserRole, id = 'u1') =>
  ({ id, role, email: 'x@y', status: 'ACTIVE', storeId: null }) as never;

const ENV_KEYS = [
  'PRODUCT_VIDEO_UPLOADS',
  'UPLOAD_VIDEO_MAX_BYTES',
  'PRODUCT_VIDEO_MIN_FREE_BYTES',
  'PRODUCT_VIDEO_STORE_QUOTA_BYTES',
  'UPLOAD_VIDEO_TMP_DIR',
];

const statusOf = (e: unknown) => (e as HttpException).getStatus();
const bodyOf = (e: unknown) =>
  (e as HttpException).getResponse() as Record<string, unknown>;

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

describe('product video uploads', () => {
  let root: string;
  let tmp: string;
  let storage: PublicStorage;
  const saved: Record<string, string | undefined> = {};

  /** Prisma mock: creator c1 with store s1, `used` bytes of video, recorded rows. */
  function prismaWith(opts: { used?: number; upsertFails?: boolean } = {}) {
    const rows: Array<Record<string, unknown>> = [];
    const raw = jest.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('SUM(uf."size")')) {
        return Promise.resolve([{ used: BigInt(opts.used ?? 0) }]);
      }
      return Promise.resolve([]);
    });
    const prisma = {
      creator: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'c1', store: { id: 's1' } }),
      },
      uploadedFile: {
        upsert: jest.fn((q: { create: Record<string, unknown> }) => {
          if (opts.upsertFails) return Promise.reject(new Error('db down'));
          rows.push(q.create);
          return Promise.resolve(q.create);
        }),
      },
      $queryRaw: raw,
    } as unknown as PrismaService;
    return { prisma, rows, raw };
  }

  const bigDisk = () =>
    Promise.resolve({ bavail: 100 * 1024 * 1024 * 1024, bsize: 1 });

  function service(prisma?: PrismaService) {
    const svc = new UploadsService(storage, prisma);
    svc.videoStatfs = bigDisk;
    return svc;
  }

  async function tempUpload(buf: Buffer, name = 'clip.mp4') {
    const p = path.join(tmp, `${Math.random().toString(16).slice(2)}.upload`);
    await fs.writeFile(p, buf);
    return {
      path: p,
      originalname: name,
      size: buf.length,
    } as Express.Multer.File;
  }

  beforeEach(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-root-'));
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'video-tmp-'));
    process.env.UPLOAD_VIDEO_TMP_DIR = tmp;
    delete process.env.PRODUCT_VIDEO_UPLOADS;
    storage = PublicStorage.local(root);
  });
  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('stores a valid MP4 as products/<uuid>.mp4, records it and removes the temp file', async () => {
    const { prisma, rows } = prismaWith();
    const file = await tempUpload(
      buildMp4({ timescale: 1000, duration: 32_400 }).file,
    );
    const res = await service(prisma).uploadVideo(
      file,
      'products',
      user(UserRole.CREATOR),
    );
    expect(res).toMatchObject({
      content_type: 'video/mp4',
      duration_s: 32,
      width: 1920,
      height: 1080,
      faststart_fixed: false,
    });
    expect(res.url).toMatch(/^\/uploads\/products\/[0-9a-f-]{36}\.mp4$/);
    expect(await storage.exists(res.url)).toBe(true);
    expect(rows).toEqual([
      expect.objectContaining({
        key: res.url,
        user_id: 'u1',
        store_id: 's1',
        folder: 'products',
        content_type: 'video/mp4',
        size: res.size_bytes,
      }),
    ]);
    await expect(fs.access(file.path)).rejects.toThrow();
  });

  it('stores the faststart copy of a moov-at-end file and deletes both temp files', async () => {
    const { prisma } = prismaWith();
    const file = await tempUpload(buildMp4({ moovLast: true }).file);
    const res = await service(prisma).uploadVideo(
      file,
      'products',
      user(UserRole.PROVIDER),
    );
    expect(res.faststart_fixed).toBe(true);
    const stored = await fs.readFile(
      path.join(root, res.url.replace('/uploads/', '')),
    );
    expect(stored.toString('latin1', 28, 32)).toBe('moov');
    expect(await fs.readdir(tmp)).toEqual([]);
  });

  it('deletes the temp file on every error path (probe, extension, magic bytes)', async () => {
    const svc = service(prismaWith().prisma);
    const cases: Array<[Buffer, string, string]> = [
      [
        buildMp4({ major: 'qt  ', compat: ['qt  '] }).file,
        'a.mp4',
        'UPLOAD_VIDEO_TYPE',
      ],
      [
        buildMp4({ tracks: [{ handler: 'vide', codec: 'hvc1' }] }).file,
        'a.mp4',
        'UPLOAD_VIDEO_CODEC',
      ],
      [buildMp4().file, 'a.mov', 'UPLOAD_VIDEO_TYPE'],
      [
        Buffer.from('\x89PNG\r\n\x1a\n0000000000', 'latin1'),
        'a.mp4',
        'UPLOAD_VIDEO_TYPE',
      ],
    ];
    for (const [buf, name, code] of cases) {
      const file = await tempUpload(buf, name);
      const e = await caught(
        svc.uploadVideo(file, 'products', user(UserRole.CREATOR)),
      );
      expect(statusOf(e)).toBe(400);
      expect(bodyOf(e).code).toBe(code);
      await expect(fs.access(file.path)).rejects.toThrow();
    }
    expect(await fs.readdir(tmp)).toEqual([]);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('flag off → 503 PRODUCT_VIDEO_UPLOADS_DISABLED (precheck and service; temp removed)', async () => {
    process.env.PRODUCT_VIDEO_UPLOADS = '0';
    const svc = service(prismaWith().prisma);
    const e1 = await caught(
      svc.assertVideoPrecheck(user(UserRole.CREATOR), 'products', 10),
    );
    expect(statusOf(e1)).toBe(503);
    expect(bodyOf(e1).code).toBe('PRODUCT_VIDEO_UPLOADS_DISABLED');
    const file = await tempUpload(buildMp4().file);
    const e2 = await caught(
      svc.uploadVideo(file, 'products', user(UserRole.CREATOR)),
    );
    expect(statusOf(e2)).toBe(503);
    await expect(fs.access(file.path)).rejects.toThrow();
    const cfg = await svc.videoConfig(user(UserRole.CREATOR));
    expect(cfg.uploads_enabled).toBe(false);
  });

  it('refuses CUSTOMER accounts and other folders with UPLOAD_FOLDER_FORBIDDEN', async () => {
    const svc = service(prismaWith().prisma);
    for (const [role, folder] of [
      [UserRole.CUSTOMER, 'products'],
      [UserRole.CREATOR, 'logos'],
      [UserRole.ADMIN, 'general'],
    ] as const) {
      const e = await caught(svc.assertVideoPrecheck(user(role), folder, 10));
      expect(statusOf(e)).toBe(403);
      expect(bodyOf(e).code).toBe('UPLOAD_FOLDER_FORBIDDEN');
    }
    const anon = await caught(
      svc.assertVideoPrecheck(undefined, 'products', 10),
    );
    expect(statusOf(anon)).toBe(403);
  });

  it('Content-Length above the limit → 413 UPLOAD_VIDEO_TOO_LARGE before the body', async () => {
    process.env.UPLOAD_VIDEO_MAX_BYTES = String(1024 * 1024);
    const svc = service(prismaWith().prisma);
    await expect(
      svc.assertVideoPrecheck(
        user(UserRole.CREATOR),
        'products',
        1024 * 1024 + 1000,
      ),
    ).resolves.toBeUndefined();
    const e = await caught(
      svc.assertVideoPrecheck(
        user(UserRole.CREATOR),
        'products',
        2 * 1024 * 1024,
      ),
    );
    expect(statusOf(e)).toBe(413);
    expect(bodyOf(e)).toMatchObject({
      code: 'UPLOAD_VIDEO_TOO_LARGE',
      maxBytes: 1024 * 1024,
    });
  });

  it('disk guard → 507 when free space would drop below the reserve, and fails closed', async () => {
    process.env.PRODUCT_VIDEO_MIN_FREE_BYTES = String(1000);
    const svc = service(prismaWith().prisma);
    svc.videoStatfs = () => Promise.resolve({ bavail: 1500, bsize: 1 });
    await expect(
      svc.assertVideoPrecheck(user(UserRole.CREATOR), 'products', 400),
    ).resolves.toBeUndefined();
    const low = await caught(
      svc.assertVideoPrecheck(user(UserRole.CREATOR), 'products', 600),
    );
    expect(statusOf(low)).toBe(507);
    expect(bodyOf(low).code).toBe('UPLOAD_VIDEO_DISK_LOW');
    svc.videoStatfs = () =>
      Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }));
    const broken = await caught(
      svc.assertVideoPrecheck(user(UserRole.CREATOR), 'products', 1),
    );
    expect(statusOf(broken)).toBe(507);
  });

  it('quota → 403 UPLOAD_VIDEO_QUOTA_EXCEEDED; counts referenced or < 24 h files of the store only', async () => {
    process.env.PRODUCT_VIDEO_STORE_QUOTA_BYTES = String(1000);
    const { prisma, raw } = prismaWith({ used: 900 });
    const svc = service(prisma);
    await expect(
      svc.assertVideoPrecheck(user(UserRole.CREATOR), 'products', 100),
    ).resolves.toBeUndefined();
    const e = await caught(
      svc.assertVideoPrecheck(user(UserRole.CREATOR), 'products', 101),
    );
    expect(statusOf(e)).toBe(403);
    expect(bodyOf(e)).toMatchObject({
      code: 'UPLOAD_VIDEO_QUOTA_EXCEEDED',
      quotaBytes: 1000,
      usedBytes: 900,
    });
    // An unreferenced file older than 24 h is not counted (SQL rule) and the
    // scope is the creator's store.
    const call = raw.mock.calls.find((c) =>
      (c[0] as unknown as string[]).join('?').includes('SUM(uf."size")'),
    ) as unknown[];
    const sql = (call[0] as string[]).join('?');
    expect(sql).toContain('uf."store_id" = ?');
    expect(sql).toContain(
      'EXISTS (SELECT 1 FROM "ProductVideo" pv WHERE pv."url" = uf."key")',
    );
    // Customer-story videos share the quota with gallery videos, also when
    // they are older than 24 h (referenced).
    expect(sql).toContain(
      'OR EXISTS (SELECT 1 FROM "ProductStory" ps WHERE ps."url" = uf."key")',
    );
    expect(sql).toContain(`uf."created_at" > now() - interval '24 hours'`);
    expect(call.slice(1)).toEqual(['video/mp4', 's1']);
  });

  it('parallel uploads: in-progress bytes count against the quota and the disk, and are released', async () => {
    process.env.PRODUCT_VIDEO_STORE_QUOTA_BYTES = String(1000);
    process.env.PRODUCT_VIDEO_MIN_FREE_BYTES = String(1000);
    const svc = service(prismaWith({ used: 500 }).prisma);
    svc.videoStatfs = () => Promise.resolve({ bavail: 2000, bsize: 1 });
    // Another upload of the same store (s:s1) holds 400 bytes in flight.
    const release = UploadsService.videoInflight.reserve('s:s1', 400);
    try {
      const quota = await caught(
        svc.assertVideoPrecheck(user(UserRole.CREATOR), 'products', 200),
      );
      expect(bodyOf(quota)).toMatchObject({
        code: 'UPLOAD_VIDEO_QUOTA_EXCEEDED',
        usedBytes: 900,
      });
      // The disk guard adds every upload in flight (any store).
      const disk = await caught(
        svc.assertVideoPrecheck(user(UserRole.PROVIDER, 'p9'), 'products', 700),
      );
      expect(bodyOf(disk).code).toBe('UPLOAD_VIDEO_DISK_LOW');
    } finally {
      release();
    }
    expect(UploadsService.videoInflight.bytes()).toBe(0);
    await expect(
      svc.assertVideoPrecheck(user(UserRole.CREATOR), 'products', 200),
    ).resolves.toBeUndefined();
  });

  it('checks room for two copies before the faststart rewrite, and releases its reservation', async () => {
    const file = await tempUpload(buildMp4({ moovLast: true }).file);
    const size = (await fs.stat(file.path)).size;
    process.env.PRODUCT_VIDEO_MIN_FREE_BYTES = String(1000);
    const svc = service(prismaWith().prisma);
    // Room for one copy but not two.
    svc.videoStatfs = () =>
      Promise.resolve({ bavail: 1000 + size + 10, bsize: 1 });
    const e = await caught(
      svc.uploadVideo(file, 'products', user(UserRole.CREATOR)),
    );
    expect(bodyOf(e).code).toBe('UPLOAD_VIDEO_DISK_LOW');
    expect(await fs.readdir(tmp)).toEqual([]);
    expect(UploadsService.videoInflight.bytes()).toBe(0);
  });

  it('quota: providers are scoped by user, ADMIN is exempt (quota_bytes null)', async () => {
    process.env.PRODUCT_VIDEO_STORE_QUOTA_BYTES = String(10);
    const { prisma, raw } = prismaWith({ used: 10_000 });
    const svc = service(prisma);
    await expect(
      svc.assertVideoPrecheck(user(UserRole.ADMIN), 'products', 5000),
    ).resolves.toBeUndefined();
    expect(
      (await svc.videoConfig(user(UserRole.ADMIN))).quota_bytes,
    ).toBeNull();
    const e = await caught(
      svc.assertVideoPrecheck(user(UserRole.PROVIDER, 'p9'), 'products', 1),
    );
    expect(statusOf(e)).toBe(403);
    const sql = (raw.mock.calls.at(-1)?.[0] as unknown as string[]).join('?');
    expect(sql).toContain('uf."user_id" = ?');
    expect(raw.mock.calls.at(-1)?.slice(1)).toEqual(['video/mp4', 'p9']);
  });

  it('GET /uploads/video/config shape', async () => {
    const { prisma } = prismaWith({ used: 12345 });
    const cfg = await service(prisma).videoConfig(user(UserRole.CREATOR));
    expect(cfg).toEqual({
      uploads_enabled: true,
      max_bytes: 52428800,
      max_duration_s: 60,
      max_kbps: 8000,
      max_videos_per_product: 3,
      accept: ['video/mp4'],
      quota_bytes: 314572800,
      used_bytes: 12345,
    });
  });

  it('a failed UploadedFile write removes the stored video (no untracked files)', async () => {
    const { prisma } = prismaWith({ upsertFails: true });
    const file = await tempUpload(buildMp4().file);
    await expect(
      service(prisma).uploadVideo(file, 'products', user(UserRole.CREATOR)),
    ).rejects.toThrow('db down');
    const products = path.join(root, 'products');
    const left = await fs.readdir(products).catch(() => []);
    expect(left.filter((f) => f.endsWith('.mp4'))).toEqual([]);
    expect(await fs.readdir(tmp)).toEqual([]);
  });

  it('the upload route carries @Throttle(10 / 10 min) and the link route 30 / 10 min', () => {
    const handler = (name: string): object =>
      Object.getOwnPropertyDescriptor(UploadsController.prototype, name)
        ?.value as object;
    const upload = handler('uploadVideo');
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, upload)).toBe(10);
    expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, upload)).toBe(
      600_000,
    );
    const link = handler('videoLink');
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, link)).toBe(30);
  });

  it('the interceptor rejects before reading the body when the precheck fails', async () => {
    const assertVideoPrecheck = jest
      .fn()
      .mockRejectedValue(
        new HttpException({ code: 'UPLOAD_VIDEO_DISK_LOW' }, 507),
      );
    const interceptor = new VideoUploadInterceptor({
      assertVideoPrecheck,
    } as unknown as UploadsService);
    const req = {
      query: { folder: 'products' },
      headers: { 'content-length': '123' },
      user: user(UserRole.CREATOR),
      pipe: jest.fn(),
      on: jest.fn(),
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
    } as never;
    const handle = jest.fn(() => of('x'));
    const e = await caught(interceptor.intercept(ctx, { handle }));
    expect(statusOf(e)).toBe(507);
    expect(assertVideoPrecheck).toHaveBeenCalledWith(req.user, 'products', 123);
    expect(handle).not.toHaveBeenCalled();
    expect(req.pipe).not.toHaveBeenCalled();
    expect(req.on).not.toHaveBeenCalled();
  });
});
