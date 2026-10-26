import { StorefrontService } from './storefront.service';
import type { PrismaService } from '../../prisma/prisma.service';

// M6: the collection fields of a storefront product payload. The primary
// comes first in `creator_categories`, `primary_collection_path` is
// root -> leaf (inactive ancestors skipped, chain order kept, at most two
// hops) and an inactive / unknown primary yields null + [].

type Node = {
  id: string;
  slug: string;
  parent_id: string | null;
  is_active: boolean;
  creator_id: string;
  translations: { locale: string; name: string }[];
};

function node(
  id: string,
  parent: string | null,
  opts: { active?: boolean; creator?: string } = {},
): Node {
  return {
    id,
    slug: id,
    parent_id: parent,
    is_active: opts.active ?? true,
    creator_id: opts.creator ?? 'c1',
    translations: [{ locale: 'en', name: id.toUpperCase() }],
  };
}

function build(tree: Node[]) {
  const byId = new Map(tree.map((n) => [n.id, n]));
  const findFirst = jest.fn(
    ({ where }: { where: { id: string; creator_id?: string } }) => {
      const row = byId.get(where.id);
      if (!row) return Promise.resolve(null);
      if (where.creator_id && row.creator_id !== where.creator_id)
        return Promise.resolve(null);
      return Promise.resolve(row);
    },
  );
  const prisma = { creatorCategory: { findFirst } };
  type Fields = (
    creatorId: string | null,
    primaryId: string | null,
    linked: Node[],
  ) => Promise<{
    creator_categories: { id: string }[];
    primary_creator_category_id: string | null;
    primary_collection_path: { id: string; slug: string }[];
  }>;
  // The private method is exercised directly: no DI, only `prisma` is read.
  const service = Object.create(StorefrontService.prototype) as {
    prisma: PrismaService;
    primaryCollectionFields: Fields;
  };
  service.prisma = prisma as unknown as PrismaService;
  const fields: Fields = (creatorId, primaryId, linked) =>
    service.primaryCollectionFields(creatorId, primaryId, linked);
  return { fields, findFirst };
}

describe('StorefrontService.primaryCollectionFields (M6)', () => {
  const root = node('root', null);
  const child = node('child', 'root');
  const leaf = node('leaf', 'child');
  const other = node('other', null);

  it('orders the primary first and returns its root -> leaf path', async () => {
    const { fields, findFirst } = build([root, child, leaf, other]);
    const out = await fields('c1', 'leaf', [other, leaf]);
    expect(out.creator_categories.map((c) => c.id)).toEqual(['leaf', 'other']);
    expect(out.primary_creator_category_id).toBe('leaf');
    expect(out.primary_collection_path.map((n) => n.id)).toEqual([
      'root',
      'child',
      'leaf',
    ]);
    // Two ancestor reads at most (depth cap), scoped to the creator.
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(findFirst.mock.calls[0][0].where).toEqual({
      id: 'child',
      creator_id: 'c1',
    });
  });

  it('skips an inactive ancestor but keeps walking up the chain', async () => {
    const inactiveChild = node('child', 'root', { active: false });
    const { fields } = build([root, inactiveChild, leaf]);
    const out = await fields('c1', 'leaf', [leaf]);
    expect(out.primary_collection_path.map((n) => n.id)).toEqual([
      'root',
      'leaf',
    ]);
  });

  it('an inactive or unlinked primary yields null and an empty path', async () => {
    const inactiveLeaf = node('leaf', 'child', { active: false });
    const { fields, findFirst } = build([root, child, inactiveLeaf, other]);
    const inactive = await fields('c1', 'leaf', [inactiveLeaf, other]);
    expect(inactive.primary_creator_category_id).toBeNull();
    expect(inactive.primary_collection_path).toEqual([]);
    expect(inactive.creator_categories.map((c) => c.id)).toEqual(['other']);

    const unlinked = await fields('c1', 'root', [other]);
    expect(unlinked.primary_creator_category_id).toBeNull();
    expect(unlinked.primary_collection_path).toEqual([]);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('stops at an ancestor of another creator', async () => {
    const foreignRoot = node('root', null, { creator: 'c2' });
    const { fields } = build([foreignRoot, child, leaf]);
    const out = await fields('c1', 'leaf', [leaf]);
    expect(out.primary_collection_path.map((n) => n.id)).toEqual([
      'child',
      'leaf',
    ]);
  });
});
