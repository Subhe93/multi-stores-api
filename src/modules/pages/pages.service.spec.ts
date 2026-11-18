import { UserRole } from '@prisma/client';
import { PagesService } from './pages.service';
import type { PrismaService } from '../../prisma/prisma.service';

// Legacy static page content is rendered on the storefront as HTML:
// sanitized on create() and update().

type Row = Record<string, unknown>;

function setup() {
  const create = jest.fn((args: { data: Row }) => Promise.resolve(args.data));
  const update = jest.fn((args: { data: Row }) => Promise.resolve(args.data));
  const prisma = {
    staticPage: {
      create,
      update,
      findUnique: jest.fn(() => Promise.resolve({ id: 'pg1', store_id: 's1' })),
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
    staticPageTranslation: { deleteMany: jest.fn() },
    // WP slug rule: store content locale + uniqueness lookups.
    store: { findUnique: jest.fn(() => Promise.resolve(null)) },
    page: { findFirst: jest.fn(() => Promise.resolve(null)) },
  };
  return {
    svc: new PagesService(prisma as unknown as PrismaService),
    create,
    update,
  };
}

const contents = (data: Row) =>
  (data.translations as { create: Row[] }).create.map((t) => t.content);

describe('PagesService HTML sanitizing on write', () => {
  it('create() stores sanitized content', async () => {
    const { svc, create } = setup();
    await svc.create(
      's1',
      {
        type: 'CUSTOM',
        slug: 'faq',
        translations: [
          { locale: 'en', title: 'T', content: '<p>c</p><script>x()</script>' },
          { locale: 'sv', title: 'T' },
        ],
      },
      'admin',
      UserRole.ADMIN,
    );
    expect(contents(create.mock.calls[0][0].data)).toEqual([
      '<p>c</p>',
      undefined,
    ]);
  });

  it('update() stores sanitized content', async () => {
    const { svc, update } = setup();
    await svc.update(
      'pg1',
      {
        translations: [
          {
            locale: 'en',
            title: 'T',
            content:
              '<p>c</p><form action="https://evil.example"><input></form>',
          },
        ],
      },
      'admin',
      UserRole.ADMIN,
    );
    expect(contents(update.mock.calls[0][0].data)).toEqual(['<p>c</p>']);
  });
});

// Legacy pages are served from the store cache of the storefront: a deleted
// or unpublished page otherwise keeps answering 200.

describe('PagesService storefront revalidation', () => {
  function build(page: Row) {
    const prisma = {
      staticPage: {
        create: jest.fn((args: { data: Row }) =>
          Promise.resolve({ id: 'pg1', ...args.data }),
        ),
        update: jest.fn((args: { data: Row }) =>
          Promise.resolve({ ...page, ...args.data }),
        ),
        delete: jest.fn(() => Promise.resolve(page)),
        findUnique: jest.fn(() => Promise.resolve(page)),
        findFirst: jest.fn(() => Promise.resolve(null)),
      },
      staticPageTranslation: { deleteMany: jest.fn() },
      store: { findUnique: jest.fn(() => Promise.resolve(null)) },
      page: { findFirst: jest.fn(() => Promise.resolve(null)) },
    };
    const revalidation = { revalidateStoreById: jest.fn() };
    const svc = new PagesService(
      prisma as unknown as PrismaService,
      undefined,
      revalidation as never,
    );
    return { svc, prisma, revalidation };
  }
  const live = { id: 'pg1', store_id: 's1', slug: 'faq', status: 'PUBLISHED' };
  const draft = { ...live, status: 'DRAFT' };

  it('delete revalidates the store after the row is gone', async () => {
    const { svc, prisma, revalidation } = build(live);
    await svc.delete('pg1', 'admin', UserRole.ADMIN);
    expect(prisma.staticPage.delete).toHaveBeenCalled();
    expect(revalidation.revalidateStoreById).toHaveBeenCalledWith('s1');
  });

  it('create revalidates the store', async () => {
    const { svc, revalidation } = build(live);
    await svc.create(
      's1',
      { type: 'CUSTOM', slug: 'faq' },
      'admin',
      UserRole.ADMIN,
    );
    expect(revalidation.revalidateStoreById).toHaveBeenCalledWith('s1');
  });

  it('a content edit of a published page (no slug change) revalidates', async () => {
    const { svc, revalidation } = build(live);
    await svc.update(
      'pg1',
      { translations: [{ locale: 'en', title: 'T', content: '<p>c</p>' }] },
      'admin',
      UserRole.ADMIN,
    );
    expect(revalidation.revalidateStoreById).toHaveBeenCalledWith('s1');
  });

  it('unpublish and publish (no slug change) revalidate', async () => {
    const a = build(live);
    await a.svc.update('pg1', { status: 'DRAFT' }, 'admin', UserRole.ADMIN);
    expect(a.revalidation.revalidateStoreById).toHaveBeenCalledWith('s1');
    const b = build(draft);
    await b.svc.update('pg1', { status: 'PUBLISHED' }, 'admin', UserRole.ADMIN);
    expect(b.revalidation.revalidateStoreById).toHaveBeenCalledWith('s1');
  });

  it('an edit of a draft page that stays a draft does not revalidate', async () => {
    const { svc, revalidation } = build(draft);
    await svc.update(
      'pg1',
      { translations: [{ locale: 'en', title: 'T' }] },
      'admin',
      UserRole.ADMIN,
    );
    expect(revalidation.revalidateStoreById).not.toHaveBeenCalled();
  });
});
