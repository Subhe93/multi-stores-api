import { summarizeCatalog, type DryRunSummary } from '../model/dry-run-summary';
import { W_HTML_SANITIZER_FALLBACK } from '../html/html-sanitizer';
import { createPlanContext, type PlanContext } from './plan-context';
import { planCategories } from './plan-categories';
import { planMedia } from './plan-media';
import { planPages } from './plan-pages';
import { planProducts } from './plan-products';
import { planRedirects } from './plan-redirects';
import { planShipping } from './plan-shipping';
import { planTemplates } from './plan-templates';
import {
  planFingerprint,
  type ImportPlan,
  type ImportRunSummary,
  type PlanAction,
  type PlanBlocker,
  type PlanEntityType,
  type PlanInput,
  type PlanWork,
} from './plan-types';

export * from './plan-types';

/**
 * The importer's pure planner (M4.4 D5): `plan(catalog, options, snapshot)`
 * → items with CREATE / UPDATE / UNCHANGED / SKIP / CONFLICT / STAGE. The dry
 * run stores these items (phase PLAN); the apply step recomputes the plan
 * and executes the same items (phase APPLY), so PLAN == APPLY. A changed
 * fingerprint between dry run and confirm → 409 IMPORT_PLAN_STALE.
 *
 * M5 B18: this file orchestrates the per-entity planners (plan-categories,
 * plan-products, plan-shipping, plan-templates, plan-media, plan-redirects)
 * in the original order, so items, warnings and the fingerprint are the same
 * as before the split.
 */

/** Blockers and store-level checks (D18, D23). */
function planStoreChecks(ctx: PlanContext): PlanBlocker[] {
  const { catalog, snapshot, scopes, warn } = ctx;
  const blockers: PlanBlocker[] = [];
  const srcCurrency = catalog.meta.currency?.toUpperCase() ?? null;
  if (srcCurrency && srcCurrency !== snapshot.currency.toUpperCase()) {
    blockers.push({
      code: 'IMPORT_CURRENCY_MISMATCH',
      message: `Source prices are in ${srcCurrency}, the store sells in ${snapshot.currency}`,
    });
  }
  if (scopes.products && !snapshot.platformCategoryExists) {
    blockers.push({
      code: 'IMPORT_PLATFORM_CATEGORY_REQUIRED',
      message: 'Choose the platform category for imported products',
    });
  }
  const storeWarn = (code: string, message: string) =>
    warn({
      code,
      external_ref: `woo:${catalog.meta.site_host}:store`,
      title: 'store',
      message,
    });
  if (catalog.meta.prices_include_tax !== null) {
    const inclusive = snapshot.taxPricingMode === 'INCLUSIVE';
    if (catalog.meta.prices_include_tax !== inclusive)
      storeWarn(
        'W_TAX_MODE_MISMATCH',
        `source prices ${catalog.meta.prices_include_tax ? 'include' : 'exclude'} tax, the store is ${snapshot.taxPricingMode}`,
      );
  }
  if (catalog.meta.locale) {
    const srcLang = catalog.meta.locale.toLowerCase().split(/[_-]/)[0];
    const dstLang = snapshot.primaryLocale.toLowerCase().split(/[_-]/)[0];
    if (srcLang !== dstLang)
      storeWarn(
        'W_LOCALE_MISMATCH',
        `source locale ${catalog.meta.locale}, store primary locale ${snapshot.primaryLocale}`,
      );
  }
  return blockers;
}

export function planImport(input: PlanInput): ImportPlan {
  const ctx = createPlanContext(input);
  const { catalog, options, snapshot, sanitizer, scopes } = ctx;

  const blockers = planStoreChecks(ctx);
  const categories = planCategories(ctx);
  const products = planProducts(ctx, categories);
  const shippingWork: PlanWork['shipping'] = products.shippingOn
    ? planShipping(ctx, products.shippingProfiles)
    : null;
  const plannedTemplates = planTemplates(ctx);
  const mediaPlan = planMedia(
    ctx,
    categories.planned,
    products.planned,
    plannedTemplates,
  );
  const plannedPages = planPages(ctx);
  const redirects = planRedirects(ctx, categories, products, plannedPages);

  // ── Summary (report shape of model/dry-run-summary + plan counts) ─────────
  const base = summarizeCatalog(catalog, {
    skip_ext_ids: options.skip_ext_ids,
    include_drafts: options.include_drafts,
    status_map: options.status_map,
    customization_type_rules: options.customization_type_rules,
    label_overrides: options.label_overrides,
    term_cleanup: options.term_cleanup,
    designer_fallback_fields: options.designer_fallback_fields,
    redirect_skipped: options.redirect_skipped,
    personalization_available: snapshot.personalizationAvailable,
    designer_available: snapshot.designerAvailable,
  });
  const counts: DryRunSummary['counts'] = {};
  const count = (t: PlanEntityType, a: PlanAction, by = 1) => {
    if (by <= 0) return;
    const rec = (counts[t] ??= {});
    rec[a] = (rec[a] ?? 0) + by;
  };
  for (const i of ctx.items) count(i.entity_type, i.action);
  if (scopes.products)
    for (const p of products.planned) {
      const a = p.action;
      count('IMAGE', a, p.mapped.images.length);
      count('TAG', a, p.mapped.tags.length);
      count('FAQ', a, p.mapped.faqs.length);
      count('PRODUCT_CATEGORY', a, p.mapped.category_refs.length);
      if (p.mapped.option_config) count('OPTION_CONFIG', a);
    }
  const warnings = { ...base.warnings };
  const sampleMax = 10;
  for (const w of ctx.mapWarnings) {
    const g = (warnings[w.code] ??= { count: 0, samples: [] });
    g.count++;
    if (g.samples.length < sampleMax)
      g.samples.push({
        external_ref: w.external_ref,
        title: w.title,
        message: w.message,
      });
  }
  if (sanitizer.mode === 'plain_text_fallback') {
    warnings[W_HTML_SANITIZER_FALLBACK] = {
      count: 1,
      samples: [
        {
          message:
            'HTML sanitizer not installed: descriptions are imported as plain text paragraphs',
        },
      ],
    };
  }
  const summary: ImportRunSummary = {
    ...base,
    counts,
    warnings,
    redirects: redirects.work
      ? {
          total: redirects.work.plan.items.length,
          by_rule: redirects.byRule,
          preview: redirects.preview,
        }
      : { total: 0, by_rule: {}, preview: [] },
    old_slugs: {
      ...base.old_slugs,
      redirected: redirects.byRule.old_slug ?? 0,
      excluded: redirects.excludedOldSlugs,
    },
    ...(redirects.content
      ? {
          content: redirects.content,
          content_unmapped: redirects.contentUnmapped,
        }
      : {}),
    plan: {
      items: ctx.items.length,
      blockers,
      sanitizer: sanitizer.mode,
      personalization_available: snapshot.personalizationAvailable,
      designer_available: snapshot.designerAvailable,
    },
  };

  const work: PlanWork = {
    categories: scopes.categories ? categories.planned : [],
    products: scopes.products ? products.planned : [],
    skipped: scopes.products
      ? products.skipped.map((p) => ({
          ref: p.ext_id,
          target_id: snapshot.productsByRef.get(p.ext_id)?.id ?? null,
          title: p.title,
        }))
      : [],
    removals: products.removals,
    shipping: shippingWork,
    templates: plannedTemplates,
    pages: plannedPages,
    media: mediaPlan.media,
    media_urls: mediaPlan.mediaUrls,
    redirects: redirects.work,
  };
  return {
    items: ctx.items,
    work,
    summary,
    fingerprint: planFingerprint(input.catalogHash, options, ctx.items, work),
    blockers,
  };
}
