import {
  buildCollectionPaths,
  type CollectionPathRow,
} from './storefront.service';

// M6.7: hierarchical collection URLs. `path` is slugs root -> self; a node
// is reachable only when it and every ancestor are active and PUBLIC and
// the parent chain is complete, acyclic and within the depth cap.

const row = (
  id: string,
  parent: string | null,
  opts: { active?: boolean; internal?: boolean } = {},
): CollectionPathRow => ({
  id,
  slug: id,
  parent_id: parent,
  is_active: opts.active ?? true,
  visibility: opts.internal ? 'INTERNAL' : 'PUBLIC',
});

describe('buildCollectionPaths (M6.7)', () => {
  it('root / child / grandchild paths, all reachable', () => {
    const out = buildCollectionPaths([
      row('root', null),
      row('child', 'root'),
      row('grandchild', 'child'),
    ]);
    expect(out.get('root')).toEqual({ path: ['root'], reachable: true });
    expect(out.get('child')).toEqual({
      path: ['root', 'child'],
      reachable: true,
    });
    expect(out.get('grandchild')).toEqual({
      path: ['root', 'child', 'grandchild'],
      reachable: true,
    });
  });

  it('an inactive node, and everything under it, is unreachable', () => {
    const out = buildCollectionPaths([
      row('root', null, { active: false }),
      row('child', 'root'),
    ]);
    expect(out.get('root')!.reachable).toBe(false);
    expect(out.get('child')).toEqual({
      path: ['root', 'child'],
      reachable: false,
    });
  });

  it('an INTERNAL node, and everything under it, is unreachable', () => {
    const out = buildCollectionPaths([
      row('label', null, { internal: true }),
      row('child', 'label'),
      row('shop', null),
    ]);
    expect(out.get('label')!.reachable).toBe(false);
    expect(out.get('child')!.reachable).toBe(false);
    expect(out.get('shop')).toEqual({ path: ['shop'], reachable: true });
  });

  it('a parent missing from the rows breaks the chain', () => {
    const out = buildCollectionPaths([row('orphan', 'gone')]);
    expect(out.get('orphan')).toEqual({ path: ['orphan'], reachable: false });
  });

  it('a cycle or a chain beyond the depth cap is unreachable and terminates', () => {
    const cyclic = buildCollectionPaths([row('a', 'b'), row('b', 'a')]);
    expect(cyclic.get('a')!.reachable).toBe(false);
    expect(cyclic.get('b')!.reachable).toBe(false);

    const deep = buildCollectionPaths([
      row('l0', null),
      row('l1', 'l0'),
      row('l2', 'l1'),
      row('l3', 'l2'),
    ]);
    expect(deep.get('l2')).toEqual({
      path: ['l0', 'l1', 'l2'],
      reachable: true,
    });
    expect(deep.get('l3')!.reachable).toBe(false);
  });
});
