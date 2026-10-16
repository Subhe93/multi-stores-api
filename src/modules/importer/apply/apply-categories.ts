import { ImportItemPhase, ImportLogLevel, type Prisma } from '@prisma/client';
import { categoryStateHash } from '../mapping/state';
import type { PlannedCategory } from '../planner/planner';
import {
  appliedRefs,
  errorMessage,
  ledgerBefore,
  publicUrlOf,
  recordItems,
  upsertLedger,
  type ApplyContext,
  type ApplyItem,
  type LedgerBefore,
  type Tx,
} from './apply-context';

/** Categories per transaction (M4.4 §9.1). */
export const CATEGORY_BATCH = 50;

/** Managed fields of a collection before an UPDATE / adoption (D7, fix 6). */
export interface CategoryBefore {
  category: {
    slug: string;
    parent_id: string | null;
    sort_order: number;
    is_active: boolean;
    noindex_when_empty: boolean;
    thumbnail_url: string | null;
    external_ref: string | null;
  };
  translation: {
    name: string;
    description: string | null;
    meta_title: string | null;
    meta_desc: string | null;
  } | null;
  ledger: LedgerBefore | null;
}

async function writeOne(
  tx: Tx,
  ctx: ApplyContext,
  c: PlannedCategory,
  idByRef: Map<string, string>,
): Promise<ApplyItem> {
  const m = c.mapped;
  if (c.action !== 'CREATE' && c.action !== 'UPDATE') {
    return {
      entity_type: 'CATEGORY',
      external_ref: m.ref,
      action: c.action,
      target_id: c.target_id,
    };
  }
  let before: CategoryBefore | null = null;
  if (c.action === 'UPDATE') {
    const cur = await tx.creatorCategory.findUnique({
      where: { id: c.target_id! },
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
    if (!cur) throw new Error(`collection ${c.target_id} no longer exists`);
    const tr = await tx.creatorCategoryTranslation.findUnique({
      where: {
        creator_category_id_locale: {
          creator_category_id: c.target_id!,
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
      ledger: await ledgerBefore(tx, ctx, 'CATEGORY', m.ref),
    };
  }
  // A thumbnail that could not be stored never wipes the current one (fix 2).
  const resolvedThumb = m.thumbnail ? publicUrlOf(ctx, m.thumbnail.url) : null;
  const thumbnail_url =
    m.thumbnail && !resolvedThumb
      ? (before?.category.thumbnail_url ?? null)
      : resolvedThumb;
  const data = {
    slug: m.slug,
    parent_id: m.parent_ref ? (idByRef.get(m.parent_ref) ?? null) : null,
    sort_order: m.sort_order,
    is_active: true,
    noindex_when_empty: m.noindex_when_empty,
    thumbnail_url,
  };
  const tr = {
    name: m.name,
    description: m.description,
    meta_title: m.meta_title,
    meta_desc: m.meta_desc,
  };
  let id: string;
  if (c.action === 'CREATE') {
    const row = await tx.creatorCategory.create({
      data: { ...data, creator_id: ctx.creatorId, external_ref: m.ref },
      select: { id: true },
    });
    id = row.id;
    await tx.creatorCategoryTranslation.create({
      data: { ...tr, creator_category_id: id, locale: ctx.primaryLocale },
    });
  } else {
    id = c.target_id!;
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
      update: tr,
    });
  }
  idByRef.set(m.ref, id);
  await upsertLedger(tx, ctx, {
    entity_type: 'CATEGORY',
    external_ref: m.ref,
    target_id: id,
    source_hash: c.source_hash,
    applied_hash: categoryStateHash({ category: data, translation: tr }),
    created: c.action === 'CREATE',
    created_by_import: c.created_by_import,
  });
  return {
    entity_type: 'CATEGORY',
    external_ref: m.ref,
    action: c.action,
    target_id: id,
    message: c.adopt ? 'adopted' : null,
    title: m.name,
    ...(before ? { before: before as unknown as Prisma.InputJsonValue } : {}),
  };
}

/**
 * Categories phase: parents first (catalog order), one transaction per 50.
 * CREATE writes a new collection, UPDATE overwrites the managed fields (an
 * adopted collection also gets its `external_ref`, D25) and keeps the
 * previous values in the item's `before` (D7), the other actions only record
 * their item. When a batch fails, its rows are retried one by one so a single
 * bad row is the only ERROR (fix 3). Returns the next cursor after each batch.
 */
export async function applyCategories(
  ctx: ApplyContext,
  planned: PlannedCategory[],
  start: number,
  onBatch: (next: number) => Promise<void>,
): Promise<{ errors: number }> {
  const refs = planned.map((c) => c.mapped.ref);
  const existing = await ctx.prisma.creatorCategory.findMany({
    where: { creator_id: ctx.creatorId, external_ref: { in: refs } },
    select: { id: true, external_ref: true },
  });
  const idByRef = new Map(existing.map((c) => [c.external_ref!, c.id]));
  for (const c of planned)
    if (c.target_id && c.action !== 'CONFLICT')
      idByRef.set(c.mapped.ref, c.target_id);
  let errors = 0;

  for (let i = start; i < planned.length; i += CATEGORY_BATCH) {
    await ctx.checkpoint();
    const batch = planned.slice(i, i + CATEGORY_BATCH);
    const done = await appliedRefs(
      ctx.prisma,
      ctx.runId,
      'CATEGORY',
      batch.map((c) => c.mapped.ref),
    );
    const todo = batch.filter((c) => !done.has(c.mapped.ref));
    const savedIds = new Map(idByRef);
    try {
      await ctx.prisma.$transaction(
        async (tx) => {
          const items: ApplyItem[] = [];
          for (const c of todo) items.push(await writeOne(tx, ctx, c, idByRef));
          await recordItems(tx, ctx.runId, ImportItemPhase.APPLY, items);
        },
        { timeout: 60_000 },
      );
    } catch {
      // Row-by-row fallback: ids created by the failed batch were rolled back.
      idByRef.clear();
      for (const [k, v] of savedIds) idByRef.set(k, v);
      for (const c of todo) {
        try {
          await ctx.prisma.$transaction(
            async (tx) => {
              const item = await writeOne(tx, ctx, c, idByRef);
              await recordItems(tx, ctx.runId, ImportItemPhase.APPLY, [item]);
            },
            { timeout: 30_000 },
          );
        } catch (err) {
          errors++;
          await ctx.log(
            ImportLogLevel.ERROR,
            'IMPORT_CATEGORY_FAILED',
            errorMessage(err),
            { entity_type: 'CATEGORY', external_ref: c.mapped.ref },
          );
          await recordItems(ctx.prisma, ctx.runId, ImportItemPhase.APPLY, [
            {
              entity_type: 'CATEGORY',
              external_ref: c.mapped.ref,
              action: 'ERROR',
              target_id: c.target_id,
              message: errorMessage(err),
            },
          ]);
        }
      }
    }
    await onBatch(Math.min(i + CATEGORY_BATCH, planned.length));
  }
  return { errors };
}
