/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- in-memory Prisma fake rows are untyped in tests */
import { BadRequestException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ProductsService } from './products.service';
import type { PrismaService } from '../../prisma/prisma.service';

// Customer stories save path (customer-stories contract 3.2/3.3): `stories`
// undefined keeps the rows, [] clears them, a list replaces them keeping ids
// and replacing translations, and the coded 400s (with `index`) fire before
// anything is written. duplicate(), findById and getImportDetails read them.

type Row = Record<string, any>;

const FILE_A = '/uploads/products/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4';
const IMG_A = '/uploads/products/story-a.webp';
const POSTER_A = '/uploads/video-posters/poster-a.webp';
const YT = 'https://youtu.be/dQw4w9WgXcQ';
const YT_CANON = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

function setup(
  opts: {
    stories?: Row[];
    translations?: Row[];
    files?: Row[];
    /** Keys the orphan sweep deletes between the checks and the save. */
    sweptBeforeLock?: string[];
  } = {},
) {
  let n = 0;
  const db = {
    product: {
      id: 'p1',
      creator_id: 'c1',
      provider_id: null,
      status: 'DRAFT',
      variant_option_config: null,
      primary_creator_category_id: null,
      base_price: 10,
    } as Row,
    images: [
      {
        id: 'img0',
        product_id: 'p1',
        variant_id: null,
        url: '/uploads/products/i0.webp',
      },
    ] as Row[],
    stories: (opts.stories ?? []).map((s): Row => ({ product_id: 'p1', ...s })),
    translations: opts.translations ?? [],
    files: opts.files ?? [],
  };
  const writes: string[] = [];
  const matchStory = (r: Row, where: Row) =>
    (!where.product_id || r.product_id === where.product_id) &&
    (!where.id?.notIn || !where.id.notIn.includes(r.id));
  const prisma: Row = {
    product: {
      findUnique: jest.fn(() => Promise.resolve(db.product)),
      update: jest.fn(() => {
        writes.push('product.update');
        return Promise.resolve(db.product);
      }),
    },
    productImage: {
      count: jest.fn(() => Promise.resolve(db.images.length)),
      findMany: jest.fn(({ where }: Row) =>
        Promise.resolve(
          db.images.filter((i) => i.product_id === where.product_id),
        ),
      ),
      deleteMany: jest.fn(() => Promise.resolve({})),
      createMany: jest.fn(() => Promise.resolve({})),
    },
    productVideo: {
      count: jest.fn(() => Promise.resolve(0)),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    productStory: {
      // The stored rows with their translations (syncStories' select).
      findMany: jest.fn(({ where }: Row) =>
        Promise.resolve(
          db.stories
            .filter((r) => matchStory(r, where))
            .map((r) => ({
              ...r,
              translations: db.translations
                .filter((t) => t.story_id === r.id)
                .map(({ locale, quote, subtitle }) => ({
                  locale,
                  quote,
                  subtitle,
                })),
            })),
        ),
      ),
      deleteMany: jest.fn(({ where }: Row) => {
        writes.push('productStory.deleteMany');
        const gone = db.stories.filter((r) => matchStory(r, where));
        db.stories = db.stories.filter((r) => !matchStory(r, where));
        // ON DELETE CASCADE of the translations.
        const ids = new Set(gone.map((r) => r.id));
        db.translations = db.translations.filter((t) => !ids.has(t.story_id));
        return Promise.resolve({});
      }),
      update: jest.fn(({ where, data }: Row) => {
        writes.push(`productStory.update:${where.id}`);
        const r = db.stories.find((s) => s.id === where.id)!;
        Object.assign(r, data);
        return Promise.resolve(r);
      }),
      create: jest.fn(({ data }: Row) => {
        writes.push('productStory.create');
        const { translations, ...rest } = data;
        const r = { id: `new${++n}`, ...rest };
        db.stories.push(r);
        for (const t of translations?.create ?? [])
          db.translations.push({ ...t, story_id: r.id });
        return Promise.resolve(r);
      }),
    },
    productStoryTranslation: {
      deleteMany: jest.fn(({ where }: Row) => {
        db.translations = db.translations.filter(
          (t) => t.story_id !== where.story_id,
        );
        return Promise.resolve({});
      }),
      createMany: jest.fn(({ data }: Row) => {
        db.translations.push(...data);
        return Promise.resolve({});
      }),
    },
    uploadedFile: {
      findMany: jest.fn(({ where }: Row) =>
        Promise.resolve(db.files.filter((f) => where.key.in.includes(f.key))),
      ),
    },
    // syncStories: `SELECT ... WHERE key IN (...) FOR SHARE`.
    $queryRaw: jest.fn(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        if (!sql.includes('FOR SHARE')) return Promise.resolve([]);
        writes.push('lock');
        for (const k of opts.sweptBeforeLock ?? []) {
          db.files = db.files.filter((f) => f.key !== k);
        }
        const keys = values.flatMap((v) =>
          v && typeof v === 'object' && 'values' in v
            ? ((v as { values: unknown[] }).values as string[])
            : [v as string],
        );
        return Promise.resolve(
          db.files
            .filter((f) => keys.includes(f.key))
            .map((f) => ({ key: f.key })),
        );
      },
    ),
    store: {
      findUnique: jest.fn(() => Promise.resolve({ id: 's1' })),
    },
  };
  prisma.$transaction = jest.fn((fn: (t: unknown) => Promise<unknown>) =>
    fn(prisma),
  );
  const svc = new ProductsService(
    prisma as unknown as PrismaService,
    {} as never,
    {
      revalidateStoreByCreatorId: jest.fn(),
      revalidateStoresByBaseProductId: jest.fn(),
    } as never,
    {} as never,
  );
  const internals = svc as unknown as Record<string, unknown>;
  internals.checkOwnership = jest.fn(() => Promise.resolve());
  internals.assertTaxClassAllowed = jest.fn(() => Promise.resolve());
  internals.assertShippingProfileAllowed = jest.fn(() => Promise.resolve());
  internals.findById = jest.fn((id: string) => Promise.resolve({ id }));
  return { svc, db, prisma, writes };
}

const save = (
  svc: ProductsService,
  dto: Row,
  role: UserRole = UserRole.CREATOR,
  userId = 'u1',
) => svc.update('p1', userId, role, dto as never);

const errorOf = async (p: Promise<unknown>): Promise<Row> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as Row;
  }
  throw new Error('expected a rejection');
};

const story = (over: Row = {}): Row => ({
  kind: 'youtube',
  url: YT,
  name: 'Anna',
  translations: [{ locale: 'sv', quote: 'Bra!', subtitle: 'Stockholm' }],
  ...over,
});

const ownFile = { key: FILE_A, content_type: 'video/mp4', user_id: 'u1' };
const ownImage = { key: IMG_A, content_type: 'image/webp', user_id: 'u1' };
const ownPoster = { key: POSTER_A, content_type: 'image/webp', user_id: 'u1' };

const storedStory = (): Row[] => [
  {
    id: S1,
    kind: 'YOUTUBE',
    url: YT_CANON,
    poster_url: null,
    name: 'Old',
    rating: null,
    verified: false,
    sort_order: 0,
  },
];
const storedTranslations = (): Row[] => [
  { story_id: S1, locale: 'sv', quote: 'Gammal', subtitle: null },
  { story_id: S1, locale: 'en', quote: 'Old', subtitle: null },
];

describe('ProductsService stories (save)', () => {
  it('`stories` undefined keeps the rows (an older save without the key)', async () => {
    const { svc, db, prisma } = setup({
      stories: storedStory(),
      translations: storedTranslations(),
    });
    await save(svc, { images: [{ url: '/uploads/products/x.webp' }] });
    expect(db.stories).toHaveLength(1);
    expect(db.translations).toHaveLength(2);
    expect(prisma.productStory.deleteMany).not.toHaveBeenCalled();
  });

  it('`stories: []` clears every row (translations cascade)', async () => {
    const { svc, db } = setup({
      stories: storedStory(),
      translations: storedTranslations(),
    });
    await save(svc, { stories: [] });
    expect(db.stories).toEqual([]);
    expect(db.translations).toEqual([]);
  });

  it('a list replaces the rows, keeps the id of a kept row and replaces its translations', async () => {
    const { svc, db } = setup({
      stories: storedStory(),
      translations: storedTranslations(),
      files: [ownImage],
    });
    await save(svc, {
      stories: [
        {
          kind: 'image',
          url: IMG_A,
          name: '  Bo  ',
          rating: 5,
          verified: true,
          width: 800,
          height: 1000,
          // An image story never keeps a poster or a duration.
          poster_url: POSTER_A,
          duration_s: 30,
          translations: [
            {
              locale: 'sv',
              quote: ' Rad 1\r\n\r\n\r\n\r\nRad 2 ',
              subtitle: '',
            },
            { locale: 'en', quote: '', subtitle: '  ' },
          ],
        },
        story({
          id: S1,
          name: 'Kept',
          translations: [{ locale: 'de', quote: 'Neu', subtitle: 'Berlin' }],
        }),
      ],
    });
    expect(db.stories).toHaveLength(2);
    const kept = db.stories.find((s) => s.id === S1)!;
    expect(kept).toMatchObject({
      name: 'Kept',
      kind: 'YOUTUBE',
      url: YT_CANON,
      sort_order: 1,
      rating: null,
      verified: false,
    });
    expect(db.translations.filter((t) => t.story_id === S1)).toEqual([
      { story_id: S1, locale: 'de', quote: 'Neu', subtitle: 'Berlin' },
    ]);
    const added = db.stories.find((s) => s.id !== S1)!;
    expect(added).toMatchObject({
      kind: 'IMAGE',
      url: IMG_A,
      name: 'Bo',
      rating: 5,
      verified: true,
      poster_url: null,
      duration_s: null,
      width: 800,
      height: 1000,
      sort_order: 0,
      product_id: 'p1',
    });
    // Text cleaned; an empty locale is dropped.
    expect(db.translations.filter((t) => t.story_id === added.id)).toEqual([
      {
        story_id: added.id,
        locale: 'sv',
        quote: 'Rad 1\n\nRad 2',
        subtitle: null,
      },
    ]);
  });

  it('an id from another product (or repeated) is treated as a new row', async () => {
    const { svc, db } = setup({ stories: storedStory() });
    await save(svc, {
      stories: [story({ id: S2 }), story({ id: S1 }), story({ id: S1 })],
    });
    expect(db.stories.map((s) => s.id)).toEqual([S1, 'new1', 'new2']);
  });

  it('an unchanged kept story is not rewritten; a changed one is', async () => {
    const full = (id: string, sort_order: number, name: string): Row => ({
      id,
      kind: 'YOUTUBE',
      url: YT_CANON,
      poster_url: null,
      duration_s: null,
      width: null,
      height: null,
      name,
      rating: null,
      verified: false,
      sort_order,
    });
    const { svc, db, prisma, writes } = setup({
      stories: [full(S1, 0, 'Anna'), full(S2, 1, 'Bo')],
      translations: [
        { story_id: S1, locale: 'sv', quote: 'Bra!', subtitle: 'Stockholm' },
        { story_id: S1, locale: 'en', quote: 'Good', subtitle: null },
        { story_id: S2, locale: 'sv', quote: 'Bra!', subtitle: 'Stockholm' },
      ],
    });
    await save(svc, {
      stories: [
        // Same texts, other locale order: unchanged.
        story({
          id: S1,
          translations: [
            { locale: 'en', quote: 'Good', subtitle: '' },
            { locale: 'sv', quote: 'Bra!', subtitle: 'Stockholm' },
          ],
        }),
        story({ id: S2, name: 'Bo B' }),
      ],
    });
    expect(writes).not.toContain(`productStory.update:${S1}`);
    expect(writes).toContain(`productStory.update:${S2}`);
    expect(prisma.productStoryTranslation.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.translations.filter((t) => t.story_id === S1)).toHaveLength(2);
    expect(db.stories.find((s) => s.id === S2)!.name).toBe('Bo B');
  });

  it('autoplay / loop: stored when sent, false on a new row when absent, kept on a stored id when absent', async () => {
    const full = (over: Row = {}): Row => ({
      id: S1,
      kind: 'YOUTUBE',
      url: YT_CANON,
      poster_url: null,
      duration_s: null,
      width: null,
      height: null,
      name: 'Anna',
      rating: null,
      verified: false,
      sort_order: 0,
      autoplay: true,
      loop: true,
      ...over,
    });
    const a = setup({
      stories: [full()],
      translations: [
        { story_id: S1, locale: 'sv', quote: 'Bra!', subtitle: 'Stockholm' },
      ],
    });
    // Older dashboard: no autoplay / loop keys -> unchanged, no write.
    await save(a.svc, { stories: [story({ id: S1 })] });
    expect(a.writes).not.toContain(`productStory.update:${S1}`);
    expect(a.db.stories[0]).toMatchObject({ autoplay: true, loop: true });

    // Sent values are stored (a change counts as a change).
    const b = setup({
      stories: [full()],
      translations: [
        { story_id: S1, locale: 'sv', quote: 'Bra!', subtitle: 'Stockholm' },
      ],
    });
    await save(b.svc, { stories: [story({ id: S1, autoplay: false })] });
    expect(b.writes).toContain(`productStory.update:${S1}`);
    expect(b.db.stories[0]).toMatchObject({ autoplay: false, loop: true });

    // New rows: absent -> false, present -> stored.
    const c = setup();
    await save(c.svc, {
      stories: [story(), story({ autoplay: true, loop: true })],
    });
    expect(c.db.stories.map((st) => [st.autoplay, st.loop])).toEqual([
      [false, false],
      [true, true],
    ]);
  });

  it('an image story always stores autoplay / loop false', async () => {
    const { svc, db } = setup({ files: [ownImage] });
    await save(svc, {
      stories: [
        story({ kind: 'image', url: IMG_A, autoplay: true, loop: true }),
      ],
    });
    expect(db.stories[0]).toMatchObject({
      kind: 'IMAGE',
      autoplay: false,
      loop: false,
    });
  });

  it('a reorder rewrites the moved rows (sort_order changed)', async () => {
    const row = (id: string, sort_order: number): Row => ({
      id,
      kind: 'YOUTUBE',
      url: YT_CANON,
      poster_url: null,
      duration_s: null,
      width: null,
      height: null,
      name: 'Anna',
      rating: null,
      verified: false,
      sort_order,
    });
    const { svc, db } = setup({ stories: [row(S1, 0), row(S2, 1)] });
    await save(svc, {
      stories: [
        story({ id: S2, translations: [] }),
        story({ id: S1, translations: [] }),
      ],
    });
    expect(db.stories.find((s) => s.id === S2)!.sort_order).toBe(0);
    expect(db.stories.find((s) => s.id === S1)!.sort_order).toBe(1);
  });

  it('strips control characters from texts and keeps the name on one line', async () => {
    const { svc, db } = setup();
    await save(svc, {
      stories: [
        story({
          name: ' Anna\n\u0007Svensson ',
          translations: [
            {
              locale: 'sv',
              quote: 'Bra\u0000\tköp\u001b!',
              subtitle: 'A\u007fB',
            },
          ],
        }),
      ],
    });
    expect(db.stories[0].name).toBe('Anna Svensson');
    expect(db.translations[0]).toMatchObject({
      quote: 'Bra köp!',
      subtitle: 'AB',
    });
  });

  it('runs inside the product save transaction, after the lock', async () => {
    const { svc, prisma, writes } = setup({ files: [ownFile] });
    await save(svc, { stories: [story({ kind: 'file', url: FILE_A })] });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(writes.indexOf('lock')).toBeLessThan(
      writes.indexOf('productStory.create'),
    );
  });

  it('STORY_LIMIT_EXCEEDED above 30, before any write (no index)', async () => {
    const { svc, writes } = setup();
    const err = await errorOf(
      save(svc, { stories: Array.from({ length: 31 }, () => story()) }),
    );
    expect(err).toMatchObject({ code: 'STORY_LIMIT_EXCEEDED', max: 30 });
    expect(err.index).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it('30 stories are accepted', async () => {
    const { svc, db } = setup();
    await save(svc, { stories: Array.from({ length: 30 }, () => story()) });
    expect(db.stories).toHaveLength(30);
  });

  it('STORY_NAME_REQUIRED with the index of the story', async () => {
    const { svc, writes } = setup();
    expect(
      await errorOf(save(svc, { stories: [story(), story({ name: '   ' })] })),
    ).toMatchObject({ code: 'STORY_NAME_REQUIRED', index: 1 });
    expect(writes).toEqual([]);
  });

  it('STORY_URL_NOT_ALLOWED for a non YouTube/Vimeo link or a kind mismatch', async () => {
    const { svc } = setup();
    expect(
      await errorOf(
        save(svc, {
          stories: [story({ url: 'https://evil.com/watch?v=dQw4w9WgXcQ' })],
        }),
      ),
    ).toMatchObject({ code: 'STORY_URL_NOT_ALLOWED', index: 0 });
    expect(
      await errorOf(
        save(svc, { stories: [story(), story({ kind: 'vimeo', url: YT })] }),
      ),
    ).toMatchObject({ code: 'STORY_URL_NOT_ALLOWED', index: 1 });
  });

  it('STORY_MEDIA_INVALID for a bad image or file URL shape', async () => {
    const { svc } = setup();
    for (const s of [
      { kind: 'image', url: 'https://cdn.example.com/a.webp' },
      { kind: 'image', url: '/uploads/products/a.gif' },
      { kind: 'image', url: '/uploads/products/..a.webp' },
      { kind: 'file', url: '/uploads/products/clip.mp4' },
      { kind: 'file', url: YT },
    ]) {
      expect(await errorOf(save(svc, { stories: [story(s)] }))).toMatchObject({
        code: 'STORY_MEDIA_INVALID',
        index: 0,
      });
    }
  });

  it('STORY_LOCALE_DUPLICATE with the index and locale', async () => {
    const { svc } = setup();
    expect(
      await errorOf(
        save(svc, {
          stories: [
            story(),
            story({
              translations: [
                { locale: 'sv', quote: 'a' },
                { locale: 'sv', quote: 'b' },
              ],
            }),
          ],
        }),
      ),
    ).toMatchObject({ code: 'STORY_LOCALE_DUPLICATE', index: 1, locale: 'sv' });
  });

  it('STORY_FILE_INVALID for another user’s file or a non-MP4 upload', async () => {
    const other = setup({
      files: [{ key: FILE_A, content_type: 'video/mp4', user_id: 'u2' }],
    });
    expect(
      await errorOf(
        save(other.svc, {
          stories: [story(), story({ kind: 'file', url: FILE_A })],
        }),
      ),
    ).toMatchObject({ code: 'STORY_FILE_INVALID', index: 1 });
    expect(other.writes).toEqual([]);

    const notMp4 = setup({
      files: [{ key: FILE_A, content_type: 'image/webp', user_id: 'u1' }],
    });
    expect(
      await errorOf(
        save(notMp4.svc, { stories: [story({ kind: 'file', url: FILE_A })] }),
      ),
    ).toMatchObject({ code: 'STORY_FILE_INVALID', index: 0 });
  });

  it('a file uploaded by the store (another staff user) is accepted', async () => {
    const { svc, db } = setup({
      files: [
        {
          key: FILE_A,
          content_type: 'video/mp4',
          user_id: 'u9',
          store_id: 's1',
        },
      ],
    });
    await save(svc, { stories: [story({ kind: 'file', url: FILE_A })] });
    expect(db.stories).toHaveLength(1);
  });

  it('ADMIN may attach another user’s file and image, but a file must still be an MP4 upload', async () => {
    const ok = setup({
      files: [{ key: FILE_A, content_type: 'video/mp4', user_id: 'u2' }],
    });
    await save(
      ok.svc,
      {
        stories: [
          story({ kind: 'file', url: FILE_A }),
          story({ kind: 'image', url: IMG_A }),
        ],
      },
      UserRole.ADMIN,
      'admin',
    );
    expect(ok.db.stories).toHaveLength(2);

    const gone = setup();
    expect(
      await errorOf(
        save(
          gone.svc,
          { stories: [story({ kind: 'file', url: FILE_A })] },
          UserRole.ADMIN,
          'admin',
        ),
      ),
    ).toMatchObject({ code: 'STORY_UPLOAD_EXPIRED', index: 0 });
  });

  it('STORY_IMAGE_INVALID for a foreign image or poster', async () => {
    const { svc, writes } = setup({
      files: [
        { key: IMG_A, content_type: 'image/webp', user_id: 'u2' },
        { key: FILE_A, content_type: 'video/mp4', user_id: 'u1' },
      ],
    });
    expect(
      await errorOf(
        save(svc, { stories: [story({ kind: 'image', url: IMG_A })] }),
      ),
    ).toMatchObject({ code: 'STORY_IMAGE_INVALID', index: 0 });
    expect(
      await errorOf(
        save(svc, {
          stories: [
            story(),
            story({
              kind: 'file',
              url: FILE_A,
              poster_url: '/uploads/products/unknown.webp',
            }),
          ],
        }),
      ),
    ).toMatchObject({ code: 'STORY_IMAGE_INVALID', index: 1 });
    expect(
      await errorOf(
        save(svc, {
          stories: [story({ poster_url: 'https://evil.com/p.webp' })],
        }),
      ),
    ).toMatchObject({ code: 'STORY_IMAGE_INVALID', index: 0 });
    expect(writes).toEqual([]);
  });

  it('media already on the product (its stories or images) needs no upload row', async () => {
    const { svc, db } = setup({
      stories: [
        {
          id: S1,
          kind: 'FILE',
          url: FILE_A,
          poster_url: POSTER_A,
          name: 'Old',
          sort_order: 0,
        },
      ],
      // FILE_A and POSTER_A rows are still present for the FOR SHARE lock.
      files: [
        { key: FILE_A, content_type: 'video/mp4', user_id: 'u2' },
        { key: POSTER_A, content_type: 'image/webp', user_id: 'u2' },
      ],
    });
    await save(svc, {
      stories: [
        story({ kind: 'file', url: FILE_A, poster_url: POSTER_A }),
        story({ kind: 'image', url: '/uploads/products/i0.webp' }),
      ],
    });
    expect(db.stories).toHaveLength(2);
  });

  it('accepts own image, own poster and own file', async () => {
    const { svc, db } = setup({ files: [ownFile, ownImage, ownPoster] });
    await save(svc, {
      stories: [
        story({ kind: 'image', url: IMG_A }),
        story({ kind: 'file', url: FILE_A, poster_url: POSTER_A }),
      ],
    });
    expect(db.stories.map((s) => s.kind)).toEqual(['IMAGE', 'FILE']);
  });

  it('STORY_UPLOAD_EXPIRED when a video or a video poster row is gone', async () => {
    const file = setup();
    expect(
      await errorOf(
        save(file.svc, { stories: [story({ kind: 'file', url: FILE_A })] }),
      ),
    ).toMatchObject({ code: 'STORY_UPLOAD_EXPIRED', index: 0 });
    const poster = setup();
    expect(
      await errorOf(
        save(poster.svc, {
          stories: [story(), story({ poster_url: POSTER_A })],
        }),
      ),
    ).toMatchObject({ code: 'STORY_UPLOAD_EXPIRED', index: 1 });
  });

  it('STORY_UPLOAD_EXPIRED when the sweep deletes the file between the checks and the save', async () => {
    const { svc, db } = setup({
      files: [ownFile],
      sweptBeforeLock: [FILE_A],
    });
    expect(
      await errorOf(
        save(svc, { stories: [story({ kind: 'file', url: FILE_A })] }),
      ),
    ).toMatchObject({ code: 'STORY_UPLOAD_EXPIRED', index: 0 });
    expect(db.stories).toEqual([]);
  });

  it('caps the client duration of an uploaded file; links keep theirs', async () => {
    const { svc, db } = setup({ files: [ownFile] });
    await save(svc, {
      stories: [
        story({ kind: 'file', url: FILE_A, duration_s: 3600 }),
        story({ duration_s: 600 }),
      ],
    });
    expect(db.stories[0].duration_s).toBeLessThanOrEqual(61);
    expect(db.stories[1].duration_s).toBe(600);
  });

  it('create validates stories before the product row exists', async () => {
    const { svc, prisma } = setup();
    prisma.creator = {
      findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })),
    };
    prisma.product.create = jest.fn();
    expect(
      await errorOf(
        svc.create('u1', UserRole.CREATOR, {
          translations: [],
          stories: [story({ name: '' })],
        } as never),
      ),
    ).toMatchObject({ code: 'STORY_NAME_REQUIRED', index: 0 });
    expect(prisma.product.create).not.toHaveBeenCalled();
  });

  it('create stores the stories in the save transaction', async () => {
    const { svc, prisma, db } = setup();
    prisma.creator = {
      findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })),
    };
    prisma.product.create = jest.fn(() =>
      Promise.resolve({ id: 'p1', base_price: 10, translations: [] }),
    );
    const internals = svc as unknown as Record<string, unknown>;
    internals.revalidateForCreator = jest.fn(() => Promise.resolve());
    jest
      .spyOn(
        jest.requireActual('../../common/slug/product-slugs'),
        'resolveProductTranslationSlugs',
      )
      .mockResolvedValue([] as never);
    jest
      .spyOn(
        jest.requireActual('../../common/slug/product-slugs'),
        'productSlugContext',
      )
      .mockResolvedValue({ locale: 'sv' } as never);
    jest
      .spyOn(
        jest.requireActual('../../common/slug/product-slugs'),
        'releaseLiveProductPaths',
      )
      .mockResolvedValue(undefined as never);
    await svc.create('u1', UserRole.CREATOR, {
      translations: [],
      stories: [story()],
    } as never);
    expect(db.stories).toHaveLength(1);
    expect(db.stories[0]).toMatchObject({ product_id: 'p1', name: 'Anna' });
  });
});

describe('ProductsService.duplicate stories', () => {
  it('copies the stories with their translations, new ids and the same media', async () => {
    const created: Row[] = [];
    const tx = {
      product: {
        create: jest.fn(() => Promise.resolve({ id: 'new-product' })),
      },
      productTranslation: { createMany: jest.fn() },
      productCreatorCategory: { createMany: jest.fn() },
      productAttribute: { createMany: jest.fn() },
      productVariant: { create: jest.fn() },
      productImage: { createMany: jest.fn() },
      productVideo: { createMany: jest.fn() },
      productFaq: { create: jest.fn() },
      productCustomField: { create: jest.fn() },
      productStory: {
        create: jest.fn(({ data }: Row) => {
          created.push(data);
          return Promise.resolve({ id: 'x' });
        }),
      },
    };
    const prisma = {
      product: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            id: 'src',
            translations: [],
            images: [],
            videos: [],
            stories: [
              {
                id: 's-src',
                product_id: 'src',
                kind: 'FILE',
                url: FILE_A,
                poster_url: POSTER_A,
                duration_s: 20,
                width: 1080,
                height: 1920,
                name: 'Anna',
                rating: 4,
                verified: true,
                sort_order: 3,
                autoplay: true,
                loop: true,
                created_at: new Date(),
                updated_at: new Date(),
                translations: [
                  { locale: 'en', quote: 'Great', subtitle: 'CEO' },
                  { locale: 'sv', quote: 'Bra', subtitle: null },
                ],
              },
            ],
            attributes: [],
            variants: [],
            creator_categories: [],
            faqs: [],
            custom_fields: [],
            shipping_profile_id: null,
            variant_option_config: null,
          }),
        ),
      },
      $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    };
    const svc = new ProductsService(
      prisma as unknown as PrismaService,
      {} as never,
      {} as never,
      {} as never,
    );
    const internals = svc as unknown as Record<string, unknown>;
    internals.checkOwnership = jest.fn(() => Promise.resolve());
    internals.assertShippingProfileAllowed = jest.fn(() => Promise.resolve());
    internals.findById = jest.fn((id: string) => Promise.resolve({ id }));

    await svc.duplicate('src', 'u', UserRole.ADMIN);
    expect(prisma.product.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({ stories: expect.anything() }),
      }),
    );
    expect(created).toEqual([
      {
        product_id: 'new-product',
        kind: 'FILE',
        url: FILE_A,
        poster_url: POSTER_A,
        duration_s: 20,
        width: 1080,
        height: 1920,
        name: 'Anna',
        rating: 4,
        verified: true,
        sort_order: 3,
        autoplay: true,
        loop: true,
        translations: {
          create: [
            { locale: 'en', quote: 'Great', subtitle: 'CEO' },
            { locale: 'sv', quote: 'Bra', subtitle: null },
          ],
        },
      },
    ]);
  });
});

const rawStory = (over: Row = {}): Row => ({
  id: 's1',
  kind: 'IMAGE',
  url: IMG_A,
  poster_url: null,
  duration_s: null,
  width: 800,
  height: 1000,
  name: 'Anna',
  rating: 5,
  verified: true,
  sort_order: 0,
  created_at: new Date(),
  updated_at: new Date(),
  product_id: 'p1',
  translations: [{ locale: 'sv', quote: 'Bra', subtitle: null }],
  ...over,
});

describe('ProductsService.findById stories (editor GET)', () => {
  const make = (stories: Row[] | undefined) =>
    new ProductsService(
      {
        product: {
          findUnique: jest.fn(() =>
            Promise.resolve({
              id: 'p1',
              provider_id: null,
              creator_id: null,
              videos: [],
              stories,
            }),
          ),
        },
      } as unknown as PrismaService,
      {} as never,
      {} as never,
      {} as never,
    );

  it('always carries `stories`, mapped, possibly []', async () => {
    const empty = (await make([]).findById('p1', 'u', UserRole.ADMIN)) as Row;
    expect(empty.stories).toEqual([]);
    const one = (await make([rawStory()]).findById(
      'p1',
      'u',
      UserRole.ADMIN,
    )) as Row;
    expect(one.stories).toEqual([
      {
        id: 's1',
        kind: 'image',
        url: IMG_A,
        poster_url: null,
        duration_s: null,
        width: 800,
        height: 1000,
        name: 'Anna',
        rating: 5,
        verified: true,
        autoplay: false,
        loop: false,
        translations: [{ locale: 'sv', quote: 'Bra', subtitle: null }],
      },
    ]);
  });
});

describe('ProductsService.getImportDetails stories (S7, creator import view)', () => {
  it('carries the base product stories, mapped', async () => {
    const prisma = {
      product: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            id: 'base',
            provider_id: 'prov',
            status: 'PUBLISHED',
            shipping_profile: { id: 'sp' },
            videos: [],
            stories: [rawStory({ kind: 'VIMEO', url: 'https://vimeo.com/1' })],
          }),
        ),
      },
    };
    const svc = new ProductsService(
      prisma as unknown as PrismaService,
      {} as never,
      {} as never,
      {} as never,
    );
    const out = (await svc.getImportDetails('base')) as Row;
    expect(prisma.product.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({ stories: expect.anything() }),
      }),
    );
    expect(out.stories).toEqual([
      expect.objectContaining({ id: 's1', kind: 'vimeo', name: 'Anna' }),
    ]);
  });
});
