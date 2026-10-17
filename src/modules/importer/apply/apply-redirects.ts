import { ImportItemAction, ImportItemPhase } from '@prisma/client';
import type { PlanWork } from '../planner/planner';
import {
  recordItems,
  type ApplyContext,
  type ApplyItem,
} from './apply-context';

export interface RedirectApplyResult {
  created: number;
  updated: number;
  unchanged: number;
  repointed: number;
  deactivated: number;
  conflicts: number;
  /** Redirects dropped because their product / collection failed in this run (fix 13, M5 B22). */
  dropped: number;
}

/**
 * Redirects phase (§6.1): one transaction through
 * `RedirectsService.bulkUpsertFromImport`, which plans with the same pure
 * `planRedirectUpserts` the dry run used (PLAN == APPLY). MANUAL rows are
 * never overwritten; live-path conflicts were filtered by the planner.
 * Redirects to products whose apply ended in ERROR are dropped (their page
 * may not exist). UPDATE, re-pointed and deactivated rows keep the replaced
 * values in the item's `before` (fix 5), so a rollback restores them. The
 * redirect cache is invalidated after the commit.
 */
export async function applyRedirects(
  ctx: ApplyContext,
  work: NonNullable<PlanWork['redirects']>,
): Promise<RedirectApplyResult> {
  await ctx.checkpoint();
  const empty: RedirectApplyResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    repointed: 0,
    deactivated: 0,
    conflicts: 0,
    dropped: 0,
  };
  // Resume marker (M5 B22): the phase writes every item in one transaction,
  // so any REDIRECT item of this run means it already ran — also for a plan
  // that only has conflicts or deactivations (no `items` / `repoints`).
  const already = await ctx.prisma.importRunItem.count({
    where: {
      run_id: ctx.runId,
      phase: ImportItemPhase.APPLY,
      entity_type: 'REDIRECT',
    },
  });
  if (already > 0) return empty;

  // Products and collections of this run that ended in ERROR (fix 13, M5
  // B22): their pages may not exist, so their redirects are dropped.
  const failed = new Set(
    (
      await ctx.prisma.importRunItem.findMany({
        where: {
          run_id: ctx.runId,
          phase: ImportItemPhase.APPLY,
          entity_type: { in: ['PRODUCT', 'CATEGORY'] },
          action: ImportItemAction.ERROR,
        },
        select: { external_ref: true },
      })
    ).map((r) => r.external_ref),
  );
  const incoming = work.incoming.filter(
    (_r, i) => !failed.has(work.incoming_refs?.[i] ?? ''),
  );
  const droppedRows = work.incoming.filter((_r, i) =>
    failed.has(work.incoming_refs?.[i] ?? ''),
  );

  const result = await ctx.prisma.$transaction(
    async (tx) => {
      const res = await ctx.redirects.bulkUpsertFromImport(
        tx,
        ctx.storeId,
        ctx.runId,
        incoming,
        work.live_paths ?? [],
      );
      const before = res.before ?? {};
      const items: ApplyItem[] = [
        ...res.items.map((i) => ({
          entity_type: 'REDIRECT',
          external_ref: i.from_path,
          action: i.action,
          target_id: i.id,
          ...(i.action === 'UPDATE' && i.id && before[i.id]
            ? {
                before: before[i.id],
                diff: { title: i.to_path, to_path: i.to_path },
              }
            : {}),
        })),
        ...res.repoints.map((r) => ({
          entity_type: 'REDIRECT',
          external_ref: r.from_path,
          action: 'UPDATE' as const,
          target_id: r.id,
          message: 'repointed',
          ...(before[r.id]
            ? {
                before: before[r.id],
                diff: { title: r.to_path, to_path: r.to_path },
              }
            : {}),
        })),
        ...res.deactivated.map((d) => ({
          entity_type: 'REDIRECT',
          external_ref: d.from_path,
          action: 'UPDATE' as const,
          target_id: d.id,
          message: 'deactivated (live path)',
          ...(before[d.id]
            ? {
                before: before[d.id],
                diff: { title: d.to_path, to_path: d.to_path },
              }
            : {}),
        })),
        ...res.conflicts.map((c) => ({
          entity_type: 'REDIRECT',
          external_ref: c.from_path,
          action: 'CONFLICT' as const,
          target_id: null,
          message: c.code,
        })),
        ...work.live_conflicts.map((c) => ({
          entity_type: 'REDIRECT',
          external_ref: c.from_path,
          action: 'CONFLICT' as const,
          target_id: null,
          message: 'live path',
        })),
        ...droppedRows.map((r) => ({
          entity_type: 'REDIRECT',
          external_ref: r.from_path,
          action: 'SKIP' as const,
          target_id: null,
          message: 'source entity failed in this run',
        })),
      ];
      await recordItems(tx, ctx.runId, ImportItemPhase.APPLY, items);
      return res;
    },
    { timeout: 120_000 },
  );
  ctx.redirects.invalidate(ctx.storeId);
  return {
    created: result.created,
    updated: result.updated,
    unchanged: result.unchanged,
    repointed: result.repointed,
    deactivated: result.deactivated.length,
    conflicts: result.conflicts.length + work.live_conflicts.length,
    dropped: droppedRows.length,
  };
}
