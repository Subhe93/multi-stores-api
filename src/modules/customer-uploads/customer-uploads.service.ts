import {
  BadRequestException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { OrderStatus, Prisma, UserRole } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import sharp from 'sharp';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PRIVATE_STORAGE,
  PrivateFileStorage,
  type PrivateStorage,
} from '../../common/storage/private-file-storage';
import {
  inspectRaster,
  RasterInspectError,
} from '../../common/uploads/raster-inspect';
import type { OrderReader } from '../../common/orders/order-read-access';
import { UploadsService } from '../uploads/uploads.service';
import { RetentionService } from '../retention/retention.service';
import {
  CUSTOMER_PREVIEW_FOLDER,
  CUSTOMER_UPLOAD_DOCUMENT_EXTS,
  CUSTOMER_UPLOAD_MAX_BYTES,
  CUSTOMER_UPLOAD_MAX_PIXELS,
  CUSTOMER_UPLOAD_ORPHAN_DAYS_DEFAULT,
  CUSTOMER_UPLOAD_ORPHAN_DAYS_ENV,
  CUSTOMER_UPLOAD_PURGEABLE_ORDER_STATUSES,
  CUSTOMER_UPLOAD_RASTER_EXTS,
  CUSTOMER_UPLOAD_RETENTION_DAYS_ENV,
  CUSTOMER_UPLOAD_RETENTION_TASK,
  CUSTOMER_UPLOAD_STORAGE_NAMESPACE,
  type CustomerUploadResponse,
  type CustomerUploadRetentionOptions,
  type CustomerUploadRetentionPolicy,
  type CustomerUploadRetentionResult,
  type ResolvedCustomerUpload,
  parseCustomerPreviewId,
} from './customer-uploads.types';
import {
  assertFreeDisk,
  CustomerUploadByteBudget,
} from './customer-upload-admission';
import { PgUploadQuotaStore } from '../ops/upload-quota-store';

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RETENTION_PAGE = 200;
/** Retention stops this long before the caller's deadline. */
const RETENTION_DEADLINE_MARGIN_MS = 5_000;
const PURGEABLE = new Set<OrderStatus>(
  CUSTOMER_UPLOAD_PURGEABLE_ORDER_STATUSES,
);

const RASTER_MIME: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** Neutral page glyph used as the preview of PDF/AI files (no text). */
const DOCUMENT_PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
<rect width="256" height="256" fill="#f1f3f5"/>
<path d="M76 40h76l40 40v136H76z" fill="#ffffff" stroke="#adb5bd" stroke-width="6" stroke-linejoin="round"/>
<path d="M152 40v40h40" fill="#e9ecef" stroke="#adb5bd" stroke-width="6" stroke-linejoin="round"/>
<path d="M100 120h68M100 144h68M100 168h44" stroke="#ced4da" stroke-width="8" stroke-linecap="round"/>
</svg>`;

type UploadedFileLike = Pick<
  Express.Multer.File,
  'buffer' | 'originalname' | 'size'
>;

/** Where an upload request comes from (per-IP byte budget). */
export interface CustomerUploadClient {
  ip?: string;
}

export interface CustomerUploadDownload {
  /** The original bytes, streamed from disk (never buffered whole, M5 A5). */
  stream: Readable;
  /** Size in bytes (Content-Length). */
  length: number;
  mime: string;
  filename: string;
}

/** Outcome of `tryMarkAttached`: what was attached and what could not be. */
export interface MarkAttachedResult {
  attached: number;
  /** Ids that are purged, unknown, or attached to another store. */
  unattachable: string[];
}

/**
 * Customer uploads (M4.0 §8): the storefront's IMAGE/FILE field uploads.
 * The exact original bytes go to private storage; a public WebP preview
 * (EXIF stripped) is the value stored in the cart and order. Orders attach
 * uploads (`markAttached`); merchants download originals through the order
 * read rules; the `customer-uploads` retention task purges expired files.
 *
 * The extra constructor dependencies are optional so the service can still
 * be built with only Prisma in unit tests of other modules.
 */
@Injectable()
export class CustomerUploadsService implements OnModuleInit {
  private readonly logger = new Logger(CustomerUploadsService.name);
  private readonly retentionPolicies: CustomerUploadRetentionPolicy[] = [];
  /** Per-IP daily byte budget of `POST /uploads/customer` (Postgres, in-memory fallback). */
  readonly byteBudget: CustomerUploadByteBudget;
  private readonly storage: PrivateStorage;
  private uploadsService?: UploadsService;
  /** Where the public previews live (same tree UploadsService writes to). */
  private readonly previewDir = path.join(
    process.cwd(),
    'uploads',
    CUSTOMER_PREVIEW_FOLDER,
  );

  constructor(
    private readonly prisma: PrismaService,
    @Optional() uploads?: UploadsService,
    @Optional() @Inject(PRIVATE_STORAGE) storage?: PrivateStorage,
    @Optional() private readonly retention?: RetentionService,
  ) {
    this.uploadsService = uploads;
    this.storage = storage ?? new PrivateFileStorage();
    this.byteBudget = new CustomerUploadByteBudget(
      new PgUploadQuotaStore(prisma),
    );
  }

  onModuleInit() {
    this.retention?.registerTask({
      key: CUSTOMER_UPLOAD_RETENTION_TASK,
      run: async (now, opts) => {
        const r = await this.runRetention(now, opts);
        return {
          purged: r.purgedAttached + r.purgedOrphans,
          skipped: r.skippedOpenOrders,
          errors: r.errors,
          details: { ...r },
        };
      },
    });
  }

  private get uploads(): UploadsService {
    this.uploadsService ??= new UploadsService();
    return this.uploadsService;
  }

  // ── Upload ────────────────────────────────────────────────────────────────

  /**
   * Stores one customer file: exact original bytes privately, a public WebP
   * preview (raster: rotate → fit 2000 → WebP 80, metadata stripped; PDF/AI: a
   * neutral placeholder) and a `CustomerUpload` row (not attached yet).
   */
  /**
   * Cheap checks before multer buffers the body: the client's daily byte
   * budget is not used up (429 CUSTOMER_UPLOAD_QUOTA) and the disks have
   * room (503 CUSTOMER_UPLOAD_STORAGE_FULL).
   */
  async admit(client: CustomerUploadClient = {}): Promise<void> {
    await this.byteBudget.assertAllowed(client.ip);
    await assertFreeDisk([this.storage.root, this.previewDir]);
  }

  async upload(
    file?: UploadedFileLike | null,
    client: CustomerUploadClient = {},
  ): Promise<CustomerUploadResponse> {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException({
        code: 'UPLOAD_NO_FILE',
        message: 'No file provided',
      });
    }
    const buffer = file.buffer;
    if (buffer.length > CUSTOMER_UPLOAD_MAX_BYTES) {
      throw tooLarge();
    }
    await this.byteBudget.assertAllowed(client.ip, buffer.length);
    await assertFreeDisk([this.storage.root, this.previewDir], buffer.length);

    const originalName = sanitizeFileName(file.originalname);
    const nameExt = path.extname(originalName).toLowerCase();
    let ext: string;
    let mime: string;
    let width: number | null = null;
    let height: number | null = null;
    let isRaster: boolean;

    if (CUSTOMER_UPLOAD_DOCUMENT_EXTS.includes(nameExt)) {
      if (!isDocument(buffer, nameExt)) throw typeNotAllowed(nameExt);
      isRaster = false;
      ext = nameExt;
      mime = nameExt === '.ai' ? 'application/postscript' : 'application/pdf';
    } else if (CUSTOMER_UPLOAD_RASTER_EXTS.includes(nameExt)) {
      let info: Awaited<ReturnType<typeof inspectRaster>>;
      try {
        info = await inspectRaster(buffer, {
          maxPixels: CUSTOMER_UPLOAD_MAX_PIXELS,
          allowAnimated: true,
        });
        // Decode-bomb guard: an animation is bounded by all its frames.
        if (
          info.width * info.height * info.pages >
          CUSTOMER_UPLOAD_MAX_PIXELS
        ) {
          throw new RasterInspectError('RASTER_TOO_MANY_PIXELS', {
            max_pixels: CUSTOMER_UPLOAD_MAX_PIXELS,
          });
        }
      } catch (e) {
        throw mapRasterError(e, nameExt);
      }
      isRaster = true;
      // The stored extension follows the real content, not the file name.
      ext =
        info.format === 'jpeg'
          ? nameExt === '.jpeg'
            ? '.jpeg'
            : '.jpg'
          : `.${info.format}`;
      mime = RASTER_MIME[info.format];
      width = info.width;
      height = info.height;
    } else {
      throw typeNotAllowed(nameExt);
    }

    const id = randomUUID();
    const now = new Date();
    const key = `${CUSTOMER_UPLOAD_STORAGE_NAMESPACE}/${now.getUTCFullYear()}/${String(
      now.getUTCMonth() + 1,
    ).padStart(2, '0')}/${id}${ext}`;
    const sha256 = createHash('sha256').update(buffer).digest('hex');

    await this.storage.write(key, buffer);
    let previewUrl: string;
    try {
      const previewSource = isRaster
        ? buffer
        : await sharp(Buffer.from(DOCUMENT_PLACEHOLDER_SVG)).webp().toBuffer();
      // First frame only, with an explicit pixel cap (decode-bomb guard);
      // the other upload paths keep their own options.
      const preview = await this.uploads.storeBuffer(
        previewSource,
        isRaster ? ext : '.webp',
        CUSTOMER_PREVIEW_FOLDER,
        {
          id,
          animated: false,
          limitInputPixels: CUSTOMER_UPLOAD_MAX_PIXELS,
        },
      );
      previewUrl = preview.url;
    } catch (e) {
      await this.storage.delete(key).catch(() => undefined);
      throw e;
    }

    try {
      await this.prisma.customerUpload.create({
        data: {
          id,
          original_key: key,
          original_name: originalName,
          mime,
          bytes: buffer.length,
          width,
          height,
          sha256,
          preview_url: previewUrl,
          created_at: now,
        },
      });
    } catch (e) {
      await Promise.all([
        this.storage.delete(key).catch(() => undefined),
        this.deletePreview(id).catch(() => undefined),
      ]);
      throw e;
    }
    await this.byteBudget.consume(client.ip, buffer.length);

    return {
      url: previewUrl,
      upload_id: id,
      file_type: ext.slice(1),
      file_size: buffer.length,
      width,
      height,
      original_name: originalName,
      mime,
    };
  }

  // ── Order write path (WP-A) ──────────────────────────────────────────────

  /**
   * Looks up the uploads behind preview URLs (`/uploads/customer-previews/<id>.webp`,
   * relative or absolute; see `parseCustomerPreviewId`). The map is keyed by
   * the URL exactly as passed. URLs that are not previews (legacy
   * `/uploads/custom-fields/...` values) and previews whose row does not exist
   * are absent from the map; WP-A treats an absent preview URL like a purged
   * one (`CUSTOMER_UPLOAD_EXPIRED`).
   *
   * With `storeId`, an upload already attached to another store is absent
   * too (IDOR guard: preview URLs are public, so a URL copied from someone
   * else's order must not link that file to a new order).
   *
   * Uses one batched query (it runs inside the Kustom validation budget).
   */
  async resolveForOrder(
    urls: readonly string[],
    storeId?: string | null,
  ): Promise<Map<string, ResolvedCustomerUpload>> {
    const result = new Map<string, ResolvedCustomerUpload>();
    const idByUrl = new Map<string, string>();
    for (const url of urls) {
      const id = parseCustomerPreviewId(url);
      if (id) idByUrl.set(url, id);
    }
    if (idByUrl.size === 0) return result;

    const rows = await this.prisma.customerUpload.findMany({
      where: { id: { in: [...new Set(idByUrl.values())] } },
      select: { id: true, purged_at: true, store_id: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const [url, id] of idByUrl) {
      const row = byId.get(id);
      if (!row) continue;
      if (storeId && row.store_id !== null && row.store_id !== storeId) {
        this.logger.warn(
          `Customer upload ${row.id} belongs to another store; not linked to an order of store ${storeId}`,
        );
        continue;
      }
      result.set(url, { id: row.id, purged: row.purged_at !== null });
    }
    return result;
  }

  /**
   * Marks uploads as attached to an order, inside the order transaction.
   * Only unpurged uploads that are orphans or already belong to `storeId`
   * qualify; every id must qualify, else this throws
   * `CUSTOMER_UPLOAD_EXPIRED` and the order transaction rolls back (a purge
   * or another store's attach won the race). `attached_at` is set on every
   * attach, so the retention clock restarts with the newest order and a
   * purge that read the row before this attach no longer matches it (see
   * `claimAttached`). Returns the number of rows attached.
   */
  async markAttached(
    ids: readonly string[],
    storeId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const { attached, unattachable } = await this.tryMarkAttached(
      ids,
      storeId,
      tx,
    );
    if (unattachable.length > 0) {
      throw new BadRequestException({
        code: 'CUSTOMER_UPLOAD_EXPIRED',
        message:
          'A file of this order is no longer available. Please upload it again.',
        params: { upload_ids: unattachable },
      });
    }
    return attached;
  }

  /**
   * `markAttached` without the throw: attaches what qualifies and returns
   * the ids that did not (purged, unknown, or another store's). The caller
   * decides the error (the order path maps the ids back to their field and
   * line, M5 A3). When any id is unattachable the caller must roll back,
   * since the qualifying rows were already updated inside `tx`.
   */
  async tryMarkAttached(
    ids: readonly string[],
    storeId: string,
    tx: Prisma.TransactionClient,
  ): Promise<MarkAttachedResult> {
    const unique = [...new Set(ids)].filter((id) => UUID_RE.test(id));
    if (unique.length === 0) return { attached: 0, unattachable: [] };
    const { count } = await tx.customerUpload.updateMany({
      where: {
        id: { in: unique },
        purged_at: null,
        OR: [{ attached_at: null }, { store_id: storeId }],
      },
      data: { attached_at: new Date(), store_id: storeId },
    });
    if (count === unique.length) return { attached: count, unattachable: [] };
    // The rows just attached (same transaction) are the attachable ones;
    // every other requested id is reported back.
    const attached = await tx.customerUpload.findMany({
      where: { id: { in: unique }, store_id: storeId, purged_at: null },
      select: { id: true },
    });
    const ok = new Set(attached.map((r) => r.id));
    const unattachable = unique.filter((id) => !ok.has(id));
    this.logger.warn(
      `markAttached: ${count}/${unique.length} uploads attachable to store ${storeId} (unattachable: ${unattachable.join(', ')}); order rolled back`,
    );
    return { attached: count, unattachable };
  }

  // ── Download ──────────────────────────────────────────────────────────────

  /**
   * The original bytes for staff of an order item that references the
   * upload: an admin, the creator who owns the order's store, or the
   * provider/creator fulfilling THAT item (`order_item.fulfiller_id`; other
   * items of the same order do not count). The buyer is not served: they
   * already have their own file. Not attached or not readable → 404
   * CUSTOMER_UPLOAD_NOT_FOUND (ids are not enumerable); purged → 410
   * CUSTOMER_UPLOAD_PURGED.
   */
  async downloadOriginal(
    id: string,
    user: OrderReader,
  ): Promise<CustomerUploadDownload> {
    const normalized = typeof id === 'string' ? id.toLowerCase() : '';
    if (!UUID_RE.test(normalized)) throw notFound();
    const upload = await this.prisma.customerUpload.findUnique({
      where: { id: normalized },
      select: {
        id: true,
        original_key: true,
        mime: true,
        purged_at: true,
        values: {
          orderBy: { id: 'asc' },
          select: {
            field_name: true,
            order_item: {
              select: {
                fulfiller_id: true,
                order: {
                  select: { order_number: true, store_id: true },
                },
              },
            },
          },
        },
      },
    });
    if (!upload) throw notFound();

    const canRead = await this.itemStaffChecker(user);
    const match = upload.values.find((v) => canRead(v.order_item)) ?? null;
    if (!match) throw notFound();
    if (upload.purged_at) {
      throw new GoneException({
        code: 'CUSTOMER_UPLOAD_PURGED',
        message: 'The file was removed after the retention period',
      });
    }

    const file = await this.openOriginal(upload.original_key);
    if (!file) {
      this.logger.warn(
        `Customer upload ${upload.id}: original missing at ${upload.original_key}`,
      );
      throw notFound();
    }
    const ext = path.extname(upload.original_key);
    const filename = [
      safeAscii(match.order_item.order.order_number) || 'order',
      safeAscii(match.field_name ?? '') || 'file',
      upload.id.slice(0, 8),
    ].join('-');
    return {
      stream: file.stream,
      length: file.bytes,
      mime: upload.mime,
      filename: `${filename}${ext}`,
    };
  }

  /**
   * The original as a stream: `stat` + `createReadStream` on disk storage
   * (no whole-file buffer, M5 A5); a storage without `openRead` (test
   * doubles) is read into memory and wrapped.
   */
  private async openOriginal(
    key: string,
  ): Promise<{ stream: Readable; bytes: number } | null> {
    if (this.storage.openRead) return this.storage.openRead(key);
    const buffer = await this.storage.read(key);
    if (!buffer) return null;
    return { stream: Readable.from([buffer]), bytes: buffer.length };
  }

  /**
   * Per-item download rule (see `downloadOriginal`), with the reader's
   * provider/creator ids loaded once.
   */
  private async itemStaffChecker(
    user: OrderReader,
  ): Promise<
    (item: {
      fulfiller_id: string | null;
      order: { store_id: string | null };
    }) => boolean
  > {
    if (!user?.id || !user.role) return () => false;
    switch (user.role) {
      case UserRole.ADMIN:
        return () => true;
      case UserRole.PROVIDER: {
        const p = await this.prisma.provider.findUnique({
          where: { user_id: user.id },
          select: { id: true },
        });
        return (item) => !!p && item.fulfiller_id === p.id;
      }
      case UserRole.CREATOR: {
        const c = await this.prisma.creator.findUnique({
          where: { user_id: user.id },
          select: { id: true, store: { select: { id: true } } },
        });
        return (item) =>
          !!c &&
          ((!!c.store && item.order.store_id === c.store.id) ||
            item.fulfiller_id === c.id);
      }
      default:
        return () => false;
    }
  }

  // ── Retention ─────────────────────────────────────────────────────────────

  /** Registers a per-store retention policy (M4.1 registers `personalization.retention_days`). */
  registerRetentionPolicy(policy: CustomerUploadRetentionPolicy): void {
    this.retentionPolicies.push(policy);
  }

  /**
   * Days to keep attached uploads of a store, or null for forever. The
   * minimum number any policy returns wins; when none returns a number, a
   * policy answering null keeps the files forever; otherwise the platform
   * default `CUSTOMER_UPLOAD_RETENTION_DAYS` (unset = forever, K1).
   */
  async retentionDaysFor(storeId: string | null): Promise<number | null> {
    const numbers: number[] = [];
    let forever = false;
    if (storeId) {
      for (const policy of this.retentionPolicies) {
        let v: number | null | undefined;
        try {
          v = await policy.retentionDays(storeId);
        } catch (err) {
          this.logger.warn(
            `Retention policy failed for store ${storeId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          // A failing policy must never shorten retention: keep the files.
          forever = true;
          continue;
        }
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
          numbers.push(v);
        } else if (v === null) {
          forever = true;
        }
      }
    }
    if (numbers.length) return Math.min(...numbers);
    if (forever) return null;
    return envDays(CUSTOMER_UPLOAD_RETENTION_DAYS_ENV, null, 0);
  }

  /**
   * Purges expired originals + previews (retention task `customer-uploads`):
   * - attached uploads older than the store's retention, only when every
   *   order that references them is closed (shipped, delivered, cancelled,
   *   refunded, returned); open orders are skipped and counted;
   * - never-attached uploads older than `CUSTOMER_UPLOAD_ORPHAN_DAYS` (30).
   * A purge deletes both files and sets `purged_at`; the row and the order
   * values stay for audit. `limit` caps purges per category. Rows with an
   * open order are filtered out in SQL (and only counted), so any number of
   * them never stalls the scan. `deadline` (epoch ms) stops the run early,
   * before the caller's transaction times out; the next run continues.
   */
  async runRetention(
    now: Date = new Date(),
    opts: CustomerUploadRetentionOptions = {},
  ): Promise<CustomerUploadRetentionResult> {
    const dryRun = opts.dryRun === true;
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 500;
    const outOfTime = () =>
      opts.deadline !== undefined &&
      Date.now() >= opts.deadline - RETENTION_DEADLINE_MARGIN_MS;
    const result: CustomerUploadRetentionResult = {
      purgedAttached: 0,
      purgedOrphans: 0,
      skippedOpenOrders: 0,
      errors: 0,
    };

    // 1. Attached uploads, store by store (each store has its own policy).
    const stores = await this.prisma.customerUpload.groupBy({
      by: ['store_id'],
      where: { attached_at: { not: null }, purged_at: null },
    });
    const openOrder: Prisma.OrderCustomFieldValueWhereInput = {
      order_item: { order: { status: { notIn: [...PURGEABLE] } } },
    };
    for (const { store_id } of stores) {
      if (result.purgedAttached >= limit || outOfTime()) break;
      const days = await this.retentionDaysFor(store_id);
      if (days === null) continue;
      const cutoff = new Date(now.getTime() - days * DAY_MS);
      const expired: Prisma.CustomerUploadWhereInput = {
        store_id,
        purged_at: null,
        attached_at: { not: null, lt: cutoff },
      };
      result.skippedOpenOrders += await this.prisma.customerUpload.count({
        where: { ...expired, values: { some: openOrder } },
      });
      let cursor: string | undefined;
      while (result.purgedAttached < limit && !outOfTime()) {
        const page = await this.prisma.customerUpload.findMany({
          where: { ...expired, values: { none: openOrder } },
          orderBy: { id: 'asc' },
          take: RETENTION_PAGE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: { id: true, original_key: true },
        });
        if (page.length === 0) break;
        cursor = page[page.length - 1].id;
        for (const row of page) {
          if (result.purgedAttached >= limit || outOfTime()) break;
          const outcome = dryRun
            ? 'purged'
            : await this.purge(row, now, { attachedBefore: cutoff });
          if (outcome === 'purged') result.purgedAttached++;
          else if (outcome === 'error') result.errors++;
          else if (outcome === 'raced') result.skippedOpenOrders++;
        }
        if (page.length < RETENTION_PAGE) break;
      }
    }

    // 2. Orphans: uploaded but never referenced by an order.
    const orphanDays = envDays(
      CUSTOMER_UPLOAD_ORPHAN_DAYS_ENV,
      CUSTOMER_UPLOAD_ORPHAN_DAYS_DEFAULT,
      1,
    )!;
    const orphanCutoff = new Date(now.getTime() - orphanDays * DAY_MS);
    const orphans = outOfTime()
      ? []
      : await this.prisma.customerUpload.findMany({
          where: {
            attached_at: null,
            purged_at: null,
            created_at: { lt: orphanCutoff },
          },
          orderBy: { created_at: 'asc' },
          take: limit,
          select: { id: true, original_key: true },
        });
    for (const row of orphans) {
      if (outOfTime()) break;
      const outcome = dryRun
        ? 'purged'
        : await this.purge(row, now, { attachedBefore: null });
      if (outcome === 'purged') result.purgedOrphans++;
      else if (outcome === 'error') result.errors++;
    }

    return result;
  }

  /**
   * Claims the row, then deletes the preview and the original.
   *
   * The claim is one atomic statement: orphans only while still unattached;
   * attached rows (`attachedBefore` = the retention cutoff, see
   * `claimAttached`) only while still expired and with no open order. An
   * order attaching the file at the same moment either commits first (the
   * claim no longer matches) or finds `purged_at` set (its `markAttached`
   * fails and the order rolls back).
   *
   * The preview goes first: while the original is still on disk a failure
   * reverts the claim so the next run retries. Once the original is gone the
   * claim is never reverted (the row must stay purged).
   */
  private async purge(
    row: { id: string; original_key: string },
    now: Date,
    { attachedBefore }: { attachedBefore: Date | null },
  ): Promise<'purged' | 'raced' | 'error'> {
    const claimed =
      attachedBefore === null
        ? (
            await this.prisma.customerUpload.updateMany({
              where: { id: row.id, purged_at: null, attached_at: null },
              data: { purged_at: now },
            })
          ).count
        : await this.claimAttached(row.id, now, attachedBefore);
    if (claimed === 0) return 'raced';
    try {
      await this.deletePreview(row.id);
      await this.storage.delete(row.original_key);
      return 'purged';
    } catch (err) {
      this.logger.error(
        `Customer upload ${row.id}: purge failed, claim reverted: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.prisma.customerUpload
        .update({ where: { id: row.id }, data: { purged_at: null } })
        .catch(() => undefined);
      return 'error';
    }
  }

  /**
   * Atomic claim of an attached upload (raw SQL, one statement):
   * still unpurged, still attached before the cutoff, and no order using it
   * is open. `markAttached` moves `attached_at` forward, so a concurrent
   * attach that commits while this statement waits on the row lock makes the
   * re-checked row fail `attached_at < cutoff`. Timestamps are passed as UTC
   * ISO strings (Prisma stores `timestamp(3)` in UTC), independent of the
   * session time zone.
   */
  private async claimAttached(
    id: string,
    now: Date,
    cutoff: Date,
  ): Promise<number> {
    const statuses = [...PURGEABLE].map((s) => Prisma.sql`${s}`);
    return this.prisma.$executeRaw`
      UPDATE "CustomerUpload" AS u
      SET "purged_at" = (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      WHERE u."id" = ${id}
        AND u."purged_at" IS NULL
        AND u."attached_at" IS NOT NULL
        AND u."attached_at" < (${cutoff.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        AND NOT EXISTS (
          SELECT 1
          FROM "OrderCustomFieldValue" v
          JOIN "OrderItem" i ON i."id" = v."order_item_id"
          JOIN "Order" o ON o."id" = i."order_id"
          WHERE v."upload_id" = u."id"
            AND o."status"::text NOT IN (${Prisma.join(statuses)})
        )`;
  }

  /** Deletes `uploads/customer-previews/<id>.webp`; a missing file is fine. */
  private async deletePreview(id: string): Promise<void> {
    if (!UUID_RE.test(id)) return;
    try {
      await fs.unlink(path.join(this.previewDir, `${id}.webp`));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * multer (busboy) reads multipart file names as latin1, so UTF-8 names
 * arrive as mojibake (`Ã¥` for `å`). Re-decodes them when the bytes are
 * valid UTF-8; anything else is kept as is.
 */
export function decodeMultipartName(name: string): string {
  // Only latin1 code units with at least one high byte can be re-decoded.
  // eslint-disable-next-line no-control-regex
  if (!/[\u0080-\u00ff]/.test(name) || /[^\u0000-\u00ff]/.test(name)) {
    return name;
  }
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? name : decoded;
}

/**
 * Base name only, at most 255 chars, without control, format (`\p{Cf}`:
 * bidi overrides/isolates, zero-width marks) or path/quote characters, so a
 * name like `photo\u202Egnp.exe` cannot disguise its extension.
 */
export function sanitizeFileName(name: unknown): string {
  const raw = typeof name === 'string' ? decodeMultipartName(name) : '';
  const base = raw.split(/[\\/]/).pop() ?? '';
  let clean = base
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}"<>|:*?]/gu, '')
    .trim();
  if (!clean || /^\.+$/.test(clean)) clean = 'file';
  if (clean.length > 255) {
    const ext = path.extname(clean).slice(0, 16);
    clean = clean.slice(0, 255 - ext.length) + ext;
  }
  return clean;
}

/**
 * Document check by content: a PDF has `%PDF-` within its first 1024 bytes
 * (some writers put a preamble before it); an `.ai` file is either a
 * PDF-compatible one or a PostScript one starting with `%!PS-Adobe`.
 */
function isDocument(buffer: Buffer, ext: string): boolean {
  const head = buffer.subarray(0, 1024).toString('latin1');
  if (head.includes('%PDF-')) return true;
  return ext === '.ai' && head.startsWith('%!PS-Adobe');
}

function safeAscii(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 60);
}

/** Integer env var ≥ min; unset or invalid → fallback. */
function envDays(
  name: string,
  fallback: number | null,
  min: number,
): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

function notFound() {
  return new NotFoundException({
    code: 'CUSTOMER_UPLOAD_NOT_FOUND',
    message: 'File not found',
  });
}

function typeNotAllowed(ext: string) {
  return new BadRequestException({
    code: 'CUSTOMER_UPLOAD_TYPE_NOT_ALLOWED',
    message: `File type ${ext || '(none)'} not allowed`,
    params: {
      ext: ext || '',
      allowed: [
        ...CUSTOMER_UPLOAD_RASTER_EXTS,
        ...CUSTOMER_UPLOAD_DOCUMENT_EXTS,
      ].join(', '),
    },
  });
}

function tooLarge() {
  return new BadRequestException({
    code: 'UPLOAD_FILE_TOO_LARGE',
    message: 'File too large (max 50MB)',
    params: { max_mb: CUSTOMER_UPLOAD_MAX_BYTES / (1024 * 1024) },
  });
}

function mapRasterError(e: unknown, ext: string) {
  if (e instanceof RasterInspectError) {
    switch (e.code) {
      case 'RASTER_FORMAT_NOT_ALLOWED':
        return typeNotAllowed(ext);
      case 'RASTER_TOO_MANY_PIXELS':
      case 'RASTER_TOO_LARGE':
        return new BadRequestException({
          code: 'UPLOAD_FILE_TOO_LARGE',
          message: 'Image dimensions too large',
          params: { max_pixels: CUSTOMER_UPLOAD_MAX_PIXELS },
        });
      default:
        break;
    }
  }
  return new BadRequestException({
    code: 'UPLOAD_IMAGE_PROCESS_FAILED',
    message: 'Could not process image — file may be corrupt',
  });
}
