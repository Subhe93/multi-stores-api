import { collectionFilterFrom } from './storefront.service';

// M6.3/M6.4: the product list's collection filter. The slug filter (storefront
// URLs) refuses INTERNAL labels; the id filter (builder section) accepts them.
describe('collectionFilterFrom', () => {
  const row = {
    id: 'cc1',
    match_rule: 'TAGS',
    match_tags: ['gift'],
    is_active: true,
    visibility: 'INTERNAL',
  };

  it('returns null for a missing or inactive collection', () => {
    expect(collectionFilterFrom(null, { allowInternal: true })).toBeNull();
    expect(
      collectionFilterFrom(
        { ...row, visibility: 'PUBLIC', is_active: false },
        { allowInternal: true },
      ),
    ).toBeNull();
  });

  it('refuses INTERNAL unless internal labels are allowed', () => {
    expect(collectionFilterFrom(row, { allowInternal: false })).toBeNull();
    expect(collectionFilterFrom(row, { allowInternal: true })).toEqual({
      id: 'cc1',
      match_rule: 'TAGS',
      match_tags: ['gift'],
    });
  });

  it('maps a PUBLIC collection on both paths', () => {
    const pub = {
      ...row,
      visibility: 'PUBLIC',
      match_rule: 'MANUAL',
      match_tags: [],
    };
    const expected = { id: 'cc1', match_rule: 'MANUAL', match_tags: [] };
    expect(collectionFilterFrom(pub, { allowInternal: false })).toEqual(
      expected,
    );
    expect(collectionFilterFrom(pub, { allowInternal: true })).toEqual(
      expected,
    );
  });
});
