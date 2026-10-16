import { DirectoryBundleReader } from '../adapters/bundle-reader';
import { WpBundleAdapter } from '../adapters/wp-bundle/wp-bundle.adapter';
import {
  NAMEZ_SOURCE,
  SLICE_DIR as SLICE,
} from '../adapters/wp-bundle/__fixtures__/fixtures';
import type { NormalizedCatalog, NProduct } from './normalized';
import { optionLabel, presetDescriptorsFor } from './presets';
import { resolveAnyVariations } from './variations';

const LABEL_OVERRIDES = { pa_namnskylt_stor_bokstav: 'Välj antal' };

describe('preset descriptors (M4-INTEGRATION X15) on the real slice', () => {
  let catalog: NormalizedCatalog;
  const product = (id: number): NProduct =>
    catalog.products.find((p) => p.source_id === String(id))!;

  beforeAll(async () => {
    catalog = await new WpBundleAdapter().load({
      bundle: new DirectoryBundleReader(SLICE),
      source: NAMEZ_SOURCE,
    });
  });

  it('A → names_equal_length', () => {
    expect(presetDescriptorsFor(product(2229), catalog)).toEqual({
      presets: [
        {
          key: 'names_equal_length',
          params: { name_max: 11, model_text: true },
          source_ref: 'woo:namez.se:product:2229#two_names',
          mechanism: 'two_names',
          detector: 'iwings.a',
        },
      ],
      skipped: [],
    });
  });

  it('C2 → name_color_per_item with count_map keyed by cleaned option values', () => {
    const { presets } = presetDescriptorsFor(product(4106), catalog, {
      label_overrides: LABEL_OVERRIDES,
    });
    expect(presets.map((p) => p.key)).toEqual([
      'single_name',
      'name_color_per_item',
    ]);
    expect(presets[1].params).toEqual({
      quantity_option: 'Välj antal',
      count_map: {
        '1 produkt': 1,
        '2 produkter': 2,
        '3 produkter': 3,
        '4 produkter': 4,
        '5 produkter': 5,
      },
      max: 5,
      palette_option: 'Färg',
      start_index: 2,
      lead: true,
    });
    // Without the override the technical label is only cleaned.
    expect(
      presetDescriptorsFor(product(4106), catalog).presets[1].params
        .quantity_option,
    ).toBe('Namnskylt_Stor_Bokstav');
  });

  it('D → engravings', () => {
    expect(presetDescriptorsFor(product(2826), catalog).presets).toEqual([
      {
        key: 'engravings',
        params: {
          count_option: 'Antal inskriptioner',
          count: 4,
          max_length: 15,
        },
        source_ref: 'woo:namez.se:product:2826#engraving_lines',
        mechanism: 'engraving_lines',
        detector: 'iwings.d',
      },
    ]);
  });

  it('PPOM → checkbox_group, broken C2 is skipped with its reason (4414)', () => {
    const r = presetDescriptorsFor(product(4414), catalog);
    expect(r.presets.map((p) => p.key)).toEqual([
      'single_name',
      'checkbox_group',
    ]);
    expect(r.presets[1].params).toEqual({
      name: 'ppom_details',
      label: 'Välj detaljer i designen',
      options: ['Student 2026', 'Studentmössa', 'Svensk flagga', 'Nallebjörn'],
      default_checked: [
        'Student 2026',
        'Studentmössa',
        'Svensk flagga',
        'Nallebjörn',
      ],
    });
    expect(r.skipped).toEqual([
      {
        source_ref: 'woo:namez.se:product:4414#iwings.c2',
        detector: 'iwings.c2',
        reason:
          'quantity attribute pa_namnskylt_stor_bokstav is not a variation attribute of the product',
      },
    ]);
  });

  it('products without flags give nothing', () => {
    expect(presetDescriptorsFor(product(4256), catalog)).toEqual({
      presets: [],
      skipped: [],
    });
    expect(
      optionLabel({ taxonomy: 'pa_x', label: ' Välj\u00a0antal\u200b ' }),
    ).toBe('Välj antal');
  });

  it('D21: drops the 12 covered "any font" variations of 2826', () => {
    const r = resolveAnyVariations(product(2826));
    expect(r.concrete).toHaveLength(48);
    expect(r.dropped.map((v) => v.source_id)).toEqual([
      '2985',
      '2986',
      '2987',
      '2988',
      '2989',
      '2990',
      '2991',
      '2992',
      '2993',
      '2994',
      '2995',
      '2996',
    ]);
    expect(r.expanded).toEqual([]);
  });
});

describe('resolveAnyVariations (synthetic)', () => {
  const base = {
    attributes: [
      {
        key: 'a',
        label: 'A',
        position: 0,
        visible: true,
        variation: true,
        values: ['x', 'y'],
        is_taxonomy: false,
      },
      {
        key: 'b',
        label: 'B',
        position: 1,
        visible: true,
        variation: true,
        values: ['1', '2'],
        is_taxonomy: false,
      },
    ],
  };
  const v = (id: string, attrs: Record<string, string | null>) => ({
    ext_id: `woo:s.se:variation:${id}`,
    source_id: id,
    status: 'publish',
    menu_order: 0,
    attrs,
    price: { regular: 1, sale: null, current: 1 },
    sku: null,
    stock: { manage: false, qty: null, status: 'instock' },
  });

  it('expands uncovered combinations with derived ext_ids', () => {
    const p = {
      ...base,
      variations: [
        v('1', { a: 'x', b: '1' }),
        v('2', { a: null, b: '1' }),
        v('3', { a: 'x', b: null }),
      ],
    } as unknown as NProduct;
    const r = resolveAnyVariations(p);
    expect(r.expanded.map((e) => [e.ext_id, e.attrs])).toEqual([
      ['woo:s.se:variation:2.1', { a: 'y', b: '1' }],
      ['woo:s.se:variation:3.1', { a: 'x', b: '2' }],
    ]);
  });

  it('refuses to expand beyond the limit', () => {
    const p = {
      ...base,
      variations: [v('9', { a: null, b: null })],
    } as unknown as NProduct;
    expect(resolveAnyVariations(p, 3).too_large).toHaveLength(1);
  });
});
