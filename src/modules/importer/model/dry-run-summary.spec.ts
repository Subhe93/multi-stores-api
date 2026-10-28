import { DirectoryBundleReader } from '../adapters/bundle-reader';
import { WpBundleAdapter } from '../adapters/wp-bundle/wp-bundle.adapter';
import {
  catalogRedirects,
  NAMEZ_RUN_OPTIONS,
  NAMEZ_SOURCE,
  SLICE_DIR,
  v1Sample,
} from '../adapters/wp-bundle/__fixtures__/fixtures';
import {
  DryRunSummary,
  redirectPath,
  summarizeCatalog,
} from './dry-run-summary';
import type { NormalizedCatalog } from './normalized';

describe('summarizeCatalog — real Namez slice', () => {
  let catalog: NormalizedCatalog;
  let s: DryRunSummary;

  beforeAll(async () => {
    catalog = await new WpBundleAdapter().load({
      bundle: new DirectoryBundleReader(SLICE_DIR),
      source: NAMEZ_SOURCE,
    });
    s = summarizeCatalog(catalog, NAMEZ_RUN_OPTIONS);
  });

  it('skips 4326 (U4) and imports the rest, drafts included', () => {
    expect(s.products).toMatchObject({
      in_source: 8,
      imported: 7,
      skipped: 1,
      by_status: { publish: 6, draft: 1 },
      by_target_status: { PUBLISHED: 6, DRAFT: 1 },
      by_type: { variable: 5, simple: 2 },
      traditional: 1,
      customizable: 6,
      by_customization_type: { PRINT_3D: 4, ENGRAVE: 1, PRINT: 1 },
    });
    expect(s.skipped).toEqual([
      {
        external_ref: 'woo:namez.se:product:4326',
        title: 'Studentskylt med gulddetaljer',
        reason: 'skip_list',
      },
    ]);
    expect(s.counts.PRODUCT).toEqual({ CREATE: 7, SKIP: 1 });
  });

  it('drops the 12 "any font" variations (D21) and counts per product', () => {
    expect(s.variants).toMatchObject({
      in_source: 139,
      imported: 127,
      dropped_any: 12,
      expanded_any: 0,
      per_product: {
        'woo:namez.se:product:2229': 27,
        'woo:namez.se:product:2826': 48,
        'woo:namez.se:product:3484': 10,
        'woo:namez.se:product:4106': 35,
        'woo:namez.se:product:4414': 7,
      },
    });
    expect(s.counts.VARIANT).toEqual({ CREATE: 127, SKIP: 12 });
    expect(s.warnings.W_VARIATION_ANY_DROPPED.count).toBe(12);
  });

  it('option configs: colour maps, the engraving swatchMap and valueMeta', () => {
    expect(s.option_configs).toEqual({
      total: 5,
      color_maps: 5,
      swatch_maps: 1,
      value_meta: { pa_storlek: 3, pa_namnskylt_stor_bokstav: 5 },
    });
  });

  it('personalization presets are staged until the M4.1 port is available', () => {
    expect(s.personalization).toEqual({
      presets: 7,
      products: 5,
      by_key: {
        names_equal_length: 1,
        engravings: 1,
        single_name: 3,
        name_color_per_item: 1,
        checkbox_group: 1,
      },
      broken: 1,
      staged: true,
    });
    expect(s.counts.PERSONALIZATION).toEqual({ STAGE: 7 });
    expect(
      summarizeCatalog(catalog, {
        ...NAMEZ_RUN_OPTIONS,
        personalization_available: true,
      }).counts.PERSONALIZATION,
    ).toEqual({ CREATE: 7 });
    expect(s.warnings.W_PERSONALIZATION_BROKEN_CONFIG.samples[0]).toMatchObject(
      { external_ref: 'woo:namez.se:product:4414' },
    );
  });

  it('NPP: fallback fields for linked products, templates staged', () => {
    expect(s.designer).toMatchObject({
      products_linked: 1,
      fallback_fields: 3,
      templates: 2,
      templates_linked: 1,
    });
    expect(s.counts.DESIGN_TEMPLATE).toEqual({ STAGE: 2 });
    // Imported designer links are disabled, so fallback fields are kept even
    // when the designer is available; only the option turns them off.
    expect(
      summarizeCatalog(catalog, {
        ...NAMEZ_RUN_OPTIONS,
        designer_available: true,
      }).designer.fallback_fields,
    ).toBe(3);
    expect(
      summarizeCatalog(catalog, {
        ...NAMEZ_RUN_OPTIONS,
        designer_available: true,
        designer_fallback_fields: false,
      }).designer.fallback_fields,
    ).toBe(0);
  });

  it('term cleanup preview lists only terms in use', () => {
    expect(s.term_cleanup).toEqual(
      expect.arrayContaining([
        {
          taxonomy: 'pa_storlek',
          slug: 'liten-13-16-cm',
          before: 'Liten (13–16 cm) - 350 kr',
          after: 'Liten (13–16 cm)',
          rules: ['price_suffix'],
        },
        {
          taxonomy: 'pa_antal-inskriptioner',
          slug: '2',
          before: '2 Inskriptioner (+50 kr)',
          after: '2 Inskriptioner',
          rules: ['price_suffix'],
        },
        {
          taxonomy: 'pa_namnskylt_stor_bokstav',
          slug: '1-produkt',
          before: '1 produkt:',
          after: '1 produkt',
          rules: ['trailing_colon'],
        },
        {
          taxonomy: 'pa_farg',
          slug: 'blank-silver',
          before: 'Blank\u00a0Silver',
          after: 'Blank Silver',
          rules: ['unicode'],
        },
      ]),
    );
    expect(s.term_cleanup.some((t) => t.taxonomy === 'pa_rakna')).toBe(false);
  });

  // The catalog summary leaves redirects to the planner (map-redirects over
  // the final slugs); the §6.1 rules are checked on the same catalog here.
  it('redirects follow §6.1 (old slugs: trashed and drafts excluded)', () => {
    expect(s.redirects).toEqual({ total: 0, by_rule: {}, preview: [] });
    expect(s.old_slugs).toMatchObject({ redirected: 0, excluded: [] });
    const r = catalogRedirects(catalog, NAMEZ_RUN_OPTIONS);
    const byRule: Record<string, number> = {};
    for (const c of r.candidates) byRule[c.rule] = (byRule[c.rule] ?? 0) + 1;
    expect(byRule).toMatchObject({
      product: 6,
      old_slug: 4,
      skipped_product: 1,
      tag: 2,
    });
    expect(r.excludedOldSlugs.map((e) => e.reason).sort()).toEqual([
      'draft',
      'trashed',
    ]);
    const skippedRedirect = r.candidates.find(
      (c) => c.rule === 'skipped_product',
    );
    expect(skippedRedirect).toEqual({
      from: '/produkt/studentskylt-med-gulddetaljer',
      to: '/collections/3d_presenter',
      rule: 'skipped_product',
      external_ref: 'woo:namez.se:product:4326',
      status_code: 301,
    });
    expect(r.candidates).toContainEqual({
      from: '/produkt/personlig-3d-namnpresent-gor-dina-ord-till-en-present',
      to: '/products/personlig-3d-namnpresent',
      rule: 'old_slug',
      external_ref: 'woo:namez.se:product:2229',
      status_code: 301,
    });
    const cat = r.candidates.find(
      (c) =>
        c.rule === 'category_path' &&
        c.to ===
          '/collections/presenter-till-vem/studentpresent/studentpresent-till-kille',
    );
    expect(cat?.from).toBe(
      '/product-category/presenter-till-vem/studentpresent/studentpresent-till-kille',
    );
    expect(r.candidates).toHaveLength(
      6 +
        4 +
        1 +
        s.categories.total +
        (s.categories.total - s.categories.roots) +
        2,
    );
  });

  it('report-only warnings: images missing in the legacy bundle, HTML, videos, focus keywords, primary category', () => {
    expect(s.images.missing_in_bundle).toBe(1);
    expect(s.warnings.W_MEDIA_MISSING_IN_BUNDLE.count).toBeGreaterThanOrEqual(
      5,
    );
    expect(s.warnings.W_HTML_SANITIZED.count).toBeGreaterThan(0);
    expect(s.warnings.W_VIDEO_UNSUPPORTED.count).toBe(3);
    expect(s.warnings.W_SHORTCODE_REMOVED.count).toBeGreaterThanOrEqual(1);
    expect(s.warnings.W_ATTRIBUTE_NOT_VARIATION_UNMAPPED.count).toBe(1);
    expect(s.warnings.W_SHIPPING_NOT_IN_BUNDLE.count).toBe(1);
    expect(s.warnings.W_TEMPLATE_STAGED.count).toBe(2);
    expect(Object.values(s.warnings).every((w) => w.samples.length <= 10)).toBe(
      true,
    );
    expect(s.unmapped_meta_prefixes).toEqual({});
  });

  it('is JSON-serializable (stored in ImportRun.summary)', () => {
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe('summarizeCatalog — v1 sample', () => {
  it('counts shipping, groups unmapped meta and flags scheduled sales', async () => {
    const catalog = await new WpBundleAdapter().load({
      bundle: v1Sample(),
      source: {
        kind: 'WP_BUNDLE',
        site_host: 'shop.example',
        host_aliases: ['old.example'],
        settings: {},
      },
    });
    const s = summarizeCatalog(catalog, { include_drafts: false });
    expect(s.shipping).toEqual({
      zones_available: true,
      classes_used: ['stor'],
      zones: 2,
      methods_enabled: 2,
    });
    expect(s.counts.SHIPPING_ZONE).toEqual({ CREATE: 2 });
    expect(s.counts.SHIPPING_PROFILE).toEqual({ CREATE: 2 });
    expect(s.unmapped_meta_prefixes).toEqual({ '_crosssell*': 1 });
    expect(s.warnings.W_SALE_SCHEDULE_IGNORED.count).toBe(1);
    expect(s.variants).toMatchObject({
      imported: 2,
      expanded_any: 1,
      dropped_any: 0,
    });
  });
});

describe('redirectPath', () => {
  it('joins, decodes and lower-cases', () => {
    expect(redirectPath('produkt', 'Fars-Dag%C3%A5')).toBe(
      '/produkt/fars-dagå',
    );
    expect(redirectPath('/product-category/', 'a', 'b/')).toBe(
      '/product-category/a/b',
    );
    expect(redirectPath('x', '%E0%A4%A')).toBe('/x/%e0%a4%a');
  });
});
