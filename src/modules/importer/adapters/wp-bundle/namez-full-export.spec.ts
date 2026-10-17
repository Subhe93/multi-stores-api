import { existsSync } from 'fs';
import { join } from 'path';
import { DirectoryBundleReader } from '../bundle-reader';
import { WpBundleAdapter } from './wp-bundle.adapter';
import {
  catalogRedirects,
  NAMEZ_EXPORT_DIR,
  NAMEZ_RUN_OPTIONS,
  NAMEZ_SOURCE,
} from './__fixtures__/fixtures';
import { DryRunSummary, summarizeCatalog } from '../../model/dry-run-summary';
import type { NormalizedCatalog, NProduct } from '../../model/normalized';

/**
 * Full read-only Namez export (2026-10-15) against the counts of
 * M4.4-DESIGN §12.3. The export is client data and is not copied into the
 * repository; set NAMEZ_EXPORT_DIR to run this suite elsewhere. Skipped
 * when the directory is absent.
 */
const available = existsSync(join(NAMEZ_EXPORT_DIR, 'posts.tsv'));
const describeIfExport = available ? describe : describe.skip;

describeIfExport(
  'Namez full export (legacy bundle) — M4.4 §12.3 counts',
  () => {
    let catalog: NormalizedCatalog;
    let s: DryRunSummary;
    const product = (id: number): NProduct =>
      catalog.products.find((p) => p.source_id === String(id))!;

    beforeAll(async () => {
      catalog = await new WpBundleAdapter().load({
        bundle: new DirectoryBundleReader(NAMEZ_EXPORT_DIR),
        source: NAMEZ_SOURCE,
      });
      s = summarizeCatalog(catalog, NAMEZ_RUN_OPTIONS);
    });

    it('source content: 36 products, 244 variations, 10 templates, no parser issues beyond media/shipping', () => {
      expect(catalog.products).toHaveLength(36);
      expect(
        catalog.products.reduce((n, p) => n + p.variations.length, 0),
      ).toBe(244);
      expect(catalog.templates).toHaveLength(10);
      expect(new Set(catalog.issues.map((i) => i.code))).toEqual(
        new Set(['W_MEDIA_MISSING_IN_BUNDLE', 'W_SHIPPING_NOT_IN_BUNDLE']),
      );
    });

    it('products: 35 imported (33 PUBLISHED + 2 DRAFT), 4326 skipped (U4), 25 simple + 10 variable', () => {
      expect(s.products).toEqual({
        in_source: 36,
        imported: 35,
        skipped: 1,
        by_status: { publish: 33, draft: 2 },
        by_target_status: { PUBLISHED: 33, DRAFT: 2 },
        by_type: { variable: 10, simple: 25 },
        traditional: 1,
        customizable: 34,
        by_customization_type: { PRINT_3D: 9, ENGRAVE: 1, PRINT: 24 },
      });
      expect(s.skipped.map((x) => x.external_ref)).toEqual([
        'woo:namez.se:product:4326',
      ]);
      expect(
        catalog.products
          .filter((p) => p.status === 'draft')
          .map((p) => p.source_id),
      ).toEqual(['3443', '3484']);
    });

    it('variants: 232 (215 published + 17 drafts), 12 "any font" rows of 2826 dropped, 2635 inactive', () => {
      expect(s.variants).toEqual({
        in_source: 244,
        imported: 232,
        published_products: 215,
        draft_products: 17,
        dropped_any: 12,
        expanded_any: 0,
        inactive: 1,
        per_product: {
          'woo:namez.se:product:2229': 27,
          'woo:namez.se:product:2628': 11,
          'woo:namez.se:product:2676': 10,
          'woo:namez.se:product:2826': 48,
          'woo:namez.se:product:3443': 7,
          'woo:namez.se:product:3484': 10,
          'woo:namez.se:product:3563': 35,
          'woo:namez.se:product:3735': 42,
          'woo:namez.se:product:4106': 35,
          'woo:namez.se:product:4414': 7,
        },
      });
      const v2635 = product(2628).variations.find(
        (v) => v.source_id === '2635',
      )!;
      expect(v2635).toMatchObject({
        status: 'private',
        stock: { manage: true, qty: 0, status: 'outofstock' },
      });
    });

    it('price ladders (Discovery C §2.2)', () => {
      const ladder = (id: number, attr: string) => {
        const m = new Map<string, number>();
        for (const v of product(id).variations) {
          const value = v.attrs[attr];
          if (value) m.set(value, v.price.current ?? NaN);
        }
        return Object.fromEntries(m);
      };
      expect(ladder(2229, 'pa_storlek')).toEqual({
        'liten-13-16-cm': 350,
        'mellan-17-21-cm': 550,
        'stor-22-30-cm': 950,
      });
      expect(ladder(3563, 'pa_rakna')).toEqual({
        ett: 199,
        tva: 349,
        tre: 499,
        fyra: 629,
        fem: 749,
      });
      expect(ladder(3735, 'pa_valj-antal')).toEqual({
        '1-produkt': 99,
        '2-produkter': 189,
        '3-produkter': 269,
        '4-produkter': 349,
        '5-produkter': 429,
        '6-produkter': 499,
      });
      expect(ladder(4106, 'pa_namnskylt_stor_bokstav')).toEqual({
        '1-produkt': 275,
        '2-produkter': 499,
        '3-produkter': 699,
        '4-produkter': 899,
        '5-produkter': 999,
      });
      expect(ladder(2826, 'pa_antal-inskriptioner')).toEqual({
        '1': 390,
        '2': 440,
        '3': 480,
        '4': 510,
      });
      const simples = catalog.products.filter(
        (p) => p.type === 'simple' && p.designer?.enabled,
      );
      expect(simples).toHaveLength(25);
      expect(simples.filter((p) => p.price.current === 399)).toHaveLength(24);
      expect(product(4326).price).toEqual({
        regular: 100,
        sale: 25,
        current: 25,
      });
    });

    it('categories: 78 (12 roots, 64 depth-2, 2 depth-3), 54 with published products, 24 empty, in D24 order', () => {
      expect(s.categories).toMatchObject({
        total: 78,
        roots: 12,
        by_depth: { 0: 12, 1: 64, 2: 2 },
        with_published_products: 54,
        empty: 24,
        with_description: 74,
        with_seo: 46,
        with_thumbnail: 1,
      });
      expect(
        catalog.categories.filter((c) => c.depth === 0).map((c) => c.slug),
      ).toEqual([
        '3d_presenter',
        '3d-printing',
        'halsband',
        'namnskyltar',
        'nyckelringar',
        'personliga-presenter',
        'presenter-efter-alder',
        'presenter-till-vem',
        'skulpturer',
        'sma-presenter',
        'studentskyltar',
        'svensk-present',
      ]);
      // Parents always come before their children; every category is kept (U7).
      const pos = new Map(catalog.categories.map((c, i) => [c.ext_id, i]));
      for (const c of catalog.categories)
        if (c.parent_ext_id)
          expect(pos.get(c.parent_ext_id)!).toBeLessThan(pos.get(c.ext_id)!);
      expect(new Set(catalog.categories.map((c) => c.slug)).size).toBe(78);
      // The 24 empty ones: 18 "Presenter till N-åring" + their parent + Halsband (+child) + 3 more.
      const published = new Set(
        catalog.products
          .filter((p) => p.status === 'publish' && p.source_id !== '4326')
          .flatMap((p) => p.category_ext_ids),
      );
      const empty = catalog.categories
        .filter((c) => !published.has(c.ext_id))
        .map((c) => c.slug);
      expect(empty).toHaveLength(24);
      expect(
        empty.filter((x) => /^presenter-till-\d+-aring$/.test(x)),
      ).toHaveLength(18);
      expect(empty).toEqual(
        expect.arrayContaining([
          'halsband',
          'namnhalsband-med-egen-gravyr',
          'nyckelringar',
          'personliga-presenter',
          'presenter-efter-alder',
          'sma-presenter',
        ]),
      );
      expect(
        catalog.categories.every(
          (c) => c.order_key[0] === 0 && c.order_key[1] === 0,
        ),
      ).toBe(true);
      expect(catalog.store_settings.rank_math?.noindex_empty_taxonomies).toBe(
        true,
      );
    });

    it('links, tags, FAQs, images', () => {
      expect(s.product_category_links).toEqual({
        total: 239,
        published: 189,
        draft: 50,
      });
      expect(s.tags).toEqual({ terms: 11, links: 11 });
      expect(product(2676).tag_ext_ids).toHaveLength(9);
      expect(product(4256).tag_ext_ids).toHaveLength(2);
      expect(s.faqs).toEqual({ items: 9, products: 6 });
      expect(s.images).toEqual({
        rows: 80,
        published_rows: 60,
        draft_rows: 20,
        distinct: 72,
        published_distinct: 52,
        missing_in_bundle: 1,
      });
      expect(
        catalog.products
          .filter((p) => p.status === 'publish' && p.images.length === 0)
          .map((p) => p.source_id),
      ).toHaveLength(16); // 15 NPP + 4326
    });

    it('attributes: 17 pa_farg colours, PPOM with 4 options, option configs and valueMeta', () => {
      const farg = catalog.attributes.find((a) => a.taxonomy === 'pa_farg')!;
      expect(farg.terms).toHaveLength(17);
      expect(farg.terms.filter((t) => t.color)).toHaveLength(17);
      const ppom = product(4414).personalization.find(
        (m) => m.kind === 'checkbox_group',
      );
      expect(
        ppom && ppom.kind === 'checkbox_group' && ppom.options,
      ).toHaveLength(4);
      expect(s.option_configs).toEqual({
        total: 10,
        color_maps: 10,
        swatch_maps: 1,
        value_meta: {
          pa_storlek: 3,
          pa_rakna: 5,
          'pa_valj-antal': 6,
          pa_namnskylt_stor_bokstav: 5,
        },
      });
    });

    it('personalization: 14 presets on 10 products (§12.3 says 12 products), C2 of 4414 broken', () => {
      expect(s.personalization).toEqual({
        presets: 14,
        products: 10,
        by_key: {
          names_equal_length: 3,
          single_name: 6,
          name_color_per_item: 3,
          engravings: 1,
          checkbox_group: 1,
        },
        broken: 1,
        staged: true,
      });
    });

    it('NPP: 10 templates (9 linked; 4273 → 16 imported products; 4410 unlinked), 24 × 3 fallback fields', () => {
      const linked = Object.fromEntries(
        catalog.templates.map((t) => [
          t.source_id,
          t.linked_product_ext_ids.length,
        ]),
      );
      expect(linked).toEqual({
        '4273': 17,
        '4281': 1,
        '4308': 1,
        '4315': 1,
        '4350': 1,
        '4355': 1,
        '4359': 1,
        '4364': 1,
        '4368': 1,
        '4410': 0,
      });
      expect(catalog.templates.every((t) => t.size_mode === 'budget')).toBe(
        true,
      );
      expect(s.designer).toEqual({
        products_linked: 24,
        fallback_fields: 72,
        templates: 10,
        templates_linked: 9,
        template_assets: 20,
        template_thumbnails: 10,
      });
      expect(product(4275).designer?.pricing).toMatchObject({
        double_extra: 199,
        poster_price: 0,
      });
    });

    it('old slugs: 8 values on 7 products, 5 redirected; 194 redirects in total', () => {
      const withOld = catalog.products.filter((p) => p.old_slugs.length);
      expect(withOld.map((p) => p.source_id)).toEqual([
        '2229',
        '3443',
        '3484',
        '3563',
        '4106',
        '4275',
        '4414',
      ]);
      expect(withOld.reduce((n, p) => n + p.old_slugs.length, 0)).toBe(8);
      expect(s.old_slugs.total).toBe(8);
      // Redirects are the planner's (map-redirects over the final slugs).
      const r = catalogRedirects(catalog, NAMEZ_RUN_OPTIONS);
      const byRule: Record<string, number> = {};
      for (const c of r.candidates) byRule[c.rule] = (byRule[c.rule] ?? 0) + 1;
      expect(r.excludedOldSlugs.map((e) => [e.external_ref, e.reason])).toEqual(
        [
          ['woo:namez.se:product:2229', 'trashed'],
          ['woo:namez.se:product:3443', 'draft'],
          ['woo:namez.se:product:3484', 'draft'],
        ],
      );
      expect(byRule).toEqual({
        product: 33,
        old_slug: 5,
        skipped_product: 1,
        category_path: 78,
        category_leaf: 66,
        tag: 11,
      });
      expect(r.candidates).toHaveLength(194);
    });

    it('nothing is left unmapped; ignore list holds', () => {
      expect(s.unmapped_meta_prefixes).toEqual({});
      expect(s.warnings.W_ATTRIBUTE_UNUSED.count).toBe(5); // 4 unused attributes + pa_rakna/6-produkter
      expect(s.warnings.W_PRIMARY_CATEGORY_NOT_ASSIGNED.count).toBe(15);
      expect(s.warnings.W_MEDIA_MISSING_IN_BUNDLE.count).toBe(8); // 2569, 2838–2840, 2998–3001
    });
  },
);

if (!available) {
  // Keep a visible marker in the test output when the export is absent.
  it.skip(`Namez full export not found at ${NAMEZ_EXPORT_DIR}`, () =>
    undefined);
}
