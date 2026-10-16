/**
 * Designer assets (M4.2 WP3): template backgrounds (web/print), decorations,
 * thumbnails and customer photos, stored privately under `designer/…`
 * (C10 `PRIVATE_STORAGE`), described by `DesignAsset` rows.
 *
 * - Every asset's canonical bytes live in private storage (`private_key`);
 *   the server renderer (WP5) reads exactly these bytes.
 * - Public kinds (web background, decoration, thumbnail) are additionally
 *   reachable at a stable, unguessable public path
 *   (`/api/designer/assets/<id>.<ext>`, `public_url`), so ISR-cached product
 *   pages never embed an expiring URL. Print backgrounds and customer photos
 *   are only reachable through signed links (`designer-urls.ts`).
 * - Uploads pass `inspectRaster()` (C20: format allowlist, no animation,
 *   pixel and side caps) and a full decode (truncated/corrupt files fail).
 *   Template assets keep their exact bytes unless they need EXIF rotation or
 *   a colour-space conversion to sRGB; customer photos are always
 *   EXIF-oriented, metadata-stripped sRGB re-encodes (§6.2).
 * - Low resolution never blocks a template asset; the response carries
 *   warnings (print background vs 6 px/mm, web background vs 2 px/mm,
 *   aspect mismatch) — U10, design Q8.
 *
 * Built on by: WP4 (`storePhoto`, `findOwnedAssets`, `assetView`), WP5
 * (`readAssetBytes`), WP6 (`purgeAssetFiles`), WP7 (`storeTemplateAsset`
 * with `source_url` for importer media, dedupe by sha256).
 */
import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { DesignAssetKind, Prisma, type DesignAsset } from '@prisma/client';
import sharp from 'sharp';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import {
  PRIVATE_STORAGE,
  type PrivateStorage,
} from '../../common/storage/private-file-storage';
import {
  inspectRaster,
  RasterInspectError,
  type RasterInfo,
} from '../../common/uploads/raster-inspect';
import { designerErrors } from './designer-errors';
import {
  ASSET_KIND_DIR,
  designerStorageKey,
  extForMime,
  extOfKey,
  MIME_BY_EXT,
  type DesignerFileExt,
} from './designer-assets.keys';
import {
  DESIGNER_LINK_TTL,
  designerAssetPath,
  designerFontPath,
  DesignerUrlsService,
} from './designer-urls';

/** Kinds a creator uploads for templates. */
export const TEMPLATE_ASSET_KINDS = [
  DesignAssetKind.TEMPLATE_BG_WEB,
  DesignAssetKind.TEMPLATE_BG_PRINT,
  DesignAssetKind.TEMPLATE_DECO,
  DesignAssetKind.TEMPLATE_THUMB,
] as const;
export type TemplateAssetKind = (typeof TEMPLATE_ASSET_KINDS)[number];

/** Kinds served at a public path (fonts through the font route). */
export const PUBLIC_ASSET_KINDS: readonly DesignAssetKind[] = [
  DesignAssetKind.TEMPLATE_BG_WEB,
  DesignAssetKind.TEMPLATE_DECO,
  DesignAssetKind.TEMPLATE_THUMB,
  DesignAssetKind.FONT,
];

/** Upload cap of template assets (print backgrounds can be large PNGs). */
export const TEMPLATE_ASSET_MAX_BYTES = 40 * 1024 * 1024;
/** Hard cap of customer photos; the store setting max_upload_mb is ≤ this. */
export const PHOTO_MAX_BYTES = 40 * 1024 * 1024;

/** Raster limits (§6.2): 100 MP, ≤ 12 000 px per side, still images only. */
export const TEMPLATE_RASTER_LIMITS = {
  maxPixels: 100_000_000,
  maxSide: 12_000,
  minShortSide: 16,
} as const;
export const PHOTO_RASTER_LIMITS = {
  maxPixels: 100_000_000,
  maxSide: 12_000,
  minShortSide: 300,
} as const;

/** Default template trim size when the asset is not tied to a template (NPP budget). */
export const DEFAULT_TEMPLATE_MM = { width: 500, height: 700 } as const;
/** U10: print at 6 px/mm (3000×4200 for 500×700). */
export const PRINT_PX_PER_MM = 6;
/** §3.1: preview / web background at 2 px/mm (1000×1400). */
export const PREVIEW_PX_PER_MM = 2;
/** A background below 80 % of the target resolution is flagged (§4.3, §10.2). */
export const LOW_RES_RATIO = 0.8;
/** Photo preview: WebP, longest side 1600 px, q80 (§6.2). */
export const PHOTO_PREVIEW_MAX = 1600;

export type AssetWarningCode =
  | 'PRINT_BG_LOW_RES'
  | 'WEB_BG_LOW_RES'
  | 'ASPECT_MISMATCH'
  | 'WEB_BG_LARGE'
  | 'COLOR_CONVERTED';

export interface AssetWarning {
  code: AssetWarningCode;
  params?: Record<string, number | string>;
}

export interface AssetResolution {
  /** Template size the check used. */
  template_mm: { width: number; height: number };
  template_size_source: 'template' | 'default';
  /** Pixels wanted at the kind's target scale (6 px/mm print, 2 px/mm web). */
  target_px: { width: number; height: number };
  /** min(px / inch) over both axes when stretched over the trim size. */
  effective_dpi: number;
}

export interface DesignerAssetView {
  id: string;
  kind: DesignAssetKind;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  created_at: Date;
  /** True when `url` is a stable public path; false = signed, short-lived. */
  public: boolean;
  /** Public path or signed path (relative to the API origin). */
  url: string | null;
  /** Signed preview path (customer photos only). */
  preview_url?: string | null;
  meta: Record<string, unknown>;
}

export interface StoreTemplateAssetInput {
  buffer: Buffer;
  kind: DesignAssetKind;
  template_id?: string | null;
  replaces_asset_id?: string | null;
  /** Importer media (WP7): original URL, kept in meta. */
  source_url?: string | null;
}

export interface StoreTemplateAssetResult {
  asset: DesignerAssetView;
  /** True when an identical file (same kind + sha256) already existed. */
  deduped: boolean;
  warnings: AssetWarning[];
  resolution: AssetResolution | null;
  /** The asset this one supersedes (`replaces_asset_id`), if any. */
  replaces: string | null;
}

/** File as delivered to a route handler. */
export interface DesignerFileBody {
  buffer: Buffer;
  mime: string;
  sha256?: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Maps a raster inspection failure to the designer upload codes. */
export function rasterError(e: unknown): Error {
  if (e instanceof RasterInspectError) {
    switch (e.code) {
      case 'RASTER_FORMAT_NOT_ALLOWED':
        return designerErrors.badRequest(
          'DESIGNER_UPLOAD_TYPE',
          'Only JPEG, PNG and WebP images are accepted.',
          { ...e.params, allowed: 'jpeg,png,webp' },
        );
      case 'RASTER_ANIMATED':
        return designerErrors.badRequest(
          'DESIGNER_UPLOAD_TYPE',
          'Animated images are not accepted.',
          { ...e.params, reason: 'animated' },
        );
      case 'RASTER_TOO_MANY_PIXELS':
      case 'RASTER_TOO_LARGE':
      case 'RASTER_TOO_SMALL':
        return designerErrors.badRequest(
          'DESIGNER_UPLOAD_DIMENSIONS',
          'The image dimensions are outside the allowed range.',
          { ...e.params, reason: e.code },
        );
      case 'RASTER_UNDECODABLE':
      default:
        return designerErrors.badRequest(
          'DESIGNER_UPLOAD_CORRUPT',
          'The file is not a readable image.',
        );
    }
  }
  return designerErrors.badRequest(
    'DESIGNER_UPLOAD_CORRUPT',
    'The file is not a readable image.',
  );
}

/**
 * Resolution checks of a template asset (pure). Backgrounds are drawn
 * stretched over the trim size (NPP `fit:'stretch'`), so the effective DPI
 * is the smaller of the two axes and an aspect mismatch distorts.
 */
export function templateAssetChecks(
  kind: DesignAssetKind,
  width: number,
  height: number,
  templateMm: { width: number; height: number },
  source: 'template' | 'default',
): { warnings: AssetWarning[]; resolution: AssetResolution | null } {
  const warnings: AssetWarning[] = [];
  if (
    kind !== DesignAssetKind.TEMPLATE_BG_PRINT &&
    kind !== DesignAssetKind.TEMPLATE_BG_WEB
  ) {
    return { warnings, resolution: null };
  }
  const scale =
    kind === DesignAssetKind.TEMPLATE_BG_PRINT
      ? PRINT_PX_PER_MM
      : PREVIEW_PX_PER_MM;
  const target = {
    width: Math.round(templateMm.width * scale),
    height: Math.round(templateMm.height * scale),
  };
  const dpi = Math.min(
    width / (templateMm.width / 25.4),
    height / (templateMm.height / 25.4),
  );
  const resolution: AssetResolution = {
    template_mm: { ...templateMm },
    template_size_source: source,
    target_px: target,
    effective_dpi: Math.round(dpi * 10) / 10,
  };
  if (
    width < target.width * LOW_RES_RATIO ||
    height < target.height * LOW_RES_RATIO
  ) {
    warnings.push({
      code:
        kind === DesignAssetKind.TEMPLATE_BG_PRINT
          ? 'PRINT_BG_LOW_RES'
          : 'WEB_BG_LOW_RES',
      params: {
        width,
        height,
        target_width: target.width,
        target_height: target.height,
        effective_dpi: resolution.effective_dpi,
      },
    });
  }
  if (
    kind === DesignAssetKind.TEMPLATE_BG_WEB &&
    (width > target.width * 2.5 || height > target.height * 2.5)
  ) {
    // The web background is what every storefront visitor downloads.
    warnings.push({
      code: 'WEB_BG_LARGE',
      params: {
        width,
        height,
        target_width: target.width,
        target_height: target.height,
      },
    });
  }
  const imgRatio = width / height;
  const tplRatio = templateMm.width / templateMm.height;
  if (Math.abs(imgRatio / tplRatio - 1) > 0.01) {
    warnings.push({
      code: 'ASPECT_MISMATCH',
      params: {
        image_ratio: Math.round(imgRatio * 1000) / 1000,
        template_ratio: Math.round(tplRatio * 1000) / 1000,
      },
    });
  }
  return { warnings, resolution };
}

/** Image jobs waiting for a sharp slot before new ones get 503. */
export const SHARP_MAX_QUEUE = 8;

/** 503 DESIGNER_UPLOAD_BUSY: the image pipeline is saturated. */
export function designerUploadBusy(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'DESIGNER_UPLOAD_BUSY',
    message: 'Too many images are being processed. Please try again shortly.',
  });
}

/**
 * Small counting semaphore (2 concurrent sharp jobs, §6.2). The queue is
 * bounded: past `maxQueue` waiting jobs a new one fails fast with 503
 * DESIGNER_UPLOAD_BUSY instead of holding its (up to 40 MB) buffer in memory.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(
    private readonly max: number,
    private readonly maxQueue: number = Infinity,
  ) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      if (this.queue.length >= this.maxQueue) throw designerUploadBusy();
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/** True when the image carries EXIF, XMP, IPTC or PNG text metadata. */
export function hasEmbeddedMetadata(meta: sharp.Metadata): boolean {
  return (
    !!meta.exif?.length ||
    !!meta.xmp?.length ||
    !!meta.iptc?.length ||
    !!(meta as { comments?: unknown[] }).comments?.length
  );
}

/** In-process cache of public asset/font responses (bytes + row). */
export const PUBLIC_CACHE_TTL_MS = 60_000;
export const PUBLIC_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const PUBLIC_CACHE_MAX_ENTRY_BYTES = 8 * 1024 * 1024;

/**
 * Small LRU (Map insertion order) bounded by total bytes, keyed by asset id,
 * with a TTL so a purge on another instance takes effect within a minute
 * (this instance evicts on purge/delete at once). The app switch is never
 * cached here.
 */
export class PublicAssetCache<T extends { buffer: Buffer }> {
  private readonly map = new Map<string, { at: number; value: T }>();
  private bytes = 0;

  constructor(
    private readonly ttlMs = PUBLIC_CACHE_TTL_MS,
    private readonly maxBytes = PUBLIC_CACHE_MAX_BYTES,
    private readonly maxEntryBytes = PUBLIC_CACHE_MAX_ENTRY_BYTES,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get(id: string): T | undefined {
    const e = this.map.get(id);
    if (!e) return undefined;
    if (this.now() - e.at >= this.ttlMs) {
      this.delete(id);
      return undefined;
    }
    // Refresh recency.
    this.map.delete(id);
    this.map.set(id, e);
    return e.value;
  }

  set(id: string, value: T): void {
    const size = value.buffer.length;
    if (size > this.maxEntryBytes) return;
    this.delete(id);
    this.map.set(id, { at: this.now(), value });
    this.bytes += size;
    while (this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  delete(id: string): void {
    const e = this.map.get(id);
    if (!e) return;
    this.bytes -= e.value.buffer.length;
    this.map.delete(id);
  }
}

interface PreparedRaster {
  data: Buffer;
  ext: DesignerFileExt;
  width: number;
  height: number;
  normalized: boolean;
}

@Injectable()
export class DesignerAssetsService {
  private readonly logger = new Logger(DesignerAssetsService.name);
  private readonly sharpJobs = new Semaphore(2, SHARP_MAX_QUEUE);
  /** Public template asset / font responses (the routes are unthrottled). */
  readonly publicCache = new PublicAssetCache<
    DesignerFileBody & { asset: DesignAsset }
  >();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PRIVATE_STORAGE) private readonly storage: PrivateStorage,
    private readonly storeApps: StoreAppsService,
    private readonly urls: DesignerUrlsService,
  ) {}

  // ── Views ─────────────────────────────────────────────────────────────────

  isPublicKind(kind: DesignAssetKind): boolean {
    return PUBLIC_ASSET_KINDS.includes(kind);
  }

  /** API view of a row; private kinds get signed paths valid `ttlSec`. */
  assetView(a: DesignAsset, opts: { ttlSec?: number } = {}): DesignerAssetView {
    const ext = extForMime(a.mime);
    const isPublic = this.isPublicKind(a.kind);
    let url: string | null = null;
    if (!a.purged_at) {
      if (isPublic && ext) {
        url =
          a.kind === DesignAssetKind.FONT
            ? designerFontPath(a.id, ext)
            : designerAssetPath(a.id, ext);
      } else if (a.private_key) {
        url = this.urls.signedPath('asset', a.id, a.store_id, {
          ttlSec: opts.ttlSec ?? DESIGNER_LINK_TTL.creator,
        });
      }
    }
    const view: DesignerAssetView = {
      id: a.id,
      kind: a.kind,
      mime: a.mime,
      width: a.width,
      height: a.height,
      bytes: a.bytes,
      sha256: a.sha256,
      created_at: a.created_at,
      public: isPublic,
      url,
      meta: isRecord(a.meta) ? a.meta : {},
    };
    if (a.kind === DesignAssetKind.CUSTOMER_PHOTO) {
      view.preview_url =
        a.preview_key && !a.purged_at
          ? this.urls.signedPath('photo_preview', a.id, a.store_id, {
              ttlSec: opts.ttlSec ?? DESIGNER_LINK_TTL.editor,
            })
          : null;
    }
    return view;
  }

  // ── Lookups ───────────────────────────────────────────────────────────────

  /** The store's asset or 404 (also for another store's id: no enumeration). */
  async getOwnedAsset(storeId: string, id: string): Promise<DesignAsset> {
    const a = UUID_RE.test(id)
      ? await this.prisma.designAsset.findFirst({
          where: { id, store_id: storeId },
        })
      : null;
    if (!a) {
      throw designerErrors.notFound(
        'DESIGNER_ASSET_NOT_FOUND',
        'Asset not found.',
      );
    }
    return a;
  }

  /**
   * Rows of `ids` that belong to the store and are not purged (WP4 template
   * `validateSpec`: every referenced asset id must be in the result).
   */
  async findOwnedAssets(
    storeId: string,
    ids: string[],
    kinds?: DesignAssetKind[],
  ): Promise<Map<string, DesignAsset>> {
    const clean = [...new Set(ids.filter((id) => UUID_RE.test(id)))];
    if (!clean.length) return new Map();
    const rows = await this.prisma.designAsset.findMany({
      where: {
        id: { in: clean },
        store_id: storeId,
        purged_at: null,
        ...(kinds ? { kind: { in: kinds } } : {}),
      },
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Template assets of the store (never customer photos), newest first. */
  async listTemplateAssets(
    storeId: string,
    q: { kind?: DesignAssetKind; page?: number; limit?: number } = {},
  ) {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const page = Math.max(q.page ?? 1, 1);
    const kinds: DesignAssetKind[] = q.kind
      ? [q.kind]
      : [...TEMPLATE_ASSET_KINDS];
    const where: Prisma.DesignAssetWhereInput = {
      store_id: storeId,
      kind: { in: kinds.filter((k) => k !== DesignAssetKind.CUSTOMER_PHOTO) },
      purged_at: null,
    };
    const [rows, total] = await Promise.all([
      this.prisma.designAsset.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.designAsset.count({ where }),
    ]);
    return {
      items: rows.map((r) => this.assetView(r)),
      total,
      page,
      limit,
    };
  }

  // ── Template assets ───────────────────────────────────────────────────────

  /**
   * Stores a template asset (creator upload, or importer media for WP7).
   * Identical bytes of the same kind are reused (`deduped`), unless the call
   * replaces another asset. A replacement never overwrites bytes in place:
   * published versions and order snapshots keep pointing at the old asset;
   * the new id goes into the next template version.
   */
  async storeTemplateAsset(
    storeId: string,
    input: StoreTemplateAssetInput,
  ): Promise<StoreTemplateAssetResult> {
    const kind = input.kind;
    if (!(TEMPLATE_ASSET_KINDS as readonly DesignAssetKind[]).includes(kind)) {
      throw designerErrors.badRequest(
        'DESIGNER_ASSET_KIND',
        'This asset kind cannot be uploaded here.',
        { kind, allowed: TEMPLATE_ASSET_KINDS.join(',') },
      );
    }
    const buf = input.buffer;
    if (!buf?.length) {
      throw designerErrors.badRequest(
        'DESIGNER_UPLOAD_CORRUPT',
        'No file was received.',
      );
    }
    if (buf.length > TEMPLATE_ASSET_MAX_BYTES) {
      throw designerErrors.tooLarge('The file is too large.', {
        max_mb: TEMPLATE_ASSET_MAX_BYTES / (1024 * 1024),
      });
    }

    const templateMm = await this.templateSize(storeId, input.template_id);
    let replaced: DesignAsset | null = null;
    if (input.replaces_asset_id) {
      replaced = await this.getOwnedAsset(storeId, input.replaces_asset_id);
      if (replaced.kind !== kind) {
        throw designerErrors.badRequest(
          'DESIGNER_ASSET_KIND',
          'A replacement must be of the same kind as the asset it replaces.',
          { kind, replaces_kind: replaced.kind },
        );
      }
    }

    const info = await this.inspect(buf, TEMPLATE_RASTER_LIMITS);
    const prepared = await this.prepareTemplateRaster(buf, info);
    const hash = sha256(prepared.data);
    const { warnings, resolution } = templateAssetChecks(
      kind,
      prepared.width,
      prepared.height,
      templateMm.size,
      templateMm.source,
    );
    if (prepared.normalized) {
      warnings.push({ code: 'COLOR_CONVERTED' });
    }

    if (!replaced) {
      const existing = await this.prisma.designAsset.findFirst({
        where: { store_id: storeId, kind, sha256: hash, purged_at: null },
        orderBy: { created_at: 'asc' },
      });
      if (existing) {
        return {
          asset: this.assetView(existing),
          deduped: true,
          warnings,
          resolution,
          replaces: null,
        };
      }
    }

    const meta: Record<string, unknown> = {};
    if (input.template_id) meta.template_id = input.template_id;
    if (replaced) meta.replaces = replaced.id;
    if (input.source_url) meta.source_url = String(input.source_url);
    if (prepared.normalized) meta.normalized = true;
    if (warnings.length) meta.warnings = warnings.map((w) => w.code);

    const row = await this.writeAsset(storeId, {
      kind,
      data: prepared.data,
      ext: prepared.ext,
      width: prepared.width,
      height: prepared.height,
      sha256: hash,
      meta,
    });
    return {
      asset: this.assetView(row),
      deduped: false,
      warnings,
      resolution,
      replaces: replaced?.id ?? null,
    };
  }

  /**
   * Trim size for the resolution checks: the template's current (else
   * latest) version, else the NPP default 500×700.
   */
  private async templateSize(
    storeId: string,
    templateId: string | null | undefined,
  ): Promise<{
    size: { width: number; height: number };
    source: 'template' | 'default';
  }> {
    if (!templateId)
      return { size: { ...DEFAULT_TEMPLATE_MM }, source: 'default' };
    const tpl = UUID_RE.test(templateId)
      ? await this.prisma.designTemplate.findFirst({
          where: { id: templateId, store_id: storeId },
          select: {
            current_version_id: true,
            versions: {
              orderBy: { version: 'desc' },
              select: { id: true, spec: true },
            },
          },
        })
      : null;
    if (!tpl) {
      throw designerErrors.notFound(
        'DESIGNER_TEMPLATE_NOT_FOUND',
        'Template not found.',
      );
    }
    const version =
      tpl.versions.find((v) => v.id === tpl.current_version_id) ??
      tpl.versions[0];
    const spec = version?.spec as { width?: unknown; height?: unknown } | null;
    const w = Number(spec?.width);
    const h = Number(spec?.height);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { size: { width: w, height: h }, source: 'template' };
    }
    return { size: { ...DEFAULT_TEMPLATE_MM }, source: 'default' };
  }

  private async inspect(
    buf: Buffer,
    limits: { maxPixels: number; maxSide: number; minShortSide: number },
  ): Promise<RasterInfo> {
    try {
      return await inspectRaster(buf, limits);
    } catch (e) {
      throw rasterError(e);
    }
  }

  /**
   * Exact bytes when they are already display-ready (no EXIF rotation, no
   * embedded profile, sRGB/grey); otherwise an EXIF-rotated sRGB re-encode
   * (PNG when the source is PNG or has alpha, else JPEG q95 4:4:4). A full
   * decode runs in both cases, so a truncated file is rejected here.
   */
  private async prepareTemplateRaster(
    buf: Buffer,
    info: RasterInfo,
  ): Promise<PreparedRaster> {
    return this.sharpJobs.run(async () => {
      let meta: sharp.Metadata;
      try {
        const input = sharp(buf, {
          failOn: 'error',
          limitInputPixels: TEMPLATE_RASTER_LIMITS.maxPixels,
        });
        meta = await input.metadata();
        // Full decode (shrink-on-load keeps it cheap) to catch truncation.
        await input.clone().resize(64, 64, { fit: 'inside' }).raw().toBuffer();
      } catch {
        throw designerErrors.badRequest(
          'DESIGNER_UPLOAD_CORRUPT',
          'The file is not a readable image.',
        );
      }
      const orientation = meta.orientation ?? 1;
      const space = meta.space ?? 'srgb';
      // Embedded metadata (EXIF incl. GPS, XMP, IPTC, PNG text chunks) forces
      // a re-encode, which drops it: public assets never leak it.
      const ready =
        orientation === 1 &&
        !meta.hasProfile &&
        !hasEmbeddedMetadata(meta) &&
        (space === 'srgb' || space === 'b-w');
      const ext: DesignerFileExt =
        info.format === 'jpeg' ? 'jpg' : (info.format as DesignerFileExt);
      if (ready) {
        return {
          data: buf,
          ext,
          width: info.width,
          height: info.height,
          normalized: false,
        };
      }
      const asPng = info.format === 'png' || !!meta.hasAlpha;
      try {
        const pipeline = sharp(buf, {
          failOn: 'error',
          limitInputPixels: TEMPLATE_RASTER_LIMITS.maxPixels,
        })
          .rotate()
          .toColourspace('srgb');
        const { data, info: out } = await (
          asPng
            ? pipeline.png({ compressionLevel: 6 })
            : pipeline.jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
        ).toBuffer({ resolveWithObject: true });
        return {
          data,
          ext: asPng ? 'png' : 'jpg',
          width: out.width,
          height: out.height,
          normalized: true,
        };
      } catch {
        throw designerErrors.badRequest(
          'DESIGNER_UPLOAD_CORRUPT',
          'The file is not a readable image.',
        );
      }
    });
  }

  /** Writes the file, then the row; a failed insert removes the file again. */
  private async writeAsset(
    storeId: string,
    a: {
      kind: DesignAssetKind;
      data: Buffer;
      ext: DesignerFileExt;
      width: number;
      height: number;
      sha256: string;
      meta: Record<string, unknown>;
      design_id?: string | null;
      preview?: Buffer | null;
    },
  ): Promise<DesignAsset> {
    const id = randomUUID();
    const at = new Date();
    const key = designerStorageKey(storeId, ASSET_KIND_DIR[a.kind], id, a.ext, {
      at,
    });
    const previewKey = a.preview
      ? designerStorageKey(storeId, 'photo-preview', id, 'webp', { at })
      : null;
    await this.storage.write(key, a.data);
    if (previewKey && a.preview) {
      try {
        await this.storage.write(previewKey, a.preview);
      } catch (e) {
        await this.storage.delete(key).catch(() => undefined);
        throw e;
      }
    }
    const isPublic = this.isPublicKind(a.kind);
    try {
      return await this.prisma.designAsset.create({
        data: {
          id,
          store_id: storeId,
          kind: a.kind,
          design_id: a.design_id ?? null,
          private_key: key,
          preview_key: previewKey,
          public_url: isPublic
            ? a.kind === DesignAssetKind.FONT
              ? designerFontPath(id, a.ext)
              : designerAssetPath(id, a.ext)
            : null,
          mime: MIME_BY_EXT[a.ext],
          width: a.width,
          height: a.height,
          bytes: a.data.length,
          sha256: a.sha256,
          meta: a.meta as Prisma.InputJsonValue,
          created_at: at,
        },
      });
    } catch (e) {
      await this.storage.delete(key).catch(() => undefined);
      if (previewKey)
        await this.storage.delete(previewKey).catch(() => undefined);
      throw e;
    }
  }

  /** Shared by the font service: stores bytes of a non-raster asset. */
  async writeRawAsset(
    storeId: string,
    a: {
      kind: DesignAssetKind;
      data: Buffer;
      ext: DesignerFileExt;
      sha256: string;
      meta: Record<string, unknown>;
    },
  ): Promise<DesignAsset> {
    return this.writeAsset(storeId, { ...a, width: 0, height: 0 });
  }

  // ── Customer photos (§6.2; the public route is WP4) ───────────────────────

  /**
   * Customer photo pipeline: inspect (jpeg/png/webp, still, short side ≥ 300,
   * side ≤ 12 000, ≤ 100 MP), EXIF-orient, convert to sRGB and strip every
   * metadata block (GPS/EXIF never stored). Original = JPEG q95 4:4:4 (PNG
   * for PNG sources, keeps alpha); preview = WebP ≤ 1600 px q80. Dimensions
   * are those after rotation. The original filename is never kept.
   */
  async storePhoto(
    storeId: string,
    buffer: Buffer,
    opts: { design_id?: string | null; max_bytes?: number } = {},
  ): Promise<DesignAsset> {
    const max = Math.min(opts.max_bytes ?? PHOTO_MAX_BYTES, PHOTO_MAX_BYTES);
    if (!buffer?.length) {
      throw designerErrors.badRequest(
        'DESIGNER_UPLOAD_CORRUPT',
        'No file was received.',
      );
    }
    if (buffer.length > max) {
      throw designerErrors.tooLarge('The photo is too large.', {
        max_mb: Math.round((max / (1024 * 1024)) * 10) / 10,
      });
    }
    const info = await this.inspect(buffer, PHOTO_RASTER_LIMITS);
    const { original, preview, width, height, ext } = await this.sharpJobs.run(
      async () => {
        try {
          const base = () =>
            sharp(buffer, {
              failOn: 'error',
              limitInputPixels: PHOTO_RASTER_LIMITS.maxPixels,
            })
              .rotate()
              .toColourspace('srgb');
          const asPng = info.format === 'png';
          const orig = await (
            asPng
              ? base().png({ compressionLevel: 6 })
              : base().jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
          ).toBuffer({ resolveWithObject: true });
          const prev = await sharp(orig.data)
            .resize(PHOTO_PREVIEW_MAX, PHOTO_PREVIEW_MAX, {
              fit: 'inside',
              withoutEnlargement: true,
            })
            .webp({ quality: 80 })
            .toBuffer();
          return {
            original: orig.data,
            preview: prev,
            width: orig.info.width,
            height: orig.info.height,
            ext: (asPng ? 'png' : 'jpg') as DesignerFileExt,
          };
        } catch {
          throw designerErrors.badRequest(
            'DESIGNER_UPLOAD_CORRUPT',
            'The file is not a readable image.',
          );
        }
      },
    );
    return this.writeAsset(storeId, {
      kind: DesignAssetKind.CUSTOMER_PHOTO,
      data: original,
      ext,
      width,
      height,
      sha256: sha256(original),
      meta: {},
      design_id: opts.design_id ?? null,
      preview,
    });
  }

  // ── Bytes (renderer, routes) ──────────────────────────────────────────────

  /** Stored bytes of an asset; 410 once purged, 404 when the file is missing. */
  async readAssetBytes(
    asset: DesignAsset,
    variant: 'original' | 'preview' = 'original',
  ): Promise<Buffer> {
    if (asset.purged_at) {
      throw designerErrors.gone(
        'DESIGNER_FILES_PURGED',
        'This file has been deleted.',
      );
    }
    const key = variant === 'preview' ? asset.preview_key : asset.private_key;
    const data = key ? await this.storage.read(key) : null;
    if (!data) {
      throw designerErrors.notFound(
        'DESIGNER_FILE_NOT_FOUND',
        'File not found.',
      );
    }
    return data;
  }

  /**
   * Public template asset (`GET designer/assets/<id>.<ext>`): a public kind,
   * not purged, the extension matching the stored type, and the designer app
   * enabled for the owning store (404 otherwise — app off hides the files).
   */
  async readPublicAsset(
    id: string,
    ext: string,
    kinds: readonly DesignAssetKind[] = [
      DesignAssetKind.TEMPLATE_BG_WEB,
      DesignAssetKind.TEMPLATE_DECO,
      DesignAssetKind.TEMPLATE_THUMB,
    ],
  ): Promise<DesignerFileBody & { asset: DesignAsset }> {
    const cached = this.publicCache.get(id);
    if (cached) {
      if (
        !kinds.includes(cached.asset.kind) ||
        extForMime(cached.asset.mime) !== ext
      ) {
        throw designerErrors.notFound(
          'DESIGNER_FILE_NOT_FOUND',
          'File not found.',
        );
      }
      // The app switch is checked on every request (StoreAppsService caches it).
      if (
        !(await this.storeApps.isEnabled(cached.asset.store_id, 'designer'))
      ) {
        throw designerErrors.notFound(
          'DESIGNER_NOT_ENABLED',
          'The designer is not enabled for this store.',
        );
      }
      return cached;
    }
    const a = UUID_RE.test(id)
      ? await this.prisma.designAsset.findUnique({ where: { id } })
      : null;
    if (!a || !kinds.includes(a.kind) || extForMime(a.mime) !== ext) {
      throw designerErrors.notFound(
        'DESIGNER_FILE_NOT_FOUND',
        'File not found.',
      );
    }
    if (!(await this.storeApps.isEnabled(a.store_id, 'designer'))) {
      throw designerErrors.notFound(
        'DESIGNER_NOT_ENABLED',
        'The designer is not enabled for this store.',
      );
    }
    const buffer = await this.readAssetBytes(a);
    const out = { buffer, mime: a.mime, sha256: a.sha256, asset: a };
    this.publicCache.set(a.id, out);
    return out;
  }

  /**
   * Resolves a signed link (`GET designer/files/:token`). The token's store
   * must own the row. `oid_proof` links (emails, account) keep working after
   * the app is switched off (order history); every other kind needs the app.
   */
  async readSignedFile(token: string): Promise<DesignerFileBody> {
    const check = this.urls.verify(token);
    if (!check.ok) {
      if (check.reason === 'expired') {
        throw designerErrors.forbidden(
          'DESIGNER_LINK_EXPIRED',
          'This link has expired.',
        );
      }
      throw designerErrors.notFound(
        'DESIGNER_FILE_NOT_FOUND',
        'File not found.',
      );
    }
    const { k, id, s } = check.payload;
    const notFound = () =>
      designerErrors.notFound('DESIGNER_FILE_NOT_FOUND', 'File not found.');
    if (k !== 'oid_proof' && !(await this.storeApps.isEnabled(s, 'designer'))) {
      throw designerErrors.notFound(
        'DESIGNER_NOT_ENABLED',
        'The designer is not enabled for this store.',
      );
    }

    if (k === 'asset' || k === 'photo_preview') {
      const a = await this.prisma.designAsset.findUnique({ where: { id } });
      if (!a || a.store_id !== s) throw notFound();
      if (k === 'photo_preview' && a.kind !== DesignAssetKind.CUSTOMER_PHOTO) {
        throw notFound();
      }
      const variant = k === 'photo_preview' ? 'preview' : 'original';
      const buffer = await this.readAssetBytes(a, variant);
      return {
        buffer,
        mime: variant === 'preview' ? 'image/webp' : a.mime,
        sha256: variant === 'preview' ? undefined : a.sha256,
      };
    }

    let key: string | null = null;
    if (k === 'proof') {
      const d = await this.prisma.design.findUnique({
        where: { id },
        select: { store_id: true, proof_key: true },
      });
      if (!d || d.store_id !== s) throw notFound();
      key = d.proof_key;
    } else {
      const o = await this.prisma.orderItemDesign.findUnique({
        where: { id },
        select: { store_id: true, proof_key: true, files_purged_at: true },
      });
      if (!o || o.store_id !== s) throw notFound();
      if (o.files_purged_at) {
        throw designerErrors.gone(
          'DESIGNER_FILES_PURGED',
          'This file has been deleted.',
        );
      }
      key = o.proof_key;
    }
    const data = key ? await this.storage.read(key) : null;
    const ext = key ? extOfKey(key) : null;
    if (!data || !ext) throw notFound();
    return { buffer: data, mime: MIME_BY_EXT[ext] };
  }

  // ── Delete / purge ────────────────────────────────────────────────────────

  /**
   * Where an asset id is still used: template versions of the store and
   * frozen order snapshots (spec + assets JSON). Ids are uuids, so a text
   * search over the JSON is exact enough and needs no JSON-path walk.
   */
  async assetReferences(
    storeId: string,
    assetId: string,
  ): Promise<{ template_versions: number; order_items: number }> {
    const needle = `%${assetId}%`;
    const [tv, oi] = await Promise.all([
      this.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*)::bigint AS n
        FROM "DesignTemplateVersion" v
        JOIN "DesignTemplate" t ON t.id = v.template_id
        WHERE t.store_id = ${storeId}
          AND (v.spec::text LIKE ${needle}
               OR COALESCE(v.thumbnail_url, '') LIKE ${needle})`,
      this.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*)::bigint AS n
        FROM "OrderItemDesign" o
        WHERE o.store_id = ${storeId}
          AND (o.template_spec::text LIKE ${needle} OR o.assets::text LIKE ${needle})`,
    ]);
    return {
      template_versions: Number(tv[0]?.n ?? 0),
      order_items: Number(oi[0]?.n ?? 0),
    };
  }

  /**
   * Creator delete of a template asset or font that nothing references
   * (409 DESIGNER_ASSET_IN_USE otherwise). Customer photos are removed by
   * the design flow / retention, never here.
   */
  async deleteAsset(storeId: string, id: string): Promise<{ deleted: true }> {
    const a = await this.getOwnedAsset(storeId, id);
    if (a.kind === DesignAssetKind.CUSTOMER_PHOTO) {
      throw designerErrors.badRequest(
        'DESIGNER_ASSET_KIND',
        'Customer photos are removed with their design.',
        { kind: a.kind },
      );
    }
    const refs = await this.assetReferences(storeId, a.id);
    if (refs.template_versions > 0 || refs.order_items > 0) {
      throw designerErrors.conflict(
        'DESIGNER_ASSET_IN_USE',
        'The asset is used by a template version or an order.',
        refs,
      );
    }
    await this.prisma.designAsset.delete({ where: { id: a.id } });
    await this.deleteFiles(a);
    return { deleted: true };
  }

  /**
   * Deletes the files of an asset and marks the row purged (retention, WP6).
   * `strict` (retention) rethrows a storage failure instead of logging it,
   * so the caller can revert its claim and retry on the next run.
   */
  async purgeAssetFiles(
    asset: DesignAsset,
    now = new Date(),
    opts: { strict?: boolean } = {},
  ): Promise<void> {
    await this.deleteFiles(asset, opts.strict === true);
    if (!asset.purged_at) {
      await this.prisma.designAsset.update({
        where: { id: asset.id },
        data: { purged_at: now },
      });
    }
  }

  private async deleteFiles(a: DesignAsset, strict = false): Promise<void> {
    this.publicCache.delete(a.id);
    for (const key of [a.private_key, a.preview_key]) {
      if (!key) continue;
      try {
        await this.storage.delete(key);
      } catch (e) {
        if (strict) throw e;
        this.logger.warn(
          `designer asset ${a.id}: could not delete ${key}: ${String(e)}`,
        );
      }
    }
  }
}
