import { CreatorCategoriesService } from './creator-categories.service';
import type { PrismaService } from '../../prisma/prisma.service';

// Collection descriptions are rendered on the storefront as HTML: sanitized
// on create() and update(); the X19 carry-over of an omitted description is
// unaffected.

type Row = Record<string, unknown>;

function setup() {
  const create = jest.fn((args: { data: Row }) =>
    Promise.resolve({ id: 'cat1', ...args.data }),
  );
  const createMany = jest.fn((_args: { data: Row[] }) =>
    Promise.resolve({ count: 1 }),
  );
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    creatorCategory: {
      create,
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'cat1', creator_id: 'c1', translations: [] }),
      ),
      update: jest.fn(() => Promise.resolve({})),
    },
    creatorCategoryTranslation: {
      findMany: jest.fn(() =>
        Promise.resolve([
          {
            locale: 'sv',
            description: '<p>stored</p>',
            meta_title: null,
            meta_desc: null,
          },
        ]),
      ),
      deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
      createMany,
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return {
    svc: new CreatorCategoriesService(prisma as unknown as PrismaService),
    create,
    createMany,
  };
}

describe('CreatorCategoriesService HTML sanitizing on write', () => {
  it('create() stores a sanitized description', async () => {
    const { svc, create } = setup();
    await svc.create('u1', {
      slug: 'c',
      translations: [
        {
          locale: 'en',
          name: 'N',
          description: '<p>d</p><script>x()</script>',
        },
      ],
    } as never);
    const data = create.mock.calls[0][0].data as {
      translations: { create: Row[] };
    };
    expect(data.translations.create[0].description).toBe('<p>d</p>');
  });

  it('update() stores a sanitized description and keeps the carry-over', async () => {
    const { svc, createMany } = setup();
    await svc.update('cat1', 'u1', {
      translations: [
        { locale: 'en', name: 'N', description: '<p onclick="x()">d</p>' },
        { locale: 'sv', name: 'S' },
      ],
    });
    const rows = createMany.mock.calls[0][0].data;
    expect(rows.map((r) => [r.locale, r.description])).toEqual([
      ['en', '<p>d</p>'],
      ['sv', '<p>stored</p>'],
    ]);
  });
});
