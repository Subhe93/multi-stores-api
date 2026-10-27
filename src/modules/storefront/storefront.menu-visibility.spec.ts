import { dropMenuItemsWithDescendants } from './storefront.service';

// M6.3: a storefront menu drops the items that link an INTERNAL collection,
// and everything nested under them, keeping the order of the rest.
type Item = {
  id: string;
  parent_id: string | null;
  kind: 'CUSTOM' | 'COLLECTION';
  resource_id: string | null;
};

const item = (
  id: string,
  parent: string | null,
  kind: Item['kind'] = 'CUSTOM',
  resource: string | null = null,
): Item => ({ id, parent_id: parent, kind, resource_id: resource });

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
