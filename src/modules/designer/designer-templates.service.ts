/**
 * Design templates on the creator side (M4.2 §4.3) and the storefront
 * product payload block (§4.1). WP4 delivers the API side WP9 builds the
 * dashboard on:
 *
 * - templates: list / create (blank 500×700 or a given spec) / detail with
 *   versions / rename + status / delete when unused (409 IN_USE);
 * - versions: immutable; `POST templates/:id/versions {spec}` runs the
 *   renderer's `validateSpec` plus the server checks (every asset id is the
 *   store's, of the right kind, its pixel size taken from the row; every font
 *   is an uploaded face of the store matching family/weight/style);
 * - publish: the version must be publishable (`validateTemplateSpec` plus
 *   no `pending:*` asset left by an import and every font uploaded: 400
 *   DESIGNER_TEMPLATE_INVALID `{errors:[{path, rule:'pending_asset' |
 *   'missing_font' | …}]}`), then `current_version_id` (+ PUBLISHED) and a
 *   storefront revalidation (product pages embed `spec_public`), then a
 *   background thumbnail render of the version's defaults (`TEMPLATE_THUMB`
 *   asset → `thumbnail_url`; the version's previous thumbnail asset is
 *   deleted when nothing else references it; with the render engine off or
 *   failing the previous thumbnail, possibly null, stays);
 * - status: ARCHIVED / DRAFT while products are enabled with the template
 *   is 409 DESIGNER_TEMPLATE_LINKED `{params:{products}}` (disable or
 *   relink them first);
 * - product link: `GET/PUT/DELETE designer/my/products/:productId`.
 *   Enabling needs a PUBLISHED, publishable template and deletes the
 *   product's M4.4 launch fields (`preset_key='npp_fallback'`, X28/C29) in
 *   the same transaction — order history keeps their snapshots (SetNull).
 *   DELETE removes the link. `PUT …/:productId/addons` saves the M5.5
 *   add-on config (designer-addons.ts); imported NPP data stays presets.
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import {
  DesignAssetKind,
  DesignTemplateStatus,
  Prisma,
  type DesignAsset,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { DesignerAssetsService } from './designer-assets.service';
import { extForMime } from './designer-assets.keys';
import { designerErrors } from './designer-errors';
import { DesignerFontsService } from './designer-fonts.service';
import { DesignerRenderService } from './designer-render.service';
import { normalizeDesignerSettings } from './designer-settings';
import { absoluteApiUrl, designerAssetPath } from './designer-urls';
import { blankTemplateSpec, isUuid, specSha256 } from './designs.util';
import {
  enabledAddons,
  legacyAddonPresets,
  readAddonsConfig,
  storedAddonsValue,
  validateAddonsConfig,
  type AddonType,
} from './designer-addons';
import {
  validateSpec,
  type AssetRef,
  type SpecIssue,
  type TemplateSpecV1,
} from './render/design-renderer';

/** `preset_key` of the M4.4 launch fields that the designer replaces. */
export const NPP_FALLBACK_PRESET_KEY = 'npp_fallback';

/** Thumbnail scale (px/mm): 500×700 px for the NPP 500×700 mm sign. */
export const TEMPLATE_THUMB_PX_PER_MM = 1;
/** Budget of a background thumbnail render. */
const TEMPLATE_THUMB_TIMEOUT_MS = 30_000;

/** Max size of a spec (JSON characters). */
const SPEC_MAX_CHARS = 512 * 1024;

/** Placeholder ids an import leaves for assets / fonts it could not fill. */
const PENDING_PREFIX = 'pending:';
/** Asset id inside a public designer asset path (`/designer/assets/<id>.<ext>`). */
const ASSET_PATH_ID =
  /\/designer\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\./;

function invalidTemplate(errors: SpecIssue[]): BadRequestException {
  return new BadRequestException({
    code: 'DESIGNER_TEMPLATE_INVALID',
    message: 'The template is not valid.',
    errors,
  });
}

/**
 * Import placeholders still in a spec: `pending:*` backgrounds and
 * decorations (`pending_asset`) and fonts (`missing_font`).
 */
export function pendingSpecIssues(raw: unknown): SpecIssue[] {
  const spec = raw as Partial<TemplateSpecV1> | null;
  const out: SpecIssue[] = [];
  const pending = (id: unknown) =>
    typeof id === 'string' && id.startsWith(PENDING_PREFIX);
  (spec?.surfaces ?? []).forEach((s, si) => {
    const base = `surfaces[${si}]`;
    if (pending(s?.background?.web?.asset_id)) {
      out.push({ path: `${base}.background.web`, rule: 'pending_asset' });
    }
    if (pending(s?.background?.print?.asset_id)) {
      out.push({ path: `${base}.background.print`, rule: 'pending_asset' });
    }
    (s?.elements ?? []).forEach((el, ei) => {
      if (el?.type === 'image' && pending(el.asset?.asset_id)) {
        out.push({
          path: `${base}.elements[${ei}].asset`,
          rule: 'pending_asset',
        });
      }
    });
  });
  (spec?.fonts ?? []).forEach((f, i) => {
    if (pending(f?.asset_id)) {
      out.push({ path: `fonts[${i}]`, rule: 'missing_font' });
    }
  });
  return out;
}

const BG_WEB_KINDS: DesignAssetKind[] = [DesignAssetKind.TEMPLATE_BG_WEB];
const BG_PRINT_KINDS: DesignAssetKind[] = [
  DesignAssetKind.TEMPLATE_BG_PRINT,
  // NPP fallback (PRINT_BG_FROM_WEB): the web original doubles as print.
  DesignAssetKind.TEMPLATE_BG_WEB,
];
const DECO_KINDS: DesignAssetKind[] = [
  DesignAssetKind.TEMPLATE_DECO,
  DesignAssetKind.TEMPLATE_BG_WEB,
];

/** The storefront product payload block (§4.1). */
export interface StorefrontDesignerBlock {
  template_id: string;
  template_version_id: string;
  /** The spec with public asset URLs; `background.print` stripped. */
  spec_public: Record<string, unknown>;
  fonts: { family: string; weight: number; style: string; url: string }[];
  settings: { max_upload_mb: number; min_effective_dpi_warning: number };
  /**
   * M5.5: the ENABLED add-ons in display order, prices in the store base
   * currency (the storefront converts them for a market). Absent when the
   * product has none, so the payload is unchanged (G0).
   */
  addons?: StorefrontAddon[];
}

export interface StorefrontAddon {
  key: string;
  type: AddonType;
  label: Record<string, string>;
  price: number;
  max_qty?: number;
}

@Injectable()
export class DesignerTemplatesService {
  private readonly logger = new Logger(DesignerTemplatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storeApps: StoreAppsService,
    private readonly assets: DesignerAssetsService,
    private readonly fonts: DesignerFontsService,
    private readonly revalidation: RevalidationService,
    @Optional() private readonly render?: DesignerRenderService,
  ) {}

  private notFound() {
    return designerErrors.notFound(
      'DESIGNER_TEMPLATE_NOT_FOUND',
      'Template not found.',
    );
  }

  private async owned(storeId: string, id: string) {
    const t = isUuid(id)
      ? await this.prisma.designTemplate.findFirst({
          where: { id, store_id: storeId },
        })
      : null;
    if (!t) throw this.notFound();
    return t;
  }

  private revalidate(storeId: string): void {
    void this.revalidation.revalidateStoreById(storeId).catch((e: unknown) => {
      this.logger.warn(`revalidation failed for ${storeId}: ${String(e)}`);
    });
  }

  // ── Spec validation ───────────────────────────────────────────────────────

  /**
   * `validateSpec` + server checks. Returns the spec with every AssetRef's
   * width/height taken from the stored asset (the renderer's geometry
   * source, D6). 400 DESIGNER_TEMPLATE_INVALID `{errors:[{path, rule}]}`.
   */
  async validateTemplateSpec(
    storeId: string,
    raw: unknown,
  ): Promise<TemplateSpecV1> {
    const invalid = invalidTemplate;
    let json: string;
    try {
      json = JSON.stringify(raw);
    } catch {
      throw invalid([{ path: '', rule: 'type' }]);
    }
    if (!json || json.length > SPEC_MAX_CHARS) {
      throw invalid([{ path: '', rule: 'size' }]);
    }
    const structural = validateSpec(raw);
    if (!structural.ok) throw invalid(structural.errors);
    const spec = JSON.parse(json) as TemplateSpecV1;
    const errors: SpecIssue[] = [];

    const want: { path: string; ref: AssetRef; kinds: DesignAssetKind[] }[] =
      [];
    spec.surfaces.forEach((s, si) => {
      const base = `surfaces[${si}]`;
      if (s.background.web) {
        want.push({
          path: `${base}.background.web`,
          ref: s.background.web,
          kinds: BG_WEB_KINDS,
        });
      }
      if (s.background.print) {
        want.push({
          path: `${base}.background.print`,
          ref: s.background.print,
          kinds: BG_PRINT_KINDS,
        });
      }
      s.elements.forEach((el, ei) => {
        if (el.type === 'image') {
          want.push({
            path: `${base}.elements[${ei}].asset`,
            ref: el.asset,
            kinds: DECO_KINDS,
          });
        }
      });
    });
    const rows = await this.assets.findOwnedAssets(
      storeId,
      want.map((w) => w.ref?.asset_id).filter((id): id is string => !!id),
    );
    for (const w of want) {
      const a = w.ref ? rows.get(w.ref.asset_id) : undefined;
      if (!a) {
        errors.push({ path: w.path, rule: 'asset' });
      } else if (!w.kinds.includes(a.kind)) {
        errors.push({ path: w.path, rule: 'asset_kind' });
      } else {
        w.ref.width = a.width;
        w.ref.height = a.height;
      }
    }
    const faces = await this.fonts.fontsForSpec(storeId, spec);
    const faceById = new Map(faces.map((f) => [f.asset_id, f]));
    spec.fonts.forEach((f, i) => {
      const face = faceById.get(f.asset_id);
      if (
        !face ||
        face.family !== f.family ||
        face.weight !== f.weight ||
        face.style !== (f.style || 'normal')
      ) {
        errors.push({ path: `fonts[${i}]`, rule: 'font' });
      }
    });
    if (errors.length) throw invalid(errors);
    return spec;
  }

  // ── Templates ─────────────────────────────────────────────────────────────

  async list(
    storeId: string,
    q: { status?: DesignTemplateStatus; page?: number; limit?: number } = {},
  ) {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const page = Math.max(q.page ?? 1, 1);
    const where: Prisma.DesignTemplateWhereInput = {
      store_id: storeId,
      ...(q.status ? { status: q.status } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.designTemplate.findMany({
        where,
        orderBy: { updated_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          _count: { select: { products: true, versions: true } },
        },
      }),
      this.prisma.designTemplate.count({ where }),
    ]);
    const currentIds = rows
      .map((r) => r.current_version_id)
      .filter((id): id is string => !!id);
    const versions = currentIds.length
      ? await this.prisma.designTemplateVersion.findMany({
          where: { id: { in: currentIds } },
          select: { id: true, version: true, thumbnail_url: true },
        })
      : [];
    const vById = new Map(versions.map((v) => [v.id, v]));
    return {
      items: rows.map((r) => {
        const cur = r.current_version_id
          ? vById.get(r.current_version_id)
          : undefined;
        return {
          id: r.id,
          name: r.name,
          status: r.status,
          source: r.source,
          external_ref: r.external_ref,
          current_version_id: r.current_version_id,
          current_version: cur ? { id: cur.id, version: cur.version } : null,
          thumbnail_url: cur?.thumbnail_url ?? null,
          product_count: r._count.products,
          version_count: r._count.versions,
          created_at: r.created_at,
          updated_at: r.updated_at,
        };
      }),
      total,
      page,
      limit,
    };
  }

  /** A blank native template (or the given spec) as DRAFT with version 1. */
  async create(
    storeId: string,
    input: { name: string; spec?: unknown },
    userId: string | null,
  ) {
    const name = String(input.name ?? '').trim();
    if (!name) {
      throw designerErrors.badRequest(
        'DESIGNER_TEMPLATE_INVALID',
        'The template needs a name.',
      );
    }
    const spec =
      input.spec === undefined
        ? blankTemplateSpec()
        : await this.validateTemplateSpec(storeId, input.spec);
    const t = await this.prisma.designTemplate.create({
      data: {
        store_id: storeId,
        name: name.slice(0, 160),
        versions: {
          create: {
            version: 1,
            spec: spec as unknown as Prisma.InputJsonValue,
            spec_sha256: specSha256(spec),
            created_by: userId,
          },
        },
      },
    });
    return this.detail(storeId, t.id);
  }

  /** Detail: versions (newest first, with design counts), linked products, current spec. */
  async detail(storeId: string, id: string) {
    const t = await this.owned(storeId, id);
    const [versions, products] = await Promise.all([
      this.prisma.designTemplateVersion.findMany({
        where: { template_id: t.id },
        orderBy: { version: 'desc' },
        select: {
          id: true,
          version: true,
          spec_sha256: true,
          thumbnail_url: true,
          created_by: true,
          created_at: true,
          _count: { select: { designs: true } },
        },
      }),
      this.prisma.productDesigner.findMany({
        where: { template_id: t.id, store_id: storeId },
        select: {
          product_id: true,
          enabled: true,
          product: {
            select: {
              status: true,
              translations: { select: { locale: true, title: true } },
            },
          },
        },
      }),
    ]);
    const latest = versions[0] ?? null;
    const specOf = async (versionId: string | null | undefined) =>
      versionId
        ? ((
            await this.prisma.designTemplateVersion.findUnique({
              where: { id: versionId },
              select: { spec: true },
            })
          )?.spec ?? null)
        : null;
    const latestSpec = await specOf(latest?.id);
    return {
      id: t.id,
      name: t.name,
      status: t.status,
      source: t.source,
      external_ref: t.external_ref,
      current_version_id: t.current_version_id,
      created_at: t.created_at,
      updated_at: t.updated_at,
      versions: versions.map((v) => ({
        id: v.id,
        version: v.version,
        spec_sha256: v.spec_sha256,
        thumbnail_url: v.thumbnail_url,
        created_by: v.created_by,
        created_at: v.created_at,
        design_count: v._count.designs,
        current: v.id === t.current_version_id,
      })),
      latest_version: latest
        ? {
            id: latest.id,
            version: latest.version,
            spec: await specOf(latest.id),
          }
        : null,
      /** Spec of the version new designs use (null before the first publish). */
      current_spec:
        t.current_version_id === latest?.id
          ? latestSpec
          : await specOf(t.current_version_id),
      products: products.map((p) => ({
        product_id: p.product_id,
        enabled: p.enabled,
        status: p.product.status,
        titles: Object.fromEntries(
          p.product.translations.map((tr) => [tr.locale, tr.title]),
        ),
      })),
    };
  }

  /** One version with its full spec. */
  async version(storeId: string, templateId: string, versionId: string) {
    const t = await this.owned(storeId, templateId);
    const v = isUuid(versionId)
      ? await this.prisma.designTemplateVersion.findFirst({
          where: { id: versionId, template_id: t.id },
        })
      : null;
    if (!v) throw this.notFound();
    return v;
  }

  /**
   * Publish / enable gate: no import placeholder left (`pending_asset`,
   * `missing_font`), then the full `validateTemplateSpec` (its `font` rule
   * reported as `missing_font`). 400 DESIGNER_TEMPLATE_INVALID.
   */
  async assertPublishable(storeId: string, spec: unknown): Promise<void> {
    const pending = pendingSpecIssues(spec);
    if (pending.length) throw invalidTemplate(pending);
    try {
      await this.validateTemplateSpec(storeId, spec);
    } catch (e) {
      if (!(e instanceof BadRequestException)) throw e;
      const body = e.getResponse() as { errors?: SpecIssue[] };
      if (!Array.isArray(body?.errors)) throw e;
      throw invalidTemplate(
        body.errors.map((x) =>
          x.rule === 'font' ? { ...x, rule: 'missing_font' } : x,
        ),
      );
    }
  }

  /** Spec of a template's version (null when missing). */
  private async versionSpec(
    templateId: string,
    versionId: string | null,
  ): Promise<unknown> {
    if (!versionId) return null;
    const v = await this.prisma.designTemplateVersion.findFirst({
      where: { id: versionId, template_id: templateId },
      select: { spec: true },
    });
    return v?.spec ?? null;
  }

  /** Rename / status. PUBLISHED needs a current version. */
  async update(
    storeId: string,
    id: string,
    input: { name?: string; status?: DesignTemplateStatus },
  ) {
    const t = await this.owned(storeId, id);
    const data: Prisma.DesignTemplateUpdateInput = {};
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name) {
        throw designerErrors.badRequest(
          'DESIGNER_TEMPLATE_INVALID',
          'The template needs a name.',
        );
      }
      data.name = name.slice(0, 160);
    }
    if (input.status !== undefined && input.status !== t.status) {
      if (input.status === DesignTemplateStatus.PUBLISHED) {
        if (!t.current_version_id) {
          throw designerErrors.badRequest(
            'DESIGNER_TEMPLATE_INVALID',
            'Publish a version first.',
          );
        }
        await this.assertPublishable(
          storeId,
          await this.versionSpec(t.id, t.current_version_id),
        );
      } else {
        // Unpublishing would silently turn enabled products into ordinary
        // products: they must be disabled or relinked first.
        const linked = await this.prisma.productDesigner.findMany({
          where: { template_id: t.id, store_id: storeId, enabled: true },
          select: { product_id: true },
        });
        if (linked.length) {
          throw designerErrors.conflict(
            'DESIGNER_TEMPLATE_LINKED',
            'Products are enabled with this template. Disable or relink them first.',
            {
              products: linked.length,
              product_ids: linked.map((l) => l.product_id),
            },
          );
        }
      }
      data.status = input.status;
    }
    if (Object.keys(data).length) {
      await this.prisma.designTemplate.update({ where: { id: t.id }, data });
      if (data.status !== undefined) this.revalidate(storeId);
    }
    return this.detail(storeId, t.id);
  }

  /** Deletes a template nothing uses (products, designs, orders). */
  async remove(storeId: string, id: string): Promise<{ deleted: true }> {
    const t = await this.owned(storeId, id);
    const [products, designs, orders] = await Promise.all([
      this.prisma.productDesigner.count({ where: { template_id: t.id } }),
      this.prisma.design.count({
        where: { template_version: { template_id: t.id } },
      }),
      this.prisma.orderItemDesign.count({ where: { template_id: t.id } }),
    ]);
    if (products || designs || orders) {
      throw designerErrors.conflict(
        'DESIGNER_TEMPLATE_IN_USE',
        'The template is used by products, designs or orders.',
        { products, designs, orders },
      );
    }
    await this.prisma.designTemplate.delete({ where: { id: t.id } });
    return { deleted: true };
  }

  /** A new immutable version from `spec` (validated). */
  async addVersion(
    storeId: string,
    id: string,
    rawSpec: unknown,
    userId: string | null,
  ) {
    const t = await this.owned(storeId, id);
    const spec = await this.validateTemplateSpec(storeId, rawSpec);
    for (let attempt = 0; ; attempt++) {
      const last = await this.prisma.designTemplateVersion.findFirst({
        where: { template_id: t.id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      try {
        const v = await this.prisma.designTemplateVersion.create({
          data: {
            template_id: t.id,
            version: (last?.version ?? 0) + 1,
            spec: spec as unknown as Prisma.InputJsonValue,
            spec_sha256: specSha256(spec),
            created_by: userId,
          },
        });
        await this.prisma.designTemplate.update({
          where: { id: t.id },
          data: { updated_at: new Date() },
        });
        return v;
      } catch (e) {
        // Two saves racing for the same version number: retry once more.
        if (
          attempt < 2 &&
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          continue;
        }
        throw e;
      }
    }
  }

  /** Makes `versionId` the version new designs use and publishes the template. */
  async publish(storeId: string, id: string, versionId: string) {
    const t = await this.owned(storeId, id);
    const v = isUuid(versionId)
      ? await this.prisma.designTemplateVersion.findFirst({
          where: { id: versionId, template_id: t.id },
          select: { id: true },
        })
      : null;
    if (!v) throw this.notFound();
    await this.assertPublishable(storeId, await this.versionSpec(t.id, v.id));
    await this.prisma.designTemplate.update({
      where: { id: t.id },
      data: {
        current_version_id: v.id,
        status: DesignTemplateStatus.PUBLISHED,
      },
    });
    this.revalidate(storeId);
    // Not awaited: publishing never waits for (or fails on) the browser.
    void this.renderThumbnail(storeId, t.id, v.id);
    return this.detail(storeId, t.id);
  }

  /**
   * Renders the defaults of a version (no photos, default texts) as a
   * `TEMPLATE_THUMB` asset and stores its public path as the version's
   * `thumbnail_url`. Never throws: with the engine off, busy (503) or a
   * failing render the previous thumbnail stays and null is returned.
   */
  async renderThumbnail(
    storeId: string,
    templateId: string,
    versionId: string,
  ): Promise<string | null> {
    if (!this.render?.engineEnabled) return null;
    try {
      const v = await this.prisma.designTemplateVersion.findFirst({
        where: { id: versionId, template_id: templateId },
        select: { spec: true, thumbnail_url: true },
      });
      if (!v) return null;
      const canvas = await this.render.renderCanvas(
        storeId,
        v.spec as unknown as TemplateSpecV1,
        { v: 1, texts: {}, photos: {} },
        {
          mode: 'proof',
          scale: TEMPLATE_THUMB_PX_PER_MM,
          type: 'image/webp',
          quality: 0.85,
          timeoutMs: TEMPLATE_THUMB_TIMEOUT_MS,
        },
      );
      const stored = await this.assets.storeTemplateAsset(storeId, {
        buffer: canvas.data,
        kind: DesignAssetKind.TEMPLATE_THUMB,
        template_id: templateId,
      });
      const url = stored.asset.url;
      if (!url) return null;
      await this.prisma.designTemplateVersion.update({
        where: { id: versionId },
        data: { thumbnail_url: url },
      });
      if (v.thumbnail_url && v.thumbnail_url !== url) {
        await this.dropThumbnail(storeId, v.thumbnail_url);
      }
      return url;
    } catch (e) {
      this.logger.warn(
        `thumbnail of template ${templateId} version ${versionId} not rendered: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  /**
   * Deletes the TEMPLATE_THUMB asset behind a replaced thumbnail URL when
   * nothing references it any more (another version's `thumbnail_url`, a
   * spec, an order). Imported thumbnails shared by older versions stay.
   * Never throws.
   */
  private async dropThumbnail(storeId: string, oldUrl: string): Promise<void> {
    const id = ASSET_PATH_ID.exec(oldUrl)?.[1];
    if (!id) return;
    try {
      const a = await this.prisma.designAsset.findFirst({
        where: { id, store_id: storeId, kind: DesignAssetKind.TEMPLATE_THUMB },
        select: { id: true },
      });
      if (!a) return;
      const users = await this.prisma.designTemplateVersion.count({
        where: { thumbnail_url: { contains: id } },
      });
      if (users > 0) return;
      await this.assets.deleteAsset(storeId, id);
    } catch (e) {
      this.logger.debug(
        `old thumbnail ${id} kept: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ── Product link ──────────────────────────────────────────────────────────

  private async ownProduct(storeId: string, productId: string) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { creator_id: true },
    });
    const p = isUuid(productId)
      ? await this.prisma.product.findUnique({
          where: { id: productId },
          select: { id: true, creator_id: true },
        })
      : null;
    if (!store || !p || p.creator_id !== store.creator_id) {
      throw designerErrors.notFound(
        'DESIGNER_DESIGN_NOT_FOUND',
        'Product not found.',
      );
    }
    return p;
  }

  async getProductLink(storeId: string, productId: string) {
    await this.ownProduct(storeId, productId);
    const link = await this.prisma.productDesigner.findUnique({
      where: { product_id: productId },
      include: { template: { select: { id: true, name: true, status: true } } },
    });
    const fallbackFields = await this.prisma.productCustomField.count({
      where: { product_id: productId, preset_key: NPP_FALLBACK_PRESET_KEY },
    });
    const requiredFields = await this.prisma.productCustomField.count({
      where: { product_id: productId, is_required: true },
    });
    return {
      product_id: productId,
      link:
        link && link.store_id === storeId
          ? {
              enabled: link.enabled,
              template_id: link.template_id,
              template: link.template,
              // M5.5: the v2 config (empty when none was saved yet) and the
              // suggested disabled presets of imported NPP data.
              addons: readAddonsConfig(link.addons) ?? { v: 2, items: [] },
              addon_presets: legacyAddonPresets(link.addons),
              updated_at: link.updated_at,
            }
          : null,
      fallback_field_count: fallbackFields,
      required_field_count: requiredFields,
    };
  }

  /**
   * Links a product to a template. Enabling: the template must be the
   * store's and PUBLISHED; the product's `npp_fallback` launch fields are
   * deleted in the same transaction. `addons` are left unchanged.
   */
  async putProductLink(
    storeId: string,
    productId: string,
    input: { enabled: boolean; template_id: string },
  ) {
    await this.ownProduct(storeId, productId);
    const t = await this.owned(storeId, input.template_id);
    if (
      input.enabled &&
      (t.status !== DesignTemplateStatus.PUBLISHED || !t.current_version_id)
    ) {
      throw designerErrors.badRequest(
        'DESIGNER_TEMPLATE_MISMATCH',
        'Publish the template before enabling it for a product.',
      );
    }
    if (input.enabled) {
      await this.assertPublishable(
        storeId,
        await this.versionSpec(t.id, t.current_version_id),
      );
    }
    const existing = await this.prisma.productDesigner.findUnique({
      where: { product_id: productId },
      select: { store_id: true },
    });
    if (existing && existing.store_id !== storeId) {
      throw designerErrors.notFound(
        'DESIGNER_DESIGN_NOT_FOUND',
        'Product not found.',
      );
    }
    const removed = await this.prisma.$transaction(async (tx) => {
      await tx.productDesigner.upsert({
        where: { product_id: productId },
        create: {
          product_id: productId,
          store_id: storeId,
          template_id: t.id,
          enabled: input.enabled,
        },
        update: { template_id: t.id, enabled: input.enabled },
      });
      if (!input.enabled) return 0;
      const res = await tx.productCustomField.deleteMany({
        where: { product_id: productId, preset_key: NPP_FALLBACK_PRESET_KEY },
      });
      return res.count;
    });
    this.revalidate(storeId);
    return {
      ...(await this.getProductLink(storeId, productId)),
      removed_fallback_fields: removed,
    };
  }

  /**
   * `PUT designer/my/products/:productId/addons` (M5.5): replaces the
   * product's add-on config with a validated v2 config. The link must exist
   * (pick a template first); imported NPP data is kept beside it so the
   * presets stay available. Storefront pages are revalidated.
   */
  async putProductAddons(storeId: string, productId: string, raw: unknown) {
    await this.ownProduct(storeId, productId);
    const res = validateAddonsConfig(raw);
    if (!res.ok) {
      throw designerErrors.badRequest(
        'DESIGNER_ADDONS_INVALID',
        'The add-ons are not valid.',
        { errors: res.errors },
      );
    }
    const link = await this.prisma.productDesigner.findUnique({
      where: { product_id: productId },
      select: { store_id: true, addons: true },
    });
    if (!link || link.store_id !== storeId) {
      throw designerErrors.notFound(
        'DESIGNER_DESIGN_NOT_FOUND',
        'Link the product to a template first.',
      );
    }
    await this.prisma.productDesigner.update({
      where: { product_id: productId },
      data: {
        addons: storedAddonsValue(
          res.value,
          link.addons,
        ) as Prisma.InputJsonValue,
      },
    });
    this.revalidate(storeId);
    return this.getProductLink(storeId, productId);
  }

  /**
   * `DELETE designer/my/products/:productId`: removes the product's link
   * (the product becomes an ordinary product; existing designs and orders
   * are untouched). Idempotent.
   */
  async deleteProductLink(
    storeId: string,
    productId: string,
  ): Promise<{ deleted: boolean }> {
    await this.ownProduct(storeId, productId);
    const res = await this.prisma.productDesigner.deleteMany({
      where: { product_id: productId, store_id: storeId },
    });
    if (res.count > 0) this.revalidate(storeId);
    return { deleted: res.count > 0 };
  }

  // ── Storefront ────────────────────────────────────────────────────────────

  /**
   * The `designer` block of `GET storefront/:slug/products/:id`: present
   * only when the app is on, the product's link is enabled and its template
   * is PUBLISHED with a current version; null otherwise (the caller then
   * leaves the key out, so the payload is unchanged). One cached
   * `isEnabled` for stores without the app.
   */
  async storefrontBlock(
    storeId: string,
    productId: string,
  ): Promise<StorefrontDesignerBlock | null> {
    if (!(await this.storeApps.isEnabled(storeId, 'designer'))) return null;
    const link = await this.prisma.productDesigner.findUnique({
      where: { product_id: productId },
      include: {
        template: {
          select: { id: true, status: true, current_version_id: true },
        },
      },
    });
    if (
      !link ||
      !link.enabled ||
      link.store_id !== storeId ||
      link.template.status !== DesignTemplateStatus.PUBLISHED ||
      !link.template.current_version_id
    ) {
      return null;
    }
    const version = await this.prisma.designTemplateVersion.findUnique({
      where: { id: link.template.current_version_id },
      select: { id: true, spec: true },
    });
    if (!version) return null;
    const spec = version.spec as unknown as TemplateSpecV1;
    const ids: string[] = [];
    for (const s of spec.surfaces ?? []) {
      if (s.background?.web?.asset_id) ids.push(s.background.web.asset_id);
      for (const el of s.elements ?? []) {
        if (el.type === 'image' && el.asset?.asset_id)
          ids.push(el.asset.asset_id);
      }
    }
    const [rows, fonts, settingsRaw] = await Promise.all([
      this.assets.findOwnedAssets(storeId, ids),
      this.fonts.fontsForSpec(storeId, spec),
      this.storeApps.getSettings(storeId, 'designer'),
    ]);
    const settings = normalizeDesignerSettings(settingsRaw);
    const addons: StorefrontAddon[] = enabledAddons(link.addons).map((a) => ({
      key: a.key,
      type: a.type,
      label: a.label,
      price: a.price,
      ...(a.type === 'quantity' ? { max_qty: a.max_qty ?? 1 } : {}),
    }));
    return {
      template_id: link.template_id,
      template_version_id: version.id,
      spec_public: publicSpec(spec, rows),
      fonts: fonts.map((f) => ({
        family: f.family,
        weight: f.weight,
        style: f.style,
        url: absoluteApiUrl(f.url),
      })),
      settings: {
        max_upload_mb: settings.max_upload_mb,
        min_effective_dpi_warning: settings.min_effective_dpi_warning,
      },
      ...(addons.length ? { addons } : {}),
    };
  }
}

/** Public URL of a public template asset (null when missing or private). */
function publicUrl(a: DesignAsset | undefined): string | null {
  if (!a || a.purged_at) return null;
  const ext = extForMime(a.mime);
  if (!ext) return null;
  if (
    a.kind !== DesignAssetKind.TEMPLATE_BG_WEB &&
    a.kind !== DesignAssetKind.TEMPLATE_DECO &&
    a.kind !== DesignAssetKind.TEMPLATE_THUMB
  ) {
    return null;
  }
  return absoluteApiUrl(designerAssetPath(a.id, ext));
}

/**
 * `spec_public` (§4.1): AssetRefs get their public `url`, the print
 * background is removed (private, print only), font refs keep their ids
 * (URLs travel in `fonts`). Everything else is the spec as stored.
 */
export function publicSpec(
  spec: TemplateSpecV1,
  rows: Map<string, DesignAsset>,
): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(spec)) as TemplateSpecV1;
  for (const s of copy.surfaces ?? []) {
    if (s.background) {
      delete s.background.print;
      if (s.background.web) {
        (s.background.web as AssetRef & { url?: string | null }).url =
          publicUrl(rows.get(s.background.web.asset_id));
      }
    }
    for (const el of s.elements ?? []) {
      if (el.type === 'image' && el.asset) {
        (el.asset as AssetRef & { url?: string | null }).url = publicUrl(
          rows.get(el.asset.asset_id),
        );
      }
    }
  }
  return copy as unknown as Record<string, unknown>;
}
