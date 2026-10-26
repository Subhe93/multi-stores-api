import { CreatorCategoriesService } from './creator-categories.service';
import type { PrismaService } from '../../prisma/prisma.service';

// M5 A-X: saving the translations of one locale must not wipe the other
// locales (X19 carry-over, same semantics as ProductsService.update):
// locales not sent are untouched; in a sent row `undefined` keeps the
// stored value and an explicit empty clears it.

type Translation = {
  locale: string;
  name: string;
  description: string | null;
  meta_title: string | null;
  meta_desc: string | null;
};

function build(stored: Translation[]) {
  const rows = stored.map((t) => ({ ...t, creator_category_id: 'cat1' }));
  const prisma = {
    creator: {
      findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })),
    },
    creatorCategory: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'cat1', creator_id: 'c1', translations: rows }),
      ),
      update: jest.fn(() => Promise.resolve({})),
    },
    creatorCategoryTranslation: {
      findMany: jest.fn(({ where }: { where: { locale?: { in: string[] } } }) =>
        Promise.resolve(
          rows.filter(
            (r) => !where.locale || where.locale.in.includes(r.locale),
          ),
        ),
      ),
      deleteMany: jest.fn(
        ({ where }: { where: { locale?: { in: string[] } } }) => {
          const gone = rows.filter(
            (r) => !where.locale || where.locale.in.includes(r.locale),
          );
          for (const g of gone) rows.splice(rows.indexOf(g), 1);
          return Promise.resolve({ count: gone.length });
        },
      ),
      createMany: jest.fn(({ data }: { data: Translation[] }) => {
        rows.push(...data.map((t) => ({ ...t, creator_category_id: 'cat1' })));
        return Promise.resolve({ count: data.length });
      }),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const service = new CreatorCategoriesService(
    prisma as unknown as PrismaService,
  );
  return { prisma, service, rows };
}

const STORED: Translation[] = [
  {
    locale: 'sv',
    name: 'Namnskyltar',
    description: 'Svensk text',
    meta_title: 'Namnskyltar | Namez',
    meta_desc: 'SEO sv',
  },
  {
    locale: 'en',
    name: 'Name tags',
    description: 'English text',
    meta_title: 'Name tags | Namez',
    meta_desc: 'SEO en',
  },
];

describe('CreatorCategoriesService.update translations (M5 A-X carry-over)', () => {
  it('keeps the locales that are not sent', async () => {
    const { service, rows } = build(STORED);
    await service.update('cat1', 'u1', {
      translations: [{ locale: 'sv', name: 'Skyltar' }],
    });
    const byLocale = new Map(rows.map((r) => [r.locale, r]));
    expect(byLocale.get('en')).toMatchObject({
      name: 'Name tags',
      description: 'English text',
      meta_title: 'Name tags | Namez',
    });
    expect(byLocale.get('sv')).toMatchObject({ name: 'Skyltar' });
  });

  it('undefined keeps the stored description/meta of the locale; an explicit empty clears', async () => {
    const { service, rows } = build(STORED);
    await service.update('cat1', 'u1', {
      translations: [
        { locale: 'sv', name: 'Skyltar', meta_desc: '' },
        {
          locale: 'en',
          name: 'Tags',
          description: null as never,
          meta_title: null,
        },
      ],
    });
    const byLocale = new Map(rows.map((r) => [r.locale, r]));
    expect(byLocale.get('sv')).toEqual({
      creator_category_id: 'cat1',
      locale: 'sv',
      name: 'Skyltar',
      description: 'Svensk text',
      meta_title: 'Namnskyltar | Namez',
      meta_desc: null,
    });
    expect(byLocale.get('en')).toEqual({
      creator_category_id: 'cat1',
      locale: 'en',
      name: 'Tags',
      description: null,
      meta_title: null,
      meta_desc: 'SEO en',
    });
  });

  it('only deletes the locales it rewrites (never the whole set)', async () => {
    const { service, prisma } = build(STORED);
    await service.update('cat1', 'u1', {
      translations: [{ locale: 'sv', name: 'Skyltar' }],
    });
    expect(prisma.creatorCategoryTranslation.deleteMany).toHaveBeenCalledWith({
      where: { creator_category_id: 'cat1', locale: { in: ['sv'] } },
    });
  });

  it('an update without translations does not touch them', async () => {
    const { service, prisma } = build(STORED);
    await service.update('cat1', 'u1', { slug: 'skyltar' });
    expect(prisma.creatorCategoryTranslation.deleteMany).not.toHaveBeenCalled();
    expect(prisma.creatorCategoryTranslation.createMany).not.toHaveBeenCalled();
  });
});

// M6: three levels of collections at most (root = 0, grandchild = 2).
// Checked on create (parent depth <= 1) and on a move (new depth plus the
// height of the moved subtree <= 2).

function buildTree(nodes: Record<string, string | null>) {
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    creatorCategory: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id in nodes
            ? {
                id: where.id,
                creator_id: 'c1',
                parent_id: nodes[where.id],
                translations: [],
              }
            : null,
        ),
      ),
      findMany: jest.fn(({ where }: { where: { parent_id?: string } }) =>
        Promise.resolve(
          Object.entries(nodes)
            .filter(([, parent]) => parent === where.parent_id)
            .map(([id]) => ({ id })),
        ),
      ),
      create: jest.fn(() => Promise.resolve({ id: 'created' })),
      update: jest.fn(() => Promise.resolve({})),
    },
    creatorCategoryTranslation: {
      findMany: jest.fn(() => Promise.resolve([])),
      deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
      createMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const service = new CreatorCategoriesService(
    prisma as unknown as PrismaService,
  );
  jest
    .spyOn(service, 'findById')
    .mockImplementation(() => Promise.resolve({} as never));
  return { prisma, service };
}

// root -> child -> grandchild, plus a second root with one child.
const TREE = {
  root: null,
  child: 'root',
  grandchild: 'child',
  root2: null,
  child2: 'root2',
};

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as { getResponse: () => { code: string } }).getResponse().code;
  }
}

describe('CreatorCategoriesService depth cap (M6, CREATOR_CATEGORY_MAX_DEPTH)', () => {
  it('create: a parent at depth 0 or 1 is fine, a parent at depth 2 is rejected', async () => {
    const { service, prisma } = buildTree(TREE);
    const dto = { slug: 'x', translations: [{ locale: 'en', name: 'X' }] };
    await service.create('u1', { ...dto, parent_id: 'root' });
    await service.create('u1', { ...dto, parent_id: 'child' });
    expect(prisma.creatorCategory.create).toHaveBeenCalledTimes(2);
    expect(
      await codeOf(service.create('u1', { ...dto, parent_id: 'grandchild' })),
    ).toBe('CREATOR_CATEGORY_MAX_DEPTH');
    expect(prisma.creatorCategory.create).toHaveBeenCalledTimes(2);
  });

  it('update: a move counts the subtree it carries', async () => {
    const { service, prisma } = buildTree(TREE);
    // root2 (height 1: child2) under root -> depths 1 + 2: fine.
    await service.update('root2', 'u1', { parent_id: 'root' });
    expect(prisma.creatorCategory.update).toHaveBeenCalledTimes(1);
    // root2 under child -> child2 would land at depth 3: rejected.
    expect(
      await codeOf(service.update('root2', 'u1', { parent_id: 'child' })),
    ).toBe('CREATOR_CATEGORY_MAX_DEPTH');
    // A leaf can still go under a depth-1 node.
    await service.update('child2', 'u1', { parent_id: 'child' });
    // ... but not under a depth-2 node.
    expect(
      await codeOf(service.update('child2', 'u1', { parent_id: 'grandchild' })),
    ).toBe('CREATOR_CATEGORY_MAX_DEPTH');
    // Moving to the root (parent_id null) is always allowed.
    await service.update('grandchild', 'u1', { parent_id: null });
    expect(prisma.creatorCategory.update).toHaveBeenCalledTimes(3);
  });
});
