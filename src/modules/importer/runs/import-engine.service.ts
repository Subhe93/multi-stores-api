import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ImportItemPhase,
  ImportLogLevel,
  ImportRunStatus,
  type ImportRun,
  type ImportSource,
  type Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  PRIVATE_STORAGE,
  type PrivateStorage,
} from '../../../common/storage/private-file-storage';
import {
  DESIGNER_IMPORT_PORT,
  type DesignerImportPort,
} from '../../../common/ports/designer-import.port';
import { RevalidationService } from '../../../common/revalidation/revalidation.service';
import { RedirectsService } from '../../redirects/redirects.service';
import { UploadsService } from '../../uploads/uploads.service';
import {
  CATALOG_LIMITS,
  ImportAdapterError,
  type ImportSourceSettings,
  type ImportSourceView,
} from '../adapters/source-adapter';
import { BundleReadError } from '../adapters/bundle-reader';
import { WpBundleAdapter } from '../adapters/wp-bundle/wp-bundle.adapter';
import type { NormalizedCatalog } from '../model/normalized';
import { hashOf } from '../mapping/hash';
import {
  IMPORTER_HTML_SANITIZER,
  type ImporterHtmlSanitizer,
  W_HTML_SANITIZER_FALLBACK,
} from '../html/html-sanitizer';
import { SafeFetcher } from '../media/safe-fetch';
import { MediaImporter, type StoredMedia } from '../media/media-importer';
import { planImport, type ImportPlan, type PlanItem } from '../planner/planner';
import { loadTargetSnapshot } from '../planner/state-loader';
import {
  PERSONALIZATION_PRESET_PORT,
  type PersonalizationPresetPort,
} from '../ports/personalization.port';
import { applyCategories } from '../apply/apply-categories';
import {
  applyProducts,
  applyRemovals,
  applySkipped,
} from '../apply/apply-products';
import { applyShipping } from '../apply/apply-shipping';
import { applyTemplates } from '../apply/apply-templates';
import { applyRedirects } from '../apply/apply-redirects';
import { rollbackRun, type RollbackResult } from '../apply/rollback';
import {
  appliedRefs,
  recordItems,
  type ApplyContext,
} from '../apply/apply-context';
import { ImportRunError } from '../importer.errors';
import { normalizeRunOptions, type ImportRunOptions } from './run-options';
import {
  loadCatalogSnapshot,
  saveCatalogSnapshot,
  snapshotKey,
  StorageBundleReader,
} from './bundle-store';

/** Apply phases in order (M4.4 §9.1); `load` happens before the first one. */
export const APPLY_PHASES = [
  'media',
  'categories',
  'shipping',
  'products',
  'templates',
  'redirects',
  'finalize',
] as const;
export type ApplyPhase = (typeof APPLY_PHASES)[number];

export interface RunCursor {
  phase: ApplyPhase;
  index: number;
}

export interface RunProgress {
  phase: string;
  done: number;
  total: number;
  cursor?: RunCursor;
}

/** Hooks the worker passes in (heartbeat + cancel/timeout checks). */
export interface RunControl {
  /** Throws to stop the run (cancel requested, wall-clock limit). */
  checkpoint: () => Promise<void>;
  /** The claiming worker; status writes are guarded by it (fix 8). */
  workerId?: string;
}

/**
 * Run outcome (fix 19). The status enum has no COMPLETED_WITH_ERRORS, so a run
 * whose entity errors pass these limits ends FAILED (rollbackable) with the
 * reasons in `summary.apply.outcome`; below them it is
 * COMPLETED_WITH_WARNINGS.
 */
export const PRODUCT_ERROR_FAIL_RATIO = 0.1;

export function runOutcome(counts: Record<string, Record<string, number>>): {
  failed: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const err = (t: string) => counts[t]?.ERROR ?? 0;
  if (err('CATEGORY'))
    reasons.push(`IMPORT_CATEGORY_ERRORS:${err('CATEGORY')}`);
  const ship =
    err('SHIPPING_PROFILE') + err('SHIPPING_ZONE') + err('SHIPPING_METHOD');
  if (ship) reasons.push(`IMPORT_SHIPPING_ERRORS:${ship}`);
  const products = Object.values(counts.PRODUCT ?? {}).reduce(
    (a, b) => a + b,
    0,
  );
  const pe = err('PRODUCT');
  if (pe && products && pe / products > PRODUCT_ERROR_FAIL_RATIO)
    reasons.push(`IMPORT_PRODUCT_ERRORS:${pe}/${products}`);
  return { failed: reasons.length > 0, reasons };
}

export class RunCancelledError extends Error {
  readonly code = 'IMPORT_RUN_CANCELLED';
  constructor() {
    super('Cancelled by the user');
  }
}

function sourceView(source: ImportSource): ImportSourceView {
  return {
    kind: source.kind,
    site_host: source.site_host,
    host_aliases: source.host_aliases ?? [],
    settings: (source.settings ?? {}) as ImportSourceSettings,
  };
}

/**
 * Planning, apply and rollback of one run. The worker owns claiming,
 * heartbeats and status transitions around these calls.
 */
@Injectable()
export class ImportEngineService {
  private readonly logger = new Logger(ImportEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PRIVATE_STORAGE) private readonly storage: PrivateStorage,
    private readonly uploads: UploadsService,
    private readonly redirects: RedirectsService,
    private readonly revalidation: RevalidationService,
    @Inject(PERSONALIZATION_PRESET_PORT)
    private readonly personalization: PersonalizationPresetPort,
    @Inject(DESIGNER_IMPORT_PORT) private readonly designer: DesignerImportPort,
    @Inject(IMPORTER_HTML_SANITIZER)
    private readonly sanitizer: ImporterHtmlSanitizer,
  ) {}

  fetcherFor(source: ImportSource): SafeFetcher {
    const settings = (source.settings ?? {}) as ImportSourceSettings;
    return new SafeFetcher({
      siteHost: source.site_host,
      aliases: source.host_aliases ?? [],
      uploadsPath: settings.uploads_path,
    });
  }

  async log(
    runId: string,
    level: ImportLogLevel,
    code: string,
    message: string,
    extra: {
      entity_type?: string;
      external_ref?: string;
      data?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    await this.prisma.importRunLog.create({
      data: {
        run_id: runId,
        level,
        code: code.slice(0, 64),
        message: message.slice(0, 2000),
        entity_type: extra.entity_type?.slice(0, 32) ?? null,
        external_ref: extra.external_ref?.slice(0, 255) ?? null,
        ...(extra.data ? { data: extra.data as Prisma.InputJsonValue } : {}),
      },
    });
  }

  // ── Planning (dry run) ───────────────────────────────────────────────────

  /** Parses the bundle into a catalog (normalized JSON round trip, so plan and apply see the same data). */
  async parseBundle(
    run: ImportRun,
    source: ImportSource,
  ): Promise<NormalizedCatalog> {
    if (source.kind !== 'WP_BUNDLE') {
      throw new ImportRunError(
        'IMPORT_SOURCE_KIND_UNSUPPORTED',
        'Only WordPress bundles can be imported in this version',
      );
    }
    if (!run.bundle_key)
      throw new ImportRunError(
        'IMPORT_BUNDLE_MISSING_FILE',
        'The run has no bundle',
      );
    let catalog: NormalizedCatalog;
    try {
      catalog = await new WpBundleAdapter().load({
        source: sourceView(source),
        bundle: new StorageBundleReader(this.storage, run.bundle_key),
      });
    } catch (e) {
      if (e instanceof BundleReadError || e instanceof ImportAdapterError)
        throw new ImportRunError(e.code, e.message);
      throw new ImportRunError(
        'IMPORT_BUNDLE_PARSE_FAILED',
        (e as Error).message,
      );
    }
    const variations = catalog.products.reduce(
      (n, p) => n + p.variations.length,
      0,
    );
    if (
      catalog.products.length > CATALOG_LIMITS.products ||
      variations > CATALOG_LIMITS.variations ||
      catalog.categories.length > CATALOG_LIMITS.categories
    ) {
      throw new ImportRunError(
        'IMPORT_BUNDLE_TOO_LARGE',
        'The catalog exceeds the import limits',
      );
    }
    return JSON.parse(JSON.stringify(catalog)) as NormalizedCatalog;
  }

  /** Plan against the store as it is now (dry run, confirm check, apply). */
  async buildPlan(
    run: Pick<ImportRun, 'store_id' | 'options'>,
    source: ImportSource,
    catalog: NormalizedCatalog,
    catalogHash: string,
  ): Promise<{
    plan: ImportPlan;
    options: ImportRunOptions;
    creatorId: string;
    primaryLocale: string;
    creatorHasDefaultProfile: boolean;
  }> {
    const { options, errors } = normalizeRunOptions(run.options);
    if (errors.length)
      throw new ImportRunError('IMPORT_RUN_OPTIONS_INVALID', errors.join('; '));
    const [personalizationAvailable, designerAvailable, redirects] =
      await Promise.all([
        this.personalization.isAvailable(run.store_id),
        this.designer.isAvailable(run.store_id),
        this.redirects.existingForPlan(run.store_id),
      ]);
    const snapshot = await loadTargetSnapshot({
      db: this.prisma,
      storeId: run.store_id,
      catalog,
      options,
      personalizationAvailable,
      designerAvailable,
      redirects,
    });
    const plan = planImport({
      catalog,
      catalogHash,
      options,
      snapshot,
      sanitizer: this.sanitizer,
      now: new Date(),
      hostAliases: source.host_aliases ?? [],
    });
    return {
      plan,
      options,
      creatorId: snapshot.creatorId,
      primaryLocale: snapshot.primaryLocale,
      creatorHasDefaultProfile: snapshot.creatorHasDefaultProfile,
    };
  }

  /** UPLOADED → (worker sets PLANNING) → PLANNED / PLAN_FAILED. */
  async executePlanning(runId: string, control: RunControl): Promise<void> {
    const run = await this.prisma.importRun.findUniqueOrThrow({
      where: { id: runId },
    });
    const source = await this.prisma.importSource.findUniqueOrThrow({
      where: { id: run.source_id },
    });
    const catalog = await this.parseBundle(run, source);
    await control.checkpoint();
    const catalogHash = hashOf(catalog);
    const key = snapshotKey(run.store_id, run.id);
    await saveCatalogSnapshot(this.storage, key, catalog);
    const { plan, options } = await this.buildPlan(
      run,
      source,
      catalog,
      catalogHash,
    );
    await control.checkpoint();

    // Dry-run media check (verify_media): first bytes of every new image.
    if (options.verify_media) {
      const fetcher = this.fetcherFor(source);
      const mi = new MediaImporter({
        db: this.prisma,
        fetcher,
        uploads: this.uploads,
        storage: this.storage,
        storeId: run.store_id,
        runId: run.id,
      });
      const res = await mi.verifyAll(
        plan.work.media.filter((m) => m.action === 'CREATE'),
      );
      const failed = res.filter((r) => !r.ok);
      if (failed.length) {
        plan.summary.warnings.W_MEDIA_FETCH_FAILED = {
          count: failed.length,
          samples: failed.slice(0, 10).map((f) => ({
            external_ref: f.source_url,
            message: f.message ?? 'failed',
          })),
        };
      }
    }

    await control.checkpoint();
    await this.prisma.importRunItem.deleteMany({
      where: { run_id: run.id, phase: ImportItemPhase.PLAN },
    });
    await this.writePlanItems(run.id, plan.items);
    // Fix 8: only the claiming worker, only from PLANNING, never over a cancel.
    const res = await this.prisma.importRun.updateMany({
      where: {
        id: run.id,
        status: ImportRunStatus.PLANNING,
        cancel_requested_at: null,
        ...(control.workerId ? { worker_id: control.workerId } : {}),
      },
      data: {
        status: ImportRunStatus.PLANNED,
        snapshot_key: key,
        catalog_hash: catalogHash,
        plan_fingerprint: plan.fingerprint,
        summary: plan.summary as unknown as Prisma.InputJsonValue,
        progress: {
          phase: 'planned',
          done: plan.items.length,
          total: plan.items.length,
        },
        planned_at: new Date(),
        heartbeat_at: null,
        worker_id: null,
        error: plan.blockers.length
          ? plan.blockers
              .map((b) => `${b.code}: ${b.message}`)
              .join('\n')
              .slice(0, 2048)
          : null,
      },
    });
    if (res.count !== 1) {
      const cur = await this.prisma.importRun.findUnique({
        where: { id: run.id },
        select: { cancel_requested_at: true },
      });
      if (cur?.cancel_requested_at) throw new RunCancelledError();
      throw new ImportRunError(
        'IMPORT_RUN_INTERRUPTED',
        'The run was taken over',
      );
    }
  }

  private async writePlanItems(
    runId: string,
    items: PlanItem[],
  ): Promise<void> {
    for (let i = 0; i < items.length; i += 1000) {
      await recordItems(
        this.prisma,
        runId,
        ImportItemPhase.PLAN,
        items
          .slice(i, i + 1000)
          .map((it) => ({ ...it, message: it.message ?? null })),
      );
    }
  }

  /** Confirm check: the plan as it would run now (409 IMPORT_PLAN_STALE when the fingerprint moved). */
  async replanForConfirm(run: ImportRun): Promise<ImportPlan> {
    if (!run.snapshot_key || !run.catalog_hash) {
      throw new ImportRunError(
        'IMPORT_RUN_INVALID_STATE',
        'The run has no dry run',
      );
    }
    const source = await this.prisma.importSource.findUniqueOrThrow({
      where: { id: run.source_id },
    });
    const catalog = await loadCatalogSnapshot(this.storage, run.snapshot_key);
    return (await this.buildPlan(run, source, catalog, run.catalog_hash)).plan;
  }

  // ── Apply ────────────────────────────────────────────────────────────────

  /** RUNNING: executes the plan phase by phase from the saved cursor. Returns the final status. */
  async executeApply(
    runId: string,
    control: RunControl,
  ): Promise<ImportRunStatus> {
    const run = await this.prisma.importRun.findUniqueOrThrow({
      where: { id: runId },
    });
    const source = await this.prisma.importSource.findUniqueOrThrow({
      where: { id: run.source_id },
    });
    if (!run.snapshot_key || !run.catalog_hash) {
      throw new ImportRunError(
        'IMPORT_RUN_INVALID_STATE',
        'The run has no dry run',
      );
    }
    const catalog = await loadCatalogSnapshot(this.storage, run.snapshot_key);
    const built = await this.buildPlan(run, source, catalog, run.catalog_hash);
    const { plan, options } = built;
    const progress = (run.progress ?? null) as RunProgress | null;
    const resumed = !!progress?.cursor;
    if (!resumed && plan.fingerprint !== run.plan_fingerprint) {
      throw new ImportRunError(
        'IMPORT_PLAN_STALE',
        'The store changed since the dry run; run a new dry run',
      );
    }
    if (plan.blockers.length)
      throw new ImportRunError(plan.blockers[0].code, plan.blockers[0].message);
    if (!resumed) {
      await this.log(
        run.id,
        ImportLogLevel.INFO,
        'IMPORT_STARTED',
        `Applying ${plan.items.length} plan items`,
      );
      if (this.sanitizer.mode === 'plain_text_fallback') {
        await this.log(
          run.id,
          ImportLogLevel.WARN,
          W_HTML_SANITIZER_FALLBACK,
          'HTML imported as plain text paragraphs (sanitize-html not installed)',
        );
      }
    } else {
      await this.log(
        run.id,
        ImportLogLevel.INFO,
        'IMPORT_RESUMED',
        `Resuming at ${progress.cursor!.phase} #${progress.cursor!.index} (attempt ${run.attempt})`,
      );
    }

    const ctx: ApplyContext = {
      prisma: this.prisma,
      storeId: run.store_id,
      creatorId: built.creatorId,
      runId: run.id,
      primaryLocale: built.primaryLocale,
      siteHost: source.site_host,
      options,
      personalization: this.personalization,
      designer: this.designer,
      redirects: this.redirects,
      personalizationAvailable: plan.summary.plan.personalization_available,
      designerAvailable: plan.summary.plan.designer_available,
      creatorHasDefaultProfile: built.creatorHasDefaultProfile,
      media: new Map(),
      log: (level, code, message, extra) =>
        this.log(run.id, level, code, message, extra),
      checkpoint: control.checkpoint,
    };

    let cursor: RunCursor = progress?.cursor ?? { phase: 'media', index: 0 };
    const save = async (
      phase: ApplyPhase,
      index: number,
      done: number,
      total: number,
    ) => {
      cursor = { phase, index };
      await this.prisma.importRun.update({
        where: { id: run.id },
        data: {
          progress: {
            phase,
            done,
            total,
            cursor: { phase, index },
          } as unknown as Prisma.InputJsonValue,
        },
      });
    };
    const startOf = (phase: ApplyPhase): number | null => {
      const at = APPLY_PHASES.indexOf(cursor.phase);
      const me = APPLY_PHASES.indexOf(phase);
      if (me < at) return null;
      return me === at ? cursor.index : 0;
    };
    let errors = 0;

    // media
    let start = startOf('media');
    if (start !== null) {
      const needs = plan.work.media;
      // Fix 8: a cursor exists before the first batch, so a crash inside it
      // resumes instead of failing the fingerprint check.
      if (!resumed) await save('media', 0, 0, needs.length);
      const fetcher = this.fetcherFor(source);
      const mi = new MediaImporter({
        db: this.prisma,
        fetcher,
        uploads: this.uploads,
        storage: this.storage,
        storeId: run.store_id,
        runId: run.id,
      });
      for (let i = start; i < needs.length; i += 20) {
        await control.checkpoint();
        const batch = needs.slice(i, i + 20);
        const toFetch = batch.filter((n) => n.action === 'CREATE');
        const results = await mi.ensureAll(toFetch);
        // On resume a file this run already stored re-plans as UNCHANGED; it
        // is still this run's CREATE (PLAN == APPLY).
        const unchanged = batch.filter((n) => n.action !== 'CREATE');
        const ours = new Set(
          unchanged.length
            ? (
                await this.prisma.importMedia.findMany({
                  where: {
                    store_id: run.store_id,
                    first_run_id: run.id,
                    source_url: { in: unchanged.map((n) => n.source_url) },
                  },
                  select: { source_url: true },
                })
              ).map((r) => r.source_url)
            : [],
        );
        const items: {
          entity_type: string;
          external_ref: string;
          action: 'CREATE' | 'UNCHANGED' | 'ERROR';
          target_id: null;
        }[] = unchanged.map((n) => ({
          entity_type: 'MEDIA',
          external_ref: `${n.target}:${n.source_url}`,
          action: resumed && ours.has(n.source_url) ? 'CREATE' : n.action,
          target_id: null,
        }));
        for (const [k, r] of results.entries()) {
          const n = toFetch[k];
          const ref = `${n.target}:${n.source_url}`;
          if (r.ok)
            items.push({
              entity_type: 'MEDIA',
              external_ref: ref,
              action: 'CREATE',
              target_id: null,
            });
          else {
            items.push({
              entity_type: 'MEDIA',
              external_ref: ref,
              action: 'ERROR',
              target_id: null,
            });
            await ctx.log(
              ImportLogLevel.WARN,
              'W_MEDIA_FETCH_FAILED',
              `${r.code}: ${r.message}`,
              { entity_type: 'MEDIA', external_ref: n.source_url },
            );
          }
        }
        // Items and cursor in one transaction: a resumed batch never
        // records its items twice (fix 8).
        const next = Math.min(i + 20, needs.length);
        await this.prisma.$transaction(async (tx) => {
          const done = await appliedRefs(
            tx,
            run.id,
            'MEDIA',
            items.map((x) => x.external_ref),
          );
          await recordItems(
            tx,
            run.id,
            ImportItemPhase.APPLY,
            items.filter((x) => !done.has(x.external_ref.slice(0, 255))),
          );
          await tx.importRun.update({
            where: { id: run.id },
            data: {
              progress: {
                phase: 'media',
                done: next,
                total: needs.length,
                cursor: { phase: 'media', index: next },
              } as unknown as Prisma.InputJsonValue,
            },
          });
        });
        cursor = { phase: 'media', index: next };
      }
      await save('categories', 0, 0, plan.work.categories.length);
    }
    ctx.media = await this.loadMediaMap(run.store_id, plan);

    start = startOf('categories');
    if (start !== null) {
      const res = await applyCategories(
        ctx,
        plan.work.categories,
        start,
        (next) => save('categories', next, next, plan.work.categories.length),
      );
      errors += res.errors;
      await save('shipping', 0, 0, plan.work.shipping?.profiles.length ?? 0);
    }

    start = startOf('shipping');
    if (start !== null) {
      if (plan.work.shipping) {
        const work = plan.work.shipping;
        const res = await applyShipping(ctx, work, start, (next) =>
          save('shipping', next, next, work.profiles.length),
        );
        errors += res.errors;
      } else if (options.scopes.shipping) {
        await ctx.log(
          ImportLogLevel.WARN,
          'W_SHIPPING_NOT_IN_BUNDLE',
          'The bundle has no shipping tables; shipping was not imported',
        );
      }
      await save('products', 0, 0, plan.work.products.length);
    }

    start = startOf('products');
    if (start !== null) {
      const res = await applyProducts(ctx, plan.work.products, start, (next) =>
        save('products', next, next, plan.work.products.length),
      );
      errors += res.errors;
      await applySkipped(ctx, plan.work.skipped);
      await applyRemovals(ctx, plan.work.removals);
      await save('templates', 0, 0, plan.work.templates.length);
    }

    start = startOf('templates');
    if (start !== null) {
      await applyTemplates(ctx, plan.work.templates, plan.work.products);
      await save('redirects', 0, 0, plan.work.redirects?.incoming.length ?? 0);
    }

    start = startOf('redirects');
    let redirectResult: Awaited<ReturnType<typeof applyRedirects>> | null =
      null;
    if (start !== null) {
      if (plan.work.redirects)
        redirectResult = await applyRedirects(ctx, plan.work.redirects);
      await save('finalize', 0, 0, 1);
    }

    // finalize: one storefront revalidation, apply summary, final status.
    await this.revalidation
      .revalidateStoreById(run.store_id)
      .catch((e: unknown) => {
        this.logger.warn(
          `revalidation failed for ${run.store_id}: ${String(e)}`,
        );
      });
    const applyCounts = await this.prisma.importRunItem.groupBy({
      by: ['entity_type', 'action'],
      where: { run_id: run.id, phase: ImportItemPhase.APPLY },
      _count: { _all: true },
    });
    const counts: Record<string, Record<string, number>> = {};
    for (const c of applyCounts)
      (counts[c.entity_type] ??= {})[c.action] = c._count._all;
    const errorItems = Object.values(counts).reduce(
      (n, r) => n + (r.ERROR ?? 0),
      0,
    );
    const warnLogs = await this.prisma.importRunLog.count({
      where: {
        run_id: run.id,
        level: { in: [ImportLogLevel.WARN, ImportLogLevel.ERROR] },
      },
    });
    const outcome = runOutcome(counts);
    const status = outcome.failed
      ? ImportRunStatus.FAILED
      : errors || errorItems || warnLogs
        ? ImportRunStatus.COMPLETED_WITH_WARNINGS
        : ImportRunStatus.COMPLETED;
    const summary = {
      ...(run.summary as Record<string, unknown> | null),
      apply: {
        counts,
        errors: errorItems,
        redirects: redirectResult,
        outcome,
      },
    };
    await this.prisma.importRun.update({
      where: { id: run.id },
      data: {
        ...(outcome.failed
          ? {
              error: `IMPORT_RUN_ERRORS: ${outcome.reasons.join(', ')}`.slice(
                0,
                2048,
              ),
            }
          : {}),
        summary: summary as unknown as Prisma.InputJsonValue,
        progress: {
          phase: 'done',
          done: 1,
          total: 1,
          cursor: { phase: 'finalize', index: 1 },
        },
      },
    });
    await this.log(
      run.id,
      ImportLogLevel.INFO,
      'IMPORT_FINISHED',
      `Finished with status ${status}`,
    );
    return status;
  }

  /**
   * Stored media for every source URL the written entities reference — also
   * when the media scope is off (fix 2), so media of earlier runs resolve.
   */
  private async loadMediaMap(
    storeId: string,
    plan: ImportPlan,
  ): Promise<Map<string, StoredMedia>> {
    const urls = [
      ...new Set([
        ...plan.work.media.map((m) => m.source_url),
        ...(plan.work.media_urls ?? []),
      ]),
    ];
    const map = new Map<string, StoredMedia>();
    for (let i = 0; i < urls.length; i += 1000) {
      const rows = await this.prisma.importMedia.findMany({
        where: {
          store_id: storeId,
          source_url: { in: urls.slice(i, i + 1000) },
        },
      });
      for (const r of rows)
        map.set(r.source_url, {
          source_url: r.source_url,
          public_url: r.public_url,
          private_key: r.private_key,
          sha256: r.sha256,
          mime: r.mime,
          width: r.width,
          height: r.height,
          created: false,
        });
    }
    // Media already imported by earlier runs but not re-planned (UNCHANGED products) stay as they are.
    return map;
  }

  // ── Rollback ─────────────────────────────────────────────────────────────

  async executeRollback(
    runId: string,
    control?: RunControl,
  ): Promise<RollbackResult> {
    const run = await this.prisma.importRun.findUniqueOrThrow({
      where: { id: runId },
    });
    const store = await this.prisma.store.findUniqueOrThrow({
      where: { id: run.store_id },
      select: {
        creator_id: true,
        language_config: { select: { primary_locale: true } },
      },
    });
    const result = await rollbackRun({
      primaryLocale: store.language_config?.primary_locale ?? 'en',
      checkpoint: control?.checkpoint,
      prisma: this.prisma,
      storage: this.storage,
      uploads: this.uploads,
      redirects: this.redirects,
      storeId: run.store_id,
      creatorId: store.creator_id,
      runId: run.id,
      designer: this.designer,
    });
    await this.revalidation
      .revalidateStoreById(run.store_id)
      .catch(() => undefined);
    const summary = {
      ...(run.summary as Record<string, unknown> | null),
      rollback: result,
    };
    await this.prisma.importRun.update({
      where: { id: run.id },
      data: { summary: summary as unknown as Prisma.InputJsonValue },
    });
    await this.log(
      run.id,
      ImportLogLevel.INFO,
      'IMPORT_ROLLED_BACK',
      JSON.stringify(result),
    );
    return result;
  }
}
