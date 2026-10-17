/**
 * Customer designs (M4.2 WP4, §4.1): the public draft API behind the
 * storefront editor.
 *
 * - A design belongs to one store, one product and one template version.
 * - Access: the guest token (`X-Design-Token`, 32 random bytes, returned
 *   once, only its sha256 stored) or the logged-in customer who owns it
 *   (set at create when a JWT is present, or claimed on the first server-cart
 *   add). Anything else answers 404 (no enumeration, ids are uuids).
 * - The state is a `DesignStateV1`, validated by the renderer's
 *   `validateState` against the version's spec (incomplete allowed here; the
 *   cart requires it complete). Photos may only reference CUSTOMER_PHOTO
 *   assets uploaded to this design; their pixel size always comes from the
 *   asset row (D6), never from the client.
 * - Optimistic concurrency: PATCH carries `state_version`; a stale one is
 *   409 DESIGNER_DESIGN_STALE. ORDERED designs are frozen (409 LOCKED);
 *   `duplicate` turns any design (ordered too) into a new DRAFT with copied
 *   photo files, which is how a customer re-orders or edits an ordered one.
 */
import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { randomBytes } from 'crypto';
import {
  DesignAssetKind,
  DesignStatus,
  DesignTemplateStatus,
  Prisma,
  ProductStatus,
  type Design,
  type DesignAsset,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { DesignerAssetsService } from './designer-assets.service';
import { designerErrors } from './designer-errors';
import { normalizeDesignerSettings } from './designer-settings';
import { DESIGNER_LINK_TTL, DesignerUrlsService } from './designer-urls';
import { DesignerFontsService } from './designer-fonts.service';
import { DesignerRenderService } from './designer-render.service';
import { DesignerRenderUnavailableError } from './render/designer-chromium.host';
import {
  effectiveDpi,
  validateState,
  type DesignStateV1,
  type ImageSlotElement,
  type StateRule,
  type TemplateSpecV1,
} from './render/design-renderer';
import { isUuid } from './designs.util';
import { canAccessDesign, hashDesignToken } from './designer-access';

/** Hard cap of any customer text (code units), whatever the template says. */
export const DESIGN_TEXT_HARD_MAX = 1000;
/** Retries of a photo state write that lost an optimistic race. */
const PHOTO_WRITE_RETRIES = 3;
/** A read refreshes a draft's `updated_at` at most this often (§9 R1). */
const DESIGN_TOUCH_MS = 24 * 60 * 60 * 1000;

/** Who is asking: the logged-in customer and/or the guest token. */
export interface DesignAccess {
  customerId: string | null;
  token: string | null;
  /** Request locale (`?locale=`), for `product_slug`. */
  locale?: string | null;
}

export interface DesignPhotoView {
  asset_id: string;
  width: number;
  height: number;
  /** Signed WebP preview (1 h), null once purged. */
  preview_url: string | null;
  effective_dpi: number;
  low_res: boolean;
}

/** Public shape of a design (GET / PATCH / photo responses). */
export interface DesignView {
  id: string;
  product_id: string;
  /** Product slug in the request locale (else any), null without one. */
  product_slug: string | null;
  template_version_id: string;
  status: DesignStatus;
  state: DesignStateV1;
  state_version: number;
  photos: Record<string, DesignPhotoView>;
  /** Signed proof (1 h) when a proof of the current state exists. */
  proof_url: string | null;
  created_at: Date;
  updated_at: Date;
}

/** One state issue (`DESIGNER_STATE_INVALID.details[]`). */
export interface StateIssue {
  element_id: string;
  rule: StateRule;
}

/** Where a cart/order error points (same keys as the personalization errors). */
export interface DesignLineRef {
  line_id?: string;
  line_index?: number;
}

export function stateInvalid(
  details: StateIssue[],
  ref: DesignLineRef = {},
): BadRequestException {
  return new BadRequestException({
    code: 'DESIGNER_STATE_INVALID',
    message: 'The design is not complete or not valid.',
    details,
    ...ref,
  });
}

// The token helpers live in designer-access.ts; re-exported for callers.
export { designTokenMatches, hashDesignToken } from './designer-access';

/** The version row a design is bound to, with its spec. */
export interface DesignVersionRow {
  id: string;
  template_id: string;
  version: number;
  spec: Prisma.JsonValue;
}

@Injectable()
export class DesignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storeApps: StoreAppsService,
    private readonly assets: DesignerAssetsService,
    private readonly urls: DesignerUrlsService,
    // WP5 render service (proofs); optional for tests / builds without it.
    @Optional() private readonly render?: DesignerRenderService,
    // Glyph coverage check (§6.4); optional for tests / builds without fonts.
    @Optional() private readonly fonts?: DesignerFontsService,
  ) {}

  /**
   * `POST designer/s/:slug/designs/:id/proof` (§4.1, §5.4): renders (or
   * reuses) the server proof of the current state. 503
   * DESIGNER_RENDER_UNAVAILABLE lets the editor fall back to its live
   * canvas thumbnail.
   */
  async proof(
    storeId: string,
    id: string,
    access: DesignAccess,
  ): Promise<{ proof_url: string; reused: boolean }> {
    const design = await this.loadAccessible(storeId, id, access);
    if (design.status === DesignStatus.ORDERED) throw this.locked();
    if (!this.render) throw new DesignerRenderUnavailableError();
    const res = await this.render.renderDesignProof(design.id);
    return { proof_url: res.proof_url, reused: res.reused };
  }

  // ── Access ────────────────────────────────────────────────────────────────

  /** Customer id behind a JWT user (null for guests and non-customers). */
  async customerIdOf(
    userId: string | null | undefined,
  ): Promise<string | null> {
    if (!userId) return null;
    const c = await this.prisma.customer.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    return c?.id ?? null;
  }

  /** True when the caller may read/edit the design. */
  canAccess(
    design: Pick<Design, 'customer_id' | 'access_token_hash'>,
    access: DesignAccess,
  ): boolean {
    return canAccessDesign(design, access);
  }

  private notFound() {
    return designerErrors.notFound(
      'DESIGNER_DESIGN_NOT_FOUND',
      'Design not found.',
    );
  }

  private locked() {
    return designerErrors.conflict(
      'DESIGNER_DESIGN_LOCKED',
      'This design has been ordered and can no longer be changed.',
    );
  }

  /** The store's design the caller may access, with its version; else 404. */
  async loadAccessible(
    storeId: string,
    id: string,
    access: DesignAccess,
  ): Promise<Design & { template_version: DesignVersionRow }> {
    const design = isUuid(id)
      ? await this.prisma.design.findUnique({
          where: { id },
          include: {
            template_version: {
              select: {
                id: true,
                template_id: true,
                version: true,
                spec: true,
              },
            },
          },
        })
      : null;
    if (
      !design ||
      design.store_id !== storeId ||
      !this.canAccess(design, access)
    ) {
      throw this.notFound();
    }
    return design;
  }

  // ── State validation ──────────────────────────────────────────────────────

  /**
   * Validates a state for a design: renderer rules (`requireComplete` for
   * cart/order), the hard text cap, and photo ownership — every photo must
   * be a live CUSTOMER_PHOTO of this store uploaded to this design. The
   * returned state carries the assets' stored pixel sizes.
   */
  async validateDesignState(
    storeId: string,
    designId: string,
    spec: TemplateSpecV1,
    raw: unknown,
    opts: { requireComplete: boolean; ref?: DesignLineRef },
  ): Promise<{ state: DesignStateV1; photos: Map<string, DesignAsset> }> {
    const res = validateState(spec, raw, {
      requireComplete: opts.requireComplete,
    });
    const issues: StateIssue[] = [...res.errors];
    for (const [elId, text] of Object.entries(res.normalized.texts)) {
      if (text.length > DESIGN_TEXT_HARD_MAX) {
        issues.push({ element_id: elId, rule: 'max_length' });
      }
    }
    // Every code point must be drawable by the face's uploaded font file
    // (rule `chars`, like an allowed_chars miss); only texts that passed
    // the renderer rules are checked.
    if (this.fonts && issues.length === 0) {
      const uncovered = await this.fonts.uncoveredTexts(
        storeId,
        spec,
        res.normalized.texts,
      );
      for (const u of uncovered) {
        issues.push({ element_id: u.element_id, rule: 'chars' });
      }
    }
    const photoIds = Object.values(res.normalized.photos).map(
      (p) => p.asset_id,
    );
    const owned = photoIds.length
      ? await this.assets.findOwnedAssets(storeId, photoIds, [
          DesignAssetKind.CUSTOMER_PHOTO,
        ])
      : new Map<string, DesignAsset>();
    const photos = new Map<string, DesignAsset>();
    for (const [slotId, p] of Object.entries(res.normalized.photos)) {
      const a = owned.get(p.asset_id);
      if (!a || a.design_id !== designId) {
        issues.push({ element_id: slotId, rule: 'asset' });
        continue;
      }
      // D6: geometry always uses the stored original size.
      p.width = a.width;
      p.height = a.height;
      photos.set(slotId, a);
    }
    if (issues.length) throw stateInvalid(dedupeIssues(issues), opts.ref);
    return { state: res.normalized, photos };
  }

  // ── Views ─────────────────────────────────────────────────────────────────

  /** Product slug in `locale`, else the same language, else any. */
  async productSlug(
    productId: string,
    locale?: string | null,
  ): Promise<string | null> {
    if (!isUuid(productId)) return null;
    const rows = await this.prisma.productTranslation.findMany({
      where: { product_id: productId },
      select: { locale: true, slug: true },
    });
    const want = (locale ?? '').trim().toLowerCase();
    const lang = want.split(/[-_]/)[0];
    const usable = rows.filter((r) => r.slug);
    const pick =
      usable.find((r) => r.locale.toLowerCase() === want) ??
      usable.find((r) => r.locale.toLowerCase().split(/[-_]/)[0] === lang) ??
      usable[0];
    return pick?.slug ?? null;
  }

  async view(
    design: Design & { template_version: DesignVersionRow },
    photoRows?: Map<string, DesignAsset>,
    locale?: string | null,
  ): Promise<DesignView> {
    const spec = design.template_version.spec as unknown as TemplateSpecV1;
    const state = (design.state ?? {
      v: 1,
      texts: {},
      photos: {},
    }) as unknown as DesignStateV1;
    const settings = normalizeDesignerSettings(
      await this.storeApps.getSettings(design.store_id, 'designer'),
    );
    let rows = photoRows;
    if (!rows) {
      const ids = Object.values(state.photos ?? {}).map((p) => p.asset_id);
      const found = ids.length
        ? await this.assets.findOwnedAssets(design.store_id, ids, [
            DesignAssetKind.CUSTOMER_PHOTO,
          ])
        : new Map<string, DesignAsset>();
      rows = new Map();
      for (const [slotId, p] of Object.entries(state.photos ?? {})) {
        const a = found.get(p.asset_id);
        if (a) rows.set(slotId, a);
      }
    }
    const slots = slotMap(spec);
    const photos: Record<string, DesignPhotoView> = {};
    for (const [slotId, p] of Object.entries(state.photos ?? {})) {
      const a = rows.get(slotId);
      const slot = slots.get(slotId);
      const dpi = slot ? effectiveDpi(slot, p.width, p.height, p.adj) : 0;
      photos[slotId] = {
        asset_id: p.asset_id,
        width: p.width,
        height: p.height,
        preview_url: a ? (this.assets.assetView(a).preview_url ?? null) : null,
        effective_dpi: Math.round(dpi * 10) / 10,
        low_res: dpi > 0 && dpi < settings.min_effective_dpi_warning,
      };
    }
    return {
      id: design.id,
      product_id: design.product_id,
      product_slug: await this.productSlug(design.product_id, locale),
      template_version_id: design.template_version_id,
      status: design.status,
      state,
      state_version: design.state_version,
      photos,
      proof_url:
        design.proof_key && design.proof_state_sha
          ? this.urls.signedPath('proof', design.id, design.store_id, {
              ttlSec: DESIGNER_LINK_TTL.editor,
            })
          : null,
      created_at: design.created_at,
      updated_at: design.updated_at,
    };
  }

  // ── Create / read / update ────────────────────────────────────────────────

  /**
   * The version a NEW design may use: a version of the template linked
   * (enabled) to this store's published product, the template PUBLISHED,
   * and not newer than its current version.
   */
  private async versionForNewDesign(
    storeId: string,
    productId: string,
    versionId: string,
  ): Promise<DesignVersionRow> {
    const mismatch = () =>
      designerErrors.badRequest(
        'DESIGNER_TEMPLATE_MISMATCH',
        'This design template is not available for the product.',
      );
    const [store, product, link] = await Promise.all([
      this.prisma.store.findUnique({
        where: { id: storeId },
        select: { creator_id: true },
      }),
      isUuid(productId)
        ? this.prisma.product.findUnique({
            where: { id: productId },
            select: { id: true, creator_id: true, status: true },
          })
        : null,
      isUuid(productId)
        ? this.prisma.productDesigner.findUnique({
            where: { product_id: productId },
            include: {
              template: {
                select: { id: true, status: true, current_version_id: true },
              },
            },
          })
        : null,
    ]);
    if (
      !store ||
      !product ||
      product.creator_id !== store.creator_id ||
      product.status !== ProductStatus.PUBLISHED
    ) {
      throw designerErrors.notFound(
        'DESIGNER_DESIGN_NOT_FOUND',
        'Product not found.',
      );
    }
    if (
      !link ||
      !link.enabled ||
      link.store_id !== storeId ||
      link.template.status !== DesignTemplateStatus.PUBLISHED ||
      !link.template.current_version_id
    ) {
      throw mismatch();
    }
    const [version, current] = await Promise.all([
      isUuid(versionId)
        ? this.prisma.designTemplateVersion.findUnique({
            where: { id: versionId },
            select: { id: true, template_id: true, version: true, spec: true },
          })
        : null,
      this.prisma.designTemplateVersion.findUnique({
        where: { id: link.template.current_version_id },
        select: { version: true },
      }),
    ]);
    if (
      !version ||
      version.template_id !== link.template_id ||
      !current ||
      version.version > current.version
    ) {
      throw mismatch();
    }
    return version;
  }

  /** `POST designer/s/:slug/designs`. The token is returned only here. */
  async create(
    storeId: string,
    input: { product_id: string; template_version_id: string; state?: unknown },
    customerId: string | null,
    locale?: string | null,
  ): Promise<DesignView & { token: string }> {
    const version = await this.versionForNewDesign(
      storeId,
      input.product_id,
      input.template_version_id,
    );
    const spec = version.spec as unknown as TemplateSpecV1;
    // A new design has no uploads yet: photos are added through the photo
    // route, so any photo in the initial state fails the ownership check.
    const { state } = await this.validateDesignState(
      storeId,
      '00000000-0000-0000-0000-000000000000',
      spec,
      input.state ?? { v: 1, texts: {}, photos: {} },
      { requireComplete: false },
    );
    const token = randomBytes(32).toString('base64url');
    const design = await this.prisma.design.create({
      data: {
        store_id: storeId,
        product_id: input.product_id,
        template_version_id: version.id,
        state: state as unknown as Prisma.InputJsonValue,
        customer_id: customerId,
        access_token_hash: hashDesignToken(token),
      },
    });
    const view = await this.view(
      { ...design, template_version: version },
      new Map(),
      locale,
    );
    return { ...view, token };
  }

  /**
   * `POST designer/s/:slug/designs/:id/duplicate` (owner / token; any
   * status, ORDERED included): a new DRAFT of the same product with the
   * same texts and photo adjustments. Every photo still on file is COPIED
   * into a new CUSTOMER_PHOTO of the new design (never a shared row or
   * file); purged photos are left out. The design's version is kept while
   * it may still be used for new designs, else the template's current
   * version (texts / photos of elements it no longer has are dropped).
   * Returns the new design and its token (once).
   */
  async duplicate(
    storeId: string,
    id: string,
    access: DesignAccess,
  ): Promise<DesignView & { token: string }> {
    const source = await this.loadAccessible(storeId, id, access);
    let version: DesignVersionRow;
    try {
      version = await this.versionForNewDesign(
        storeId,
        source.product_id,
        source.template_version_id,
      );
    } catch {
      const link = await this.prisma.productDesigner.findUnique({
        where: { product_id: source.product_id },
        include: { template: { select: { current_version_id: true } } },
      });
      version = await this.versionForNewDesign(
        storeId,
        source.product_id,
        link?.template?.current_version_id ?? source.template_version_id,
      );
    }
    const spec = version.spec as unknown as TemplateSpecV1;
    const from = cloneState(source.state);
    const textIds = new Set(
      (spec.surfaces ?? [])
        .flatMap((s) => s.elements ?? [])
        .filter((e) => e.type === 'text')
        .map((e) => e.id),
    );
    const texts = Object.fromEntries(
      Object.entries(from.texts).filter(([k]) => textIds.has(k)),
    );
    const token = randomBytes(32).toString('base64url');
    const created = await this.prisma.design.create({
      data: {
        store_id: storeId,
        product_id: source.product_id,
        template_version_id: version.id,
        state: { v: 1, texts, photos: {} } as unknown as Prisma.InputJsonValue,
        customer_id: access.customerId,
        access_token_hash: hashDesignToken(token),
      },
    });
    const slots = slotMap(spec);
    const photos: DesignStateV1['photos'] = {};
    const copied: DesignAsset[] = [];
    const settings = normalizeDesignerSettings(
      await this.storeApps.getSettings(storeId, 'designer'),
    );
    try {
      for (const [slotId, p] of Object.entries(from.photos)) {
        if (!slots.has(slotId)) continue;
        const a = await this.prisma.designAsset.findFirst({
          where: {
            id: p.asset_id,
            store_id: storeId,
            design_id: source.id,
            kind: DesignAssetKind.CUSTOMER_PHOTO,
            purged_at: null,
          },
        });
        if (!a) continue;
        const bytes = await this.assets.readAssetBytes(a, 'original');
        const copy = await this.assets.storePhoto(storeId, bytes, {
          design_id: created.id,
          max_bytes: Math.max(
            bytes.length,
            settings.max_upload_mb * 1024 * 1024,
          ),
        });
        copied.push(copy);
        photos[slotId] = {
          asset_id: copy.id,
          width: copy.width,
          height: copy.height,
          adj: { ...p.adj },
        };
      }
    } catch (e) {
      for (const c of copied) await this.removeAsset(c);
      await this.prisma.design
        .delete({ where: { id: created.id } })
        .catch(() => undefined);
      throw e;
    }
    const state: DesignStateV1 = { v: 1, texts, photos };
    const saved = Object.keys(photos).length
      ? await this.prisma.design.update({
          where: { id: created.id },
          data: { state: state as unknown as Prisma.InputJsonValue },
        })
      : created;
    const rows = new Map<string, DesignAsset>();
    for (const c of copied) {
      const slot = Object.entries(photos).find(
        ([, p]) => p.asset_id === c.id,
      )?.[0];
      if (slot) rows.set(slot, c);
    }
    const view = await this.view(
      { ...saved, template_version: version },
      rows,
      access.locale,
    );
    return { ...view, token };
  }

  /** `GET designer/s/:slug/designs/:id` (409 LOCKED once ordered). */
  async get(
    storeId: string,
    id: string,
    access: DesignAccess,
  ): Promise<DesignView> {
    const design = await this.loadAccessible(storeId, id, access);
    if (design.status === DesignStatus.ORDERED) throw this.locked();
    // §9 R1: an opened draft is in use (refreshed at most once a day).
    if (
      design.updated_at instanceof Date &&
      Date.now() - design.updated_at.getTime() > DESIGN_TOUCH_MS
    ) {
      await this.prisma.design
        .updateMany({
          where: { id: design.id, status: { not: DesignStatus.ORDERED } },
          data: { updated_at: new Date() },
        })
        .catch(() => undefined);
    }
    return this.view(design, undefined, access.locale);
  }

  /** `PATCH designer/s/:slug/designs/:id` (optimistic, clears the proof sha). */
  async update(
    storeId: string,
    id: string,
    input: { state: unknown; state_version: number },
    access: DesignAccess,
  ): Promise<DesignView> {
    const design = await this.loadAccessible(storeId, id, access);
    if (design.status === DesignStatus.ORDERED) throw this.locked();
    const spec = design.template_version.spec as unknown as TemplateSpecV1;
    const { state, photos } = await this.validateDesignState(
      storeId,
      design.id,
      spec,
      input.state,
      { requireComplete: false },
    );
    const res = await this.prisma.design.updateMany({
      where: {
        id: design.id,
        state_version: input.state_version,
        status: { not: DesignStatus.ORDERED },
      },
      data: {
        state: state as unknown as Prisma.InputJsonValue,
        state_version: { increment: 1 },
        proof_state_sha: null,
      },
    });
    if (res.count === 0) throw this.stale();
    return this.view(
      {
        ...design,
        state: state as unknown as Prisma.JsonValue,
        state_version: input.state_version + 1,
        proof_state_sha: null,
        updated_at: new Date(),
      },
      photos,
      access.locale,
    );
  }

  private stale() {
    return designerErrors.conflict(
      'DESIGNER_DESIGN_STALE',
      'The design was changed elsewhere. Reload it and try again.',
    );
  }

  // ── Photos ────────────────────────────────────────────────────────────────

  /**
   * `POST designer/s/:slug/designs/:id/photos`: stores the photo (private
   * original + signed preview; size limit from the settings), puts it into
   * the slot with the slot's default adjustment and deletes the slot's
   * previous photo.
   */
  async uploadPhoto(
    storeId: string,
    id: string,
    elementId: string,
    buffer: Buffer,
    access: DesignAccess,
  ): Promise<{
    asset_id: string;
    width: number;
    height: number;
    preview_url: string | null;
    effective_dpi_default: number;
    low_res: boolean;
    design: DesignView;
  }> {
    const design = await this.loadAccessible(storeId, id, access);
    if (design.status === DesignStatus.ORDERED) throw this.locked();
    const spec = design.template_version.spec as unknown as TemplateSpecV1;
    const slot = slotMap(spec).get(String(elementId ?? ''));
    if (!slot) {
      throw stateInvalid([
        { element_id: String(elementId ?? ''), rule: 'asset' },
      ]);
    }
    const settings = normalizeDesignerSettings(
      await this.storeApps.getSettings(storeId, 'designer'),
    );
    const asset = await this.assets.storePhoto(storeId, buffer, {
      design_id: design.id,
      max_bytes: settings.max_upload_mb * 1024 * 1024,
    });
    const adj = {
      ...(slot.default_adj ?? { zoom: 1, rot: 0, panX: 0.5, panY: 0.5 }),
    };

    let current: typeof design = design;
    let previous: string | null = null;
    for (let attempt = 0; ; attempt++) {
      const state = cloneState(current.state);
      previous = state.photos[slot.id]?.asset_id ?? null;
      state.photos[slot.id] = {
        asset_id: asset.id,
        width: asset.width,
        height: asset.height,
        adj,
      };
      const res = await this.prisma.design.updateMany({
        where: {
          id: current.id,
          state_version: current.state_version,
          status: { not: DesignStatus.ORDERED },
        },
        data: {
          state: state as unknown as Prisma.InputJsonValue,
          state_version: { increment: 1 },
          proof_state_sha: null,
        },
      });
      if (res.count === 1) {
        current = {
          ...current,
          state: state as unknown as Prisma.JsonValue,
          state_version: current.state_version + 1,
          proof_state_sha: null,
        };
        break;
      }
      if (attempt + 1 >= PHOTO_WRITE_RETRIES) {
        await this.removeAsset(asset);
        throw this.stale();
      }
      current = await this.loadAccessible(storeId, id, access);
      if (current.status === DesignStatus.ORDERED) {
        await this.removeAsset(asset);
        throw this.locked();
      }
    }
    if (previous && previous !== asset.id) {
      await this.removeDesignPhoto(storeId, design.id, previous);
    }
    const view = await this.view(current, undefined, access.locale);
    const dpi = effectiveDpi(slot, asset.width, asset.height, adj);
    return {
      asset_id: asset.id,
      width: asset.width,
      height: asset.height,
      preview_url: this.assets.assetView(asset).preview_url ?? null,
      effective_dpi_default: Math.round(dpi * 10) / 10,
      low_res: dpi > 0 && dpi < settings.min_effective_dpi_warning,
      design: view,
    };
  }

  /** `DELETE designer/s/:slug/designs/:id/photos/:assetId`. */
  async deletePhoto(
    storeId: string,
    id: string,
    assetId: string,
    access: DesignAccess,
  ): Promise<DesignView> {
    let design = await this.loadAccessible(storeId, id, access);
    if (design.status === DesignStatus.ORDERED) throw this.locked();
    let inState = false;
    for (let attempt = 0; ; attempt++) {
      const state = cloneState(design.state);
      let changed = false;
      for (const [slotId, p] of Object.entries(state.photos)) {
        if (p.asset_id === assetId) {
          delete state.photos[slotId];
          changed = true;
        }
      }
      if (!changed) break;
      inState = true;
      const res = await this.prisma.design.updateMany({
        where: {
          id: design.id,
          state_version: design.state_version,
          status: { not: DesignStatus.ORDERED },
        },
        data: {
          state: state as unknown as Prisma.InputJsonValue,
          state_version: { increment: 1 },
          proof_state_sha: null,
        },
      });
      if (res.count === 1) {
        design = {
          ...design,
          state: state as unknown as Prisma.JsonValue,
          state_version: design.state_version + 1,
          proof_state_sha: null,
        };
        break;
      }
      if (attempt + 1 >= PHOTO_WRITE_RETRIES) throw this.stale();
      design = await this.loadAccessible(storeId, id, access);
      if (design.status === DesignStatus.ORDERED) throw this.locked();
    }
    const found = await this.removeDesignPhoto(storeId, design.id, assetId);
    if (!found && !inState) {
      throw designerErrors.notFound(
        'DESIGNER_ASSET_NOT_FOUND',
        'Photo not found.',
      );
    }
    return this.view(design, undefined, access.locale);
  }

  /** Deletes a photo of a (non-ordered) design: files and row. */
  private async removeDesignPhoto(
    storeId: string,
    designId: string,
    assetId: string,
  ): Promise<boolean> {
    if (!isUuid(assetId)) return false;
    const a = await this.prisma.designAsset.findFirst({
      where: {
        id: assetId,
        store_id: storeId,
        design_id: designId,
        kind: DesignAssetKind.CUSTOMER_PHOTO,
      },
    });
    if (!a) return false;
    await this.removeAsset(a);
    return true;
  }

  private async removeAsset(a: DesignAsset): Promise<void> {
    await this.assets.purgeAssetFiles(a);
    await this.prisma.designAsset
      .delete({ where: { id: a.id } })
      .catch(() => undefined);
  }
}

/** Image slots of the front surface by id. */
export function slotMap(spec: TemplateSpecV1): Map<string, ImageSlotElement> {
  const front = (spec?.surfaces ?? []).find((s) => s && s.key === 'front');
  const out = new Map<string, ImageSlotElement>();
  for (const el of front?.elements ?? []) {
    if (el?.type === 'image_slot') out.set(el.id, el);
  }
  return out;
}

function cloneState(raw: unknown): DesignStateV1 {
  const s = (
    raw && typeof raw === 'object' ? raw : {}
  ) as Partial<DesignStateV1>;
  return {
    v: 1,
    texts: { ...(s.texts ?? {}) },
    photos: Object.fromEntries(
      Object.entries(s.photos ?? {}).map(([k, p]) => [
        k,
        { ...p, adj: { ...p.adj } },
      ]),
    ),
    ...(s.choices ? { choices: { ...s.choices } } : {}),
  };
}

function dedupeIssues(issues: StateIssue[]): StateIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.element_id}|${i.rule}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
