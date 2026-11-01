import { PagesV2Service } from './pages-v2.service';
import { RedirectsService } from '../redirects/redirects.service';
import { StorefrontService } from '../storefront/storefront.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';
import { storeRow, table } from '../../common/slug/__fixtures__/fake-slug-db';

// Permalink edit from the builder (PUT /v2/pages/:id { slug }) on a
// published page: the new URL serves at once (no re-publish, the storefront
// looks pages up by their current slug), the old URL 301s to it in one hop
// (also under the secondary locale prefix), and menu links follow.

type Row = Record<string, unknown>;

function writable(rows: Row[]) {
  const t = table(rows);
  const byWhere = (where: Row) => rows.filter((r) => r.id === where.id);
  return {
    ...t,
    update: jest.fn((args: { where: Row; data: Row }) => {
      const row = byWhere(args.where)[0];
      Object.assign(row, args.data);
      return Promise.resolve({ ...row });
    }),
  };
}

function fakeDb() {
  const page: Row = {
    id: 'p1',
    store_id: 's1',
    type: 'STATIC',
    slug: 'om-oss',
    status: 'PUBLISHED',
    published_version_id: 'v1',
    published_version: {
      id: 'v1',
      snapshot: { page: { slug: 'om-oss' }, sections: [] },
      published_at: new Date(0),
    },
    translations: [],
  };
  const menuItems: Row[] = [
    {
      id: 'm1',
      kind: 'PAGE',
      resource_id: 'p1',
      url: '/om-oss',
      menu: { store_id: 's1' },
    },
    {
      id: 'm2',
      kind: 'CUSTOM',
      resource_id: null,
      url: '/om-oss',
      menu: { store_id: 's1' },
    },
  ];
  const redirects: Row[] = [];
  const store = {
    ...storeRow('s1', 'c1', 'sv'),
    slug: 'namez',
    is_active: true,
  };

  const redirectTable = table(redirects);
  const storeRedirect = {
    ...redirectTable,
    createMany: jest.fn((args: { data: Row[] }) => {
      for (const d of args.data)
        redirects.push({ id: `r${redirects.length + 1}`, ...d });
      return Promise.resolve({ count: args.data.length });
    }),
    update: jest.fn((args: { where: Row; data: Row }) => {
      const row = redirects.find((r) => r.id === args.where.id)!;
      Object.assign(row, args.data);
      return Promise.resolve(row);
    }),
    updateMany: jest.fn(async (args: { where: Row; data: Row }) => {
      const hits = await redirectTable.findMany({ where: args.where });
      for (const h of hits)
        Object.assign(redirects.find((r) => r.id === h.id)!, args.data);
      return { count: hits.length };
    }),
  };

  const prisma: Row = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    store: table([store]),
    page: writable([page]),
    pageTranslation: {
      findMany: jest.fn(() => Promise.resolve([])),
      upsert: jest.fn(),
    },
    staticPage: table([]),
    menuItem: writable(menuItems),
    storeRedirect,
    storeLanguageConfig: {
      findUnique: jest.fn(() =>
        Promise.resolve({ primary_locale: 'sv', secondary_locales: ['en'] }),
      ),
    },
    market: { findMany: jest.fn(() => Promise.resolve([])) },
  };
  prisma.$transaction = jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
    fn(prisma),
  );
  return { prisma, page, menuItems, redirects };
}

function services(prisma: Row) {
  const db = prisma as unknown as PrismaService;
  const revalidation = { revalidateStoreById: jest.fn() };
  const redirects = new RedirectsService(db);
  const pages = new PagesV2Service(
    db,
    revalidation as unknown as RevalidationService,
    redirects,
  );
  (pages as unknown as Row).assertPageBelongsToStore = jest.fn(() =>
    Promise.resolve(),
  );
  // getPublishedPage only reads `this.prisma`.
  const storefront = Object.create(
    StorefrontService.prototype,
  ) as StorefrontService;
  (storefront as unknown as Row).prisma = db;
  return { pages, redirects, storefront, revalidation };
}

describe('v2 page permalink edit (published page)', () => {
  it('serves the new slug at once, 301s the old one in one hop, relinks menus', async () => {
    const { prisma, menuItems } = fakeDb();
    const { pages, redirects, storefront, revalidation } = services(prisma);

    const updated = await pages.update('u1', 'p1', { slug: 'Om Namez' });
    expect(updated.slug).toBe('om-namez');

    // New URL serves the published snapshot without a re-publish.
    const live = await storefront.getPublishedPage('namez', {
      type: 'SLUG',
      slug: 'om-namez',
    });
    expect(live?.id).toBe('p1');
    expect(
      await storefront.getPublishedPage('namez', {
        type: 'SLUG',
        slug: 'om-oss',
      }),
    ).toBeNull();

    // Old URL: one 301 straight to the new one (and its /en/ form).
    const hop = await redirects.resolve('s1', '/om-oss');
    expect(hop).toEqual({ to: '/om-namez', status: 301 });
    expect(await redirects.resolve('s1', hop!.to)).toBeNull();
    expect(await redirects.resolve('s1', '/en/om-oss')).toEqual({
      to: '/en/om-namez',
      status: 301,
    });

    // The PAGE menu item follows; a custom link is left alone.
    expect(menuItems.find((m) => m.id === 'm1')!.url).toBe('/om-namez');
    expect(menuItems.find((m) => m.id === 'm2')!.url).toBe('/om-oss');
    expect(revalidation.revalidateStoreById).toHaveBeenCalledWith('s1');
  });

  it('renaming twice keeps every old URL one hop from the current one', async () => {
    const { prisma } = fakeDb();
    const { pages, redirects } = services(prisma);
    await pages.update('u1', 'p1', { slug: 'om-namez' });
    await pages.update('u1', 'p1', { slug: 'vilka-vi-ar' });
    expect(await redirects.resolve('s1', '/om-oss')).toEqual({
      to: '/vilka-vi-ar',
      status: 301,
    });
    expect(await redirects.resolve('s1', '/om-namez')).toEqual({
      to: '/vilka-vi-ar',
      status: 301,
    });
  });

  it('a rename back to the old slug switches off the redirect that would shadow it', async () => {
    const { prisma, redirects: rows } = fakeDb();
    const { pages, redirects } = services(prisma);
    await pages.update('u1', 'p1', { slug: 'om-namez' });
    await pages.update('u1', 'p1', { slug: 'om-oss' });
    expect(await redirects.resolve('s1', '/om-oss')).toBeNull();
    expect(await redirects.resolve('s1', '/om-namez')).toEqual({
      to: '/om-oss',
      status: 301,
    });
    expect(rows.length).toBeGreaterThan(0);
  });
});
