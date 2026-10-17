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
      deleteMany: jest.fn(({ where }: { where: { locale?: { in: string[] } } }) => {
        const gone = rows.filter(
          (r) => !where.locale || where.locale.in.includes(r.locale),
        );
        for (const g of gone) rows.splice(rows.indexOf(g), 1);
        return Promise.resolve({ count: gone.length });
      }),
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
        { locale: 'en', name: 'Tags', description: null as never, meta_title: null },
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
