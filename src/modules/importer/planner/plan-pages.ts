import { ImportEntityStatus } from '@prisma/client';
import { isNumericPageSlug, suffixSlug } from '@multi-stores/core/slug';
import { isReservedPageSlug } from '../../../common/slug/wp-slug';
import { cleanHtml, htmlToPlainText, truncateWords } from '../model/clean';
import type { NPage } from '../model/normalized';
import { hashOf } from '../mapping/hash';
import { resolveContentTarget } from '../mapping/map-redirects';
import type { PlanContext } from './plan-context';
import type { PlanAction, PlannedPage } from './plan-types';

/** Platform path of an imported page: the storefront serves builder pages at `/<slug>`. */
export function importedPagePath(page: { final_slug: string }): string {
  return `/${page.final_slug}`;
}

/**
 * Synchronous twin of uniqueV2PageSlug (common/slug/wp-slug): reserved root
 * routes, feeds, locale prefixes and numeric slugs (`2024`, `page2`) always
 * get a suffix; a taken slug gets `-2`, `-3`, ... (numbered candidates are
 * only checked against `taken`, as uniqueSlug does).
 */
export function plannedPageSlug(
  base: string,
  taken: (slug: string) => boolean,
): string {
  if (!isReservedPageSlug(base) && !isNumericPageSlug(base) && !taken(base))
    return base;
  for (let n = 2; ; n++) {
    const c = suffixSlug(base, n);
    if (!taken(c)) return c;
  }
}

/** Meta description fallback (same rule as products: the excerpt, else the text). */
function metaDescription(page: NPage, html: string): string | null {
  if (page.seo.meta_desc) return page.seo.meta_desc;
  const text = htmlToPlainText(page.excerpt || html);
  return text ? truncateWords(text, 30) : null;
}

/**
 * Pages (M5 B17, `scopes.pages`): every published WP `page` whose content
 * target is `import` becomes a draft builder page (one rich-text section).
 * Posts are never imported (redirects only). The ledger (`PAGE`, ref) makes
 * re-runs idempotent: same hash → UNCHANGED, changed → UPDATE (apply only
 * touches pages that are still drafts), rolled back / missing → CREATE.
 */
export function planPages(ctx: PlanContext): PlannedPage[] {
  const { catalog, options, scopes, sanitizer, push, warn } = ctx;
  const planned: PlannedPage[] = [];
  if (!scopes.pages) return planned;
  const seenSlugs = new Set<string>();
  // Slugs served by builder pages now, plus the ones this plan hands out.
  const storePages = ctx.snapshot.pageSlugs ?? new Map<string, string>();
  const claimed = new Set<string>(storePages.values());
  for (const page of catalog.pages ?? []) {
    if (page.kind !== 'page' || page.status !== 'publish') continue;
    if (
      resolveContentTarget(page.ref, options.content_redirects).kind !==
      'import'
    )
      continue;
    if (!page.slug || seenSlugs.has(page.slug)) {
      warn({
        code: 'W_PAGE_SLUG_CONFLICT',
        external_ref: page.ref,
        title: page.title,
        message: page.slug
          ? `another imported page already uses the slug ${page.slug}`
          : 'the page has no slug',
      });
      push({
        entity_type: 'PAGE',
        external_ref: page.ref,
        action: 'SKIP',
        target_id: null,
        title: page.title,
        message: 'W_PAGE_SLUG_CONFLICT',
      });
      continue;
    }
    seenSlugs.add(page.slug);
    const html = cleanHtml(page.html, sanitizer).html;
    const mapped: PlannedPage['mapped'] = {
      ref: page.ref,
      slug: page.slug,
      title: page.title,
      html,
      meta_title: page.seo.meta_title ?? null,
      meta_description: metaDescription(page, html),
      noindex: page.seo.noindex,
    };
    const sourceHash = hashOf(mapped);
    const ledger = ctx.ledger('PAGE', page.ref);
    let action: PlanAction;
    if (
      ledger &&
      ledger.status === ImportEntityStatus.ACTIVE &&
      ledger.target_id
    )
      action = ledger.source_hash === sourceHash ? 'UNCHANGED' : 'UPDATE';
    else action = 'CREATE';
    const targetId = action === 'CREATE' ? null : ledger!.target_id;
    // Apply never renames an existing page: it keeps its stored slug.
    const stored = targetId ? storePages.get(targetId) : undefined;
    const finalSlug =
      stored ?? plannedPageSlug(page.slug, (s) => claimed.has(s));
    claimed.add(finalSlug);
    if (!stored && finalSlug !== page.slug)
      warn({
        code: 'W_SLUG_CONFLICT_SUFFIXED',
        external_ref: page.ref,
        title: page.title,
        message: `"${page.slug}" → "${finalSlug}"`,
      });
    planned.push({
      page,
      mapped,
      final_slug: finalSlug,
      action,
      target_id: targetId,
      source_hash: sourceHash,
      created_by_import: true,
    });
    push({
      entity_type: 'PAGE',
      external_ref: page.ref,
      action,
      target_id: targetId,
      title: page.title,
    });
  }
  return planned;
}
