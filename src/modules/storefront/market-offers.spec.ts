import { marketizeBundles, marketizePromotions } from './market-offers';

// Product-page promotions and bundle offers in a market: FIXED amounts are
// base-currency (SEK) values and must reach the EUR page converted.

const toEur = (amount: number) => Math.round(amount * 0.087 * 100) / 100;
const noRate = () => null;

describe('marketizePromotions', () => {
  const promos = [
    { id: 'a', type: 'PERCENTAGE', value: 10, conditions: null },
    {
      id: 'b',
      type: 'FIXED_AMOUNT',
      value: 50,
      conditions: { product_ids: ['p'] },
    },
    {
      id: 'c',
      type: 'FREE_SHIPPING',
      value: 0,
      conditions: { min_amount: 400 },
    },
  ];

  it('converts fixed amounts and minimum amounts, keeps percentages', () => {
    const out = marketizePromotions(promos, toEur);
    expect(out.map((p) => p.value)).toEqual([10, 4.35, 0]);
    expect(out[1].conditions).toEqual({ product_ids: ['p'] });
    expect(out[2].conditions).toEqual({ min_amount: 34.8 });
  });

  it('drops amount promotions the market cannot convert', () => {
    expect(marketizePromotions(promos, noRate).map((p) => p.id)).toEqual(['a']);
  });

  it('does not mutate the input', () => {
    marketizePromotions(promos, toEur);
    expect(promos[1].value).toBe(50);
  });
});

describe('marketizeBundles', () => {
  const bundles = [
    {
      id: 'b1',
      offers: [
        { id: 'o1', discount_type: 'PERCENTAGE', discount_value: 15 },
        { id: 'o2', discount_type: 'FIXED', discount_value: '100' },
        { id: 'o3', discount_type: 'ITEM', discount_value: 1 },
      ],
    },
  ];

  it('converts FIXED offers only', () => {
    const [b] = marketizeBundles(bundles, toEur);
    expect(b.offers.map((o) => o.discount_value)).toEqual([15, 8.7, 1]);
  });

  it('drops FIXED offers without a rate', () => {
    const [b] = marketizeBundles(bundles, noRate);
    expect(b.offers.map((o) => o.id)).toEqual(['o1', 'o3']);
  });
});
