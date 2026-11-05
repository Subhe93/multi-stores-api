import { RedirectsService } from './redirects.service';
import { RedirectsCreatorController } from './redirects-creator.controller';
import {
  collectionChainIsLive,
  livePathCandidate,
} from './redirect-live-content';
import type { PrismaService } from '../../prisma/prisma.service';

// Redirects are a core online-store feature: MARKETPLACE and INDEPENDENT
// stores manage them without the importer app, scoped to their own store.
// A redirect from a path that still serves published content is refused
// (REDIRECT_SHADOWS_LIVE); after the content is deleted it is accepted.

type Row = {
  id: string;
  store_id: string;
  from_path: string;
  to_path: string;
  status_code: number;
  source: 'IMPORT' | 'MANUAL' | 'SLUG_CHANGE';
  import_run_id: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

type Status = 'PUBLISHED' | 'DRAFT' | 'ARCHIVED';

interface World {
  products: { creator_id: string; status: Status; slug: string }[];
  customProducts: { creator_id: string; status: Status; slug: string }[];
  staticPages: { store_id: string; status: Status; slug: string }[];
  pages: {
    store_id: string;
    type: string;
    slug: string | null;
    published_version_id: string | null;
  }[];
  categories: {
    creator_id: string;
    id: string;
    slug: string;
    parent_id: string | null;
    is_active: boolean;
    visibility: string;
  }[];
}

const STORES = {
  mkt: { id: 'store-mkt', creator_id: 'c-mkt', store_type: 'MARKETPLACE' },
  ind: { id: 'store-ind', creator_id: 'c-ind', store_type: 'INDEPENDENT' },
} as const;
const USERS: Record<string, string> = { 'u-mkt': 'c-mkt', 'u-ind': 'c-ind' };

function setup(initial: Partial<Row>[] = [], world: Partial<World> = {}) {
  const w: World = {
    products: [],
    customProducts: [],
    staticPages: [],
    pages: [],
    categories: [],
    ...world,
  };
  let n = 0;
  let rows: Row[] = initial.map((r) => ({
    id: `r${++n}`,
    store_id: STORES.mkt.id,
    from_path: '/x',
    to_path: '/',
    status_code: 301,
    source: 'MANUAL',
    import_run_id: null,
    is_active: true,
    created_at: new Date(0),
    updated_at: new Date(1000),
    ...r,
  }));
  const match = (r: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && 'in' in v)
        return (v as { in: string[] }).in.includes(
          (r as unknown as Record<string, string>)[k],
        );
      if (k === 'OR') return true;
      return (r as unknown as Record<string, unknown>)[k] === v;
    });
  // Exact `in` pass or the case-insensitive `OR: [{ slug: { equals } }]`
  // pass of liveContentAt.
  type SlugWhere = {
    slug?: { in: string[] };
    OR?: { slug: { equals: string; mode: string } }[];
  };
  const inList = (slug: string | null, w: SlugWhere) => {
    if (!slug) return false;
    if (w.slug) return w.slug.in.includes(slug);
    return (w.OR ?? []).some(
      (o) =>
        o.slug.mode === 'insensitive' &&
        o.slug.equals.toLowerCase() === slug.toLowerCase(),
    );
  };

  const storeRedirect = {
    findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(rows.filter((r) => match(r, where))),
    ),
    findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(rows.find((r) => match(r, where)) ?? null),
    ),
    findUnique: jest.fn(
      ({
        where,
      }: {
        where: { store_id_from_path: { store_id: string; from_path: string } };
      }) =>
        Promise.resolve(
          rows.find(
            (r) =>
              r.store_id === where.store_id_from_path.store_id &&
              r.from_path === where.store_id_from_path.from_path,
          ) ?? null,
        ),
    ),
    count: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(rows.filter((r) => match(r, where)).length),
    ),
    create: jest.fn(({ data }: { data: Partial<Row> }) => {
      const r: Row = {
        id: `new${++n}`,
        store_id: '',
        from_path: '',
        to_path: '',
        status_code: 301,
        source: 'MANUAL',
        import_run_id: null,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
        ...data,
      };
      rows.push(r);
      return Promise.resolve(r);
    }),
    update: jest.fn(
      ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const r = rows.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return Promise.resolve(r);
      },
    ),
    deleteMany: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      const before = rows.length;
      rows = rows.filter((r) => !match(r, where));
      return Promise.resolve({ count: before - rows.length });
    }),
  };
  const prisma = {
    storeRedirect,
    creator: {
      findUnique: jest.fn(({ where }: { where: { user_id: string } }) => {
        const cid = USERS[where.user_id];
        const store = Object.values(STORES).find((s) => s.creator_id === cid);
        return Promise.resolve(
          cid ? { store: store ? { id: store.id } : null } : null,
        );
      }),
    },
    store: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          Object.values(STORES).find((s) => s.id === where.id) ?? null,
        ),
      ),
    },
    productTranslation: {
      findMany: jest.fn(
        ({
          where,
        }: {
          where: SlugWhere & {
            product: { creator_id: string; status: string };
          };
        }) =>
          Promise.resolve(
            w.products.filter(
              (p) =>
                inList(p.slug, where) &&
                p.creator_id === where.product.creator_id &&
                p.status === where.product.status,
            ),
          ),
      ),
    },
    customProductTranslation: {
      findMany: jest.fn(
        ({
          where,
        }: {
          where: SlugWhere & {
            custom_product: { creator_id: string; status: string };
          };
        }) =>
          Promise.resolve(
            w.customProducts.filter(
              (p) =>
                inList(p.slug, where) &&
                p.creator_id === where.custom_product.creator_id &&
                p.status === where.custom_product.status,
            ),
          ),
      ),
    },
    staticPage: {
      findMany: jest.fn(
        ({
          where,
        }: {
          where: SlugWhere & { store_id: string; status: string };
        }) =>
          Promise.resolve(
            w.staticPages.filter(
              (p) =>
                p.store_id === where.store_id &&
                p.status === where.status &&
                inList(p.slug, where),
            ),
          ),
      ),
    },
    page: {
      findMany: jest.fn(
        ({
          where,
        }: {
          where: SlugWhere & {
            store_id: string;
            type: { in: string[] };
          };
        }) =>
          Promise.resolve(
            w.pages.filter(
              (p) =>
                p.store_id === where.store_id &&
                where.type.in.includes(p.type) &&
                p.published_version_id !== null &&
                inList(p.slug, where),
            ),
          ),
      ),
    },
    creatorCategory: {
      findMany: jest.fn(({ where }: { where: { creator_id: string } }) =>
        Promise.resolve(
          w.categories.filter((c) => c.creator_id === where.creator_id),
        ),
      ),
    },
    // The interactive transaction client is the same fake (update reads
    // live content through it).
    $transaction: jest.fn(
      (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(prisma),
    ),
  };
  const svc = new RedirectsService(prisma as unknown as PrismaService);
  const ctrl = new RedirectsCreatorController(svc);
  return { svc, ctrl, prisma, world: w, rows: () => rows };
}

const shadows = (kind: string) => ({
  status: 409,
  response: { code: 'REDIRECT_SHADOWS_LIVE', kind },
});

describe('creator redirects on every store type (no importer app)', () => {
  it.each([
    ['MARKETPLACE', 'u-mkt', STORES.mkt.id],
    ['INDEPENDENT', 'u-ind', STORES.ind.id],
  ])(
    '%s creator: create, list, test, update, delete',
    async (_t, user, storeId) => {
      const { ctrl, rows } = setup();
      const created = await ctrl.create(user, {
        from_path: '/Old-Shirt',
        to_path: '/products/new-shirt',
      });
      expect(created).toMatchObject({
        from_path: '/old-shirt',
        to_path: '/products/new-shirt',
        source: 'MANUAL',
        status_code: 301,
      });
      expect(rows()[0].store_id).toBe(storeId);
      const list = await ctrl.list(user, {});
      expect(list.items.map((r) => r.id)).toEqual([created.id]);
      expect(await ctrl.test(user, { path: '/old-shirt?x=1' })).toMatchObject({
        path: '/old-shirt',
        live: null,
        match: { id: created.id },
      });
      await expect(
        ctrl.update(user, created.id, { status_code: 302 }),
      ).resolves.toMatchObject({ status_code: 302 });
      const bulk = await ctrl.bulk(user, { csv: '/a,/b\n/c,/d,302' });
      expect(bulk.created).toHaveLength(2);
      await expect(ctrl.remove(user, created.id)).resolves.toEqual({
        deleted: true,
      });
    },
  );

  it("isolation: a creator never sees or changes another store's rows", async () => {
    const { ctrl, rows } = setup([
      { id: 'mine', store_id: STORES.ind.id, from_path: '/a' },
      { id: 'theirs', store_id: STORES.mkt.id, from_path: '/b' },
    ]);
    const list = await ctrl.list('u-ind', {});
    expect(list.items.map((r) => r.id)).toEqual(['mine']);
    await expect(
      ctrl.update('u-ind', 'theirs', { to_path: '/z' }),
    ).rejects.toMatchObject({ response: { code: 'REDIRECT_NOT_FOUND' } });
    await expect(ctrl.remove('u-ind', 'theirs')).rejects.toMatchObject({
      response: { code: 'REDIRECT_NOT_FOUND' },
    });
    // The same from_path in another store is not a duplicate.
    await expect(
      ctrl.create('u-ind', { from_path: '/b', to_path: '/c' }),
    ).resolves.toMatchObject({ from_path: '/b' });
    expect(rows().find((r) => r.id === 'theirs')).toMatchObject({
      to_path: '/',
      store_id: STORES.mkt.id,
    });
    await expect(ctrl.list('u-nobody', {})).rejects.toMatchObject({
      response: { code: 'STORE_NOT_FOUND' },
    });
  });

  it('IMPORT rows stay manageable by the owner without the app: edit turns MANUAL, delete works', async () => {
    const { ctrl } = setup([
      {
        id: 'imp',
        store_id: STORES.ind.id,
        from_path: '/produkt/x',
        to_path: '/products/x',
        source: 'IMPORT',
        import_run_id: 'run1',
      },
    ]);
    const edited = await ctrl.update('u-ind', 'imp', {
      to_path: '/products/y',
    });
    expect(edited).toMatchObject({
      source: 'MANUAL',
      import_run_id: 'run1',
      to_path: '/products/y',
    });
    await expect(ctrl.remove('u-ind', 'imp')).resolves.toEqual({
      deleted: true,
    });
  });
});

describe('REDIRECT_SHADOWS_LIVE (published content at the source path)', () => {
  const world = (): Partial<World> => ({
    products: [
      { creator_id: 'c-mkt', status: 'PUBLISHED', slug: 'shirt' },
      { creator_id: 'c-mkt', status: 'DRAFT', slug: 'draft-shirt' },
      { creator_id: 'c-ind', status: 'PUBLISHED', slug: 'mössa' },
    ],
    customProducts: [
      { creator_id: 'c-mkt', status: 'PUBLISHED', slug: 'my-mug' },
      { creator_id: 'c-ind', status: 'PUBLISHED', slug: 'old-custom' },
    ],
    staticPages: [
      { store_id: STORES.mkt.id, status: 'PUBLISHED', slug: 'about' },
    ],
    pages: [
      {
        store_id: STORES.ind.id,
        type: 'LANDING',
        slug: 'summer',
        published_version_id: 'v1',
      },
      {
        store_id: STORES.ind.id,
        type: 'STATIC',
        slug: 'unpublished',
        published_version_id: null,
      },
    ],
    categories: [
      {
        creator_id: 'c-mkt',
        id: 'k1',
        slug: 'men',
        parent_id: null,
        is_active: true,
        visibility: 'PUBLIC',
      },
      {
        creator_id: 'c-mkt',
        id: 'k2',
        slug: 'shirts',
        parent_id: 'k1',
        is_active: true,
        visibility: 'PUBLIC',
      },
      {
        creator_id: 'c-mkt',
        id: 'k3',
        slug: 'tags',
        parent_id: null,
        is_active: true,
        visibility: 'INTERNAL',
      },
    ],
  });

  it('marketplace: own product, custom product, legacy page and collection chain are live', async () => {
    const { ctrl } = setup([], world());
    const create = (from_path: string) =>
      ctrl.create('u-mkt', { from_path, to_path: '/' });
    await expect(create('/products/shirt')).rejects.toMatchObject(
      shadows('product'),
    );
    await expect(create('/products/SHIRT/')).rejects.toMatchObject(
      shadows('product'),
    );
    await expect(create('/sv/products/shirt')).rejects.toMatchObject(
      shadows('product'),
    );
    await expect(create('/products/my-mug')).rejects.toMatchObject(
      shadows('product'),
    );
    await expect(create('/about')).rejects.toMatchObject(shadows('page'));
    await expect(create('/collections/men/shirts')).rejects.toMatchObject(
      shadows('collection'),
    );
    await expect(create('/collections/men')).rejects.toMatchObject(
      shadows('collection'),
    );
    // Not served: draft product, non-root collection path, INTERNAL
    // collection, another store's content, unknown paths, /legal/*.
    for (const p of [
      '/products/draft-shirt',
      '/collections/shirts',
      '/collections/tags',
      '/products/mössa',
      '/summer',
      '/legal/terms',
      '/products/shirt/reviews',
    ])
      await expect(create(p)).resolves.toMatchObject({ source: 'MANUAL' });
  });

  it('independent: own product and builder page are live; custom products are not served there', async () => {
    const { ctrl } = setup([], world());
    const create = (from_path: string) =>
      ctrl.create('u-ind', { from_path, to_path: '/' });
    await expect(create('/products/m%C3%B6ssa')).rejects.toMatchObject(
      shadows('product'),
    );
    await expect(create('/summer')).rejects.toMatchObject(shadows('page'));
    await expect(create('/products/old-custom')).resolves.toBeDefined();
    await expect(create('/unpublished')).resolves.toBeDefined();
  });

  it('after the product is deleted the same redirect is accepted (delete prompt flow)', async () => {
    const { ctrl, world: w } = setup([], world());
    const body = { from_path: '/products/shirt', to_path: '/collections/men' };
    await expect(ctrl.create('u-mkt', body)).rejects.toMatchObject(
      shadows('product'),
    );
    expect(await ctrl.test('u-mkt', { path: '/products/shirt' })).toMatchObject(
      {
        live: 'product',
        match: null,
      },
    );
    w.products = w.products.filter((p) => p.slug !== 'shirt');
    await expect(ctrl.create('u-mkt', body)).resolves.toMatchObject({
      from_path: '/products/shirt',
      to_path: '/collections/men',
    });
  });

  it('an inactive row may sit on a live path; switching it on or moving onto one is refused', async () => {
    const { ctrl } = setup(
      [
        {
          id: 'off',
          store_id: STORES.mkt.id,
          from_path: '/about',
          is_active: false,
        },
        { id: 'legacy', store_id: STORES.mkt.id, from_path: '/products/shirt' },
        { id: 'free', store_id: STORES.mkt.id, from_path: '/free' },
      ],
      world(),
    );
    await expect(
      ctrl.create('u-mkt', {
        from_path: '/products/my-mug',
        to_path: '/',
        is_active: false,
      }),
    ).resolves.toMatchObject({ is_active: false });
    await expect(
      ctrl.update('u-mkt', 'off', { is_active: true }),
    ).rejects.toMatchObject(shadows('page'));
    await expect(
      ctrl.update('u-mkt', 'free', { from_path: '/about' }),
    ).rejects.toMatchObject(shadows('page'));
    // A row that already shadows content (written before this check) can
    // still get a new target.
    await expect(
      ctrl.update('u-mkt', 'legacy', { to_path: '/collections/men' }),
    ).resolves.toMatchObject({ to_path: '/collections/men' });
  });

  it('bulk reports live sources per line and writes the rest', async () => {
    const { ctrl } = setup([], world());
    const res = await ctrl.bulk('u-mkt', {
      csv: '/products/shirt,/\n/old,/products/shirt\n/about,/',
    });
    expect(res.created.map((c) => c.line)).toEqual([2]);
    expect(res.conflicts).toEqual([
      {
        line: 1,
        from_path: '/products/shirt',
        to_path: '/',
        code: 'REDIRECT_SHADOWS_LIVE',
      },
      {
        line: 3,
        from_path: '/about',
        to_path: '/',
        code: 'REDIRECT_SHADOWS_LIVE',
      },
    ]);
  });
});

describe('live check details', () => {
  it('legacy capitalised slugs count as live (case-insensitive pass)', async () => {
    const { ctrl, prisma } = setup([], {
      products: [
        { creator_id: 'c-mkt', status: 'PUBLISHED', slug: 'Old-Shirt' },
      ],
      staticPages: [
        { store_id: STORES.mkt.id, status: 'PUBLISHED', slug: 'About-Us' },
      ],
    });
    const create = (from_path: string) =>
      ctrl.create('u-mkt', { from_path, to_path: '/' });
    await expect(create('/products/old-shirt')).rejects.toMatchObject(
      shadows('product'),
    );
    await expect(create('/de/products/OLD-SHIRT')).rejects.toMatchObject(
      shadows('product'),
    );
    await expect(create('/about-us')).rejects.toMatchObject(shadows('page'));
    const calls = prisma.productTranslation.findMany.mock.calls.map(
      (c) => c[0].where,
    );
    expect(calls[0]).toHaveProperty('slug.in');
    expect(calls[1]).toMatchObject({
      OR: [{ slug: { equals: 'old-shirt', mode: 'insensitive' } }],
    });
    // A prefix of a longer slug is not a match.
    await expect(create('/products/old')).resolves.toBeDefined();
  });

  it('an exact hit skips the case-insensitive pass', async () => {
    const { ctrl, prisma } = setup([], {
      products: [{ creator_id: 'c-mkt', status: 'PUBLISHED', slug: 'shirt' }],
    });
    await expect(
      ctrl.create('u-mkt', { from_path: '/products/shirt', to_path: '/' }),
    ).rejects.toMatchObject(shadows('product'));
    expect(prisma.productTranslation.findMany).toHaveBeenCalledTimes(1);
  });

  it('bulk with no rows returns before opening a transaction', async () => {
    const { ctrl, prisma } = setup();
    await expect(ctrl.bulk('u-mkt', { csv: '' })).resolves.toEqual({
      created: [],
      conflicts: [],
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.store.findUnique).not.toHaveBeenCalled();
  });

  it('update reads live content through the transaction client', async () => {
    const { ctrl, prisma } = setup(
      [{ id: 'free', store_id: STORES.mkt.id, from_path: '/free' }],
      {
        staticPages: [
          { store_id: STORES.mkt.id, status: 'PUBLISHED', slug: 'about' },
        ],
      },
    );
    const txStore = {
      findUnique: jest.fn(prisma.store.findUnique.getMockImplementation()),
    };
    prisma.$transaction.mockImplementationOnce(
      (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ ...prisma, store: txStore }),
    );
    const storeCalls = prisma.store.findUnique.mock.calls.length;
    await expect(
      ctrl.update('u-mkt', 'free', { from_path: '/about' }),
    ).rejects.toMatchObject(shadows('page'));
    expect(txStore.findUnique).toHaveBeenCalled();
    expect(prisma.store.findUnique.mock.calls.length).toBe(storeCalls);
  });
});

describe('redirect-live-content helpers', () => {
  it('livePathCandidate maps URL shapes (locale prefix stripped)', () => {
    expect(livePathCandidate('/products/x')).toEqual({
      kind: 'product',
      slug: 'x',
    });
    expect(livePathCandidate('/de/products/x')).toEqual({
      kind: 'product',
      slug: 'x',
    });
    expect(livePathCandidate('/collections/a/b')).toEqual({
      kind: 'collection',
      segments: ['a', 'b'],
    });
    expect(livePathCandidate('/about')).toEqual({
      kind: 'page',
      slug: 'about',
    });
    expect(livePathCandidate('/sv/about')).toEqual({
      kind: 'page',
      slug: 'about',
    });
    for (const p of [
      '/',
      '/?p=12',
      '/products',
      '/collections',
      '/legal/terms',
      '/a/b',
    ])
      expect(livePathCandidate(p)).toBeNull();
  });

  it('collectionChainIsLive needs a full active PUBLIC chain from a root', () => {
    const rows = [
      {
        id: '1',
        slug: 'a',
        parent_id: null,
        is_active: true,
        visibility: 'PUBLIC',
      },
      {
        id: '2',
        slug: 'b',
        parent_id: '1',
        is_active: false,
        visibility: 'PUBLIC',
      },
    ];
    expect(collectionChainIsLive(rows, ['a'])).toBe(true);
    expect(collectionChainIsLive(rows, ['a', 'b'])).toBe(false);
    expect(collectionChainIsLive(rows, ['b'])).toBe(false);
    expect(collectionChainIsLive(rows, [])).toBe(false);
  });
});
