import { BadRequestException } from '@nestjs/common';
import {
  CREATOR_CATEGORY_MAX_DEPTH,
  MENU_MAX_DEPTH,
  resolvePrimaryCreatorCategory,
} from './primary-collection';

// M6: the primary-collection rules shared by products and custom products.
describe('resolvePrimaryCreatorCategory (M6)', () => {
  it('no links: null, and a requested id is rejected', () => {
    expect(
      resolvePrimaryCreatorCategory({
        requested: null,
        linked: [],
        current: 'old',
      }),
    ).toBeNull();
    expect(() =>
      resolvePrimaryCreatorCategory({
        requested: 'a',
        linked: [],
        current: null,
      }),
    ).toThrow(BadRequestException);
  });

  it('exactly one link: that one, whatever the current value', () => {
    expect(
      resolvePrimaryCreatorCategory({
        requested: undefined,
        linked: ['a'],
        current: 'zzz',
      }),
    ).toBe('a');
  });

  it('several links, nothing requested: keeps the current when still linked, else the first', () => {
    expect(
      resolvePrimaryCreatorCategory({
        requested: null,
        linked: ['a', 'b', 'c'],
        current: 'b',
      }),
    ).toBe('b');
    expect(
      resolvePrimaryCreatorCategory({
        requested: undefined,
        linked: ['a', 'b', 'c'],
        current: 'gone',
      }),
    ).toBe('a');
    expect(
      resolvePrimaryCreatorCategory({
        requested: null,
        linked: ['a', 'b'],
        current: null,
      }),
    ).toBe('a');
  });

  it('a requested id must be linked', () => {
    expect(
      resolvePrimaryCreatorCategory({
        requested: 'c',
        linked: ['a', 'b', 'c'],
        current: 'a',
      }),
    ).toBe('c');
    try {
      resolvePrimaryCreatorCategory({
        requested: 'x',
        linked: ['a', 'b'],
        current: 'a',
      });
      fail('expected PRIMARY_COLLECTION_NOT_LINKED');
    } catch (err) {
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'PRIMARY_COLLECTION_NOT_LINKED',
      });
    }
  });

  // M6.3: INTERNAL labels can be linked but are never the primary.
  describe('internal collections (M6.3)', () => {
    it('a requested INTERNAL id is rejected with PRIMARY_COLLECTION_INTERNAL', () => {
      try {
        resolvePrimaryCreatorCategory({
          requested: 'lbl',
          linked: ['a', 'lbl'],
          current: null,
          internal: ['lbl'],
        });
        fail('expected PRIMARY_COLLECTION_INTERNAL');
      } catch (err) {
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: 'PRIMARY_COLLECTION_INTERNAL',
        });
      }
      // An unlinked id still fails as "not linked" first.
      try {
        resolvePrimaryCreatorCategory({
          requested: 'lbl',
          linked: ['a'],
          current: null,
          internal: ['lbl'],
        });
        fail('expected PRIMARY_COLLECTION_NOT_LINKED');
      } catch (err) {
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: 'PRIMARY_COLLECTION_NOT_LINKED',
        });
      }
    });

    it('auto-pick skips INTERNAL links: first PUBLIC one, null when all are INTERNAL', () => {
      expect(
        resolvePrimaryCreatorCategory({
          requested: null,
          linked: ['lbl', 'a', 'b'],
          current: null,
          internal: new Set(['lbl']),
        }),
      ).toBe('a');
      expect(
        resolvePrimaryCreatorCategory({
          requested: undefined,
          linked: ['lbl'],
          current: null,
          internal: ['lbl'],
        }),
      ).toBeNull();
      expect(
        resolvePrimaryCreatorCategory({
          requested: undefined,
          linked: ['lbl1', 'lbl2'],
          current: 'lbl1',
          internal: ['lbl1', 'lbl2'],
        }),
      ).toBeNull();
    });

    it('the current primary is kept only while still linked and PUBLIC', () => {
      expect(
        resolvePrimaryCreatorCategory({
          requested: null,
          linked: ['a', 'b'],
          current: 'b',
          internal: [],
        }),
      ).toBe('b');
      // The current one became INTERNAL: fall back to the first PUBLIC link.
      expect(
        resolvePrimaryCreatorCategory({
          requested: null,
          linked: ['a', 'b'],
          current: 'b',
          internal: ['b'],
        }),
      ).toBe('a');
    });
  });

  it('exposes the depth limits the plan fixes', () => {
    expect(CREATOR_CATEGORY_MAX_DEPTH).toBe(2);
    expect(MENU_MAX_DEPTH).toBe(3);
  });
});
