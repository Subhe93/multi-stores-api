import { withoutFeedFields } from './storefront.service';

// G0 of the feeds app (M5.6): a product without feed data serves exactly
// the payload it served before the columns existed; `brand` is the only
// feed field the storefront ever exposes, and only when set.
describe('storefront withoutFeedFields (M5.6 G0)', () => {
  const base = {
    id: 'p1',
    base_price: 10,
    gtin: null,
    mpn: null,
    brand: null,
    google_product_category: null,
    condition: null,
    feed_excluded: false,
  };

  it('drops every feed key when nothing is set (no new keys in the payload)', () => {
    expect(withoutFeedFields(base)).toEqual({ id: 'p1', base_price: 10 });
    expect(Object.keys(withoutFeedFields(base))).toEqual(['id', 'base_price']);
  });

  it('keeps brand only when set; the other feed fields never leak', () => {
    const out = withoutFeedFields({
      ...base,
      brand: 'Namz',
      gtin: '4006381333931',
      mpn: 'M-1',
      google_product_category: '1604',
      condition: 'used',
      feed_excluded: true,
    });
    expect(out).toEqual({ id: 'p1', base_price: 10, brand: 'Namz' });
    expect(withoutFeedFields({ ...base, brand: '' })).toEqual({
      id: 'p1',
      base_price: 10,
    });
  });
});
