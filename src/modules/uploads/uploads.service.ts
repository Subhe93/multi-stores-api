import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import * as path from 'path';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { PrismaService } from '../../prisma/prisma.service';
import type { RequestUser } from '../../common/decorators/current-user.decorator';
import {
  InvalidPublicUrlError,
  PublicStorage,
  publicMediaKeyFromUrl,
  sanitizeFolder,
} from '../storage/public-storage';
import { sniffUploadType } from './upload-sniff';

// Raster formats we re-encode to WebP. Vector/document types are stored as-is.
const RASTER_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
const PASSTHROUGH_EXTS = ['.svg', '.pdf', '.ai'];

// Downscale anything larger than this on the longest edge — storefront images
// never need more, and next/image generates smaller responsive variants on top.
const MAX_DIMENSION = 2000;
const WEBP_QUALITY = 80;
/**
 * Decode cap for the generic upload route (about 4 bytes of RAM per pixel
 * while resizing). 60 MP covers any camera photo; larger inputs are refused
 * instead of letting a few parallel uploads exhaust memory.
 */
export const GENERIC_UPLOAD_MAX_PIXELS = 60_000_000;
/** Generic upload route: multer and the service both enforce it. */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Folders a role may write with `POST /uploads?folder=` (SPEC "Security
 * fixes"). CUSTOMER accounts have no generic upload at all (the storefront
 * uses `POST /uploads/customer`); ADMIN may use any folder.
 */
export const UPLOAD_FOLDERS_BY_ROLE: Readonly<
  Record<UserRole, readonly string[]>
> = {
  [UserRole.ADMIN]: ['*'],
  [UserRole.CREATOR]: [
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
  ],
  [UserRole.PROVIDER]: ['products', 'logos', 'avatars'],
  [UserRole.CUSTOMER]: [],
};

/** True when `role` may upload into `folder` (already sanitized). */
export function folderAllowedForRole(role: UserRole, folder: string): boolean {
  const allowed = UPLOAD_FOLDERS_BY_ROLE[role] ?? [];
  return allowed.includes('*') || allowed.includes(folder);
}

type OwnerUser = Pick<RequestUser, 'id' | 'role'>;

@Injectable()
export class UploadsService {
  private readonly storage: PublicStorage;

  /**
   * Both dependencies are optional so the service can be built bare in unit
   * tests (`new UploadsService()` → local disk at `<cwd>/uploads`, no
   * ownership lookups).
   */
  constructor(
    @Optional() @Inject(PublicStorage) storage?: PublicStorage,
    @Optional() private readonly prisma?: PrismaService,
  ) {
    this.storage = storage ?? PublicStorage.localDefault();
  }

  /** `local` or `s3`. */
  get driver(): 'local' | 's3' {
    return this.storage.driver;
  }

  /** Disk directory of a folder in local mode; null on S3 (no disk guard). */
  localDir(folder: string): string | null {
    return this.storage.localDir(folder);
  }

  async uploadFile(
    file: Express.Multer.File,
    folder: string = 'general',
  ): Promise<{ url: string; file_type: string; file_size: number }> {
    if (!file) {
      throw new BadRequestException({
        code: 'UPLOAD_NO_FILE',
        message: 'No file provided',
      });
    }

    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = [...RASTER_EXTS, ...PASSTHROUGH_EXTS];
    if (!allowedExts.includes(ext)) {
      throw new BadRequestException(`File type ${ext} not allowed`);
    }

    if (file.size > UPLOAD_MAX_BYTES || file.buffer.length > UPLOAD_MAX_BYTES) {
      throw new BadRequestException({
        code: 'UPLOAD_FILE_TOO_LARGE',
        message: 'File too large (max 50MB)',
      });
    }

    // The bytes must be what the extension claims (magic bytes); a renamed
    // executable or an HTML file named .svg is refused before it is stored.
    if (!sniffUploadType(file.buffer, ext)) {
      throw new BadRequestException({
        code: 'UPLOAD_TYPE_MISMATCH',
        message: `File content does not match ${ext}`,
      });
    }

    return this.storeBuffer(file.buffer, ext, folder);
  }

  /**
   * Writes a buffer under `uploads/<folder>/` exactly like `uploadFile` does
   * (M4.5 C21): raster input (`.png/.jpg/.jpeg/.webp`) is resized and
   * re-encoded to WebP, anything else is written through untouched. The
   * caller has already validated the type and size. `opts.id` fixes the file
   * name (`<id><ext>`) instead of a random uuid; it must be a uuid.
   * `opts.animated` / `opts.limitInputPixels` override the decoder options of
   * the raster path (customer uploads: first frame only, explicit pixel cap);
   * without them the output is exactly what `uploadFile` always produced.
   */
  async storeBuffer(
    buffer: Buffer,
    ext: string,
    folder: string = 'general',
    opts: { id?: string; animated?: boolean; limitInputPixels?: number } = {},
  ): Promise<{ url: string; file_type: string; file_size: number }> {
    const inExt = (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase();
    const id = opts.id ?? randomUUID();
    if (!UUID_RE.test(id)) {
      throw new BadRequestException({
        code: 'UPLOAD_INVALID_PATH',
        message: 'Invalid file name',
      });
    }

    const safeFolder = sanitizeFolder(folder);

    // Raster images are resized + re-encoded to WebP to shrink payloads
    // (often 70–90% smaller). Other types are written through untouched.
    const isRaster = RASTER_EXTS.includes(inExt);
    const outExt = isRaster ? '.webp' : inExt;
    const filename = `${id}${outExt}`;

    const out = isRaster
      ? await this.processImage(buffer, inExt, opts)
      : buffer;
    const stored = await this.storage.put(safeFolder, filename, out);

    return {
      url: stored.url,
      file_type: outExt.replace('.', ''),
      file_size: out.length,
    };
  }

  /**
   * Resize (without enlarging) to fit within MAX_DIMENSION and encode as WebP.
   * Animated WebP frames are preserved. Rejects undecodable input rather than
   * storing it under a mismatched .webp name.
   */
  private async processImage(
    buffer: Buffer,
    ext: string,
    decode: { animated?: boolean; limitInputPixels?: number } = {},
  ): Promise<Buffer> {
    const input: sharp.SharpOptions = {
      animated: decode.animated ?? ext === '.webp',
    };
    input.limitInputPixels =
      decode.limitInputPixels ?? GENERIC_UPLOAD_MAX_PIXELS;
    try {
      return await sharp(buffer, input)
        .rotate() // honour EXIF orientation before stripping metadata
        .resize(MAX_DIMENSION, MAX_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
    } catch {
      throw new BadRequestException({
        code: 'UPLOAD_IMAGE_PROCESS_FAILED',
        message: 'Could not process image — file may be corrupt',
      });
    }
  }

  /**
   * Delete an uploaded file by its public URL (`/uploads/<folder>/<file>`,
   * relative or absolute). The URL arrives from the client: anything outside
   * the public key shape (`..`, other paths) is refused, so nothing outside
   * the uploads tree can ever be unlinked. A missing file is not an error.
   */
  async deleteFile(fileUrl: string): Promise<void> {
    try {
      await this.storage.delete(fileUrl);
    } catch (e) {
      if (e instanceof InvalidPublicUrlError) {
        throw new BadRequestException({
          code: 'UPLOAD_INVALID_PATH',
          message: 'Invalid file path',
        });
      }
      throw e;
    }
  }

  /**
   * `DELETE /uploads/:fileUrl` with ownership: an ADMIN may delete any public
   * file; a CREATOR/PROVIDER only a file referenced by a record they own
   * (store logo/favicon, legal-profile logo, avatar/cover, provider logo,
   * product / custom-product / collection images, imported media, page
   * builder JSON) or inside their store's `template-imports/<storeId>/`
   * folder. Anything else → 403 UPLOAD_NOT_OWNED (the file is not revealed
   * as existing or not).
   */
  async deleteOwnedFile(fileUrl: string, user: OwnerUser): Promise<void> {
    const key = publicMediaKeyFromUrl(fileUrl);
    if (!key) {
      throw new BadRequestException({
        code: 'UPLOAD_INVALID_PATH',
        message: 'Invalid file path',
      });
    }
    if (user.role !== UserRole.ADMIN) {
      // Owning a reference is not enough: anyone can paste another store's
      // URL into their own record. A file another account still uses is
      // never deleted by a non-admin.
      const owned =
        (await this.isOwnedBy(`/${key}`, user)) &&
        !(await this.isReferencedByOthers(`/${key}`, user));
      if (!owned) {
        throw new ForbiddenException({
          code: 'UPLOAD_NOT_OWNED',
          message: 'You can only delete files you uploaded',
        });
      }
    }
    await this.storage.delete(`/${key}`);
  }

  /**
   * True when `rel` (`/uploads/<folder>/<file>`) is referenced by a record of
   * the caller. Column values may be absolute (`https://host/uploads/...`),
   * so every string column is matched with `endsWith`; JSON page-builder
   * blobs are matched as text.
   */
  async isOwnedBy(rel: string, user: OwnerUser): Promise<boolean> {
    const prisma = this.prisma;
    if (!prisma) return false;
    if (user.role === UserRole.CUSTOMER) return false;
    const ends = { endsWith: rel };

    const me = await prisma.user.findUnique({
      where: { id: user.id },
      select: { avatar_url: true },
    });
    if (me?.avatar_url?.endsWith(rel)) return true;

    if (user.role === UserRole.PROVIDER) {
      const provider = await prisma.provider.findUnique({
        where: { user_id: user.id },
        select: { id: true, logo_url: true },
      });
      if (!provider) return false;
      if (provider.logo_url?.endsWith(rel)) return true;
      const image = await prisma.productImage.findFirst({
        where: { url: ends, product: { provider_id: provider.id } },
        select: { id: true },
      });
      return image !== null;
    }

    if (user.role !== UserRole.CREATOR) return false;
    const creator = await prisma.creator.findUnique({
      where: { user_id: user.id },
      select: {
        id: true,
        avatar_url: true,
        cover_url: true,
        store: { select: { id: true, logo_url: true, favicon_url: true } },
      },
    });
    if (!creator) return false;
    if (creator.avatar_url?.endsWith(rel) || creator.cover_url?.endsWith(rel)) {
      return true;
    }
    const store = creator.store;
    if (store) {
      if (store.logo_url?.endsWith(rel) || store.favicon_url?.endsWith(rel)) {
        return true;
      }
      // The kit assets of this store (`/uploads/template-imports/<storeId>/...`).
      if (rel.startsWith(`/uploads/template-imports/${store.id}/`)) return true;
    }

    const checks: Array<() => Promise<boolean>> = [
      async () =>
        (await prisma.productImage.findFirst({
          where: { url: ends, product: { creator_id: creator.id } },
          select: { id: true },
        })) !== null,
      async () =>
        (await prisma.customProductImage.findFirst({
          where: { url: ends, custom_product: { creator_id: creator.id } },
          select: { id: true },
        })) !== null,
      async () =>
        (await prisma.creatorCategory.findFirst({
          where: { thumbnail_url: ends, creator_id: creator.id },
          select: { id: true },
        })) !== null,
    ];
    if (store) {
      checks.push(
        async () =>
          (await prisma.storeLegalProfile.findFirst({
            where: { logo_url: ends, store_id: store.id },
            select: { id: true },
          })) !== null,
        async () =>
          (await prisma.importMedia.findFirst({
            where: { public_url: ends, store_id: store.id },
            select: { id: true },
          })) !== null,
        async () => this.referencedInPageJson(rel, store.id),
      );
    }
    for (const check of checks) {
      if (await check()) return true;
    }
    return false;
  }

  /**
   * True when `rel` is referenced by a record that does NOT belong to the
   * caller: another user's avatar, another provider/creator profile, another
   * store's logo / description / legal logo / imports / pages, or a product,
   * custom product or collection of someone else (images and description
   * HTML). Absolute URLs match by suffix, HTML and JSON by substring.
   */
  async isReferencedByOthers(rel: string, user: OwnerUser): Promise<boolean> {
    const prisma = this.prisma;
    if (!prisma) return true;
    const [creator, provider] = await Promise.all([
      prisma.creator.findUnique({
        where: { user_id: user.id },
        select: { id: true, store: { select: { id: true } } },
      }),
      prisma.provider.findUnique({
        where: { user_id: user.id },
        select: { id: true },
      }),
    ]);
    const creatorId = creator?.id ?? null;
    const storeId = creator?.store?.id ?? null;
    const providerId = provider?.id ?? null;
    const esc = rel.replace(/[%_\\]/g, (c) => `\\${c}`);
    const suffix = `%${esc}`;
    const inside = `%${esc}%`;
    const rows = await prisma.$queryRaw<{ found: number }[]>`
      SELECT 1 AS found WHERE
        EXISTS (SELECT 1 FROM "User" u WHERE u."id" <> ${user.id} AND u."avatar_url" LIKE ${suffix})
        OR EXISTS (SELECT 1 FROM "Creator" c WHERE c."user_id" <> ${user.id}
                   AND (c."avatar_url" LIKE ${suffix} OR c."cover_url" LIKE ${suffix}))
        OR EXISTS (SELECT 1 FROM "Provider" p WHERE p."user_id" <> ${user.id}
                   AND (p."logo_url" LIKE ${suffix} OR p."description" LIKE ${inside}))
        OR EXISTS (SELECT 1 FROM "Store" s WHERE s."creator_id" IS DISTINCT FROM ${creatorId}
                   AND (s."logo_url" LIKE ${suffix} OR s."favicon_url" LIKE ${suffix} OR s."description" LIKE ${inside}))
        OR EXISTS (SELECT 1 FROM "ProductImage" i JOIN "Product" pr ON pr."id" = i."product_id"
                   WHERE i."url" LIKE ${suffix}
                     AND pr."creator_id" IS DISTINCT FROM ${creatorId}
                     AND pr."provider_id" IS DISTINCT FROM ${providerId})
        OR EXISTS (SELECT 1 FROM "ProductTranslation" t JOIN "Product" pr ON pr."id" = t."product_id"
                   WHERE (t."description" LIKE ${inside} OR t."short_description" LIKE ${inside})
                     AND pr."creator_id" IS DISTINCT FROM ${creatorId}
                     AND pr."provider_id" IS DISTINCT FROM ${providerId})
        OR EXISTS (SELECT 1 FROM "CustomProductImage" i JOIN "CustomProduct" cp ON cp."id" = i."custom_product_id"
                   WHERE i."url" LIKE ${suffix} AND cp."creator_id" IS DISTINCT FROM ${creatorId})
        OR EXISTS (SELECT 1 FROM "CustomProductTranslation" t JOIN "CustomProduct" cp ON cp."id" = t."custom_product_id"
                   WHERE t."description" LIKE ${inside} AND cp."creator_id" IS DISTINCT FROM ${creatorId})
        OR EXISTS (SELECT 1 FROM "CreatorCategory" cc WHERE cc."creator_id" IS DISTINCT FROM ${creatorId}
                   AND cc."thumbnail_url" LIKE ${suffix})
        OR EXISTS (SELECT 1 FROM "StoreLegalProfile" l WHERE l."store_id" IS DISTINCT FROM ${storeId}
                   AND l."logo_url" LIKE ${suffix})
        OR EXISTS (SELECT 1 FROM "ImportMedia" m WHERE m."store_id" IS DISTINCT FROM ${storeId}
                   AND m."public_url" LIKE ${suffix})
        OR EXISTS (SELECT 1 FROM "Page" pg WHERE pg."store_id" IS DISTINCT FROM ${storeId}
                   AND (pg."seo"::text LIKE ${inside}
                     OR EXISTS (SELECT 1 FROM "PageSection" ps WHERE ps."page_id" = pg."id" AND ps."settings"::text LIKE ${inside})
                     OR EXISTS (SELECT 1 FROM "PageSection" ps JOIN "PageSectionTranslation" pt ON pt."section_id" = ps."id"
                                WHERE ps."page_id" = pg."id" AND pt."content"::text LIKE ${inside})))
      LIMIT 1`;
    return rows.length > 0;
  }

  /** Page-builder JSON of the store (sections, blocks, translations, versions, SEO) mentioning `rel`. */
  private async referencedInPageJson(
    rel: string,
    storeId: string,
  ): Promise<boolean> {
    const prisma = this.prisma;
    if (!prisma) return false;
    const needle = `%${rel.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const rows = await prisma.$queryRaw<{ found: number }[]>`
      SELECT 1 AS found FROM "Page" p
      WHERE p."store_id" = ${storeId}
        AND (
          p."seo"::text LIKE ${needle}
          OR EXISTS (SELECT 1 FROM "PageSection" s WHERE s."page_id" = p."id" AND s."settings"::text LIKE ${needle})
          OR EXISTS (SELECT 1 FROM "PageSection" s JOIN "PageSectionTranslation" t ON t."section_id" = s."id"
                     WHERE s."page_id" = p."id" AND t."content"::text LIKE ${needle})
          OR EXISTS (SELECT 1 FROM "PageVersion" v WHERE v."page_id" = p."id" AND v."snapshot"::text LIKE ${needle})
        )
      LIMIT 1`;
    return rows.length > 0;
  }
}
