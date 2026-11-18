import { StoreType } from '@prisma/client';
import {
  buildList,
  ids,
  type CustomSpec,
  type ListFixture,
  type OwnSpec,
} from './__fixtures__/product-list-fake';

// Walks every page of a larger mixed catalogue (130 products: own + custom,
// many equal dates, prices and titles) for each sort value and several page
// sizes, and checks the windowed list against the unpaginated one: no
// duplicates, no gaps, the right total, and limit-only requests equal to the
// head of the same order.

const CC = '22222222-2222-2222-2222-222222222222';
const DATES = [
  '2026-09-01T10:00:00Z',
  '2026-09-02T10:00:00Z',
  '2026-09-02T10:00:00Z',
  '2026-09-03T10:00:00Z',
  '2026-09-04T10:00:00Z',
];
const PRICES = [50, 99, 99, 120];
const TITLES = ['Ägg', 'agg', 'Bok', 'bok 2', 'bok 10', 'Zebra'];

function catalogue(manual: boolean): ListFixture {
  const own: OwnSpec[] = [];
  const custom: CustomSpec[] = [];
  const order: Record<string, number> = {};
  for (let i = 0; i < 130; i++) {
    const isOwn = i % 2 === 0 || i >= 120;
    // Ids not in creation order, so the tie-breaker is really exercised.
    const id = `${isOwn ? 'p' : 'cp'}-${String((i * 37) % 131).padStart(3, '0')}`;
    const spec = {
      id,
      created: DATES[i % DATES.length],
      price: PRICES[i % PRICES.length],
      title: TITLES[i % TITLES.length],
      links: [CC],
    };
    if (isOwn) own.push(spec);
    else custom.push(spec);
    // A MANUAL order for two thirds of the rows (with repeated positions);
    // the rest has no link order and falls to the end.
    if (manual && i % 3 !== 0) order[`${isOwn ? 'p' : 'cp'}:${id}`] = i % 17;
  }
  return {
    own,
    custom,
    collection: manual ? { id: CC, match_rule: 'MANUAL', order } : null,
  };
}

type Filters = Record<string, unknown>;
type Page = {
  items: { id: string }[];
  total: number;
  page: number;
  limit: number;
  has_more: boolean;
};
type Service = ReturnType<typeof buildList>['service'];

const get = (service: Service, filters: Filters) =>
  service.getProducts(
    'shop',
    filters as never,
    undefined,
    undefined,
    undefined,
  );

async function walk(service: Service, filters: Filters, size: number) {
  const out: string[] = [];
  let total = -1;
  for (let page = 1; page < 1000; page++) {
    const res = (await get(service, {
      ...filters,
      page,
      limit: size,
    })) as unknown as Page;
    expect(Array.isArray(res)).toBe(false);
    if (total === -1) total = res.total;
    expect(res.total).toBe(total);
    expect(res.page).toBe(page);
    expect(res.limit).toBe(size);
    expect(res.items.length).toBeLessThanOrEqual(size);
    out.push(...ids(res.items));
    expect(res.has_more).toBe(page * size < total);
    if (!res.has_more) {
      // One page past the end is empty, with the same total.
      const after = (await get(service, {
        ...filters,
        page: page + 1,
        limit: size,
      })) as unknown as Page;
      expect(after.items).toEqual([]);
      expect(after.total).toBe(total);
      expect(after.has_more).toBe(false);
      break;
    }
    expect(res.items.length).toBe(size);
  }
  return { out, total };
}

const CASES: [string, StoreType, boolean, Filters][] = [
  ['marketplace, no collection', StoreType.MARKETPLACE, false, {}],
  [
    'marketplace, MANUAL collection',
    StoreType.MARKETPLACE,
    true,
    { creator_category_id: CC },
  ],
  ['marketplace, search', StoreType.MARKETPLACE, false, { search: 'bok' }],
  ['independent', StoreType.INDEPENDENT, false, {}],
];
const SORTS = [undefined, 'newest', 'price_asc', 'price_desc', 'name', 'bogus'];

describe('paged walk over 130 mixed products with many ties', () => {
  for (const [name, storeType, manual, base] of CASES) {
    describe(name, () => {
      const fx = () => ({ ...catalogue(manual), storeType });

      it.each(SORTS)(
        'sort=%s: every page size gives the full set exactly once',
        async (sort) => {
          const { service } = buildList(fx());
          const all = ids(await get(service, base));
          const expected = new Set(all);
          expect(expected.size).toBe(all.length);
          const filters = sort ? { ...base, sort } : base;
          let reference: string[] | undefined;
          for (const size of [7, 24, 60, 100]) {
            const { out, total } = await walk(service, filters, size);
            expect(total).toBe(all.length);
            expect(new Set(out).size).toBe(out.length);
            expect(out.length).toBe(all.length);
            expect(new Set(out)).toEqual(expected);
            // The order does not depend on the page size.
            if (reference) expect(out).toEqual(reference);
            else reference = out;
            // limit-only: a plain array, the head of the same order.
            const head = await get(service, { ...filters, limit: size });
            expect(Array.isArray(head)).toBe(true);
            expect(ids(head)).toEqual(out.slice(0, size));
          }
        },
      );
    });
  }

  it('the price orders follow the stored base price', async () => {
    const fixture = catalogue(false);
    const priceOf = new Map(
      [...fixture.own, ...(fixture.custom ?? [])].map((s) => [
        s.id,
        s.price ?? 0,
      ]),
    );
    const { service } = buildList(fixture);
    for (const sort of ['price_asc', 'price_desc'] as const) {
      const { out } = await walk(service, { sort }, 24);
      const prices = out.map((id) => priceOf.get(id)!);
      const sorted = [...prices].sort((a, b) =>
        sort === 'price_asc' ? a - b : b - a,
      );
      expect(prices).toEqual(sorted);
    }
  });

  it('newest is newest first across both sources', async () => {
    const fixture = catalogue(false);
    const dateOf = new Map(
      [...fixture.own, ...(fixture.custom ?? [])].map((s) => [
        s.id,
        Date.parse(s.created),
      ]),
    );
    const { service } = buildList(fixture);
    const { out } = await walk(service, { sort: 'newest' }, 24);
    const dates = out.map((id) => dateOf.get(id)!);
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
  });

  it('without collection, page and sort the windowed default equals the full list when dates differ', async () => {
    // Distinct dates: the windowed default must equal today's array exactly.
    const fixture = catalogue(false);
    let n = 0;
    for (const s of [...fixture.own, ...(fixture.custom ?? [])]) {
      s.created = new Date(Date.UTC(2026, 0, 1) + n++ * 60_000).toISOString();
    }
    const { service } = buildList(fixture);
    const all = ids(await get(service, {}));
    const { out } = await walk(service, {}, 7);
    expect(out).toEqual(all);
  });
});
