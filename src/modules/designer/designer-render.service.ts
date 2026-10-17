/**
 * Proof and print rendering of the designer app (M4.2 §5.1–5.2, §5.4, WP5).
 *
 * - Inputs are prepared in Node: every image is read from private storage
 *   (`DesignerAssetsService.readAssetBytes`), fonts from the store's font
 *   assets (`DesignerFontsService.fontFiles`). Nothing is fetched.
 * - Print (`renderPrint`): print background (falling back to web),
 *   decorations and customer photo ORIGINALS, each photo pre-cut to the
 *   region its slot shows (the slot clip rotated into the photo's frame,
 *   intersected with the drawn image: `photoVisibleCrop`) and pre-scaled
 *   with sharp to the size that region is drawn at (never upscaled). A
 *   zoomed photo therefore costs the slot's pixels, not zoom² of them,
 *   which bounds the bitmap Chromium decodes (see DESIGNER_RENDER_CONCURRENCY
 *   in .env.example for the per-job RAM). The render page remaps the
 *   cropped bitmap to its sub-rect, so the shared renderer is unchanged. The
 *   canvas runs at 6 px/mm (3000×4200 for 500×700), then sharp embeds the
 *   sRGB profile and 25.4×px/mm DPI (152.4) and the PNG is stored under
 *   `designer/<store>/<yyyy>/print/<oidId>-front.png`.
 * - Proof (`renderDesignProof`): web background, photo previews, scale 2,
 *   WebP q 0.85, stored under
 *   `designer/<store>/<yyyy>/proof/<designId>-<sha>.webp` (`<sha>` = the
 *   first 16 hex digits of the proof sha as letters a–p), so every state has
 *   its own key and two renders never overwrite each other's file;
 *   re-rendered only when `sha256(canonical(state) + version_id)` changed.
 *   The row is updated through `replaceDesignProofKey` (fenced by
 *   `state_version`); the winner releases the superseded file, a loser
 *   releases its own (`releaseProofKey` never deletes a key another design
 *   or an unpurged order snapshot still uses). Identical requests share one
 *   render; at most one proof renders per store at a time (a few wait, the
 *   rest get 503 DESIGNER_RENDER_UNAVAILABLE).
 * - Canvas clamps: a proof is at most PROOF_MAX_PIXELS (~4 MP) and a print
 *   at most PRINT_MAX_PIXELS / DESIGNER_MAX_CANVAS_SIDE per side, whatever
 *   `preview_px_per_mm` or the trim size in the spec say.
 * - Locale: placeholders resolve in the order's locale (print) or the
 *   store's primary locale (proof), falling back to the store's primary.
 * - The order proof is derived from the print PNG (sharp downscale) when the
 *   snapshot did not reuse the design's proof.
 * - Determinism: inputs are byte-identical per job, prescaling and encoding
 *   are deterministic, and the canvas runs in software raster, so the same
 *   input gives the same pixels (verified by the real-browser spec).
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { createHash } from 'crypto';
import {
  DesignAssetKind,
  Prisma,
  type DesignAsset,
  type OrderItemDesign,
} from '@prisma/client';
import sharp from 'sharp';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PRIVATE_STORAGE,
  type PrivateStorage,
} from '../../common/storage/private-file-storage';
import { DesignerAssetsService } from './designer-assets.service';
import { designerStorageKey } from './designer-assets.keys';
import { designerErrorCode, designerErrors } from './designer-errors';
import { DesignerFontsService } from './designer-fonts.service';
import { releaseProofKey, replaceDesignProofKey } from './designer-proof-keys';
import { DESIGNER_LINK_TTL, DesignerUrlsService } from './designer-urls';
import { designProofSha } from './designs.util';
import {
  canvasSize,
  coverLayout,
  DEFAULT_ADJ,
  type DesignPhoto,
  type DesignStateV1,
  type ElementBase,
  type Mode,
  type RenderReport,
  type TemplateSpecV1,
} from './render/design-renderer';
import {
  DESIGNER_BROWSER,
  DESIGNER_MAX_CANVAS_SIDE,
  DesignerRenderUnavailableError,
  type CanvasAsset,
  type CanvasJob,
  type CropFraction,
  type DesignerBrowserRenderer,
  type RenderFile,
} from './render/designer-chromium.host';
import {
  Semaphore,
  SemaphoreBusyError,
} from '../../common/chromium/browser-host';

/** Budget of an interactive proof (§4.1: 10 s). */
export const PROOF_TIMEOUT_MS = 10_000;
/** Budget of a print canvas (§5.1: 60 s). */
export const PRINT_TIMEOUT_MS = 60_000;
/** Proof scale (px/mm) when the spec does not say. */
export const PROOF_PX_PER_MM = 2;
/** Print scale (px/mm): NPP parity, U10. */
export const PRINT_PX_PER_MM = 6;
export const PROOF_WEBP_QUALITY = 0.85;
/** Largest proof canvas (pixels), whatever the spec asks for. */
export const PROOF_MAX_PIXELS = 4_000_000;
/** Largest print canvas (pixels); 500×700 mm at 6 px/mm is 12.6 MP. */
export const PRINT_MAX_PIXELS = 64_000_000;
/** Proofs of one store waiting behind the running one before a 503. */
export const PROOF_STORE_MAX_QUEUE = 4;
/** Max wait for the store's proof slot (ms). */
export const PROOF_STORE_WAIT_MS = 5_000;

export interface PrintFile {
  surface: 'front';
  format: 'png';
  key: string;
  width_px: number;
  height_px: number;
  dpi: number;
  bytes: number;
  sha256: string;
}

export interface PrintRenderResult {
  files: PrintFile[];
  /** Set when the order proof was (re)created by this render. */
  proof_key: string | null;
  report: RenderReport;
}

/**
 * A render failure with a retry decision. Deterministic failures (a purged
 * or missing file, a font or image the page cannot load, an invalid spec)
 * are not retried; engine / timeout failures are.
 */
export class DesignerRenderJobError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: string = 'DESIGNER_RENDER_FAILED',
  ) {
    super(message);
    this.name = 'DesignerRenderJobError';
  }
}

const DETERMINISTIC_PAGE_ERRORS =
  /(RENDER_MISSING|FONT_LOAD_FAILED|ASSET_LOAD_FAILED|RENDERER_MISSING|ENCODE_FAILED|CANVAS_TOO_LARGE)/;

/** Maps any error of a render job to a DesignerRenderJobError. */
export function classifyRenderError(e: unknown): DesignerRenderJobError {
  if (e instanceof DesignerRenderJobError) return e;
  if (e instanceof DesignerRenderUnavailableError) {
    return new DesignerRenderJobError(
      e.message,
      true,
      'DESIGNER_RENDER_UNAVAILABLE',
    );
  }
  const code = designerErrorCode(e);
  const msg = e instanceof Error ? e.message : String(e);
  if (code) return new DesignerRenderJobError(msg, false, code);
  const page = DETERMINISTIC_PAGE_ERRORS.exec(msg);
  if (page) return new DesignerRenderJobError(msg, false, page[1]);
  return new DesignerRenderJobError(msg, true);
}

// One definition of the proof hash for WP4 (snapshot reuse) and WP5 (render).
export { canonicalJson, designProofSha } from './designs.util';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function frontSurface(spec: TemplateSpecV1) {
  return (spec.surfaces ?? []).find((s) => s.key === 'front') ?? null;
}

/** A region of an ORIGINAL photo in its own pixels (integers). */
export interface PhotoCrop {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One image the canvas needs, with how to prepare it. */
export interface ImageNeed {
  asset_id: string;
  variant: 'original' | 'preview';
  /** Drawn size of the WHOLE image in px (photos only); larger originals are downscaled. */
  fit?: { width: number; height: number };
  /** The part of the original the slot shows (print photos); unset = all of it. */
  crop?: PhotoCrop;
}

const DEG = Math.PI / 180;

/**
 * The region of a photo's original its slot shows at `scale` (pure): the
 * slot's box rotated into the photo's frame (the photo turns by `adj.rot`
 * around its centre, the element rotation applies to both alike), its
 * bounding box intersected with the drawn image, mapped back to original
 * pixels and widened to whole pixels. Null when the whole image is visible
 * (nothing to cut). Also returns the drawn size of the whole image.
 */
export function photoVisibleCrop(
  slot: Pick<ElementBase, 'x' | 'y' | 'w' | 'h'>,
  photo: Pick<DesignPhoto, 'width' | 'height' | 'adj'>,
  scale: number,
): { crop: PhotoCrop | null; fit: { width: number; height: number } } {
  const l = coverLayout(slot, photo.width, photo.height, photo.adj, scale);
  const fit = {
    width: Math.max(1, Math.ceil(l.dw)),
    height: Math.max(1, Math.ceil(l.dh)),
  };
  const empty = { crop: null, fit };
  if (!(l.dw > 0 && l.dh > 0 && photo.width > 0 && photo.height > 0))
    return empty;
  const sx0 = slot.x * scale;
  const sy0 = slot.y * scale;
  const sx1 = (slot.x + slot.w) * scale;
  const sy1 = (slot.y + slot.h) * scale;
  const a = -l.rot * DEG;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (const [px, py] of [
    [sx0, sy0],
    [sx1, sy0],
    [sx0, sy1],
    [sx1, sy1],
  ]) {
    const rx = l.cx + (px - l.cx) * cos - (py - l.cy) * sin;
    const ry = l.cy + (px - l.cx) * sin + (py - l.cy) * cos;
    bx0 = Math.min(bx0, rx);
    by0 = Math.min(by0, ry);
    bx1 = Math.max(bx1, rx);
    by1 = Math.max(by1, ry);
  }
  // Intersect with the drawn image, then back to original pixels.
  const kx = photo.width / l.dw;
  const ky = photo.height / l.dh;
  const left = Math.max(0, Math.floor((Math.max(bx0, l.dx) - l.dx) * kx));
  const top = Math.max(0, Math.floor((Math.max(by0, l.dy) - l.dy) * ky));
  const right = Math.min(
    photo.width,
    Math.ceil((Math.min(bx1, l.dx + l.dw) - l.dx) * kx),
  );
  const bottom = Math.min(
    photo.height,
    Math.ceil((Math.min(by1, l.dy + l.dh) - l.dy) * ky),
  );
  if (!(right > left && bottom > top)) return empty;
  if (
    left === 0 &&
    top === 0 &&
    right === photo.width &&
    bottom === photo.height
  )
    return empty;
  return {
    crop: { left, top, width: right - left, height: bottom - top },
    fit,
  };
}

/**
 * Images of a render (pure). Print: print background (else web),
 * decorations, photo originals cut to their visible region and fitted to
 * their drawn size. Proof: web background, decorations, photo previews.
 */
export function imageNeeds(
  spec: TemplateSpecV1,
  state: DesignStateV1,
  mode: Exclude<Mode, 'edit'>,
  scale: number,
): ImageNeed[] {
  const surface = frontSurface(spec);
  if (!surface) return [];
  const needs = new Map<string, ImageNeed>();
  const add = (n: ImageNeed) => {
    const prev = needs.get(n.asset_id);
    if (!prev) {
      needs.set(n.asset_id, n);
      return;
    }
    // Same asset used twice: keep the larger fit (or no fit at all) and
    // never a crop (each use shows a different part).
    prev.crop = undefined;
    if (!prev.fit || !n.fit) prev.fit = undefined;
    else
      prev.fit = {
        width: Math.max(prev.fit.width, n.fit.width),
        height: Math.max(prev.fit.height, n.fit.height),
      };
  };
  const bg = surface.background;
  const bgRef = mode === 'print' && bg?.print ? bg.print : bg?.web;
  if (bgRef?.asset_id) add({ asset_id: bgRef.asset_id, variant: 'original' });
  for (const el of surface.elements ?? []) {
    if (el.type === 'image' && el.asset?.asset_id) {
      add({ asset_id: el.asset.asset_id, variant: 'original' });
    } else if (el.type === 'image_slot') {
      const photo = state?.photos?.[el.id];
      if (!photo?.asset_id) continue;
      if (mode === 'proof') {
        add({ asset_id: photo.asset_id, variant: 'preview' });
        continue;
      }
      const v = photoVisibleCrop(
        el,
        { ...photo, adj: photo.adj ?? DEFAULT_ADJ },
        scale,
      );
      add({
        asset_id: photo.asset_id,
        variant: 'original',
        fit: v.fit,
        ...(v.crop ? { crop: v.crop } : {}),
      });
    }
  }
  return [...needs.values()];
}

/** The order snapshot fields a render reads. */
export type OrderDesignRow = Pick<
  OrderItemDesign,
  | 'id'
  | 'store_id'
  | 'order_id'
  | 'template_spec'
  | 'state'
  | 'proof_key'
  | 'files_purged_at'
  | 'originals_purged_at'
>;

@Injectable()
export class DesignerRenderService implements OnModuleDestroy {
  private readonly logger = new Logger(DesignerRenderService.name);
  /** In-flight proof renders by `<designId>:<sha>` (duplicates share one). */
  private readonly proofFlights = new Map<
    string,
    Promise<{ proof_key: string; proof_url: string; reused: boolean }>
  >();
  /** One running proof per store. */
  private readonly storeProofSlots = new Map<string, Semaphore>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PRIVATE_STORAGE) private readonly storage: PrivateStorage,
    private readonly assets: DesignerAssetsService,
    private readonly fonts: DesignerFontsService,
    private readonly urls: DesignerUrlsService,
    @Inject(DESIGNER_BROWSER) private readonly browser: DesignerBrowserRenderer,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.browser.close().catch(() => undefined);
  }

  /** False when DESIGNER_RENDER_ENGINE=off. */
  get engineEnabled(): boolean {
    return this.browser.enabled;
  }

  /**
   * Makes sure the engine can render (print worker, before its first
   * claim). Throws DesignerRenderUnavailableError when it cannot.
   */
  probeEngine(): Promise<void> {
    return this.browser.probe();
  }

  // ── Print ────────────────────────────────────────────────────────────────

  /**
   * Renders the print file of an order item design and stores it. Does not
   * touch the queue columns (the queue does). Throws DesignerRenderJobError.
   */
  async renderPrint(
    row: OrderDesignRow,
    now: Date = new Date(),
  ): Promise<PrintRenderResult> {
    try {
      if (row.files_purged_at || row.originals_purged_at) {
        throw new DesignerRenderJobError(
          'The design files have been purged.',
          false,
          'DESIGNER_FILES_PURGED',
        );
      }
      const spec = row.template_spec as unknown as TemplateSpecV1;
      const state = row.state as unknown as DesignStateV1;
      const scale = printScale(spec);
      const locale = await this.orderLocale(row.order_id, row.store_id);
      const canvas = await this.renderCanvas(row.store_id, spec, state, {
        mode: 'print',
        scale,
        type: 'image/png',
        timeoutMs: PRINT_TIMEOUT_MS,
        locale,
      });
      const expected = canvasSize(spec, scale);
      if (
        canvas.width !== expected.width ||
        canvas.height !== expected.height
      ) {
        throw new DesignerRenderJobError(
          `Unexpected canvas size ${canvas.width}x${canvas.height}`,
          false,
        );
      }
      const dpi = Math.round(25.4 * scale * 1000) / 1000;
      const png = await finalizePrintPng(canvas.data, dpi);
      const key = designerStorageKey(row.store_id, 'print', row.id, 'png', {
        at: now,
        suffix: 'front',
      });
      await this.storage.write(key, png);
      const files: PrintFile[] = [
        {
          surface: 'front',
          format: 'png',
          key,
          width_px: canvas.width,
          height_px: canvas.height,
          dpi,
          bytes: png.length,
          sha256: sha256(png),
        },
      ];
      let proofKey: string | null = null;
      if (!row.proof_key) {
        const size = canvasSize(spec, proofScale(spec));
        const webp = await sharp(canvas.data)
          .resize(size.width, size.height, { fit: 'fill' })
          .webp({ quality: Math.round(PROOF_WEBP_QUALITY * 100) })
          .toBuffer();
        proofKey = designerStorageKey(row.store_id, 'proof', row.id, 'webp', {
          at: now,
        });
        await this.storage.write(proofKey, webp);
      }
      return { files, proof_key: proofKey, report: canvas.report };
    } catch (e) {
      throw classifyRenderError(e);
    }
  }

  // ── Proof (design draft / cart) ──────────────────────────────────────────

  /**
   * Proof of a Design (POST …/designs/:id/proof, cart add). Reuses the
   * stored proof when the state did not change. 503
   * DESIGNER_RENDER_UNAVAILABLE when the engine is off, cannot start or is
   * over its 10 s budget, so the client falls back to its live thumbnail.
   */
  async renderDesignProof(
    designId: string,
    opts: { now?: Date; force?: boolean } = {},
  ): Promise<{ proof_key: string; proof_url: string; reused: boolean }> {
    const design = await this.prisma.design.findUnique({
      where: { id: designId },
      select: {
        id: true,
        store_id: true,
        state: true,
        state_version: true,
        proof_key: true,
        proof_state_sha: true,
        template_version_id: true,
        template_version: { select: { spec: true } },
      },
    });
    if (!design) {
      throw designerErrors.notFound(
        'DESIGNER_DESIGN_NOT_FOUND',
        'Design not found.',
      );
    }
    const sha = designProofSha(design.state, design.template_version_id);
    const url = () =>
      this.urls.signedPath('proof', design.id, design.store_id, {
        ttlSec: DESIGNER_LINK_TTL.editor,
      });
    if (
      !opts.force &&
      design.proof_key &&
      design.proof_state_sha === sha &&
      (await this.storage.exists(design.proof_key))
    ) {
      return {
        proof_key: design.proof_key,
        proof_url: url(),
        reused: true,
      };
    }
    // Identical requests (same design, same state) share one render.
    const flightKey = `${design.id}:${sha}`;
    const running = this.proofFlights.get(flightKey);
    if (running) return running;
    const flight = this.withStoreProofSlot(design.store_id, () =>
      this.renderAndRecordProof(design, sha, opts.now ?? new Date()),
    )
      .then((key) => ({ proof_key: key, proof_url: url(), reused: false }))
      .finally(() => this.proofFlights.delete(flightKey));
    this.proofFlights.set(flightKey, flight);
    return flight;
  }

  /** Runs `fn` in the store's single proof slot; 503 when too many wait. */
  private async withStoreProofSlot<T>(
    storeId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    let sem = this.storeProofSlots.get(storeId);
    if (!sem) {
      sem = new Semaphore(1);
      this.storeProofSlots.set(storeId, sem);
    }
    try {
      await sem.acquire({
        maxQueue: PROOF_STORE_MAX_QUEUE,
        timeoutMs: PROOF_STORE_WAIT_MS,
      });
    } catch (e) {
      if (sem.busy === 0) this.storeProofSlots.delete(storeId);
      if (e instanceof SemaphoreBusyError) {
        throw new DesignerRenderUnavailableError(
          'Too many proofs are being rendered for this store. Try again shortly.',
        );
      }
      throw e;
    }
    try {
      return await fn();
    } finally {
      sem.release();
      if (sem.busy === 0) this.storeProofSlots.delete(storeId);
    }
  }

  /** Renders, stores and records (compare-and-set) one design proof → its key. */
  private async renderAndRecordProof(
    design: {
      id: string;
      store_id: string;
      state: Prisma.JsonValue;
      state_version: number;
      proof_key: string | null;
      proof_state_sha: string | null;
      template_version: { spec: Prisma.JsonValue };
    },
    sha: string,
    now: Date,
  ): Promise<string> {
    const spec = design.template_version.spec as unknown as TemplateSpecV1;
    const state = design.state as unknown as DesignStateV1;
    let canvas: { data: Buffer };
    try {
      canvas = await this.renderCanvas(design.store_id, spec, state, {
        mode: 'proof',
        scale: proofScale(spec),
        type: 'image/webp',
        quality: PROOF_WEBP_QUALITY,
        timeoutMs: PROOF_TIMEOUT_MS,
        locale: await this.storeLocale(design.store_id),
      });
    } catch (e) {
      const err = classifyRenderError(e);
      if (err.retryable) throw new DesignerRenderUnavailableError(err.message);
      if (designerErrorCode(e)) throw e;
      throw designerErrors.badRequest(
        'DESIGNER_STATE_INVALID',
        'The design cannot be rendered.',
        { reason: err.code },
      );
    }
    const key = designProofKey(design.store_id, design.id, sha, now);
    await this.storage.write(key, canvas.data);
    // Record the key while the row still holds the rendered state; the
    // superseded file is released, or ours when the state moved on. The
    // previous key is read right before the update (not from the row
    // loaded before the store's proof slot was taken), so a proof recorded
    // by a render that ran meanwhile is the one released.
    const recorded = await replaceDesignProofKey(this.prisma, this.storage, {
      designId: design.id,
      stateVersion: design.state_version,
      newKey: key,
      stateSha: sha,
      logger: this.logger,
    });
    if (recorded) return key;
    const current = await this.prisma.design.findUnique({
      where: { id: design.id },
      select: { proof_key: true },
    });
    return current?.proof_key ?? key;
  }

  // ── Proof files (retention helpers) ──────────────────────────────────────

  /**
   * Retention helper: clears a design's proof (compare-and-set on the key)
   * and releases the file (`releaseProofKey`: kept while another design or
   * an unpurged order snapshot uses it). Safe to call for a design without
   * a proof or one that was removed meanwhile.
   */
  async purgeDesignProof(designId: string): Promise<{ deleted: boolean }> {
    const d = await this.prisma.design.findUnique({
      where: { id: designId },
      select: { proof_key: true },
    });
    if (!d?.proof_key) return { deleted: false };
    const res = await this.prisma.design.updateMany({
      where: { id: designId, proof_key: d.proof_key },
      data: { proof_key: null, proof_state_sha: null },
    });
    if (res.count === 0) return { deleted: false };
    return {
      deleted: await releaseProofKey(this.prisma, this.storage, d.proof_key, {
        logger: this.logger,
      }),
    };
  }

  // ── Locale ───────────────────────────────────────────────────────────────

  /** The store's primary content locale (undefined when unknown). */
  async storeLocale(storeId: string): Promise<string | undefined> {
    try {
      const cfg = await this.prisma.storeLanguageConfig.findUnique({
        where: { store_id: storeId },
        select: { primary_locale: true },
      });
      return cfg?.primary_locale || undefined;
    } catch (e) {
      this.logger.debug(
        `store ${storeId}: locale lookup failed, placeholders use the first value: ${String(e)}`,
      );
      return undefined;
    }
  }

  /** The locale the order was placed in, else the store's primary locale. */
  async orderLocale(
    orderId: string | null | undefined,
    storeId: string,
  ): Promise<string | undefined> {
    if (orderId) {
      try {
        const o = await this.prisma.order.findUnique({
          where: { id: orderId },
          select: { locale: true },
        });
        if (o?.locale) return o.locale;
      } catch (e) {
        this.logger.debug(
          `order ${orderId}: locale lookup failed, falling back to the store locale: ${String(e)}`,
        );
      }
    }
    return this.storeLocale(storeId);
  }

  /** Signed `oid_proof` path of an order item design (null without a proof). */
  orderProofPath(
    row: Pick<
      OrderItemDesign,
      'id' | 'store_id' | 'proof_key' | 'files_purged_at'
    >,
    ttlSec: number = DESIGNER_LINK_TTL.creator,
  ): string | null {
    if (!row.proof_key || row.files_purged_at) return null;
    return this.urls.signedPath('oid_proof', row.id, row.store_id, { ttlSec });
  }

  // ── Canvas ───────────────────────────────────────────────────────────────

  /** Prepares fonts and images, then renders one canvas in the browser. */
  async renderCanvas(
    storeId: string,
    spec: TemplateSpecV1,
    state: DesignStateV1,
    o: {
      mode: Exclude<Mode, 'edit'>;
      scale: number;
      type: CanvasJob['type'];
      quality?: number;
      timeoutMs: number;
      locale?: string;
    },
  ) {
    if (!this.browser.enabled) {
      throw new DesignerRenderUnavailableError(
        'Design rendering is disabled (DESIGNER_RENDER_ENGINE=off)',
      );
    }
    if (!spec || !frontSurface(spec)) {
      throw new DesignerRenderJobError(
        'The template has no front surface.',
        false,
        'DESIGNER_TEMPLATE_INVALID',
      );
    }
    const files = new Map<string, RenderFile>();
    const needs = imageNeeds(spec, state, o.mode, o.scale);
    const rows = await this.loadAssets(
      storeId,
      needs.map((n) => n.asset_id),
    );
    const jobAssets: CanvasAsset[] = [];
    for (const n of needs) {
      const asset = rows.get(n.asset_id);
      if (!asset) {
        throw new DesignerRenderJobError(
          `Asset ${n.asset_id} not found`,
          false,
          'DESIGNER_ASSET_NOT_FOUND',
        );
      }
      const prepared = await this.prepareImage(asset, n);
      files.set(`a/${n.asset_id}`, prepared.file);
      jobAssets.push({
        id: n.asset_id,
        ...(prepared.crop ? { crop: prepared.crop } : {}),
      });
    }
    const fontRefs = (spec.fonts ?? []).filter(
      (f) => typeof f?.asset_id === 'string',
    );
    const fontFiles = await this.fonts.fontFiles(
      storeId,
      fontRefs.map((f) => f.asset_id),
    );
    const byId = new Map(fontFiles.map((f) => [f.asset_id, f]));
    const fonts: CanvasJob['fonts'] = [];
    for (const ref of fontRefs) {
      const file = byId.get(ref.asset_id);
      if (!file) continue; // an unused face may be absent; a used one fails as RENDER_MISSING
      files.set(`f/${ref.asset_id}`, {
        body: file.data,
        contentType: file.mime,
      });
      fonts.push({
        family: ref.family,
        weight: ref.weight,
        style: ref.style,
        asset_id: ref.asset_id,
      });
    }
    const result = await this.browser.renderCanvas(
      {
        spec,
        state,
        mode: o.mode,
        scale: o.scale,
        locale: o.locale,
        type: o.type,
        quality: o.quality,
        fonts,
        assets: jobAssets,
      },
      files,
      o.timeoutMs,
    );
    if (result.report.missing.length) {
      throw new DesignerRenderJobError(
        `RENDER_MISSING:${result.report.missing.join(',')}`,
        false,
        'RENDER_MISSING',
      );
    }
    return result;
  }

  private async loadAssets(
    storeId: string,
    ids: string[],
  ): Promise<Map<string, DesignAsset>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.designAsset.findMany({
      where: { id: { in: [...new Set(ids)] }, store_id: storeId },
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * Reads the bytes; cuts photo originals to their visible region and
   * downscales them to their drawn size. An original already small enough
   * is served whole (no crop, nothing to gain).
   */
  private async prepareImage(
    asset: DesignAsset,
    need: ImageNeed,
  ): Promise<{ file: RenderFile; crop?: CropFraction }> {
    const usePreview =
      need.variant === 'preview' &&
      asset.kind === DesignAssetKind.CUSTOMER_PHOTO &&
      !!asset.preview_key;
    const data = await this.assets.readAssetBytes(
      asset,
      usePreview ? 'preview' : 'original',
    );
    const mime = usePreview ? 'image/webp' : asset.mime;
    const fit = need.fit;
    if (!fit || usePreview) return { file: { body: data, contentType: mime } };
    if (asset.width <= fit.width && asset.height <= fit.height) {
      return { file: { body: data, contentType: mime } };
    }
    let pipeline = sharp(data, { limitInputPixels: 200_000_000 });
    let box = fit;
    let crop: CropFraction | undefined;
    const c = need.crop;
    if (
      c &&
      c.left >= 0 &&
      c.top >= 0 &&
      c.width > 0 &&
      c.height > 0 &&
      c.left + c.width <= asset.width &&
      c.top + c.height <= asset.height
    ) {
      pipeline = pipeline.extract(c);
      // The crop is drawn at the same px-per-original-px as the whole image.
      box = {
        width: Math.max(1, Math.ceil((c.width * fit.width) / asset.width)),
        height: Math.max(1, Math.ceil((c.height * fit.height) / asset.height)),
      };
      crop = {
        fx: c.left / asset.width,
        fy: c.top / asset.height,
        fw: c.width / asset.width,
        fh: c.height / asset.height,
      };
    }
    const resized = pipeline.resize(box.width, box.height, {
      fit: 'inside',
      withoutEnlargement: true,
    });
    if (mime === 'image/png') {
      return {
        file: {
          body: await resized.png({ compressionLevel: 1 }).toBuffer(),
          contentType: 'image/png',
        },
        crop,
      };
    }
    return {
      file: {
        body: await resized
          .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
          .toBuffer(),
        contentType: 'image/jpeg',
      },
      crop,
    };
  }
}

function previewScale(spec: TemplateSpecV1): number {
  const s = Number(spec?.render?.preview_px_per_mm);
  return Number.isFinite(s) && s > 0 ? s : PROOF_PX_PER_MM;
}

/**
 * Lowers `scale` so the canvas of `spec` stays within `maxPixels` and
 * DESIGNER_MAX_CANVAS_SIDE per side (3 decimals, rounded down).
 */
export function clampScale(
  spec: TemplateSpecV1,
  scale: number,
  maxPixels: number,
): number {
  const w = Number(spec?.width);
  const h = Number(spec?.height);
  if (!(w > 0 && h > 0) || !Number.isFinite(w * h)) return scale;
  const limit = Math.min(
    Math.sqrt(maxPixels / (w * h)),
    DESIGNER_MAX_CANVAS_SIDE / Math.max(w, h),
  );
  return scale <= limit ? scale : Math.floor(limit * 1000) / 1000;
}

/** Proof scale: the spec's preview scale, at most ~4 MP. */
export function proofScale(spec: TemplateSpecV1): number {
  return clampScale(spec, previewScale(spec), PROOF_MAX_PIXELS);
}

/** Print scale: 6 px/mm (U10), lowered only for oversized trim sizes. */
export function printScale(spec: TemplateSpecV1): number {
  return clampScale(spec, PRINT_PX_PER_MM, PRINT_MAX_PIXELS);
}

/**
 * Storage key of a design proof: one key per (design, state sha), the sha
 * written as letters a–p because key suffixes are lowercase letters only.
 */
export function designProofKey(
  storeId: string,
  designId: string,
  sha: string,
  at: Date,
): string {
  const suffix = sha
    .slice(0, 16)
    .toLowerCase()
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
  return designerStorageKey(storeId, 'proof', designId, 'webp', {
    at,
    suffix: /^[a-p]{16}$/.test(suffix) ? suffix : undefined,
  });
}

/** Canvas PNG → print PNG: sRGB profile, DPI, compression level 6 (§5.2). */
export async function finalizePrintPng(
  canvasPng: Buffer,
  dpi: number,
): Promise<Buffer> {
  return sharp(canvasPng)
    .withIccProfile('srgb')
    .withMetadata({ density: dpi })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

/** Prisma JSON input of the print files list. */
export function printFilesJson(files: PrintFile[]): Prisma.InputJsonValue {
  return files as unknown as Prisma.InputJsonValue;
}
