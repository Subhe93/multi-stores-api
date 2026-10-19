import { fileRefPath } from '@multi-stores/core/personalization/rules';

/**
 * Customer uploads (M4.0 §8) — contract shared by WP-A (order write path)
 * and WP-B (upload endpoint, storage, download, retention).
 */

/** Public preview URL path of an upload: `/uploads/customer-previews/<uuid>.webp`. */
export const CUSTOMER_PREVIEW_FOLDER = 'customer-previews';

/** Private storage namespace of the originals (see PRIVATE_STORAGE_KEY_PATTERNS). */
export const CUSTOMER_UPLOAD_STORAGE_NAMESPACE = 'customer-uploads';

/**
 * The exact preview path (`/uploads/customer-previews/<uuid>.webp`) and its
 * upload id. Anchored at both ends: no prefix, query string or fragment.
 */
export const CUSTOMER_PREVIEW_PATH_RE =
  /^\/uploads\/customer-previews\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.webp$/i;

/**
 * Upload id behind a preview URL, or null when the URL is not a preview
 * (legacy value). THE single parser of preview URLs (order write path,
 * upload resolution, quote): a relative URL must be exactly the preview
 * path; an absolute http(s) URL must have exactly that path with no query
 * string or fragment (same rule as `fileRefPath` / `isFileRefPath`). The
 * host of an absolute URL is checked by `PersonalizationCoreService.isFileRef`.
 */
export function parseCustomerPreviewId(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 2048) return null;
  const pathname = fileRefPath(url);
  if (pathname === null) return null;
  const m = CUSTOMER_PREVIEW_PATH_RE.exec(pathname);
  return m ? m[1].toLowerCase() : null;
}

/** Result of `CustomerUploadsService.resolveForOrder` for one preview URL. */
export interface ResolvedCustomerUpload {
  id: string;
  /** True when the files were removed by retention (`purged_at` set). */
  purged: boolean;
}

/**
 * Per-store retention opinion (M4.0 §8.3, C23). Several policies → the
 * minimum number wins; none returns a number → platform default
 * (`CUSTOMER_UPLOAD_RETENTION_DAYS`, unset = keep forever).
 */
export interface CustomerUploadRetentionPolicy {
  /**
   * Days to keep originals + previews after attach for this store.
   * number = keep N days; null = keep forever; undefined = no opinion.
   */
  retentionDays(storeId: string): Promise<number | null | undefined>;
}

export interface CustomerUploadRetentionOptions {
  dryRun?: boolean;
  /** Default 500. */
  limit?: number;
  /** Epoch ms by which the run must have returned (retention transaction timeout). */
  deadline?: number;
}

export interface CustomerUploadRetentionResult {
  purgedAttached: number;
  purgedOrphans: number;
  skippedOpenOrders: number;
  errors: number;
}

/** Env: days to keep attached uploads when no policy answers (unset = forever, K1). */
export const CUSTOMER_UPLOAD_RETENTION_DAYS_ENV =
  'CUSTOMER_UPLOAD_RETENTION_DAYS';
/** Env: days before never-attached uploads are purged (default 30). */
export const CUSTOMER_UPLOAD_ORPHAN_DAYS_ENV = 'CUSTOMER_UPLOAD_ORPHAN_DAYS';
export const CUSTOMER_UPLOAD_ORPHAN_DAYS_DEFAULT = 30;

/** Order statuses in which an attached upload may be purged (all orders must be in one). */
export const CUSTOMER_UPLOAD_PURGEABLE_ORDER_STATUSES = [
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'REFUNDED',
  'RETURNED',
] as const;

/** Retention task key in the generic RetentionService (C22). */
export const CUSTOMER_UPLOAD_RETENTION_TASK = 'customer-uploads';

/** Max upload size (same as the existing uploads endpoint). */
export const CUSTOMER_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
/** Max pixels of one raster frame (header check before any decode). */
export const CUSTOMER_UPLOAD_MAX_PIXELS = 100_000_000;
/** Accepted file extensions; raster files are also checked by content. */
export const CUSTOMER_UPLOAD_RASTER_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
export const CUSTOMER_UPLOAD_DOCUMENT_EXTS = ['.pdf', '.ai'];

/** Response of `POST /uploads/customer` (inside the usual `{ data }` envelope). */
export interface CustomerUploadResponse {
  /** Public preview URL (`/uploads/customer-previews/<id>.webp`): the field value. */
  url: string;
  upload_id: string;
  /** Extension of the stored original, without the dot (`jpg`, `png`, `webp`, `pdf`, `ai`). */
  file_type: string;
  /** Bytes of the original. */
  file_size: number;
  width: number | null;
  height: number | null;
  original_name: string;
  mime: string;
}
