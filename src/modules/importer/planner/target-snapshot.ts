import type { ImportEntityStatus } from '@prisma/client';
import type { ExistingRedirectRow } from '../../redirects/redirect-plan';

/**
 * What the planner needs to know about the target store (M4.4 §10
 * `planner/target-snapshot.ts`). Loaded from the database by
 * `loadTargetSnapshot` (state-loader.ts); plain data so the planner stays pure.
 */

export interface LedgerRow {
  id: string;
  entity_type: string;
  external_ref: string;
  target_id: string | null;
  source_hash: string;
  applied_hash: string | null;
  created_by_import: boolean;
  status: ImportEntityStatus;
  first_run_id: string;
  last_run_id: string;
  /** STAGED hand-offs; for PRODUCT rows `{incomplete: {media, categories}}` (fix 1). */
  payload?: unknown;
}

/** What an applied product still lacks (ledger payload, fix 1). */
export interface IncompleteInfo {
  /** Source URLs of images that were not stored when the product was written. */
  media?: string[];
  /** Category refs the product could not be linked to. */
  categories?: string[];
}

export function incompleteOf(
  row: LedgerRow | undefined,
): IncompleteInfo | null {
  const p = row?.payload as { incomplete?: IncompleteInfo } | null | undefined;
  return p && typeof p === 'object' && p.incomplete ? p.incomplete : null;
}

export interface SnapshotProduct {
  id: string;
  slug: string | null;
  status: string;
  /** Hash of the managed fields as they are now (state.ts). */
  state_hash: string;
}

export interface SnapshotVariant {
  id: string;
  product_id: string;
  external_ref: string | null;
  is_active: boolean;
}

export interface SnapshotCategory {
  id: string;
  slug: string;
  /** M6.7: the live parent, for the hierarchical `/collections/` path. */
  parent_id: string | null;
  external_ref: string | null;
  is_active: boolean;
  /**
   * Namez Phase 1: an INTERNAL label (a converted occasion page's label)
   * is never written by the importer and has no live collection path.
   * Absent in older fixtures = PUBLIC.
   */
  visibility?: 'PUBLIC' | 'INTERNAL';
  state_hash: string;
}

export interface TargetSnapshot {
  storeId: string;
  creatorId: string;
  primaryLocale: string;
  /** Effective store currency (default market, else the store / platform currency). */
  currency: string;
  taxPricingMode: string;
  platformCategoryExists: boolean;
  personalizationAvailable: boolean;
  designerAvailable: boolean;
  /** `${entity_type}|${external_ref}` → ledger row. */
  ledger: Map<string, LedgerRow>;
  /** Creator products with an external_ref, by ref. */
  productsByRef: Map<string, SnapshotProduct>;
  /** Primary-locale slugs of every product of the creator → product id. */
  productSlugs: Map<string, string>;
  /** Slugs of the creator's PUBLISHED products (live `/products/<slug>` paths). */
  publishedProductSlugs: Set<string>;
  /** Variants of the creator's imported products, by product id. */
  variantsByProduct: Map<string, SnapshotVariant[]>;
  /** Collection ids each imported product is linked to (fix 1). */
  productCategoryLinks: Map<string, Set<string>>;
  /** Owners of the source SKUs anywhere on the platform (ProductVariant.sku is unique). */
  skuOwners: Map<string, { product_id: string; external_ref: string | null }>;
  categoriesByRef: Map<string, SnapshotCategory>;
  categoriesBySlug: Map<string, SnapshotCategory>;
  /** Current state hash of shipping rows by id (profiles, zones, methods). */
  shippingStates: Map<string, string>;
  creatorHasDefaultProfile: boolean;
  /** `ImportMedia` rows by source URL. */
  media: Map<string, { public: boolean; private: boolean }>;
  redirects: ExistingRedirectRow[];
}

export const ledgerKey = (entityType: string, ref: string): string =>
  `${entityType}|${ref}`;

/** Empty snapshot (tests, a store that has nothing yet). */
export function emptySnapshot(
  partial: Partial<TargetSnapshot> & { storeId: string; creatorId: string },
): TargetSnapshot {
  return {
    primaryLocale: 'sv',
    currency: 'SEK',
    taxPricingMode: 'INCLUSIVE',
    platformCategoryExists: true,
    personalizationAvailable: true,
    designerAvailable: false,
    ledger: new Map(),
    productsByRef: new Map(),
    productSlugs: new Map(),
    publishedProductSlugs: new Set(),
    variantsByProduct: new Map(),
    productCategoryLinks: new Map(),
    skuOwners: new Map(),
    categoriesByRef: new Map(),
    categoriesBySlug: new Map(),
    shippingStates: new Map(),
    creatorHasDefaultProfile: false,
    media: new Map(),
    redirects: [],
    ...partial,
  };
}
