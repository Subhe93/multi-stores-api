import { StorefrontService } from './storefront.service';
import type { PrismaService } from '../../prisma/prisma.service';

// M6: the collection fields of a storefront product payload. The primary
// comes first in `creator_categories`, `primary_collection_path` is
// root -> leaf and an inactive / unknown primary yields null + []. M6.7:
// every node carries `path` (slugs root -> self) and a collection under an
// inactive, INTERNAL, foreign or missing ancestor is not served at all; the
// creator's collections are read in one query.

type Node = {
  id: string;
  slug: string;
  parent_id: string | null;
  is_active: boolean;
  visibility: 'PUBLIC' | 'INTERNAL';
  creator_id: string;
  translations: { locale: string; name: string }[];
};

function node(
  id: string,
  parent: string | null,
  opts: { active?: boolean; creator?: string; internal?: boolean } = {},
): Node {
  return {
    id,
    slug: id,
    parent_id: parent,
    is_active: opts.active ?? true,
    visibility: opts.internal ? 'INTERNAL' : 'PUBLIC',
    creator_id: opts.creator ?? 'c1',
    translations: [{ locale: 'en', name: id.toUpperCase() }],
  };
}

function build(tree: Node[]) {
  const findMany = jest.fn(({ where }: { where: { creator_id: string } }) =>
    Promise.resolve(tree.filter((n) => n.creator_id === where.creator_id)),
  );
  const prisma = { creatorCategory: { findMany } };
  type Fields = (
    creatorId: string | null,
    primaryId: string | null,
    linked: Node[],
  ) => Promise<{
    creator_categories: { id: string; path: string[] }[];
    primary_creator_category_id: string | null;
    primary_collection_path: { id: string; slug: string; path: string[] }[];
  }>;
  // The private method is exercised directly: no DI, only `prisma` is read.
  const service = Object.create(StorefrontService.prototype) as {
    prisma: PrismaService;
    primaryCollectionFields: Fields;
  };
  service.prisma = prisma as unknown as PrismaService;
  const fields: Fields = (creatorId, primaryId, linked) =>
    service.primaryCollectionFields(creatorId, primaryId, linked);
  return { fields, findMany };
}

describe('StorefrontService.primaryCollectionFields (M6 / M6.7)', () => {
  const root = node('root', null);
  const child = node('child', 'root');
  const leaf = node('leaf', 'child');
  const other = node('other', null);

  it('orders the primary first and returns its root -> leaf path with hierarchical paths', async () => {
    const { fields, findMany } = build([root, child, leaf, other]);
    const out = await fields('c1', 'leaf', [other, leaf]);
    expect(out.creator_categories.map((c) => c.id)).toEqual(['leaf', 'other']);
    expect(out.creator_categories.map((c) => c.path)).toEqual([
      ['root', 'child', 'leaf'],
      ['other'],
    ]);
    expect(out.primary_creator_category_id).toBe('leaf');
    expect(out.primary_collection_path.map((n) => n.id)).toEqual([
      'root',
      'child',
      'leaf',
    ]);
    expect(out.primary_collection_path.map((n) => n.path)).toEqual([
      ['root'],
      ['root', 'child'],
      ['root', 'child', 'leaf'],
    ]);
    // One read of the creator's collections, scoped to the creator.
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({ creator_id: 'c1' });
  });

  it('an inactive ancestor makes the collection unreachable: not served', async () => {
    const inactiveChild = node('child', 'root', { active: false });
    const { fields } = build([root, inactiveChild, leaf, other]);
    const out = await fields('c1', 'leaf', [leaf, other]);
    expect(out.primary_creator_category_id).toBeNull();
    expect(out.primary_collection_path).toEqual([]);
    expect(out.creator_categories.map((c) => c.id)).toEqual(['other']);
  });

  it('an inactive, INTERNAL or unlinked primary yields null and an empty path', async () => {
    const inactiveLeaf = node('leaf', 'child', { active: false });
    const { fields, findMany } = build([root, child, inactiveLeaf, other]);
    const inactive = await fields('c1', 'leaf', [inactiveLeaf, other]);
    expect(inactive.primary_creator_category_id).toBeNull();
    expect(inactive.primary_collection_path).toEqual([]);
    expect(inactive.creator_categories.map((c) => c.id)).toEqual(['other']);

    const label = node('label', null, { internal: true });
    const { fields: f2 } = build([other, label]);
    const internal = await f2('c1', 'label', [label, other]);
    expect(internal.primary_creator_category_id).toBeNull();
    expect(internal.creator_categories.map((c) => c.id)).toEqual(['other']);

    const unlinked = await fields('c1', 'root', [other]);
    expect(unlinked.primary_creator_category_id).toBeNull();
    expect(unlinked.primary_collection_path).toEqual([]);
    expect(unlinked.creator_categories.map((c) => c.id)).toEqual(['other']);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('no linked collection: no query, empty fields', async () => {
    const { fields, findMany } = build([root]);
    const out = await fields('c1', 'root', []);
    expect(out).toEqual({
      creator_categories: [],
      primary_creator_category_id: null,
      primary_collection_path: [],
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('an ancestor of another creator breaks the chain: not served', async () => {
    const foreignRoot = node('root', null, { creator: 'c2' });
    const { fields } = build([foreignRoot, child, leaf, other]);
    const out = await fields('c1', 'leaf', [leaf, other]);
    expect(out.primary_creator_category_id).toBeNull();
    expect(out.creator_categories.map((c) => c.id)).toEqual(['other']);
  });
});
