import {
  compareSizes,
  facetKey,
  hasActiveFilter,
  normalizeFacetQuery,
  runFacets,
  toFacetRow,
  type FacetCollection,
  type RawFacetSource,
} from './product-list-facets';

function src(over: Partial<RawFacetSource> & { id: string }): RawFacetSource {
  return {
    kind: 'p',
    created_at: new Date('2026-10-01T00:00:00Z'),
    price: 100,
    category_id: 'cat-tops',
    links: [],
    track_inventory: false,
    stock_quantity: null,
    variants: [],
    variant_option_config: null,
    ...over,
  };
}

const v = (options: Record<string, string>, stock: number | null = null) => ({
  options,
  stock_quantity: stock,
  is_active: true,
});

describe('normalizeFacetQuery', () => {
  it('is not engaged without any parameter', () => {
    const q = normalizeFacetQuery({});
    expect(q.engaged).toBe(false);
    expect(q.facets).toBe(false);
    expect(hasActiveFilter(q.filters)).toBe(false);
  });

  it('reads comma lists and repeated keys, folded to keys', () => {
    const q = normalizeFacetQuery({
      color: ['Black, Navy  Blue', 'black'],
      size: 'M,,L',
    });
    expect(q.filters.color).toEqual(['black', 'navy blue']);
    expect(q.filters.size).toEqual(['m', 'l']);
    expect(q.engaged).toBe(true);
  });

  it('parses prices, swaps a reversed range and ignores junk', () => {
    expect(
      normalizeFacetQuery({ price_min: '300', price_max: '100' }).filters,
    ).toMatchObject({ price_min: 100, price_max: 300 });
    const junk = normalizeFacetQuery({ price_min: '-1', price_max: 'abc' });
    expect(junk.filters.price_min).toBeUndefined();
    expect(junk.filters.price_max).toBeUndefined();
    expect(junk.engaged).toBe(false);
  });

  it('takes facets=1 and in_stock=1 (only those values)', () => {
    expect(normalizeFacetQuery({ facets: '1' })).toMatchObject({
      facets: true,
      engaged: true,
    });
    expect(normalizeFacetQuery({ in_stock: 'yes' }).engaged).toBe(false);
    expect(normalizeFacetQuery({ in_stock: '1' }).filters.in_stock).toBe(true);
  });

  it('caps the number and length of values', () => {
    const many = Array.from({ length: 50 }, (_, i) => `c${i}`).join(',');
    expect(normalizeFacetQuery({ color: many }).filters.color).toHaveLength(30);
    expect(
      normalizeFacetQuery({ color: 'x'.repeat(81) }).filters.color,
    ).toEqual([]);
  });
});

describe('facetKey', () => {
  it('trims, lowers and folds commas and spaces', () => {
    expect(facetKey('  Navy,Blue ')).toBe('navy blue');
  });
});

describe('toFacetRow', () => {
  it('finds colour by style or name and size by name, any language', () => {
    const row = toFacetRow(
      src({
        id: 'a',
        variants: [
          v({ Färg: 'Svart', Storlek: 'M' }),
          v({ Färg: 'Vit', Storlek: 'L' }, 0),
        ],
      }),
    );
    expect([...row.colorLabels.values()]).toEqual(['Svart', 'Vit']);
    expect([...row.sizeLabels.keys()]).toEqual(['m', 'l']);
    expect(row.in_stock).toBe(true);
    expect(row.variants[1].ok).toBe(false);
  });

  it('reads seller swatches of the colour option', () => {
    const row = toFacetRow(
      src({
        id: 'a',
        variants: [v({ Tone: 'Sand' }), v({ Tone: 'Duo' })],
        variant_option_config: [
          {
            name: 'Tone',
            style: 'color',
            colorMap: { Sand: '#d8c6a5' },
            dualColorMap: { Duo: ['#000', '#fff'] },
          },
        ],
      }),
    );
    expect(row.swatches.get('sand')).toEqual(['#d8c6a5']);
    expect(row.swatches.get('duo')).toEqual(['#000', '#fff']);
  });

  it('follows the card stock rule', () => {
    expect(
      toFacetRow(src({ id: 'a', variants: [v({ size: 'S' }, 0)] })).in_stock,
    ).toBe(false);
    expect(
      toFacetRow(src({ id: 'a', variants: [v({ size: 'S' }, null)] })).in_stock,
    ).toBe(true);
    expect(
      toFacetRow(src({ id: 'a', track_inventory: true, stock_quantity: 0 }))
        .in_stock,
    ).toBe(false);
    expect(
      toFacetRow(src({ id: 'a', track_inventory: false, stock_quantity: 0 }))
        .in_stock,
    ).toBe(true);
  });
});

describe('runFacets', () => {
  const collections: FacetCollection[] = [
    {
      id: 'c-new',
      slug: 'New',
      parent_id: null,
      sort_order: 0,
      match_rule: 'MANUAL',
      match_tags: [],
      label: 'New in',
    },
    {
      id: 'c-sale',
      slug: 'sale',
      parent_id: null,
      sort_order: 1,
      match_rule: 'TAGS',
      match_tags: ['tag-sale'],
      label: 'Sale',
    },
    {
      id: 'c-empty',
      slug: 'empty',
      parent_id: null,
      sort_order: 2,
      match_rule: 'MANUAL',
      match_tags: [],
      label: 'Empty',
    },
  ];
  const categories = [
    { id: 'cat-tops', slug: 'tops', label: 'Tops' },
    { id: 'cat-bags', slug: 'bags', label: 'Bags' },
  ];
  const rows = [
    toFacetRow(
      src({
        id: 'hoodie',
        price: 74,
        links: ['c-new'],
        variants: [
          v({ Colour: 'Black', Size: 'S' }),
          v({ Colour: 'Black', Size: 'M' }, 0),
          v({ Colour: 'Sand', Size: 'M' }),
        ],
      }),
    ),
    toFacetRow(
      src({
        id: 'tee',
        price: 30,
        links: ['c-new', 'tag-sale'],
        variants: [
          v({ Colour: 'White', Size: 'M' }),
          v({ Colour: 'Black', Size: 'L' }),
        ],
      }),
    ),
    toFacetRow(
      src({
        id: 'tote',
        price: 25,
        category_id: 'cat-bags',
        links: ['tag-sale'],
        variants: [v({ Colour: 'Black' }, 0)],
      }),
    ),
    toFacetRow(
      src({
        id: 'ring',
        price: 43,
        category_id: 'cat-bags',
        track_inventory: true,
        stock_quantity: 0,
      }),
    ),
  ];
  const run = (filters: Parameters<typeof normalizeFacetQuery>[0]) =>
    runFacets(
      {
        rows,
        filters: normalizeFacetQuery(filters).filters,
        collections,
        categories,
      },
      true,
    );
  const ids = (r: { matched: { id: string }[] }) => r.matched.map((x) => x.id);

  it('without filters matches every row and counts every value', () => {
    const r = run({});
    expect(ids(r)).toEqual(['hoodie', 'tee', 'tote', 'ring']);
    expect(r.facets!.collection).toEqual([
      { value: 'new', label: 'New in', count: 2, parent: null },
      { value: 'sale', label: 'Sale', count: 2, parent: null },
    ]);
    expect(r.facets!.type.map((t) => [t.value, t.count])).toEqual([
      ['bags', 2],
      ['tops', 2],
    ]);
    expect(r.facets!.color.map((c) => [c.value, c.count])).toEqual([
      ['black', 3],
      ['sand', 1],
      ['white', 1],
    ]);
    expect(r.facets!.size.map((s) => s.label)).toEqual(['S', 'M', 'L']);
    expect(r.facets!.price).toEqual({ min: 25, max: 74 });
    expect(r.facets!.in_stock).toEqual({ count: 2 });
  });

  it('ORs values of one facet and ANDs facets; counts are disjunctive', () => {
    const r = run({ color: 'sand,white', collection: 'new' });
    expect(ids(r)).toEqual(['hoodie', 'tee']);
    // Colour counts ignore the colour filter but keep the collection.
    expect(r.facets!.color.find((c) => c.value === 'black')!.count).toBe(2);
    // Collection counts keep the colour filter: only `tee` is in sale.
    expect(r.facets!.collection.find((c) => c.value === 'sale')!.count).toBe(1);
  });

  it('matches colour, size and stock on one variant', () => {
    // The black hoodie in M is sold out; the sand one in M is not.
    expect(ids(run({ color: 'black', size: 'm', in_stock: '1' }))).toEqual([]);
    expect(ids(run({ color: 'black', size: 'm' }))).toEqual(['hoodie']);
    expect(ids(run({ color: 'sand', size: 'm', in_stock: '1' }))).toEqual([
      'hoodie',
    ]);
  });

  it('filters by price, collection (TAGS rule) and type', () => {
    expect(ids(run({ price_min: '30', price_max: '50' }))).toEqual([
      'tee',
      'ring',
    ]);
    expect(ids(run({ collection: 'SALE' }))).toEqual(['tee', 'tote']);
    expect(ids(run({ type: 'bags', in_stock: '1' }))).toEqual([]);
    const r = run({ price_max: '40' });
    // The price range ignores the price filter itself.
    expect(r.facets!.price).toEqual({ min: 25, max: 74 });
  });

  it('an unknown value matches nothing', () => {
    expect(ids(run({ collection: 'nope' }))).toEqual([]);
    expect(ids(run({ color: 'mauve' }))).toEqual([]);
  });

  it('skips the facets without withFacets', () => {
    const r = runFacets(
      {
        rows,
        filters: normalizeFacetQuery({}).filters,
        collections,
        categories,
      },
      false,
    );
    expect(r.facets).toBeUndefined();
  });

  it('offers no type facet for a single-category catalogue', () => {
    const r = runFacets(
      {
        rows: rows.filter((x) => x.category_id === 'cat-tops'),
        filters: normalizeFacetQuery({}).filters,
        collections,
        categories,
      },
      true,
    );
    expect(r.facets!.type).toEqual([]);
  });
});

describe('compareSizes', () => {
  it('orders letters, then numbers, then the rest', () => {
    const list = [
      'XL',
      '38',
      'one size',
      'M',
      'XS',
      '36',
      'Kids',
      'L',
      '2XL',
      'S',
    ];
    expect([...list].sort(compareSizes)).toEqual([
      'XS',
      'S',
      'M',
      'L',
      'XL',
      '2XL',
      'one size',
      '36',
      '38',
      'Kids',
    ]);
  });
});
