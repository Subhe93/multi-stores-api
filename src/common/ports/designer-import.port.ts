import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { NTemplate } from '../../modules/importer/model/normalized';

/**
 * Hand-off of WooCommerce NPP templates from the importer (M4.4) to the
 * designer app (M4.2) — M4-INTEGRATION C26, M4.4 §8.2.
 *
 * The importer binds `NullDesignerImportPort` in `ImporterModule`; M4.2 WP7
 * rebinds `DESIGNER_IMPORT_PORT` to its implementation (one provider line).
 * While the port is unavailable the importer stages every template as
 * `ImportEntity(DESIGN_TEMPLATE, STAGED, payload)` and the products get the
 * D28 fallback fields; "re-run the importer with scope `templates`" passes
 * the staged templates on once the designer is available.
 */
export const DESIGNER_IMPORT_PORT = Symbol('DESIGNER_IMPORT_PORT');

/** Private copy of one template asset (importer storage key, C10). */
export interface DesignerImportMedia {
  private_key: string;
  sha256: string;
  mime: string;
  width?: number;
  height?: number;
}

/** Per-template outcome reported by `upsertTemplates` (M4.2 WP7). */
export interface DesignerTemplateResult {
  ext_id: string;
  template_id: string | null;
  action: 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'SKIP' | 'ERROR';
  /** Pending placeholders left in the spec (`pending:bg_web`, `pending:font:…`). */
  pending_assets: string[];
  /** Warning codes for the run log / dashboard i18n (`creator.designer.importWarnings.<code>`). */
  warnings: { code: string; message: string; data?: Record<string, unknown> }[];
  /** With `action: 'ERROR'`: why this template failed (the others still apply). */
  error?: string;
}

export interface DesignerUpsertOptions {
  /** Importer media scope: false ⇒ nothing is fetched, missing assets stay `pending:*`. Default true. */
  fetch_media?: boolean;
  /** Source site host of the external refs (C7); default: parsed from the template ext ids. */
  site_host?: string;
  /** Called once per template with its outcome. */
  onResult?: (r: DesignerTemplateResult) => void | Promise<void>;
}

/** Rollback outcome of one template (importer rollback, M4.4 §9.4). */
export interface DesignerTemplateRollback {
  template_id: string;
  action: 'DELETE' | 'KEEP';
  /** Why a template was kept (or `not_found` when it is already gone). */
  reason?: 'orders' | 'designs' | 'edited' | 'preexisting' | 'not_found';
  links_deleted: number;
  assets_deleted: number;
}

export interface DesignerImportPort {
  /** True when the designer app is available and enabled for the store. */
  isAvailable(storeId: string): Promise<boolean>;
  /**
   * Creates or updates `DesignTemplate` rows keyed by
   * `DesignTemplate.external_ref` (`woo:<site_host>:npp_template:<id>`).
   * `media` is keyed by the asset's source URL. Returns template ext ref →
   * `DesignTemplate.id` of every template that succeeded; a template that
   * failed is reported through `onResult` (`action: 'ERROR'`, `error`) and
   * left out, so the importer ledgers the others (partial results). Only a
   * failure of the whole call throws.
   */
  upsertTemplates(
    storeId: string,
    templates: NTemplate[],
    media: Map<string, DesignerImportMedia>,
    opts?: DesignerUpsertOptions,
  ): Promise<Map<string, string>>;
  /** Links a product to a template inside the importer's transaction (`ProductDesigner{enabled:false}`). */
  linkProduct(
    tx: Prisma.TransactionClient,
    productId: string,
    templateId: string,
    opts: { addons?: unknown; pricing?: unknown },
  ): Promise<void>;
  /**
   * Importer rollback: deletes the templates the run created (with their
   * product links and the imported asset files nothing else references),
   * unless orders or designs reference them, the merchant edited/published
   * them, or they existed before `created_since`.
   */
  rollbackTemplates?(
    storeId: string,
    templateIds: string[],
    opts?: { created_since?: Date },
  ): Promise<DesignerTemplateRollback[]>;
  /** M4.2 removes the D28 fallback fields (`preset_key = 'npp_fallback'`) it supersedes. */
  readonly replacesFallbackFields: true;
}

/** Default binding until M4.2 ships: never available, never called. */
@Injectable()
export class NullDesignerImportPort implements DesignerImportPort {
  readonly replacesFallbackFields = true as const;

  isAvailable(): Promise<boolean> {
    return Promise.resolve(false);
  }

  upsertTemplates(): Promise<Map<string, string>> {
    return Promise.reject(new Error('Designer import port is not available'));
  }

  linkProduct(): Promise<void> {
    return Promise.reject(new Error('Designer import port is not available'));
  }

  rollbackTemplates(
    _storeId: string,
    templateIds: string[],
  ): Promise<DesignerTemplateRollback[]> {
    // Nothing was handed off: the designer (if it ever ran) keeps its rows.
    return Promise.resolve(
      templateIds.map((template_id) => ({
        template_id,
        action: 'KEEP' as const,
        links_deleted: 0,
        assets_deleted: 0,
      })),
    );
  }
}
