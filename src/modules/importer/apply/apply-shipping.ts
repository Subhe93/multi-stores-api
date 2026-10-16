import {
  ImportEntityStatus,
  ImportItemPhase,
  ImportLogLevel,
} from '@prisma/client';
import { groupBy } from '../planner/state-loader';
import {
  shippingMethodStateHash,
  shippingProfileStateHash,
  shippingZoneStateHash,
} from '../mapping/state';
import type { PlanWork } from '../planner/planner';
import {
  appliedRefs,
  errorMessage,
  recordItems,
  upsertLedger,
  type ApplyContext,
  type ApplyItem,
} from './apply-context';

/**
 * Shipping phase (D26), one transaction per profile with its zones and
 * methods. The imported default profile becomes `is_default` only when the
 * creator has none. Zones/methods that left the source are kept.
 *
 * Multi-instance guard (fix 20): each profile transaction takes the
 * creator's `importer:shipping:<creatorId>` advisory lock, then re-reads the
 * ledger and the creator's default profile, so a run taken over by another
 * worker (or a second process) never creates the same profile twice nor a
 * second default.
 */
export async function applyShipping(
  ctx: ApplyContext,
  work: NonNullable<PlanWork['shipping']>,
  start: number,
  onBatch: (next: number) => Promise<void>,
): Promise<{ errors: number }> {
  let errors = 0;
  const zonesOf = groupBy(work.zones, (z) => z.profile_ref);
  const methodsOf = groupBy(work.methods, (m) => m.zone_ref);
  for (let i = start; i < work.profiles.length; i++) {
    await ctx.checkpoint();
    const prof = work.profiles[i];
    const done = await appliedRefs(ctx.prisma, ctx.runId, 'SHIPPING_PROFILE', [
      prof.mapped.ref,
    ]);
    if (done.size) {
      await onBatch(i + 1);
      continue;
    }
    const zones = zonesOf.get(prof.mapped.ref) ?? [];
    try {
      await ctx.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`importer:shipping:${ctx.creatorId}`}))`;
          const items: ApplyItem[] = [];
          let profileId = prof.target_id;
          let created = prof.action === 'CREATE';
          if (prof.action === 'CREATE') {
            const owned = await tx.importEntity.findUnique({
              where: {
                store_id_entity_type_external_ref: {
                  store_id: ctx.storeId,
                  entity_type: 'SHIPPING_PROFILE',
                  external_ref: prof.mapped.ref,
                },
              },
              select: { target_id: true, status: true },
            });
            const live =
              owned?.status === ImportEntityStatus.ACTIVE && owned.target_id
                ? await tx.shippingProfile.findUnique({
                    where: { id: owned.target_id },
                    select: { id: true },
                  })
                : null;
            if (live) {
              // Another worker already created it: adopt, never duplicate.
              profileId = live.id;
              created = false;
            } else {
              const hasDefault =
                (await tx.shippingProfile.count({
                  where: { creator_id: ctx.creatorId, is_default: true },
                })) > 0;
              const isDefault = prof.mapped.class_slug === null && !hasDefault;
              const row = await tx.shippingProfile.create({
                data: {
                  creator_id: ctx.creatorId,
                  name: prof.mapped.name,
                  is_default: isDefault,
                },
                select: { id: true },
              });
              profileId = row.id;
            }
          } else if (prof.action === 'UPDATE') {
            await tx.shippingProfile.update({
              where: { id: profileId! },
              data: { name: prof.mapped.name },
            });
          }
          if (prof.action === 'CREATE' || prof.action === 'UPDATE') {
            await upsertLedger(tx, ctx, {
              entity_type: 'SHIPPING_PROFILE',
              external_ref: prof.mapped.ref,
              target_id: profileId,
              source_hash: prof.source_hash,
              applied_hash: shippingProfileStateHash({
                name: prof.mapped.name,
              }),
              created,
            });
          }
          items.push({
            entity_type: 'SHIPPING_PROFILE',
            external_ref: prof.mapped.ref,
            action: prof.action,
            target_id: profileId,
          });

          for (const z of zones) {
            let zoneId = z.target_id;
            const { methods: _methods, ref: _ref, ...fields } = z.mapped;
            if (z.action === 'CREATE' && profileId) {
              const row = await tx.shippingZone.create({
                data: { ...fields, profile_id: profileId },
                select: { id: true },
              });
              zoneId = row.id;
            } else if (z.action === 'UPDATE' && zoneId) {
              await tx.shippingZone.update({
                where: { id: zoneId },
                data: fields,
              });
            }
            if (z.action === 'CREATE' || z.action === 'UPDATE') {
              await upsertLedger(tx, ctx, {
                entity_type: 'SHIPPING_ZONE',
                external_ref: z.mapped.ref,
                target_id: zoneId,
                source_hash: z.source_hash,
                applied_hash: shippingZoneStateHash(fields),
                created: z.action === 'CREATE',
              });
            }
            items.push({
              entity_type: 'SHIPPING_ZONE',
              external_ref: z.mapped.ref,
              action: z.action,
              target_id: zoneId,
            });

            for (const m of methodsOf.get(z.mapped.ref) ?? []) {
              let methodId = m.target_id;
              const { ref: _mref, ...mfields } = m.mapped;
              if (m.action === 'CREATE' && zoneId) {
                const row = await tx.shippingMethod.create({
                  data: { ...mfields, zone_id: zoneId },
                  select: { id: true },
                });
                methodId = row.id;
              } else if (m.action === 'UPDATE' && methodId) {
                await tx.shippingMethod.update({
                  where: { id: methodId },
                  data: mfields,
                });
              }
              if (m.action === 'CREATE' || m.action === 'UPDATE') {
                await upsertLedger(tx, ctx, {
                  entity_type: 'SHIPPING_METHOD',
                  external_ref: m.mapped.ref,
                  target_id: methodId,
                  source_hash: m.source_hash,
                  applied_hash: shippingMethodStateHash(mfields),
                  created: m.action === 'CREATE',
                });
              }
              items.push({
                entity_type: 'SHIPPING_METHOD',
                external_ref: m.mapped.ref,
                action: m.action,
                target_id: methodId,
              });
            }
          }
          await recordItems(tx, ctx.runId, ImportItemPhase.APPLY, items);
        },
        { timeout: 60_000 },
      );
    } catch (err) {
      errors++;
      await ctx.log(
        ImportLogLevel.ERROR,
        'IMPORT_SHIPPING_FAILED',
        errorMessage(err),
        {
          entity_type: 'SHIPPING_PROFILE',
          external_ref: prof.mapped.ref,
        },
      );
      await recordItems(ctx.prisma, ctx.runId, ImportItemPhase.APPLY, [
        {
          entity_type: 'SHIPPING_PROFILE',
          external_ref: prof.mapped.ref,
          action: 'ERROR',
          message: errorMessage(err),
        },
      ]);
    }
    await onBatch(i + 1);
  }
  return { errors };
}
