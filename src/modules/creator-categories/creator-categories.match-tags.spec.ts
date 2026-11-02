import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { CreatorCategoriesService } from './creator-categories.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { withMatchTagIds } from './tag-rule';

// Tags rename (2026-11-02): a TAGS-rule collection lists INTERNAL rows
// (tags) by id in `match_tag_ids` (stored in the `match_tags` column);
// PUBLIC or foreign ids are rejected; `match_tags` stays as an alias.

type Row = {
  id: string;
  creator_id: string;
  visibility: 'PUBLIC' | 'INTERNAL';
};

function build(rows: Row[]) {
  const updates: unknown[] = [];
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    store: { findUnique: jest.fn(() => Promise.resolve(null)) },
    creatorCategory: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          creator_id: 'c1',
          visibility: 'PUBLIC',
          parent_id: null,
          slug: 'gifts',
        }),
      ),
      findMany: jest.fn(
        ({ where }: { where: { id: { in: string[] }; creator_id: string } }) =>
          Promise.resolve(
            rows
              .filter(
                (r) =>
                  where.id.in.includes(r.id) &&
                  r.creator_id === where.creator_id,
              )
              .map((r) => ({ id: r.id, visibility: r.visibility })),
          ),
      ),
      update: jest.fn((args: unknown) => {
        updates.push(args);
        return Promise.resolve({});
      }),
      count: jest.fn(() => Promise.resolve(0)),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const service = new CreatorCategoriesService(
    prisma as unknown as PrismaService,
    { revalidateStoreByCreatorId: jest.fn() } as unknown as RevalidationService,
  );
  (service as unknown as { findById: unknown }).findById = jest.fn(
    (id: string) => Promise.resolve({ id }),
  );
  return { service, prisma, updates };
}

const ROWS: Row[] = [
  { id: 'tag-a', creator_id: 'c1', visibility: 'INTERNAL' },
  { id: 'tag-b', creator_id: 'c1', visibility: 'INTERNAL' },
  { id: 'pub-1', creator_id: 'c1', visibility: 'PUBLIC' },
  { id: 'tag-x', creator_id: 'other', visibility: 'INTERNAL' },
];

describe('CreatorCategoriesService match_tag_ids', () => {
  it('stores de-duplicated INTERNAL ids of the creator in match_tags', async () => {
    const { service, updates } = build(ROWS);
    await service.update('cat1', 'u1', {
      match_rule: 'TAGS',
      match_tag_ids: ['tag-a', ' tag-b ', 'tag-a'],
    });
    expect(updates[0]).toMatchObject({
      where: { id: 'cat1' },
      data: { match_rule: 'TAGS', match_tags: ['tag-a', 'tag-b'] },
    });
  });

  it('accepts the deprecated match_tags alias, ignored when match_tag_ids is sent', async () => {
    const { service, updates } = build(ROWS);
    await service.update('cat1', 'u1', { match_tags: ['tag-b'] });
    expect(updates[0]).toMatchObject({ data: { match_tags: ['tag-b'] } });
    await service.update('cat1', 'u1', {
      match_tag_ids: ['tag-a'],
      match_tags: ['tag-b'],
    });
    expect(updates[1]).toMatchObject({ data: { match_tags: ['tag-a'] } });
    // Not sent: the stored value is left alone.
    await service.update('cat1', 'u1', { sort_order: 3 });
    expect(
      (updates[2] as { data: Record<string, unknown> }).data,
    ).not.toHaveProperty('match_tags');
  });

  it('rejects PUBLIC collections and ids of another creator / unknown ids', async () => {
    const { service, updates } = build(ROWS);
    await expect(
      service.update('cat1', 'u1', { match_tag_ids: ['tag-a', 'pub-1'] }),
    ).rejects.toMatchObject({
      response: {
        code: 'CREATOR_CATEGORY_MATCH_TAG_NOT_INTERNAL',
        ids: ['pub-1'],
      },
    });
    await expect(
      service.update('cat1', 'u1', { match_tag_ids: ['tag-x', 'nope'] }),
    ).rejects.toMatchObject({
      response: {
        code: 'CREATOR_CATEGORY_MATCH_TAG_UNKNOWN',
        ids: ['tag-x', 'nope'],
      },
    });
    expect(updates).toHaveLength(0);
  });

  it('withMatchTagIds exposes match_tag_ids next to match_tags', () => {
    expect(withMatchTagIds({ id: 'x', match_tags: ['tag-a'] })).toEqual({
      id: 'x',
      match_tags: ['tag-a'],
      match_tag_ids: ['tag-a'],
    });
  });
});
