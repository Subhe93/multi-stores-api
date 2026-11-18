/**
 * Query normalisation and ordering of GET /storefront/:slug/products
 * (`limit`, opt-in `page`, `sort`). Pure: no Prisma, no Nest.
 *
 * Modes:
 * - `all`: neither `page` nor a valid `limit` — the documented full list,
 *   unchanged (plain array, `sort` ignored).
 * - `limit`: a valid `limit` without `page` — the first N of the same
 *   order, still a plain array.
 * - `paged`: `page` present — `{ items, total, page, limit, has_more }`.
 *
 * No value ever produces a 400: invalid input falls back to a default.
 */

import {
  compareManualOrder,
  type ProductOrderKind,
} from '../creator-categories/product-order';

export const LIST_LIMIT_MAX = 100;
export const LIST_PAGE_SIZE_DEFAULT = 24;
export const LIST_PAGE_MAX = 1000;
export const LIST_SORTS = [
  'newest',
  'price_asc',
  'price_desc',
  'name',
] as const;
export type ListSort = (typeof LIST_SORTS)[number];

export type ListQuery =
  | { mode: 'all' }
  | { mode: 'limit'; offset: 0; limit: number; sort?: ListSort }
  | {
      mode: 'paged';
      page: number;
      limit: number;
      offset: number;
      sort?: ListSort;
    };

export type WindowQuery = Exclude<ListQuery, { mode: 'all' }>;

export interface ProductsPage<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  has_more: boolean;
}

/**
 * An integer number, or a string of 1 to 9 digits (after trim); anything
 * else (array, '', '1.5', '-1', 'abc') is undefined.
 */
export function toInt(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isInteger(v) ? v : undefined;
  if (typeof v === 'string') {
    const s = v.trim();
    return /^\d{1,9}$/.test(s) ? Number(s) : undefined;
  }
  return undefined;
}

function present(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

function toSort(v: unknown): ListSort | undefined {
  return typeof v === 'string' && (LIST_SORTS as readonly string[]).includes(v)
    ? (v as ListSort)
    : undefined;
}

export function normalizeListQuery(raw: {
  page?: unknown;
  limit?: unknown;
  sort?: unknown;
}): ListQuery {
  const rawLimit = toInt(raw.limit);
  const limit =
    rawLimit !== undefined && rawLimit >= 1
      ? Math.min(rawLimit, LIST_LIMIT_MAX)
      : undefined;
  const sort = toSort(raw.sort);
  if (present(raw.page)) {
    const rawPage = toInt(raw.page);
    const page =
      rawPage !== undefined && rawPage >= 1
        ? Math.min(rawPage, LIST_PAGE_MAX)
        : 1;
    const size = limit ?? LIST_PAGE_SIZE_DEFAULT;
    return {
      mode: 'paged',
      page,
      limit: size,
      offset: (page - 1) * size,
      ...(sort ? { sort } : {}),
    };
  }
  if (limit !== undefined) {
    return { mode: 'limit', offset: 0, limit, ...(sort ? { sort } : {}) };
  }
  return { mode: 'all' };
}

/** The empty answer of a mode: `[]`, or an empty page with total 0. */
export function emptyListResult(q: ListQuery): never[] | ProductsPage<never> {
  if (q.mode !== 'paged') return [];
  return { items: [], total: 0, page: q.page, limit: q.limit, has_more: false };
}

/** Wrap a window of items as the paged answer. */
export function toProductsPage<T>(
  q: Extract<ListQuery, { mode: 'paged' }>,
  items: T[],
  total: number,
): ProductsPage<T> {
  return {
    items,
    total,
    page: q.page,
    limit: q.limit,
    has_more: q.page * q.limit < total,
  };
}

// ── Ordering ──────────────────────────────────────────────

/** Light key of one listed product (own `p` or custom `cp`). */
export interface ListKey {
  kind: ProductOrderKind;
  id: string;
  created_at: Date;
  /** Product.base_price / CustomProduct.final_price, store currency. */
  price: number;
  /** Title in the requested locale (`sort=name` only). */
  title?: string;
}

export type ListComparator = (a: ListKey, b: ListKey) => number;

const time = (d: Date) => new Date(d).getTime();
const byKind = (a: ListKey, b: ListKey) =>
  a.kind === b.kind ? 0 : a.kind === 'p' ? -1 : 1;
const byId = (a: ListKey, b: ListKey) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Common tail T: newest first, then own before custom, then id. */
export const compareTail: ListComparator = (a, b) =>
  time(b.created_at) - time(a.created_at) || byKind(a, b) || byId(a, b);

/**
 * Default order of a plain list (no collection or a TAGS one, with or
 * without search): own products first, then custom, each newest first,
 * then id. Equals today's full list whenever `created_at` values differ.
 */
export const compareDefault: ListComparator = (a, b) =>
  byKind(a, b) || time(b.created_at) - time(a.created_at) || byId(a, b);

/** Stored base price (store currency), then T. */
export function comparePrice(dir: 'asc' | 'desc'): ListComparator {
  return (a, b) =>
    (dir === 'asc' ? a.price - b.price : b.price - a.price) ||
    compareTail(a, b);
}

/** Title (locale collation, empty titles last), then T. */
export function compareName(locale?: string): ListComparator {
  const collator = new Intl.Collator(locale || 'en', {
    sensitivity: 'base',
    numeric: true,
  });
  return (a, b) => {
    const at = a.title ?? '';
    const bt = b.title ?? '';
    if (!at !== !bt) return at ? -1 : 1;
    return collator.compare(at, bt) || compareTail(a, b);
  };
}

/**
 * MANUAL collection default order (compareManualOrder unchanged: link
 * sort_order, missing link last, then newest, own before custom, id).
 */
export function compareManual(sortOf: Map<string, number>): ListComparator {
  const key = (k: ListKey) => ({
    kind: k.kind,
    id: k.id,
    sort_order: sortOf.get(`${k.kind}:${k.id}`) ?? Number.MAX_SAFE_INTEGER,
    created_at: k.created_at,
  });
  return (a, b) => compareManualOrder(key(a), key(b));
}

const LOCALE_RE = /^[a-z]{2}(-[a-z]{2})?$/i;

/** The `locale` parameter when it is a plain locale code, else undefined. */
export function listLocale(v: unknown): string | undefined {
  return typeof v === 'string' && LOCALE_RE.test(v) ? v : undefined;
}

/**
 * Title used by `sort=name`: the translation in `locale`, else the one with
 * the smallest locale code; '' when there is none.
 */
export function titleFor(
  translations: { locale: string; title: string | null }[],
  locale?: string,
): string {
  if (!translations.length) return '';
  const exact = locale
    ? translations.find((t) => t.locale === locale)
    : undefined;
  if (exact) return exact.title ?? '';
  const first = [...translations].sort((a, b) =>
    a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0,
  )[0];
  return first.title ?? '';
}

/**
 * Per-source database order matching the comparator restricted to one
 * kind, for the orders read with `take` (default without a MANUAL
 * collection, newest, price). `priceField` is base_price (own) or
 * final_price (custom).
 */
export function sourceOrderBy<F extends string>(
  sort: ListSort | undefined,
  priceField: F,
):
  | [{ created_at: 'desc' }, { id: 'asc' }]
  | [Record<F, 'asc' | 'desc'>, { created_at: 'desc' }, { id: 'asc' }] {
  if (sort === 'price_asc' || sort === 'price_desc') {
    const dir = sort === 'price_asc' ? 'asc' : 'desc';
    return [
      { [priceField]: dir } as Record<F, 'asc' | 'desc'>,
      { created_at: 'desc' },
      { id: 'asc' },
    ];
  }
  return [{ created_at: 'desc' }, { id: 'asc' }];
}
