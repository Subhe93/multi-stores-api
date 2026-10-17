import { cleanTermName, cleanText, scanHtml, TermCleanupRules } from './clean';
import type { NormalizedCatalog, NProduct } from './normalized';
import { presetDescriptorsFor, PresetKey } from './presets';
import { resolveAnyVariations } from './variations';

/**
 * Dry-run summarizer (M4.4 §13 "Dry-run report", `ImportRun.summary`):
 * counts per entity type × action, warnings grouped by code with samples,
 * the skipped list, unmapped-meta prefixes, media and redirect previews.
 *
 * It works on the catalog alone, i.e. it describes a run against an empty
 * target store (every write is CREATE / STAGE / SKIP). The planner (WP-C)
 * produces the same shape with UPDATE / UNCHANGED / CONFLICT once it has a
 * target snapshot.
 */

export type SummaryAction =
  | 'CREATE'
  | 'UPDATE'
  | 'UNCHANGED'
  | 'SKIP'
  | 'CONFLICT'
  | 'STAGE';

export type SummaryEntityType =
  | 'PRODUCT'
  | 'VARIANT'
  | 'CATEGORY'
  | 'PRODUCT_CATEGORY'
  | 'TAG'
  | 'IMAGE'
  | 'FAQ'
  | 'OPTION_CONFIG'
  | 'PERSONALIZATION'
  | 'FALLBACK_FIELD'
  | 'DESIGN_TEMPLATE'
  | 'MEDIA'
  | 'SHIPPING_PROFILE'
  | 'SHIPPING_ZONE'
  | 'SHIPPING_METHOD'
  | 'REDIRECT';

export interface CustomizationTypeRule {
  mechanisms?: string[];
  designer?: boolean;
  type: string;
}

export interface DryRunOptions {
  skip_ext_ids?: string[];
  include_drafts?: boolean;
  status_map?: Record<string, string>;
  customization_type_rules?: CustomizationTypeRule[];
  label_overrides?: Record<string, string>;
  term_cleanup?: TermCleanupRules;
  designer_fallback_fields?: boolean;
  redirect_skipped?: boolean;
  /** Whether the M4.1 personalization port is available for the store (else presets are STAGED). */
  personalization_available?: boolean;
  /** Whether the M4.2 designer port is available (else templates are STAGED and fallback fields used). */
  designer_available?: boolean;
  /** Samples kept per warning code. */
  max_samples?: number;
}

export interface WarningSample {
  external_ref?: string;
  title?: string;
  message: string;
}

export interface RedirectCandidate {
  from: string;
  to: string;
  rule:
    | 'product'
    | 'old_slug'
    | 'skipped_product'
    | 'category_path'
    | 'category_leaf'
    /** A slug the platform page had before this run renamed it (fix 3/13). */
    | 'renamed'
    | 'tag';
  external_ref: string;
}

export interface DryRunSummary {
  source: { kind: string; format_version: number; site_host: string };
  counts: Partial<
    Record<SummaryEntityType, Partial<Record<SummaryAction, number>>>
  >;
  products: {
    in_source: number;
    imported: number;
    skipped: number;
    by_status: Record<string, number>;
    by_target_status: Record<string, number>;
    by_type: Record<string, number>;
    traditional: number;
    customizable: number;
    by_customization_type: Record<string, number>;
  };
  variants: {
    in_source: number;
    imported: number;
    published_products: number;
    draft_products: number;
    dropped_any: number;
    expanded_any: number;
    inactive: number;
    per_product: Record<string, number>;
  };
  option_configs: {
    total: number;
    color_maps: number;
    swatch_maps: number;
    value_meta: Record<string, number>;
  };
  images: {
    rows: number;
    published_rows: number;
    draft_rows: number;
    distinct: number;
    published_distinct: number;
    missing_in_bundle: number;
  };
  categories: {
    total: number;
    roots: number;
    by_depth: Record<number, number>;
    with_published_products: number;
    empty: number;
    with_description: number;
    with_seo: number;
    with_thumbnail: number;
    /** Slugs in import order (parents first, D24 sibling order). */
    order: string[];
  };
  product_category_links: { total: number; published: number; draft: number };
  tags: { terms: number; links: number };
  faqs: { items: number; products: number };
  personalization: {
    presets: number;
    products: number;
    by_key: Partial<Record<PresetKey, number>>;
    broken: number;
    staged: boolean;
  };
  designer: {
    products_linked: number;
    fallback_fields: number;
    templates: number;
    templates_linked: number;
    template_assets: number;
    template_thumbnails: number;
  };
  media: {
    public_distinct: number;
    private_distinct: number;
    missing_in_bundle: number;
  };
  shipping: {
    zones_available: boolean;
    classes_used: string[];
    zones: number;
    methods_enabled: number;
  };
  redirects: {
    total: number;
    by_rule: Record<string, number>;
    preview: RedirectCandidate[];
  };
  old_slugs: {
    total: number;
    redirected: number;
    excluded: { external_ref: string; slug: string; reason: string }[];
  };
  term_cleanup: {
    taxonomy: string;
    slug: string;
    before: string;
    after: string;
    rules: string[];
  }[];
  warnings: Record<string, { count: number; samples: WarningSample[] }>;
  skipped: { external_ref: string; title: string; reason: string }[];
  unmapped_meta_prefixes: Record<string, number>;
}

const DEFAULT_STATUS_MAP: Record<string, string> = {
  publish: 'PUBLISHED',
  draft: 'DRAFT',
  pending: 'DRAFT',
  future: 'DRAFT',
  private: 'DRAFT',
};

export const NPP_FALLBACK_FIELDS = ['Namn', 'Klass', 'Foto'] as const;

function inc<K extends string | number>(
  rec: Record<K, number>,
  key: K,
  by = 1,
): void {
  rec[key] = (rec[key] ?? 0) + by;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Minimal form of §6.2 normalization (the redirects module owns the full one). */
export function redirectPath(...segments: string[]): string {
  const p =
    '/' +
    segments
      .map((s) => s.replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
      .join('/');
  return safeDecode(p)
    .normalize('NFC')
    .toLowerCase()
    .replace(/\/{2,}/g, '/');
}

function isImportedPublished(
  p: NProduct,
  map: Record<string, string>,
): boolean {
  return (map[p.status] ?? 'DRAFT') === 'PUBLISHED';
}

/** §6.1 redirect generation over the imported/skipped product sets. */
export function buildRedirectCandidates(
  catalog: NormalizedCatalog,
  imported: NProduct[],
  skipped: NProduct[],
  opts: {
    redirect_skipped?: boolean;
    status_map?: Record<string, string>;
  } = {},
): {
  candidates: RedirectCandidate[];
  excludedOldSlugs: { external_ref: string; slug: string; reason: string }[];
} {
  const statusMap = { ...DEFAULT_STATUS_MAP, ...(opts.status_map ?? {}) };
  const { bases } = catalog.meta;
  const out: RedirectCandidate[] = [];
  const seen = new Set<string>();
  const add = (c: RedirectCandidate) => {
    if (seen.has(c.from)) return;
    seen.add(c.from);
    out.push(c);
  };
  const excludedOldSlugs: {
    external_ref: string;
    slug: string;
    reason: string;
  }[] = [];
  const published = imported.filter((p) => isImportedPublished(p, statusMap));
  const liveSlugs = new Set(published.map((p) => p.slug));

  for (const p of published) {
    add({
      from: redirectPath(bases.product, p.slug),
      to: `/products/${p.slug}`,
      rule: 'product',
      external_ref: p.ext_id,
    });
  }
  for (const p of imported) {
    for (const old of p.old_slugs) {
      let reason: string | null = null;
      if (/__trashed$/.test(old)) reason = 'trashed';
      else if (!isImportedPublished(p, statusMap)) reason = 'draft';
      else if (liveSlugs.has(old)) reason = 'equals_live_slug';
      else if (old === p.slug) reason = 'equals_current_slug';
      if (reason) {
        excludedOldSlugs.push({ external_ref: p.ext_id, slug: old, reason });
        continue;
      }
      add({
        from: redirectPath(bases.product, old),
        to: `/products/${p.slug}`,
        rule: 'old_slug',
        external_ref: p.ext_id,
      });
    }
  }
  if (opts.redirect_skipped !== false) {
    const catBySlug = new Map(catalog.categories.map((c) => [c.ext_id, c]));
    for (const p of skipped) {
      if (p.status !== 'publish') continue;
      const first = p.category_ext_ids
        .map((e) => catBySlug.get(e))
        .find(Boolean);
      add({
        from: redirectPath(bases.product, p.slug),
        to: first ? `/collections/${first.slug}` : '/',
        rule: 'skipped_product',
        external_ref: p.ext_id,
      });
    }
  }
  for (const c of catalog.categories) {
    add({
      from: redirectPath(bases.category, ...c.path),
      to: `/collections/${c.slug}`,
      rule: 'category_path',
      external_ref: c.ext_id,
    });
  }
  for (const c of catalog.categories) {
    if (c.depth > 0) {
      add({
        from: redirectPath(bases.category, c.slug),
        to: `/collections/${c.slug}`,
        rule: 'category_leaf',
        external_ref: c.ext_id,
      });
    }
  }
  for (const t of catalog.tags) {
    const on = imported.filter((p) => p.tag_ext_ids.includes(t.ext_id));
    add({
      from: redirectPath(bases.tag, t.slug),
      to: on.length === 1 ? `/products/${on[0].slug}` : '/',
      rule: 'tag',
      external_ref: t.ext_id,
    });
  }
  return { candidates: out, excludedOldSlugs };
}

function unmappedPrefix(key: string): string {
  const m = /^(_*[A-Za-z0-9]+)/.exec(key);
  return m ? `${m[1]}*` : key;
}

export function summarizeCatalog(
  catalog: NormalizedCatalog,
  options: DryRunOptions = {},
): DryRunSummary {
  const statusMap = { ...DEFAULT_STATUS_MAP, ...(options.status_map ?? {}) };
  const maxSamples = options.max_samples ?? 10;
  const skipSet = new Set(options.skip_ext_ids ?? []);
  const includeDrafts = options.include_drafts !== false;
  const presetsAvailable = options.personalization_available === true;
  const designerAvailable = options.designer_available === true;
  const fallbackFields = options.designer_fallback_fields !== false;

  const warnings: DryRunSummary['warnings'] = {};
  const warn = (code: string, sample: WarningSample, by = 1) => {
    const w = (warnings[code] ??= { count: 0, samples: [] });
    w.count += by;
    if (w.samples.length < maxSamples) w.samples.push(sample);
  };
  const counts: DryRunSummary['counts'] = {};
  const count = (type: SummaryEntityType, action: SummaryAction, by = 1) => {
    if (by <= 0) return;
    const rec = (counts[type] ??= {});
    rec[action] = (rec[action] ?? 0) + by;
  };

  for (const issue of catalog.issues) {
    if (issue.level === 'info') continue;
    warn(issue.code, {
      external_ref: issue.external_ref,
      message: issue.message,
    });
  }

  // --- Products ------------------------------------------------------------
  const imported: NProduct[] = [];
  const skippedProducts: NProduct[] = [];
  const skipped: DryRunSummary['skipped'] = [];
  for (const p of catalog.products) {
    let reason: string | null = null;
    if (skipSet.has(p.ext_id)) reason = 'skip_list';
    else if (!includeDrafts && p.status !== 'publish')
      reason = 'draft_excluded';
    if (reason) {
      skippedProducts.push(p);
      skipped.push({ external_ref: p.ext_id, title: p.title, reason });
      warn('W_PRODUCT_SKIPPED_BY_RULE', {
        external_ref: p.ext_id,
        title: p.title,
        message: reason,
      });
      count('PRODUCT', 'SKIP');
    } else {
      imported.push(p);
      count('PRODUCT', 'CREATE');
    }
  }

  const products: DryRunSummary['products'] = {
    in_source: catalog.products.length,
    imported: imported.length,
    skipped: skippedProducts.length,
    by_status: {},
    by_target_status: {},
    by_type: {},
    traditional: 0,
    customizable: 0,
    by_customization_type: {},
  };
  const variants: DryRunSummary['variants'] = {
    in_source: catalog.products.reduce((n, p) => n + p.variations.length, 0),
    imported: 0,
    published_products: 0,
    draft_products: 0,
    dropped_any: 0,
    expanded_any: 0,
    inactive: 0,
    per_product: {},
  };
  const option_configs: DryRunSummary['option_configs'] = {
    total: 0,
    color_maps: 0,
    swatch_maps: 0,
    value_meta: {},
  };
  const images: DryRunSummary['images'] = {
    rows: 0,
    published_rows: 0,
    draft_rows: 0,
    distinct: 0,
    published_distinct: 0,
    missing_in_bundle: 0,
  };
  const links: DryRunSummary['product_category_links'] = {
    total: 0,
    published: 0,
    draft: 0,
  };
  const faqs = { items: 0, products: 0 };
  const personalization: DryRunSummary['personalization'] = {
    presets: 0,
    products: 0,
    by_key: {},
    broken: 0,
    staged: !presetsAvailable,
  };
  const designer: DryRunSummary['designer'] = {
    products_linked: 0,
    fallback_fields: 0,
    templates: catalog.templates.length,
    templates_linked: catalog.templates.filter((t) =>
      t.linked_product_ext_ids.some((e) => !skipSet.has(e)),
    ).length,
    template_assets: 0,
    template_thumbnails: 0,
  };
  const publicMedia = new Set<string>();
  const privateMedia = new Set<string>();
  let missingMedia = 0;
  const unmapped: Record<string, number> = {};
  const attrByTax = new Map(catalog.attributes.map((a) => [a.taxonomy, a]));
  const usedTaxonomies = new Set<string>();
  const usedTerms = new Map<string, Set<string>>();
  const valueMetaSeen = new Map<string, Set<string>>();
  const publishedCategoryRefs = new Map<string, number>();
  const tagLinks = { links: 0 };
  const classesUsed = new Set<string>();
  const now = Date.now();

  for (const p of imported) {
    const target = statusMap[p.status] ?? 'DRAFT';
    inc(products.by_status, p.status);
    inc(products.by_target_status, target);
    inc(products.by_type, p.type);
    if (p.status === 'private')
      warn('W_PRODUCT_PRIVATE_AS_DRAFT', {
        external_ref: p.ext_id,
        title: p.title,
        message: 'private → DRAFT',
      });
    const published = target === 'PUBLISHED';

    // Customization type (options rules, §12.2).
    const kinds = p.personalization
      .filter((m) => m.kind !== 'broken')
      .map((m) => m.kind as string);
    const designerOn = !!p.designer?.enabled;
    if (kinds.length || designerOn) {
      products.customizable++;
      const rule = (options.customization_type_rules ?? []).find(
        (r) =>
          (r.mechanisms && r.mechanisms.some((m) => kinds.includes(m))) ||
          (r.designer && designerOn),
      );
      inc(products.by_customization_type, rule ? rule.type : 'UNSPECIFIED');
    } else {
      products.traditional++;
    }

    // Variants (D20, D21).
    if (p.type === 'variable') {
      const res = resolveAnyVariations(p);
      const kept = [...res.concrete, ...res.expanded];
      variants.imported += kept.length;
      variants.per_product[p.ext_id] = kept.length;
      if (published) variants.published_products += kept.length;
      else variants.draft_products += kept.length;
      variants.dropped_any += res.dropped.length;
      variants.expanded_any += res.expanded.length;
      variants.inactive += kept.filter(
        (v) => v.status === 'private' || v.stock.status === 'outofstock',
      ).length;
      count('VARIANT', 'CREATE', kept.length);
      count('VARIANT', 'SKIP', res.dropped.length + res.too_large.length);
      if (res.dropped.length) {
        warn(
          'W_VARIATION_ANY_DROPPED',
          {
            external_ref: p.ext_id,
            title: p.title,
            message: `${res.dropped.length} "any value" variations covered by concrete ones`,
          },
          res.dropped.length,
        );
      }
      if (res.expanded.length) {
        warn(
          'W_VARIATION_ANY_EXPANDED',
          {
            external_ref: p.ext_id,
            title: p.title,
            message: `${res.expanded.length} combinations generated`,
          },
          res.expanded.length,
        );
      }
      if (res.too_large.length) {
        warn(
          'W_VARIATION_ANY_TOO_LARGE',
          {
            external_ref: p.ext_id,
            title: p.title,
            message: `${res.too_large.length} "any" variations not expanded`,
          },
          res.too_large.length,
        );
      }

      const varAttrs = p.attributes.filter((a) => a.variation);
      if (varAttrs.length) {
        option_configs.total++;
        count('OPTION_CONFIG', 'CREATE');
      }
      for (const a of varAttrs) {
        usedTaxonomies.add(a.key);
        const set = usedTerms.get(a.key) ?? new Set<string>();
        a.values.forEach((v) => set.add(v));
        usedTerms.set(a.key, set);
        const def = attrByTax.get(a.key);
        if (!def) continue;
        const terms = def.terms.filter((t) => a.values.includes(t.slug));
        if (def.swatch_type === 'color' && terms.some((t) => t.color))
          option_configs.color_maps++;
        if (def.swatch_type === 'image' && terms.some((t) => t.image)) {
          option_configs.swatch_maps++;
          for (const t of terms) {
            if (t.image?.missing) continue;
            if (t.image?.url) publicMedia.add(t.image.url);
          }
        }
        for (const t of terms) {
          const c = t.card;
          if (c && (c.label || c.size || c.badge || c.badge_color)) {
            const seen = valueMetaSeen.get(a.key) ?? new Set<string>();
            seen.add(t.slug);
            valueMetaSeen.set(a.key, seen);
          }
        }
        if (options.label_overrides?.[a.key] !== undefined) {
          warn('W_LABEL_OVERRIDDEN', {
            external_ref: p.ext_id,
            title: p.title,
            message: `${a.key}: "${def.label}" → "${options.label_overrides[a.key]}"`,
          });
        }
      }
    }
    for (const a of p.attributes.filter((x) => !x.variation)) {
      usedTaxonomies.add(a.key);
      const set = usedTerms.get(a.key) ?? new Set<string>();
      a.values.forEach((v) => set.add(v));
      usedTerms.set(a.key, set);
      warn('W_ATTRIBUTE_NOT_VARIATION_UNMAPPED', {
        external_ref: p.ext_id,
        title: p.title,
        message: `${a.key} (${a.values.length} values)`,
      });
    }

    // Prices (D19): scheduled sales.
    if (p.price.sale_from && Date.parse(p.price.sale_from) > now) {
      warn('W_SALE_SCHEDULE_IGNORED', {
        external_ref: p.ext_id,
        title: p.title,
        message: `sale starts ${p.price.sale_from}`,
      });
    }

    // Images.
    for (const img of p.images) {
      images.rows++;
      if (published) images.published_rows++;
      else images.draft_rows++;
      if (img.missing) {
        images.missing_in_bundle++;
        missingMedia++;
      } else publicMedia.add(img.url);
    }
    count('IMAGE', 'CREATE', p.images.filter((i) => !i.missing).length);
    count('IMAGE', 'SKIP', p.images.filter((i) => i.missing).length);

    // Categories and tags.
    links.total += p.category_ext_ids.length;
    if (published) {
      links.published += p.category_ext_ids.length;
      for (const c of p.category_ext_ids)
        publishedCategoryRefs.set(c, (publishedCategoryRefs.get(c) ?? 0) + 1);
    } else links.draft += p.category_ext_ids.length;
    count('PRODUCT_CATEGORY', 'CREATE', p.category_ext_ids.length);
    if (
      p.primary_category_ext_id &&
      !p.category_ext_ids.includes(p.primary_category_ext_id)
    ) {
      warn('W_PRIMARY_CATEGORY_NOT_ASSIGNED', {
        external_ref: p.ext_id,
        title: p.title,
        message: `primary ${p.primary_category_ext_id} is not assigned`,
      });
    }
    tagLinks.links += p.tag_ext_ids.length;
    if (p.shipping_class_slug) classesUsed.add(p.shipping_class_slug);

    // Report-only data.
    if (p.upsell_ext_ids.length)
      warn('W_UPSELL_UNMAPPED', {
        external_ref: p.ext_id,
        title: p.title,
        message: p.upsell_ext_ids.join(', '),
      });
    if (p.seo.focus_keyword)
      warn('W_FOCUS_KEYWORD_UNMAPPED', {
        external_ref: p.ext_id,
        title: p.title,
        message: p.seo.focus_keyword,
      });
    if (p.extras.videos.length)
      warn('W_VIDEO_UNSUPPORTED', {
        external_ref: p.ext_id,
        title: p.title,
        message: p.extras.videos.join(', '),
      });

    // HTML (description, excerpt, FAQ answers).
    const htmls = [
      p.content_html,
      p.excerpt_html,
      ...p.extras.faq.map((f) => f.html),
    ];
    let sanitized = false;
    for (const html of htmls) {
      const scan = scanHtml(html);
      if (
        scan.data_attributes ||
        scan.unsafe_elements ||
        scan.event_handlers ||
        scan.javascript_urls
      )
        sanitized = true;
      if (scan.shortcodes.namez_card || scan.shortcodes.caption) {
        warn('W_SHORTCODE_REMOVED', {
          external_ref: p.ext_id,
          title: p.title,
          message: `namez_card ×${scan.shortcodes.namez_card}, caption ×${scan.shortcodes.caption}`,
        });
      }
      const foreign = scan.inline_images.filter((u) => {
        try {
          return (
            new URL(u, catalog.meta.uploads_base).hostname !==
            catalog.meta.site_host
          );
        } catch {
          return true;
        }
      });
      if (foreign.length)
        warn(
          'W_HTML_IMAGE_REMOVED',
          {
            external_ref: p.ext_id,
            title: p.title,
            message: `${foreign.length} inline image(s) on other hosts`,
          },
          foreign.length,
        );
    }
    if (sanitized)
      warn('W_HTML_SANITIZED', {
        external_ref: p.ext_id,
        title: p.title,
        message: 'data-*/unsafe markup will be removed',
      });

    // FAQs.
    if (p.extras.faq.length) {
      faqs.items += p.extras.faq.length;
      faqs.products++;
      count('FAQ', 'CREATE', p.extras.faq.length);
    }

    // Personalization (M4.1 port).
    const { presets, skipped: broken } = presetDescriptorsFor(
      p,
      catalog,
      options,
    );
    if (presets.length) personalization.products++;
    personalization.presets += presets.length;
    for (const d of presets)
      inc(personalization.by_key as Record<string, number>, d.key);
    count(
      'PERSONALIZATION',
      presetsAvailable ? 'CREATE' : 'STAGE',
      presets.length,
    );
    if (presets.length && !presetsAvailable) {
      warn(
        'W_PERSONALIZATION_STAGED',
        {
          external_ref: p.ext_id,
          title: p.title,
          message: presets.map((d) => d.key).join(', '),
        },
        presets.length,
      );
    }
    for (const b of broken) {
      personalization.broken++;
      warn('W_PERSONALIZATION_BROKEN_CONFIG', {
        external_ref: p.ext_id,
        title: p.title,
        message: `${b.detector}: ${b.reason}`,
      });
    }

    // Designer (M4.2 port) / fallback fields.
    if (designerOn) {
      designer.products_linked++;
      // Fallback fields are planned whether or not the designer is available
      // (links are imported disabled; see planner D28 note).
      if (fallbackFields) {
        designer.fallback_fields += NPP_FALLBACK_FIELDS.length;
        count('FALLBACK_FIELD', 'CREATE', NPP_FALLBACK_FIELDS.length);
      }
    }

    for (const key of p.unmapped_meta_keys) inc(unmapped, unmappedPrefix(key));
    if (p.unmapped_meta_keys.length) {
      warn(
        'W_UNKNOWN_PLUGIN_META',
        {
          external_ref: p.ext_id,
          title: p.title,
          message: p.unmapped_meta_keys.join(', '),
        },
        p.unmapped_meta_keys.length,
      );
    }
  }

  for (const [tax, set] of valueMetaSeen)
    option_configs.value_meta[tax] = set.size;

  // Attributes / terms that no imported product uses (§12.4 item 3).
  for (const a of catalog.attributes) {
    if (!usedTaxonomies.has(a.taxonomy)) {
      warn('W_ATTRIBUTE_UNUSED', {
        external_ref: a.ext_id,
        title: a.label,
        message: `${a.taxonomy} is not used by any imported product`,
      });
      continue;
    }
    const used = usedTerms.get(a.taxonomy) ?? new Set<string>();
    for (const t of a.terms) {
      if (!used.has(t.slug))
        warn('W_ATTRIBUTE_UNUSED', {
          external_ref: t.ext_id,
          title: t.name,
          message: `term ${a.taxonomy}/${t.slug} is not used`,
        });
    }
  }

  // Term cleanup preview (D22) for terms in use.
  const term_cleanup: DryRunSummary['term_cleanup'] = [];
  for (const a of catalog.attributes) {
    const used = usedTerms.get(a.taxonomy);
    if (!used) continue;
    for (const t of a.terms) {
      if (!used.has(t.slug)) continue;
      const c = cleanTermName(t.name, options.term_cleanup);
      if (c.changed) {
        term_cleanup.push({
          taxonomy: a.taxonomy,
          slug: t.slug,
          before: c.before,
          after: c.value,
          rules: c.applied,
        });
        warn('W_TERM_NAME_CLEANED', {
          external_ref: t.ext_id,
          title: t.name,
          message: `"${c.before}" → "${c.value}"`,
        });
      }
    }
  }

  // Categories.
  const byDepth: Record<number, number> = {};
  let withDesc = 0;
  let withSeo = 0;
  let withThumb = 0;
  for (const c of catalog.categories) {
    inc(byDepth, c.depth);
    if (c.description_html.trim()) withDesc++;
    if (c.seo.title || c.seo.description) withSeo++;
    if (c.thumbnail && !c.thumbnail.missing) {
      withThumb++;
      publicMedia.add(c.thumbnail.url);
    }
    if (c.seo.focus_keyword)
      warn('W_FOCUS_KEYWORD_UNMAPPED', {
        external_ref: c.ext_id,
        title: c.name,
        message: c.seo.focus_keyword,
      });
    const cleaned = cleanText(c.name);
    if (cleaned !== c.name)
      warn('W_TERM_NAME_CLEANED', {
        external_ref: c.ext_id,
        title: c.name,
        message: `"${c.name}" → "${cleaned}"`,
      });
  }
  count('CATEGORY', 'CREATE', catalog.categories.length);
  const withPublished = catalog.categories.filter(
    (c) => (publishedCategoryRefs.get(c.ext_id) ?? 0) > 0,
  ).length;

  // Tags.
  count('TAG', 'CREATE', tagLinks.links);
  for (const t of catalog.tags) {
    const cleaned = cleanText(t.name);
    if (cleaned !== t.name)
      warn('W_TERM_NAME_CLEANED', {
        external_ref: t.ext_id,
        title: t.name,
        message: `"${t.name}" → "${cleaned}"`,
      });
  }

  // Templates (M4.2).
  for (const t of catalog.templates) {
    t.assets.forEach((a) => privateMedia.add(a.url));
    if (t.thumbnail && !t.thumbnail.missing) {
      privateMedia.add(t.thumbnail.url);
      designer.template_thumbnails++;
    }
    if (!designerAvailable)
      warn('W_TEMPLATE_STAGED', {
        external_ref: t.ext_id,
        title: t.title,
        message: `${t.linked_product_ext_ids.length} linked products`,
      });
  }
  designer.template_assets = new Set(
    catalog.templates.flatMap((t) => t.assets.map((a) => a.url)),
  ).size;
  count(
    'DESIGN_TEMPLATE',
    designerAvailable ? 'CREATE' : 'STAGE',
    catalog.templates.length,
  );

  // Shipping.
  const shipping = catalog.shipping;
  const shippingSummary: DryRunSummary['shipping'] = {
    zones_available: !!shipping?.zones_available,
    classes_used: [...classesUsed].sort(),
    zones: shipping?.zones.length ?? 0,
    methods_enabled:
      shipping?.zones.reduce(
        (n, z) => n + z.methods.filter((m) => m.enabled).length,
        0,
      ) ?? 0,
  };
  if (shipping?.zones_available) {
    count('SHIPPING_PROFILE', 'CREATE', 1 + classesUsed.size);
    count('SHIPPING_ZONE', 'CREATE', shipping.zones.length);
    count('SHIPPING_METHOD', 'CREATE', shippingSummary.methods_enabled);
  }

  // Media.
  count('MEDIA', 'CREATE', publicMedia.size + privateMedia.size);
  const distinctImages = (list: NProduct[]) =>
    new Set(list.flatMap((p) => p.images.map((i) => i.ext_id ?? i.url))).size;
  images.distinct = distinctImages(imported);
  images.published_distinct = distinctImages(
    imported.filter((p) => isImportedPublished(p, statusMap)),
  );

  // Redirects.
  const { candidates, excludedOldSlugs } = buildRedirectCandidates(
    catalog,
    imported,
    skippedProducts,
    options,
  );
  const byRule: Record<string, number> = {};
  for (const c of candidates) inc(byRule, c.rule);
  count('REDIRECT', 'CREATE', candidates.length);

  return {
    source: {
      kind: catalog.meta.kind,
      format_version: catalog.meta.format_version,
      site_host: catalog.meta.site_host,
    },
    counts,
    products,
    variants,
    option_configs,
    images,
    categories: {
      total: catalog.categories.length,
      roots: byDepth[0] ?? 0,
      by_depth: byDepth,
      with_published_products: withPublished,
      empty: catalog.categories.length - withPublished,
      with_description: withDesc,
      with_seo: withSeo,
      with_thumbnail: withThumb,
      order: catalog.categories.map((c) => c.slug),
    },
    product_category_links: links,
    tags: { terms: catalog.tags.length, links: tagLinks.links },
    faqs,
    personalization,
    designer,
    media: {
      public_distinct: publicMedia.size,
      private_distinct: privateMedia.size,
      missing_in_bundle: missingMedia,
    },
    shipping: shippingSummary,
    redirects: {
      total: candidates.length,
      by_rule: byRule,
      preview: candidates.slice(0, 50),
    },
    old_slugs: {
      total: imported.reduce((n, p) => n + p.old_slugs.length, 0),
      redirected: byRule.old_slug ?? 0,
      excluded: excludedOldSlugs,
    },
    term_cleanup,
    warnings,
    skipped,
    unmapped_meta_prefixes: unmapped,
  };
}
