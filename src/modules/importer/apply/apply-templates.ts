import {
  ImportEntityStatus,
  ImportItemPhase,
  ImportLogLevel,
  type Prisma,
} from '@prisma/client';
import { createHash } from 'crypto';
import type {
  DesignerImportMedia,
  DesignerTemplateResult,
} from '../../../common/ports/designer-import.port';
import type { PlannedProduct, PlannedTemplate } from '../planner/planner';
import {
  appliedRefs,
  errorMessage,
  recordItems,
  upsertLedger,
  type ApplyContext,
  type ApplyItem,
} from './apply-context';

function templateMedia(
  ctx: ApplyContext,
  t: PlannedTemplate,
): Map<string, DesignerImportMedia> {
  const out = new Map<string, DesignerImportMedia>();
  const refs = [
    ...(t.template.thumbnail ? [t.template.thumbnail] : []),
    ...t.template.assets,
  ];
  for (const r of refs) {
    const m = r.url ? ctx.media.get(r.url) : undefined;
    if (!m?.private_key) continue;
    out.set(r.url, {
      private_key: m.private_key,
      sha256: m.sha256,
      mime: m.mime,
      ...(m.width ? { width: m.width } : {}),
      ...(m.height ? { height: m.height } : {}),
    });
  }
  return out;
}

/**
 * NPP templates (D28, C26). Without the designer port every template is
 * staged as `ImportEntity(DESIGN_TEMPLATE, STAGED, {template, media})`; with
 * it, templates are upserted through the port and linked to their products.
 */
export async function applyTemplates(
  ctx: ApplyContext,
  planned: PlannedTemplate[],
  products: PlannedProduct[],
): Promise<void> {
  if (!planned.length) return;
  await ctx.checkpoint();
  const done = await appliedRefs(
    ctx.prisma,
    ctx.runId,
    'DESIGN_TEMPLATE',
    planned.map((t) => t.template.ext_id),
  );
  const todo = planned.filter((t) => !done.has(t.template.ext_id));
  const items: ApplyItem[] = [];

  for (const t of todo.filter((x) => x.action === 'STAGE')) {
    const media = Object.fromEntries(templateMedia(ctx, t));
    await upsertLedger(ctx.prisma, ctx, {
      entity_type: 'DESIGN_TEMPLATE',
      external_ref: t.template.ext_id,
      target_id: null,
      source_hash: t.source_hash,
      created: true,
      status: ImportEntityStatus.STAGED,
      payload: {
        template: t.template,
        media,
      } as unknown as Prisma.InputJsonValue,
    });
    items.push({
      entity_type: 'DESIGN_TEMPLATE',
      external_ref: t.template.ext_id,
      action: 'STAGE',
    });
  }

  const upserts = todo.filter(
    (x) => x.action === 'CREATE' || x.action === 'UPDATE',
  );
  if (upserts.length) {
    try {
      const media = new Map<string, DesignerImportMedia>();
      for (const t of upserts)
        for (const [k, v] of templateMedia(ctx, t)) media.set(k, v);
      // M4.2 WP7: per-template outcome (warnings for the run log, pending
      // assets). A template left with pending assets gets a ledger hash that
      // differs from the source hash, so the next run plans it as UPDATE and
      // the designer fills the assets in (e.g. media scope switched on).
      const results = new Map<string, DesignerTemplateResult>();
      const ids = await ctx.designer.upsertTemplates(
        ctx.storeId,
        upserts.map((t) => t.template),
        media,
        {
          fetch_media: ctx.options.scopes.media,
          site_host: ctx.siteHost,
          onResult: async (r) => {
            results.set(r.ext_id, r);
            for (const w of r.warnings)
              await ctx.log(ImportLogLevel.WARN, w.code, w.message, {
                entity_type: 'DESIGN_TEMPLATE',
                external_ref: r.ext_id,
                data: w.data,
              });
          },
        },
      );
      const productRows = await ctx.prisma.product.findMany({
        where: {
          creator_id: ctx.creatorId,
          external_ref: {
            in: products
              .filter((p) => p.mapped.npp?.template_ref)
              .map((p) => p.mapped.ref),
          },
        },
        select: { id: true, external_ref: true },
      });
      const productIdByRef = new Map(
        productRows.map((r) => [r.external_ref!, r.id]),
      );
      for (const t of upserts) {
        const templateId = ids.get(t.template.ext_id) ?? null;
        // Partial results (M4.2): a template the designer reported as
        // failed is logged and recorded as ERROR without a ledger row, so
        // the next run retries it; the others are ledgered below.
        const failed = results.get(t.template.ext_id);
        if (!templateId && failed?.action === 'ERROR') {
          const message = failed.error ?? 'The template could not be imported.';
          await ctx.log(
            ImportLogLevel.ERROR,
            'IMPORT_TEMPLATE_FAILED',
            message,
            {
              entity_type: 'DESIGN_TEMPLATE',
              external_ref: t.template.ext_id,
            },
          );
          items.push({
            entity_type: 'DESIGN_TEMPLATE',
            external_ref: t.template.ext_id,
            action: 'ERROR',
            message,
          });
          continue;
        }
        await ctx.prisma.$transaction(async (tx) => {
          if (templateId) {
            for (const p of products) {
              if (p.mapped.npp?.template_ref !== t.template.ext_id) continue;
              const pid = productIdByRef.get(p.mapped.ref);
              if (!pid) continue;
              await ctx.designer.linkProduct(tx, pid, templateId, {
                addons: p.mapped.npp.addons,
                pricing: p.mapped.npp.pricing,
              });
            }
          }
          const pending = results.get(t.template.ext_id)?.pending_assets.length
            ? createHash('sha256')
                .update(`${t.source_hash}:pending`)
                .digest('hex')
            : null;
          await upsertLedger(tx, ctx, {
            entity_type: 'DESIGN_TEMPLATE',
            external_ref: t.template.ext_id,
            target_id: templateId,
            source_hash: pending ?? t.source_hash,
            created: t.action === 'CREATE',
            status: ImportEntityStatus.ACTIVE,
            payload: null,
          });
        });
        items.push({
          entity_type: 'DESIGN_TEMPLATE',
          external_ref: t.template.ext_id,
          action: t.action,
          target_id: templateId,
        });
      }
    } catch (err) {
      await ctx.log(
        ImportLogLevel.ERROR,
        'IMPORT_TEMPLATE_FAILED',
        errorMessage(err),
        { entity_type: 'DESIGN_TEMPLATE' },
      );
      for (const t of upserts)
        if (!items.some((i) => i.external_ref === t.template.ext_id))
          items.push({
            entity_type: 'DESIGN_TEMPLATE',
            external_ref: t.template.ext_id,
            action: 'ERROR',
            message: errorMessage(err),
          });
    }
  }

  for (const t of todo.filter(
    (x) =>
      x.action !== 'STAGE' && x.action !== 'CREATE' && x.action !== 'UPDATE',
  ))
    items.push({
      entity_type: 'DESIGN_TEMPLATE',
      external_ref: t.template.ext_id,
      action: t.action,
      target_id: t.target_id,
    });
  await recordItems(ctx.prisma, ctx.runId, ImportItemPhase.APPLY, items);
}
