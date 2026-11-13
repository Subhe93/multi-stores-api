import type { ProductVideo } from '@prisma/client';

/**
 * Wire shape of a product video (product-video contract section 2): the same
 * in the editor GET, the storefront payloads and the save input.
 */
export interface ProductVideoOut {
  id: string;
  kind: 'file' | 'youtube' | 'vimeo';
  /** file: relative `/uploads/products/<uuid>.mp4`; external: canonical watch URL. */
  url: string;
  poster_url: string | null;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  /** Product-level images shown before this video; always >= 1. */
  position: number;
  alt: string | null;
  /** ISO 8601 with "Z" (JSON-LD uploadDate). */
  created_at: string;
}

/** Row order used by every read: position, then the saved array index. */
export const PRODUCT_VIDEO_ORDER = [
  { position: 'asc' as const },
  { sort_order: 'asc' as const },
];

/** Prisma include fragment for `videos` on a Product. */
export const PRODUCT_VIDEOS_INCLUDE = { orderBy: PRODUCT_VIDEO_ORDER };

type ProductVideoRow = Pick<
  ProductVideo,
  | 'id'
  | 'kind'
  | 'url'
  | 'poster_url'
  | 'alt_text'
  | 'duration_s'
  | 'width'
  | 'height'
  | 'position'
  | 'created_at'
> &
  Partial<Pick<ProductVideo, 'sort_order'>>;

export function toProductVideoOut(row: ProductVideoRow): ProductVideoOut {
  return {
    id: row.id,
    kind: String(row.kind).toLowerCase() as ProductVideoOut['kind'],
    url: row.url,
    poster_url: row.poster_url ?? null,
    duration_s: row.duration_s ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    position: row.position,
    alt: row.alt_text ?? null,
    created_at: new Date(row.created_at).toISOString(),
  };
}

/**
 * Maps rows in display order (position, then sort_order). Rows are sorted
 * here too so a caller that forgot the include orderBy still gets the
 * contract order.
 */
export function toProductVideosOut(
  rows: readonly ProductVideoRow[] | null | undefined,
): ProductVideoOut[] {
  if (!rows?.length) return [];
  return [...rows]
    .sort(
      (a, b) =>
        a.position - b.position || (a.sort_order ?? 0) - (b.sort_order ?? 0),
    )
    .map(toProductVideoOut);
}

/**
 * Storefront omission rule (Namez byte-identity): `{ videos }` only when
 * there is at least one video, otherwise an empty object to spread.
 */
export function storefrontVideosField(
  rows: readonly ProductVideoRow[] | null | undefined,
): { videos?: ProductVideoOut[] } {
  const videos = toProductVideosOut(rows);
  return videos.length ? { videos } : {};
}
