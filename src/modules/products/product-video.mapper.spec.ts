import { Prisma } from '@prisma/client';
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
      autoplay: false,
      loop: false,
      alt: 'Clip',
      created_at: '2026-11-13T10:00:00.000Z',
    });
    expect(Object.keys(out)).not.toContain('sort_order');
    expect(Object.keys(out)).not.toContain('product_id');
    expect(Object.keys(out)).not.toContain('updated_at');
  });

  it('maps autoplay / loop (missing on an old row -> false) and position 0', () => {
    expect(
      toProductVideoOut(row({ position: 0, autoplay: true, loop: true })),
    ).toMatchObject({ position: 0, autoplay: true, loop: true });
    const legacy = toProductVideoOut(
      row({ autoplay: undefined, loop: undefined }),
    );
    expect(legacy.autoplay).toBe(false);
    expect(legacy.loop).toBe(false);
  });

  it('the featured video (position 0) comes first', () => {
    const out = toProductVideosOut([
      row({ id: 'b', position: 1, sort_order: 0 }),
      row({ id: 'f', position: 0, sort_order: 1 }),
    ]);
    expect(out.map((v) => v.id)).toEqual(['f', 'b']);
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

// Jest mocks accept any row, so the new columns are checked against the
// generated Prisma data model (DMMF).
describe('ProductVideo / ProductStory autoplay columns exist in the Prisma models', () => {
  const field = (model: string, name: string) =>
    Prisma.dmmf.datamodel.models
      .find((m) => m.name === model)
      ?.fields.find((f) => f.name === name);

  it.each([
    ['ProductVideo', 'autoplay'],
    ['ProductVideo', 'loop'],
    ['ProductStory', 'autoplay'],
    ['ProductStory', 'loop'],
  ])('%s.%s is a Boolean defaulting to false', (model, name) => {
    const f = field(model, name);
    expect(f?.type).toBe('Boolean');
    expect(f?.isRequired).toBe(true);
    expect(f?.default).toBe(false);
  });

  it('every wire field except alt comes from a ProductVideo column', () => {
    const cols = new Set(
      Prisma.dmmf.datamodel.models
        .find((m) => m.name === 'ProductVideo')!
        .fields.map((f) => f.name),
    );
    for (const k of Object.keys(toProductVideoOut(row()))) {
      expect(cols.has(k === 'alt' ? 'alt_text' : k)).toBe(true);
    }
  });
});
