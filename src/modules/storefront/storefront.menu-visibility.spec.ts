import {
  dropMenuItemsWithDescendants,
  rewriteCollectionMenuItems,
  type CollectionPathInfo,
} from './storefront.service';

// M6.3: a storefront menu drops the items that link an INTERNAL collection,
// and everything nested under them, keeping the order of the rest.
type Item = {
  id: string;
  parent_id: string | null;
  kind: 'CUSTOM' | 'COLLECTION';
  resource_id: string | null;
  url: string | null;
};

const item = (
  id: string,
  parent: string | null,
  kind: Item['kind'] = 'CUSTOM',
  resource: string | null = null,
  url: string | null = null,
): Item => ({ id, parent_id: parent, kind, resource_id: resource, url });

describe('dropMenuItemsWithDescendants (M6.3)', () => {
  const internal = new Set(['lbl']);
  const drop = (it: Item) =>
    it.kind === 'COLLECTION' &&
    !!it.resource_id &&
    internal.has(it.resource_id);

  it('removes the INTERNAL collection item and its whole subtree', () => {
    const items = [
      item('home', null),
      item('occasions', null, 'COLLECTION', 'lbl'),
      item('dad', 'occasions', 'COLLECTION', 'pub'),
      item('dad-cards', 'dad'),
      item('shop', null, 'COLLECTION', 'pub'),
      item('news', 'shop'),
    ];
    expect(dropMenuItemsWithDescendants(items, drop).map((i) => i.id)).toEqual([
      'home',
      'shop',
      'news',
    ]);
  });

  it('returns the same array when nothing matches', () => {
    const items = [item('home', null), item('shop', null, 'COLLECTION', 'pub')];
    expect(dropMenuItemsWithDescendants(items, drop)).toBe(items);
  });
});

// M6.7: COLLECTION items are served with the collection's hierarchical url;
// an unreachable (INTERNAL, inactive, broken chain) or unknown collection
// drops the item with its descendants.
describe('rewriteCollectionMenuItems (M6.7)', () => {
  const paths = new Map<string, CollectionPathInfo>([
    ['shop', { path: ['shop'], reachable: true }],
    ['mugs', { path: ['shop', 'mugs'], reachable: true }],
    ['lbl', { path: ['lbl'], reachable: false }],
    ['hidden', { path: ['shop', 'hidden'], reachable: false }],
  ]);

  it('rewrites the url to /collections/<path…> ignoring the stored url', () => {
    const items = [
      item('home', null, 'CUSTOM', null, '/'),
      item('shop', null, 'COLLECTION', 'shop', '/collections/old-shop'),
      item('mugs', 'shop', 'COLLECTION', 'mugs', '/collections/mugs'),
    ];
    expect(rewriteCollectionMenuItems(items, paths)).toEqual([
      items[0],
      { ...items[1], url: '/collections/shop' },
      { ...items[2], url: '/collections/shop/mugs' },
    ]);
  });

  it('drops unreachable and unknown collections with their subtrees', () => {
    const items = [
      item('occasions', null, 'COLLECTION', 'lbl'),
      item('dad', 'occasions', 'COLLECTION', 'shop'),
      item('hidden', null, 'COLLECTION', 'hidden'),
      item('gone', null, 'COLLECTION', 'deleted-id'),
      item('gone-child', 'gone'),
      item('shop', null, 'COLLECTION', 'shop'),
      item('news', 'shop'),
    ];
    expect(rewriteCollectionMenuItems(items, paths).map((i) => i.id)).toEqual([
      'shop',
      'news',
    ]);
  });

  it('a COLLECTION item without resource_id is kept as stored', () => {
    const items = [item('x', null, 'COLLECTION', null, '/collections/x')];
    expect(rewriteCollectionMenuItems(items, paths)).toEqual(items);
  });
});
