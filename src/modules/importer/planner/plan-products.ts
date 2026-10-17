import { ImportEntityStatus } from '@prisma/client';
import type { NProduct } from '../model/normalized';
import { hashOf } from '../mapping/hash';
import {
  collectionPositions,
  mapProduct,
  presetHelpRefs,
  productMediaRefs,
} from '../mapping/map-product';
import {
  mapShipping,
  type MappedShippingProfile,
} from '../mapping/map-shipping';
import { firstFreeSlug } from '../mapping/slug';
import { incompleteOf } from './target-snapshot';
import type { CategoryPlan } from './plan-categories';
import type { PlanContext } from './plan-context';
import {
  decide,
  fallbackRef,
  PRODUCT_INDEPENDENT_PRESETS,
  type PlanAction,
  type PlannedPreset,
  type PlannedProduct,
  type PlannedRemoval,
  type PlannedVariant,
} from './plan-types';

export interface ProductPlan {
  planned: PlannedProduct[];
  /** Source products planned (after the skip rules). */
  imported: NProduct[];
  /** Source products skipped by rule (skip list, drafts excluded). */
  skipped: NProduct[];
  removals: PlannedRemoval[];
  /** Mapped shipping profiles (empty when the shipping phase does not run). */
  shippingProfiles: MappedShippingProfile[];
  shippingOn: boolean;
}

/**
 * Products (D19–D28): skip rules, mapping, slug suffixing and SKU clearing
 * (D25), the ledger decision with the incomplete check (fix 1), the archived
 * guard (fix 12), variants, presets (D27, fix 9), NPP fallback fields (D28)
 * and `on_source_removed` removals (D6). Items are pushed in the same order
 * as before the split (products, then their children, then removals).
 */
export function planProducts(
  ctx: PlanContext,
  categories: CategoryPlan,
): ProductPlan {
  const { catalog, options, snapshot, sanitizer, scopes, now, warn, push } =
    ctx;
  const { collectionFor, byRef: plannedCatByRef } = categories;
  const skipSet = new Set(options.skip_ext_ids);
  const imported: NProduct[] = [];
  const skipped: NProduct[] = [];
  for (const p of catalog.products) {
    if (
      skipSet.has(p.ext_id) ||
      (!options.include_drafts && p.status !== 'publish')
    )
      skipped.push(p);
    else imported.push(p);
  }
  for (const p of skipped)
    if (scopes.products)
      push({
        entity_type: 'PRODUCT',
        external_ref: p.ext_id,
        action: 'SKIP',
        target_id: snapshot.productsByRef.get(p.ext_id)?.id ?? null,
        message: 'W_PRODUCT_SKIPPED_BY_RULE',
        title: p.title,
      });

  const mapped = imported.map((p) =>
    mapProduct(p, {
      catalog,
      options,
      sanitizer,
      now,
      warn,
      host_aliases: ctx.hostAliases,
    }),
  );
  const positions = collectionPositions(mapped);
  const shippingOn = scopes.shipping && !!catalog.shipping?.zones_available;
  const shippingProfiles = shippingOn
    ? mapShipping(
        catalog,
        new Set(
          mapped
            .map((m) => m.shipping_class_slug)
            .filter((s): s is string => !!s),
        ),
        options,
        warn,
      )
    : [];
  const profileRefByClass = new Map(
    shippingProfiles.map((p) => [p.class_slug ?? '', p.ref]),
  );

  const assignedSlugs = new Map<string, string>(); // slug → product ref
  const assignedSkus = new Set<string>();
  const plannedProducts: PlannedProduct[] = [];
  for (const m of mapped) {
    const existing = snapshot.productsByRef.get(m.ref);
    const ownId = existing?.id;
    // D25 slug suffixing against non-imported products and this plan.
    const { slug: finalSlug, suffixed } = firstFreeSlug(m.slug, (s) => {
      const owner = snapshot.productSlugs.get(s);
      if (owner && owner !== ownId) return true;
      const planned = assignedSlugs.get(s);
      return !!planned && planned !== m.ref;
    });
    assignedSlugs.set(finalSlug, m.ref);
    if (suffixed)
      warn({
        code: 'W_SLUG_CONFLICT_SUFFIXED',
        external_ref: m.ref,
        title: m.translation.title,
        message: `"${m.slug}" → "${finalSlug}"`,
      });
    // D25 SKU conflicts (ProductVariant.sku is unique on the platform).
    const variants = m.variants.map((v) => {
      if (!v.sku) return v;
      const owner = snapshot.skuOwners.get(v.sku);
      const ours =
        owner && owner.product_id === ownId && owner.external_ref === v.ref;
      if ((owner && !ours) || assignedSkus.has(v.sku)) {
        warn({
          code: 'W_SKU_CONFLICT_CLEARED',
          external_ref: v.ref,
          title: m.translation.title,
          message: `SKU "${v.sku}" is taken`,
        });
        return { ...v, sku: null };
      }
      assignedSkus.add(v.sku);
      return v;
    });
    const shippingProfileRef = shippingOn
      ? (profileRefByClass.get(m.shipping_class_slug ?? '') ??
        profileRefByClass.get('') ??
        null)
      : null;
    const pos: Record<string, number> = {};
    for (const c of m.category_refs) pos[c] = positions.get(c)?.get(m.ref) ?? 0;
    const hashInput = {
      ...m,
      variants,
      final_slug: finalSlug,
      positions: pos,
      platform_category_id: options.platform_category_id,
      shipping_profile_ref: shippingProfileRef,
      presets: undefined,
      broken_presets: undefined,
    };
    const hash = hashOf(hashInput);
    const ledger = ctx.ledger('PRODUCT', m.ref);
    // Fix 1: what the last apply could not resolve makes the product UPDATE.
    let incomplete = false;
    if (existing) {
      const before = incompleteOf(ledger);
      if (scopes.media) {
        if (before?.media?.length) incomplete = true;
        else
          incomplete = productMediaRefs(m).some(
            (i) => !snapshot.media.get(i.source_url)?.public,
          );
      }
      const linked = snapshot.productCategoryLinks.get(existing.id);
      for (const ref of m.category_refs) {
        const id = collectionFor(ref);
        if (id && (id === 'new' || !linked?.has(id))) incomplete = true;
      }
    }
    for (const ref of m.category_refs)
      if (
        plannedCatByRef.get(ref)?.action === 'CONFLICT' &&
        !collectionFor(ref)
      )
        warn({
          code: 'W_PRODUCT_CATEGORY_CONFLICT',
          external_ref: m.ref,
          title: m.translation.title,
          message: `not linked to ${ref} (collection slug conflict)`,
        });
    const d = decide(
      ledger,
      existing
        ? { id: existing.id, state_hash: existing.state_hash }
        : undefined,
      hash,
      options.conflict_policy,
      { incomplete },
    );
    let action = d.action;
    let message = d.message ?? null;
    // Fix 12: an archived product is not republished unless OVERWRITE.
    if (
      existing?.status === 'ARCHIVED' &&
      (action === 'UPDATE' || action === 'SKIP')
    ) {
      if (options.conflict_policy !== 'OVERWRITE') {
        action = 'SKIP';
        message = 'W_PRODUCT_ARCHIVED_SKIPPED';
      } else if (m.status === 'PUBLISHED') {
        warn({
          code: 'W_ARCHIVED_PRODUCT_REPUBLISHED',
          external_ref: m.ref,
          title: m.translation.title,
          message: 'archived on the platform; published again (OVERWRITE)',
        });
      }
    }
    if (message)
      warn({
        code: message,
        external_ref: m.ref,
        title: m.translation.title,
        message:
          message === 'W_PRODUCT_ARCHIVED_SKIPPED'
            ? 'archived on the platform; not updated'
            : 'product edited on the platform; not updated',
      });

    // Variants (matched by external_ref; disappeared ones deactivated).
    const current = existing
      ? (snapshot.variantsByProduct.get(existing.id) ?? [])
      : [];
    const currentByRef = new Map(
      current.filter((v) => v.external_ref).map((v) => [v.external_ref!, v]),
    );
    const plannedVariants: PlannedVariant[] = variants.map((v) => {
      const vh = hashOf(v);
      const cur = currentByRef.get(v.ref);
      let va: PlanAction;
      if (action === 'CREATE' || !cur)
        va = action === 'UNCHANGED' || action === 'SKIP' ? action : 'CREATE';
      else if (action === 'UNCHANGED' || action === 'SKIP') va = action;
      else {
        const vl = ctx.ledger('VARIANT', v.ref);
        va =
          vl && vl.status === ImportEntityStatus.ACTIVE && vl.source_hash === vh
            ? 'UNCHANGED'
            : 'UPDATE';
      }
      return {
        mapped: v,
        action: va,
        target_id: action === 'CREATE' ? null : (cur?.id ?? null),
        source_hash: vh,
        created_by_import: cur
          ? (ctx.ledger('VARIANT', v.ref)?.created_by_import ?? false)
          : true,
      };
    });
    const sourceRefs = new Set(variants.map((v) => v.ref));
    const deactivate =
      action === 'UPDATE'
        ? current
            .filter(
              (v) =>
                v.external_ref &&
                !sourceRefs.has(v.external_ref) &&
                v.is_active,
            )
            .map((v) => ({ id: v.id, external_ref: v.external_ref! }))
        : [];

    // Presets (M4.1 port, D27).
    const presets: PlannedPreset[] = [];
    if (scopes.personalization) {
      for (const desc of m.presets) {
        const help = presetHelpRefs(m, desc.source_ref).map(
          (i) => i.source_url,
        );
        const ph = hashOf(
          help.length
            ? { key: desc.key, params: desc.params, help }
            : { key: desc.key, params: desc.params },
        );
        const pl = ctx.ledger('PERSONALIZATION', desc.source_ref);
        let pa: PlanAction;
        let mode: PlannedPreset['mode'] = 'skip_if_exists';
        if (!snapshot.personalizationAvailable) {
          pa =
            pl &&
            pl.status === ImportEntityStatus.STAGED &&
            pl.source_hash === ph
              ? 'UNCHANGED'
              : 'STAGE';
        } else if (action === 'SKIP') {
          // Fix 9: a staged / never-applied preset that only adds its own
          // fields goes on even when the merchant edited the product.
          pa =
            PRODUCT_INDEPENDENT_PRESETS.has(desc.key) &&
            !!existing &&
            (!pl || pl.status !== ImportEntityStatus.ACTIVE)
              ? 'CREATE'
              : 'SKIP';
        } else if (
          action === 'CREATE' ||
          !pl ||
          pl.status !== ImportEntityStatus.ACTIVE
        )
          pa = 'CREATE';
        else if (pl.source_hash === ph) pa = 'UNCHANGED';
        else {
          pa = 'UPDATE';
          mode = 'replace_preset';
        }
        presets.push({ descriptor: desc, action: pa, source_hash: ph, mode });
      }
    }
    for (const b of m.broken_presets)
      warn({
        code: 'W_PERSONALIZATION_BROKEN_CONFIG',
        external_ref: b.source_ref,
        title: m.translation.title,
        message: `${b.detector}: ${b.reason}`,
      });

    // NPP fallback fields (D28). Written even when the designer port is
    // available: imported designer links are created disabled, so without
    // these fields the product would collect no personalization at all until
    // the merchant publishes a template and enables the link (which removes
    // the `npp_fallback` fields in the same transaction).
    let fallback: PlannedProduct['fallback'] = null;
    if (m.npp && options.designer_fallback_fields) {
      const ref = fallbackRef(m.ref);
      const fl = ctx.ledger('FALLBACK_FIELD', ref);
      let fa: PlanAction;
      if (action === 'SKIP') fa = 'SKIP';
      else if (
        action === 'CREATE' ||
        !fl ||
        fl.status !== ImportEntityStatus.ACTIVE
      )
        fa = 'CREATE';
      else fa = 'UNCHANGED';
      fallback = { ref, action: fa };
    }

    plannedProducts.push({
      mapped: m,
      final_slug:
        action === 'SKIP' || action === 'UNCHANGED'
          ? (existing?.slug ?? finalSlug)
          : finalSlug,
      action,
      target_id: existing?.id ?? null,
      source_hash: hash,
      created_by_import: existing ? (ledger?.created_by_import ?? false) : true,
      variants: plannedVariants,
      deactivate,
      presets,
      fallback,
      positions: pos,
      shipping_profile_ref: shippingProfileRef,
      skip_reason: action === 'SKIP' ? message : null,
      current_status: existing?.status ?? null,
    });
  }

  const removals: PlannedRemoval[] = [];
  if (scopes.products) {
    for (const p of plannedProducts) {
      const title = p.mapped.translation.title;
      push({
        entity_type: 'PRODUCT',
        external_ref: p.mapped.ref,
        action: p.action,
        target_id: p.target_id,
        message: p.skip_reason,
        title,
      });
      for (const v of p.variants)
        push({
          entity_type: 'VARIANT',
          external_ref: v.mapped.ref,
          action: v.action,
          target_id: v.target_id,
          title: `${title} — ${Object.values(v.mapped.options).join(' / ')}`,
        });
      for (const v of p.deactivate)
        push({
          entity_type: 'VARIANT',
          external_ref: v.external_ref,
          action: 'UPDATE',
          target_id: v.id,
          message: 'deactivated (removed from the source)',
        });
      for (const pr of p.presets)
        push({
          entity_type: 'PERSONALIZATION',
          external_ref: pr.descriptor.source_ref,
          action: pr.action,
          target_id: p.target_id,
          title: `${title} — ${pr.descriptor.key}`,
        });
      for (const b of p.mapped.broken_presets)
        push({
          entity_type: 'PERSONALIZATION',
          external_ref: b.source_ref,
          action: 'SKIP',
          target_id: p.target_id,
          message: 'W_PERSONALIZATION_BROKEN_CONFIG',
        });
      if (p.fallback)
        push({
          entity_type: 'FALLBACK_FIELD',
          external_ref: p.fallback.ref,
          action: p.fallback.action,
          target_id: p.target_id,
          title,
        });
    }
    // Products imported earlier that left the source (D6 on_source_removed).
    if (options.on_source_removed !== 'keep') {
      const inSource = new Set(catalog.products.map((p) => p.ext_id));
      const to = options.on_source_removed === 'draft' ? 'DRAFT' : 'ARCHIVED';
      for (const row of snapshot.ledger.values()) {
        if (
          row.entity_type !== 'PRODUCT' ||
          row.status !== ImportEntityStatus.ACTIVE
        )
          continue;
        if (inSource.has(row.external_ref)) continue;
        const cur = snapshot.productsByRef.get(row.external_ref);
        if (!cur || cur.status === to) continue;
        removals.push({
          ref: row.external_ref,
          target_id: cur.id,
          to_status: to,
        });
        push({
          entity_type: 'PRODUCT',
          external_ref: row.external_ref,
          action: 'UPDATE',
          target_id: cur.id,
          message: `source removed → ${to}`,
        });
      }
    }
  }

  return {
    planned: plannedProducts,
    imported,
    skipped,
    removals,
    shippingProfiles,
    shippingOn,
  };
}
