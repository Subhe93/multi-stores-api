import { StoreType } from '@prisma/client';
import {
  CARD_CONFIG,
  MARKET,
  buildList,
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
      { id: 'p-a', created: '2026-10-05T10:00:00Z', price: 300, links: [CC], overrideIn: ['m-eu'] },
      { id: 'p-b', created: '2026-10-04T10:00:00Z', price: 120, optionConfig: CARD_CONFIG, links: [CC] },
      // Two rows with the same created_at (fixture = physical order).
      { id: 'p-d', created: '2026-10-03T10:00:00Z', price: 80, taxExempt: true },
      { id: 'p-c', created: '2026-10-03T10:00:00Z', price: 80, links: [CC] },
      { id: 'p-hidden', created: '2026-10-02T10:00:00Z', price: 50, hiddenIn: ['m-eu'], links: [CC] },
    ],
    custom: [
      { id: 'cp-a', created: '2026-10-06T10:00:00Z', price: 210, links: [CC] },
      { id: 'cp-b', created: '2026-10-03T10:00:00Z', price: 0, pricing: 'PER_VARIANT', links: [CC] },
      { id: 'cp-c', created: '2026-09-01T10:00:00Z', price: 0, pricing: 'MARGIN' },
    ],
    collection: {
      id: CC,
      match_rule: 'MANUAL',
      order: { 'p:p-c': 0, 'cp:cp-b': 1, 'p:p-a': 2, 'cp:cp-a': 3, 'p:p-hidden': 4 },
    },
    promotions: [
      { id: 'promo-all', type: 'PERCENTAGE', value: 10 },
      { id: 'promo-one', type: 'FIXED', value: 5, product_ids: ['p-b', 'cp-a'] },
    ],
    personalization: false,
    ...over,
  };
}

describe('all mode (no page, no limit) is unchanged', () => {
  const variants: [string, Partial<ListFixture>, Record<string, unknown>][] = [];
  for (const market of [null, MARKET])
    for (const b2b of [false, true])
      for (const withCollection of [false, true])
        variants.push([
          `market ${market ? 'on' : 'off'}, b2b ${b2b ? 'on' : 'off'}, ${withCollection ? 'MANUAL collection' : 'no collection'}`,
          { market, b2b },
          withCollection ? { creator_category: 'c' } : {},
        ]);
  variants.push([
    'personalization app on',
    { personalization: true },
    {},
  ]);
  variants.push([
    'independent store',
    { storeType: StoreType.INDEPENDENT },
    {},
  ]);
  variants.push(['search', {}, { search: 'title p-' , locale: 'sv' }]);

  it.each(variants)('golden bytes: %s', async (_name, over, filters) => {
    const { service, prisma } = buildList(rich(over));
    const list = await service.getProducts('shop', filters);
    expect(JSON.stringify(list)).toMatchSnapshot();
    // Same Prisma calls: one full read per source, newest first, no
    // window, no count, no tie-breaker.
    expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
    const ownArgs = prisma.product.findMany.mock.calls[0][0] as Record<string, unknown>;
    expect(ownArgs.orderBy).toEqual({ created_at: 'desc' });
    expect(ownArgs).not.toHaveProperty('take');
    expect(ownArgs).not.toHaveProperty('skip');
    expect(ownArgs).not.toHaveProperty('select');
    expect(prisma.product.count).not.toHaveBeenCalled();
    expect(prisma.customProduct.count).not.toHaveBeenCalled();
    expect(JSON.stringify(prisma.product.findMany.mock.calls)).toMatchSnapshot();
    expect(JSON.stringify(prisma.customProduct.findMany.mock.calls)).toMatchSnapshot();
  });
});
