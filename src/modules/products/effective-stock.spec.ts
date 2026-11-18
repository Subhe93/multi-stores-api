import { effectiveProductStock } from './effective-stock';

describe('effectiveProductStock', () => {
  it('no variants: the product number, whatever it is', () => {
    expect(effectiveProductStock({ stock_quantity: 40 }, [])).toBe(40);
    expect(effectiveProductStock({ stock_quantity: 0 }, null)).toBe(0);
    expect(effectiveProductStock({ stock_quantity: null }, undefined)).toBe(
      null,
    );
    // A row without the column keeps not having a value.
    expect(effectiveProductStock({}, [])).toBe(undefined);
  });

  it('every active variant numbered: their sum (the hoodie case)', () => {
    expect(
      effectiveProductStock({ stock_quantity: 40 }, [
        { stock_quantity: 18, is_active: true },
        { stock_quantity: 20, is_active: true },
      ]),
    ).toBe(38);
    // The product-level number may even be missing.
    expect(
      effectiveProductStock({ stock_quantity: null }, [
        { stock_quantity: 3 },
        { stock_quantity: 0 },
      ]),
    ).toBe(3);
  });

  it('a negative variant counts as 0', () => {
    expect(
      effectiveProductStock({ stock_quantity: 40 }, [
        { stock_quantity: -2 },
        { stock_quantity: 5 },
      ]),
    ).toBe(5);
  });

  it('all variants sold out: 0, not the stale product number', () => {
    expect(
      effectiveProductStock({ stock_quantity: 40 }, [
        { stock_quantity: 0 },
        { stock_quantity: 0 },
      ]),
    ).toBe(0);
  });

  it('any active variant untracked: the product number unchanged', () => {
    expect(
      effectiveProductStock({ stock_quantity: 40 }, [
        { stock_quantity: 18 },
        { stock_quantity: null },
      ]),
    ).toBe(40);
    expect(
      effectiveProductStock({ stock_quantity: null }, [
        { stock_quantity: null },
      ]),
    ).toBe(null);
  });

  it('inactive variants are ignored', () => {
    expect(
      effectiveProductStock({ stock_quantity: 40 }, [
        { stock_quantity: 18, is_active: true },
        { stock_quantity: 100, is_active: false },
        { stock_quantity: null, is_active: false },
      ]),
    ).toBe(18);
    // Only inactive variants: like a product without variants.
    expect(
      effectiveProductStock({ stock_quantity: 40 }, [
        { stock_quantity: 1, is_active: false },
      ]),
    ).toBe(40);
  });
});
