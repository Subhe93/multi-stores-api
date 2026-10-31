import { StorefrontService, productBySlugQuery } from './storefront.service';

/** Exact filter of a stored NFC slug: the slug and its NFD spelling (legacy rows). */
const exact = (nfc: string) =>
  nfc === nfc.normalize('NFD')
    ? { equals: nfc }
    : { in: [nfc, nfc.normalize('NFD')] };
import { parseStorefrontPath } from './edit-hint/storefront-path';
import { walkCollectionPath } from './edit-hint/storefront-edit-target.service';

// Storefront by-slug lookups normalize the incoming slug like WP's query
// context (percent-decode, NFC, lower case) to the stored decoded form, so
// encoded (any hex case), NFD and upper-case input all match.

const VARIANTS = [
  'kl%C3%A4der', // browser / Next.js: uppercase hex
  'kl%c3%a4der', // WP permalinks: lowercase hex
  'kläder'.normalize('NFD'), // NFD (macOS / Word paste)
  'KLÄDER',
  'kläder',
];

describe('product lookup', () => {
  it.each(VARIANTS)('%s matches the stored "kläder"', (raw) => {
    expect(productBySlugQuery('c1', raw).where.translations).toEqual({
      some: { slug: exact('kläder') },
    });
    expect(productBySlugQuery('c1', raw, true).where.translations).toEqual({
      some: { slug: { equals: 'kläder', mode: 'insensitive' } },
    });
  });

  it('Arabic, encoded', () => {
    expect(
      productBySlugQuery(
        'c1',
        '%D9%87%D8%AF%D9%8A%D8%A9-%D9%84%D8%A3%D9%85%D9%8A',
      ).where.translations,
    ).toEqual({ some: { slug: exact('هدية-لأمي') } });
  });
});

describe('collection filter, legacy and v2 pages', () => {
  function service() {
    const prisma = {
      store: {
        findUnique: jest.fn(() =>
          Promise.resolve({ id: 's1', slug: 'shop', is_active: true }),
        ),
      },
      creatorCategory: {
        findFirst: jest.fn((_args: unknown) => Promise.resolve(null)),
      },
      staticPage: {
        findFirst: jest.fn((_args: unknown) => Promise.resolve(null)),
      },
      page: { findFirst: jest.fn((_args: unknown) => Promise.resolve(null)) },
    };
    const svc = Object.create(StorefrontService.prototype) as StorefrontService;
    (svc as unknown as { prisma: unknown }).prisma = prisma;
    return { svc, prisma };
  }

  it.each(VARIANTS)('?creator_category=%s', async (raw) => {
    const { svc, prisma } = service();
    await (
      svc as unknown as {
        resolveCollectionFilter: (c: string, f: object) => Promise<unknown>;
      }
    ).resolveCollectionFilter('c1', { creator_category: raw });
    expect(prisma.creatorCategory.findFirst.mock.calls[0][0]).toMatchObject({
      where: { creator_id: 'c1', slug: exact('kläder') },
    });
    // A miss retries case-insensitively (legacy slugs with capitals).
    expect(prisma.creatorCategory.findFirst.mock.calls[1][0]).toMatchObject({
      where: {
        creator_id: 'c1',
        slug: { equals: 'kläder', mode: 'insensitive' },
      },
    });
  });

  it.each(VARIANTS)('legacy page %s', async (raw) => {
    const { svc, prisma } = service();
    await svc.getPage('shop', raw).catch(() => null);
    expect(prisma.staticPage.findFirst.mock.calls[0][0]).toMatchObject({
      where: { store_id: 's1', slug: exact('kläder') },
    });
    expect(prisma.staticPage.findFirst.mock.calls[1][0]).toMatchObject({
      where: {
        store_id: 's1',
        slug: { equals: 'kläder', mode: 'insensitive' },
      },
    });
  });

  it.each(VARIANTS)('v2 page %s', async (raw) => {
    const { svc, prisma } = service();
    await svc.getPublishedPage('shop', { type: 'SLUG', slug: raw });
    expect(prisma.page.findFirst.mock.calls[0][0]).toMatchObject({
      where: { slug: exact('kläder') },
    });
    expect(prisma.page.findFirst.mock.calls[1][0]).toMatchObject({
      where: { slug: { equals: 'kläder', mode: 'insensitive' } },
    });
  });
});

describe('edit-hint storefront path resolver', () => {
  it('decodes, NFCs and lower-cases product, page and collection segments', () => {
    expect(parseStorefrontPath('/sv/products/KL%C3%A4DER')).toEqual({
      kind: 'product',
      slug: 'kläder',
    });
    expect(parseStorefrontPath(`/${'kläder'.normalize('NFD')}`)).toEqual({
      kind: 'page',
      slug: 'kläder',
    });
    expect(
      parseStorefrontPath('/collections/G%C3%85VOR/%d9%87%d8%af%d9%8a%d8%a9'),
    ).toEqual({ kind: 'collection', path: ['gåvor', 'هدية'] });
  });

  it('walks the collection tree in the stored form on both sides', () => {
    const tree = [
      {
        id: 'a',
        slug: 'gåvor',
        children: [{ id: 'b', slug: 'kläder'.normalize('NFD'), children: [] }],
      },
    ];
    expect(walkCollectionPath(tree as never, ['gåvor', 'kläder'])?.id).toBe(
      'b',
    );
  });
});

describe('legacy stored slugs with capitals stay reachable', () => {
  /** A tiny Prisma stand-in honouring `equals` / `in` / `mode: insensitive`. */
  const matches = (stored: string, f: Record<string, unknown>) => {
    if (Array.isArray(f.in)) return (f.in as string[]).includes(stored);
    if (f.mode === 'insensitive')
      return stored.toLowerCase() === String(f.equals).toLowerCase();
    return stored === f.equals;
  };

  it('legacy page "Om-Oss" answers /om-oss (exact miss, then insensitive hit)', async () => {
    const row = { id: 'l1', slug: 'Om-Oss', status: 'PUBLISHED' };
    const findFirst = jest.fn(({ where }: { where: { slug: never } }) =>
      Promise.resolve(matches(row.slug, where.slug) ? row : null),
    );
    const svc = Object.create(StorefrontService.prototype) as StorefrontService;
    (svc as unknown as { prisma: unknown }).prisma = {
      store: {
        findUnique: jest.fn(() => Promise.resolve({ id: 's1', slug: 'shop' })),
      },
      staticPage: { findFirst },
    };
    await expect(svc.getPage('shop', 'om-oss')).resolves.toBe(row);
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('collection "Rea" answers ?creator_category=rea; an exact row wins first', async () => {
    const rows = [{ id: 'c1', slug: 'Rea', is_active: true }];
    const findFirst = jest.fn(({ where }: { where: { slug: never } }) =>
      Promise.resolve(rows.find((r) => matches(r.slug, where.slug)) ?? null),
    );
    const svc = Object.create(StorefrontService.prototype) as StorefrontService;
    (svc as unknown as { prisma: unknown }).prisma = {
      creatorCategory: { findFirst },
    };
    const resolve = (
      svc as unknown as {
        resolveCollectionFilter: (c: string, f: object) => Promise<unknown>;
      }
    ).resolveCollectionFilter.bind(svc);
    await resolve('c1', { creator_category: 'rea' });
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(await findFirst.mock.results[1].value).toEqual(rows[0]);
    findFirst.mockClear();
    rows.push({ id: 'c2', slug: 'rea', is_active: true });
    await resolve('c1', { creator_category: 'REA' });
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(await findFirst.mock.results[0].value).toEqual(rows[1]);
  });

  it('own product "Mugg" answers /products/mugg only through the insensitive query', () => {
    const slugOf = (q: ReturnType<typeof productBySlugQuery>) =>
      q.where.translations.some.slug as unknown as Record<string, unknown>;
    expect(matches('Mugg', slugOf(productBySlugQuery('c1', 'mugg')))).toBe(
      false,
    );
    expect(
      matches('Mugg', slugOf(productBySlugQuery('c1', 'mugg', true))),
    ).toBe(true);
  });
});
