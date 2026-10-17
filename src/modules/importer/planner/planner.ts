import { ImportEntityStatus } from '@prisma/client';
import { normalizeRedirectPath } from '../../redirects/redirect-path.util';
import { capRedirectCreates } from '../../redirects/redirects.service';
import {
  planRedirectDeactivations,
  planRedirectUpserts,
  withoutDeactivated,
  type IncomingRedirect,
  type RedirectDeactivation,
  type RedirectUpsertPlan,
} from '../../redirects/redirect-plan';
import {
  summarizeCatalog,
  type DryRunSummary,
  type SummaryAction,
  type SummaryEntityType,
} from '../model/dry-run-summary';
import type {
  NormalizedCatalog,
  NProduct,
  NTemplate,
} from '../model/normalized';
import type { PresetDescriptor } from '../model/presets';
import { hashOf } from '../mapping/hash';
import { mapCategories, type MappedCategory } from '../mapping/map-category';
import {
  collectionPositions,
  mapProduct,
  mediaRefOf,
  presetHelpRefs,
  productMediaRefs,
  type MapWarning,
  type MappedImage,
  type MappedProduct,
  type MappedVariant,
} from '../mapping/map-product';
import { buildImportRedirects } from '../mapping/map-redirects';
import {
  mapShipping,
  type MappedShippingMethod,
  type MappedShippingProfile,
  type MappedShippingZone,
} from '../mapping/map-shipping';
import { firstFreeSlug } from '../mapping/slug';
import type { ImportRunOptions } from '../runs/run-options';
import type { ImporterHtmlSanitizer } from '../html/html-sanitizer';
import { W_HTML_SANITIZER_FALLBACK } from '../html/html-sanitizer';
import type { MediaNeed, MediaTarget } from '../media/media-importer';
import {
  incompleteOf,
  ledgerKey,
  type LedgerRow,
  type TargetSnapshot,
} from './target-snapshot';

/**
 * The importer's pure planner (M4.4 D5): `plan(catalog, options, snapshot)`
 * → items with CREATE / UPDATE / UNCHANGED / SKIP / CONFLICT / STAGE. The dry
 * run stores these items (phase PLAN); the apply step recomputes the plan
 * and executes the same items (phase APPLY), so PLAN == APPLY. A changed
 * fingerprint between dry run and confirm → 409 IMPORT_PLAN_STALE.
 */

export type PlanAction = Exclude<SummaryAction, never>;
export type PlanEntityType = SummaryEntityType;

export interface PlanItem {
  entity_type: PlanEntityType;
  external_ref: string;
  action: PlanAction;
  target_id: string | null;
  message?: string | null;
  /** Human label for the report (product / collection / template title). */
  title?: string | null;
}

interface Planned {
  action: PlanAction;
  target_id: string | null;
  source_hash: string;
  created_by_import: boolean;
}

export interface PlannedCategory extends Planned {
  mapped: MappedCategory;
  /** Adopt an existing collection of the same slug (D25). */
  adopt: boolean;
}

export interface PlannedVariant extends Planned {
  mapped: MappedVariant;
}

export interface PlannedPreset {
  descriptor: PresetDescriptor;
  action: PlanAction;
  source_hash: string;
  mode: 'skip_if_exists' | 'replace_preset';
}

export interface PlannedProduct extends Planned {
  mapped: MappedProduct;
  final_slug: string;
  /** Planned variants (a SKU taken elsewhere is already cleared, D25). */
  variants: PlannedVariant[];
  /** Variants that disappeared from the source: deactivated, never deleted (D6). */
  deactivate: { id: string; external_ref: string }[];
  presets: PlannedPreset[];
  fallback: { ref: string; action: PlanAction } | null;
  /** Category ref → position in that collection (D24). */
  positions: Record<string, number>;
  /** Shipping profile ref, when the shipping phase runs. */
  shipping_profile_ref: string | null;
  /** Warning code of a SKIP (merchant edit, untracked, archived). */
  skip_reason: string | null;
  /** Live status of an existing product (null for CREATE). */
  current_status: string | null;
}

export interface PlannedRemoval {
  ref: string;
  target_id: string;
  to_status: 'DRAFT' | 'ARCHIVED';
}

export interface PlannedShippingProfile extends Planned {
  mapped: MappedShippingProfile;
}
export interface PlannedShippingZone extends Planned {
  mapped: MappedShippingZone;
  profile_ref: string;
}
export interface PlannedShippingMethod extends Planned {
  mapped: MappedShippingMethod;
  zone_ref: string;
}

export interface PlannedTemplate extends Planned {
  template: NTemplate;
}

export interface PlannedMedia extends MediaNeed {
  action: 'CREATE' | 'UNCHANGED';
}

/**
 * Presets that only add the importer's own fields and read nothing the
 * merchant may have edited on the product (no option references): they are
 * applied even to SKIP (merchant-edited) products (fix 9).
 */
export const PRODUCT_INDEPENDENT_PRESETS: ReadonlySet<string> = new Set([
  'names_equal_length',
  'single_name',
  'checkbox_group',
]);

export interface PlanWork {
  categories: PlannedCategory[];
  products: PlannedProduct[];
  /** Products skipped by rule (skip list, drafts excluded): SKIP items only. */
  skipped: { ref: string; target_id: string | null; title: string }[];
  removals: PlannedRemoval[];
  shipping: {
    profiles: PlannedShippingProfile[];
    zones: PlannedShippingZone[];
    methods: PlannedShippingMethod[];
  } | null;
  templates: PlannedTemplate[];
  media: PlannedMedia[];
  /**
   * Every media source URL the written entities reference, whether or not
   * the media scope is on (fix 2): the apply step resolves them all from the
   * `ImportMedia` ledger, so media stored by earlier runs are never wiped.
   */
  media_urls: string[];
  redirects: {
    incoming: IncomingRedirect[];
    /** Source entity (product/category/tag ref) of each `incoming` row, same index. */
    incoming_refs: string[];
    plan: RedirectUpsertPlan;
    live_conflicts: { from_path: string; to_path: string }[];
    /** Active IMPORT rows that would shadow a live page: switched off. */
    deactivate: RedirectDeactivation[];
    /** Normalised live product/collection paths (apply recomputes `deactivate` from them). */
    live_paths: string[];
  } | null;
}

export interface PlanBlocker {
  code: 'IMPORT_CURRENCY_MISMATCH' | 'IMPORT_PLATFORM_CATEGORY_REQUIRED';
  message: string;
}

export interface ImportRunSummary extends DryRunSummary {
  plan: {
    items: number;
    blockers: PlanBlocker[];
    sanitizer: ImporterHtmlSanitizer['mode'];
    personalization_available: boolean;
    designer_available: boolean;
  };
}

export interface ImportPlan {
  items: PlanItem[];
  work: PlanWork;
  summary: ImportRunSummary;
  fingerprint: string;
  blockers: PlanBlocker[];
}

export interface PlanInput {
  catalog: NormalizedCatalog;
  /** Hash of the catalog snapshot (ImportRun.catalog_hash). */
  catalogHash: string;
  options: ImportRunOptions;
  snapshot: TargetSnapshot;
  sanitizer: ImporterHtmlSanitizer;
  now: Date;
  hostAliases?: string[];
}

const NPP_FALLBACK_SUFFIX = '#npp_fallback';

/**
 * Paths the storefront proxy (`multi-stores-web/src/proxy.ts`) hands to
 * Next.js before any redirect lookup: a redirect from one of them is written
 * but can never fire (W_REDIRECT_UNREACHABLE).
 */
const PROXY_RESERVED_PREFIXES = ['/_next/', '/api/', '/builder-preview/'];
const PROXY_RESERVED_PATHS = new Set([
  '/_next',
  '/api',
  '/builder-preview',
  '/sitemap.xml',
  '/robots.txt',
]);

export function isProxyReservedPath(normalizedFrom: string): boolean {
  return (
    PROXY_RESERVED_PATHS.has(normalizedFrom) ||
    PROXY_RESERVED_PREFIXES.some((p) => normalizedFrom.startsWith(p))
  );
}

export function fallbackRef(productRef: string): string {
  return `${productRef}${NPP_FALLBACK_SUFFIX}`;
}

/** Plan fingerprint (D5): catalog, options and every (type, ref, action, target). */
export function planFingerprint(
  catalogHash: string,
  options: ImportRunOptions,
  items: PlanItem[],
  work?: PlanWork,
): string {
  const tuples = items
    .map(
      (i) =>
        `${i.entity_type}|${i.external_ref}|${i.action}|${i.target_id ?? ''}`,
    )
    .sort();
  // What would be written also counts (final slugs, SKU clearing, redirect targets).
  const written = work
    ? {
        products: work.products.map((p) => [p.mapped.ref, p.source_hash]),
        categories: work.categories.map((c) => [c.mapped.ref, c.source_hash]),
        redirects:
          work.redirects?.plan.items.map((r) => [r.from_path, r.to_path]) ?? [],
        redirects_off: work.redirects?.deactivate.map((r) => r.id) ?? [],
      }
    : null;
  return hashOf({ catalogHash, options, tuples, written });
}

/**
 * Ledger + live-target decision shared by every entity type (D6).
 * - `incomplete` (fix 1): an entity the last run could not finish (missing
 *   media / collection links) is never UNCHANGED, whatever the policy.
 * - fix 12: a target found by ref whose ledger is not ACTIVE (rolled back,
 *   missing, other target) still gets the merchant-edit check; without an
 *   `applied_hash` there is nothing to compare, so it counts as edited.
 */
export function decide(
  ledger: LedgerRow | undefined,
  target: { id: string; state_hash: string } | undefined,
  sourceHash: string,
  policy: ImportRunOptions['conflict_policy'],
  opts: { incomplete?: boolean } = {},
): { action: PlanAction; message?: string } {
  if (!target) return { action: 'CREATE' };
  const tracked = !!ledger && ledger.target_id === target.id;
  const active = tracked && ledger.status === ImportEntityStatus.ACTIVE;
  if (active && ledger.source_hash === sourceHash && !opts.incomplete)
    return { action: 'UNCHANGED' };
  if (policy === 'SKIP_MODIFIED') {
    if (active) {
      if (ledger.applied_hash && ledger.applied_hash !== target.state_hash)
        return { action: 'SKIP', message: 'W_TARGET_MODIFIED_SKIPPED' };
    } else if (!tracked || !ledger.applied_hash) {
      return { action: 'SKIP', message: 'W_TARGET_UNTRACKED_SKIPPED' };
    } else if (ledger.applied_hash !== target.state_hash) {
      return { action: 'SKIP', message: 'W_TARGET_MODIFIED_SKIPPED' };
    }
  }
  return { action: 'UPDATE' };
}

export function planImport(input: PlanInput): ImportPlan {
  const { catalog, options, snapshot, sanitizer, now } = input;
  const scopes = options.scopes;
  const items: PlanItem[] = [];
  const mapWarnings: MapWarning[] = [];
  const warn = (w: MapWarning) => mapWarnings.push(w);
  const L = (type: string, ref: string) =>
    snapshot.ledger.get(ledgerKey(type, ref));
  const push = (i: PlanItem) => items.push(i);

  // ── Blockers and store-level checks (D18, D23) ───────────────────────────
  const blockers: PlanBlocker[] = [];
  const srcCurrency = catalog.meta.currency?.toUpperCase() ?? null;
  if (srcCurrency && srcCurrency !== snapshot.currency.toUpperCase()) {
    blockers.push({
      code: 'IMPORT_CURRENCY_MISMATCH',
      message: `Source prices are in ${srcCurrency}, the store sells in ${snapshot.currency}`,
    });
  }
  if (scopes.products && !snapshot.platformCategoryExists) {
    blockers.push({
      code: 'IMPORT_PLATFORM_CATEGORY_REQUIRED',
      message: 'Choose the platform category for imported products',
    });
  }
  const storeWarn = (code: string, message: string) =>
    warn({
      code,
      external_ref: `woo:${catalog.meta.site_host}:store`,
      title: 'store',
      message,
    });
  if (catalog.meta.prices_include_tax !== null) {
    const inclusive = snapshot.taxPricingMode === 'INCLUSIVE';
    if (catalog.meta.prices_include_tax !== inclusive)
      storeWarn(
        'W_TAX_MODE_MISMATCH',
        `source prices ${catalog.meta.prices_include_tax ? 'include' : 'exclude'} tax, the store is ${snapshot.taxPricingMode}`,
      );
  }
  if (catalog.meta.locale) {
    const srcLang = catalog.meta.locale.toLowerCase().split(/[_-]/)[0];
    const dstLang = snapshot.primaryLocale.toLowerCase().split(/[_-]/)[0];
    if (srcLang !== dstLang)
      storeWarn(
        'W_LOCALE_MISMATCH',
        `source locale ${catalog.meta.locale}, store primary locale ${snapshot.primaryLocale}`,
      );
  }

  // ── Categories (D24, D25, U7) ─────────────────────────────────────────────
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
    const ledger = L('CATEGORY', m.ref);
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
  const plannedCatByRef = new Map(
    plannedCategories.map((c) => [c.mapped.ref, c]),
  );
  /** A collection that is (or will be) on the platform for this ref ('new' = created now). */
  const collectionFor = (ref: string): string | null => {
    const live = snapshot.categoriesByRef.get(ref);
    if (live) return live.id;
    const pc = plannedCatByRef.get(ref);
    if (!pc || !scopes.categories) return null;
    if (pc.action === 'CREATE') return 'new';
    if (pc.adopt && pc.target_id) return pc.target_id;
    return null;
  };
  if (scopes.categories)
    for (const c of plannedCategories) {
      const parent = c.mapped.parent_ref;
      if (!parent || c.action === 'CONFLICT') continue;
      if (
        plannedCatByRef.get(parent)?.action === 'CONFLICT' &&
        !collectionFor(parent)
      )
        warn({
          code: 'W_CATEGORY_PARENT_CONFLICT',
          external_ref: c.mapped.ref,
          title: c.mapped.name,
          message: `parent ${parent} was not imported (slug conflict); placed at the top level`,
        });
    }

  // ── Products (D19–D28) ────────────────────────────────────────────────────
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
      host_aliases: input.hostAliases,
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
    const ledger = L('PRODUCT', m.ref);
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
        const vl = L('VARIANT', v.ref);
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
          ? (L('VARIANT', v.ref)?.created_by_import ?? false)
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
        const pl = L('PERSONALIZATION', desc.source_ref);
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
      const fl = L('FALLBACK_FIELD', ref);
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

  // ── Shipping (D26) ────────────────────────────────────────────────────────
  let shippingWork: PlanWork['shipping'] = null;
  if (shippingOn) {
    shippingWork = { profiles: [], zones: [], methods: [] };
    const plan = <T>(
      type: string,
      ref: string,
      mappedValue: T,
      hash: string,
    ) => {
      const ledger = L(type, ref);
      const targetId =
        ledger?.status === ImportEntityStatus.ACTIVE ? ledger.target_id : null;
      const state = targetId
        ? snapshot.shippingStates.get(targetId)
        : undefined;
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
      shippingWork.profiles.push(pp);
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
        shippingWork.zones.push(zp);
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
          shippingWork.methods.push(mp);
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
  }

  // ── NPP templates (D28, C26) ──────────────────────────────────────────────
  const plannedTemplates: PlannedTemplate[] = [];
  if (scopes.templates) {
    for (const t of catalog.templates) {
      const th = hashOf(t);
      const tl = L('DESIGN_TEMPLATE', t.ext_id);
      let ta: PlanAction;
      if (!snapshot.designerAvailable) {
        ta =
          tl && tl.status === ImportEntityStatus.STAGED && tl.source_hash === th
            ? 'UNCHANGED'
            : 'STAGE';
      } else if (tl && tl.status === ImportEntityStatus.ACTIVE)
        ta = tl.source_hash === th ? 'UNCHANGED' : 'UPDATE';
      else ta = 'CREATE';
      plannedTemplates.push({
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
  }

  // ── Media (D8, D9) ────────────────────────────────────────────────────────
  const media: PlannedMedia[] = [];
  if (scopes.media) {
    const seen = new Map<string, PlannedMedia>();
    const need = (img: MappedImage, target: MediaTarget) => {
      if (!img.source_url) return;
      const key = `${target}|${img.source_url}`;
      if (seen.has(key)) return;
      const have = snapshot.media.get(img.source_url);
      const ok = target === 'public' ? have?.public : have?.private;
      const pm: PlannedMedia = {
        source_url: img.source_url,
        candidates: img.candidates,
        target,
        action: ok ? 'UNCHANGED' : 'CREATE',
      };
      seen.set(key, pm);
      media.push(pm);
    };
    if (scopes.categories)
      for (const c of plannedCategories)
        if (
          (c.action === 'CREATE' || c.action === 'UPDATE') &&
          c.mapped.thumbnail
        )
          need(mediaRefOf(c.mapped.thumbnail), 'public');
    if (scopes.products)
      for (const p of plannedProducts) {
        if (p.action === 'CREATE' || p.action === 'UPDATE')
          productMediaRefs(p.mapped).forEach((i) => need(i, 'public'));
        for (const pr of p.presets)
          if (pr.action === 'CREATE' || pr.action === 'UPDATE')
            presetHelpRefs(p.mapped, pr.descriptor.source_ref).forEach((i) =>
              need(i, 'public'),
            );
      }
    for (const t of plannedTemplates) {
      if (t.action === 'UNCHANGED') continue;
      if (t.template.thumbnail && !t.template.thumbnail.missing)
        need(mediaRefOf(t.template.thumbnail), 'private');
      for (const a of t.template.assets)
        if (!a.missing && a.url) need(mediaRefOf(a), 'private');
    }
    for (const m of media)
      push({
        entity_type: 'MEDIA',
        external_ref: `${m.target}:${m.source_url}`.slice(0, 255),
        action: m.action,
        target_id: null,
      });
  }

  const mediaUrls = new Set<string>(media.map((m) => m.source_url));
  if (scopes.categories)
    for (const c of plannedCategories)
      if (
        (c.action === 'CREATE' || c.action === 'UPDATE') &&
        c.mapped.thumbnail
      )
        mediaUrls.add(c.mapped.thumbnail.url);
  if (scopes.products)
    for (const p of plannedProducts) {
      if (p.action === 'CREATE' || p.action === 'UPDATE')
        for (const i of productMediaRefs(p.mapped)) mediaUrls.add(i.source_url);
      for (const pr of p.presets)
        for (const i of presetHelpRefs(p.mapped, pr.descriptor.source_ref))
          mediaUrls.add(i.source_url);
    }
  for (const t of plannedTemplates)
    for (const r of [
      ...(t.template.thumbnail ? [t.template.thumbnail] : []),
      ...t.template.assets,
    ])
      if (r.url) mediaUrls.add(r.url);

  // ── Redirects (§6.1) ──────────────────────────────────────────────────────
  let redirectWork: PlanWork['redirects'] = null;
  let redirectPreview: {
    from: string;
    to: string;
    rule: string;
    external_ref: string;
  }[] = [];
  const redirectByRule: Record<string, number> = {};
  let excludedOldSlugs: {
    external_ref: string;
    slug: string;
    reason: string;
  }[] = [];
  // Fix 13: a redirect may only point at a page that will be live.
  const willBePublished = (p: PlannedProduct): boolean => {
    const writes =
      scopes.products && (p.action === 'CREATE' || p.action === 'UPDATE');
    if (writes) return p.mapped.status === 'PUBLISHED';
    return p.current_status === 'PUBLISHED';
  };
  if (scopes.redirects) {
    const sourceByRef = new Map(imported.map((x) => [x.ext_id, x]));
    const built = buildImportRedirects({
      catalog,
      imported: plannedProducts.map((p) => ({
        product: sourceByRef.get(p.mapped.ref)!,
        final_slug: p.final_slug,
        published: willBePublished(p),
      })),
      skipped,
      categorySlug,
      redirectSkipped: options.redirect_skipped,
    });
    excludedOldSlugs = built.excludedOldSlugs;
    // A from-path equal to a live product or collection path is a CONFLICT (§6.1).
    const livePaths = new Set<string>();
    for (const s of snapshot.publishedProductSlugs)
      livePaths.add(`/products/${s}`);
    for (const p of plannedProducts)
      if (willBePublished(p)) livePaths.add(`/products/${p.final_slug}`);
    for (const c of snapshot.categoriesBySlug.values())
      if (c.is_active) livePaths.add(`/collections/${c.slug}`);
    for (const s of categorySlug.values()) livePaths.add(`/collections/${s}`);
    // Platform pages whose slug this run changes: the old page path
    // redirects to the new one (and older rows pointing at it are re-pointed).
    const claimed = new Set<string>();
    for (const p of plannedProducts) claimed.add(`/products/${p.final_slug}`);
    for (const s of categorySlug.values()) claimed.add(`/collections/${s}`);
    if (scopes.products)
      for (const p of plannedProducts) {
        const old = snapshot.productsByRef.get(p.mapped.ref)?.slug;
        if (
          p.action !== 'UPDATE' ||
          !old ||
          old === p.final_slug ||
          p.current_status !== 'PUBLISHED' ||
          !willBePublished(p)
        )
          continue;
        const from = `/products/${old}`;
        if (claimed.has(from)) continue;
        livePaths.delete(from);
        built.candidates.push({
          from,
          to: `/products/${p.final_slug}`,
          rule: 'renamed',
          external_ref: p.mapped.ref,
          status_code: 301,
        });
      }
    if (scopes.categories)
      for (const c of plannedCategories) {
        const live = snapshot.categoriesByRef.get(c.mapped.ref);
        if (c.action !== 'UPDATE' || !live || live.slug === c.mapped.slug)
          continue;
        const from = `/collections/${live.slug}`;
        if (claimed.has(from)) continue;
        livePaths.delete(from);
        built.candidates.push({
          from,
          to: `/collections/${c.mapped.slug}`,
          rule: 'renamed',
          external_ref: c.mapped.ref,
          status_code: 301,
        });
      }
    const normalizedLive = new Set(
      [...livePaths].map((p) => normalizeRedirectPath(p) ?? p),
    );
    // An earlier run's redirect whose from-path is live again (a rename that
    // was reverted) would shadow the page: switched off, restored on rollback.
    const deactivations = planRedirectDeactivations(
      snapshot.redirects,
      normalizedLive,
    );
    const incoming: IncomingRedirect[] = [];
    const incomingRefs: string[] = [];
    const liveConflicts: { from_path: string; to_path: string }[] = [];
    for (const c of built.candidates) {
      const key = normalizeRedirectPath(c.from);
      if (key && normalizedLive.has(key)) {
        liveConflicts.push({ from_path: key, to_path: c.to });
        continue;
      }
      incoming.push({
        from_path: c.from,
        to_path: c.to,
        status_code: c.status_code,
      });
      incomingRefs.push(c.external_ref);
    }
    // Same per-store cap as RedirectsService.bulkUpsertFromImport (PLAN == APPLY).
    const rplan = capRedirectCreates(
      planRedirectUpserts(
        withoutDeactivated(snapshot.redirects, deactivations),
        incoming,
      ),
      snapshot.redirects.length,
    );
    redirectWork = {
      incoming,
      incoming_refs: incomingRefs,
      plan: rplan,
      live_conflicts: liveConflicts,
      deactivate: deactivations,
      live_paths: [...normalizedLive],
    };
    for (const it of rplan.items) {
      push({
        entity_type: 'REDIRECT',
        external_ref: it.from_path.slice(0, 255),
        action: it.action,
        target_id: it.id,
        title: it.to_path,
      });
      if (isProxyReservedPath(it.from_path))
        warn({
          code: 'W_REDIRECT_UNREACHABLE',
          external_ref: it.from_path,
          title: it.to_path,
          message: 'the storefront never routes this path to redirects',
        });
    }
    for (const d of deactivations)
      push({
        entity_type: 'REDIRECT',
        external_ref: d.from_path.slice(0, 255),
        action: 'UPDATE',
        target_id: d.id,
        message: 'deactivated (live path)',
        title: d.to_path,
      });
    // Existing IMPORT rows re-pointed at the new final targets (fix 5).
    for (const r of rplan.repoints)
      push({
        entity_type: 'REDIRECT',
        external_ref: r.from_path.slice(0, 255),
        action: 'UPDATE',
        target_id: r.id,
        message: 'repointed',
        title: r.to_path,
      });
    for (const c of rplan.conflicts) {
      push({
        entity_type: 'REDIRECT',
        external_ref: c.from_path.slice(0, 255),
        action: 'CONFLICT',
        target_id: null,
        message: c.code,
      });
      warn({
        code: 'W_REDIRECT_CONFLICT',
        external_ref: c.from_path,
        title: c.to_path,
        message: c.code,
      });
    }
    for (const c of liveConflicts) {
      push({
        entity_type: 'REDIRECT',
        external_ref: c.from_path.slice(0, 255),
        action: 'CONFLICT',
        target_id: null,
        message: 'live path',
      });
      warn({
        code: 'W_REDIRECT_CONFLICT',
        external_ref: c.from_path,
        title: c.to_path,
        message: 'the path is a live page of this store',
      });
    }
    const accepted = new Set(rplan.items.map((i) => i.from_path));
    const ruleOf = new Map(
      built.candidates.map((c) => [normalizeRedirectPath(c.from) ?? c.from, c]),
    );
    for (const it of rplan.items) {
      const c = ruleOf.get(it.from_path);
      if (!c) continue;
      redirectByRule[c.rule] = (redirectByRule[c.rule] ?? 0) + 1;
      if (redirectPreview.length < 50)
        redirectPreview.push({
          from: it.from_path,
          to: it.to_path,
          rule: c.rule,
          external_ref: c.external_ref,
        });
    }
    redirectPreview = redirectPreview.filter((r) => accepted.has(r.from));
  }

  // ── Summary (report shape of model/dry-run-summary + plan counts) ─────────
  const base = summarizeCatalog(catalog, {
    skip_ext_ids: options.skip_ext_ids,
    include_drafts: options.include_drafts,
    status_map: options.status_map,
    customization_type_rules: options.customization_type_rules,
    label_overrides: options.label_overrides,
    term_cleanup: options.term_cleanup,
    designer_fallback_fields: options.designer_fallback_fields,
    redirect_skipped: options.redirect_skipped,
    personalization_available: snapshot.personalizationAvailable,
    designer_available: snapshot.designerAvailable,
  });
  const counts: DryRunSummary['counts'] = {};
  const count = (t: PlanEntityType, a: PlanAction, by = 1) => {
    if (by <= 0) return;
    const rec = (counts[t] ??= {});
    rec[a] = (rec[a] ?? 0) + by;
  };
  for (const i of items) count(i.entity_type, i.action);
  if (scopes.products)
    for (const p of plannedProducts) {
      const a = p.action;
      count('IMAGE', a, p.mapped.images.length);
      count('TAG', a, p.mapped.tags.length);
      count('FAQ', a, p.mapped.faqs.length);
      count('PRODUCT_CATEGORY', a, p.mapped.category_refs.length);
      if (p.mapped.option_config) count('OPTION_CONFIG', a);
    }
  const warnings = { ...base.warnings };
  const sampleMax = 10;
  for (const w of mapWarnings) {
    const g = (warnings[w.code] ??= { count: 0, samples: [] });
    g.count++;
    if (g.samples.length < sampleMax)
      g.samples.push({
        external_ref: w.external_ref,
        title: w.title,
        message: w.message,
      });
  }
  if (sanitizer.mode === 'plain_text_fallback') {
    warnings[W_HTML_SANITIZER_FALLBACK] = {
      count: 1,
      samples: [
        {
          message:
            'HTML sanitizer not installed: descriptions are imported as plain text paragraphs',
        },
      ],
    };
  }
  const summary: ImportRunSummary = {
    ...base,
    counts,
    warnings,
    redirects: scopes.redirects
      ? {
          total: redirectWork!.plan.items.length,
          by_rule: redirectByRule,
          preview: redirectPreview as DryRunSummary['redirects']['preview'],
        }
      : { total: 0, by_rule: {}, preview: [] },
    old_slugs: {
      ...base.old_slugs,
      redirected: redirectByRule.old_slug ?? 0,
      excluded: excludedOldSlugs,
    },
    plan: {
      items: items.length,
      blockers,
      sanitizer: sanitizer.mode,
      personalization_available: snapshot.personalizationAvailable,
      designer_available: snapshot.designerAvailable,
    },
  };

  const work: PlanWork = {
    categories: scopes.categories ? plannedCategories : [],
    products: scopes.products ? plannedProducts : [],
    skipped: scopes.products
      ? skipped.map((p) => ({
          ref: p.ext_id,
          target_id: snapshot.productsByRef.get(p.ext_id)?.id ?? null,
          title: p.title,
        }))
      : [],
    removals,
    shipping: shippingWork,
    templates: plannedTemplates,
    media,
    media_urls: [...mediaUrls],
    redirects: redirectWork,
  };
  return {
    items,
    work,
    summary,
    fingerprint: planFingerprint(input.catalogHash, options, items, work),
    blockers,
  };
}
