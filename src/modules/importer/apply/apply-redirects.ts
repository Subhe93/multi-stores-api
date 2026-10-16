import { ImportItemAction, ImportItemPhase } from '@prisma/client';
import type { PlanWork } from '../planner/planner';
import {
  appliedRefs,
  recordItems,
  type ApplyContext,
  type ApplyItem,
} from './apply-context';

export interface RedirectApplyResult {
  created: number;
  updated: number;
  unchanged: number;
  repointed: number;
  conflicts: number;
  /** Product redirects dropped because the product failed in this run (fix 13). */
  dropped: number;
}

/**
 * Redirects phase (§6.1): one transaction through
 * `RedirectsService.bulkUpsertFromImport`, which plans with the same pure
 * `planRedirectUpserts` the dry run used (PLAN == APPLY). MANUAL rows are
 * never overwritten; live-path conflicts were filtered by the planner.
 * Redirects to products whose apply ended in ERROR are dropped (their page
 * may not exist). UPDATE and re-pointed rows keep the replaced values in the
 * item's `before` (fix 5). The redirect cache is invalidated after the commit.
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
    conflicts: 0,
    dropped: 0,
  };
  const marker =
    work.plan.items[0]?.from_path ?? work.plan.repoints[0]?.from_path;
  const already = marker
    ? await appliedRefs(ctx.prisma, ctx.runId, 'REDIRECT', [marker])
    : new Set<string>();
  if (already.size) return empty;

  // Products of this run that ended in ERROR (fix 13).
  const failed = new Set(
    (
      await ctx.prisma.importRunItem.findMany({
        where: {
          run_id: ctx.runId,
          phase: ImportItemPhase.APPLY,
          entity_type: 'PRODUCT',
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
          message: 'product failed in this run',
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
    conflicts: result.conflicts.length + work.live_conflicts.length,
    dropped: droppedRows.length,
  };
}
