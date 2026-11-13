import {
  CONTAINER_PAGE_TYPES,
  CONTAINER_SECTION_KEYS,
  containersAllowedOnPage,
  countLeafSections,
  depthUnder,
  dropHiddenSubtrees,
  isContainerSectionKey,
  layoutBlocksCopyError,
  layoutBlocksCreateError,
  layoutBlocksReorderError,
  orderSectionsAsTree,
  PRODUCT_LAYOUT_APP_KEY,
  PRODUCT_LAYOUT_BLOCK_KEYS,
  requiresProductLayoutApp,
  subtreeIds,
  validateSectionTree,
  validateTreeReorder,
} from './section-tree';

const PT = 'PRODUCT_TEMPLATE';

function node(
  id: string,
  section_key: string,
  parent_id: string | null = null,
) {
  return { id, section_key, parent_id };
}

describe('section-tree constants', () => {
  it('only the three layout containers may be parents', () => {
    expect([...CONTAINER_SECTION_KEYS].sort()).toEqual([
      'layout-column',
      'layout-grid',
      'layout-row',
    ]);
    expect(isContainerSectionKey('layout-row')).toBe(true);
    expect(isContainerSectionKey('layout-columns')).toBe(false);
    expect(isContainerSectionKey('product-page')).toBe(false);
    expect(isContainerSectionKey(undefined)).toBe(false);
  });

  it('containers are allowed on the product template only (for now)', () => {
    expect(CONTAINER_PAGE_TYPES).toEqual(['PRODUCT_TEMPLATE']);
    expect(containersAllowedOnPage(PT)).toBe(true);
    for (const t of ['HOME', 'STATIC', 'LANDING', 'HEADER', 'FOOTER'])
      expect(containersAllowedOnPage(t)).toBe(false);
    expect(containersAllowedOnPage(null)).toBe(false);
  });
});

describe('validateSectionTree', () => {
  it('accepts a flat page of any type', () => {
    const nodes = [node('a', 'hero-banner'), node('b', 'rich-text')];
    expect(validateSectionTree(nodes, 'HOME')).toBeNull();
    expect(validateSectionTree([], 'HOME')).toBeNull();
  });

  it('accepts row > column > block on the product template', () => {
    const nodes = [
      node('row', 'layout-row'),
      node('col1', 'layout-column', 'row'),
      node('col2', 'layout-column', 'row'),
      node('g', 'product-gallery', 'col1'),
      node('t', 'product-details', 'col2'),
      node('tabs', 'product-tabs'),
    ];
    expect(validateSectionTree(nodes, PT)).toBeNull();
  });

  it('rejects container keys on pages that do not allow containers', () => {
    const err = validateSectionTree([node('row', 'layout-row')], 'HOME');
    expect(err?.code).toBe('PAGE_SECTION_CONTAINER_NOT_ALLOWED');
  });

  it('rejects a non-container parent', () => {
    const err = validateSectionTree(
      [node('a', 'rich-text'), node('b', 'hero-banner', 'a')],
      PT,
    );
    expect(err).toMatchObject({
      code: 'PAGE_SECTION_PARENT_NOT_CONTAINER',
      section_id: 'b',
    });
  });

  it('rejects a parent that is not on the page (foreign id)', () => {
    const err = validateSectionTree([node('b', 'rich-text', 'elsewhere')], PT);
    expect(err?.code).toBe('PAGE_SECTION_PARENT_INVALID');
  });

  it('rejects self-parenting and cycles', () => {
    expect(validateSectionTree([node('a', 'layout-row', 'a')], PT)?.code).toBe(
      'PAGE_SECTION_TREE_CYCLE',
    );
    expect(
      validateSectionTree(
        [node('a', 'layout-row', 'b'), node('b', 'layout-column', 'a')],
        PT,
      )?.code,
    ).toBe('PAGE_SECTION_TREE_CYCLE');
  });

  it('allows a leaf at depth 3 but not depth 4', () => {
    const base = [
      node('r', 'layout-row'),
      node('c', 'layout-column', 'r'),
      node('leaf', 'rich-text', 'c'),
    ];
    expect(validateSectionTree(base, PT)).toBeNull();
    const deeper = [
      node('r', 'layout-row'),
      node('c', 'layout-column', 'r'),
      node('g', 'layout-grid', 'c'),
      node('leaf', 'rich-text', 'g'),
    ];
    expect(validateSectionTree(deeper, PT)?.code).toBe(
      'PAGE_SECTION_TREE_TOO_DEEP',
    );
  });

  it('rejects a container at depth 3 even when empty', () => {
    const nodes = [
      node('r', 'layout-row'),
      node('c', 'layout-column', 'r'),
      node('g', 'layout-grid', 'c'),
    ];
    expect(validateSectionTree(nodes, PT)).toMatchObject({
      code: 'PAGE_SECTION_TREE_TOO_DEEP',
      section_id: 'g',
    });
  });

  it('rejects duplicate ids', () => {
    expect(
      validateSectionTree([node('a', 'rich-text'), node('a', 'rich-text')], PT)
        ?.code,
    ).toBe('PAGE_SECTION_IDS_INVALID');
  });
});

describe('validateTreeReorder', () => {
  const existing = [
    { id: 'row', section_key: 'layout-row' },
    { id: 'a', section_key: 'rich-text' },
    { id: 'b', section_key: 'hero-banner' },
  ];

  it('accepts the full list with valid parents', () => {
    expect(
      validateTreeReorder(
        existing,
        [
          { id: 'row', parent_id: null, sort_order: 0 },
          { id: 'a', parent_id: 'row', sort_order: 0 },
          { id: 'b', sort_order: 1 },
        ],
        PT,
      ),
    ).toBeNull();
  });

  it('rejects foreign, missing and duplicate ids', () => {
    const foreign = validateTreeReorder(
      existing,
      [
        { id: 'row', sort_order: 0 },
        { id: 'a', sort_order: 1 },
        { id: 'zzz', sort_order: 2 },
      ],
      PT,
    );
    expect(foreign?.code).toBe('PAGE_SECTION_IDS_INVALID');
    const missing = validateTreeReorder(
      existing,
      [
        { id: 'row', sort_order: 0 },
        { id: 'a', sort_order: 1 },
      ],
      PT,
    );
    expect(missing?.code).toBe('PAGE_SECTION_IDS_INVALID');
    const dup = validateTreeReorder(
      existing,
      [
        { id: 'row', sort_order: 0 },
        { id: 'a', sort_order: 1 },
        { id: 'a', sort_order: 2 },
      ],
      PT,
    );
    expect(dup?.code).toBe('PAGE_SECTION_IDS_INVALID');
  });

  it('rejects a parent outside the page and non-container parents', () => {
    expect(
      validateTreeReorder(
        existing,
        [
          { id: 'row', sort_order: 0 },
          { id: 'a', parent_id: 'other-page-section', sort_order: 1 },
          { id: 'b', sort_order: 2 },
        ],
        PT,
      )?.code,
    ).toBe('PAGE_SECTION_PARENT_INVALID');
    expect(
      validateTreeReorder(
        existing,
        [
          { id: 'row', sort_order: 0 },
          { id: 'a', sort_order: 1 },
          { id: 'b', parent_id: 'a', sort_order: 0 },
        ],
        PT,
      )?.code,
    ).toBe('PAGE_SECTION_PARENT_NOT_CONTAINER');
  });

  it('rejects nesting on a page type without containers', () => {
    expect(
      validateTreeReorder(
        existing,
        [
          { id: 'row', sort_order: 0 },
          { id: 'a', parent_id: 'row', sort_order: 0 },
          { id: 'b', sort_order: 1 },
        ],
        'HOME',
      )?.code,
    ).toBe('PAGE_SECTION_CONTAINER_NOT_ALLOWED');
  });
});

describe('tree helpers', () => {
  const rows = [
    { id: 'tabs', parent_id: null, sort_order: 1, section_key: 'product-tabs' },
    { id: 'row', parent_id: null, sort_order: 0, section_key: 'layout-row' },
    { id: 'c2', parent_id: 'row', sort_order: 1, section_key: 'layout-column' },
    { id: 'c1', parent_id: 'row', sort_order: 0, section_key: 'layout-column' },
    { id: 'price', parent_id: 'c2', sort_order: 0, section_key: 'x' },
    { id: 'gal', parent_id: 'c1', sort_order: 0, section_key: 'x' },
  ];

  it('orders depth-first by sibling sort_order', () => {
    expect(orderSectionsAsTree(rows).map((r) => r.id)).toEqual([
      'row',
      'c1',
      'gal',
      'c2',
      'price',
      'tabs',
    ]);
  });

  it('equals a stable sort_order sort for a flat list', () => {
    const flat = [
      { id: 'a', sort_order: 2 },
      { id: 'b', sort_order: 0 },
      { id: 'c', sort_order: 0 },
    ];
    expect(orderSectionsAsTree(flat).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('drops orphans and cycles', () => {
    const bad = [
      { id: 'a', parent_id: null, sort_order: 0 },
      { id: 'o', parent_id: 'missing', sort_order: 0 },
      { id: 'x', parent_id: 'y', sort_order: 0 },
      { id: 'y', parent_id: 'x', sort_order: 0 },
    ];
    expect(orderSectionsAsTree(bad).map((r) => r.id)).toEqual(['a']);
  });

  it('dropHiddenSubtrees removes a hidden container and its descendants', () => {
    const withHidden = rows.map((r) =>
      r.id === 'c1' ? { ...r, is_hidden: true } : { ...r, is_hidden: false },
    );
    expect(
      dropHiddenSubtrees(withHidden)
        .map((r) => r.id)
        .sort(),
    ).toEqual(['c2', 'price', 'row', 'tabs']);
  });

  it('dropHiddenSubtrees drops children whose parent is missing', () => {
    expect(
      dropHiddenSubtrees([
        { id: 'a', parent_id: 'gone', is_hidden: false },
        { id: 'b', parent_id: null, is_hidden: false },
      ]).map((r) => r.id),
    ).toEqual(['b']);
  });

  it('subtreeIds lists the section and its descendants in pre-order', () => {
    expect(subtreeIds(rows, 'row')).toEqual([
      'row',
      'c1',
      'gal',
      'c2',
      'price',
    ]);
    expect(subtreeIds(rows, 'tabs')).toEqual(['tabs']);
    expect(subtreeIds(rows, 'nope')).toEqual([]);
  });

  it('depthUnder gives the depth of a new child', () => {
    expect(depthUnder(rows, null)).toBe(1);
    expect(depthUnder(rows, 'row')).toBe(2);
    expect(depthUnder(rows, 'c1')).toBe(3);
    expect(depthUnder(rows, 'missing')).toBeNull();
  });

  it('countLeafSections skips containers', () => {
    expect(countLeafSections(rows)).toBe(3);
    expect(countLeafSections([{ section_key: 'layout-row' }])).toBe(0);
    expect(countLeafSections([null, 'x'])).toBe(2);
  });
});

describe('product layout app gate', () => {
  it('names the store app and the gated keys', () => {
    expect(PRODUCT_LAYOUT_APP_KEY).toBe('product_layout');
    expect(PRODUCT_LAYOUT_BLOCK_KEYS).toHaveLength(15);
    for (const k of [...CONTAINER_SECTION_KEYS, ...PRODUCT_LAYOUT_BLOCK_KEYS])
      expect(requiresProductLayoutApp(k)).toBe(true);
    for (const k of [
      'product-page',
      'product-gallery',
      'product-details',
      'add-to-cart',
      'product-tabs',
      'rich-text',
      '',
      null,
      undefined,
    ])
      expect(requiresProductLayoutApp(k)).toBe(false);
  });

  it('create: blocks gated keys and parents only while off', () => {
    expect(
      layoutBlocksCreateError({ section_key: 'product-buy' }, false)?.code,
    ).toBe('PAGE_SECTION_LAYOUT_BLOCKS_DISABLED');
    expect(
      layoutBlocksCreateError(
        { section_key: 'rich-text', parent_id: 'c1' },
        false,
      )?.code,
    ).toBe('PAGE_SECTION_LAYOUT_BLOCKS_DISABLED');
    expect(
      layoutBlocksCreateError({ section_key: 'product-page' }, false),
    ).toBeNull();
    expect(
      layoutBlocksCreateError(
        { section_key: 'layout-row', parent_id: 'x' },
        true,
      ),
    ).toBeNull();
  });

  it('copy: blocks a subtree holding gated keys only while off', () => {
    const tree = [node('r', 'layout-row'), node('g', 'product-gallery', 'r')];
    expect(layoutBlocksCopyError(tree, false)).toMatchObject({
      code: 'PAGE_SECTION_LAYOUT_BLOCKS_DISABLED',
      section_id: 'r',
    });
    expect(layoutBlocksCopyError(tree, true)).toBeNull();
    expect(
      layoutBlocksCopyError([node('t', 'product-tabs')], false),
    ).toBeNull();
  });

  it('reorder: keeps saved parents, allows moving out, rejects new parents', () => {
    const existing = [
      node('r', 'layout-row'),
      node('c', 'layout-column', 'r'),
      node('g', 'product-gallery', 'c'),
      node('t', 'product-tabs'),
    ];
    const same = [
      { id: 'r', parent_id: null, sort_order: 1 },
      { id: 'c', parent_id: 'r', sort_order: 0 },
      { id: 'g', parent_id: 'c', sort_order: 0 },
      { id: 't', parent_id: null, sort_order: 0 },
    ];
    expect(layoutBlocksReorderError(existing, same, false)).toBeNull();
    const out = same.map((i) => (i.id === 'g' ? { ...i, parent_id: null } : i));
    expect(layoutBlocksReorderError(existing, out, false)).toBeNull();
    const into = same.map((i) => (i.id === 't' ? { ...i, parent_id: 'c' } : i));
    expect(layoutBlocksReorderError(existing, into, false)).toMatchObject({
      code: 'PAGE_SECTION_LAYOUT_BLOCKS_DISABLED',
      section_id: 't',
    });
    // Re-parenting between saved containers is a new parent too.
    const across = same.map((i) =>
      i.id === 'g' ? { ...i, parent_id: 'r' } : i,
    );
    expect(layoutBlocksReorderError(existing, across, false)?.code).toBe(
      'PAGE_SECTION_LAYOUT_BLOCKS_DISABLED',
    );
    expect(layoutBlocksReorderError(existing, into, true)).toBeNull();
  });
});
