import { ImportEntityStatus } from '@prisma/client';
import { hashOf } from '../mapping/hash';
import type { PlanContext } from './plan-context';
import type { PlanAction, PlannedTemplate } from './plan-types';

/** NPP templates (D28, C26): STAGE while the designer is unavailable, else CREATE/UPDATE/UNCHANGED. */
export function planTemplates(ctx: PlanContext): PlannedTemplate[] {
  const { catalog, snapshot, scopes, push } = ctx;
  const planned: PlannedTemplate[] = [];
  if (!scopes.templates) return planned;
  for (const t of catalog.templates) {
    const th = hashOf(t);
    const tl = ctx.ledger('DESIGN_TEMPLATE', t.ext_id);
    let ta: PlanAction;
    if (!snapshot.designerAvailable) {
      ta =
        tl && tl.status === ImportEntityStatus.STAGED && tl.source_hash === th
          ? 'UNCHANGED'
          : 'STAGE';
    } else if (tl && tl.status === ImportEntityStatus.ACTIVE)
      ta = tl.source_hash === th ? 'UNCHANGED' : 'UPDATE';
    else ta = 'CREATE';
    planned.push({
      template: t,
      action: ta,
      source_hash: th,
      target_id: tl?.target_id ?? null,
      created_by_import: true,
    });
    push({
      entity_type: 'DESIGN_TEMPLATE',
      external_ref: t.ext_id,
      action: ta,
      target_id: tl?.target_id ?? null,
      title: t.title,
    });
  }
  return planned;
}
