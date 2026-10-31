import { encodeSlugForUrl } from '@multi-stores/core/slug';

/*
 * Public paths that move when a slug changes (old-slug 301s, WP
 * `_wp_old_slug`). Pure: the services decide what was published/live and
 * RedirectsService.applySlugChangeRedirects writes the rows.
 *
 * URL shapes (multi-stores-web proxy + app/store/[storeSlug]):
 * - product:    `/products/<slug>`; a secondary locale is served under
 *               `/<locale>/products/<slug>`, the primary locale unprefixed.
 *               The product page resolves ANY translated slug, so an
 *               unprefixed URL with a secondary-locale slug also worked.
 * - collection: `/collections/<root>/<child>/<self>`.
 * - root page:  `/<slug>`.
 * Paths are percent-encoded per segment (lowercase hex, WP permalinks); the
 * redirect store normalises `from_path` (decode, NFC, lower case) itself.
 */

export interface PathMove {
  from: string;
  to: string;
}

export interface LocaleSlug {
  locale: string;
  slug: string;
}

export function productPath(slug: string, locale?: string | null): string {
  const p = `/products/${encodeSlugForUrl(slug)}`;
  return locale ? `/${locale.toLowerCase()}${p}` : p;
}

export function collectionPath(path: readonly string[]): string {
  return `/collections/${path.map((s) => encodeSlugForUrl(s)).join('/')}`;
}

export function rootPagePath(slug: string): string {
  return `/${encodeSlugForUrl(slug)}`;
}

/**
 * Moves of one product whose translation slugs changed. Only slugs the
 * product no longer has move (a slug kept by another locale is still live).
 * For each removed slug: the unprefixed URL goes to the new primary-locale
 * slug when the primary locale had it (else to the new slug of the locale
 * that had it), and `/<locale>/products/<old>` goes to that locale's new slug
 * for every secondary locale that had it. The caller drops slugs that
 * another product of the store still serves.
 */
export function productSlugMoves(opts: {
  primaryLocale: string;
  before: readonly LocaleSlug[];
  after: readonly LocaleSlug[];
}): PathMove[] {
  const after = opts.after.filter((t) => !!t.slug);
  if (!after.length) return [];
  const afterSlugs = new Set(after.map((t) => t.slug));
  const afterByLocale = new Map(after.map((t) => [t.locale, t.slug]));
  const primaryNew = afterByLocale.get(opts.primaryLocale) ?? after[0].slug;
  const localesByOld = new Map<string, string[]>();
  for (const t of opts.before) {
    if (!t.slug || afterSlugs.has(t.slug)) continue;
    const list = localesByOld.get(t.slug) ?? [];
    list.push(t.locale);
    localesByOld.set(t.slug, list);
  }
  const moves: PathMove[] = [];
  for (const [old, locales] of localesByOld) {
    const unprefixedTarget = locales.includes(opts.primaryLocale)
      ? primaryNew
      : (afterByLocale.get(locales[0]) ?? primaryNew);
    moves.push({ from: productPath(old), to: productPath(unprefixedTarget) });
    for (const l of locales) {
      if (l === opts.primaryLocale) continue;
      moves.push({
        from: productPath(old, l),
        to: productPath(afterByLocale.get(l) ?? primaryNew, l),
      });
    }
  }
  return moves;
}

/**
 * Adds the `/<locale>/…` form of every move for each served locale prefix
 * (collections and root pages have one slug for all locales, and the proxy
 * serves secondary locales under a prefix).
 */
export function withLocalePrefixes(
  moves: readonly PathMove[],
  prefixes: readonly string[],
): PathMove[] {
  return moves.flatMap((m) => [
    m,
    ...prefixes.map((l) => ({ from: `/${l}${m.from}`, to: `/${l}${m.to}` })),
  ]);
}

/** What collectionPathMoves needs of a collection path (buildCollectionPaths). */
export interface CollectionPathState {
  path: string[];
  reachable: boolean;
}

/**
 * Moves of collections whose `/collections/…` path changed (the renamed one
 * and every descendant, or a re-parented subtree): only rows that were served
 * before and are still served after. An old path that some collection still
 * serves after the change is not moved.
 */
export function collectionPathMoves(
  before: ReadonlyMap<string, CollectionPathState>,
  after: ReadonlyMap<string, CollectionPathState>,
): PathMove[] {
  const livePaths = new Set(
    [...after.values()].filter((v) => v.reachable).map((v) => v.path.join('/')),
  );
  const moves: PathMove[] = [];
  for (const [id, b] of before) {
    const a = after.get(id);
    if (!b.reachable || !a?.reachable) continue;
    const from = b.path.join('/');
    if (from === a.path.join('/') || livePaths.has(from)) continue;
    moves.push({ from: collectionPath(b.path), to: collectionPath(a.path) });
  }
  return moves;
}
