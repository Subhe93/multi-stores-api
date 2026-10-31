import { ImportEntityStatus } from '@prisma/client';
import type {
  IncomingRedirect,
  RedirectDeactivation,
  RedirectUpsertPlan,
} from '../../redirects/redirect-plan';
import type {
  DryRunSummary,
  SummaryAction,
  SummaryEntityType,
} from '../model/dry-run-summary';
import type { NormalizedCatalog, NPage, NTemplate } from '../model/normalized';
import type { PresetDescriptor } from '../model/presets';
import { hashOf } from '../mapping/hash';
import type { MappedCategory } from '../mapping/map-category';
import type { MappedProduct, MappedVariant } from '../mapping/map-product';
import type {
  MappedShippingMethod,
  MappedShippingProfile,
  MappedShippingZone,
} from '../mapping/map-shipping';
import type { ImportRunOptions } from '../runs/run-options';
import type { ImporterHtmlSanitizer } from '../html/html-sanitizer';
import type { MediaNeed } from '../media/media-importer';
import type { LedgerRow, TargetSnapshot } from './target-snapshot';

/**
 * Types and pure helpers shared by the per-entity planners (M5 B18 split of
 * the former single-file planner). `planner.ts` is the orchestrator and
 * re-exports everything here, so callers keep importing from `./planner`.
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

export interface Planned {
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

/** What the apply step writes for one imported WP page (M5 B17, `scopes.pages`). */
export interface MappedPage {
  ref: string;
  slug: string;
  title: string;
  /** Sanitized through the HtmlSanitizer seam (one rich-text section). */
  html: string;
  meta_title: string | null;
  meta_description: string | null;
  noindex: boolean;
}

export interface PlannedPage extends Planned {
  page: NPage;
  mapped: MappedPage;
  /**
   * The slug the page is served at (`/<final_slug>`): the target page's
   * stored slug on UPDATE/UNCHANGED, else `mapped.slug` made unique like a
   * builder page (reserved routes, numeric slugs, taken slugs get `-2`, ...).
   * Apply creates the page with exactly this slug (PLAN == APPLY).
   */
  final_slug: string;
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

export interface PlanRedirectWork {
  incoming: IncomingRedirect[];
  /** Source entity (product/category/tag ref) of each `incoming` row, same index. */
  incoming_refs: string[];
  plan: RedirectUpsertPlan;
  live_conflicts: { from_path: string; to_path: string }[];
  /** Active IMPORT rows that would shadow a live page: switched off. */
  deactivate: RedirectDeactivation[];
  /** Normalised live product/collection paths (apply recomputes `deactivate` from them). */
  live_paths: string[];
}

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
  /** Draft builder pages to create (M5 B17, `scopes.pages`). */
  pages: PlannedPage[];
  media: PlannedMedia[];
  /**
   * Every media source URL the written entities reference, whether or not
   * the media scope is on (fix 2): the apply step resolves them all from the
   * `ImportMedia` ledger, so media stored by earlier runs are never wiped.
   */
  media_urls: string[];
  redirects: PlanRedirectWork | null;
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
        pages: work.pages.map((p) => [p.mapped.ref, p.source_hash]),
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
