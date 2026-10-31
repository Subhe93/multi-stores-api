import { normalizeRedirectPath } from '../../redirects/redirect-path.util';
import { capRedirectCreates } from '../../redirects/redirects.service';
import {
  planRedirectDeactivations,
  planRedirectUpserts,
  withoutDeactivated,
  type IncomingRedirect,
} from '../../redirects/redirect-plan';
import {
  CONTENT_ROWS_MAX,
  type ContentRow,
  type ContentUnmappedRow,
  type DryRunSummary,
} from '../model/dry-run-summary';
import {
  buildImportRedirects,
  collectionPathTarget,
  resolveContentTarget,
} from '../mapping/map-redirects';
import { ImportEntityStatus } from '@prisma/client';
import { ledgerKey, type SnapshotCategory } from './target-snapshot';
import type { CategoryPlan } from './plan-categories';
import type { PlanContext } from './plan-context';
import { importedPagePath } from './plan-pages';
import type { ProductPlan } from './plan-products';
import {
  isProxyReservedPath,
  type PlannedProduct,
  type PlanRedirectWork,
} from './plan-types';

export interface RedirectPlanResult {
  work: PlanRedirectWork | null;
  /** Summary parts (`summary.redirects`, `summary.old_slugs.excluded`). */
  byRule: Record<string, number>;
  preview: DryRunSummary['redirects']['preview'];
  excludedOldSlugs: { external_ref: string; slug: string; reason: string }[];
  /** M5 B17: pages / posts of the source and their targets (null when the bundle has none). */
  content: DryRunSummary['content'] | null;
  contentUnmapped: ContentUnmappedRow[];
}

/**
 * Content rows for the summary (M5 B17): every published page / post with
 * the target `content_redirects` resolves, plus the unmapped list. Computed
 * even when the redirects scope is off, so Mapping review can map them first.
 */
export function summarizeContent(
  ctx: PlanContext,
  importedRefs: ReadonlySet<string>,
): {
  content: DryRunSummary['content'] | null;
  unmapped: ContentUnmappedRow[];
} {
  const pages = (ctx.catalog.pages ?? []).filter((p) => p.status === 'publish');
  if (!pages.length) return { content: null, unmapped: [] };
  const items: ContentRow[] = [];
  const unmapped: ContentUnmappedRow[] = [];
  let mapped = 0;
  for (const p of pages) {
    const r = resolveContentTarget(p.ref, ctx.options.content_redirects);
    const row: ContentUnmappedRow = {
      ref: p.ref,
      kind: p.kind,
      path: p.path,
      title: p.title,
    };
    let target: string | null = null;
    if (r.kind === 'unmapped') {
      if (unmapped.length < CONTENT_ROWS_MAX) unmapped.push(row);
    } else {
      mapped++;
      target =
        ctx.options.content_redirects.targets[p.ref] ??
        (r.kind === 'path' ? r.to : 'skip');
    }
    if (items.length < CONTENT_ROWS_MAX) items.push({ ...row, target });
  }
  return {
    content: {
      pages: pages.filter((p) => p.kind === 'page').length,
      posts: pages.filter((p) => p.kind === 'post').length,
      mapped,
      unmapped: pages.length - mapped,
      imported: pages.filter((p) => importedRefs.has(p.ref)).length,
      items,
    },
    unmapped,
  };
}

/**
 * Redirects (§6.1): candidates from the final slugs, renamed platform paths
 * (fix 3/13), live-path conflicts, deactivations of rows that would shadow a
 * live page, then the same pure upsert planner and per-store cap the apply
 * step uses (PLAN == APPLY).
 */
export function planRedirects(
  ctx: PlanContext,
  categories: CategoryPlan,
  products: ProductPlan,
  /** Pages the pages scope creates (their `/<slug>` is the `import` target). */
  importedPages: readonly {
    mapped: { ref: string };
    final_slug: string;
  }[] = [],
): RedirectPlanResult {
  const { catalog, options, snapshot, scopes, warn, push } = ctx;
  const { categorySlug } = categories;
  const plannedProducts = products.planned;
  let preview: {
    from: string;
    to: string;
    rule: string;
    external_ref: string;
  }[] = [];
  const byRule: Record<string, number> = {};
  const importedRefs = new Set(importedPages.map((p) => p.mapped.ref));
  const importedByRef = new Map(importedPages.map((p) => [p.mapped.ref, p]));
  const { content, unmapped: contentUnmapped } = summarizeContent(
    ctx,
    importedRefs,
  );
  if (!scopes.redirects)
    return {
      work: null,
      byRule,
      preview: [],
      excludedOldSlugs: [],
      content,
      contentUnmapped,
    };

  // Fix 13: a redirect may only point at a page that will be live.
  const willBePublished = (p: PlannedProduct): boolean => {
    const writes =
      scopes.products && (p.action === 'CREATE' || p.action === 'UPDATE');
    if (writes) return p.mapped.status === 'PUBLISHED';
    return p.current_status === 'PUBLISHED';
  };
  const sourceByRef = new Map(products.imported.map((x) => [x.ext_id, x]));
  // M6.7: collection URLs carry the ancestry. `livePathOf` is the chain as
  // it is now (snapshot parent_id). `categoryPath` is the chain after the
  // run: a collection this run writes (CREATE / UPDATE, scope on) sits under
  // its mapped parent when that parent gets a collection (apply-categories
  // resolves the parent the same way; otherwise the child is a root, fix
  // 18); every other live collection (SKIP / UNCHANGED / CONFLICT, or the
  // scope off) keeps its live parent. Each parent is resolved by the same
  // rule, so a kept child under a renamed parent gets the new parent slug.
  const liveById = new Map<string, SnapshotCategory>();
  for (const c of snapshot.categoriesBySlug.values()) liveById.set(c.id, c);
  const livePathOf = (c: SnapshotCategory): string[] => {
    const path = [c.slug];
    const seen = new Set<string>([c.id]);
    for (
      let p = c.parent_id ? liveById.get(c.parent_id) : undefined;
      p && !seen.has(p.id) && path.length <= 8;
      p = p.parent_id ? liveById.get(p.parent_id) : undefined
    ) {
      seen.add(p.id);
      path.unshift(p.slug);
    }
    return path;
  };
  const isWritten = (ref: string): boolean => {
    const pc = categories.byRef.get(ref);
    return (
      scopes.categories &&
      !!pc &&
      (pc.action === 'CREATE' || pc.action === 'UPDATE')
    );
  };
  // Path of a live row after the run: by ref when this run writes it, else
  // its own slug under its live parent (resolved the same way).
  const plannedLivePathOf = (
    c: SnapshotCategory,
    seen: Set<string>,
  ): string[] => {
    if (c.external_ref && isWritten(c.external_ref)) {
      const planned = plannedPathOfRef(c.external_ref, seen);
      if (planned) return planned;
    }
    if (seen.has(c.id) || seen.size > 8) return [c.slug];
    seen.add(c.id);
    const parent = c.parent_id ? liveById.get(c.parent_id) : undefined;
    return parent ? [...plannedLivePathOf(parent, seen), c.slug] : [c.slug];
  };
  const plannedPathOfRef = (
    ref: string,
    seen: Set<string>,
  ): string[] | null => {
    const slug = categorySlug.get(ref);
    if (!slug) return null;
    if (!isWritten(ref)) {
      const live = snapshot.categoriesByRef.get(ref);
      return live ? plannedLivePathOf(live, seen) : [slug];
    }
    const parentRef = categories.byRef.get(ref)?.mapped.parent_ref ?? null;
    if (!parentRef || !categories.collectionFor(parentRef)) return [slug];
    if (seen.has(ref) || seen.size > 8) return [slug];
    seen.add(ref);
    // `collectionFor` is non-null, so the parent is live, created or adopted
    // by this run and has a planned slug.
    return [...(plannedPathOfRef(parentRef, seen) ?? []), slug];
  };
  const categoryPath = (ref: string): string[] | null =>
    plannedPathOfRef(ref, new Set<string>());
  // Namez Phase 1: a collection converted into a root occasion page (ACTIVE
  // OCCASION_PAGE ledger row) redirects to that page, not to a collection
  // path that no longer exists (its label is INTERNAL).
  const occasionTarget = (ref: string): string | null => {
    const row = snapshot.ledger.get(ledgerKey('OCCASION_PAGE', ref));
    if (!row || row.status !== ImportEntityStatus.ACTIVE) return null;
    const live = snapshot.categoriesByRef.get(ref);
    return live ? `/${live.slug}` : null;
  };
  const collectionTarget = (ref: string): string | null => {
    const occasion = occasionTarget(ref);
    if (occasion) return occasion;
    // An INTERNAL label without a page has no public URL at all.
    if (snapshot.categoriesByRef.get(ref)?.visibility === 'INTERNAL')
      return null;
    const path = categoryPath(ref);
    return path ? collectionPathTarget(path) : null;
  };
  const built = buildImportRedirects({
    collectionTarget,
    catalog,
    imported: plannedProducts.map((p) => ({
      product: sourceByRef.get(p.mapped.ref)!,
      final_slug: p.final_slug,
      published: willBePublished(p),
    })),
    skipped: products.skipped,
    categorySlug,
    categoryPath,
    redirectSkipped: options.redirect_skipped,
    shortlinks: options.redirect_shortlinks,
    // M5 B17: pages / posts per `content_redirects`, plus the system paths.
    // An `import` target only gets a row when the pages scope creates the page.
    content: options.content_redirects,
    importedPagePath: (page) => {
      const planned = importedByRef.get(page.ref);
      return planned ? importedPagePath(planned) : null;
    },
  });
  for (const row of contentUnmapped)
    warn({
      code: 'W_CONTENT_UNMAPPED',
      external_ref: row.ref,
      title: row.title,
      message: `${row.path} has no target yet (Mapping review → Old pages and posts)`,
    });
  const excludedOldSlugs = built.excludedOldSlugs;
  // A from-path equal to a live product or collection path is a CONFLICT (§6.1).
  const livePaths = new Set<string>();
  for (const s of snapshot.publishedProductSlugs)
    livePaths.add(`/products/${s}`);
  for (const p of plannedProducts)
    if (willBePublished(p)) livePaths.add(`/products/${p.final_slug}`);
  for (const c of snapshot.categoriesBySlug.values())
    if (c.is_active && c.visibility !== 'INTERNAL')
      livePaths.add(collectionPathTarget(livePathOf(c)));
  for (const ref of categorySlug.keys()) {
    const to = collectionTarget(ref);
    if (to) livePaths.add(to);
  }
  // Live builder pages (`/<slug>`): an imported page that had to take a
  // suffixed slug must not redirect away from the merchant's own page.
  for (const s of snapshot.livePageSlugs ?? []) livePaths.add(`/${s}`);
  // Platform pages whose slug this run changes: the old page path
  // redirects to the new one (and older rows pointing at it are re-pointed).
  const claimed = new Set<string>();
  for (const p of plannedProducts) claimed.add(`/products/${p.final_slug}`);
  for (const ref of categorySlug.keys()) {
    const to = collectionTarget(ref);
    if (to) claimed.add(to);
  }
  if (scopes.products)
    for (const p of plannedProducts) {
      const old = snapshot.productsByRef.get(p.mapped.ref)?.slug;
      if (
        p.action !== 'UPDATE' ||
        !old ||
        old === p.final_slug ||
        p.current_status !== 'PUBLISHED' ||
        !willBePublished(p)
      )
        continue;
      const from = `/products/${old}`;
      if (claimed.has(from)) continue;
      livePaths.delete(from);
      built.candidates.push({
        from,
        to: `/products/${p.final_slug}`,
        rule: 'renamed',
        external_ref: p.mapped.ref,
        status_code: 301,
      });
    }
  // M6.7: the old path is the live chain, the new one the planned chain, so
  // a collection moved under another parent (or whose ancestor is renamed)
  // redirects too, not only a renamed slug.
  if (scopes.categories)
    for (const c of categories.planned) {
      const live = snapshot.categoriesByRef.get(c.mapped.ref);
      if (
        c.action === 'CONFLICT' ||
        !live ||
        !live.is_active ||
        live.visibility === 'INTERNAL'
      )
        continue;
      const to = collectionTarget(c.mapped.ref);
      const from = collectionPathTarget(livePathOf(live));
      if (!to || to === from || claimed.has(from)) continue;
      livePaths.delete(from);
      built.candidates.push({
        from,
        to,
        rule: 'renamed',
        external_ref: c.mapped.ref,
        status_code: 301,
      });
    }
  const normalizedLive = new Set(
    [...livePaths].map((p) => normalizeRedirectPath(p) ?? p),
  );
  // An earlier run's redirect whose from-path is live again (a rename that
  // was reverted) would shadow the page: switched off, restored on rollback.
  const deactivations = planRedirectDeactivations(
    snapshot.redirects,
    normalizedLive,
  );
  const incoming: IncomingRedirect[] = [];
  const incomingRefs: string[] = [];
  const liveConflicts: { from_path: string; to_path: string }[] = [];
  for (const c of built.candidates) {
    const key = normalizeRedirectPath(c.from);
    if (key && normalizedLive.has(key)) {
      liveConflicts.push({ from_path: key, to_path: c.to });
      continue;
    }
    incoming.push({
      from_path: c.from,
      to_path: c.to,
      status_code: c.status_code,
    });
    incomingRefs.push(c.external_ref);
  }
  // Same per-store cap as RedirectsService.bulkUpsertFromImport (PLAN == APPLY).
  const rplan = capRedirectCreates(
    planRedirectUpserts(
      withoutDeactivated(snapshot.redirects, deactivations),
      incoming,
    ),
    snapshot.redirects.length,
  );
  const work: PlanRedirectWork = {
    incoming,
    incoming_refs: incomingRefs,
    plan: rplan,
    live_conflicts: liveConflicts,
    deactivate: deactivations,
    live_paths: [...normalizedLive],
  };
  for (const it of rplan.items) {
    push({
      entity_type: 'REDIRECT',
      external_ref: it.from_path.slice(0, 255),
      action: it.action,
      target_id: it.id,
      title: it.to_path,
    });
    if (isProxyReservedPath(it.from_path))
      warn({
        code: 'W_REDIRECT_UNREACHABLE',
        external_ref: it.from_path,
        title: it.to_path,
        message: 'the storefront never routes this path to redirects',
      });
  }
  for (const d of deactivations)
    push({
      entity_type: 'REDIRECT',
      external_ref: d.from_path.slice(0, 255),
      action: 'UPDATE',
      target_id: d.id,
      message: 'deactivated (live path)',
      title: d.to_path,
    });
  // Existing IMPORT rows re-pointed at the new final targets (fix 5).
  for (const r of rplan.repoints)
    push({
      entity_type: 'REDIRECT',
      external_ref: r.from_path.slice(0, 255),
      action: 'UPDATE',
      target_id: r.id,
      message: 'repointed',
      title: r.to_path,
    });
  for (const c of rplan.conflicts) {
    push({
      entity_type: 'REDIRECT',
      external_ref: c.from_path.slice(0, 255),
      action: 'CONFLICT',
      target_id: null,
      message: c.code,
    });
    warn({
      code: 'W_REDIRECT_CONFLICT',
      external_ref: c.from_path,
      title: c.to_path,
      message: c.code,
    });
  }
  for (const c of liveConflicts) {
    push({
      entity_type: 'REDIRECT',
      external_ref: c.from_path.slice(0, 255),
      action: 'CONFLICT',
      target_id: null,
      message: 'live path',
    });
    warn({
      code: 'W_REDIRECT_CONFLICT',
      external_ref: c.from_path,
      title: c.to_path,
      message: 'the path is a live page of this store',
    });
  }
  const accepted = new Set(rplan.items.map((i) => i.from_path));
  const ruleOf = new Map(
    built.candidates.map((c) => [normalizeRedirectPath(c.from) ?? c.from, c]),
  );
  for (const it of rplan.items) {
    const c = ruleOf.get(it.from_path);
    if (!c) continue;
    byRule[c.rule] = (byRule[c.rule] ?? 0) + 1;
    if (preview.length < 50)
      preview.push({
        from: it.from_path,
        to: it.to_path,
        rule: c.rule,
        external_ref: c.external_ref,
      });
  }
  preview = preview.filter((r) => accepted.has(r.from));
  return {
    work,
    byRule,
    preview: preview as DryRunSummary['redirects']['preview'],
    excludedOldSlugs,
    content,
    contentUnmapped,
  };
}
