import { redirectPath, type RedirectCandidate } from '../model/dry-run-summary';
import type { NormalizedCatalog, NPage, NProduct } from '../model/normalized';
import type { ContentRedirectOptions } from '../runs/run-options';

/**
 * Redirect generation (M4.4 §6.1) over the planner's final slugs (M6.7:
 * every collection target is the hierarchical `/collections/<root>/…/<slug>`):
 *  - `/<product_base>/<slug>` → `/products/<final slug>` for every product
 *    that is PUBLISHED after the status map;
 *  - its old slugs → same target (not `…__trashed`, not a live slug, not drafts);
 *  - skipped published products → their first category, else `/`
 *    (`redirect_skipped`);
 *  - `/<category_base>/<full/path>` and, for nested categories, the leaf
 *    alias → `/collections/<path…>`;
 *  - `/<tag_base>/<slug>` → the single product carrying the tag, else `/`;
 *  - (M5 B17, `redirect_shortlinks`) the WordPress shortlink `/?p=<post id>`
 *    of every published product → the same target as its slug;
 *  - (M5 B17) WordPress pages / posts (`catalog.pages`): `/<path>` (and
 *    `/?p=<id>` with shortlinks) → the target `content_redirects` gives
 *    (see `resolveContentTarget`); unmapped ones follow the mode;
 *  - (M5 B17) the WordPress / WooCommerce system paths (`/shop/`, `/cart/`,
 *    `/checkout/`, `/my-account/`, `/wp-login.php` (302), feeds, Rank Math
 *    sitemaps) → their platform counterpart, overridable per path through
 *    `content_redirects.targets`.
 * The from-path is normalised by the redirects module when it is planned.
 */

export interface RedirectProductInput {
  product: NProduct;
  final_slug: string;
  published: boolean;
}

export interface RedirectBuildInput {
  catalog: NormalizedCatalog;
  imported: RedirectProductInput[];
  skipped: NProduct[];
  categorySlug: Map<string, string>;
  /**
   * M6.7: slugs root -> self of a category's collection (its hierarchical
   * `/collections/` URL), null when the category gets no collection. Default:
   * the catalog's parent chain over `categorySlug` (see `categoryPathResolver`).
   */
  categoryPath?: (ref: string) => string[] | null;
  /**
   * Final target of a category ref; defaults to the `/collections/` path of
   * `categoryPath`. The planner passes a resolver that sends converted
   * occasion collections to their root page.
   */
  collectionTarget?: (ref: string) => string | null;
  redirectSkipped: boolean;
  /** `/?p=<id>` rows for published products (and pages / posts). Default false. */
  shortlinks?: boolean;
  /**
   * M5 B17: where pages / posts and the system paths go. Absent = no
   * content rows and no system rows (catalog-only summaries).
   */
  content?: ContentRedirectOptions;
  /**
   * Platform path of a page whose target is `import` (`/<slug>`), when the
   * pages scope creates it; absent = `import` targets get no redirect.
   */
  importedPagePath?: (page: NPage) => string | null;
}

/** Catalog root of the platform (the CATALOG_TEMPLATE page serves it). */
export const PLATFORM_CATALOG_PATH = '/products';

/** M6.7: the storefront URL of a collection from its slugs root -> self. */
export const collectionPathTarget = (path: string[]): string =>
  `/collections/${path.join('/')}`;

/** Longest parent chain the resolver follows (the platform caps depth at 3). */
const CATEGORY_PATH_MAX_HOPS = 8;

/**
 * M6.7: build `ref -> slugs root -> self` from a slug map and a parent
 * function. The chain stops at the first parent without a slug (not
 * imported: the child is then a root on the platform, fix 18), on a cycle,
 * or after CATEGORY_PATH_MAX_HOPS. Null when `ref` itself has no slug.
 */
export function categoryPathResolver(opts: {
  categorySlug: ReadonlyMap<string, string>;
  parentOf: (ref: string) => string | null;
}): (ref: string) => string[] | null {
  return (ref) => {
    const own = opts.categorySlug.get(ref);
    if (!own) return null;
    const path = [own];
    const seen = new Set<string>([ref]);
    let cursor = opts.parentOf(ref);
    for (let hop = 0; cursor && hop < CATEGORY_PATH_MAX_HOPS; hop++) {
      const slug = opts.categorySlug.get(cursor);
      if (!slug || seen.has(cursor)) break;
      seen.add(cursor);
      path.unshift(slug);
      cursor = opts.parentOf(cursor);
    }
    return path;
  };
}

/**
 * WordPress / WooCommerce system paths and their platform targets (M5 B17).
 * `wp-login.php` is temporary (302): the merchant may later point it at a
 * login page of their own. The Rank Math sitemaps are listed by name
 * (redirect rows are exact paths).
 */
export const SYSTEM_REDIRECTS: readonly {
  from: string;
  to: string;
  status_code: 301 | 302;
}[] = [
  { from: '/shop/', to: PLATFORM_CATALOG_PATH, status_code: 301 },
  { from: '/cart/', to: '/cart', status_code: 301 },
  { from: '/checkout/', to: '/checkout', status_code: 301 },
  { from: '/my-account/', to: '/account', status_code: 301 },
  { from: '/wp-login.php', to: '/account', status_code: 302 },
  { from: '/feed/', to: '/', status_code: 301 },
  { from: '/comments/feed/', to: '/', status_code: 301 },
  { from: '/sitemap_index.xml', to: '/sitemap.xml', status_code: 301 },
  { from: '/product-sitemap.xml', to: '/sitemap.xml', status_code: 301 },
  { from: '/product_cat-sitemap.xml', to: '/sitemap.xml', status_code: 301 },
  { from: '/product_tag-sitemap.xml', to: '/sitemap.xml', status_code: 301 },
  { from: '/page-sitemap.xml', to: '/sitemap.xml', status_code: 301 },
  { from: '/post-sitemap.xml', to: '/sitemap.xml', status_code: 301 },
  { from: '/category-sitemap.xml', to: '/sitemap.xml', status_code: 301 },
  { from: '/wp-sitemap.xml', to: '/sitemap.xml', status_code: 301 },
];

export type ContentResolution =
  | { kind: 'path'; to: string }
  | { kind: 'import' }
  | { kind: 'skip' }
  | { kind: 'unmapped' };

/**
 * Target of one page / post under `content_redirects`: the explicit target,
 * else the mode (`home` → `/`, `skip` → none, `map` → unmapped).
 */
export function resolveContentTarget(
  ref: string,
  content: ContentRedirectOptions,
): ContentResolution {
  const t = content.targets[ref];
  if (t === undefined) {
    if (content.mode === 'home') return { kind: 'path', to: '/' };
    if (content.mode === 'skip') return { kind: 'skip' };
    return { kind: 'unmapped' };
  }
  if (t === 'home') return { kind: 'path', to: '/' };
  if (t === 'skip') return { kind: 'skip' };
  if (t === 'import') return { kind: 'import' };
  return { kind: 'path', to: t };
}

/** Same matching key (trailing slash, case, encoding ignored): no self-redirect row. */
function sameTarget(from: string, to: string): boolean {
  const key = (p: string) => redirectPath(p.split(/[?#]/)[0]);
  return key(from) === key(to);
}

/** The WordPress shortlink of a post, as the redirects module keys it. */
export function shortlinkPath(sourceId: string): string | null {
  return /^\d{1,12}$/.test(sourceId) ? `/?p=${Number(sourceId)}` : null;
}

export interface ImportRedirectCandidate extends RedirectCandidate {
  status_code: 301 | 302;
}

export function buildImportRedirects(input: RedirectBuildInput): {
  candidates: ImportRedirectCandidate[];
  excludedOldSlugs: { external_ref: string; slug: string; reason: string }[];
} {
  const { catalog } = input;
  const { bases } = catalog.meta;
  const out: ImportRedirectCandidate[] = [];
  const seen = new Set<string>();
  const add = (
    c: Omit<ImportRedirectCandidate, 'status_code'> & {
      status_code?: 301 | 302;
    },
  ) => {
    if (seen.has(c.from)) return;
    seen.add(c.from);
    out.push({ ...c, status_code: c.status_code ?? 301 });
  };
  const excludedOldSlugs: {
    external_ref: string;
    slug: string;
    reason: string;
  }[] = [];
  const published = input.imported.filter((p) => p.published);
  const liveSourceSlugs = new Set(published.map((p) => p.product.slug));
  const finalByRef = new Map(
    input.imported.map((p) => [p.product.ext_id, p.final_slug]),
  );

  for (const p of published) {
    add({
      from: redirectPath(bases.product, p.product.slug),
      to: `/products/${p.final_slug}`,
      rule: 'product',
      external_ref: p.product.ext_id,
    });
  }
  if (input.shortlinks)
    for (const p of published) {
      const from = shortlinkPath(p.product.source_id);
      if (from)
        add({
          from,
          to: `/products/${p.final_slug}`,
          rule: 'shortlink',
          external_ref: p.product.ext_id,
        });
    }
  // Pages / posts (M5 B17): mapped targets, mode fallback for the rest.
  if (input.content)
    for (const page of catalog.pages ?? []) {
      if (page.status !== 'publish') continue;
      const r = resolveContentTarget(page.ref, input.content);
      let to: string | null = null;
      if (r.kind === 'path') to = r.to;
      else if (r.kind === 'import') to = input.importedPagePath?.(page) ?? null;
      // The front page (`/`) and a page re-created under the same path need no row.
      if (!to || page.path === '/' || sameTarget(page.path, to)) continue;
      add({
        from: redirectPath(page.path),
        to,
        rule: page.kind,
        external_ref: page.ref,
      });
      const from = input.shortlinks ? shortlinkPath(page.source_id) : null;
      if (from) add({ from, to, rule: 'shortlink', external_ref: page.ref });
    }
  for (const p of input.imported) {
    for (const old of p.product.old_slugs) {
      let reason: string | null = null;
      if (/__trashed$/.test(old)) reason = 'trashed';
      else if (!p.published) reason = 'draft';
      else if (liveSourceSlugs.has(old)) reason = 'equals_live_slug';
      else if (old === p.product.slug) reason = 'equals_current_slug';
      if (reason) {
        excludedOldSlugs.push({
          external_ref: p.product.ext_id,
          slug: old,
          reason,
        });
        continue;
      }
      add({
        from: redirectPath(bases.product, old),
        to: `/products/${p.final_slug}`,
        rule: 'old_slug',
        external_ref: p.product.ext_id,
      });
    }
  }
  // M6.7: collection targets carry the ancestry (`/collections/a/b/c`).
  const parentByRef = new Map(
    catalog.categories.map((c) => [c.ext_id, c.parent_ext_id]),
  );
  const categoryPath =
    input.categoryPath ??
    categoryPathResolver({
      categorySlug: input.categorySlug,
      parentOf: (ref) => parentByRef.get(ref) ?? null,
    });
  const collectionTarget =
    input.collectionTarget ??
    ((ref: string): string | null => {
      const path = categoryPath(ref);
      return path ? collectionPathTarget(path) : null;
    });
  if (input.redirectSkipped) {
    for (const p of input.skipped) {
      if (p.status !== 'publish') continue;
      const first = p.category_ext_ids
        .map(collectionTarget)
        .find((s): s is string => !!s);
      add({
        from: redirectPath(bases.product, p.slug),
        to: first ?? '/',
        rule: 'skipped_product',
        external_ref: p.ext_id,
      });
    }
  }
  for (const c of catalog.categories) {
    const to = collectionTarget(c.ext_id);
    if (!to) continue;
    add({
      from: redirectPath(bases.category, ...c.path),
      to,
      rule: 'category_path',
      external_ref: c.ext_id,
    });
  }
  for (const c of catalog.categories) {
    const to = collectionTarget(c.ext_id);
    if (!to || c.depth === 0) continue;
    add({
      from: redirectPath(bases.category, c.slug),
      to,
      rule: 'category_leaf',
      external_ref: c.ext_id,
    });
  }
  // Products per tag, built once (no per-tag scan of every product).
  const byTag = new Map<string, RedirectProductInput[]>();
  for (const p of input.imported)
    for (const tag of new Set(p.product.tag_ext_ids)) {
      const list = byTag.get(tag) ?? [];
      list.push(p);
      byTag.set(tag, list);
    }
  for (const t of catalog.tags) {
    const on = byTag.get(t.ext_id) ?? [];
    // Never point a tag at a product page that is not live (draft, skipped).
    add({
      from: redirectPath(bases.tag, t.slug),
      to:
        on.length === 1 && on[0].published
          ? `/products/${finalByRef.get(on[0].product.ext_id)}`
          : '/',
      rule: 'tag',
      external_ref: t.ext_id,
    });
  }
  // System paths (M5 B17): built-in targets, overridable per from-path.
  // Always planned (legacy bundles too): the WordPress shop, account, feed
  // and sitemap URLs exist on every source site.
  if (input.content) {
    for (const sys of SYSTEM_REDIRECTS) {
      let to: string | null = sys.to;
      if (input.content.targets[sys.from] !== undefined) {
        const r = resolveContentTarget(sys.from, input.content);
        to = r.kind === 'path' ? r.to : null;
      }
      if (!to || sameTarget(sys.from, to)) continue;
      add({
        from: redirectPath(sys.from),
        to,
        rule: 'system',
        external_ref: `system:${sys.from}`,
        status_code: sys.status_code,
      });
    }
  }
  return { candidates: out, excludedOldSlugs };
}
