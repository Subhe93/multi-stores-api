import { hashOf } from '../mapping/hash';
import { firstFreeSlug } from '../mapping/slug';
import { mapTags } from '../mapping/map-tag';
import type { CategoryPlan } from './plan-categories';
import type { PlanContext } from './plan-context';
import { decide, type PlannedTag } from './plan-types';

/** Result of the tags planner, consumed by the product planner. */
export interface TagPlan {
  planned: PlannedTag[];
  byRef: Map<string, PlannedTag>;
  /** An INTERNAL row that is (or will be) on the platform for this ref ('new' = created now). */
  tagFor: (ref: string) => string | null;
}

/**
 * WooCommerce `product_tag` terms → INTERNAL `CreatorCategory` rows (tags
 * rename, 2026-11-02). Same ledger decision as collections (CREATE / UPDATE /
 * UNCHANGED / SKIP, D6), keyed by `woo:<host>:product_tag:<id>` with the
 * `TAG` entity type. Slugs share the creator's collection slug space, so a
 * taken slug gets the WP `-2`, `-3` suffix in the plan (PLAN == APPLY). An
 * existing INTERNAL row without `external_ref` and with the same slug is
 * adopted when `match_existing.categories = 'slug'` (D25), like
 * collections. Tags ride on the products scope: without it nothing is
 * planned.
 */
export function planTags(ctx: PlanContext, categories: CategoryPlan): TagPlan {
  const { catalog, options, snapshot, scopes, warn, push } = ctx;
  const planned: PlannedTag[] = [];
  const byRef = new Map<string, PlannedTag>();
  if (!scopes.products) {
    return { planned, byRef, tagFor: () => null };
  }
  const plannedCategorySlugs = new Set(categories.categorySlug.values());
  /** Slugs this plan writes for tags → tag ref. */
  const assignedTagSlugs = new Map<string, string>();
  const slugTaken = (slug: string, ownId: string | null, ref: string) => {
    const owner = snapshot.categoriesBySlug.get(slug);
    if (owner && owner.id !== ownId) return true;
    if (plannedCategorySlugs.has(slug)) return true;
    const other = assignedTagSlugs.get(slug);
    return !!other && other !== ref;
  };

  for (const m of mapTags(catalog)) {
    const live = snapshot.categoriesByRef.get(m.ref);
    const adoptable =
      !live &&
      options.match_existing.categories === 'slug' &&
      snapshot.categoriesBySlug.get(m.slug)?.external_ref == null &&
      snapshot.categoriesBySlug.get(m.slug)?.visibility === 'INTERNAL'
        ? snapshot.categoriesBySlug.get(m.slug)!
        : null;
    const target = live ?? adoptable;
    const ownId = target?.id ?? null;
    // The slug the row will carry: a taken slug is suffixed deterministically.
    const { slug: finalSlug, suffixed } = firstFreeSlug(m.slug, (s) =>
      slugTaken(s, ownId, m.ref),
    );
    const hash = hashOf({ ...m, final_slug: finalSlug });
    const ledger = ctx.ledger('TAG', m.ref);
    let item: PlannedTag;
    if (live) {
      const d = decide(ledger, live, hash, options.conflict_policy);
      item = {
        mapped: m,
        final_slug: d.action === 'UPDATE' ? finalSlug : live.slug,
        action: d.action,
        target_id: live.id,
        source_hash: hash,
        created_by_import: ledger?.created_by_import ?? false,
        adopt: false,
      };
      if (d.message)
        warn({
          code: d.message,
          external_ref: m.ref,
          title: m.name,
          message: 'tag edited on the platform; not updated',
        });
    } else if (adoptable) {
      item = {
        mapped: m,
        final_slug: finalSlug,
        action: 'UPDATE',
        target_id: adoptable.id,
        source_hash: hash,
        created_by_import: false,
        adopt: true,
      };
    } else {
      item = {
        mapped: m,
        final_slug: finalSlug,
        action: 'CREATE',
        target_id: null,
        source_hash: hash,
        created_by_import: true,
        adopt: false,
      };
    }
    if (suffixed && (item.action === 'CREATE' || item.action === 'UPDATE'))
      warn({
        code: 'W_TAG_SLUG_SUFFIXED',
        external_ref: m.ref,
        title: m.name,
        message: `"${m.slug}" → "${finalSlug}"`,
      });
    if (item.action === 'CREATE' || item.action === 'UPDATE')
      assignedTagSlugs.set(item.final_slug, m.ref);
    planned.push(item);
    byRef.set(m.ref, item);
    push({
      entity_type: 'TAG',
      external_ref: m.ref,
      action: item.action,
      target_id: item.target_id,
      message: item.adopt ? 'adopted' : null,
      title: m.name,
    });
  }

  const tagFor = (ref: string): string | null => {
    const live = snapshot.categoriesByRef.get(ref);
    if (live) return live.id;
    const pt = byRef.get(ref);
    if (!pt) return null;
    if (pt.action === 'CREATE') return 'new';
    if (pt.adopt && pt.target_id) return pt.target_id;
    return null;
  };
  return { planned, byRef, tagFor };
}
