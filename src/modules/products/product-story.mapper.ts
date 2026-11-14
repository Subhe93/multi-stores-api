import type { Prisma, ProductStory } from '@prisma/client';

/** One locale of a customer story on the wire (customer-stories contract 2). */
export interface ProductStoryTranslationOut {
  locale: string;
  /** Plain text, may be ''. */
  quote: string;
  subtitle: string | null;
}

/**
 * Wire shape of a customer story: the same in the editor GET, the storefront
 * payloads and the save input.
 */
export interface ProductStoryOut {
  id: string;
  kind: 'image' | 'file' | 'youtube' | 'vimeo';
  /** image/file: relative `/uploads/...`; external: canonical watch URL. */
  url: string;
  /** Video poster (relative); always null for 'image'. */
  poster_url: string | null;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  name: string;
  /** 1..5 or null. */
  rating: number | null;
  verified: boolean;
  /** Muted autoplay of a video story; always false for 'image'. */
  autoplay: boolean;
  /** Loop the autoplaying story video; always false for 'image'. */
  loop: boolean;
  /** Sorted by locale asc. */
  translations: ProductStoryTranslationOut[];
}

/** Prisma include fragment for `stories` on a Product. */
export const PRODUCT_STORIES_INCLUDE = {
  orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
  include: {
    translations: {
      select: { locale: true, quote: true, subtitle: true },
      orderBy: { locale: 'asc' },
    },
  },
} as const satisfies Prisma.Product$storiesArgs;

type ProductStoryRow = Pick<
  ProductStory,
  | 'id'
  | 'kind'
  | 'url'
  | 'poster_url'
  | 'duration_s'
  | 'width'
  | 'height'
  | 'name'
  | 'rating'
  | 'verified'
> &
  Partial<Pick<ProductStory, 'sort_order' | 'autoplay' | 'loop'>> & {
    translations?: readonly ProductStoryTranslationOut[] | null;
  };

export function toProductStoryOut(row: ProductStoryRow): ProductStoryOut {
  const kind = String(row.kind).toLowerCase() as ProductStoryOut['kind'];
  const isImage = kind === 'image';
  return {
    id: row.id,
    kind,
    url: row.url,
    poster_url: row.poster_url ?? null,
    duration_s: row.duration_s ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    name: row.name,
    rating: row.rating ?? null,
    verified: row.verified === true,
    autoplay: isImage ? false : (row.autoplay ?? false),
    loop: isImage ? false : (row.loop ?? false),
    translations: [...(row.translations ?? [])]
      .sort((a, b) => (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0))
      .map((t) => ({
        locale: t.locale,
        quote: t.quote ?? '',
        subtitle: t.subtitle ?? null,
      })),
  };
}

/**
 * Maps rows in display order (sort_order, then id). Rows are sorted here too
 * so a caller that forgot the include orderBy still gets the contract order.
 */
export function toProductStoriesOut(
  rows: readonly ProductStoryRow[] | null | undefined,
): ProductStoryOut[] {
  if (!rows?.length) return [];
  return [...rows]
    .sort(
      (a, b) =>
        (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map(toProductStoryOut);
}

/**
 * Storefront omission rule (Namez byte-identity): `{ stories }` only when
 * there is at least one story, otherwise an empty object to spread.
 */
export function storefrontStoriesField(
  rows: readonly ProductStoryRow[] | null | undefined,
): { stories?: ProductStoryOut[] } {
  const stories = toProductStoriesOut(rows);
  return stories.length ? { stories } : {};
}
