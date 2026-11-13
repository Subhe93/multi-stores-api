/**
 * Pure helpers for the page-section tree (layout containers).
 *
 * Sections are stored flat with an optional `parent_id`. Only the layout
 * container sections may be parents, nesting is at most MAX_SECTION_DEPTH
 * levels deep (root = depth 1; containers only at depth 1..MAX-1) and
 * `sort_order` is scoped to siblings (same parent_id). No Prisma / Nest
 * imports here so the rules are unit-testable and shareable.
 */

/** Section keys that may hold child sections. */
export const CONTAINER_SECTION_KEYS: readonly string[] = [
  'layout-row',
  'layout-column',
  'layout-grid',
];

/** Root = depth 1; a leaf may sit at depth 3, a container at most at 2. */
export const MAX_SECTION_DEPTH = 3;

/**
 * Page types whose builder may use layout containers. Product template only
 * for now; widen this list to roll containers out to more page types.
 */
export const CONTAINER_PAGE_TYPES: readonly string[] = ['PRODUCT_TEMPLATE'];

export function isContainerSectionKey(key: string | null | undefined): boolean {
  return !!key && CONTAINER_SECTION_KEYS.includes(key);
}

export function containersAllowedOnPage(
  pageType: string | null | undefined,
): boolean {
  return !!pageType && CONTAINER_PAGE_TYPES.includes(pageType);
}

export interface SectionTreeNode {
  id: string;
  section_key: string;
  parent_id?: string | null;
}

export type SectionTreeErrorCode =
  | 'PAGE_SECTION_IDS_INVALID'
  | 'PAGE_SECTION_PARENT_INVALID'
  | 'PAGE_SECTION_PARENT_NOT_CONTAINER'
  | 'PAGE_SECTION_TREE_CYCLE'
  | 'PAGE_SECTION_TREE_TOO_DEEP'
  | 'PAGE_SECTION_CONTAINER_NOT_ALLOWED'
  | 'PAGE_SECTION_LAYOUT_BLOCKS_DISABLED';

export interface SectionTreeError {
  code: SectionTreeErrorCode;
  message: string;
  section_id?: string;
}

/**
 * Validates a complete section list of one page as a tree. Returns the first
 * problem found, or null when the tree is valid:
 * - container keys only on pages that allow containers;
 * - every parent_id points at a section of the same list;
 * - parents are containers;
 * - no cycles (incl. a section as its own parent);
 * - depth: leaves <= MAX_SECTION_DEPTH, containers <= MAX_SECTION_DEPTH - 1.
 */
export function validateSectionTree(
  nodes: readonly SectionTreeNode[],
  pageType: string | null | undefined,
): SectionTreeError | null {
  const byId = new Map<string, SectionTreeNode>();
  for (const n of nodes) {
    if (byId.has(n.id)) {
      return {
        code: 'PAGE_SECTION_IDS_INVALID',
        message: `Section ${n.id} is listed more than once`,
        section_id: n.id,
      };
    }
    byId.set(n.id, n);
  }

  const allowContainers = containersAllowedOnPage(pageType);
  for (const n of nodes) {
    if (!allowContainers && isContainerSectionKey(n.section_key)) {
      return {
        code: 'PAGE_SECTION_CONTAINER_NOT_ALLOWED',
        message: `Layout containers are not available on ${pageType ?? 'this'} pages`,
        section_id: n.id,
      };
    }
    const parentId = n.parent_id ?? null;
    if (parentId === null) continue;
    if (parentId === n.id) {
      return {
        code: 'PAGE_SECTION_TREE_CYCLE',
        message: `Section ${n.id} cannot be its own parent`,
        section_id: n.id,
      };
    }
    const parent = byId.get(parentId);
    if (!parent) {
      return {
        code: 'PAGE_SECTION_PARENT_INVALID',
        message: `Parent ${parentId} of section ${n.id} is not on this page`,
        section_id: n.id,
      };
    }
    if (!isContainerSectionKey(parent.section_key)) {
      return {
        code: 'PAGE_SECTION_PARENT_NOT_CONTAINER',
        message: `Section ${parent.id} (${parent.section_key}) cannot hold sections`,
        section_id: n.id,
      };
    }
  }

  // Depth + cycles: walk up from every node, bounded by the list size.
  for (const n of nodes) {
    let depth = 1;
    let cursor = n.parent_id ?? null;
    const seen = new Set<string>([n.id]);
    while (cursor !== null) {
      if (seen.has(cursor)) {
        return {
          code: 'PAGE_SECTION_TREE_CYCLE',
          message: `Section ${n.id} is nested inside itself`,
          section_id: n.id,
        };
      }
      seen.add(cursor);
      depth++;
      cursor = byId.get(cursor)?.parent_id ?? null;
    }
    const limit = isContainerSectionKey(n.section_key)
      ? MAX_SECTION_DEPTH - 1
      : MAX_SECTION_DEPTH;
    if (depth > limit) {
      return {
        code: 'PAGE_SECTION_TREE_TOO_DEEP',
        message: `Section ${n.id} is nested too deep (max ${MAX_SECTION_DEPTH} levels)`,
        section_id: n.id,
      };
    }
  }
  return null;
}

export interface TreeReorderItem {
  id: string;
  parent_id?: string | null;
  sort_order: number;
}

/**
 * Validates a tree-reorder payload against the page's current sections:
 * the payload must list exactly the page's sections (no foreign, missing or
 * duplicate ids), and the resulting tree must be valid.
 */
export function validateTreeReorder(
  existing: readonly { id: string; section_key: string }[],
  items: readonly TreeReorderItem[],
  pageType: string | null | undefined,
): SectionTreeError | null {
  const keyById = new Map(existing.map((s) => [s.id, s.section_key]));
  const seen = new Set<string>();
  for (const it of items) {
    if (!keyById.has(it.id) || seen.has(it.id)) {
      return {
        code: 'PAGE_SECTION_IDS_INVALID',
        message: 'items must list every section of this page exactly once',
        section_id: it.id,
      };
    }
    seen.add(it.id);
  }
  if (seen.size !== keyById.size) {
    return {
      code: 'PAGE_SECTION_IDS_INVALID',
      message: 'items must list every section of this page exactly once',
    };
  }
  return validateSectionTree(
    items.map((it) => ({
      id: it.id,
      parent_id: it.parent_id ?? null,
      section_key: keyById.get(it.id) as string,
    })),
    pageType,
  );
}

/**
 * Depth of a would-be child of `parentId` (root = 1), or null when the parent
 * chain is broken / cyclic.
 */
export function depthUnder(
  nodes: readonly SectionTreeNode[],
  parentId: string | null,
): number | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let depth = 1;
  let cursor = parentId;
  const seen = new Set<string>();
  while (cursor !== null) {
    const node = byId.get(cursor);
    if (!node || seen.has(cursor)) return null;
    seen.add(cursor);
    depth++;
    cursor = node.parent_id ?? null;
  }
  return depth;
}

interface OrderableNode {
  id?: string;
  parent_id?: string | null;
  sort_order: number;
}

/**
 * Orders a flat section list depth-first (pre-order): root sections by
 * sort_order, each followed by its descendants, siblings by sort_order
 * (stable for ties). Sections whose parent is not in the list are dropped,
 * as are cycles. For a list without parents the result equals a stable sort
 * by sort_order.
 */
export function orderSectionsAsTree<T extends OrderableNode>(
  rows: readonly T[],
): T[] {
  const ids = new Set(rows.map((r) => r.id).filter((id): id is string => !!id));
  const childrenOf = new Map<string | null, T[]>();
  for (const r of rows) {
    const parent = r.parent_id ?? null;
    if (parent !== null && !ids.has(parent)) continue; // orphan
    const list = childrenOf.get(parent) ?? [];
    list.push(r);
    childrenOf.set(parent, list);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.sort_order - b.sort_order);
  }
  const out: T[] = [];
  const visited = new Set<string>();
  const walk = (parent: string | null) => {
    for (const r of childrenOf.get(parent) ?? []) {
      if (r.id) {
        if (visited.has(r.id)) continue;
        visited.add(r.id);
      }
      out.push(r);
      if (r.id) walk(r.id);
    }
  };
  walk(null);
  return out;
}

/** Drops hidden sections together with all their descendants. */
export function dropHiddenSubtrees<
  T extends { id: string; parent_id?: string | null; is_hidden?: boolean },
>(rows: readonly T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const isHidden = (r: T): boolean => {
    const seen = new Set<string>();
    let cursor: T | undefined = r;
    while (cursor) {
      if (cursor.is_hidden || seen.has(cursor.id)) return true;
      seen.add(cursor.id);
      const parentId: string | null = cursor.parent_id ?? null;
      if (parentId === null) return false;
      // A missing parent (e.g. filtered out upstream) hides the child too.
      cursor = byId.get(parentId);
      if (!cursor) return true;
    }
    return false;
  };
  return rows.filter((r) => !isHidden(r));
}

/** Ids of `rootId` and all its descendants, root first (pre-order). */
export function subtreeIds(
  rows: readonly {
    id: string;
    parent_id?: string | null;
    sort_order: number;
  }[],
  rootId: string,
): string[] {
  const root = rows.find((r) => r.id === rootId);
  if (!root) return [];
  const out = [rootId];
  const seen = new Set(out);
  const walk = (parent: string) => {
    const kids = rows
      .filter((r) => (r.parent_id ?? null) === parent)
      .sort((a, b) => a.sort_order - b.sort_order);
    for (const k of kids) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      out.push(k.id);
      walk(k.id);
    }
  };
  walk(rootId);
  return out;
}

/**
 * Number of content (non-container) sections, e.g. for "does this page have
 * content" checks. Accepts unknown snapshot entries.
 */
export function countLeafSections(sections: readonly unknown[]): number {
  let n = 0;
  for (const s of sections) {
    const key =
      s && typeof s === 'object'
        ? (s as { section_key?: unknown }).section_key
        : undefined;
    if (typeof key === 'string' && isContainerSectionKey(key)) continue;
    n++;
  }
  return n;
}

// ── Per-store feature flag: product layout blocks ─────────────────────────

/**
 * Product block section keys added with the layout containers (product
 * layout waves 2-3). The older product sections (product-page, product-gallery,
 * product-details, add-to-cart, product-tabs) are deliberately not listed:
 * they stay available on every store.
 */
export const PRODUCT_LAYOUT_BLOCK_KEYS: readonly string[] = [
  'product-breadcrumb',
  'product-title',
  'product-price',
  'product-short-description',
  'product-promotions',
  'product-bundles',
  'product-variants',
  'product-personalization',
  'product-buy',
  'product-trust',
  'product-shipping',
];

/** Store app (shared registry key) that unlocks containers + product blocks. */
export const PRODUCT_LAYOUT_APP_KEY = 'product_layout' as const;

/** True for keys that need the `product_layout` app: containers + new blocks. */
export function requiresProductLayoutApp(
  key: string | null | undefined,
): boolean {
  return (
    !!key &&
    (isContainerSectionKey(key) || PRODUCT_LAYOUT_BLOCK_KEYS.includes(key))
  );
}

function layoutBlocksDisabled(
  message: string,
  sectionId?: string,
): SectionTreeError {
  return {
    code: 'PAGE_SECTION_LAYOUT_BLOCKS_DISABLED',
    message,
    ...(sectionId ? { section_id: sectionId } : {}),
  };
}

/**
 * Gate for creating one section while the store's `product_layout` app is
 * off: no container, no new product block and no parent. Null = allowed
 * (always null when the app is on).
 */
export function layoutBlocksCreateError(
  input: { section_key: string; parent_id?: string | null },
  appEnabled: boolean,
): SectionTreeError | null {
  if (appEnabled) return null;
  if (requiresProductLayoutApp(input.section_key)) {
    return layoutBlocksDisabled(
      `"${input.section_key}" needs the product layout blocks app, which is off for this store`,
    );
  }
  if ((input.parent_id ?? null) !== null) {
    return layoutBlocksDisabled(
      'Placing sections inside layout containers needs the product layout blocks app, which is off for this store',
    );
  }
  return null;
}

/**
 * Gate for copying sections (subtree duplicate) while the app is off: the
 * copy would create containers / new product blocks. Null = allowed.
 */
export function layoutBlocksCopyError(
  nodes: readonly { id: string; section_key: string }[],
  appEnabled: boolean,
): SectionTreeError | null {
  if (appEnabled) return null;
  const gated = nodes.find((n) => requiresProductLayoutApp(n.section_key));
  return gated
    ? layoutBlocksDisabled(
        `"${gated.section_key}" needs the product layout blocks app, which is off for this store`,
        gated.id,
      )
    : null;
}

/**
 * Gate for a tree reorder while the app is off: a section may keep its
 * current parent (already-saved nesting keeps working and can be reordered)
 * or move to the root, but never gain a new parent. Null = allowed.
 */
export function layoutBlocksReorderError(
  existing: readonly { id: string; parent_id?: string | null }[],
  items: readonly TreeReorderItem[],
  appEnabled: boolean,
): SectionTreeError | null {
  if (appEnabled) return null;
  const parentOf = new Map(existing.map((s) => [s.id, s.parent_id ?? null]));
  for (const it of items) {
    const next = it.parent_id ?? null;
    if (next === null) continue;
    if (parentOf.get(it.id) === next) continue;
    return layoutBlocksDisabled(
      'Moving sections into layout containers needs the product layout blocks app, which is off for this store',
      it.id,
    );
  }
  return null;
}
