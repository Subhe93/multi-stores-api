import { TranslationsService } from './translations.service';
import { CategoriesService } from '../categories/categories.service';
import { TranslatableEntity } from './dto/translation.dto';
import type { PrismaService } from '../../prisma/prisma.service';
import { storeRow, table } from '../../common/slug/__fixtures__/fake-slug-db';

// Auto-translate slugs (formerly `generateSlug`, which dropped Arabic and
// `ä`) and platform categories follow WordPress sanitize_title.

type Row = Record<string, unknown>;

describe('TranslationsService auto-translate slugs', () => {
  function setup(existing: Row[] = []) {
    const upsert = jest.fn((_args: { create: { slug: string } }) =>
      Promise.resolve({}),
    );
    const prisma = {
      store: table([storeRow('s1', 'c1', 'sv')]),
      product: {
        findUnique: jest.fn(() =>
          Promise.resolve({ creator_id: 'c1', provider_id: null }),
        ),
      },
      customProduct: {
        findUnique: jest.fn(() => Promise.resolve({ creator_id: 'c1' })),
      },
      productTranslation: { ...table(existing), upsert },
      customProductTranslation: { ...table([]), upsert },
    };
    const svc = new TranslationsService(prisma as unknown as PrismaService);
    const internals = svc as unknown as {
      saveTranslation: (
        t: TranslatableEntity,
        id: string,
        locale: string,
        tr: Record<string, string>,
      ) => Promise<void>;
    };
    const save = (
      t: TranslatableEntity,
      id: string,
      locale: string,
      tr: Record<string, string>,
    ) => internals.saveTranslation(t, id, locale, tr);
    return { save, upsert };
  }

  it.each([
    ['هدية لأمي', 'ar', 'هدية-لأمي'],
    ['Present till svärfar', 'en', 'present-till-svarfar'],
    ['Kläder', 'de', 'klader'], // the STORE locale (sv) folds, not the target
  ])('%s (%s) -> %s', async (title, locale, slug) => {
    const { save, upsert } = setup();
    await save(TranslatableEntity.PRODUCT, 'p1', locale, {
      title,
      description: 'd',
    });
    expect(upsert.mock.calls[0][0].create.slug).toBe(slug);
  });

  it('a slug taken by another product of the creator gets -2', async () => {
    const { save, upsert } = setup([
      {
        id: 't9',
        locale: 'en',
        slug: 'mug',
        product: { id: 'p9', creator_id: 'c1' },
      },
    ]);
    await save(TranslatableEntity.PRODUCT, 'p1', 'en', {
      title: 'Mug',
      description: 'd',
    });
    expect(upsert.mock.calls[0][0].create.slug).toBe('mug-2');
  });

  it('custom products use the same rule', async () => {
    const { save, upsert } = setup();
    await save(TranslatableEntity.CUSTOM_PRODUCT, 'cp1', 'ar', {
      title: 'هدية لأمي',
      description: 'd',
    });
    expect(upsert.mock.calls[0][0].create.slug).toBe('هدية-لأمي');
  });
});

describe('CategoriesService (platform) WP slugs', () => {
  function setup(rows: Row[]) {
    const t = table(rows);
    const create = jest.fn((args: { data: Row }) => Promise.resolve(args.data));
    const update = jest.fn((args: { data: Row }) => Promise.resolve(args.data));
    const prisma = {
      category: { ...t, create, update },
      categoryTranslation: { deleteMany: jest.fn() },
    };
    return {
      svc: new CategoriesService(prisma as unknown as PrismaService),
      create,
      update,
      findUnique: t.findUnique,
      findFirst: t.findFirst,
    };
  }

  it('create: sanitized, empty slug from the English name, duplicates -2', async () => {
    const { svc, create } = setup([{ id: 'k1', slug: 'klader' }]);
    await svc.create({
      slug: 'Kläder',
      translations: [{ locale: 'sv', name: 'Kläder' }],
    } as never);
    await svc.create({
      slug: '',
      translations: [
        { locale: 'ar', name: 'هدية' },
        { locale: 'en', name: 'Gifts' },
      ],
    } as never);
    expect(create.mock.calls.map((c) => c[0].data.slug)).toEqual([
      'klader-2',
      'gifts',
    ]);
  });

  it('update: unchanged kept, changed sanitized; lookup normalizes the slug', async () => {
    const { svc, update, findFirst } = setup([
      { id: 'k1', slug: 'straße', translations: [] },
    ]);
    await svc.update('k1', { slug: 'straße' } as never);
    expect(update.mock.calls[0][0].data).not.toHaveProperty('slug');
    await svc.update('k1', { slug: 'Ny Kategori' } as never);
    expect(update.mock.calls[1][0].data.slug).toBe('ny-kategori');
    // Exact on the stored form first; a legacy `Straße` is found by the
    // case-insensitive retry.
    await expect(svc.findBySlug('STRA%C3%9FE')).resolves.toMatchObject({
      id: 'k1',
    });
    expect(findFirst.mock.calls.at(-1)?.[0]).toMatchObject({
      where: { slug: { equals: 'straße' } },
    });
    // A legacy slug with capitals: exact miss, then the insensitive hit.
    const legacy = setup([{ id: 'k2', slug: 'Kläder', translations: [] }]);
    await expect(legacy.svc.findBySlug('kl%C3%A4der')).resolves.toMatchObject({
      id: 'k2',
    });
    expect(legacy.findFirst).toHaveBeenCalledTimes(2);
  });
});
