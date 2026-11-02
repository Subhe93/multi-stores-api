import {
  CreatorCategoryVisibility,
  ImportItemPhase,
  ImportLogLevel,
  type Prisma,
} from '@prisma/client';
import { categoryStateHash } from '../mapping/state';
import type { PlannedTag } from '../planner/planner';
import type { CategoryBefore } from './apply-categories';
import {
  appliedRefs,
  errorMessage,
  ledgerBefore,
  recordItems,
  upsertLedger,
  type ApplyContext,
  type ApplyItem,
  type Tx,
} from './apply-context';

/** Tags per transaction (same batch size as collections). */
export const TAG_BATCH = 50;

/**
 * Tags rename (2026-11-02): one WooCommerce `product_tag` term = one
 * INTERNAL `CreatorCategory` row. CREATE writes the row with the planned
 * slug (PLAN == APPLY), `visibility: INTERNAL`, no parent, `is_active`, and
 * its primary-locale name; UPDATE rewrites slug, sort_order and name and
 * keeps the previous values in the item's `before` (the same shape as a
 * collection, so the rollback restores it with the collection code).
 * Visibility is never changed on UPDATE: a tag the merchant turned into a
 * PUBLIC collection stays one. The ledger / item entity type is `TAG`.
 */
async function writeOne(
  tx: Tx,
  ctx: ApplyContext,
  t: PlannedTag,
): Promise<ApplyItem> {
  const m = t.mapped;
  if (t.action !== 'CREATE' && t.action !== 'UPDATE') {
    return {
      entity_type: 'TAG',
      external_ref: m.ref,
      action: t.action,
      target_id: t.target_id,
    };
  }
  let before: CategoryBefore | null = null;
  if (t.action === 'UPDATE') {
    const cur = await tx.creatorCategory.findUnique({
      where: { id: t.target_id! },
      select: {
        slug: true,
        parent_id: true,
        sort_order: true,
        is_active: true,
        noindex_when_empty: true,
        thumbnail_url: true,
        external_ref: true,
      },
    });
    if (!cur) throw new Error(`tag ${t.target_id} no longer exists`);
    const tr = await tx.creatorCategoryTranslation.findUnique({
      where: {
        creator_category_id_locale: {
          creator_category_id: t.target_id!,
          locale: ctx.primaryLocale,
        },
      },
      select: {
        name: true,
        description: true,
        meta_title: true,
        meta_desc: true,
      },
    });
    before = {
      category: cur,
      translation: tr ?? null,
      ledger: await ledgerBefore(tx, ctx, 'TAG', m.ref),
    };
  }
  const data = {
    slug: t.final_slug,
    parent_id: null,
    sort_order: m.sort_order,
    is_active: true,
    noindex_when_empty: false,
    thumbnail_url: null,
  };
  const tr = {
    name: m.name,
    description: null,
    meta_title: null,
    meta_desc: null,
  };
  let id: string;
  if (t.action === 'CREATE') {
    const row = await tx.creatorCategory.create({
      data: {
        ...data,
        creator_id: ctx.creatorId,
        external_ref: m.ref,
        visibility: CreatorCategoryVisibility.INTERNAL,
      },
      select: { id: true },
    });
    id = row.id;
    await tx.creatorCategoryTranslation.create({
      data: { ...tr, creator_category_id: id, locale: ctx.primaryLocale },
    });
  } else {
    id = t.target_id!;
    await tx.creatorCategory.update({
      where: { id },
      data: { ...data, external_ref: m.ref },
    });
    await tx.creatorCategoryTranslation.upsert({
      where: {
        creator_category_id_locale: {
          creator_category_id: id,
          locale: ctx.primaryLocale,
        },
      },
      create: { ...tr, creator_category_id: id, locale: ctx.primaryLocale },
      // Only the name is managed; an adopted row keeps its description/SEO.
      update: { name: tr.name },
    });
  }
  const appliedTr = await tx.creatorCategoryTranslation.findUnique({
    where: {
      creator_category_id_locale: {
        creator_category_id: id,
        locale: ctx.primaryLocale,
      },
    },
    select: {
      name: true,
      description: true,
      meta_title: true,
      meta_desc: true,
    },
  });
  await upsertLedger(tx, ctx, {
    entity_type: 'TAG',
    external_ref: m.ref,
    target_id: id,
    source_hash: t.source_hash,
    applied_hash: categoryStateHash({
      category: data,
      translation: appliedTr ?? tr,
    }),
    created: t.action === 'CREATE',
    created_by_import: t.created_by_import,
  });
  return {
    entity_type: 'TAG',
    external_ref: m.ref,
    action: t.action,
    target_id: id,
    message: t.adopt ? 'adopted' : null,
    title: m.name,
    ...(before ? { before: before as unknown as Prisma.InputJsonValue } : {}),
  };
}

/**
 * Tags phase (after collections, before products): one transaction per 50;
 * a failed batch is retried row by row so a single bad row is the only
 * ERROR, like collections. Returns the next cursor after each batch.
 */
export async function applyTags(
  ctx: ApplyContext,
  planned: PlannedTag[],
  start: number,
  onBatch: (next: number) => Promise<void>,
): Promise<{ errors: number }> {
  let errors = 0;
  for (let i = start; i < planned.length; i += TAG_BATCH) {
    await ctx.checkpoint();
    const batch = planned.slice(i, i + TAG_BATCH);
    const done = await appliedRefs(
      ctx.prisma,
      ctx.runId,
      'TAG',
      batch.map((t) => t.mapped.ref),
    );
    const todo = batch.filter((t) => !done.has(t.mapped.ref));
    try {
      await ctx.prisma.$transaction(
        async (tx) => {
          const items: ApplyItem[] = [];
          for (const t of todo) items.push(await writeOne(tx, ctx, t));
          await recordItems(tx, ctx.runId, ImportItemPhase.APPLY, items);
        },
        { timeout: 60_000 },
      );
    } catch {
      for (const t of todo) {
        try {
          await ctx.prisma.$transaction(
            async (tx) => {
              const item = await writeOne(tx, ctx, t);
              await recordItems(tx, ctx.runId, ImportItemPhase.APPLY, [item]);
            },
            { timeout: 30_000 },
          );
        } catch (err) {
          errors++;
          await ctx.log(
            ImportLogLevel.ERROR,
            'IMPORT_TAG_FAILED',
            errorMessage(err),
            { entity_type: 'TAG', external_ref: t.mapped.ref },
          );
          await recordItems(ctx.prisma, ctx.runId, ImportItemPhase.APPLY, [
            {
              entity_type: 'TAG',
              external_ref: t.mapped.ref,
              action: 'ERROR',
              target_id: t.target_id,
              message: errorMessage(err),
            },
          ]);
        }
      }
    }
    await onBatch(Math.min(i + TAG_BATCH, planned.length));
  }
  return { errors };
}
