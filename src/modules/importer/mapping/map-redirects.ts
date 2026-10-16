import { redirectPath, type RedirectCandidate } from '../model/dry-run-summary';
import type { NormalizedCatalog, NProduct } from '../model/normalized';

/**
 * Redirect generation (M4.4 §6.1) over the planner's final slugs:
 *  - `/<product_base>/<slug>` → `/products/<final slug>` for every product
 *    that is PUBLISHED after the status map;
 *  - its old slugs → same target (not `…__trashed`, not a live slug, not drafts);
 *  - skipped published products → their first category, else `/`
 *    (`redirect_skipped`);
 *  - `/<category_base>/<full/path>` and, for nested categories, the leaf
 *    alias → `/collections/<slug>`;
 *  - `/<tag_base>/<slug>` → the single product carrying the tag, else `/`.
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
  redirectSkipped: boolean;
}

export interface ImportRedirectCandidate extends RedirectCandidate {
  status_code: 301;
}

export function buildImportRedirects(input: RedirectBuildInput): {
  candidates: ImportRedirectCandidate[];
  excludedOldSlugs: { external_ref: string; slug: string; reason: string }[];
} {
  const { catalog } = input;
  const { bases } = catalog.meta;
  const out: ImportRedirectCandidate[] = [];
  const seen = new Set<string>();
  const add = (c: Omit<ImportRedirectCandidate, 'status_code'>) => {
    if (seen.has(c.from)) return;
    seen.add(c.from);
    out.push({ ...c, status_code: 301 });
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
  if (input.redirectSkipped) {
    for (const p of input.skipped) {
      if (p.status !== 'publish') continue;
      const first = p.category_ext_ids
        .map((e) => input.categorySlug.get(e))
        .find((s): s is string => !!s);
      add({
        from: redirectPath(bases.product, p.slug),
        to: first ? `/collections/${first}` : '/',
        rule: 'skipped_product',
        external_ref: p.ext_id,
      });
    }
  }
  for (const c of catalog.categories) {
    const slug = input.categorySlug.get(c.ext_id);
    if (!slug) continue;
    add({
      from: redirectPath(bases.category, ...c.path),
      to: `/collections/${slug}`,
      rule: 'category_path',
      external_ref: c.ext_id,
    });
  }
  for (const c of catalog.categories) {
    const slug = input.categorySlug.get(c.ext_id);
    if (!slug || c.depth === 0) continue;
    add({
      from: redirectPath(bases.category, c.slug),
      to: `/collections/${slug}`,
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
  return { candidates: out, excludedOldSlugs };
}
