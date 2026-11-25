import { Prisma, ProductReviewStatus } from '@prisma/client';

// M171: selects and response shapes of the reviews module. The public shapes
// are built key by key from the selected columns (never a spread of a row),
// so a new column can never reach a public payload by accident.

// -- Public (storefront) -----------------------------------------------------

/** The only columns a public read may load. */
export const publicReviewSelect = {
  id: true,
  rating: true,
  title: true,
  body: true,
  display_name: true,
  locale: true,
  verified_purchase: true,
  published_at: true,
  reply_body: true,
  replied_at: true,
} satisfies Prisma.ProductReviewSelect;

export type PublicReviewRow = Prisma.ProductReviewGetPayload<{
  select: typeof publicReviewSelect;
}>;

export interface PublicReview {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  display_name: string;
  locale: string;
  verified: boolean;
  published_at: string | null;
  reply: { body: string; replied_at: string | null } | null;
}

export type RatingDistribution = Record<'1' | '2' | '3' | '4' | '5', number>;

export interface ReviewsSummary {
  /** Rounded to one decimal; 0 when there is no review. */
  average: number;
  count: number;
  distribution: RatingDistribution;
}

export interface PublicReviewsPage {
  summary: ReviewsSummary;
  items: PublicReview[];
  page: number;
  total: number;
  total_pages: number;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** A public row in its response form (exactly the documented keys). */
export function toPublicReview(row: PublicReviewRow): PublicReview {
  return {
    id: row.id,
    rating: row.rating,
    title: row.title,
    body: row.body,
    display_name: row.display_name,
    locale: row.locale,
    verified: row.verified_purchase,
    published_at: iso(row.published_at),
    reply: row.reply_body
      ? { body: row.reply_body, replied_at: iso(row.replied_at) }
      : null,
  };
}

/** Summary from the per-rating counts of one groupBy. */
export function summarize(
  groups: ReadonlyArray<{ rating: number; count: number }>,
): ReviewsSummary {
  const distribution: RatingDistribution = {
    '1': 0,
    '2': 0,
    '3': 0,
    '4': 0,
    '5': 0,
  };
  let count = 0;
  let sum = 0;
  for (const g of groups) {
    const key = String(g.rating);
    if (!(key in distribution)) continue;
    distribution[key as keyof RatingDistribution] += g.count;
    count += g.count;
    sum += g.rating * g.count;
  }
  return {
    average: count > 0 ? Math.round((sum / count) * 10) / 10 : 0,
    count,
    distribution,
  };
}

// -- Customer ----------------------------------------------------------------

/** The customer's own review, as the form prefills it. */
export const ownReviewSelect = {
  id: true,
  rating: true,
  title: true,
  body: true,
  display_name: true,
  status: true,
} satisfies Prisma.ProductReviewSelect;

export type OwnReviewRow = Prisma.ProductReviewGetPayload<{
  select: typeof ownReviewSelect;
}>;

export interface OwnReview {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  display_name: string;
  status: ProductReviewStatus;
}

export function toOwnReview(row: OwnReviewRow): OwnReview {
  return {
    id: row.id,
    rating: row.rating,
    title: row.title,
    body: row.body,
    display_name: row.display_name,
    status: row.status,
  };
}

/** Answer of the two write routes (`id: null` only for the honeypot). */
export interface SubmitReviewResult {
  id: string | null;
  status: ProductReviewStatus;
}

export interface ReviewEligibility {
  eligible: boolean;
  reason: null | 'NOT_PURCHASED';
  display_name_suggestion: string;
  review: OwnReview | null;
}

export interface OrderReviewItems {
  eligible: boolean;
  items: {
    order_item_id: string;
    product_id: string;
    review_status: ProductReviewStatus | null;
  }[];
}

export interface ReviewLinkContext {
  product: {
    id: string;
    translations: { locale: string; title: string; slug: string }[];
    image_url: string | null;
  };
  display_name_suggestion: string;
  /** No id: the link edits its own review only. */
  review: Omit<OwnReview, 'id'> | null;
  expires_at: string;
}

// -- Owner -------------------------------------------------------------------

const translationSelect = {
  locale: true,
  title: true,
  slug: true,
} as const;

const firstImage = {
  where: { variant_id: null },
  orderBy: [{ is_featured: 'desc' }, { sort_order: 'asc' }],
  take: 1,
  select: { url: true },
} satisfies Prisma.Product$imagesArgs;

/** Product facts shown next to a review (title, slug, thumbnail). */
export const reviewProductSelect = {
  id: true,
  creator_id: true,
  translations: { select: translationSelect },
  images: firstImage,
} satisfies Prisma.ProductSelect;

export const reviewCustomProductSelect = {
  id: true,
  creator_id: true,
  translations: { select: translationSelect },
  mockup_images: {
    orderBy: { sort_order: 'asc' },
    take: 1,
    select: { url: true },
  },
  // A custom product without mockups shows its base product's image.
  product: { select: { images: firstImage } },
} satisfies Prisma.CustomProductSelect;

export type ReviewProductRow = Prisma.ProductGetPayload<{
  select: typeof reviewProductSelect;
}>;
export type ReviewCustomProductRow = Prisma.CustomProductGetPayload<{
  select: typeof reviewCustomProductSelect;
}>;

/** Owner list / detail: no email, phone or address of the customer. */
export const ownerReviewSelect = {
  id: true,
  status: true,
  rating: true,
  title: true,
  body: true,
  display_name: true,
  locale: true,
  verified_purchase: true,
  source: true,
  created_at: true,
  updated_at: true,
  published_at: true,
  reply_body: true,
  replied_at: true,
  product: { select: reviewProductSelect },
  custom_product: { select: reviewCustomProductSelect },
  order: { select: { id: true, order_number: true } },
  customer: { select: { id: true, first_name: true, last_name: true } },
} satisfies Prisma.ProductReviewSelect;

export type OwnerReviewRow = Prisma.ProductReviewGetPayload<{
  select: typeof ownerReviewSelect;
}>;

export interface ReviewProductInfo {
  id: string;
  kind: 'product' | 'custom_product';
  title: string;
  slug: string;
  image_url: string | null;
}

export interface OwnerReview {
  id: string;
  status: ProductReviewStatus;
  rating: number;
  title: string | null;
  body: string;
  display_name: string;
  locale: string;
  verified: boolean;
  source: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  reply: { body: string; replied_at: string | null } | null;
  product: ReviewProductInfo | null;
  order: { id: string; order_number: string } | null;
  customer: { id: string; name: string };
}

/** The translation of the store primary locale, else English, else any. */
export function pickTranslation<T extends { locale: string }>(
  translations: readonly T[],
  primaryLocale: string | null | undefined,
): T | null {
  return (
    translations.find((t) => t.locale === primaryLocale) ??
    translations.find((t) => t.locale === 'en') ??
    translations[0] ??
    null
  );
}

export function productImageUrl(
  product: ReviewProductRow | ReviewCustomProductRow,
): string | null {
  if ('mockup_images' in product) {
    return (
      product.mockup_images[0]?.url ?? product.product.images[0]?.url ?? null
    );
  }
  return product.images[0]?.url ?? null;
}

export function toProductInfo(
  row: {
    product: ReviewProductRow | null;
    custom_product: ReviewCustomProductRow | null;
  },
  primaryLocale: string | null | undefined,
): ReviewProductInfo | null {
  const target = row.product ?? row.custom_product;
  if (!target) return null;
  const tr = pickTranslation(target.translations, primaryLocale);
  return {
    id: target.id,
    kind: row.product ? 'product' : 'custom_product',
    title: tr?.title ?? '',
    slug: tr?.slug ?? '',
    image_url: productImageUrl(target),
  };
}

export function toOwnerReview(
  row: OwnerReviewRow,
  primaryLocale: string | null | undefined,
): OwnerReview {
  return {
    id: row.id,
    status: row.status,
    rating: row.rating,
    title: row.title,
    body: row.body,
    display_name: row.display_name,
    locale: row.locale,
    verified: row.verified_purchase,
    source: row.source,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    published_at: iso(row.published_at),
    reply: row.reply_body
      ? { body: row.reply_body, replied_at: iso(row.replied_at) }
      : null,
    product: toProductInfo(row, primaryLocale),
    order: row.order
      ? { id: row.order.id, order_number: row.order.order_number }
      : null,
    customer: {
      id: row.customer.id,
      name: `${row.customer.first_name} ${row.customer.last_name}`.trim(),
    },
  };
}

export interface OwnerReviewsPage {
  items: OwnerReview[];
  total: number;
  page: number;
  limit: number;
  counts: Record<ProductReviewStatus, number>;
}

export interface ReviewLinkRow {
  order_item_id: string;
  product_title: string;
  url: string;
  expires_at: string;
  review_status: ProductReviewStatus | null;
}
