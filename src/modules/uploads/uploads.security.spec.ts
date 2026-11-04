import {
  BadRequestException,
  ForbiddenException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import type { PrismaService } from '../../prisma/prisma.service';
import { PublicStorage } from '../storage/public-storage';
import { lastValueFrom, throwError } from 'rxjs';
import { sniffUploadType } from './upload-sniff';
import { uploadLimit } from './upload-limit.interceptor';
import { UploadsController } from './uploads.controller';
import { folderAllowedForRole, UploadsService } from './uploads.service';

const user = (role: UserRole, id = 'u1') =>
  ({ id, role, email: 'x@y', status: 'ACTIVE', storeId: null }) as never;

describe('upload magic-byte sniff', () => {
  it('matches the accepted formats and nothing else', async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#000' },
    })
      .png()
      .toBuffer();
    const jpg = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#000' },
    })
      .jpeg()
      .toBuffer();
    const webp = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#000' },
    })
      .webp()
      .toBuffer();
    expect(sniffUploadType(png, '.png')).toBe(true);
    expect(sniffUploadType(jpg, '.jpg')).toBe(true);
    expect(sniffUploadType(jpg, '.jpeg')).toBe(true);
    expect(sniffUploadType(webp, '.webp')).toBe(true);
    expect(sniffUploadType(png, '.jpg')).toBe(false);
    expect(sniffUploadType(jpg, '.png')).toBe(false);
    expect(sniffUploadType(Buffer.from('%PDF-1.7 x'), '.pdf')).toBe(true);
    expect(sniffUploadType(Buffer.from('junk\n%PDF-1.4'), '.pdf')).toBe(true);
    expect(sniffUploadType(Buffer.from('%PDF-1.7'), '.ai')).toBe(true);
    expect(sniffUploadType(Buffer.from('%!PS-Adobe-3.0'), '.ai')).toBe(true);
    expect(sniffUploadType(Buffer.from('<svg xmlns="x"></svg>'), '.svg')).toBe(
      true,
    );
    expect(
      sniffUploadType(
        Buffer.from(
          '﻿<?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE svg>\n<svg/>',
        ),
        '.svg',
      ),
    ).toBe(true);
    expect(
      sniffUploadType(Buffer.from('<html><script>x</script></html>'), '.svg'),
    ).toBe(false);
    expect(sniffUploadType(Buffer.from('MZ\0\0'), '.svg')).toBe(false);
    expect(sniffUploadType(Buffer.from('MZ'), '.png')).toBe(false);
    expect(sniffUploadType(png, '.exe')).toBe(false);
  });
});

describe('per-role folder allowlist', () => {
  it('matches SPEC "Security fixes"', () => {
    expect(folderAllowedForRole(UserRole.ADMIN, 'anything')).toBe(true);
    for (const f of [
      'products',
      'custom-products',
      'avatars',
      'logos',
      'favicons',
      'page-blocks',
      'page-seo',
      'store-hero',
      'creator-categories',
      'custom-fields',
      'general',
    ]) {
      expect(folderAllowedForRole(UserRole.CREATOR, f)).toBe(true);
    }
    expect(folderAllowedForRole(UserRole.CREATOR, 'imports')).toBe(false);
    expect(folderAllowedForRole(UserRole.CREATOR, 'customer-previews')).toBe(
      false,
    );
    expect(folderAllowedForRole(UserRole.PROVIDER, 'products')).toBe(true);
    expect(folderAllowedForRole(UserRole.PROVIDER, 'logos')).toBe(true);
    expect(folderAllowedForRole(UserRole.PROVIDER, 'avatars')).toBe(true);
    expect(folderAllowedForRole(UserRole.PROVIDER, 'page-blocks')).toBe(false);
    expect(folderAllowedForRole(UserRole.CUSTOMER, 'general')).toBe(false);
  });

  it('the controller refuses forbidden folders before touching the service', () => {
    const uploadFile = jest
      .fn()
      .mockResolvedValue({ url: '/uploads/products/x.webp' });
    const controller = new UploadsController({
      uploadFile,
    } as unknown as UploadsService);
    const file = {
      originalname: 'a.png',
      buffer: Buffer.alloc(1),
      size: 1,
    } as Express.Multer.File;
    expect(() =>
      controller.upload(file, user(UserRole.CUSTOMER), 'products'),
    ).toThrow(ForbiddenException);
    expect(() =>
      controller.upload(file, user(UserRole.PROVIDER), 'page-blocks'),
    ).toThrow(ForbiddenException);
    expect(() =>
      controller.upload(file, user(UserRole.CREATOR), '../imports'),
    ).toThrow(ForbiddenException);
    expect(uploadFile).not.toHaveBeenCalled();
    const creatorUser = user(UserRole.CREATOR);
    void controller.upload(file, creatorUser, 'products');
    expect(uploadFile).toHaveBeenLastCalledWith(file, 'products', creatorUser);
    void controller.upload(file, creatorUser, undefined);
    expect(uploadFile).toHaveBeenLastCalledWith(file, 'general', creatorUser);
    const adminUser = user(UserRole.ADMIN);
    void controller.upload(file, adminUser, 'imports');
    expect(uploadFile).toHaveBeenLastCalledWith(file, 'imports', adminUser);
    expect(controller).not.toHaveProperty('uploadPublic');
  });
});

describe('uploadFile sniff + size', () => {
  let root: string;
  let service: UploadsService;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'upl-sec-'));
    service = new UploadsService(PublicStorage.local(root));
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it('refuses content that does not match the extension', async () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    await expect(
      service.uploadFile({
        originalname: 'x.svg',
        buffer: html,
        size: html.length,
      } as Express.Multer.File),
    ).rejects.toMatchObject({ response: { code: 'UPLOAD_TYPE_MISMATCH' } });
    const exe = Buffer.from('MZ\0\0');
    await expect(
      service.uploadFile({
        originalname: 'x.png',
        buffer: exe,
        size: exe.length,
      } as Express.Multer.File),
    ).rejects.toMatchObject({ response: { code: 'UPLOAD_TYPE_MISMATCH' } });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('refuses buffers over 50 MB even when `size` lies', async () => {
    const big = Buffer.alloc(50 * 1024 * 1024 + 1, 1);
    await expect(
      service.uploadFile({
        originalname: 'x.pdf',
        buffer: big,
        size: 1,
      } as Express.Multer.File),
    ).rejects.toMatchObject({ response: { code: 'UPLOAD_FILE_TOO_LARGE' } });
  });
});

describe('DELETE ownership', () => {
  let root: string;
  let storage: PublicStorage;

  const REL = '/uploads/products/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp';
  const ABS = `https://api.example.com${REL}`;

  function prismaWith(rows: {
    user?: { avatar_url: string | null };
    creator?: {
      id: string;
      avatar_url: string | null;
      cover_url: string | null;
      store: {
        id: string;
        logo_url: string | null;
        favicon_url: string | null;
      } | null;
    } | null;
    provider?: { id: string; logo_url: string | null } | null;
    productImages?: Array<{
      url: string;
      creator_id?: string;
      provider_id?: string;
    }>;
    customProductImages?: Array<{ url: string; creator_id: string }>;
    categories?: Array<{ thumbnail_url: string; creator_id: string }>;
    legal?: Array<{ logo_url: string; store_id: string }>;
    importMedia?: Array<{ public_url: string; store_id: string }>;
    pageJson?: boolean;
    uploaded?: Array<{
      key: string;
      user_id: string | null;
      store_id: string | null;
    }>;
  }) {
    const uploaded = rows.uploaded ?? [];
    const ends = (v: string | null | undefined, w: { endsWith: string }) =>
      typeof v === 'string' && v.endsWith(w.endsWith);
    return {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue(rows.user ?? { avatar_url: null }),
      },
      creator: {
        findUnique: jest.fn().mockResolvedValue(rows.creator ?? null),
      },
      provider: {
        findUnique: jest.fn().mockResolvedValue(rows.provider ?? null),
      },
      productImage: {
        findFirst: jest.fn(
          async (q: {
            where: {
              url: { endsWith: string };
              product: { creator_id?: string; provider_id?: string };
            };
          }) =>
            (rows.productImages ?? []).find(
              (r) =>
                ends(r.url, q.where.url) &&
                (q.where.product.creator_id
                  ? r.creator_id === q.where.product.creator_id
                  : r.provider_id === q.where.product.provider_id),
            ) ?? null,
        ),
      },
      customProductImage: {
        findFirst: jest.fn(
          async (q: {
            where: {
              url: { endsWith: string };
              custom_product: { creator_id: string };
            };
          }) =>
            (rows.customProductImages ?? []).find(
              (r) =>
                ends(r.url, q.where.url) &&
                r.creator_id === q.where.custom_product.creator_id,
            ) ?? null,
        ),
      },
      creatorCategory: {
        findFirst: jest.fn(
          async (q: {
            where: { thumbnail_url: { endsWith: string }; creator_id: string };
          }) =>
            (rows.categories ?? []).find(
              (r) =>
                ends(r.thumbnail_url, q.where.thumbnail_url) &&
                r.creator_id === q.where.creator_id,
            ) ?? null,
        ),
      },
      storeLegalProfile: {
        findFirst: jest.fn(
          async (q: {
            where: { logo_url: { endsWith: string }; store_id: string };
          }) =>
            (rows.legal ?? []).find(
              (r) =>
                ends(r.logo_url, q.where.logo_url) &&
                r.store_id === q.where.store_id,
            ) ?? null,
        ),
      },
      importMedia: {
        findFirst: jest.fn(
          async (q: {
            where: { public_url: { endsWith: string }; store_id: string };
          }) =>
            (rows.importMedia ?? []).find(
              (r) =>
                ends(r.public_url, q.where.public_url) &&
                r.store_id === q.where.store_id,
            ) ?? null,
        ),
      },
      uploadedFile: {
        findUnique: jest.fn((q: { where: { key: string } }) =>
          Promise.resolve(uploaded.find((r) => r.key === q.where.key) ?? null),
        ),
        upsert: jest.fn(
          (q: {
            where: { key: string };
            create: { key: string; user_id: string; store_id: string | null };
          }) => {
            const i = uploaded.findIndex((r) => r.key === q.where.key);
            if (i >= 0) uploaded.splice(i, 1);
            uploaded.push(q.create);
            return Promise.resolve(q.create);
          },
        ),
        deleteMany: jest.fn((q: { where: { key: string } }) => {
          const before = uploaded.length;
          for (let i = uploaded.length - 1; i >= 0; i--) {
            if (uploaded[i].key === q.where.key) uploaded.splice(i, 1);
          }
          return Promise.resolve({ count: before - uploaded.length });
        }),
      },
      $queryRaw: jest
        .fn()
        .mockResolvedValue(rows.pageJson ? [{ found: 1 }] : []),
    } as unknown as PrismaService;
  }

  type UploadedFileMock = Record<
    'findUnique' | 'upsert' | 'deleteMany',
    jest.Mock
  >;
  const uploadedOf = (prisma: PrismaService) =>
    prisma.uploadedFile as unknown as UploadedFileMock;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'upl-own-'));
    storage = PublicStorage.local(root);
    await storage.put('products', path.basename(REL), Buffer.from('x'));
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  const creator = (store = true) => ({
    id: 'c1',
    avatar_url: null,
    cover_url: null,
    store: store ? { id: 's1', logo_url: null, favicon_url: null } : null,
  });

  it('ADMIN deletes anything; CUSTOMER never', async () => {
    const admin = new UploadsService(storage, prismaWith({}));
    await admin.deleteOwnedFile(REL, user(UserRole.ADMIN));
    expect(await storage.exists(REL)).toBe(false);
    await storage.put('products', path.basename(REL), Buffer.from('x'));
    const svc = new UploadsService(
      storage,
      prismaWith({ productImages: [{ url: REL }] }),
    );
    await expect(
      svc.deleteOwnedFile(REL, user(UserRole.CUSTOMER)),
    ).rejects.toMatchObject({
      response: { code: 'UPLOAD_NOT_OWNED' },
    });
    expect(await storage.exists(REL)).toBe(true);
  });

  it('CREATOR: a file referenced by an owned record (absolute URL too) is deletable', async () => {
    const owned = new UploadsService(
      storage,
      prismaWith({
        creator: creator(),
        productImages: [{ url: ABS, creator_id: 'c1' }],
      }),
    );
    await owned.deleteOwnedFile(ABS, user(UserRole.CREATOR));
    expect(await storage.exists(REL)).toBe(false);

    await storage.put('products', path.basename(REL), Buffer.from('x'));
    const other = new UploadsService(
      storage,
      prismaWith({
        creator: creator(),
        productImages: [{ url: ABS, creator_id: 'c2' }],
      }),
    );
    await expect(
      other.deleteOwnedFile(REL, user(UserRole.CREATOR)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await storage.exists(REL)).toBe(true);
  });

  it('CREATOR: an owned reference does not allow deleting a file another account still uses', async () => {
    // Store B pasted store A's image URL into its own product: B "owns" a
    // reference, but A's record still points at the file.
    const prisma = prismaWith({
      creator: creator(),
      productImages: [{ url: REL, creator_id: 'c1' }],
    });
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ found: 1 }]);
    const svc = new UploadsService(storage, prisma);
    await expect(
      svc.deleteOwnedFile(REL, user(UserRole.CREATOR)),
    ).rejects.toMatchObject({ response: { code: 'UPLOAD_NOT_OWNED' } });
    expect(await storage.exists(REL)).toBe(true);
  });

  it('isReferencedByOthers escapes LIKE wildcards and excludes the caller', async () => {
    const prisma = prismaWith({ creator: creator() });
    const raw = (prisma as unknown as { $queryRaw: jest.Mock<unknown[]> })
      .$queryRaw;
    const svc = new UploadsService(storage, prisma);
    expect(
      await svc.isReferencedByOthers(
        '/uploads/products/a_b%.webp',
        user(UserRole.CREATOR),
      ),
    ).toBe(false);
    const values = (raw.mock.calls[0] as unknown[]).slice(1);
    expect(values).toContain(String.raw`%/uploads/products/a\_b\%.webp`);
    expect(values).toContain(String.raw`%/uploads/products/a\_b\%.webp%`);
  });

  it('CREATOR: store logo, legal logo, categories, custom products, imports, page JSON, kit folder', async () => {
    const cases = [
      {
        creator: {
          ...creator(),
          store: { id: 's1', logo_url: REL, favicon_url: null },
        },
      },
      { creator: { ...creator(), avatar_url: ABS } },
      { creator: creator(), legal: [{ logo_url: REL, store_id: 's1' }] },
      {
        creator: creator(),
        categories: [{ thumbnail_url: ABS, creator_id: 'c1' }],
      },
      {
        creator: creator(),
        customProductImages: [{ url: REL, creator_id: 'c1' }],
      },
      {
        creator: creator(),
        importMedia: [{ public_url: REL, store_id: 's1' }],
      },
      { creator: creator(), pageJson: true },
      { user: { avatar_url: REL } },
    ];
    for (const rows of cases) {
      const svc = new UploadsService(storage, prismaWith(rows as never));
      expect(await svc.isOwnedBy(REL, user(UserRole.CREATOR))).toBe(true);
    }
    const none = new UploadsService(
      storage,
      prismaWith({ creator: creator() }),
    );
    expect(await none.isOwnedBy(REL, user(UserRole.CREATOR))).toBe(false);
    expect(
      await none.isOwnedBy(
        '/uploads/template-imports/s1/k.png',
        user(UserRole.CREATOR),
      ),
    ).toBe(true);
    expect(
      await none.isOwnedBy(
        '/uploads/template-imports/s2/k.png',
        user(UserRole.CREATOR),
      ),
    ).toBe(false);
  });

  it('PROVIDER: own logo or own product images only', async () => {
    const svc = new UploadsService(
      storage,
      prismaWith({
        provider: { id: 'p1', logo_url: null },
        productImages: [{ url: REL, provider_id: 'p1' }],
      }),
    );
    expect(await svc.isOwnedBy(REL, user(UserRole.PROVIDER))).toBe(true);
    const logo = new UploadsService(
      storage,
      prismaWith({ provider: { id: 'p1', logo_url: ABS } }),
    );
    expect(await logo.isOwnedBy(REL, user(UserRole.PROVIDER))).toBe(true);
    const nope = new UploadsService(
      storage,
      prismaWith({ provider: { id: 'p1', logo_url: null } }),
    );
    expect(await nope.isOwnedBy(REL, user(UserRole.PROVIDER))).toBe(false);
  });

  describe('recorded uploader (UploadedFile)', () => {
    const row = (user_id: string | null, store_id: string | null) => ({
      key: REL,
      user_id,
      store_id,
    });
    const creatorIn = (storeId: string, id = 'c1') => ({
      id,
      avatar_url: null,
      cover_url: null,
      store: { id: storeId, logo_url: null, favicon_url: null },
    });

    it('records the uploader and a creator store on upload', async () => {
      const prisma = prismaWith({ creator: creatorIn('s1') });
      const svc = new UploadsService(storage, prisma);
      const png = await sharp({
        create: { width: 2, height: 2, channels: 3, background: '#000' },
      })
        .png()
        .toBuffer();
      const out = await svc.uploadFile(
        {
          originalname: 'a.png',
          buffer: png,
          size: png.length,
        } as Express.Multer.File,
        'products',
        user(UserRole.CREATOR, 'u1'),
      );
      const upsert = uploadedOf(prisma).upsert;
      expect(upsert).toHaveBeenCalledTimes(1);
      const [arg] = upsert.mock.calls[0] as [
        {
          where: { key: string };
          create: Record<string, unknown>;
        },
      ];
      expect(out.url.endsWith(arg.where.key)).toBe(true);
      expect(arg.where.key).toMatch(/^\/uploads\/products\/[0-9a-f-]+\.webp$/);
      expect(arg.create).toMatchObject({
        key: arg.where.key,
        user_id: 'u1',
        store_id: 's1',
        folder: 'products',
        content_type: 'image/webp',
        size: out.file_size,
      });

      // Non-creators have no store; a buffer without an uploader is not recorded.
      const provider = prismaWith({});
      const psvc = new UploadsService(storage, provider);
      await psvc.storeBuffer(Buffer.from('%PDF-1.7'), '.pdf', 'logos', {
        uploader: user(UserRole.PROVIDER, 'p-user'),
      });
      const providerCall = uploadedOf(provider).upsert.mock.calls[0] as [
        { create: Record<string, unknown> },
      ];
      expect(providerCall[0].create).toMatchObject({
        user_id: 'p-user',
        store_id: null,
        content_type: 'application/pdf',
      });
      await psvc.storeBuffer(Buffer.from('%PDF-1.7'), '.pdf', 'general');
      expect(uploadedOf(provider).upsert).toHaveBeenCalledTimes(1);
    });

    it('a recording failure does not fail the upload', async () => {
      const prisma = prismaWith({});
      uploadedOf(prisma).upsert.mockRejectedValue(new Error('db down'));
      const svc = new UploadsService(storage, prisma);
      const out = await svc.storeBuffer(
        Buffer.from('%PDF-1.7'),
        '.pdf',
        'general',
        {
          uploader: user(UserRole.ADMIN),
        },
      );
      expect(await storage.exists(out.url)).toBe(true);
    });

    it('the uploader deletes their own file, and the row is removed', async () => {
      const prisma = prismaWith({
        creator: creatorIn('s1'),
        uploaded: [row('u1', 's1')],
      });
      const svc = new UploadsService(storage, prisma);
      await svc.deleteOwnedFile(ABS, user(UserRole.CREATOR, 'u1'));
      expect(await storage.exists(REL)).toBe(false);
      expect(uploadedOf(prisma).deleteMany).toHaveBeenCalledWith({
        where: { key: REL },
      });
      expect(
        await uploadedOf(prisma).findUnique({ where: { key: REL } }),
      ).toBeNull();
    });

    it('the uploader (no reference needed) is still refused while another account uses the file', async () => {
      const prisma = prismaWith({
        provider: { id: 'p1', logo_url: null },
        uploaded: [row('u1', null)],
      });
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ found: 1 }]);
      const svc = new UploadsService(storage, prisma);
      await expect(
        svc.deleteOwnedFile(REL, user(UserRole.PROVIDER, 'u1')),
      ).rejects.toMatchObject({ response: { code: 'UPLOAD_NOT_OWNED' } });
      expect(await storage.exists(REL)).toBe(true);
      expect(uploadedOf(prisma).deleteMany).not.toHaveBeenCalled();
    });

    it('another creator cannot delete it even when their own record references it', async () => {
      const prisma = prismaWith({
        creator: creatorIn('s2', 'c2'),
        productImages: [{ url: REL, creator_id: 'c2' }],
        uploaded: [row('u1', 's1')],
      });
      const svc = new UploadsService(storage, prisma);
      await expect(
        svc.deleteOwnedFile(REL, user(UserRole.CREATOR, 'u2')),
      ).rejects.toMatchObject({ response: { code: 'UPLOAD_NOT_OWNED' } });
      expect(await storage.exists(REL)).toBe(true);
      expect(uploadedOf(prisma).deleteMany).not.toHaveBeenCalled();
    });

    it('a CREATOR of the same store may delete it; a PROVIDER or CUSTOMER may not', async () => {
      // Uploaded by another account (or the uploader was deleted) for store s1.
      for (const uploader of ['someone-else', null]) {
        await storage.put('products', path.basename(REL), Buffer.from('x'));
        const prisma = prismaWith({
          creator: creatorIn('s1'),
          uploaded: [row(uploader, 's1')],
        });
        const svc = new UploadsService(storage, prisma);
        await svc.deleteOwnedFile(REL, user(UserRole.CREATOR, 'u1'));
        expect(await storage.exists(REL)).toBe(false);
      }
      await storage.put('products', path.basename(REL), Buffer.from('x'));
      for (const role of [UserRole.PROVIDER, UserRole.CUSTOMER]) {
        const prisma = prismaWith({
          creator: creatorIn('s1'),
          provider: { id: 'p1', logo_url: REL },
          uploaded: [row('someone-else', 's1')],
        });
        const svc = new UploadsService(storage, prisma);
        await expect(
          svc.deleteOwnedFile(REL, user(role, 'u1')),
        ).rejects.toMatchObject({ response: { code: 'UPLOAD_NOT_OWNED' } });
      }
      // A row without a store and without a matching user: nobody but admin.
      const orphan = prismaWith({
        creator: creatorIn('s1'),
        productImages: [{ url: REL, creator_id: 'c1' }],
        uploaded: [row(null, null)],
      });
      await expect(
        new UploadsService(storage, orphan).deleteOwnedFile(
          REL,
          user(UserRole.CREATOR, 'u1'),
        ),
      ).rejects.toMatchObject({ response: { code: 'UPLOAD_NOT_OWNED' } });
      expect(await storage.exists(REL)).toBe(true);
    });

    it('legacy files without a row keep the reference check', async () => {
      const owned = prismaWith({
        creator: creatorIn('s1'),
        productImages: [{ url: REL, creator_id: 'c1' }],
      });
      await new UploadsService(storage, owned).deleteOwnedFile(
        REL,
        user(UserRole.CREATOR, 'u1'),
      );
      expect(await storage.exists(REL)).toBe(false);
      expect(uploadedOf(owned).findUnique).toHaveBeenCalledWith({
        where: { key: REL },
        select: { user_id: true, store_id: true },
      });

      await storage.put('products', path.basename(REL), Buffer.from('x'));
      const notOwned = prismaWith({ creator: creatorIn('s1') });
      await expect(
        new UploadsService(storage, notOwned).deleteOwnedFile(
          REL,
          user(UserRole.CREATOR, 'u1'),
        ),
      ).rejects.toMatchObject({ response: { code: 'UPLOAD_NOT_OWNED' } });
      expect(await storage.exists(REL)).toBe(true);
    });

    it('ADMIN deletes a recorded file of anyone and the row goes too', async () => {
      const prisma = prismaWith({ uploaded: [row('u1', 's1')] });
      await new UploadsService(storage, prisma).deleteOwnedFile(
        REL,
        user(UserRole.ADMIN, 'admin'),
      );
      expect(await storage.exists(REL)).toBe(false);
      expect(
        await uploadedOf(prisma).findUnique({ where: { key: REL } }),
      ).toBeNull();
    });
  });

  it('refuses non-public paths before any lookup', async () => {
    const prisma = prismaWith({});
    const svc = new UploadsService(storage, prisma);
    await expect(
      svc.deleteOwnedFile('/uploads/../package.json', user(UserRole.ADMIN)),
    ).rejects.toMatchObject({
      response: { code: 'UPLOAD_INVALID_PATH' },
    });
    await expect(
      svc.deleteOwnedFile('/storage/x.pdf', user(UserRole.CREATOR)),
    ).rejects.toMatchObject({
      response: { code: 'UPLOAD_INVALID_PATH' },
    });
    expect((prisma.creator.findUnique as jest.Mock).mock.calls).toHaveLength(0);
  });
});

describe('uploadLimit interceptor', () => {
  const run = (err: unknown) =>
    lastValueFrom(
      new (uploadLimit(50 * 1024 * 1024))().intercept({} as never, {
        handle: () => throwError(() => err),
      }),
    );

  it('maps multer LIMIT_FILE_SIZE to 413 UPLOAD_FILE_TOO_LARGE with the cap', async () => {
    await expect(
      run(new PayloadTooLargeException('File too large')),
    ).rejects.toMatchObject({
      status: 413,
      response: {
        code: 'UPLOAD_FILE_TOO_LARGE',
        message: 'File too large (max 50 MB)',
        max_bytes: 52428800,
        params: { max_mb: 50 },
      },
    });
  });

  it('codes LIMIT_FILE_COUNT / LIMIT_UNEXPECTED_FILE and passes anything else through', async () => {
    await expect(
      run(new BadRequestException('Too many files')),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'UPLOAD_TOO_MANY_FILES' },
    });
    await expect(
      run(new BadRequestException('Unexpected field - photo')),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'UPLOAD_UNEXPECTED_FIELD' },
    });
    const other = new BadRequestException({ code: 'X', message: 'x' });
    await expect(run(other)).rejects.toBe(other);
    const plain = new Error('boom');
    await expect(run(plain)).rejects.toBe(plain);
  });
});
