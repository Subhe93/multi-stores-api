/*
 * Slug of a product link built by the API (Google feed, designer
 * `product_slug`), M164 part 3. Mirror of the web `productLinkSlug`
 * (multi-stores-web/src/lib/productPaths.ts) so every link the API emits is
 * the canonical URL of the page it opens and never goes through the
 * storefront's canonical redirect:
 *
 *  1. the usable slug of `locale`;
 *  2. the usable slug of `fallbackLocale` (market default, then store
 *     primary; a list is tried in order);
 *  3. the first usable slug in a stable order (locale ascending);
 *  null when no row has a usable slug.
 *
 * Pure: no Nest, no Prisma.
 */

/**
 * A slug that can be used in a product URL: at least one letter or digit in
 * any script. Empty or punctuation-only slugs (a stray "-") would 404.
 */
export function isUsableSlug(slug: string | null | undefined): slug is string {
  return !!slug && /[\p{L}\p{N}]/u.test(slug);
}

export interface ProductLinkSlugRow {
  locale: string;
  slug: string | null;
}

export function productLinkSlug(
  rows: readonly ProductLinkSlugRow[] | null | undefined,
  locale: string,
  fallbackLocale:
    | string
    | readonly (string | null | undefined)[]
    | null
    | undefined,
): string | null {
  const list = rows ?? [];
  const fallbacks = Array.isArray(fallbackLocale)
    ? fallbackLocale
    : [fallbackLocale];
  for (const want of [locale, ...fallbacks]) {
    if (!want) continue;
    const hit = list.find((r) => r.locale === want && isUsableSlug(r.slug));
    if (hit?.slug) return hit.slug;
  }
  const first = [...list]
    .filter((r) => isUsableSlug(r.slug))
    .sort((a, b) => (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0))[0];
  return first?.slug ?? null;
}
