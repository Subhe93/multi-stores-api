import { ImportEntityStatus } from '@prisma/client';
import { hashOf } from '../mapping/hash';
import type { MappedShippingProfile } from '../mapping/map-shipping';
import type { PlanContext } from './plan-context';
import { decide, type PlanWork } from './plan-types';

/**
 * Shipping (D26): profiles, zones and methods against the ledger. The
 * profiles were mapped by the products planner (products need their profile
 * ref); this step only decides the actions and pushes the items.
 */
export function planShipping(
  ctx: PlanContext,
  shippingProfiles: MappedShippingProfile[],
): NonNullable<PlanWork['shipping']> {
  const { options, snapshot, push } = ctx;
  const work: NonNullable<PlanWork['shipping']> = {
    profiles: [],
    zones: [],
    methods: [],
  };
  const plan = <T>(type: string, ref: string, mappedValue: T, hash: string) => {
    const ledger = ctx.ledger(type, ref);
    const targetId =
      ledger?.status === ImportEntityStatus.ACTIVE ? ledger.target_id : null;
    const state = targetId ? snapshot.shippingStates.get(targetId) : undefined;
    const d = decide(
      ledger,
      targetId && state ? { id: targetId, state_hash: state } : undefined,
      hash,
      options.conflict_policy,
    );
    return {
      action: d.action,
      target_id: d.action === 'CREATE' ? null : targetId,
      source_hash: hash,
      created_by_import: ledger?.created_by_import ?? true,
      mapped: mappedValue,
    };
  };
  for (const prof of shippingProfiles) {
    const pp = plan(
      'SHIPPING_PROFILE',
      prof.ref,
      prof,
      hashOf({ name: prof.name }),
    );
    work.profiles.push(pp);
    push({
      entity_type: 'SHIPPING_PROFILE',
      external_ref: prof.ref,
      action: pp.action,
      target_id: pp.target_id,
      title: prof.name,
    });
    for (const z of prof.zones) {
      const { methods: _m, ...zoneFields } = z;
      const zp = {
        ...plan('SHIPPING_ZONE', z.ref, z, hashOf(zoneFields)),
        profile_ref: prof.ref,
      };
      work.zones.push(zp);
      push({
        entity_type: 'SHIPPING_ZONE',
        external_ref: z.ref,
        action: zp.action,
        target_id: zp.target_id,
        title: `${prof.name} — ${z.name}`,
      });
      for (const meth of z.methods) {
        const mp = {
          ...plan('SHIPPING_METHOD', meth.ref, meth, hashOf(meth)),
          zone_ref: z.ref,
        };
        work.methods.push(mp);
        push({
          entity_type: 'SHIPPING_METHOD',
          external_ref: meth.ref,
          action: mp.action,
          target_id: mp.target_id,
          title: `${z.name} — ${meth.name}`,
        });
      }
    }
  }
  return work;
}
