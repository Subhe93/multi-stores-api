import { UserRole } from '@prisma/client';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PrismaService } from '../../prisma/prisma.service';
import { PublicStorage } from '../storage/public-storage';
import { UploadsService } from './uploads.service';

const user = (role: UserRole, id = 'u1') =>
  ({ id, role, email: 'x@y', status: 'ACTIVE', storeId: null }) as never;

describe('video ownership and reference counting', () => {
  const VIDEO = '/uploads/products/00000000-0000-4000-8000-0000000000aa.mp4';
  let root: string;
  let storage: PublicStorage;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-own-'));
    storage = PublicStorage.local(root);
    await storage.put('products', path.basename(VIDEO), Buffer.from('v'));
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  /** `found` decides per SQL text which raw queries report a reference. */
  function prismaWith(found: (sql: string, values: unknown[]) => boolean) {
    return {
      user: { findUnique: jest.fn().mockResolvedValue({ avatar_url: null }) },
      creator: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'c1',
          avatar_url: null,
          cover_url: null,
          store: { id: 's1', logo_url: null, favicon_url: null },
        }),
      },
      provider: { findUnique: jest.fn().mockResolvedValue(null) },
      productImage: { findFirst: jest.fn().mockResolvedValue(null) },
      customProductImage: { findFirst: jest.fn().mockResolvedValue(null) },
      creatorCategory: { findFirst: jest.fn().mockResolvedValue(null) },
      storeLegalProfile: { findFirst: jest.fn().mockResolvedValue(null) },
      importMedia: { findFirst: jest.fn().mockResolvedValue(null) },
      uploadedFile: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ user_id: 'u1', store_id: 's1' }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: jest.fn(
        (strings: TemplateStringsArray, ...values: unknown[]) =>
          Promise.resolve(
            found(strings.join('?'), values) ? [{ found: 1 }] : [],
          ),
      ),
    } as unknown as PrismaService;
  }

  const sqlOf = (prisma: PrismaService, call = 0) =>
    (prisma.$queryRaw as unknown as jest.Mock<unknown, [string[]]>).mock.calls[
      call
    ][0].join('?');

  it('the uploader deletes their own video when no other account uses it', async () => {
    const svc = new UploadsService(
      storage,
      prismaWith(() => false),
    );
    await svc.deleteOwnedFile(VIDEO, user(UserRole.CREATOR));
    expect(await storage.exists(VIDEO)).toBe(false);
  });

  it('a video another store references (duplicate copy, provider product) is protected', async () => {
    const prisma = prismaWith(
      (sql) =>
        sql.includes('FROM "ProductVideo" v JOIN "Product" pr') &&
        sql.includes('IS DISTINCT FROM'),
    );
    const svc = new UploadsService(storage, prisma);
    await expect(
      svc.deleteOwnedFile(VIDEO, user(UserRole.CREATOR)),
    ).rejects.toMatchObject({ response: { code: 'UPLOAD_NOT_OWNED' } });
    expect(await storage.exists(VIDEO)).toBe(true);
  });

  it('isReferencedByOthers checks ProductVideo url and poster_url of other owners', async () => {
    const prisma = prismaWith(() => false);
    const svc = new UploadsService(storage, prisma);
    await svc.isReferencedByOthers(VIDEO, user(UserRole.CREATOR));
    const sql = sqlOf(prisma);
    expect(sql).toContain(
      'FROM "ProductVideo" v JOIN "Product" pr ON pr."id" = v."product_id"',
    );
    expect(sql).toContain('v."poster_url" LIKE');
  });

  it("isOwnedBy: a video or poster on the caller's own product counts as owned", async () => {
    const creatorSvc = new UploadsService(
      storage,
      prismaWith((sql) => sql.includes('pr."creator_id" = ?')),
    );
    expect(await creatorSvc.isOwnedBy(VIDEO, user(UserRole.CREATOR))).toBe(
      true,
    );

    const providerPrisma = prismaWith(
      (sql, values) =>
        sql.includes('pr."provider_id" = ?') && values.includes('p1'),
    );
    (providerPrisma.provider.findUnique as jest.Mock).mockResolvedValue({
      id: 'p1',
      logo_url: null,
    });
    const providerSvc = new UploadsService(storage, providerPrisma);
    expect(await providerSvc.isOwnedBy(VIDEO, user(UserRole.PROVIDER))).toBe(
      true,
    );

    const none = new UploadsService(
      storage,
      prismaWith(() => false),
    );
    expect(await none.isOwnedBy(VIDEO, user(UserRole.CREATOR))).toBe(false);
  });

  it('a customer-story video of another store is protected', async () => {
    const prisma = prismaWith(
      (sql) =>
        sql.includes('FROM "ProductStory" st JOIN "Product" pr') &&
        sql.includes('IS DISTINCT FROM'),
    );
    const svc = new UploadsService(storage, prisma);
    await expect(
      svc.deleteOwnedFile(VIDEO, user(UserRole.CREATOR)),
    ).rejects.toMatchObject({ response: { code: 'UPLOAD_NOT_OWNED' } });
    expect(await storage.exists(VIDEO)).toBe(true);
    const sql = sqlOf(prisma);
    expect(sql).toContain(
      'FROM "ProductStory" st JOIN "Product" pr ON pr."id" = st."product_id"',
    );
    expect(sql).toContain('st."poster_url" LIKE');
  });

  it("isOwnedBy: story media on the caller's own product counts as owned", async () => {
    const prisma = prismaWith(
      (sql) =>
        sql.includes('FROM "ProductStory" st JOIN "Product" pr') &&
        sql.includes('pr."creator_id" = ?'),
    );
    const svc = new UploadsService(storage, prisma);
    expect(await svc.isOwnedBy(VIDEO, user(UserRole.CREATOR))).toBe(true);
  });

  it('isReferencedAnywhere covers product videos, images, descriptions and page JSON', async () => {
    const prisma = prismaWith(() => true);
    const svc = new UploadsService(storage, prisma);
    expect(await svc.isReferencedAnywhere(VIDEO)).toBe(true);
    const sql = sqlOf(prisma);
    for (const t of [
      '"ProductVideo"',
      '"ProductStory"',
      '"ProductImage"',
      '"CustomProductImage"',
      '"ProductTranslation"',
      '"PageSection"',
      '"PageVersion"',
      '"ImportMedia"',
    ]) {
      expect(sql).toContain(t);
    }
  });
});
