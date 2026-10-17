import { PlainTextHtmlSanitizer } from '../html/html-sanitizer';
import type {
  NormalizedCatalog,
  NProduct,
  NTemplate,
  NVariation,
} from '../model/normalized';
import { normalizeRunOptions } from '../runs/run-options';
import { mapProduct, type MapWarning } from './map-product';

/**
 * Pure mapper cases that the Namez fixtures do not contain: variation sale
 * windows (scheduled / expired) and the template thumbnail used as the
 * image of a designer product without images.
 */

const NOW = new Date('2026-10-16T00:00:00Z');
const HOST = 'shop.example';

function catalog(over: Partial<NormalizedCatalog> = {}): NormalizedCatalog {
  return {
    meta: {
      kind: 'WP_BUNDLE',
      format_version: 0,
      site_host: HOST,
      uploads_base: `https://${HOST}/wp-content/uploads`,
      currency: 'SEK',
      prices_include_tax: null,
      locale: null,
      bases: { product: 'produkt', category: 'product-category', tag: 'tag' },
      versions: {},
    },
    capabilities: {
      products: true,
      variations: true,
      categories: true,
      category_seo: false,
      category_order: false,
      swatches: false,
      variation_cards: false,
      personalization_flags: false,
      npp_templates: true,
      old_slugs: false,
      shipping: false,
      tax_settings: false,
      product_seo: false,
      original_images: false,
    },
    categories: [],
    tags: [],
    attributes: [],
    products: [],
    shipping: null,
    templates: [],
    store_settings: {},
    issues: [],
    ...over,
  };
}

function product(over: Partial<NProduct> = {}): NProduct {
  return {
    ext_id: `woo:${HOST}:product:1`,
    source_id: '1',
    type: 'simple',
    status: 'publish',
    slug: 'p',
    old_slugs: [],
    title: 'P',
    content_html: '',
    excerpt_html: '',
    sku: null,
    price: { regular: 100, sale: null, current: 100 },
    tax: { status: 'taxable', class: '' },
    stock: { manage: false, qty: null, status: 'instock' },
    weight: null,
    images: [],
    category_ext_ids: [],
    primary_category_ext_id: null,
    tag_ext_ids: [],
    shipping_class_slug: null,
    menu_order: 0,
    upsell_ext_ids: [],
    attributes: [],
    variations: [],
    seo: {},
    extras: { faq: [], videos: [] },
    personalization: [],
    designer: null,
    total_sales: 0,
    unmapped_meta_keys: [],
    ...over,
  };
}

function variation(
  id: number,
  size: string,
  price: NVariation['price'],
): NVariation {
  return {
    ext_id: `woo:${HOST}:variation:${id}`,
    source_id: String(id),
    status: 'publish',
    menu_order: 0,
    attrs: { size },
    price,
    sku: null,
    stock: { manage: false, qty: null, status: 'instock' },
  };
}

function map(p: NProduct, cat: NormalizedCatalog) {
  const warnings: MapWarning[] = [];
  const { options, errors } = normalizeRunOptions({
    platform_category_id: 'cat',
  });
  expect(errors).toEqual([]);
  const mapped = mapProduct(p, {
    catalog: { ...cat, products: [p] },
    options,
    sanitizer: new PlainTextHtmlSanitizer(),
    now: NOW,
    warn: (w) => warnings.push(w),
  });
  return { mapped, warnings };
}

describe('mapProduct — variation sale windows (D19)', () => {
  it('expired and scheduled variation sales fall back to the regular price', () => {
    const p = product({
      type: 'variable',
      attributes: [
        {
          key: 'size',
          label: 'Size',
          position: 0,
          visible: true,
          variation: true,
          values: ['s', 'm', 'l'],
          is_taxonomy: false,
        },
      ],
      variations: [
        // Expired: WooCommerce's `_price` still holds the sale price.
        variation(11, 's', {
          regular: 100,
          sale: 80,
          current: 80,
          sale_to: '2026-01-01T00:00:00.000Z',
        }),
        // Scheduled for later.
        variation(12, 'm', {
          regular: 100,
          sale: 70,
          current: 70,
          sale_from: '2027-01-01T00:00:00.000Z',
        }),
        // No window: `_price` is trusted.
        variation(13, 'l', { regular: 100, sale: 90, current: 90 }),
      ],
    });
    const { mapped, warnings } = map(p, catalog());
    expect(mapped.base_price).toBe('90.00');
    expect(mapped.compare_at_price).toBe('100.00');
    expect(
      mapped.variants.map((v) => [
        v.options.Size,
        v.price_adjustment,
        v.compare_at_price,
      ]),
    ).toEqual([
      ['s', '10.00', null],
      ['m', '10.00', null],
      ['l', '0.00', '100.00'],
    ]);
    const scheduled = warnings.filter(
      (w) => w.code === 'W_SALE_SCHEDULE_IGNORED',
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].message).toContain('variation:12');
  });

  it('an active window keeps the sale (same as no window)', () => {
    const p = product({
      type: 'variable',
      attributes: [
        {
          key: 'size',
          label: 'Size',
          position: 0,
          visible: true,
          variation: true,
          values: ['s'],
          is_taxonomy: false,
        },
      ],
      variations: [
        variation(11, 's', {
          regular: 100,
          sale: 80,
          current: 80,
          sale_from: '2026-01-01T00:00:00.000Z',
          sale_to: '2027-01-01T00:00:00.000Z',
        }),
      ],
    });
    const { mapped, warnings } = map(p, catalog());
    expect(mapped.base_price).toBe('80.00');
    expect(mapped.compare_at_price).toBe('100.00');
    expect(warnings.map((w) => w.code)).not.toContain(
      'W_SALE_SCHEDULE_IGNORED',
    );
  });
});

describe('mapProduct — template thumbnail as the product image', () => {
  const TPL = `woo:${HOST}:npp_template:7`;
  const THUMB = `https://${HOST}/wp-content/uploads/npp-thumbnails/poster.jpg`;
  const template: NTemplate = {
    ext_id: TPL,
    source_id: '7',
    title: 'Poster',
    size_mode: 'a4',
    elements: [],
    fonts: [],
    thumbnail: { url: THUMB, candidates: [THUMB] },
    assets: [],
    linked_product_ext_ids: [],
    raw_meta: {},
  };
  const cat = catalog({ templates: [template] });
  const designer = { enabled: true, template_ext_id: TPL };

  it('a designer product without images gets the thumbnail, with W_IMAGE_FROM_TEMPLATE', () => {
    const { mapped, warnings } = map(product({ designer }), cat);
    expect(mapped.images).toEqual([
      { source_url: THUMB, candidates: [THUMB], alt: null },
    ]);
    expect(warnings.map((w) => w.code)).toContain('W_IMAGE_FROM_TEMPLATE');
  });

  it('own images, a disabled link or a template without thumbnail: untouched', () => {
    const own = `https://${HOST}/wp-content/uploads/own.jpg`;
    const withImages = map(
      product({ designer, images: [{ url: own, candidates: [own] }] }),
      cat,
    );
    expect(withImages.mapped.images.map((i) => i.source_url)).toEqual([own]);
    expect(withImages.warnings.map((w) => w.code)).not.toContain(
      'W_IMAGE_FROM_TEMPLATE',
    );

    const disabled = map(
      product({ designer: { enabled: false, template_ext_id: TPL } }),
      cat,
    );
    expect(disabled.mapped.images).toEqual([]);

    const noThumb = map(
      product({ designer }),
      catalog({ templates: [{ ...template, thumbnail: null }] }),
    );
    expect(noThumb.mapped.images).toEqual([]);
    expect(noThumb.warnings.map((w) => w.code)).not.toContain(
      'W_IMAGE_FROM_TEMPLATE',
    );
  });
});
