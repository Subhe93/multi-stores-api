import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Manual product order of a MANUAL collection. Own products
 * (ProductCreatorCategory) and custom products (CustomProductCreatorCategory)
 * share one `sort_order` index space so the two kinds can interleave. The
 * dashboard sends and reads the order as tokens: `p:<productId>` and
 * `cp:<customProductId>`.
 */

export type ProductOrderKind = 'p' | 'cp';

export interface OrderedLink {
  id: string;
  sort_order: number;
}

export interface DatedLink extends OrderedLink {
  created_at: Date | string | null | undefined;
}

export function productOrderToken(kind: ProductOrderKind, id: string): string {
  return `${kind}:${id}`;
}

/** Index of each token in `order` (first occurrence wins on duplicates). */
export function productOrderIndex(order: string[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const token of order) {
    if (!index.has(token)) index.set(token, index.size);
  }
  return index;
}

/**
 * New sort_order of every link: a link named in `order` gets its index there
 * (first occurrence wins on duplicates); the links it leaves out follow, own
 * ones first then custom ones, each in their current sort_order (stable).
 */
export function computeLinkSortOrders(
  order: string[],
  ownLinks: OrderedLink[],
  customLinks: OrderedLink[],
): { own: Map<string, number>; custom: Map<string, number> } {
  const index = productOrderIndex(order);
  const own = new Map<string, number>();
  const custom = new Map<string, number>();
  const restOwn: OrderedLink[] = [];
  const restCustom: OrderedLink[] = [];
  for (const l of ownLinks) {
    const i = index.get(productOrderToken('p', l.id));
    if (i === undefined) restOwn.push(l);
    else own.set(l.id, i);
  }
  for (const l of customLinks) {
    const i = index.get(productOrderToken('cp', l.id));
    if (i === undefined) restCustom.push(l);
    else custom.set(l.id, i);
  }
  let next = index.size;
  const byCurrent = (a: OrderedLink, b: OrderedLink) =>
    a.sort_order - b.sort_order;
  for (const l of [...restOwn].sort(byCurrent)) own.set(l.id, next++);
  for (const l of [...restCustom].sort(byCurrent)) custom.set(l.id, next++);
  return { own, custom };
}

function time(d: Date | string | null | undefined): number {
  if (!d) return 0;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Comparator of the manual collection order: link sort_order ascending, then
 * newest product first, then own before custom, then id (fully stable).
 */
export function compareManualOrder(
  a: {
    kind: ProductOrderKind;
    id: string;
    sort_order: number;
    created_at?: Date | string | null;
  },
  b: {
    kind: ProductOrderKind;
    id: string;
    sort_order: number;
    created_at?: Date | string | null;
  },
): number {
  return (
    a.sort_order - b.sort_order ||
    time(b.created_at) - time(a.created_at) ||
    (a.kind === b.kind ? 0 : a.kind === 'p' ? -1 : 1) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Merged order tokens of a collection's links (same order as the storefront). */
export function mergedProductOrder(
  ownLinks: DatedLink[],
  customLinks: DatedLink[],
): string[] {
  return [
    ...ownLinks.map((l) => ({ kind: 'p' as const, ...l })),
    ...customLinks.map((l) => ({ kind: 'cp' as const, ...l })),
  ]
    .sort(compareManualOrder)
    .map((l) => productOrderToken(l.kind, l.id));
}

/**
 * Sort order for a link newly added to each of `categoryIds` (from a product
 * editor): one past the highest sort_order of that collection across BOTH
 * link tables, so the product lands at the end of a manual collection.
 * An empty collection starts at 0.
 */
export async function nextCollectionSortOrders(
  prisma: Pick<
    PrismaService,
    'productCreatorCategory' | 'customProductCreatorCategory'
  >,
  categoryIds: string[],
): Promise<Map<string, number>> {
  const next = new Map<string, number>(categoryIds.map((id) => [id, 0]));
  if (!categoryIds.length) return next;
  const where = { creator_category_id: { in: categoryIds } };
  const [own, custom] = await Promise.all([
    prisma.productCreatorCategory.groupBy({
      by: ['creator_category_id'],
      where,
      _max: { sort_order: true },
    }),
    prisma.customProductCreatorCategory.groupBy({
      by: ['creator_category_id'],
      where,
      _max: { sort_order: true },
    }),
  ]);
  for (const row of [...own, ...custom]) {
    const max = row._max.sort_order;
    if (max == null) continue;
    next.set(
      row.creator_category_id,
      Math.max(next.get(row.creator_category_id) ?? 0, max + 1),
    );
  }
  return next;
}
