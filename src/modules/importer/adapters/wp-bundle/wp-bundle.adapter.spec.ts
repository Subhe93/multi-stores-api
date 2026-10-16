import { DirectoryBundleReader, MemoryBundleReader } from '../bundle-reader';
import { ImportAdapterError } from '../source-adapter';
import {
  NAMEZ_SOURCE,
  SLICE_DIR as SLICE,
  v1Sample,
} from './__fixtures__/fixtures';
import { WpBundleAdapter } from './wp-bundle.adapter';
import { loadWpTables } from './wp-tables';
import type { NormalizedCatalog, NProduct } from '../../model/normalized';
import { quantityFromTerm } from './detectors/iwings';

describe('WpBundleAdapter — real Namez slice (legacy bundle, format 0)', () => {
  let catalog: NormalizedCatalog;
  const product = (id: number): NProduct =>
    catalog.products.find((p) => p.source_id === String(id))!;

  beforeAll(async () => {
    const logs: string[] = [];
    catalog = await new WpBundleAdapter().load({
      bundle: new DirectoryBundleReader(SLICE),
      source: NAMEZ_SOURCE,
      log: (code) => logs.push(code),
    });
    expect(logs).toContain('W_SHIPPING_NOT_IN_BUNDLE');
  });

  it('fills meta from the source settings and versions.txt', () => {
    expect(catalog.meta).toEqual({
      kind: 'WP_BUNDLE',
      format_version: 0,
      site_host: 'namez.se',
      uploads_base: 'https://namez.se/wp-content/uploads/',
      currency: 'SEK',
      prices_include_tax: null,
      locale: 'sv',
      bases: {
        product: 'produkt',
        category: 'product-category',
        tag: 'product-tag',
      },
      versions: { wp: '7.1.3', wc: '11.2.1' },
    });
    expect(catalog.capabilities).toMatchObject({
      shipping: false,
      tax_settings: false,
      original_images: false,
      npp_templates: true,
    });
  });

  it('reads the products of the slice in id order with statuses and types', () => {
    expect(
      catalog.products.map((p) => [p.source_id, p.status, p.type]),
    ).toEqual([
      ['2229', 'publish', 'variable'],
      ['2826', 'publish', 'variable'],
      ['3484', 'draft', 'variable'],
      ['4106', 'publish', 'variable'],
      ['4256', 'publish', 'simple'],
      ['4275', 'publish', 'simple'],
      ['4326', 'publish', 'simple'],
      ['4414', 'publish', 'variable'],
    ]);
    expect(product(2229).ext_id).toBe('woo:namez.se:product:2229');
  });

  it('2229: prices, sku, old slugs and the featured image missing from the legacy bundle', () => {
    const p = product(2229);
    expect(p.slug).toBe('personlig-3d-namnpresent');
    expect(p.sku).toBe('3d-name');
    expect(p.price).toEqual({ regular: null, sale: null, current: 350 });
    expect(p.old_slugs).toEqual([
      'personlig-3d-namnpresent-gor-dina-ord-till-en-present__trashed',
      'personlig-3d-namnpresent-gor-dina-ord-till-en-present',
    ]);
    expect(p.images[0]).toEqual({
      ext_id: 'woo:namez.se:attachment:2569',
      url: '',
      candidates: [],
      missing: true,
    });
    expect(p.images).toHaveLength(8);
    expect(p.images[1].url).toBe(
      'https://namez.se/wp-content/uploads/2024/09/right-left-3dnamez.jpg',
    );
    expect(catalog.issues).toContainEqual(
      expect.objectContaining({
        code: 'W_MEDIA_MISSING_IN_BUNDLE',
        external_ref: p.ext_id,
      }),
    );
    expect(p.variations).toHaveLength(27);
    const prices = [...new Set(p.variations.map((v) => v.price.current))].sort(
      (a, b) => a! - b!,
    );
    expect(prices).toEqual([350, 550, 950]);
    expect(
      p.attributes.map((a) => [a.key, a.variation, a.values.length]),
    ).toEqual([
      ['pa_storlek', true, 3],
      ['pa_farg', true, 9],
    ]);
    expect(p.extras.faq.map((f) => [f.field, f.label])).toEqual([
      ['product_size_fit', 'Size & Fit'],
      ['product_delivery', 'Delivery'],
    ]);
    expect(p.personalization).toEqual([
      {
        kind: 'two_names',
        detector: 'iwings.a',
        placeholders: [null, null, null],
      },
    ]);
    expect(p.unmapped_meta_keys).toEqual([]);
  });

  it('rewrites the alias host 3dnamez.se and prepares -scaled candidates', () => {
    const all = catalog.products
      .flatMap((p) => p.images)
      .filter((i) => !i.missing);
    expect(all.length).toBeGreaterThan(0);
    expect(
      all.every((i) =>
        i.url.startsWith('https://namez.se/wp-content/uploads/'),
      ),
    ).toBe(true);
    const tpl = catalog.templates.find((t) => t.source_id === '4273')!;
    expect(tpl.assets[0].candidates).toEqual([
      'https://namez.se/wp-content/uploads/2026/04/Stilren-studentskylt-med-foto.jpg',
      'https://namez.se/wp-content/uploads/2026/04/Stilren-studentskylt-med-foto-scaled.jpg',
    ]);
  });

  it('2826: 60 variations incl. 12 "any font" rows, engraving lines, image swatches', () => {
    const p = product(2826);
    expect(p.variations).toHaveLength(60);
    const any = p.variations.filter(
      (v) => v.attrs['pa_gravyr-teckensnitt'] === null,
    );
    expect(any.map((v) => Number(v.source_id))).toEqual([
      2985, 2986, 2987, 2988, 2989, 2990, 2991, 2992, 2993, 2994, 2995, 2996,
    ]);
    expect(p.personalization).toEqual([
      {
        kind: 'engraving_lines',
        detector: 'iwings.d',
        count_attribute: 'pa_antal-inskriptioner',
        max: 4,
        max_length: 15,
      },
    ]);
    const gravyr = catalog.attributes.find(
      (a) => a.taxonomy === 'pa_gravyr-teckensnitt',
    )!;
    expect(gravyr.swatch_type).toBe('image');
    expect(
      gravyr.terms.map((t) => [t.slug, t.image?.ext_id, t.image?.missing]),
    ).toEqual([
      ['aa-typewriter', 'woo:namez.se:attachment:3000', true],
      ['aa-handwriting', 'woo:namez.se:attachment:2998', true],
      ['aa-old-london', 'woo:namez.se:attachment:2999', true],
      ['aa-standard', 'woo:namez.se:attachment:3001', true],
    ]);
  });

  it('pa_farg carries the WVS hex colours (17 terms)', () => {
    const farg = catalog.attributes.find((a) => a.taxonomy === 'pa_farg')!;
    expect(farg.swatch_type).toBe('color');
    expect(farg.terms).toHaveLength(17);
    expect(farg.terms.every((t) => /^#[0-9a-f]{6}$/.test(t.color ?? ''))).toBe(
      true,
    );
    expect(farg.terms.find((t) => t.slug === 'olivgron')).toMatchObject({
      name: 'olivgrön',
      color: '#697537',
    });
    expect(farg.terms.find((t) => t.slug === 'blank-silver')!.name).toBe(
      'Blank\u00a0Silver',
    );
  });

  it('ACF term cards on pa_storlek and pa_namnskylt_stor_bokstav (order 0 → term_id order)', () => {
    const storlek = catalog.attributes.find(
      (a) => a.taxonomy === 'pa_storlek',
    )!;
    expect(storlek.terms.map((t) => [t.slug, t.order])).toEqual([
      ['liten-13-16-cm', 1],
      ['mellan-17-21-cm', 2],
      ['stor-22-30-cm', 3],
    ]);
    expect(storlek.terms[1].card).toEqual({
      label: 'Mellan ',
      size: '(17–21 cm)',
      badge: 'Mest populär',
      badge_color: '#f56cff',
      price_text: '550 kr',
      shipment_text: 'Fri frakt',
    });
    const nsb = catalog.attributes.find(
      (a) => a.taxonomy === 'pa_namnskylt_stor_bokstav',
    )!;
    expect(nsb.label).toBe('Namnskylt_Stor_Bokstav');
    expect(nsb.terms.map((t) => t.slug)).toEqual([
      '1-produkt',
      '2-produkter',
      '3-produkter',
      '4-produkter',
      '5-produkter',
    ]);
    expect(nsb.terms[0].name).toBe('1 produkt:');
    expect(nsb.terms[2].card).toMatchObject({
      badge: 'Mest Populärt ⭐',
      badge_color: '#FFD84D',
    });
  });

  it('4106: C2 on pa_namnskylt_stor_bokstav with counts 1..5', () => {
    expect(product(4106).personalization).toEqual([
      { kind: 'single_name', detector: 'iwings.b' },
      {
        kind: 'name_color_per_item',
        detector: 'iwings.c2',
        quantity_attribute: 'pa_namnskylt_stor_bokstav',
        counts: {
          '1-produkt': 1,
          '2-produkter': 2,
          '3-produkter': 3,
          '4-produkter': 4,
          '5-produkter': 5,
        },
        max: 5,
        palette_attribute: 'pa_farg',
      },
    ]);
  });

  it('4414: broken C2, PPOM checkbox group, non-variation attribute, sale on variations', () => {
    const p = product(4414);
    expect(p.personalization).toEqual([
      { kind: 'single_name', detector: 'iwings.b' },
      {
        kind: 'broken',
        detector: 'iwings.c2',
        reason:
          'quantity attribute pa_namnskylt_stor_bokstav is not a variation attribute of the product',
      },
      {
        kind: 'checkbox_group',
        detector: 'ppom',
        label: 'Välj detaljer i designen',
        options: [
          { label: 'Student 2026', checked: true },
          { label: 'Studentmössa', checked: true },
          { label: 'Svensk flagga', checked: true },
          { label: 'Nallebjörn', checked: true },
        ],
      },
    ]);
    expect(
      p.attributes.find((a) => a.key === 'pa_valj-detaljer-i-designen'),
    ).toMatchObject({
      variation: false,
      values: ['student-2026', 'studentmossa', 'svensk-flagga', 'nallebjorn'],
    });
    expect(
      p.variations.every(
        (v) =>
          v.price.regular === 490 &&
          v.price.sale === 275 &&
          v.price.current === 275,
      ),
    ).toBe(true);
    expect(p.price.current).toBe(275);
    expect(p.designer).toEqual({
      enabled: false,
      template_ext_id: null,
      addons: { double: true, raincover: true, poster: true, welcome: false },
      pricing: {
        double_extra: 149,
        rain_extra: 29,
        poster_price: 179,
        welcome_price: 249,
        welcome_regular: 349,
      },
    });
    expect(p.extras.videos).toEqual([
      'https://namez.se/wp-content/uploads/2026/05/Student-present-namez.mp4',
    ]);
  });

  it('4275 / 4326: NPP designer hand-off and templates', () => {
    expect(product(4275).designer).toEqual({
      enabled: true,
      template_ext_id: 'woo:namez.se:npp_template:4315',
      addons: {
        double: false,
        raincover: false,
        poster: false,
        welcome: false,
      },
      pricing: {
        double_extra: 199,
        rain_extra: 29,
        poster_price: 0,
        welcome_price: 249,
        welcome_regular: 349,
      },
    });
    expect(product(4275).price).toEqual({
      regular: 600,
      sale: 399,
      current: 399,
    });
    expect(product(4275).seo).toEqual({
      description:
        'Beställ en stilren studentskylt med foto, namn och klass. En personlig och enkel design som passar perfekt till studentdagen.',
      focus_keyword: 'stilren studentskylt',
      robots: ['index'],
    });
    expect(product(4275).shipping_class_slug).toBe('npp-poster');
    expect(product(4326).price).toEqual({
      regular: 100,
      sale: 25,
      current: 25,
    });
    expect(product(4326).primary_category_ext_id).toBe(
      'woo:namez.se:product_cat:176',
    );
    expect(product(4326).category_ext_ids).toEqual([
      'woo:namez.se:product_cat:15',
    ]);

    expect(
      catalog.templates.map((t) => [
        t.source_id,
        t.size_mode,
        t.linked_product_ext_ids,
      ]),
    ).toEqual([
      ['4273', 'budget', ['woo:namez.se:product:4326']],
      ['4315', 'budget', ['woo:namez.se:product:4275']],
    ]);
    const t = catalog.templates[1];
    expect(t.title).toBe('Stilren studentskylt med foto');
    expect((t.elements as { type: string }[]).map((e) => e.type)).toEqual([
      'background',
      'text',
      'text',
      'image-slot',
    ]);
    expect(t.assets.map((a) => a.url)).toEqual([
      'https://namez.se/wp-content/uploads/2026/04/Student-2026-1-scaled.jpg',
      'https://namez.se/wp-content/uploads/2026/04/Student-2026-4.png',
    ]);
    expect(t.thumbnail?.url).toMatch(
      /^https:\/\/namez\.se\/wp-content\/uploads\/npp-thumbnails\/poster-.*\.jpg$/,
    );
    expect(Object.keys(t.raw_meta).sort()).toEqual([
      '_npp_elements',
      '_npp_fonts',
      '_npp_size_mode',
      '_npp_thumbnail_url',
    ]);
  });

  it('4256: simple product with tags, FAQ and an ACF video', () => {
    const p = product(4256);
    expect(p.price).toEqual({ regular: 275, sale: null, current: 275 });
    expect(p.personalization).toEqual([]);
    expect(p.designer).toBeNull();
    expect(p.tag_ext_ids).toHaveLength(2);
    expect(p.extras.faq.map((f) => f.label)).toEqual(['Care Instructions']);
    expect(p.extras.videos).toEqual([
      'https://namez.se/wp-content/uploads/2026/03/present-till-utlandet-till-amerikaner.mp4',
    ]);
    const tags = catalog.tags.filter((t) => p.tag_ext_ids.includes(t.ext_id));
    expect(tags).toHaveLength(2);
  });

  it('3484 (draft): old slug is kept for the redirect rules to judge', () => {
    expect(product(3484).old_slugs).toEqual(['3d-bokstav-med-namn']);
    expect(product(3484).variations[0].price).toEqual({
      regular: 299,
      sale: 199,
      current: 199,
    });
  });

  it('categories: parents first, D24 sibling order, paths, SEO and the thumbnail', () => {
    const slugs = catalog.categories.map((c) => c.slug);
    for (const c of catalog.categories) {
      if (c.parent_ext_id) {
        expect(
          slugs.indexOf(
            catalog.categories.find((x) => x.ext_id === c.parent_ext_id)!.slug,
          ),
        ).toBeLessThan(slugs.indexOf(c.slug));
      }
    }
    const kille = catalog.categories.find(
      (c) => c.slug === 'studentpresent-till-kille',
    )!;
    expect(kille.path).toEqual([
      'presenter-till-vem',
      'studentpresent',
      'studentpresent-till-kille',
    ]);
    expect(kille.depth).toBe(2);
    const sk = catalog.categories.find((c) => c.slug === 'studentskyltar')!;
    expect(sk.thumbnail?.url).toBe(
      'https://namez.se/wp-content/uploads/2026/04/Studentskylt-pris.jpg',
    );
    const halsband = catalog.categories.find((c) => c.slug === 'halsband')!;
    expect(halsband.count).toBe(0);
    const roots = catalog.categories.filter((c) => c.depth === 0);
    expect(roots.map((r) => r.sibling_rank)).toEqual(roots.map((_, i) => i));
    const pappa = catalog.categories.find(
      (c) => c.slug === 'present-till-pappa',
    )!;
    expect(pappa.seo.title).toContain('&amp;');
  });

  it('reports no unmapped meta for the slice and keeps the known-ignore list quiet', () => {
    expect(catalog.products.flatMap((p) => p.unmapped_meta_keys)).toEqual([]);
  });
});

describe('quantityFromTerm', () => {
  it.each([
    ['ett', undefined, 1],
    ['tva', undefined, 2],
    ['fem', undefined, 5],
    ['6-produkter', undefined, 6],
    ['1-produkt', '1 produkt:', 1],
    ['x', 'Tre produkter', 3],
    ['abc', 'Abc', null],
  ])('%s → %s', (slug, name, n) => {
    expect(quantityFromTerm(slug, name)).toBe(n);
  });
});

describe('WpBundleAdapter — bundle v1 sample', () => {
  let catalog: NormalizedCatalog;
  beforeAll(async () => {
    catalog = await new WpBundleAdapter().load({
      bundle: v1Sample(),
      source: {
        kind: 'WP_BUNDLE',
        site_host: 'shop.example',
        host_aliases: ['old.example'],
        settings: {},
      },
    });
  });

  it('reads the manifest, options and permalink bases', () => {
    expect(catalog.meta).toMatchObject({
      format_version: 1,
      currency: 'SEK',
      prices_include_tax: true,
      locale: 'sv_SE',
      bases: { product: 'produkt', category: 'kategori', tag: 'product-tag' },
      versions: { wp: '7.1.3', wc: '11.2.1' },
      exported_at: '2026-10-20T10:00:00Z',
    });
    expect(catalog.capabilities).toMatchObject({
      shipping: true,
      tax_settings: true,
      original_images: true,
    });
  });

  it('skips trashed products and reports it', () => {
    expect(catalog.products.map((p) => p.source_id)).toEqual(['10', '20']);
    expect(catalog.issues).toContainEqual(
      expect.objectContaining({ code: 'W_PRODUCT_STATUS_UNSUPPORTED' }),
    );
  });

  it('prefers original_image, then the de-scaled path, then the URL (D9)', () => {
    const img = catalog.products[0].images[0];
    expect(img).toMatchObject({
      ext_id: 'woo:shop.example:attachment:500',
      alt: 'En mugg',
      mime: 'image/jpeg',
    });
    expect(img.url).toBe(
      'https://shop.example/wp-content/uploads/2026/04/mugg-scaled.jpg',
    );
    expect(img.candidates).toEqual([
      'https://shop.example/wp-content/uploads/2026/04/mugg.jpg',
      'https://shop.example/wp-content/uploads/2026/04/mugg-scaled.jpg',
    ]);
  });

  it('maps simple-product fields, decimal commas and scheduled sales', () => {
    const p = catalog.products[0];
    expect(p.price).toEqual({
      regular: 149,
      sale: 99,
      current: 99,
      sale_from: '2100-01-01T00:00:00.000Z',
    });
    expect(p.weight).toBe(0.5);
    expect(p.content_html).toBe('<p data-start="1">Hej\nrad två</p>');
    expect(p.shipping_class_slug).toBe('stor');
    expect(p.unmapped_meta_keys).toEqual(['_crosssell_ids']);
  });

  it('handles local attributes and "any" variations', () => {
    const p = catalog.products[1];
    expect(p.attributes).toEqual([
      {
        key: 'farg-',
        label: 'Färg',
        position: 0,
        visible: true,
        variation: true,
        values: ['Röd', 'Blå'],
        is_taxonomy: false,
      },
    ]);
    expect(p.variations.map((v) => [v.source_id, v.attrs, v.sku])).toEqual([
      ['21', { 'farg-': 'Röd' }, 'SK-1'],
      ['22', { 'farg-': null }, null],
    ]);
  });

  it('reads shipping zones, locations, methods and their settings', () => {
    expect(catalog.shipping).toEqual({
      classes: [
        {
          ext_id: 'woo:shop.example:shipping_class:60',
          slug: 'stor',
          name: 'Frakt Stor',
        },
      ],
      zones_available: true,
      zones: [
        {
          ext_id: 'woo:shop.example:shipping_zone:1',
          name: 'Sverige',
          order: 0,
          locations: [
            { type: 'country', code: 'SE' },
            { type: 'postcode', code: '784*' },
          ],
          methods: [
            {
              instance_id: '3',
              method_id: 'flat_rate',
              enabled: true,
              order: 1,
              settings: { title: 'Standard', cost: '49' },
            },
            {
              instance_id: '4',
              method_id: 'local_pickup',
              enabled: false,
              order: 2,
              settings: {},
            },
          ],
        },
        {
          ext_id: 'woo:shop.example:shipping_zone:0',
          name: 'Locations not covered by your other zones',
          order: Number.MAX_SAFE_INTEGER,
          locations: [],
          methods: [
            {
              instance_id: '5',
              method_id: 'free_shipping',
              enabled: true,
              order: 1,
              settings: {},
            },
          ],
        },
      ],
    });
  });

  it('never keeps non-allowlisted options or PII sub-keys', async () => {
    const tables = await loadWpTables(v1Sample());
    expect(tables.options.has('woocommerce_stripe_settings')).toBe(false);
    expect(
      JSON.parse(tables.options.get('rank-math-options-general') as string),
    ).toEqual({ wc_remove_product_base: 'off' });
    expect(tables.files).not.toContain('evil.sh');
  });

  it('fails clearly when a required file is missing', async () => {
    await expect(
      new WpBundleAdapter().load({
        bundle: new MemoryBundleReader({ 'posts.tsv': '' }),
        source: NAMEZ_SOURCE,
      }),
    ).rejects.toMatchObject({ code: 'IMPORT_BUNDLE_MISSING_FILE' });
    await expect(
      new WpBundleAdapter().load({ source: NAMEZ_SOURCE }),
    ).rejects.toBeInstanceOf(ImportAdapterError);
  });
});
