import { PagesV2Service } from './pages-v2.service';
import { PagesService } from '../pages/pages.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';
import type { RedirectsService } from '../redirects/redirects.service';
import { storeRow, table } from '../../common/slug/__fixtures__/fake-slug-db';

// Root pages (v2 STATIC/LANDING and legacy StaticPage, served at `/<slug>`):
// WP page slugs, reserved / numeric / locale slugs suffixed instead of 400,
// duplicates suffixed instead of 409, old-slug 301 for a live page.

type Row = Record<string, unknown>;

function db(opts: { v2?: Row[]; legacy?: Row[]; locale?: string }) {
  const v2 = opts.v2 ?? [];
  const legacy = opts.legacy ?? [];
  const pageTable = table(v2);
  const staticTable = table(legacy);
  const pageCreate = jest.fn((args: { data: Row }) =>
    Promise.resolve({ id: 'new', ...args.data }),
  );
  const pageUpdate = jest.fn((args: { where: { id: string }; data: Row }) => {
    const row = v2.find((r) => r.id === args.where.id)!;
    Object.assign(row, args.data);
    return Promise.resolve(row);
  });
  const staticUpdate = jest.fn((args: { where: { id: string }; data: Row }) => {
    const row = legacy.find((r) => r.id === args.where.id)!;
    Object.assign(row, args.data);
    return Promise.resolve(row);
  });
  const page = { ...pageTable, create: pageCreate, update: pageUpdate };
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    store: table([storeRow('s1', 'c1', opts.locale ?? 'sv')]),
    page,
    pageTranslation: {
      findMany: jest.fn(() => Promise.resolve([])),
      upsert: jest.fn(),
    },
    staticPage: {
      ...staticTable,
      create: jest.fn((args: { data: Row }) =>
        Promise.resolve({ id: 'new', ...args.data }),
      ),
      update: staticUpdate,
    },
    staticPageTranslation: {
      findMany: jest.fn(() => Promise.resolve([])),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) =>
      fn({ page, pageTranslation: { upsert: jest.fn() } }),
    ),
  };
  const redirects = {
    applySlugChangeRedirects: jest.fn(() => Promise.resolve(null)),
    releaseLivePaths: jest.fn(() => Promise.resolve(0)),
  };
  return { prisma, redirects, pageCreate };
}

function v2Service(d: ReturnType<typeof db>) {
  const svc = new PagesV2Service(
    d.prisma as unknown as PrismaService,
    { revalidateStoreById: jest.fn() } as unknown as RevalidationService,
    d.redirects as unknown as RedirectsService,
  );
  (svc as unknown as Record<string, unknown>).assertPageBelongsToStore =
    jest.fn(() => Promise.resolve());
  return svc;
}

describe('PagesV2Service WP slugs', () => {
  it.each([
    ['cart', 'cart-2'],
    ['Checkout', 'checkout-2'],
    ['sv', 'sv-2'],
    ['2024', '2024-2'],
    ['feed', 'feed-2'],
    ['Om oss', 'om-oss-2'], // taken by another v2 page (was 409)
    ['Kläder', 'klader'],
    ['هدية لأمي', 'هدية-لأمي'],
  ])('create %s -> %s', async (slug, out) => {
    const d = db({ v2: [{ id: 'p0', store_id: 's1', slug: 'om-oss' }] });
    await v2Service(d).create('u', { type: 'LANDING', slug } as never);
    expect(d.pageCreate.mock.calls[0][0].data.slug).toBe(out);
  });

  it('create without a slug derives it from the title', async () => {
    const d = db({});
    await v2Service(d).create('u', {
      type: 'LANDING',
      translations: [{ locale: 'sv', title: 'Present till svärfar' }],
    } as never);
    expect(d.pageCreate.mock.calls[0][0].data.slug).toBe(
      'present-till-svarfar',
    );
  });

  it('update: a live page that moves leaves a 301; an unchanged slug is kept', async () => {
    const row = {
      id: 'p1',
      store_id: 's1',
      slug: 'straße',
      type: 'LANDING',
      published_version_id: 'v1',
    };
    const d = db({ v2: [row] });
    const svc = v2Service(d);
    await svc.update('u', 'p1', { slug: 'straße' } as never);
    expect(row.slug).toBe('straße');
    expect(d.redirects.applySlugChangeRedirects).not.toHaveBeenCalled();

    await svc.update('u', 'p1', { slug: 'Ny sida' } as never);
    expect(row.slug).toBe('ny-sida');
    expect(d.redirects.applySlugChangeRedirects).toHaveBeenCalledWith(
      's1',
      [{ from: '/stra%c3%9fe', to: '/ny-sida' }],
      undefined,
      { localePrefixes: true },
    );
  });

  it('update: no 301 when a legacy page still serves the old path', async () => {
    const row = {
      id: 'p1',
      store_id: 's1',
      slug: 'about',
      type: 'STATIC',
      published_version_id: 'v1',
    };
    const d = db({
      v2: [row],
      legacy: [
        { id: 'l1', store_id: 's1', slug: 'about', status: 'PUBLISHED' },
      ],
    });
    await v2Service(d).update('u', 'p1', { slug: 'om' } as never);
    expect(row.slug).toBe('om');
    expect(d.redirects.applySlugChangeRedirects).not.toHaveBeenCalled();
  });
});

describe('PagesService (legacy) WP slugs', () => {
  function legacyService(d: ReturnType<typeof db>) {
    const svc = new PagesService(
      d.prisma as unknown as PrismaService,
      d.redirects as unknown as RedirectsService,
    );
    return svc;
  }

  it('create: sanitized, avoids v2 and legacy slugs and reserved ones', async () => {
    const d = db({
      v2: [{ id: 'p0', store_id: 's1', slug: 'om-oss' }],
      legacy: [{ id: 'l0', store_id: 's1', slug: 'faq' }],
    });
    const svc = legacyService(d);
    for (const slug of ['Om oss', 'FAQ', 'account', 'Kläder']) {
      await svc.create(
        's1',
        { type: 'CUSTOM', slug } as never,
        'a',
        'ADMIN' as never,
      );
    }
    expect(
      d.prisma.staticPage.create.mock.calls.map((c) => c[0].data.slug),
    ).toEqual(['om-oss-2', 'faq-2', 'account-2', 'klader']);
  });

  it('update: published page rename writes the 301; a draft does not', async () => {
    const pub = {
      id: 'l1',
      store_id: 's1',
      slug: 'villkor',
      status: 'PUBLISHED',
    };
    const draft = { id: 'l2', store_id: 's1', slug: 'utkast', status: 'DRAFT' };
    const d = db({ legacy: [pub, draft] });
    const svc = legacyService(d);
    await svc.update('l1', { slug: 'Köpvillkor' }, 'a', 'ADMIN' as never);
    expect(pub.slug).toBe('kopvillkor');
    expect(d.redirects.applySlugChangeRedirects).toHaveBeenCalledWith(
      's1',
      [{ from: '/villkor', to: '/kopvillkor' }],
      undefined,
      { localePrefixes: true },
    );
    d.redirects.applySlugChangeRedirects.mockClear();
    await svc.update('l2', { slug: 'nytt' }, 'a', 'ADMIN' as never);
    expect(draft.slug).toBe('nytt');
    expect(d.redirects.applySlugChangeRedirects).not.toHaveBeenCalled();
  });
});
