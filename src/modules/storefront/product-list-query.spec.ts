import {
  LIST_LIMIT_MAX,
  LIST_PAGE_MAX,
  LIST_PAGE_SIZE_DEFAULT,
  LIST_SORTS,
  compareDefault,
  compareManual,
  compareName,
  comparePrice,
  compareTail,
  emptyListResult,
  listLocale,
  normalizeListQuery,
  sourceOrderBy,
  titleFor,
  toInt,
  toProductsPage,
  type ListKey,
} from './product-list-query';

describe('constants', () => {
  it('match the contract', () => {
    expect(LIST_LIMIT_MAX).toBe(100);
    expect(LIST_PAGE_SIZE_DEFAULT).toBe(24);
    expect(LIST_PAGE_MAX).toBe(1000);
    expect(LIST_SORTS).toEqual(['newest', 'price_asc', 'price_desc', 'name']);
  });
});

describe('toInt', () => {
  it.each<[unknown, number | undefined]>([
    [5, 5],
    [0, 0],
    [-1, -1],
    [1.5, undefined],
    [NaN, undefined],
    ['12', 12],
    [' 7 ', 7],
    ['007', 7],
    ['999999999', 999999999],
    ['1234567890', undefined],
    ['', undefined],
    ['1.5', undefined],
    ['-1', undefined],
    ['abc', undefined],
    ['1e3', undefined],
    [['1', '2'], undefined],
    [null, undefined],
    [undefined, undefined],
    [{}, undefined],
  ])('%p -> %p', (input, out) => {
    expect(toInt(input)).toBe(out);
  });
});

describe('normalizeListQuery', () => {
  it('neither page nor limit: all mode, sort ignored', () => {
    expect(normalizeListQuery({})).toEqual({ mode: 'all' });
    expect(normalizeListQuery({ sort: 'price_asc' })).toEqual({ mode: 'all' });
    expect(normalizeListQuery({ page: '', limit: '0' })).toEqual({
      mode: 'all',
    });
    expect(normalizeListQuery({ page: null, limit: 'abc' })).toEqual({
      mode: 'all',
    });
  });

  it('limit: 1 to 100, invalid or 0 treated as absent', () => {
    expect(normalizeListQuery({ limit: '8' })).toEqual({
      mode: 'limit',
      offset: 0,
      limit: 8,
    });
    expect(normalizeListQuery({ limit: 8 })).toEqual({
      mode: 'limit',
      offset: 0,
      limit: 8,
    });
    expect(normalizeListQuery({ limit: '1000' })).toEqual({
      mode: 'limit',
      offset: 0,
      limit: 100,
    });
    expect(normalizeListQuery({ limit: '0' })).toEqual({ mode: 'all' });
    expect(normalizeListQuery({ limit: '-3' })).toEqual({ mode: 'all' });
    expect(normalizeListQuery({ limit: ['4', '5'] })).toEqual({ mode: 'all' });
  });

  it('page present: paged mode with defaults and caps', () => {
    expect(normalizeListQuery({ page: '1' })).toEqual({
      mode: 'paged',
      page: 1,
      limit: 24,
      offset: 0,
    });
    expect(normalizeListQuery({ page: '3', limit: '10' })).toEqual({
      mode: 'paged',
      page: 3,
      limit: 10,
      offset: 20,
    });
    expect(normalizeListQuery({ page: 'abc', limit: '10' })).toEqual({
      mode: 'paged',
      page: 1,
      limit: 10,
      offset: 0,
    });
    expect(normalizeListQuery({ page: '0' })).toMatchObject({
      mode: 'paged',
      page: 1,
    });
    expect(normalizeListQuery({ page: '-2' })).toMatchObject({
      mode: 'paged',
      page: 1,
    });
    expect(normalizeListQuery({ page: '5000', limit: '1000' })).toEqual({
      mode: 'paged',
      page: 1000,
      limit: 100,
      offset: 999 * 100,
    });
    // An array counts as present (a repeated key), but is not a number.
    expect(normalizeListQuery({ page: ['2', '3'] })).toMatchObject({
      mode: 'paged',
      page: 1,
      limit: 24,
    });
    expect(normalizeListQuery({ page: '2', limit: '0' })).toMatchObject({
      page: 2,
      limit: 24,
      offset: 24,
    });
  });

  it('sort: one of the four values in limit and paged modes only', () => {
    for (const sort of LIST_SORTS) {
      expect(normalizeListQuery({ limit: '4', sort })).toEqual({
        mode: 'limit',
        offset: 0,
        limit: 4,
        sort,
      });
      expect(normalizeListQuery({ page: '1', sort })).toMatchObject({
        mode: 'paged',
        sort,
      });
    }
    expect(normalizeListQuery({ limit: '4', sort: 'zzz' })).toEqual({
      mode: 'limit',
      offset: 0,
      limit: 4,
    });
    expect(normalizeListQuery({ limit: '4', sort: ['name'] })).toEqual({
      mode: 'limit',
      offset: 0,
      limit: 4,
    });
    expect(normalizeListQuery({ limit: '4', sort: 'NAME' })).toEqual({
      mode: 'limit',
      offset: 0,
      limit: 4,
    });
  });
});

describe('result shapes', () => {
  it('empty: [] in array modes, an empty page in paged mode', () => {
    expect(emptyListResult({ mode: 'all' })).toEqual([]);
    expect(emptyListResult(normalizeListQuery({ limit: '3' }))).toEqual([]);
    expect(
      emptyListResult(normalizeListQuery({ page: '2', limit: '3' })),
    ).toEqual({
      items: [],
      total: 0,
      page: 2,
      limit: 3,
      has_more: false,
    });
  });

  it('has_more = page * limit < total', () => {
    const q = (page: number) =>
      normalizeListQuery({ page: String(page), limit: '5' }) as Extract<
        ReturnType<typeof normalizeListQuery>,
        { mode: 'paged' }
      >;
    expect(toProductsPage(q(1), [1, 2, 3, 4, 5], 11).has_more).toBe(true);
    expect(toProductsPage(q(2), [1, 2, 3, 4, 5], 10).has_more).toBe(false);
    expect(toProductsPage(q(3), [1], 11)).toEqual({
      items: [1],
      total: 11,
      page: 3,
      limit: 5,
      has_more: false,
    });
  });
});

const k = (
  kind: 'p' | 'cp',
  id: string,
  created: string,
  price = 0,
  title?: string,
): ListKey => ({ kind, id, created_at: new Date(created), price, title });

const order = (keys: ListKey[], cmp: (a: ListKey, b: ListKey) => number) =>
  [...keys].sort(cmp).map((x) => `${x.kind}:${x.id}`);

describe('comparators', () => {
  const keys = [
    k('cp', 'b', '2026-10-05', 20, 'äpple'),
    k('p', 'c', '2026-10-01', 10, 'Banan'),
    k('p', 'a', '2026-10-03', 30, ''),
    k('cp', 'a', '2026-10-03', 10, 'apple 10'),
    k('p', 'b', '2026-10-03', 10, 'apple 9'),
  ];

  it('tail: newest, own before custom, id', () => {
    expect(order(keys, compareTail)).toEqual([
      'cp:b',
      'p:a',
      'p:b',
      'cp:a',
      'p:c',
    ]);
  });

  it('default: own first, then newest, then id', () => {
    expect(order(keys, compareDefault)).toEqual([
      'p:a',
      'p:b',
      'p:c',
      'cp:b',
      'cp:a',
    ]);
  });

  it('price asc / desc with the tail on ties', () => {
    expect(order(keys, comparePrice('asc'))).toEqual([
      'p:b',
      'cp:a',
      'p:c',
      'cp:b',
      'p:a',
    ]);
    expect(order(keys, comparePrice('desc'))).toEqual([
      'p:a',
      'cp:b',
      'p:b',
      'cp:a',
      'p:c',
    ]);
  });

  it('name: collation (base sensitivity, numeric), empty titles last', () => {
    // sv collation sorts "ä" after "z"; en treats it as "a" ("äpple" is
    // then a prefix of "apple 9"). Numeric: "apple 9" before "apple 10".
    expect(order(keys, compareName('en'))).toEqual([
      'cp:b',
      'p:b',
      'cp:a',
      'p:c',
      'p:a',
    ]);
    expect(order(keys, compareName('sv'))).toEqual([
      'p:b',
      'cp:a',
      'p:c',
      'cp:b',
      'p:a',
    ]);
    expect(order(keys, compareName())).toEqual(order(keys, compareName('en')));
  });

  it('manual: link sort_order, missing link last, then the tail', () => {
    const sortOf = new Map([
      ['p:c', 0],
      ['cp:a', 1],
      ['p:a', 1],
    ]);
    expect(order(keys, compareManual(sortOf))).toEqual([
      'p:c',
      'p:a',
      'cp:a',
      'cp:b',
      'p:b',
    ]);
  });

  it('every comparator is total: equal dates and prices still order by kind and id', () => {
    const tied = [
      k('cp', 'x', '2026-01-01', 5, 'T'),
      k('p', 'y', '2026-01-01', 5, 'T'),
      k('p', 'x', '2026-01-01', 5, 'T'),
    ];
    for (const cmp of [
      compareTail,
      compareDefault,
      comparePrice('asc'),
      comparePrice('desc'),
      compareName('sv'),
      compareManual(new Map()),
    ]) {
      expect(order(tied, cmp)).toEqual(['p:x', 'p:y', 'cp:x']);
    }
  });
});

describe('helpers', () => {
  it('listLocale accepts plain locale codes only', () => {
    expect(listLocale('sv')).toBe('sv');
    expect(listLocale('en-GB')).toBe('en-GB');
    expect(listLocale('english')).toBeUndefined();
    expect(listLocale(['sv'])).toBeUndefined();
    expect(listLocale(undefined)).toBeUndefined();
  });

  it('titleFor: the locale, else the smallest locale code, else empty', () => {
    const ts = [
      { locale: 'sv', title: 'Mugg' },
      { locale: 'en', title: 'Mug' },
      { locale: 'de', title: 'Becher' },
    ];
    expect(titleFor(ts, 'sv')).toBe('Mugg');
    expect(titleFor(ts, 'fr')).toBe('Becher');
    expect(titleFor(ts)).toBe('Becher');
    expect(titleFor([], 'sv')).toBe('');
  });

  it('sourceOrderBy matches the comparators per source', () => {
    expect(sourceOrderBy(undefined, 'base_price')).toEqual([
      { created_at: 'desc' },
      { id: 'asc' },
    ]);
    expect(sourceOrderBy('newest', 'base_price')).toEqual([
      { created_at: 'desc' },
      { id: 'asc' },
    ]);
    expect(sourceOrderBy('price_asc', 'base_price')).toEqual([
      { base_price: 'asc' },
      { created_at: 'desc' },
      { id: 'asc' },
    ]);
    expect(sourceOrderBy('price_desc', 'final_price')).toEqual([
      { final_price: 'desc' },
      { created_at: 'desc' },
      { id: 'asc' },
    ]);
  });
});
