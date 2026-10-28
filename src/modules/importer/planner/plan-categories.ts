import { hashOf } from '../mapping/hash';
import { mapCategories } from '../mapping/map-category';
import type { PlanContext } from './plan-context';
import { decide, type PlannedCategory } from './plan-types';

/** Result of the categories planner, consumed by the product/media/redirect planners. */
export interface CategoryPlan {
  planned: PlannedCategory[];
  /** Category ref → slug that will be live after the run (CREATE/UPDATE/adopt/kept). */
  categorySlug: Map<string, string>;
  byRef: Map<string, PlannedCategory>;
  /** A collection that is (or will be) on the platform for this ref ('new' = created now). */
  collectionFor: (ref: string) => string | null;
}

/** Categories (D24, D25, U7): slug adoption, slug conflicts, parent conflicts (fix 18). */
export function planCategories(ctx: PlanContext): CategoryPlan {
  const { catalog, options, snapshot, sanitizer, scopes, warn, push } = ctx;
  const mappedCategories = mapCategories(catalog, sanitizer);
  const categorySlug = new Map<string, string>();
  const plannedCategories: PlannedCategory[] = [];
  /** Slugs this plan writes (CREATE / UPDATE / adopt) → category ref. */
  const assignedCatSlugs = new Map<string, string>();
  const catSlugTaken = (slug: string, ownId: string | null, ref: string) => {
    const owner = snapshot.categoriesBySlug.get(slug);
    if (owner && owner.id !== ownId) return true;
    const planned = assignedCatSlugs.get(slug);
    return !!planned && planned !== ref;
  };
  for (const m of mappedCategories) {
    const hash = hashOf(m);
    const ledger = ctx.ledger('CATEGORY', m.ref);
    const byRef = snapshot.categoriesByRef.get(m.ref);
    let planned: PlannedCategory;
    if (byRef) {
      const thumbMissing =
        scopes.media &&
        !!m.thumbnail &&
        !snapshot.media.get(m.thumbnail.url)?.public;
      const d = decide(ledger, byRef, hash, options.conflict_policy, {
        incomplete: thumbMissing,
      });
      let action = d.action;
      // Namez Phase 1: a live INTERNAL label (a converted occasion page) is
      // never rewritten, whatever the conflict policy: an UPDATE would give
      // it back its parent and make it PUBLIC again.
      if (byRef.visibility === 'INTERNAL' && action !== 'UNCHANGED') {
        action = 'SKIP';
        // One warning per row: the "edited on the platform" message of
        // decide() is implied by the label's state.
        d.message = undefined;
        warn({
          code: 'W_CATEGORY_INTERNAL_SKIPPED',
          external_ref: m.ref,
          title: m.name,
          message:
            'collection is an internal label on the platform; not updated',
        });
      }
      // Fix 3: the UPDATE writes `m.slug`; it must be free like on CREATE.
      if (
        action === 'UPDATE' &&
        m.slug !== byRef.slug &&
        catSlugTaken(m.slug, byRef.id, m.ref)
      ) {
        action = 'CONFLICT';
        warn({
          code: 'W_CATEGORY_SLUG_CONFLICT',
          external_ref: m.ref,
          title: m.name,
          message: `collection slug "${m.slug}" is taken; "${byRef.slug}" kept`,
        });
      }
      planned = {
        mapped: m,
        action,
        target_id: byRef.id,
        source_hash: hash,
        created_by_import: ledger?.created_by_import ?? false,
        adopt: false,
      };
      if (d.message)
        warn({
          code: d.message,
          external_ref: m.ref,
          title: m.name,
          message: 'collection edited on the platform; not updated',
        });
      // UPDATE writes the new slug; every other action leaves the live one.
      const slug =
        action === 'UPDATE' && scopes.categories ? m.slug : byRef.slug;
      if (action === 'UPDATE') assignedCatSlugs.set(m.slug, m.ref);
      categorySlug.set(m.ref, slug);
    } else {
      const bySlug = snapshot.categoriesBySlug.get(m.slug);
      const plannedOwner = assignedCatSlugs.get(m.slug);
      if (plannedOwner && plannedOwner !== m.ref) {
        planned = {
          mapped: m,
          action: 'CONFLICT',
          target_id: null,
          source_hash: hash,
          created_by_import: false,
          adopt: false,
        };
        warn({
          code: 'W_CATEGORY_SLUG_CONFLICT',
          external_ref: m.ref,
          title: m.name,
          message: `collection slug "${m.slug}" is used by another imported collection`,
        });
      } else if (
        bySlug &&
        !bySlug.external_ref &&
        options.match_existing.categories === 'slug'
      ) {
        planned = {
          mapped: m,
          action: 'UPDATE',
          target_id: bySlug.id,
          source_hash: hash,
          created_by_import: false,
          adopt: true,
        };
        assignedCatSlugs.set(m.slug, m.ref);
        // Fix 13: without the categories scope nothing is written or adopted.
        if (scopes.categories) categorySlug.set(m.ref, m.slug);
      } else if (bySlug) {
        planned = {
          mapped: m,
          action: 'CONFLICT',
          target_id: bySlug.id,
          source_hash: hash,
          created_by_import: false,
          adopt: false,
        };
        warn({
          code: 'W_CATEGORY_SLUG_CONFLICT',
          external_ref: m.ref,
          title: m.name,
          message: `collection slug "${m.slug}" is taken`,
        });
      } else {
        planned = {
          mapped: m,
          action: 'CREATE',
          target_id: null,
          source_hash: hash,
          created_by_import: true,
          adopt: false,
        };
        assignedCatSlugs.set(m.slug, m.ref);
        if (scopes.categories) categorySlug.set(m.ref, m.slug);
      }
    }
    // A category whose live parent is an INTERNAL label cannot be written:
    // an internal label never has children (Namez Phase 1).
    if (
      (planned.action === 'CREATE' || planned.action === 'UPDATE') &&
      m.parent_ref &&
      snapshot.categoriesByRef.get(m.parent_ref)?.visibility === 'INTERNAL'
    ) {
      planned = { ...planned, action: 'CONFLICT', adopt: false };
      warn({
        code: 'W_CATEGORY_PARENT_INTERNAL',
        external_ref: m.ref,
        title: m.name,
        message: `parent ${m.parent_ref} is an internal label on the platform; not imported`,
      });
    }
    plannedCategories.push(planned);
    if (scopes.categories)
      push({
        entity_type: 'CATEGORY',
        external_ref: m.ref,
        action: planned.action,
        target_id: planned.target_id,
        message: planned.adopt
          ? 'adopted'
          : planned.action === 'CONFLICT'
            ? 'slug taken'
            : null,
        title: m.name,
      });
  }

  // Fix 18: collections that lose their parent / products that lose a link.
  const byRef = new Map(plannedCategories.map((c) => [c.mapped.ref, c]));
  const collectionFor = (ref: string): string | null => {
    const live = snapshot.categoriesByRef.get(ref);
    if (live) return live.id;
    const pc = byRef.get(ref);
    if (!pc || !scopes.categories) return null;
    if (pc.action === 'CREATE') return 'new';
    if (pc.adopt && pc.target_id) return pc.target_id;
    return null;
  };
  if (scopes.categories)
    for (const c of plannedCategories) {
      const parent = c.mapped.parent_ref;
      if (!parent || c.action === 'CONFLICT') continue;
      if (byRef.get(parent)?.action === 'CONFLICT' && !collectionFor(parent))
        warn({
          code: 'W_CATEGORY_PARENT_CONFLICT',
          external_ref: c.mapped.ref,
          title: c.mapped.name,
          message: `parent ${parent} was not imported (slug conflict); placed at the top level`,
        });
    }

  return { planned: plannedCategories, categorySlug, byRef, collectionFor };
}
