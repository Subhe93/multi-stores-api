import { ImportEntityStatus } from '@prisma/client';
import { hashOf } from '../importer/mapping/hash';
import { htmlToPlainText, truncateWords } from '../importer/model/clean';
import {
  isNumericPageSlug,
  normalizeSlugForLookup,
} from '@multi-stores/core/slug';
import { isReservedPageSlug, isWpSlug } from '../../common/slug/wp-slug';
import {
  planRedirectUpserts,
  type ExistingRedirectRow,
  type IncomingRedirect,
  type RedirectUpsertPlan,
} from '../redirects/redirect-plan';
import {
  HERO_SUBHEADING_MAX,
  occasionPageSections,
  occasionPresetText,
  type OccasionSectionBody,
} from './occasion-preset';

/**
 * Occasion conversion (Namez go-live, Phase 1): the sub-collections of one
 * collection become root LANDING pages ("till vem" + occasions, like the
 * competitor's /presenter-till-pappa), each backed by the same collection
 * row turned into an INTERNAL label, with 301s from the collection path.
 *
 * This file is the pure planner: it reads a loaded `ConversionState` and
 * returns the exact work `apply` executes (PLAN == APPLY, fingerprinted).
 * Nothing here touches the database.
 */

export const OCCASION_ENTITY_TYPE = 'OCCASION_PAGE';
export const CATEGORY_REF_PREFIX = 'cc:';
/** Longest ancestor chain followed when building a collection path. */
const PATH_MAX_DEPTH = 8;
/** Rank Math `%excerpt%` length for a generated meta description. */
const META_DESCRIPTION_MAX = 160;

export interface StateCategory {
  id: string;
  slug: string;
  parent_id: string | null;
  visibility: 'PUBLIC' | 'INTERNAL';
  is_active: boolean;
  sort_order: number;
  external_ref: string | null;
  thumbnail_url: string | null;
  translation: {
    name: string;
    description: string | null;
    long_description: string | null;
    meta_title: string | null;
    meta_desc: string | null;
  } | null;
  /** Linked product ids (ProductCreatorCategory), in sort order. */
  product_ids: string[];
  /** Linked custom product ids (CustomProductCreatorCategory), in sort order. */
  custom_product_ids: string[];
}

export interface StateProduct {
  id: string;
  primary_creator_category_id: string | null;
  /** Linked collection ids in link sort order. */
  linked: string[];
}

export interface StatePage {
  id: string;
  slug: string | null;
  type: string;
  status: string;
  published_version_id: string | null;
}

export interface StateMenuItem {
  id: string;
  menu_id: string;
  parent_id: string | null;
  kind: string;
  resource_id: string | null;
  url: string;
}

export interface StateLedgerRow {
  external_ref: string;
  target_id: string | null;
  source_hash: string;
  applied_hash: string | null;
  status: ImportEntityStatus;
  last_run_id: string;
}

export interface ConversionState {
  storeId: string;
  creatorId: string;
  primaryLocale: string;
  categories: StateCategory[];
  products: StateProduct[];
  customProducts: StateProduct[];
  pages: StatePage[];
  staticPageSlugs: string[];
  redirects: ExistingRedirectRow[];
  menuItems: StateMenuItem[];
  ledger: StateLedgerRow[];
}

export interface ConversionInput {
  /** Slug of the collection whose descendants are converted. */
  parent_slug: string;
  /**
   * Slugs whose INTERNAL label also receives the product links of their
   * descendants (e.g. `studentpresent` lists the products of its two
   * children too). Defaults to none.
   */
  merge_descendant_products?: string[];
  /**
   * Also convert the parent collection itself (after its descendants), e.g.
   * `svensk-present` and its child both become root pages. Defaults to false.
   */
  include_parent?: boolean;
  /** When false, the plan is reported but pages would be drafts: not supported for apply. */
  publish?: boolean;
}

export type ConversionAction = 'CREATE' | 'UNCHANGED' | 'SKIP' | 'CONFLICT';

export interface PlannedPrimary {
  entity: 'PRODUCT' | 'CUSTOM_PRODUCT';
  id: string;
  from: string;
  to: string | null;
}

export interface PlannedLink {
  entity: 'PRODUCT' | 'CUSTOM_PRODUCT';
  id: string;
}

export interface PlannedPageWrite {
  slug: string;
  title: string;
  meta_title: string;
  meta_description: string | null;
  sections: OccasionSectionBody[];
}

export interface PlannedConversionItem {
  category_id: string;
  external_ref: string;
  slug: string;
  name: string;
  path: string[];
  depth: number;
  action: ConversionAction;
  message: string | null;
  /** Existing page (UNCHANGED / SKIP), or null for CREATE. */
  page_id: string | null;
  source_hash: string;
  page: PlannedPageWrite | null;
  /** Product links added to the label (descendant merge). */
  links_added: PlannedLink[];
  /** Products whose primary collection pointed at this category. */
  primaries: PlannedPrimary[];
  /** Menu items switched from COLLECTION to PAGE. */
  menu_items: { id: string; url: string }[];
  /** The collection paths that redirect to the page. */
  redirect_from: string[];
  label_products: number;
  rich_text_source: 'long_description' | 'description' | 'none';
  hero_image: string | null;
  conflicts: string[];
}

export interface ConversionPlan {
  input: Required<ConversionInput>;
  parent: { id: string; slug: string } | null;
  items: PlannedConversionItem[];
  redirects: RedirectUpsertPlan;
  /** Codes that stop `apply` for the whole batch. */
  blockers: string[];
  warnings: { code: string; slug: string; message: string }[];
  fingerprint: string;
  counts: {
    pages: Record<ConversionAction, number>;
    redirects: {
      create: number;
      update: number;
      unchanged: number;
      repointed: number;
      conflicts: number;
    };
    menu_items: number;
    primaries: { repicked: number; cleared: number };
    links_added: number;
  };
}

export const categoryRef = (c: Pick<StateCategory, 'id' | 'external_ref'>) =>
  c.external_ref ?? `${CATEGORY_REF_PREFIX}${c.id}`;

/** Path of a category (root first) from the live tree. */
export function categoryPath(
  c: StateCategory,
  byId: ReadonlyMap<string, StateCategory>,
): string[] {
  const path = [c.slug];
  const seen = new Set<string>([c.id]);
  for (
    let p = c.parent_id ? byId.get(c.parent_id) : undefined;
    p && !seen.has(p.id) && path.length <= PATH_MAX_DEPTH;
    p = p.parent_id ? byId.get(p.parent_id) : undefined
  ) {
    seen.add(p.id);
    path.unshift(p.slug);
  }
  return path;
}

/** Descendants of `rootId`, deepest first (children before their parent). */
export function descendantsDeepestFirst(
  rootId: string,
  categories: readonly StateCategory[],
): StateCategory[] {
  const kids = new Map<string, StateCategory[]>();
  for (const c of categories) {
    if (!c.parent_id) continue;
    const list = kids.get(c.parent_id) ?? [];
    list.push(c);
    kids.set(c.parent_id, list);
  }
  const out: StateCategory[] = [];
  const visit = (id: string, seen: Set<string>) => {
    for (const child of (kids.get(id) ?? []).sort(
      (a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug),
    )) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      visit(child.id, seen);
      out.push(child);
    }
  };
  visit(rootId, new Set([rootId]));
  return out;
}

/** Content hash of what the page is built from (UNCHANGED on re-run). */
export function sourceHashOf(
  c: StateCategory,
  mergedLinks: readonly string[],
): string {
  return hashOf({
    slug: c.slug,
    thumbnail_url: c.thumbnail_url,
    translation: c.translation,
    merged_links: [...mergedLinks].sort(),
  });
}

function metaDescriptionOf(c: StateCategory): string | null {
  const tr = c.translation;
  if (!tr) return null;
  if (tr.meta_desc) return tr.meta_desc;
  const text = htmlToPlainText(tr.description ?? '');
  return text ? truncateWords(text, META_DESCRIPTION_MAX) : null;
}

export function planOccasionConversion(
  state: ConversionState,
  rawInput: ConversionInput,
): ConversionPlan {
  // Collection slugs as typed / encoded by the caller, in the stored form.
  const input: Required<ConversionInput> = {
    parent_slug: normalizeSlugForLookup(rawInput.parent_slug),
    merge_descendant_products: (rawInput.merge_descendant_products ?? []).map(
      (s) => normalizeSlugForLookup(s),
    ),
    include_parent: rawInput.include_parent ?? false,
    publish: rawInput.publish ?? true,
  };
  const byId = new Map(state.categories.map((c) => [c.id, c]));
  const parent = state.categories.find((c) => c.slug === input.parent_slug);
  const blockers: string[] = [];
  const warnings: ConversionPlan['warnings'] = [];
  if (!parent) blockers.push('PARENT_NOT_FOUND');
  else if (parent.visibility !== 'PUBLIC') blockers.push('PARENT_INTERNAL');
  if (!input.publish) blockers.push('PUBLISH_REQUIRED');

  const ledgerByRef = new Map(state.ledger.map((r) => [r.external_ref, r]));
  const pagesById = new Map(state.pages.map((p) => [p.id, p]));
  const pageSlugs = new Map<string, StatePage>();
  for (const p of state.pages) if (p.slug) pageSlugs.set(p.slug, p);
  const staticSlugs = new Set(state.staticPageSlugs);
  const activeFrom = new Set(
    state.redirects.filter((r) => r.is_active).map((r) => r.from_path),
  );
  const internalIds = new Set(
    state.categories
      .filter((c) => c.visibility === 'INTERNAL')
      .map((c) => c.id),
  );
  const text = occasionPresetText(state.primaryLocale);

  const targets = parent
    ? [
        ...descendantsDeepestFirst(parent.id, state.categories),
        // The parent goes last: it is only converted when every child was.
        ...(input.include_parent ? [parent] : []),
      ]
    : [];
  // Every converted category is INTERNAL after the batch, so a primary
  // re-pick never lands on another converted sibling.
  const convertedIds = new Set(targets.map((c) => c.id));
  const seenSlugs = new Set<string>();
  const items: PlannedConversionItem[] = [];
  const incoming: IncomingRedirect[] = [];
  const primariesDone = new Set<string>();
  /** Action of every visited category (children are visited first). */
  const actionById = new Map<string, ConversionAction>();
  const manualOwned = new Set(
    state.redirects
      .filter((r) => r.source === 'MANUAL')
      .map((r) => r.from_path),
  );

  for (const c of targets) {
    const ref = categoryRef(c);
    const path = categoryPath(c, byId);
    const name = c.translation?.name?.trim() || c.slug;
    const mergeDescendants = input.merge_descendant_products.includes(c.slug);
    const descendants = mergeDescendants
      ? descendantsDeepestFirst(c.id, state.categories)
      : [];
    const own = new Set(c.product_ids);
    const ownCustom = new Set(c.custom_product_ids);
    const linksAdded: PlannedLink[] = [];
    for (const d of descendants) {
      for (const id of d.product_ids)
        if (!own.has(id)) {
          own.add(id);
          linksAdded.push({ entity: 'PRODUCT', id });
        }
      for (const id of d.custom_product_ids)
        if (!ownCustom.has(id)) {
          ownCustom.add(id);
          linksAdded.push({ entity: 'CUSTOM_PRODUCT', id });
        }
    }
    const sourceHash = sourceHashOf(
      c,
      linksAdded.map((l) => `${l.entity}:${l.id}`),
    );
    const ledger = ledgerByRef.get(ref);
    const ledgerPage = ledger?.target_id
      ? pagesById.get(ledger.target_id)
      : undefined;

    const base = {
      category_id: c.id,
      external_ref: ref,
      slug: c.slug,
      name,
      path,
      depth: path.length - 1,
      source_hash: sourceHash,
      page: null,
      links_added: [] as PlannedLink[],
      primaries: [] as PlannedPrimary[],
      menu_items: [] as { id: string; url: string }[],
      redirect_from: [] as string[],
      label_products: own.size + ownCustom.size,
      rich_text_source: 'none' as PlannedConversionItem['rich_text_source'],
      hero_image: c.thumbnail_url,
      conflicts: [] as string[],
    };

    // Re-runs: an ACTIVE ledger row with its page still there.
    if (ledger && ledger.status === ImportEntityStatus.ACTIVE && ledgerPage) {
      if (ledger.source_hash === sourceHash && c.visibility === 'INTERNAL') {
        items.push({
          ...base,
          action: 'UNCHANGED',
          message: null,
          page_id: ledgerPage.id,
        });
      } else {
        items.push({
          ...base,
          action: 'SKIP',
          message: 'W_TARGET_MODIFIED_SKIPPED',
          page_id: ledgerPage.id,
        });
        warnings.push({
          code: 'W_TARGET_MODIFIED_SKIPPED',
          slug: c.slug,
          message: 'converted earlier and changed since; not rewritten',
        });
      }
      actionById.set(c.id, items[items.length - 1].action);
      seenSlugs.add(c.slug);
      continue;
    }

    // Pre-checks → CONFLICT per item.
    const conflicts: string[] = [];
    // The page slug is the collection slug: valid when it is what the WP
    // rule stores for it (Unicode letters kept, <= 200 encoded bytes).
    if (!isWpSlug(c.slug, state.primaryLocale))
      conflicts.push('PAGE_SLUG_INVALID');
    // WP page rules: reserved routes / feeds / locale prefixes, and numeric
    // slugs (`2024`, `page2`) that clash with pagination.
    if (isReservedPageSlug(c.slug) || isNumericPageSlug(c.slug))
      conflicts.push('PAGE_SLUG_RESERVED');
    if (seenSlugs.has(c.slug)) conflicts.push('PAGE_SLUG_DUPLICATE');
    if (pageSlugs.has(c.slug)) conflicts.push('PAGE_SLUG_TAKEN');
    if (staticSlugs.has(c.slug)) conflicts.push('STATIC_PAGE_SLUG_TAKEN');
    if (activeFrom.has(`/${c.slug}`)) conflicts.push('REDIRECT_SHADOWS_PAGE');
    if (!c.is_active) conflicts.push('CATEGORY_INACTIVE');
    if (c.visibility === 'INTERNAL')
      conflicts.push('CATEGORY_ALREADY_INTERNAL');
    if (!c.translation) conflicts.push('CATEGORY_NO_TRANSLATION');
    // PLAN == APPLY: an INTERNAL label cannot keep children, so a parent is
    // only converted when every child was (or already is a converted label).
    const childLeft = state.categories.some(
      (k) =>
        k.parent_id === c.id &&
        !['CREATE', 'UNCHANGED'].includes(actionById.get(k.id) ?? ''),
    );
    if (childLeft) conflicts.push('CHILD_NOT_CONVERTED');
    // The merchant owns a MANUAL row on the collection path: the 301 would
    // not be written, so the item is a CONFLICT rather than a silent gap.
    const collectionFrom = `/collections/${path.join('/')}`;
    if (manualOwned.has(collectionFrom)) conflicts.push('REDIRECT_CONFLICT');
    seenSlugs.add(c.slug);
    if (conflicts.length) {
      items.push({
        ...base,
        action: 'CONFLICT',
        message: conflicts.join(','),
        page_id: null,
        conflicts,
      });
      actionById.set(c.id, 'CONFLICT');
      continue;
    }

    const tr = c.translation!;
    const html = tr.long_description?.trim() || tr.description?.trim() || '';
    const richSource: PlannedConversionItem['rich_text_source'] =
      tr.long_description?.trim()
        ? 'long_description'
        : tr.description?.trim()
          ? 'description'
          : 'none';
    const subheading =
      richSource === 'long_description' && tr.description
        ? truncateWords(htmlToPlainText(tr.description), HERO_SUBHEADING_MAX) ||
          null
        : null;
    const page: PlannedPageWrite = {
      slug: c.slug,
      title: name,
      meta_title: tr.meta_title?.trim() || name,
      meta_description: metaDescriptionOf(c),
      sections: occasionPageSections({
        name,
        subheading,
        hero_image: c.thumbnail_url,
        label_id: c.id,
        html,
        products_heading: text.products_heading,
        products_link_label: text.products_link_label,
        text_heading: text.text_heading,
      }),
    };

    // Primaries: products whose primary is this category pick the first
    // PUBLIC link that is not converted in this batch, else null.
    const primaries: PlannedPrimary[] = [];
    const repick = (
      entity: PlannedPrimary['entity'],
      products: StateProduct[],
    ) => {
      for (const p of products) {
        if (p.primary_creator_category_id !== c.id) continue;
        const key = `${entity}:${p.id}`;
        if (primariesDone.has(key)) continue;
        primariesDone.add(key);
        const to =
          p.linked.find(
            (id) => !internalIds.has(id) && !convertedIds.has(id),
          ) ?? null;
        primaries.push({ entity, id: p.id, from: c.id, to });
        if (!to)
          warnings.push({
            code: 'W_PRODUCT_NO_PUBLIC_COLLECTION',
            slug: c.slug,
            message: `${entity.toLowerCase()} ${p.id} keeps no public collection`,
          });
      }
    };
    repick('PRODUCT', state.products);
    repick('CUSTOM_PRODUCT', state.customProducts);

    const menuItems = state.menuItems
      .filter((m) => m.kind === 'COLLECTION' && m.resource_id === c.id)
      .map((m) => ({ id: m.id, url: `/${c.slug}` }));

    const from = collectionFrom;
    incoming.push({ from_path: from, to_path: `/${c.slug}`, status_code: 301 });

    items.push({
      ...base,
      action: 'CREATE',
      message: null,
      page_id: null,
      page,
      links_added: linksAdded,
      primaries,
      menu_items: menuItems,
      redirect_from: [from],
      rich_text_source: richSource,
    });
    actionById.set(c.id, 'CREATE');
  }

  // Rows converted by an earlier run are INTERNAL roots now, so the tree
  // walk above never reaches them: list them as UNCHANGED (no writes) so a
  // second dry run reports "45 UNCHANGED" rather than nothing.
  for (const row of state.ledger) {
    if (row.status !== ImportEntityStatus.ACTIVE || !row.target_id) continue;
    if (row.external_ref.startsWith('batch:')) continue;
    const c = state.categories.find((k) => categoryRef(k) === row.external_ref);
    if (!c || actionById.has(c.id) || c.visibility !== 'INTERNAL') continue;
    const page = pagesById.get(row.target_id);
    if (!page) continue;
    items.push({
      category_id: c.id,
      external_ref: row.external_ref,
      slug: c.slug,
      name: c.translation?.name?.trim() || c.slug,
      path: [c.slug],
      depth: 0,
      action: 'UNCHANGED',
      message: 'converted earlier',
      page_id: page.id,
      source_hash: row.source_hash,
      page: null,
      links_added: [],
      primaries: [],
      menu_items: [],
      redirect_from: [],
      label_products: c.product_ids.length + c.custom_product_ids.length,
      rich_text_source: 'none',
      hero_image: c.thumbnail_url,
      conflicts: [],
    });
  }

  const redirects = planRedirectUpserts(state.redirects, incoming);
  for (const cf of redirects.conflicts)
    warnings.push({
      code: cf.code,
      slug: cf.to_path.replace(/^\//, ''),
      message: `${cf.from_path} → ${cf.to_path}`,
    });

  const counts: ConversionPlan['counts'] = {
    pages: { CREATE: 0, UNCHANGED: 0, SKIP: 0, CONFLICT: 0 },
    redirects: {
      create: redirects.items.filter((i) => i.action === 'CREATE').length,
      update: redirects.items.filter((i) => i.action === 'UPDATE').length,
      unchanged: redirects.items.filter((i) => i.action === 'UNCHANGED').length,
      repointed: redirects.repoints.length,
      conflicts: redirects.conflicts.length,
    },
    menu_items: 0,
    primaries: { repicked: 0, cleared: 0 },
    links_added: 0,
  };
  for (const it of items) {
    counts.pages[it.action] += 1;
    counts.menu_items += it.menu_items.length;
    counts.links_added += it.links_added.length;
    for (const p of it.primaries)
      if (p.to) counts.primaries.repicked += 1;
      else counts.primaries.cleared += 1;
  }

  const fingerprint = hashOf({
    store: state.storeId,
    input,
    items: items.map((it) => ({
      ref: it.external_ref,
      action: it.action,
      page_id: it.page_id,
      source_hash: it.source_hash,
      page: it.page,
      links: it.links_added,
      primaries: it.primaries,
      menu_items: it.menu_items,
    })),
    redirects,
  });

  return {
    input,
    parent: parent ? { id: parent.id, slug: parent.slug } : null,
    items,
    redirects,
    blockers,
    warnings,
    fingerprint,
    counts,
  };
}
