import {
  cartRequiresShipping,
  fulfilmentRunsShippedHooks,
  lineRequiresShipping,
  orderLineRequiresShipping,
  orderRequiresShipping,
  PRODUCT_SHIPPING_SELECT,
} from './requires-shipping';

// The one place that turns `requires_shipping` into a decision. Only the
// literal `false` switches shipping off: a missing, null or true value
// (old rows, mocked objects, cached payloads) requires shipping.

describe('lineRequiresShipping', () => {
  it('product truth table: only literal false is "no shipping"', () => {
    expect(lineRequiresShipping({ requires_shipping: false })).toBe(false);
    expect(lineRequiresShipping({ requires_shipping: true })).toBe(true);
    expect(lineRequiresShipping({ requires_shipping: null })).toBe(true);
    expect(lineRequiresShipping({})).toBe(true);
    expect(lineRequiresShipping(null)).toBe(true);
    expect(lineRequiresShipping(undefined)).toBe(true);
  });

  it('non-boolean values never switch shipping off', () => {
    for (const raw of [0, '', 'false', 'no']) {
      expect(
        lineRequiresShipping({ requires_shipping: raw as unknown as boolean }),
      ).toBe(true);
    }
  });

  it('a variant without a value inherits the product', () => {
    for (const variant of [null, undefined, {}, { requires_shipping: null }]) {
      expect(lineRequiresShipping({ requires_shipping: false }, variant)).toBe(
        false,
      );
      expect(lineRequiresShipping({ requires_shipping: true }, variant)).toBe(
        true,
      );
    }
  });

  it('a variant with a boolean overrides the product (later per-variant flag)', () => {
    expect(
      lineRequiresShipping(
        { requires_shipping: true },
        { requires_shipping: false },
      ),
    ).toBe(false);
    expect(
      lineRequiresShipping(
        { requires_shipping: false },
        { requires_shipping: true },
      ),
    ).toBe(true);
    expect(lineRequiresShipping(null, { requires_shipping: false })).toBe(
      false,
    );
  });
});

describe('cartRequiresShipping', () => {
  it('requires shipping as soon as one line does', () => {
    expect(cartRequiresShipping([true])).toBe(true);
    expect(cartRequiresShipping([false, true])).toBe(true);
    expect(cartRequiresShipping([false])).toBe(false);
    expect(cartRequiresShipping([false, false])).toBe(false);
  });

  it('an empty cart keeps the default (requires shipping)', () => {
    expect(cartRequiresShipping([])).toBe(true);
  });
});

describe('snapshot readers', () => {
  it.each([
    ['order line', orderLineRequiresShipping],
    ['order', orderRequiresShipping],
  ])('%s: only literal false is "no shipping"', (_label, read) => {
    expect(read({ requires_shipping: false })).toBe(false);
    expect(read({ requires_shipping: true })).toBe(true);
    expect(read({ requires_shipping: null })).toBe(true);
    expect(read({})).toBe(true);
    expect(read(null)).toBe(true);
    expect(read(undefined)).toBe(true);
  });
});

describe('fulfilmentRunsShippedHooks', () => {
  const RANK = { PENDING: 0, CONFIRMED: 1, PROCESSING: 2, SHIPPED: 5 };
  const run = (
    requiresShipping: boolean,
    fromRank: number,
    to: string,
  ): boolean =>
    fulfilmentRunsShippedHooks({
      requiresShipping,
      fromRank,
      shippedRank: RANK.SHIPPED,
      to,
    });

  it('a non-shipping order reaching DELIVERED before SHIPPED runs them', () => {
    expect(run(false, RANK.PENDING, 'DELIVERED')).toBe(true);
    expect(run(false, RANK.PROCESSING, 'DELIVERED')).toBe(true);
    expect(run(false, 4, 'DELIVERED')).toBe(true);
  });

  it('not when the order was already SHIPPED (they ran then)', () => {
    expect(run(false, RANK.SHIPPED, 'DELIVERED')).toBe(false);
    expect(run(false, 6, 'DELIVERED')).toBe(false);
  });

  it('not for a status without a rank (cancelled, refunded, returned)', () => {
    expect(run(false, Infinity, 'DELIVERED')).toBe(false);
  });

  it('not for any other target status', () => {
    for (const to of ['SHIPPED', 'PROCESSING', 'CANCELLED', 'REFUNDED']) {
      expect(run(false, RANK.CONFIRMED, to)).toBe(false);
    }
  });

  it('never for an order that requires shipping', () => {
    expect(run(true, RANK.PENDING, 'DELIVERED')).toBe(false);
    expect(run(true, RANK.PROCESSING, 'DELIVERED')).toBe(false);
  });
});

it('PRODUCT_SHIPPING_SELECT selects the one column', () => {
  expect(PRODUCT_SHIPPING_SELECT).toEqual({ requires_shipping: true });
});
