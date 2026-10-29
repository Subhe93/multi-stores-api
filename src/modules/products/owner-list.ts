import { Prisma } from '@prisma/client';

// Dashboard product list (`GET /products/mine`): the extra filters and sort
// orders an owner gets on top of the shared catalogue filters.

export const OWNER_LIST_SORTS = [
  'newest',
  'oldest',
  'updated',
  'title_asc',
  'title_desc',
  'price_asc',
  'price_desc',
] as const;
export type OwnerListSort = (typeof OWNER_LIST_SORTS)[number];

export const OWNER_LIST_STOCK = ['in_stock', 'out_of_stock'] as const;
export type OwnerListStock = (typeof OWNER_LIST_STOCK)[number];

/** `collection` value that selects products linked to no collection. */
export const NO_COLLECTION = 'none';

export const OWNER_LIST_MAX_LIMIT = 100;

export function parseSort(raw?: string): OwnerListSort {
  return (OWNER_LIST_SORTS as readonly string[]).includes(raw ?? '')
    ? (raw as OwnerListSort)
    : 'newest';
}

export function parseStock(raw?: string): OwnerListStock | undefined {
  return (OWNER_LIST_STOCK as readonly string[]).includes(raw ?? '')
    ? (raw as OwnerListStock)
    : undefined;
}

export function clampLimit(raw?: number): number {
  if (!raw || !Number.isFinite(raw) || raw < 1) return 20;
  return Math.min(Math.floor(raw), OWNER_LIST_MAX_LIMIT);
}

/**
 * Out of stock = what checkout would refuse: a product without active
 * variants that tracks inventory with a stock of 0 or less, or a product
 * whose every active variant has a tracked stock of 0 or less (a variant
 * with a null stock is unlimited).
 */
export function outOfStockWhere(): Prisma.ProductWhereInput {
  return {
    OR: [
      {
        track_inventory: true,
        // Explicit not-null: SQL NULL <= 0 is NULL, and NOT(NULL) would drop
        // a tracked product without a stock number from "in stock" too.
        stock_quantity: { not: null, lte: 0 },
        variants: { none: { is_active: true } },
      },
      {
        variants: { some: { is_active: true } },
        NOT: {
          variants: {
            some: {
              is_active: true,
              OR: [{ stock_quantity: null }, { stock_quantity: { gt: 0 } }],
            },
          },
        },
      },
    ],
  };
}

export function stockWhere(
  stock?: OwnerListStock,
): Prisma.ProductWhereInput | undefined {
  if (stock === 'out_of_stock') return outOfStockWhere();
  if (stock === 'in_stock') return { NOT: outOfStockWhere() };
  return undefined;
}

/** Membership of one collection, by the same rule as the storefront listing. */
export function collectionWhere(collection: {
  id: string;
  match_rule: string;
  match_tags: string[];
}): Prisma.ProductWhereInput {
  if (collection.match_rule === 'TAGS') {
    // An empty tag rule lists nothing on the storefront either.
    return collection.match_tags.length
      ? { tags: { some: { tag: { in: collection.match_tags } } } }
      : { id: { in: [] } };
  }
  return {
    creator_categories: { some: { creator_category_id: collection.id } },
  };
}

/**
 * Products listed by no collection: no manual link rows and none of the tags
 * used by the store's tag-rule collections.
 */
export function noCollectionWhere(
  tagRuleTags: string[],
): Prisma.ProductWhereInput {
  return tagRuleTags.length
    ? {
        creator_categories: { none: {} },
        NOT: { tags: { some: { tag: { in: tagRuleTags } } } },
      }
    : { creator_categories: { none: {} } };
}

/** Query-string value, or undefined when absent or repeated (array). */
export function single(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Title, SKU (product or variant) or slug containing the query. */
export function searchWhere(
  search: string,
): Prisma.ProductWhereInput | undefined {
  const q = search.trim();
  if (!q) return undefined;
  const contains = { contains: q, mode: 'insensitive' as const };
  return {
    OR: [
      { translations: { some: { title: contains } } },
      { translations: { some: { slug: contains } } },
      { sku: contains },
      { variants: { some: { sku: contains } } },
    ],
  };
}

/** Column order for every sort except the title ones (see `sortByTitle`). */
export function orderByFor(
  sort: OwnerListSort,
): Prisma.ProductOrderByWithRelationInput[] {
  switch (sort) {
    case 'oldest':
      return [{ created_at: 'asc' }, { id: 'asc' }];
    case 'updated':
      return [{ updated_at: 'desc' }, { id: 'asc' }];
    case 'price_asc':
      return [{ base_price: 'asc' }, { created_at: 'desc' }, { id: 'asc' }];
    case 'price_desc':
      return [{ base_price: 'desc' }, { created_at: 'desc' }, { id: 'asc' }];
    default:
      return [{ created_at: 'desc' }, { id: 'asc' }];
  }
}

/**
 * The title the dashboard shows for a product: the English translation,
 * else the first one (same rule as the list page).
 */
export function displayTitle(
  translations: { locale: string; title: string }[],
): string {
  return (
    (translations.find((t) => t.locale === 'en') ?? translations[0])?.title ??
    ''
  );
}

/**
 * Product ids ordered by display title. Titles live in a one-to-many
 * relation, which Prisma cannot order by, so the (small) id/title list of
 * the matching products is sorted in memory with a locale-aware collator.
 */
export function sortByTitle(
  rows: { id: string; translations: { locale: string; title: string }[] }[],
  dir: 'asc' | 'desc',
  locale = 'sv',
): string[] {
  const collator = new Intl.Collator(locale, {
    sensitivity: 'base',
    numeric: true,
  });
  const sign = dir === 'asc' ? 1 : -1;
  return rows
    .map((r) => ({ id: r.id, title: displayTitle(r.translations) }))
    .sort(
      (a, b) =>
        sign * collator.compare(a.title, b.title) || (a.id < b.id ? -1 : 1),
    )
    .map((r) => r.id);
}
