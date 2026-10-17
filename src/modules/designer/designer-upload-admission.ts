import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NestInterceptor,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DesignAssetKind } from '@prisma/client';
import type { Request } from 'express';
import { concatMap, from, map, Observable, switchMap } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PgUploadQuotaStore,
  type UploadQuotaStore,
} from '../ops/upload-quota-store';
import {
  PRIVATE_STORAGE,
  type PrivateStorage,
} from '../../common/storage/private-file-storage';
import { freeBytes } from '../customer-uploads/customer-upload-admission';
import type { RequestWithAppStore } from '../../common/guards/require-app.guard';
import { UUID_RE } from './designs.util';

/**
 * Admission of storefront designer photo uploads
 * (`POST designer/s/:slug/designs/:id/photos`, public: guests design too).
 * Runs BEFORE multer buffers up to 40 MB, the same way as the M4.0
 * `CustomerUploadAdmissionInterceptor`:
 *
 * - per-IP daily bytes (Postgres `UploadQuotaWindow`, UTC day, shared by all
 *   instances; in-memory rolling 24 h fallback when the DB is unreachable):
 *   `DESIGNER_UPLOAD_DAILY_BYTES_PER_IP` (default 500 MB, 0 = off)
 *   → 429 `DESIGNER_UPLOAD_QUOTA` (params.scope = 'ip');
 * - per-store daily bytes: `DESIGNER_UPLOAD_DAILY_BYTES_PER_STORE`
 *   (default 5 GB, 0 = off) → 429 `DESIGNER_UPLOAD_QUOTA` (scope 'store');
 * - photos per design: `DESIGNER_MAX_PHOTOS_PER_DESIGN` (default 10, live
 *   CUSTOMER_PHOTO rows of the design) → 429 `DESIGNER_UPLOAD_QUOTA`
 *   (scope 'design');
 * - free disk under the private storage root: `DESIGNER_UPLOAD_MIN_FREE_MB`
 *   (default: CUSTOMER_UPLOAD_MIN_FREE_MB, else 1024; 0 = off)
 *   → 503 `DESIGNER_STORAGE_FULL`.
 *
 * The request's Content-Length is checked against the byte budgets up front
 * and the stored file's size is charged after a successful upload. The
 * client IP is `req.ip`: behind a proxy only with TRUST_PROXY set. The byte
 * counters are shared across instances (M5 W1-C); the photos-per-design
 * count is a live DB count.
 */

export const DESIGNER_UPLOAD_DAILY_BYTES_PER_IP_ENV =
  'DESIGNER_UPLOAD_DAILY_BYTES_PER_IP';
export const DESIGNER_UPLOAD_DAILY_BYTES_PER_IP_DEFAULT = 500 * 1024 * 1024;
export const DESIGNER_UPLOAD_DAILY_BYTES_PER_STORE_ENV =
  'DESIGNER_UPLOAD_DAILY_BYTES_PER_STORE';
export const DESIGNER_UPLOAD_DAILY_BYTES_PER_STORE_DEFAULT =
  5 * 1024 * 1024 * 1024;
export const DESIGNER_MAX_PHOTOS_PER_DESIGN_ENV =
  'DESIGNER_MAX_PHOTOS_PER_DESIGN';
export const DESIGNER_MAX_PHOTOS_PER_DESIGN_DEFAULT = 10;
export const DESIGNER_UPLOAD_MIN_FREE_MB_ENV = 'DESIGNER_UPLOAD_MIN_FREE_MB';
export const DESIGNER_UPLOAD_MIN_FREE_MB_DEFAULT = 1024;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Tracked keys before old windows are swept (memory bound). */
const MAX_TRACKED_KEYS = 50_000;

function envInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export type DesignerQuotaScope = 'ip' | 'store' | 'design';

/** 429 DESIGNER_UPLOAD_QUOTA. */
export function designerUploadQuota(
  scope: DesignerQuotaScope,
  params: Record<string, unknown> = {},
): HttpException {
  return new HttpException(
    {
      code: 'DESIGNER_UPLOAD_QUOTA',
      message:
        scope === 'design'
          ? 'This design already has the maximum number of photos.'
          : 'Upload limit reached for today. Please try again tomorrow.',
      params: { scope, ...params },
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/** 503 DESIGNER_STORAGE_FULL. */
export function designerStorageFull(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'DESIGNER_STORAGE_FULL',
    message: 'Uploads are temporarily unavailable. Please try again later.',
  });
}

/** Bytes per key in a rolling 24 h window that starts at the first upload. */
export class RollingByteBudget {
  private readonly used = new Map<string, { since: number; bytes: number }>();

  constructor(
    private readonly limit: () => number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The current limit in bytes (0 = off). */
  limitOf(): number {
    return this.limit();
  }

  private entry(key: string): { since: number; bytes: number } | undefined {
    const e = this.used.get(key);
    if (e && this.now() - e.since >= DAY_MS) {
      this.used.delete(key);
      return undefined;
    }
    return e;
  }

  /** True when `key` may still add `bytes` today. */
  allows(key: string | undefined, bytes = 0): boolean {
    const limit = this.limit();
    if (!limit || !key) return true;
    const used = this.entry(key)?.bytes ?? 0;
    return used < limit && used + bytes <= limit;
  }

  consume(key: string | undefined, bytes: number): void {
    if (!this.limit() || !key || !(bytes > 0)) return;
    const e = this.entry(key);
    if (e) {
      e.bytes += bytes;
      return;
    }
    if (this.used.size >= MAX_TRACKED_KEYS) this.sweep();
    this.used.set(key, { since: this.now(), bytes });
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, e] of this.used) {
      if (now - e.since >= DAY_MS) this.used.delete(k);
    }
    while (this.used.size >= MAX_TRACKED_KEYS) {
      const first = this.used.keys().next();
      if (first.done) break;
      this.used.delete(first.value);
    }
  }
}

/** The admission state and checks (one per process, shared by the interceptor). */
@Injectable()
export class DesignerUploadAdmission {
  /** In-memory windows: the fallback when the shared store is unavailable. */
  readonly perIp: RollingByteBudget;
  readonly perStore: RollingByteBudget;
  /** Shared Postgres counters (unavailable with a unit-test prisma fake). */
  readonly store: UploadQuotaStore;
  /** Read on every check (specs replace it). */
  env: NodeJS.ProcessEnv = process.env;
  /** Clock of the budgets (specs replace it). */
  now: () => number = Date.now;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PRIVATE_STORAGE) private readonly storage: PrivateStorage,
  ) {
    const now = () => this.now();
    this.store = new PgUploadQuotaStore(prisma, now);
    this.perIp = new RollingByteBudget(
      () =>
        envInt(
          this.env,
          DESIGNER_UPLOAD_DAILY_BYTES_PER_IP_ENV,
          DESIGNER_UPLOAD_DAILY_BYTES_PER_IP_DEFAULT,
        ),
      now,
    );
    this.perStore = new RollingByteBudget(
      () =>
        envInt(
          this.env,
          DESIGNER_UPLOAD_DAILY_BYTES_PER_STORE_ENV,
          DESIGNER_UPLOAD_DAILY_BYTES_PER_STORE_DEFAULT,
        ),
      now,
    );
  }

  /** Directory whose disk receives the photos. */
  storageRoot(): string | undefined {
    return this.storage?.root;
  }

  maxPhotosPerDesign(): number {
    return envInt(
      this.env,
      DESIGNER_MAX_PHOTOS_PER_DESIGN_ENV,
      DESIGNER_MAX_PHOTOS_PER_DESIGN_DEFAULT,
    );
  }

  private minFreeMb(): number {
    return envInt(
      this.env,
      DESIGNER_UPLOAD_MIN_FREE_MB_ENV,
      envInt(
        this.env,
        'CUSTOMER_UPLOAD_MIN_FREE_MB',
        DESIGNER_UPLOAD_MIN_FREE_MB_DEFAULT,
      ),
    );
  }

  /**
   * Throws 429 DESIGNER_UPLOAD_QUOTA / 503 DESIGNER_STORAGE_FULL when the
   * upload may not start. `bytes` = the announced request size (0 unknown).
   */
  async admit(c: {
    ip?: string;
    storeId?: string;
    designId?: string;
    bytes?: number;
    storageRoot?: string;
  }): Promise<void> {
    const bytes = c.bytes && c.bytes > 0 ? c.bytes : 0;
    if (!(await this.allows('ip', this.perIp, c.ip, bytes)))
      throw designerUploadQuota('ip');
    if (!(await this.allows('store', this.perStore, c.storeId, bytes)))
      throw designerUploadQuota('store');
    const maxPhotos = this.maxPhotosPerDesign();
    if (maxPhotos > 0 && c.designId && UUID_RE.test(c.designId)) {
      const n = await this.prisma.designAsset.count({
        where: {
          design_id: c.designId,
          kind: DesignAssetKind.CUSTOMER_PHOTO,
          purged_at: null,
        },
      });
      if (n >= maxPhotos)
        throw designerUploadQuota('design', { max_photos: maxPhotos });
    }
    const minMb = this.minFreeMb();
    if (minMb && c.storageRoot) {
      const free = await freeBytes(c.storageRoot);
      if (free !== null && free < minMb * 1024 * 1024 + bytes)
        throw designerStorageFull();
    }
  }

  /**
   * Shared counter when available (one indexed read), else the in-memory
   * window. The limit is read through the budget so `limit 0 = off` and the
   * `used >= limit || used + bytes > limit` rule stay identical.
   */
  private async allows(
    scope: 'ip' | 'store',
    local: RollingByteBudget,
    key: string | undefined,
    bytes: number,
  ): Promise<boolean> {
    const limit = local.limitOf();
    if (!limit || !key) return true;
    if (!this.store.available()) return local.allows(key, bytes);
    const used = await this.store.used(`designer.${scope}`, key, this.now());
    if (used === null) return local.allows(key, bytes);
    return used < limit && used + bytes <= limit;
  }

  /**
   * Charges a stored upload to the IP and the store: the local windows
   * synchronously (so callers that do not await still see it), then the
   * shared store.
   */
  async record(c: {
    ip?: string;
    storeId?: string;
    bytes: number;
  }): Promise<void> {
    this.perIp.consume(c.ip, c.bytes);
    this.perStore.consume(c.storeId, c.bytes);
    if (!(c.bytes > 0) || !this.store.available()) return;
    const now = this.now();
    if (c.ip && this.perIp.limitOf())
      await this.store.add('designer.ip', c.ip, c.bytes, now);
    if (c.storeId && this.perStore.limitOf())
      await this.store.add('designer.store', c.storeId, c.bytes, now);
  }
}

/**
 * Apply before `FileInterceptor` on the photo route:
 * `@UseInterceptors(DesignerPhotoAdmissionInterceptor, designerUploadLimit(…), FileInterceptor(…))`.
 * Guards (RequireAppGuard) run first, so `req.appStoreId` is set.
 */
@Injectable()
export class DesignerPhotoAdmissionInterceptor implements NestInterceptor {
  constructor(private readonly admission: DesignerUploadAdmission) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request & RequestWithAppStore>();
    const ip = req.ip;
    const storeId = req.appStoreId ?? undefined;
    const designId =
      typeof req.params?.id === 'string' ? req.params.id : undefined;
    const announced = Number(req.headers?.['content-length']);
    return from(
      this.admission.admit({
        ip,
        storeId,
        designId,
        bytes: Number.isFinite(announced) ? announced : 0,
        storageRoot: this.admission.storageRoot(),
      }),
    ).pipe(
      switchMap(() => next.handle()),
      concatMap((result: unknown) => {
        const size = (req as { file?: { size?: number } }).file?.size ?? 0;
        return from(this.admission.record({ ip, storeId, bytes: size })).pipe(
          map(() => result),
        );
      }),
    );
  }
}
