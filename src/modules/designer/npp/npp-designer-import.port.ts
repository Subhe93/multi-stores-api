/**
 * Real `DesignerImportPort` (M4.2 WP7, M4-INTEGRATION C26): the importer's
 * staged NPP templates become designer templates.
 *
 * Bound in `ImporterModule` instead of `NullDesignerImportPort`. The choice
 * is made per call: for a store whose designer app is off, `isAvailable` is
 * false (the importer keeps staging) and `upsertTemplates` behaves exactly
 * like the Null port.
 */
import { Injectable } from '@nestjs/common';
import { DesignAssetKind, type Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  NullDesignerImportPort,
  type DesignerImportMedia,
  type DesignerImportPort,
  type DesignerTemplateResult,
  type DesignerTemplateRollback,
  type DesignerUpsertOptions,
} from '../../../common/ports/designer-import.port';
import type { NTemplate } from '../../importer/model/normalized';
import { StoreAppsService } from '../../store-apps/store-apps.service';
import { DesignerAssetsService } from '../designer-assets.service';
import type { TemplateSpecV1 } from '../render/design-renderer';
import { NppImportService, type NppImportMedia } from './npp-import.service';

const HOST_RE = /^woo:([^:]+):npp_template:/;
const ASSET_PATH_ID =
  /\/designer\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\./;

/** Asset ids a version references (backgrounds, decorations; not fonts). */
function specAssetIds(spec: unknown): string[] {
  const s = spec as TemplateSpecV1 | null;
  const out: string[] = [];
  for (const surface of s?.surfaces ?? []) {
    const bg = surface.background;
    if (bg?.web?.asset_id) out.push(bg.web.asset_id);
    if (bg?.print?.asset_id) out.push(bg.print.asset_id);
    for (const el of surface.elements ?? [])
      if (el.type === 'image' && el.asset?.asset_id)
        out.push(el.asset.asset_id);
  }
  return out;
}

@Injectable()
export class NppDesignerImportPort implements DesignerImportPort {
  readonly replacesFallbackFields = true as const;
  private readonly nullPort = new NullDesignerImportPort();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storeApps: StoreAppsService,
    private readonly npp: NppImportService,
    private readonly assets: DesignerAssetsService,
  ) {}

  isAvailable(storeId: string): Promise<boolean> {
    return this.storeApps.isEnabled(storeId, 'designer');
  }

  async upsertTemplates(
    storeId: string,
    templates: NTemplate[],
    media: Map<string, DesignerImportMedia>,
    opts: DesignerUpsertOptions = {},
  ): Promise<Map<string, string>> {
    if (!(await this.isAvailable(storeId)))
      return this.nullPort.upsertTemplates();
    const siteHost =
      opts.site_host ??
      templates.map((t) => HOST_RE.exec(t.ext_id)?.[1]).find(Boolean);
    if (!siteHost) throw new Error('NPP import: unknown source site host');

    // Which candidate the importer actually downloaded (original vs -scaled).
    const withFetched = new Map<string, NppImportMedia>();
    const urls = [...media.keys()];
    const rows = urls.length
      ? await this.prisma.importMedia.findMany({
          where: { store_id: storeId, source_url: { in: urls } },
          select: { source_url: true, fetched_url: true },
        })
      : [];
    const fetchedBy = new Map(rows.map((r) => [r.source_url, r.fetched_url]));
    for (const [url, m] of media)
      withFetched.set(url, { ...m, fetched_url: fetchedBy.get(url) ?? null });

    const report = await this.npp.importNpp(storeId, templates, {
      siteHost,
      media: withFetched,
      fetchMedia: opts.fetch_media !== false,
      linkProducts: false,
    });

    // Partial results: a failed template is reported (ERROR + error) and
    // left out of the map; the importer ledgers every other template.
    const out = new Map<string, string>();
    const extra = report.warnings;
    for (const t of report.templates) {
      if (t.template_id && t.action !== 'ERROR') {
        out.set(t.external_ref, t.template_id);
      }
      const result: DesignerTemplateResult = {
        ext_id: t.external_ref,
        template_id: t.template_id,
        action: t.action,
        pending_assets: t.pending_assets,
        warnings: [
          ...t.warnings,
          ...extra.filter((w) => w.template_id === t.source_id),
        ].map((w) => ({
          code: w.code,
          message: w.message,
          data: {
            ...(w.data ?? {}),
            ...(w.element_id ? { element_id: w.element_id } : {}),
          },
        })),
        ...(t.action === 'ERROR'
          ? { error: t.error ?? 'The template could not be imported.' }
          : {}),
      };
      await opts.onResult?.(result);
    }
    return out;
  }

  /** Inside the importer's product transaction (C26). */
  async linkProduct(
    tx: Prisma.TransactionClient,
    productId: string,
    templateId: string,
    opts: { addons?: unknown; pricing?: unknown },
  ): Promise<void> {
    const tpl = await tx.designTemplate.findUnique({
      where: { id: templateId },
      select: { store_id: true },
    });
    if (!tpl) throw new Error(`Design template ${templateId} not found`);
    const [product, store] = await Promise.all([
      tx.product.findUnique({
        where: { id: productId },
        select: { creator_id: true },
      }),
      tx.store.findUnique({
        where: { id: tpl.store_id },
        select: { creator_id: true },
      }),
    ]);
    if (!product || !store || product.creator_id !== store.creator_id)
      throw new Error(
        `Product ${productId} does not belong to the template's store`,
      );
    await this.npp.link(tx, tpl.store_id, productId, templateId, opts);
  }

  /**
   * Importer rollback (M4.4 §9.4): deletes each template the run created,
   * its product links, its versions and the imported asset files nothing
   * else references. Kept: templates with orders (`OrderItemDesign`) or
   * customer designs, templates the merchant published / edited (a version
   * with `created_by`), and templates older than the run (`preexisting`).
   * Fonts are creator uploads and never deleted here.
   */
  async rollbackTemplates(
    storeId: string,
    templateIds: string[],
    opts: { created_since?: Date } = {},
  ): Promise<DesignerTemplateRollback[]> {
    const out: DesignerTemplateRollback[] = [];
    for (const id of [...new Set(templateIds)]) {
      const r: DesignerTemplateRollback = {
        template_id: id,
        action: 'KEEP',
        links_deleted: 0,
        assets_deleted: 0,
      };
      out.push(r);
      const t = await this.prisma.designTemplate.findFirst({
        where: { id, store_id: storeId },
      });
      if (!t) {
        r.action = 'DELETE';
        r.reason = 'not_found';
        continue;
      }
      if (opts.created_since && t.created_at < opts.created_since) {
        r.reason = 'preexisting';
        continue;
      }
      const versions = await this.prisma.designTemplateVersion.findMany({
        where: { template_id: id },
        select: {
          id: true,
          spec: true,
          thumbnail_url: true,
          created_by: true,
        },
      });
      if (
        (await this.prisma.orderItemDesign.count({
          where: { template_id: id },
        })) > 0
      ) {
        r.reason = 'orders';
        continue;
      }
      const versionIds = versions.map((v) => v.id);
      if (
        versionIds.length &&
        (await this.prisma.design.count({
          where: { template_version_id: { in: versionIds } },
        })) > 0
      ) {
        r.reason = 'designs';
        continue;
      }
      if (t.status !== 'DRAFT' || versions.some((v) => v.created_by)) {
        r.reason = 'edited';
        continue;
      }
      const assetIds = new Set<string>();
      for (const v of versions) {
        for (const a of specAssetIds(v.spec)) assetIds.add(a);
        const m = v.thumbnail_url ? ASSET_PATH_ID.exec(v.thumbnail_url) : null;
        if (m) assetIds.add(m[1]);
      }
      const removed = await this.prisma.$transaction(async (tx) => {
        const links = await tx.productDesigner.deleteMany({
          where: { template_id: id },
        });
        await tx.designTemplateVersion.deleteMany({
          where: { template_id: id },
        });
        await tx.designTemplate.delete({ where: { id } });
        return links.count;
      });
      r.action = 'DELETE';
      r.links_deleted = removed;
      r.assets_deleted = await this.deleteImportedAssets(storeId, [
        ...assetIds,
      ]);
    }
    return out;
  }

  /** Imported (`meta.source_url`) template assets that nothing references any more. */
  private async deleteImportedAssets(
    storeId: string,
    ids: string[],
  ): Promise<number> {
    if (!ids.length) return 0;
    const rows = await this.assets.findOwnedAssets(storeId, ids, [
      DesignAssetKind.TEMPLATE_BG_WEB,
      DesignAssetKind.TEMPLATE_BG_PRINT,
      DesignAssetKind.TEMPLATE_DECO,
      DesignAssetKind.TEMPLATE_THUMB,
    ]);
    let n = 0;
    for (const a of rows.values()) {
      const meta = (a.meta ?? {}) as Record<string, unknown>;
      if (typeof meta.source_url !== 'string') continue;
      // Thumbnails live in thumbnail_url, which assetReferences does not scan.
      const thumbUser = await this.prisma.designTemplateVersion.findFirst({
        where: { thumbnail_url: { contains: a.id } },
        select: { id: true },
      });
      if (thumbUser) continue;
      try {
        await this.assets.deleteAsset(storeId, a.id);
        n++;
      } catch {
        // DESIGNER_ASSET_IN_USE: another template version or an order uses it.
      }
    }
    return n;
  }
}
