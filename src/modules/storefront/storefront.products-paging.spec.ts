import { StoreStatus, StoreType } from '@prisma/client';
import {
  CARD_CONFIG,
  MARKET,
  buildList,
  ids,
  type ListFixture,
} from './__fixtures__/product-list-fake';

// GET /storefront/:slug/products: `limit`, opt-in pagination (`page`) and
// server sorting. A request without `page` and `limit` is the documented
// full list and must stay byte-identical.

const CC = '11111111-1111-1111-1111-111111111111';

/** Rich catalogue: own + custom, ties, advanced option config, promos. */
function rich(over: Partial<ListFixture> = {}): ListFixture {
  return {
    own: [
      {
        id: 'p-a',
        created: '2026-10-05T10:00:00Z',
        price: 300,
        links: [CC],
        overrideIn: ['m-eu'],
      },
      {
        id: 'p-b',
        created: '2026-10-04T10:00:00Z',
        price: 120,
        optionConfig: CARD_CONFIG,
        links: [CC],
      },
      // Two rows with the same created_at (fixture = physical order).
      {
        id: 'p-d',
        created: '2026-10-03T10:00:00Z',
        price: 80,
        taxExempt: true,
      },
      { id: 'p-c', created: '2026-10-03T10:00:00Z', price: 80, links: [CC] },
      {
        id: 'p-hidden',
        created: '2026-10-02T10:00:00Z',
        price: 50,
        hiddenIn: ['m-eu'],
        links: [CC],
      },
    ],
    custom: [
      { id: 'cp-a', created: '2026-10-06T10:00:00Z', price: 210, links: [CC] },
      {
        id: 'cp-b',
        created: '2026-10-03T10:00:00Z',
        price: 0,
        pricing: 'PER_VARIANT',
        links: [CC],
      },
      {
        id: 'cp-c',
        created: '2026-09-01T10:00:00Z',
        price: 0,
        pricing: 'MARGIN',
      },
    ],
    collection: {
      id: CC,
      match_rule: 'MANUAL',
      order: {
        'p:p-c': 0,
        'cp:cp-b': 1,
        'p:p-a': 2,
        'cp:cp-a': 3,
        'p:p-hidden': 4,
      },
    },
    promotions: [
      { id: 'promo-all', type: 'PERCENTAGE', value: 10 },
      {
        id: 'promo-one',
        type: 'FIXED',
        value: 5,
        product_ids: ['p-b', 'cp-a'],
      },
    ],
    personalization: false,
    ...over,
  };
}

describe('all mode (no page, no limit) is unchanged', () => {
  const variants: [string, Partial<ListFixture>, Record<string, unknown>][] =
    [];
  for (const market of [null, MARKET])
    for (const b2b of [false, true])
      for (const withCollection of [false, true])
        variants.push([
          `market ${market ? 'on' : 'off'}, b2b ${b2b ? 'on' : 'off'}, ${withCollection ? 'MANUAL collection' : 'no collection'}`,
          { market, b2b },
          withCollection ? { creator_category: 'c' } : {},
        ]);
  variants.push(['personalization app on', { personalization: true }, {}]);
  variants.push([
    'independent store',
    { storeType: StoreType.INDEPENDENT },
    {},
  ]);
  variants.push(['search', {}, { search: 'title p-', locale: 'sv' }]);

  it.each(variants)('golden bytes: %s', async (_name, over, filters) => {
    const { service, prisma } = buildList(rich(over));
    const list = await service.getProducts('shop', filters);
    expect(JSON.stringify(list)).toMatchSnapshot();
    // Same Prisma calls: one full read per source, newest first, no
    // window, no count, no tie-breaker.
    expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
    const ownArgs = prisma.product.findMany.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(ownArgs.orderBy).toEqual({ created_at: 'desc' });
    expect(ownArgs).not.toHaveProperty('take');
    expect(ownArgs).not.toHaveProperty('skip');
    expect(ownArgs).not.toHaveProperty('select');
    expect(prisma.product.count).not.toHaveBeenCalled();
    expect(prisma.customProduct.count).not.toHaveBeenCalled();
    expect(
      JSON.stringify(prisma.product.findMany.mock.calls),
    ).toMatchSnapshot();
    expect(
      JSON.stringify(prisma.customProduct.findMany.mock.calls),
    ).toMatchSnapshot();
  });
});

// ── limit and page ────────────────────────────────────────

const TAG = '22222222-2222-2222-2222-222222222222';
const at = (hour: number) =>
  new Date(Date.UTC(2026, 9, 1) + hour * 3600e3).toISOString();

/**
 * Distinct dates, own and custom interleaved by date, varied prices and
 * titles, one product hidden in the market, card config, a tax-exempt row.
 */
function distinct(over: Partial<ListFixture> = {}): ListFixture {
  return {
    own: [
      {
        id: 'p-01',
        created: at(20),
        price: 90,
        title: 'Gamma',
        links: [CC, TAG],
      },
      {
        id: 'p-02',
        created: at(16),
        price: 15,
        title: 'alfa',
        links: [CC],
        optionConfig: CARD_CONFIG,
      },
      {
        id: 'p-03',
        created: at(12),
        price: 40,
        title: 'Beta 10',
        links: [TAG],
        taxExempt: true,
      },
      {
        id: 'p-04',
        created: at(8),
        price: 40,
        title: 'Beta 9',
        links: [CC],
        overrideIn: ['m-eu'],
      },
      {
        id: 'p-05',
        created: at(6),
        price: 70,
        title: 'Delta',
        hiddenIn: ['m-eu'],
        links: [CC, TAG],
      },
      { id: 'p-06', created: at(2), price: 5, title: 'Ångström' },
      { id: 'p-07', created: at(1), price: 60, title: 'epsilon', links: [CC] },
    ],
    custom: [
      {
        id: 'cp-01',
        created: at(22),
        price: 45,
        title: 'Zeta',
        links: [CC, TAG],
      },
      {
        id: 'cp-02',
        created: at(14),
        price: 0,
        title: 'Beta 2',
        pricing: 'PER_VARIANT',
        links: [CC],
      },
      { id: 'cp-03', created: at(10), price: 25, title: 'kappa', links: [TAG] },
      {
        id: 'cp-04',
        created: at(4),
        price: 0,
        title: 'Iota',
        pricing: 'MARGIN',
        links: [CC],
      },
      { id: 'cp-05', created: at(0), price: 99, title: 'Eta' },
    ],
    collection: {
      id: CC,
      match_rule: 'MANUAL',
      order: {
        'cp:cp-04': 0,
        'p:p-07': 1,
        'cp:cp-02': 2,
        'p:p-04': 3,
        'p:p-01': 4,
        'cp:cp-01': 5,
        'p:p-05': 6,
        'p:p-02': 7,
      },
    },
    promotions: [
      { id: 'promo-all', type: 'PERCENTAGE', value: 10 },
      {
        id: 'promo-one',
        type: 'FIXED',
        value: 5,
        product_ids: ['p-02', 'cp-03'],
      },
    ],
    personalization: false,
    ...over,
  };
}

const TAGS_COLLECTION = {
  id: CC,
  match_rule: 'TAGS' as const,
  match_tags: [TAG],
};

type Filters = Record<string, unknown>;
type Item = Record<string, unknown> & { id: string };
type Page = {
  items: Item[];
  total: number;
  page: number;
  limit: number;
  has_more: boolean;
};
type Service = ReturnType<typeof buildList>['service'];
const json = (v: unknown) => JSON.stringify(v);
/** Raw query values, as the controller passes them. */
const get = (service: Service, filters: Filters, viewer?: unknown) =>
  service.getProducts(
    'shop',
    filters as never,
    undefined,
    undefined,
    viewer as never,
  );
const getPage = async (service: Service, filters: Filters) =>
  (await get(service, filters)) as unknown as Page;

const SCENARIOS: [string, Partial<ListFixture>, Filters][] = [
  ['no collection', {}, {}],
  [
    'TAGS collection',
    { collection: TAGS_COLLECTION },
    { creator_category: 'c' },
  ],
  [
    'MANUAL collection (own and custom interleaved)',
    {},
    { creator_category_id: CC },
  ],
  ['search', {}, { search: 'beta' }],
  ['market + b2b on', { market: MARKET, b2b: true }, {}],
  [
    'market + b2b on, MANUAL collection',
    { market: MARKET, b2b: true },
    { creator_category: 'c' },
  ],
  ['independent store', { storeType: StoreType.INDEPENDENT }, {}],
];

describe('limit mode: the first N of the full list', () => {
  it.each(SCENARIOS)('%s', async (_name, over, filters) => {
    const { service } = buildList(distinct(over));
    const all = (await get(service, filters)) as Item[];
    expect(all.length).toBeGreaterThan(2);
    for (const limit of [1, 2, 3, 5, all.length, all.length + 3]) {
      const list = await get(service, { ...filters, limit });
      expect(Array.isArray(list)).toBe(true);
      // Byte-identical items, same order.
      expect(json(list)).toBe(json(all.slice(0, limit)));
    }
  });

  it('reads at most N keys per source and hydrates at most N rows', async () => {
    const { service, prisma } = buildList(distinct());
    await get(service, { limit: 3 });
    const [ownKeys, ownRows] = prisma.product.findMany.mock.calls.map(
      (c) => c[0] as unknown as Record<string, unknown>,
    );
    expect(ownKeys).toMatchObject({
      select: { id: true, created_at: true, base_price: true },
      orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
      take: 3,
    });
    expect(ownRows).toMatchObject({
      where: {
        AND: [expect.anything(), { id: { in: ['p-01', 'p-02', 'p-03'] } }],
      },
    });
    expect(prisma.customProduct.findMany.mock.calls[0][0]).toMatchObject({
      orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
      take: 3,
    });
    // No custom row in the window: no custom row is hydrated.
    expect(prisma.customProduct.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.product.count).not.toHaveBeenCalled();
  });

  it('a MANUAL collection scans light keys only and hydrates the window', async () => {
    const { service, prisma } = buildList(distinct());
    await get(service, { creator_category_id: CC, limit: 2 });
    const calls = prisma.product.findMany.mock.calls.map(
      (c) => c[0] as unknown as Record<string, unknown>,
    );
    expect(calls[0].select).toEqual({
      id: true,
      created_at: true,
      base_price: true,
    });
    expect(calls[0]).not.toHaveProperty('take');
    expect(calls[0]).not.toHaveProperty('orderBy');
    expect(calls[1]).toMatchObject({
      where: { AND: [expect.anything(), { id: { in: ['p-07'] } }] },
    });
    expect(prisma.customProduct.findMany.mock.calls[1][0]).toMatchObject({
      where: { AND: [expect.anything(), { id: { in: ['cp-04'] } }] },
    });
  });
});

describe('ties on created_at', () => {
  const tied: ListFixture = {
    own: [
      { id: 'p-z', created: at(5) },
      { id: 'p-a', created: at(5) },
      { id: 'p-m', created: at(5) },
    ],
    custom: [],
  };

  it('the full list keeps the database order; windowed modes order ties by id', async () => {
    const { service } = buildList(tied);
    expect(ids(await get(service, {}))).toEqual(['p-z', 'p-a', 'p-m']);
    expect(ids(await get(service, { limit: 3 }))).toEqual([
      'p-a',
      'p-m',
      'p-z',
    ]);
    expect(ids(await get(service, { limit: 1 }))).toEqual(['p-a']);
  });
});

describe('paged mode: stable pages without duplicates or gaps', () => {
  const day = '2026-10-01T10:00:00Z';
  const flat: ListFixture = {
    own: ['p-g', 'p-c', 'p-e', 'p-a', 'p-f', 'p-b', 'p-d'].map((id) => ({
      id,
      created: day,
      price: 50,
      title: 'Same',
      links: [CC],
    })),
    custom: ['cp-f', 'cp-b', 'cp-d', 'cp-a', 'cp-e', 'cp-c'].map((id) => ({
      id,
      created: day,
      price: 50,
      title: 'Same',
      links: [CC],
    })),
    collection: { id: CC, match_rule: 'MANUAL', order: {} },
  };
  const expected = [
    'p-a',
    'p-b',
    'p-c',
    'p-d',
    'p-e',
    'p-f',
    'p-g',
    'cp-a',
    'cp-b',
    'cp-c',
    'cp-d',
    'cp-e',
    'cp-f',
  ];

  it.each<[string, Filters]>([
    ['default', {}],
    ['newest', { sort: 'newest' }],
    ['price_asc', { sort: 'price_asc' }],
    ['price_desc', { sort: 'price_desc' }],
    ['name', { sort: 'name', locale: 'sv' }],
    ['MANUAL collection default', { creator_category_id: CC }],
  ])(
    '%s: pages of 4 concatenate to the 13 ids in order',
    async (_n, filters) => {
      const { service } = buildList(flat);
      const seen: string[] = [];
      for (let page = 1; page <= 5; page++) {
        const res = await getPage(service, { ...filters, page, limit: 4 });
        expect(res).toMatchObject({
          total: 13,
          page,
          limit: 4,
          has_more: page < 4,
        });
        seen.push(...ids(res.items));
        if (page === 5) expect(res.items).toEqual([]);
      }
      expect(seen).toEqual(expected);
    },
  );

  it('price: stored amount, own and custom merged, then newest', async () => {
    const { service } = buildList(distinct());
    const asc = await getPage(service, {
      page: 1,
      limit: 100,
      sort: 'price_asc',
    });
    // Stored amounts: cp-02 / cp-04 are PER_VARIANT / MARGIN with
    // final_price 0 (not the price shown), p-06 5, p-02 15, cp-03 25, ...
    expect(ids(asc.items)).toEqual([
      'cp-02',
      'cp-04',
      'p-06',
      'p-02',
      'cp-03',
      'p-03',
      'p-04',
      'cp-01',
      'p-07',
      'p-05',
      'p-01',
      'cp-05',
    ]);
    const desc = await getPage(service, {
      page: 1,
      limit: 100,
      sort: 'price_desc',
    });
    expect(ids(desc.items)).toEqual([
      'cp-05',
      'p-01',
      'p-05',
      'p-07',
      'cp-01',
      'p-03',
      'p-04',
      'cp-03',
      'p-02',
      'p-06',
      'cp-02',
      'cp-04',
    ]);
    // Small pages walk the same order.
    const walked: string[] = [];
    for (let page = 1; page <= 3; page++) {
      walked.push(
        ...ids(
          (await getPage(service, { page, limit: 5, sort: 'price_asc' })).items,
        ),
      );
    }
    expect(walked).toEqual(ids(asc.items));
  });

  it('name: locale collation, numeric', async () => {
    const { service } = buildList(distinct());
    const sv = await getPage(service, {
      page: 1,
      limit: 100,
      sort: 'name',
      locale: 'sv',
    });
    // Swedish: "Å" sorts after "Z"; "Beta 9" before "Beta 10".
    expect(ids(sv.items)).toEqual([
      'p-02',
      'cp-02',
      'p-04',
      'p-03',
      'p-05',
      'p-07',
      'cp-05',
      'p-01',
      'cp-04',
      'cp-03',
      'cp-01',
      'p-06',
    ]);
    const limited = await get(service, {
      limit: 3,
      sort: 'name',
      locale: 'sv',
    });
    expect(ids(limited)).toEqual(['p-02', 'cp-02', 'p-04']);
  });

  it('newest merges own and custom by date', async () => {
    const { service } = buildList(distinct());
    expect(ids(await get(service, { limit: 4, sort: 'newest' }))).toEqual([
      'cp-01',
      'p-01',
      'p-02',
      'cp-02',
    ]);
  });

  it('an explicit sort overrides the MANUAL order', async () => {
    const { service } = buildList(distinct());
    const res = await getPage(service, {
      creator_category_id: CC,
      page: 1,
      limit: 3,
      sort: 'newest',
    });
    expect(ids(res.items)).toEqual(['cp-01', 'p-01', 'p-02']);
    expect(res.total).toBe(8);
  });
});

describe('paged mode: total and has_more', () => {
  it.each(SCENARIOS)(
    '%s: total is the full list length',
    async (_name, over, filters) => {
      const { service } = buildList(distinct(over));
      const all = (await get(service, filters)) as Item[];
      const first = await getPage(service, { ...filters, page: 1, limit: 2 });
      expect(first.total).toBe(all.length);
      expect(first.has_more).toBe(all.length > 2);
      expect(json(first.items)).toBe(json(all.slice(0, 2)));
      const last = Math.ceil(all.length / 2);
      const end = await getPage(service, { ...filters, page: last, limit: 2 });
      expect(end.has_more).toBe(false);
      expect(json(end.items)).toBe(json(all.slice((last - 1) * 2, last * 2)));
    },
  );

  it('independent store: custom products are never queried nor counted', async () => {
    const { service, prisma } = buildList(
      distinct({ storeType: StoreType.INDEPENDENT }),
    );
    const res = await getPage(service, { page: 1, limit: 3 });
    expect(res.total).toBe(7);
    expect(prisma.customProduct.findMany).not.toHaveBeenCalled();
    expect(prisma.customProduct.count).not.toHaveBeenCalled();
    expect(prisma.product.count).toHaveBeenCalledTimes(1);
  });

  it('marketplace with search and a market: counts use the list where', async () => {
    const { service, prisma } = buildList(distinct({ market: MARKET }));
    const res = await getPage(service, { page: 1, limit: 3, search: 'beta' });
    // Beta 10, Beta 9 (own), Beta 2 (custom).
    expect(res.total).toBe(3);
    expect(res.has_more).toBe(false);
    const whereOf = (m: jest.Mock) =>
      (m.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
    expect(whereOf(prisma.product.count)).toHaveProperty('NOT');
    expect(whereOf(prisma.product.count)).toHaveProperty('translations');
    expect(whereOf(prisma.customProduct.count)).toHaveProperty('translations');
  });

  it('market filter: a product hidden in the market is not counted', async () => {
    const off = await getPage(buildList(distinct()).service, { page: 1 });
    const on = await getPage(buildList(distinct({ market: MARKET })).service, {
      page: 1,
    });
    expect(off.total).toBe(12);
    expect(on.total).toBe(11);
    expect(ids(on.items)).not.toContain('p-05');
  });
});

describe('normalisation and caps', () => {
  const many: ListFixture = {
    own: Array.from({ length: 120 }, (_, i) => ({
      id: `p-${String(i).padStart(3, '0')}`,
      created: at(500 - i),
    })),
    custom: [],
  };

  it('limit=1000 serves 100; page=abc is page 1; the page size defaults to 24; page caps at 1000', async () => {
    const { service } = buildList(many);
    expect(await get(service, { limit: '1000' })).toHaveLength(100);
    const abc = await getPage(service, { page: 'abc', limit: '10' });
    expect(abc).toMatchObject({
      page: 1,
      limit: 10,
      total: 120,
      has_more: true,
    });
    expect(ids(abc.items)[0]).toBe('p-000');
    const dflt = await getPage(service, { page: '2' });
    expect(dflt).toMatchObject({ page: 2, limit: 24 });
    expect(ids(dflt.items)[0]).toBe('p-024');
    const capped = await getPage(service, { page: '99999', limit: '1000' });
    expect(capped).toEqual({
      items: [],
      total: 120,
      page: 1000,
      limit: 100,
      has_more: false,
    });
  });

  it('an unknown sort equals the default order; sort without limit or page is ignored', async () => {
    const { service } = buildList(distinct());
    expect(json(await get(service, { limit: 5, sort: 'zzz' }))).toBe(
      json(await get(service, { limit: 5 })),
    );
    expect(json(await get(service, { sort: 'price_asc' }))).toBe(
      json(await get(service, {})),
    );
  });

  it('featured=true is not a filter (known defect, kept as is)', async () => {
    const { service } = buildList(distinct());
    for (const base of [{}, { limit: 3 }, { page: 1, limit: 3 }]) {
      expect(json(await get(service, { ...base, featured: 'true' }))).toBe(
        json(await get(service, base)),
      );
    }
  });
});

describe('empty answers in both shapes', () => {
  it('closed store: [] / an empty page for the public, served for the owner', async () => {
    const { service, prisma } = buildList(
      distinct({ status: StoreStatus.DRAFT }),
    );
    expect(await get(service, { limit: 3 })).toEqual([]);
    expect(await get(service, { page: 2, limit: 3 })).toEqual({
      items: [],
      total: 0,
      page: 2,
      limit: 3,
      has_more: false,
    });
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    const served = (await get(
      service,
      { page: 1, limit: 3 },
      { id: 'owner', role: 'CREATOR' },
    )) as unknown as Page;
    expect(served).toMatchObject({ total: 12, has_more: true });
    expect(served.items).toHaveLength(3);
  });

  it('unknown collection and an empty TAGS rule', async () => {
    const unknown = buildList(distinct({ collection: null })).service;
    expect(await get(unknown, { creator_category: 'x', limit: 3 })).toEqual([]);
    expect(await get(unknown, { creator_category: 'x', page: 1 })).toEqual({
      items: [],
      total: 0,
      page: 1,
      limit: 24,
      has_more: false,
    });
    const empty = buildList(
      distinct({ collection: { id: CC, match_rule: 'TAGS', match_tags: [] } }),
    ).service;
    expect(
      await get(empty, { creator_category: 'c', page: 3, limit: 5 }),
    ).toEqual({
      items: [],
      total: 0,
      page: 3,
      limit: 5,
      has_more: false,
    });
  });
});

describe('hydrated items carry the per-item enrichments', () => {
  it('tax_rate_bp, promotions and market prices equal the full list', async () => {
    const { service } = buildList(distinct({ market: MARKET, b2b: true }));
    const all = (await get(service, {})) as Item[];
    const page2 = await getPage(service, { page: 2, limit: 3 });
    expect(json(page2.items)).toBe(json(all.slice(3, 6)));
    expect(page2.items.every((p) => typeof p.tax_rate_bp === 'number')).toBe(
      true,
    );
    const items = (await getPage(service, { page: 1, limit: 100 })).items;
    const byId = (id: string) => items.find((p) => p.id === id)!;
    // Market override instead of the stored 40; the exempt row at 0 bp.
    expect(byId('p-04').base_price).not.toBe(40);
    expect(byId('p-04').base_price).toBe(
      all.find((p) => p.id === 'p-04')!.base_price,
    );
    expect(byId('p-03').tax_rate_bp).toBe(0);
    expect(byId('p-01').tax_rate_bp).toBe(2500);
    expect(
      (byId('cp-03').promotions as { id: string }[]).map((p) => p.id),
    ).toEqual(['promo-all', 'promo-one']);
  });
});
