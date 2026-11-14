import { Prisma } from '@prisma/client';
import {
  PRODUCT_STORIES_INCLUDE,
  storefrontStoriesField,
  toProductStoriesOut,
  toProductStoryOut,
} from './product-story.mapper';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'a',
  kind: 'FILE' as const,
  url: '/uploads/products/00000000-0000-4000-8000-000000000001.mp4',
  poster_url: '/uploads/video-posters/p.webp',
  duration_s: 12,
  width: 1080,
  height: 1920,
  name: 'Anna',
  rating: 4,
  verified: true,
  sort_order: 0,
  translations: [
    { locale: 'sv', quote: 'Bra', subtitle: 'Stockholm' },
    { locale: 'en', quote: 'Good', subtitle: null },
  ],
  ...over,
});

describe('product story mapper', () => {
  it('maps a row to the wire shape (lowercase kind, translations by locale)', () => {
    expect(
      toProductStoryOut({
        ...row(),
        product_id: 'p1',
        created_at: new Date(),
      } as never),
    ).toEqual({
      id: 'a',
      kind: 'file',
      url: '/uploads/products/00000000-0000-4000-8000-000000000001.mp4',
      poster_url: '/uploads/video-posters/p.webp',
      duration_s: 12,
      width: 1080,
      height: 1920,
      name: 'Anna',
      rating: 4,
      verified: true,
      autoplay: false,
      loop: false,
      translations: [
        { locale: 'en', quote: 'Good', subtitle: null },
        { locale: 'sv', quote: 'Bra', subtitle: 'Stockholm' },
      ],
    });
  });

  it('maps autoplay / loop for video stories, forced false for images', () => {
    expect(
      toProductStoryOut(row({ autoplay: true, loop: true }) as never),
    ).toMatchObject({ autoplay: true, loop: true });
    expect(
      toProductStoryOut(
        row({ kind: 'IMAGE', autoplay: true, loop: true }) as never,
      ),
    ).toMatchObject({ autoplay: false, loop: false });
    expect(toProductStoryOut(row() as never)).toMatchObject({
      autoplay: false,
      loop: false,
    });
  });

  it('sorts by sort_order then id, defensively', () => {
    const out = toProductStoriesOut([
      row({ id: 'c', sort_order: 1 }),
      row({ id: 'b', sort_order: 0 }),
      row({ id: 'a', sort_order: 1 }),
    ]);
    expect(out.map((s) => s.id)).toEqual(['b', 'a', 'c']);
    expect(toProductStoriesOut(undefined)).toEqual([]);
  });

  it('storefront omits the key when there is no story', () => {
    expect(storefrontStoriesField([])).toEqual({});
    expect(storefrontStoriesField(null)).toEqual({});
    expect(storefrontStoriesField([row()]).stories).toHaveLength(1);
  });
});

// Jest mocks accept any include, so the fields are checked against the
// generated Prisma data model (a missing field broke prod on 2026-11-13).
describe('PRODUCT_STORIES_INCLUDE matches the Prisma models', () => {
  const model = (name: string) =>
    Prisma.dmmf.datamodel.models.find((m) => m.name === name);
  const fieldsOf = (name: string) =>
    new Set(model(name)!.fields.map((f) => f.name));

  it('Product has the `stories` relation to ProductStory', () => {
    const rel = model('Product')!.fields.find((f) => f.name === 'stories');
    expect(rel?.type).toBe('ProductStory');
  });

  it('orders and includes only fields that exist', () => {
    const story = fieldsOf('ProductStory');
    for (const o of PRODUCT_STORIES_INCLUDE.orderBy)
      for (const k of Object.keys(o)) expect(story.has(k)).toBe(true);
    for (const k of Object.keys(PRODUCT_STORIES_INCLUDE.include))
      expect(story.has(k)).toBe(true);
    const tr = fieldsOf('ProductStoryTranslation');
    const t = PRODUCT_STORIES_INCLUDE.include.translations;
    for (const k of [...Object.keys(t.select), ...Object.keys(t.orderBy)])
      expect(tr.has(k)).toBe(true);
  });

  it('every wire field comes from a ProductStory column', () => {
    const story = fieldsOf('ProductStory');
    for (const k of Object.keys(toProductStoryOut(row() as never)))
      expect(story.has(k)).toBe(true);
  });
});
