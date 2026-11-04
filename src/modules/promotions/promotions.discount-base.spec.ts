import { discountBase } from './promotions.service';

// A product-targeted coupon discounts only the targeted cart lines.

describe('discountBase', () => {
  const lines = [
    { product_id: 'p-x', amount: 100 },
    { product_id: 'p-y', amount: 900 },
  ];

  it('uses only the targeted lines when the coupon targets products', () => {
    expect(discountBase({ subtotal: 1000, line_totals: lines }, ['p-x'])).toBe(
      100,
    );
  });

  it('sums every targeted line', () => {
    expect(
      discountBase(
        {
          subtotal: 1100,
          line_totals: [...lines, { product_id: 'p-x', amount: 100 }],
        },
        ['p-x', 'p-y'],
      ),
    ).toBe(1100);
  });

  it('uses the whole subtotal for an untargeted coupon', () => {
    expect(discountBase({ subtotal: 1000, line_totals: lines }, [])).toBe(1000);
    expect(
      discountBase({ subtotal: 1000, line_totals: lines }, undefined),
    ).toBe(1000);
  });

  it('falls back to the subtotal without line totals, null when unknown', () => {
    expect(discountBase({ subtotal: 500 }, ['p-x'])).toBe(500);
    expect(discountBase({}, undefined)).toBeNull();
  });
});
