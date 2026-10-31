import {
  ProductSlugOwner,
  SlugDb,
  resolveSlugBase,
  storeSlugLocale,
  uniqueProductSlug,
} from './wp-slug';
import {
  LocaleSlug,
  PathMove,
  productPath,
  productSlugMoves,
} from './slug-moves';
import type { RedirectsService } from '../../modules/redirects/redirects.service';

/*
 * Per-locale slugs of own products and custom products (one slug per
 * translation). Shared by ProductsService, CustomProductsService and the
 * auto-translate writers so every path applies the same rule:
 *
 * - candidates per translation: its slug, its title, then the primary
 *   translation's (resolved) slug and title; else `product-<id8>`;
 * - a slug sent back unchanged for its locale is kept as stored;
 * - anything else is sanitized with the store's primary content locale and
 *   made unique in the creator's `/products/<slug>` domain (own + custom
 *   products, every locale), excluding the product itself so its locales may
 *   share one slug.
 */

export interface SlugTranslationInput {
  locale: string;
  slug?: string | null;
  title?: string | null;
}

export interface ResolveProductSlugsOptions {
  owner: ProductSlugOwner;
  /** Store primary content locale (sanitizer locale + primary translation). */
  locale: string;
  /** Slugs stored now, per locale (update); empty on create. */
  stored?: readonly LocaleSlug[];
  exclude?: { productId?: string | null; customProductId?: string | null };
  /** Entity id for the id fallback (a fresh id when unknown). */
  id?: string | null;
}

export async function resolveProductTranslationSlugs<
  T extends SlugTranslationInput,
>(
  db: SlugDb,
  translations: readonly T[],
  opts: ResolveProductSlugsOptions,
): Promise<(T & { slug: string })[]> {
  const storedSlugs = new Set((opts.stored ?? []).map((s) => s.slug));
  const storedByLocale = new Map(
    (opts.stored ?? []).map((s) => [s.locale, s.slug]),
  );
  // The primary translation first, so the others can fall back on its slug.
  const primaryIdx = Math.max(
    0,
    translations.findIndex((t) => t.locale === opts.locale),
  );
  const order = translations.length
    ? [primaryIdx, ...translations.keys()].filter(
        (i, n, all) => all.indexOf(i) === n,
      )
    : [];
  const out: (T & { slug: string })[] = [];
  let primary: { slug: string; title?: string | null } | null = null;
  for (const i of order) {
    const t = translations[i];
    const { slug, keep } = resolveSlugBase({
      candidates: [t.slug, t.title, primary?.slug, primary?.title],
      locale: opts.locale,
      // Unchanged = the slug stored for this locale, or any slug the
      // product already has (a secondary locale reusing the primary one).
      stored:
        typeof t.slug === 'string' && storedSlugs.has(t.slug)
          ? t.slug
          : storedByLocale.get(t.locale),
      prefix: 'product',
      id: opts.id,
    });
    const finalSlug = keep
      ? slug
      : await uniqueProductSlug(db, opts.owner, slug, opts.exclude ?? {});
    out[i] = { ...t, slug: finalSlug };
    if (primary === null) primary = { slug: finalSlug, title: t.title };
  }
  return out;
}

/** Store id + primary content locale of a product owner (null store for providers). */
export async function productSlugContext(
  db: SlugDb,
  creatorId: string | null | undefined,
): Promise<{ storeId: string | null; locale: string }> {
  if (!creatorId)
    return { storeId: null, locale: await storeSlugLocale(db, {}) };
  const store = await db.store.findUnique({
    where: { creator_id: creatorId },
    select: {
      id: true,
      language_config: { select: { primary_locale: true } },
    },
  });
  return {
    storeId: store?.id ?? null,
    locale: store?.language_config?.primary_locale || 'en',
  };
}

/**
 * Old-slug moves of a published product after its translations changed,
 * minus slugs another product or custom product of the creator still serves
 * (`/products/<old>` would otherwise be shadowed by the redirect).
 */
export async function productRedirectMoves(
  db: SlugDb,
  opts: {
    creatorId: string;
    primaryLocale: string;
    before: readonly LocaleSlug[];
    after: readonly LocaleSlug[];
    exclude: { productId?: string | null; customProductId?: string | null };
  },
): Promise<PathMove[]> {
  const afterSlugs = new Set(opts.after.map((t) => t.slug));
  const removed = [
    ...new Set(
      opts.before.map((t) => t.slug).filter((s) => s && !afterSlugs.has(s)),
    ),
  ];
  if (!removed.length) return [];
  const [own, custom] = await Promise.all([
    db.productTranslation.findMany({
      where: {
        slug: { in: removed },
        product: {
          creator_id: opts.creatorId,
          ...(opts.exclude.productId
            ? { id: { not: opts.exclude.productId } }
            : {}),
        },
      },
      select: { slug: true },
    }),
    db.customProductTranslation.findMany({
      where: {
        slug: { in: removed },
        custom_product: {
          creator_id: opts.creatorId,
          ...(opts.exclude.customProductId
            ? { id: { not: opts.exclude.customProductId } }
            : {}),
        },
      },
      select: { slug: true },
    }),
  ]);
  const live = new Set([...own, ...custom].map((r) => r.slug));
  return productSlugMoves({
    primaryLocale: opts.primaryLocale,
    before: opts.before.filter((t) => !live.has(t.slug)),
    after: opts.after,
  });
}

/**
 * A published product (own or custom) serves `/products/<slug>` for every
 * translation slug: old-slug / import 301s from those paths (and their
 * `/<locale>/` forms) are switched off, because the proxy matches redirects
 * before routing and would shadow the product (a new product taking an old
 * slug, a renamed draft published later). WP's old-slug redirect only runs
 * on a 404. Drafts keep the redirects until they go live.
 */
export async function releaseLiveProductPaths(
  db: SlugDb,
  redirects: Pick<RedirectsService, 'releaseLivePaths'> | null | undefined,
  ref: { productId?: string | null; customProductId?: string | null },
): Promise<void> {
  if (!redirects) return;
  const row = ref.productId
    ? await db.product.findUnique({
        where: { id: ref.productId },
        select: {
          status: true,
          creator_id: true,
          translations: { select: { slug: true } },
        },
      })
    : ref.customProductId
      ? await db.customProduct.findUnique({
          where: { id: ref.customProductId },
          select: {
            status: true,
            creator_id: true,
            translations: { select: { slug: true } },
          },
        })
      : null;
  if (!row || row.status !== 'PUBLISHED' || !row.creator_id) return;
  const store = await db.store.findUnique({
    where: { creator_id: row.creator_id },
    select: { id: true },
  });
  if (!store) return;
  const slugs = [
    ...new Set((row.translations ?? []).map((t) => t.slug)),
  ].filter(Boolean);
  await redirects.releaseLivePaths(
    store.id,
    slugs.map((s) => productPath(s)),
    { localePrefixes: true },
  );
}
