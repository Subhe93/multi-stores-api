import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { CreatorCategoriesService } from './creator-categories.service';
import type { PrismaService } from '../../prisma/prisma.service';

// Collection descriptions (short `description` and the M6.2
// `long_description`) are rendered on the storefront as HTML: sanitized on
// create() and update(); the X19 carry-over of an omitted field is
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
    // WP slug rule: store content locale + uniqueness lookups.
    store: { findUnique: jest.fn(() => Promise.resolve(null)) },
    creatorCategory: {
      findFirst: jest.fn(() => Promise.resolve(null)),
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
            long_description: '<h2>stored long</h2>',
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
    svc: new CreatorCategoriesService(
      prisma as unknown as PrismaService,
      {
        revalidateStoreByCreatorId: jest.fn(),
      } as unknown as RevalidationService,
    ),
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

  // M6.2
  it('create() stores a sanitized long_description and null when omitted', async () => {
    const { svc, create } = setup();
    await svc.create('u1', {
      slug: 'c',
      translations: [
        {
          locale: 'en',
          name: 'N',
          description: '<p>short</p>',
          long_description:
            '<h2>SEO</h2><p onclick="x()">text</p><script>x()</script>',
        },
        { locale: 'sv', name: 'S' },
      ],
    } as never);
    const data = create.mock.calls[0][0].data as {
      translations: { create: Row[] };
    };
    expect(data.translations.create[0]).toMatchObject({
      description: '<p>short</p>',
      long_description: '<h2>SEO</h2><p>text</p>',
    });
    // Omitted on create: nothing is written, the column stays null.
    expect(data.translations.create[1]).not.toHaveProperty('long_description');
  });

  it('update() stores a sanitized long_description and keeps the carry-over', async () => {
    const { svc, createMany } = setup();
    await svc.update('cat1', 'u1', {
      translations: [
        {
          locale: 'en',
          name: 'N',
          long_description: '<p>long</p><script>alert(1)</script>',
        },
        { locale: 'sv', name: 'S' },
      ],
    });
    const rows = createMany.mock.calls[0][0].data;
    expect(rows.map((r) => [r.locale, r.long_description])).toEqual([
      ['en', '<p>long</p>'],
      ['sv', '<h2>stored long</h2>'],
    ]);
  });

  it('a script-only long_description is persisted as null', async () => {
    const { svc, createMany } = setup();
    await svc.update('cat1', 'u1', {
      translations: [
        { locale: 'en', name: 'N', long_description: '<script>x()</script>' },
      ],
    });
    const rows = createMany.mock.calls[0][0].data;
    expect(rows[0].long_description).toBeNull();
  });
});
