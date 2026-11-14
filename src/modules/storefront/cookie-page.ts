import { PageType, Prisma } from '@prisma/client';

/**
 * Slugs the storefront treats as "the store's cookie page" (consent v2: the
 * cookie banner and the settings dialog link to it). Order is preference.
 * Must stay identical to COOKIE_POLICY_SLUGS in multi-stores-web
 * src/lib/consent.ts.
 */
export const COOKIE_POLICY_SLUGS = [
  'om-cookies',
  'cookies',
  'cookie-policy',
  'cookiepolicy',
] as const;

/** Visitor-facing builder (v2) page types served at a root slug. */
export const COOKIE_PAGE_TYPES: PageType[] = [PageType.STATIC, PageType.LANDING];

export const cookiePageSelect = {
  slug: true,
} satisfies Prisma.PageSelect;

/** Builder (v2) pages that can be the cookie page: live and slugged. */
export function cookiePageWhere(storeId: string): Prisma.PageWhereInput {
  return {
    store_id: storeId,
    type: { in: COOKIE_PAGE_TYPES },
    slug: { in: [...COOKIE_POLICY_SLUGS] },
    // "Live" for v2 means a published snapshot exists (see getPublishedPage).
    published_version_id: { not: null },
  };
}

/**
 * The cookie page slug among the store's published pages, preferring the
 * COOKIE_POLICY_SLUGS order. `v2Slugs` are published builder pages (any
 * visitor-facing type), `legacySlugs` are PUBLISHED legacy static pages;
 * both are candidates since either serves at /{slug}.
 */
export function resolveCookiePageSlug(
  v2Slugs: ReadonlyArray<string | null>,
  legacySlugs: ReadonlyArray<string | null>,
): string | null {
  const live = new Set<string>();
  for (const s of [...v2Slugs, ...legacySlugs]) if (s) live.add(s);
  return COOKIE_POLICY_SLUGS.find((s) => live.has(s)) ?? null;
}
