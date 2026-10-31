import { Prisma } from '@prisma/client';
import { CreatorCategoriesService } from './creator-categories.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';
import type { RedirectsService } from '../redirects/redirects.service';
import { storeRow, table } from '../../common/slug/__fixtures__/fake-slug-db';

// Collections (WP hierarchical terms): sanitized slugs, `<slug>-<parent>`
// then `-N` instead of a 500 on a duplicate, and old-path 301s for the
// renamed collection and its whole subtree.

type Cat = {
  id: string;
  slug: string;
  parent_id: string | null;
  creator_id: string;
  is_active: boolean;
  visibility: string;
};

function setup(cats: Cat[], locale = 'sv') {
  const rows = cats.map((c) => ({ ...c }));
  const cc = table(rows as unknown as Record<string, unknown>[]);
  const create = jest.fn((args: { data: Record<string, unknown> }) => {
    const row = { ...(args.data as unknown as Cat), id: 'new' };
    rows.push(row);
    return Promise.resolve(row);
  });
  const update = jest.fn(
    (args: { where: { id: string }; data: Partial<Cat> }) => {
      const row = rows.find((r) => r.id === args.where.id)!;
      Object.assign(row, args.data);
      return Promise.resolve(row);
    },
  );
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    store: table([storeRow('s1', 'c1', locale)]),
    creatorCategory: {
      ...cc,
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          rows.find((r) => r.id === where.id)
            ? { ...rows.find((r) => r.id === where.id), translations: [] }
            : null,
        ),
      ),
      create,
      update,
      count: jest.fn(() => Promise.resolve(0)),
    },
    creatorCategoryTranslation: {
      findMany: jest.fn(() => Promise.resolve([])),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const redirects = {
    applySlugChangeRedirects: jest.fn(() => Promise.resolve(null)),
    releaseLivePaths: jest.fn(() => Promise.resolve(0)),
  };
  const svc = new CreatorCategoriesService(
    prisma as unknown as PrismaService,
    { revalidateStoreByCreatorId: jest.fn() } as unknown as RevalidationService,
    redirects as unknown as RedirectsService,
  );
  const internals = svc as unknown as Record<string, unknown>;
  internals.writeProductLinks = jest.fn(() => Promise.resolve());
  internals.findById = jest.fn((id: string) =>
    Promise.resolve(rows.find((r) => r.id === id)),
  );
  return { svc, rows, create, redirects };
}

const cat = (
  id: string,
  slug: string,
  parent_id: string | null = null,
): Cat => ({
  id,
  slug,
  parent_id,
  creator_id: 'c1',
  is_active: true,
  visibility: 'PUBLIC',
});

const tr = (name: string) => [{ locale: 'sv', name }];

describe('CreatorCategoriesService WP slugs', () => {
  it('create: Swedish and Arabic names, empty slug from the name', async () => {
    const { svc, create } = setup([]);
    await svc.create('u', { slug: 'Kläder', translations: tr('Kläder') });
    await svc.create('u', { slug: '', translations: tr('هدية لأمي') });
    expect(create.mock.calls.map((c) => c[0].data.slug)).toEqual([
      'klader',
      'هدية-لأمي',
    ]);
  });

  it('create: old-slug 301s on the new live path are released (they would shadow it)', async () => {
    const { svc, redirects } = setup([cat('a', 'rea')]);
    await svc.create('u', { slug: 'Kampanj', translations: tr('Kampanj') });
    expect(redirects.releaseLivePaths).toHaveBeenCalledWith(
      's1',
      expect.arrayContaining(['/collections/rea']),
      { localePrefixes: true },
    );
  });

  it('create: a duplicate tries <slug>-<parent>, then -2 (no 500)', async () => {
    const { svc, create } = setup([cat('shirts', 'shirts'), cat('red', 'red')]);
    await svc.create('u', {
      slug: 'red',
      parent_id: 'shirts',
      translations: tr('Red'),
    });
    await svc.create('u', { slug: 'red', translations: tr('Red') });
    expect(create.mock.calls.map((c) => c[0].data.slug)).toEqual([
      'red-shirts',
      'red-2',
    ]);
  });

  it('create: a P2002 race recomputes the slug once', async () => {
    const { svc, create, rows } = setup([]);
    create.mockImplementationOnce(() => {
      rows.push(cat('racer', 'mugg'));
      return Promise.reject(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'x',
        }),
      );
    });
    await svc.create('u', { slug: 'mugg', translations: tr('Mugg') });
    expect(create.mock.calls.map((c) => c[0].data.slug)).toEqual([
      'mugg',
      'mugg-2',
    ]);
  });

  it('update: an unchanged slug is kept; a rename sanitizes and 301s the subtree', async () => {
    const { svc, rows, redirects } = setup([
      cat('a', 'klader'),
      cat('b', 'troja', 'a'),
      cat('c', 'straße', 'b'),
    ]);
    await svc.update('c', 'u', { slug: 'straße' });
    expect(rows.find((r) => r.id === 'c')!.slug).toBe('straße');
    expect(redirects.applySlugChangeRedirects).not.toHaveBeenCalled();

    await svc.update('a', 'u', { slug: 'Kläder & Mode' });
    expect(rows.find((r) => r.id === 'a')!.slug).toBe('klader-mode');
    expect(redirects.applySlugChangeRedirects).toHaveBeenCalledWith(
      's1',
      [
        { from: '/collections/klader', to: '/collections/klader-mode' },
        {
          from: '/collections/klader/troja',
          to: '/collections/klader-mode/troja',
        },
        {
          from: '/collections/klader/troja/stra%c3%9fe',
          to: '/collections/klader-mode/troja/stra%c3%9fe',
        },
      ],
      undefined,
      { localePrefixes: true },
    );
  });

  it('update: a rename to a taken slug is suffixed (this row excluded)', async () => {
    const { svc, rows } = setup([cat('a', 'rea'), cat('b', 'kampanj')]);
    await svc.update('b', 'u', { slug: 'REA' });
    expect(rows.find((r) => r.id === 'b')!.slug).toBe('rea-2');
    await svc.update('a', 'u', { slug: 'rea' });
    expect(rows.find((r) => r.id === 'a')!.slug).toBe('rea');
  });
});
