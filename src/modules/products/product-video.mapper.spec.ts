import {
  storefrontVideosField,
  toProductVideoOut,
  toProductVideosOut,
} from './product-video.mapper';

const row = (over: Record<string, unknown> = {}) =>
  ({
    id: 'v1',
    product_id: 'p1',
    kind: 'FILE',
    url: '/uploads/products/11111111-1111-1111-1111-111111111111.mp4',
    poster_url: null,
    alt_text: null,
    duration_s: null,
    width: null,
    height: null,
    position: 1,
    sort_order: 0,
    created_at: new Date('2026-11-13T10:00:00Z'),
    updated_at: new Date('2026-11-14T10:00:00Z'),
    ...over,
  }) as never;

describe('product video mapper', () => {
  it('maps a row to the exact wire shape', () => {
    const out = toProductVideoOut(
      row({ kind: 'VIMEO', alt_text: 'Clip', duration_s: 12 }),
    );
    expect(out).toEqual({
      id: 'v1',
      kind: 'vimeo',
      url: '/uploads/products/11111111-1111-1111-1111-111111111111.mp4',
      poster_url: null,
      duration_s: 12,
      width: null,
      height: null,
      position: 1,
      alt: 'Clip',
      created_at: '2026-11-13T10:00:00.000Z',
    });
    expect(Object.keys(out)).not.toContain('sort_order');
    expect(Object.keys(out)).not.toContain('product_id');
    expect(Object.keys(out)).not.toContain('updated_at');
  });

  it('orders by position, then sort_order', () => {
    const out = toProductVideosOut([
      row({ id: 'c', position: 2, sort_order: 2 }),
      row({ id: 'b', position: 1, sort_order: 1 }),
      row({ id: 'a', position: 1, sort_order: 0 }),
    ]);
    expect(out.map((v) => v.id)).toEqual(['a', 'b', 'c']);
  });

  it('storefront omission rule: no key when empty', () => {
    expect(storefrontVideosField([])).toEqual({});
    expect(storefrontVideosField(undefined)).toEqual({});
    expect(Object.keys({ a: 1, ...storefrontVideosField([]) })).toEqual(['a']);
    expect(storefrontVideosField([row()]).videos).toHaveLength(1);
  });
});
