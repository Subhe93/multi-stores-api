/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- in-memory Prisma fake rows are untyped in tests */
import { BadRequestException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { ProductsService } from './products.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ProductVideoInputDto } from './dto/product.dto';

// Product video save path (contract 3.2/3.3): `videos` undefined keeps the
// rows, [] clears them, a list replaces them keeping ids/created_at, and the
// coded 400s fire before anything is written. duplicate() copies the rows.

type Row = Record<string, any>;

const FILE_A = '/uploads/products/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4';
const FILE_B = '/uploads/products/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.mp4';
const YT = 'https://youtu.be/dQw4w9WgXcQ';
const YT_CANON = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const V1 = '11111111-1111-4111-8111-111111111111';

function setup(
  opts: {
    images?: number;
    videos?: Row[];
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
    images: Array.from({ length: opts.images ?? 1 }, (_, i) => ({
      id: `img${i}`,
      product_id: 'p1',
      variant_id: null,
      url: `/uploads/products/i${i}.webp`,
    })) as Row[],
    videos: (opts.videos ?? []).map((v): Row => ({ product_id: 'p1', ...v })),
    files: opts.files ?? [],
  };
  const writes: string[] = [];
  /** Video write calls in order: `update:<id>:<position>` / `create:<position>`. */
  const videoCalls: string[] = [];
  // Mirrors the partial unique index ProductVideo_product_id_featured_key.
  const assertOneFeatured = () => {
    const featured = db.videos.filter((v) => v.position === 0);
    if (new Set(featured.map((v) => v.product_id)).size < featured.length) {
      throw new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      });
    }
  };
  const matchVideo = (r: Row, where: Row) =>
    (!where.product_id || r.product_id === where.product_id) &&
    (!where.id?.notIn || !where.id.notIn.includes(r.id)) &&
    (!where.url?.in || where.url.in.includes(r.url));
  const prisma: Row = {
    product: {
      findUnique: jest.fn(() => Promise.resolve(db.product)),
      update: jest.fn(() => {
        writes.push('product.update');
        return Promise.resolve(db.product);
      }),
    },
    productImage: {
      count: jest.fn(({ where }: Row) =>
        Promise.resolve(
          db.images.filter(
            (i) => i.product_id === where.product_id && i.variant_id === null,
          ).length,
        ),
      ),
      findMany: jest.fn(({ where }: Row) =>
        Promise.resolve(
          db.images.filter(
            (i) =>
              i.product_id === where.product_id &&
              (!where.url?.in || where.url.in.includes(i.url)),
          ),
        ),
      ),
      findUnique: jest.fn(({ where }: Row) =>
        Promise.resolve(db.images.find((i) => i.id === where.id) ?? null),
      ),
      delete: jest.fn(({ where }: Row) => {
        writes.push('productImage.delete');
        db.images = db.images.filter((i) => i.id !== where.id);
        return Promise.resolve({});
      }),
      deleteMany: jest.fn(({ where }: Row) => {
        db.images = db.images.filter(
          (i) =>
            !(
              i.product_id === where.product_id &&
              (where.variant_id === null
                ? i.variant_id === null
                : i.variant_id !== null)
            ),
        );
        return Promise.resolve({});
      }),
      createMany: jest.fn(({ data }: Row) => {
        for (const d of data) db.images.push({ variant_id: null, ...d });
        return Promise.resolve({});
      }),
    },
    productVideo: {
      findMany: jest.fn(({ where }: Row) =>
        Promise.resolve(db.videos.filter((r) => matchVideo(r, where))),
      ),
      count: jest.fn(({ where }: Row) =>
        Promise.resolve(db.videos.filter((r) => matchVideo(r, where)).length),
      ),
      deleteMany: jest.fn(({ where }: Row) => {
        db.videos = db.videos.filter((r) => !matchVideo(r, where));
        return Promise.resolve({});
      }),
      update: jest.fn(({ where, data }: Row) => {
        videoCalls.push(`update:${where.id}:${data.position}`);
        const r = db.videos.find((v) => v.id === where.id)!;
        Object.assign(r, data);
        assertOneFeatured();
        return Promise.resolve(r);
      }),
      create: jest.fn(({ data }: Row) => {
        videoCalls.push(`create:${data.position}`);
        const r = { id: `new${++n}`, created_at: 'now', ...data };
        db.videos.push(r);
        assertOneFeatured();
        return Promise.resolve(r);
      }),
      createMany: jest.fn(({ data }: Row) => {
        for (const d of data) db.videos.push({ id: `dup${++n}`, ...d });
        return Promise.resolve({});
      }),
    },
    uploadedFile: {
      findMany: jest.fn(({ where }: Row) =>
        Promise.resolve(db.files.filter((f) => where.key.in.includes(f.key))),
      ),
    },
    // syncVideos: `SELECT ... WHERE key IN (...) FOR SHARE`.
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
  return { svc, db, prisma, writes, videoCalls };
}

const save = (
  svc: ProductsService,
  dto: Row,
  role: UserRole = UserRole.CREATOR,
  userId = 'u1',
) => svc.update('p1', userId, role, dto as never);

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return ((e as BadRequestException).getResponse() as Row).code;
  }
  throw new Error('expected a rejection');
};

const yt = (over: Partial<ProductVideoInputDto> = {}) => ({
  kind: 'youtube',
  url: YT,
  position: 1,
  ...over,
});

describe('ProductsService videos', () => {
  const stored = () => [
    {
      id: V1,
      kind: 'YOUTUBE',
      url: YT_CANON,
      position: 1,
      sort_order: 0,
      created_at: 'then',
    },
  ];

  it('`videos` undefined keeps the rows (older save sends images only)', async () => {
    const { svc, db, prisma } = setup({ videos: stored() });
    await save(svc, { images: [{ url: '/uploads/products/x.webp' }] });
    expect(db.videos).toHaveLength(1);
    expect(prisma.productVideo.deleteMany).not.toHaveBeenCalled();
  });

  it('`videos: []` clears every row', async () => {
    const { svc, db } = setup({ videos: stored() });
    await save(svc, { videos: [] });
    expect(db.videos).toEqual([]);
  });

  it('a list replaces the rows, keeping the id and created_at of a kept row', async () => {
    const { svc, db } = setup({
      videos: stored(),
      files: [{ key: FILE_A, content_type: 'video/mp4', user_id: 'u1' }],
    });
    await save(svc, {
      videos: [
        { kind: 'file', url: FILE_A, position: 2, alt: ' Clip ' },
        yt({ id: V1, position: 1, alt: 'Kept' }),
      ],
    });
    expect(db.videos).toHaveLength(2);
    const kept = db.videos.find((v) => v.id === V1)!;
    expect(kept).toMatchObject({
      created_at: 'then',
      alt_text: 'Kept',
      sort_order: 1,
      url: YT_CANON,
      kind: 'YOUTUBE',
    });
    const added = db.videos.find((v) => v.id !== V1)!;
    expect(added).toMatchObject({
      kind: 'FILE',
      url: FILE_A,
      position: 2,
      sort_order: 0,
      alt_text: 'Clip',
      poster_url: null,
    });
  });

  it('an id from another product is treated as a new row', async () => {
    const { svc, db } = setup();
    await save(svc, { videos: [yt({ id: V1 })] });
    expect(db.videos).toHaveLength(1);
    expect(db.videos[0].id).not.toBe(V1);
  });

  it('stores the canonical watch URL of a link', async () => {
    const { svc, db } = setup();
    await save(svc, {
      videos: [
        {
          kind: 'vimeo',
          url: 'https://player.vimeo.com/video/123?h=abcdef1',
          position: 1,
        },
      ],
    });
    expect(db.videos[0]).toMatchObject({
      kind: 'VIMEO',
      url: 'https://vimeo.com/123/abcdef1',
    });
  });

  it('VIDEO_LIMIT_EXCEEDED above 3, before any write', async () => {
    const { svc, writes } = setup();
    expect(await codeOf(save(svc, { videos: [yt(), yt(), yt(), yt()] }))).toBe(
      'VIDEO_LIMIT_EXCEEDED',
    );
    expect(writes).toEqual([]);
  });

  it.each([
    ['youtube', 'https://evil.com/watch?v=dQw4w9WgXcQ'],
    ['youtube', 'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ'],
    ['vimeo', YT], // kind mismatch
    ['youtube', 'javascript:alert(1)'],
  ])('VIDEO_URL_NOT_ALLOWED: %s %s', async (kind, url) => {
    const { svc } = setup();
    expect(
      await codeOf(save(svc, { videos: [{ kind, url, position: 1 }] })),
    ).toBe('VIDEO_URL_NOT_ALLOWED');
  });

  it('VIDEO_FILE_INVALID for another user’s file, a foreign URL or a non-uuid name', async () => {
    const files = [
      {
        key: FILE_A,
        content_type: 'video/mp4',
        user_id: 'other',
        store_id: 's9',
      },
    ];
    for (const url of [
      FILE_A,
      'https://cdn.example.com/x.mp4',
      '/uploads/products/x.mp4',
      '/uploads/avatars/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4',
    ]) {
      const { svc, writes } = setup({ files });
      expect(
        await codeOf(
          save(svc, { videos: [{ kind: 'file', url, position: 1 }] }),
        ),
      ).toBe('VIDEO_FILE_INVALID');
      expect(writes).toEqual([]);
    }
  });

  it('a file uploaded by the store (another staff user) is accepted', async () => {
    const { svc, db } = setup({
      files: [
        {
          key: FILE_A,
          content_type: 'video/mp4',
          user_id: 'staff',
          store_id: 's1',
        },
      ],
    });
    await save(svc, { videos: [{ kind: 'file', url: FILE_A, position: 1 }] });
    expect(db.videos[0].url).toBe(FILE_A);
  });

  it('a file already on this product is accepted (e.g. a duplicate)', async () => {
    const { svc, db } = setup({
      videos: [
        { id: V1, kind: 'FILE', url: FILE_A, position: 1, sort_order: 0 },
      ],
    });
    await save(svc, { videos: [{ kind: 'file', url: FILE_A, position: 3 }] });
    expect(db.videos).toHaveLength(1);
    expect(db.videos[0].position).toBe(3);
  });

  it('ADMIN may attach another user’s file', async () => {
    const { svc, db } = setup({
      files: [{ key: FILE_B, content_type: 'video/mp4', user_id: 'other' }],
    });
    await save(
      svc,
      { videos: [{ kind: 'file', url: FILE_B, position: 1 }] },
      UserRole.ADMIN,
    );
    expect(db.videos).toHaveLength(1);
  });

  it('VIDEO_UPLOAD_EXPIRED when the upload row is gone (swept after 24 h in an open editor)', async () => {
    for (const role of [UserRole.CREATOR, UserRole.ADMIN]) {
      const { svc, writes } = setup();
      expect(
        await codeOf(
          save(
            svc,
            { videos: [{ kind: 'file', url: FILE_B, position: 1 }] },
            role,
          ),
        ),
      ).toBe('VIDEO_UPLOAD_EXPIRED');
      expect(writes).toEqual([]);
    }
  });

  it('VIDEO_UPLOAD_EXPIRED when the sweep deletes the file between the checks and the save; rows are locked FOR SHARE', async () => {
    const { svc, db, writes } = setup({
      files: [{ key: FILE_A, content_type: 'video/mp4', user_id: 'u1' }],
      sweptBeforeLock: [FILE_A],
    });
    expect(
      await codeOf(
        save(svc, { videos: [{ kind: 'file', url: FILE_A, position: 1 }] }),
      ),
    ).toBe('VIDEO_UPLOAD_EXPIRED');
    expect(writes).toContain('lock');
    expect(db.videos).toEqual([]);
  });

  it('caps the client duration of an uploaded file at the limit (+1 s); links keep theirs', async () => {
    const { svc, db } = setup({
      files: [{ key: FILE_A, content_type: 'video/mp4', user_id: 'u1' }],
    });
    await save(svc, {
      videos: [
        { kind: 'file', url: FILE_A, position: 1, duration_s: 3600 },
        yt({ duration_s: 900 }),
      ],
    });
    expect(db.videos.map((v) => v.duration_s)).toEqual([61, 900]);
  });

  it.each([
    'https://evil.com/p.webp',
    '/uploads/products/p.gif',
    '/uploads/products/../secret.webp',
    '/elsewhere/p.webp',
  ])('VIDEO_POSTER_INVALID: %s', async (poster_url) => {
    const { svc } = setup();
    expect(await codeOf(save(svc, { videos: [yt({ poster_url })] }))).toBe(
      'VIDEO_POSTER_INVALID',
    );
  });

  it('VIDEO_POSTER_INVALID for another store’s image (or an unknown one)', async () => {
    for (const files of [
      [{ key: '/uploads/products/p-1.webp', user_id: 'other', store_id: 's9' }],
      [],
    ]) {
      const { svc, writes } = setup({ files });
      expect(
        await codeOf(
          save(svc, {
            videos: [yt({ poster_url: '/uploads/products/p-1.webp' })],
          }),
        ),
      ).toBe('VIDEO_POSTER_INVALID');
      expect(writes).toEqual([]);
    }
  });

  it('accepts a poster already on the product, one of its images, or any poster for ADMIN', async () => {
    const a = setup({
      videos: [
        {
          id: V1,
          kind: 'YOUTUBE',
          url: YT_CANON,
          poster_url: '/uploads/products/old.webp',
          position: 1,
        },
      ],
    });
    await save(a.svc, {
      videos: [yt({ id: V1, poster_url: '/uploads/products/old.webp' })],
    });
    expect(a.db.videos[0].poster_url).toBe('/uploads/products/old.webp');

    const b = setup();
    await save(b.svc, {
      videos: [yt({ poster_url: '/uploads/products/i0.webp' })],
    });
    expect(b.db.videos[0].poster_url).toBe('/uploads/products/i0.webp');

    const c = setup();
    await save(
      c.svc,
      { videos: [yt({ poster_url: '/uploads/products/x.webp' })] },
      UserRole.ADMIN,
    );
    expect(c.db.videos[0].poster_url).toBe('/uploads/products/x.webp');
  });

  it('accepts a relative poster and null', async () => {
    const { svc, db } = setup({
      files: [{ key: '/uploads/products/p-1.webp', user_id: 'u1' }],
    });
    await save(svc, {
      videos: [
        yt({ poster_url: '/uploads/products/p-1.webp' }),
        yt({ poster_url: null }),
      ],
    });
    expect(db.videos.map((v) => v.poster_url)).toEqual([
      '/uploads/products/p-1.webp',
      null,
    ]);
  });

  it('VIDEO_REQUIRES_IMAGE without a product-level image (stored or sent)', async () => {
    const a = setup({ images: 0 });
    expect(await codeOf(save(a.svc, { videos: [yt()] }))).toBe(
      'VIDEO_REQUIRES_IMAGE',
    );
    expect(a.writes).toEqual([]);
    // The same save removes the last image.
    const b = setup({ images: 1 });
    expect(await codeOf(save(b.svc, { images: [], videos: [yt()] }))).toBe(
      'VIDEO_REQUIRES_IMAGE',
    );
    expect(b.writes).toEqual([]);
    // Clearing videos never needs an image.
    const c = setup({ images: 0 });
    await save(c.svc, { videos: [] });
  });

  it('an images-only save that clears the gallery cannot strand stored videos', async () => {
    const a = setup({ videos: stored() });
    expect(await codeOf(save(a.svc, { images: [] }))).toBe(
      'VIDEO_REQUIRES_IMAGE',
    );
    expect(a.writes).toEqual([]);
    expect(a.db.images).toHaveLength(1);
    // Without videos it stays allowed (unchanged behaviour).
    const b = setup();
    await save(b.svc, { images: [] });
    expect(b.db.images).toEqual([]);
  });

  it('deleteImage refuses the last product-level image of a product with videos', async () => {
    const a = setup({ videos: stored() });
    expect(
      await codeOf(a.svc.deleteImage('img0', 'u1', UserRole.CREATOR)),
    ).toBe('VIDEO_REQUIRES_IMAGE');
    expect(a.writes).toEqual([]);
    const b = setup({ images: 2, videos: stored() });
    await b.svc.deleteImage('img0', 'u1', UserRole.CREATOR);
    expect(b.db.images).toHaveLength(1);
    const c = setup();
    await c.svc.deleteImage('img0', 'u1', UserRole.CREATOR);
    expect(c.db.images).toEqual([]);
  });

  it('a provider product update revalidates every reselling store (D5)', async () => {
    const { svc, db, prisma } = setup();
    void prisma;
    db.product.creator_id = null;
    db.product.provider_id = 'prov1';
    const revalidation = (svc as unknown as { revalidation: Row }).revalidation;
    await save(svc, { videos: [] }, UserRole.PROVIDER);
    expect(revalidation.revalidateStoresByBaseProductId).toHaveBeenCalledWith(
      'p1',
    );
    expect(revalidation.revalidateStoreByCreatorId).not.toHaveBeenCalled();
  });

  it('create validates videos before the product row exists', async () => {
    const { svc, prisma } = setup();
    prisma.creator = {
      findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })),
    };
    prisma.product.create = jest.fn();
    expect(
      await codeOf(
        svc.create('u1', UserRole.CREATOR, {
          translations: [],
          images: [],
          videos: [yt()],
        } as never),
      ),
    ).toBe('VIDEO_REQUIRES_IMAGE');
    expect(prisma.product.create).not.toHaveBeenCalled();
  });
});

describe('ProductsService videos: featured (position 0) and autoplay (CONTRACT-AUTOPLAY)', () => {
  const POSTER = '/uploads/products/i0.webp';
  const V2 = '22222222-2222-4222-8222-222222222222';
  const storedRow = (over: Row = {}): Row => ({
    id: V1,
    kind: 'YOUTUBE',
    url: YT_CANON,
    poster_url: POSTER,
    position: 1,
    sort_order: 0,
    autoplay: false,
    loop: false,
    created_at: 'then',
    ...over,
  });

  it('accepts position 0 (featured) with a poster', async () => {
    const { svc, db } = setup();
    await save(svc, { videos: [yt({ position: 0, poster_url: POSTER })] });
    expect(db.videos[0]).toMatchObject({ position: 0, poster_url: POSTER });
  });

  it('VIDEO_FEATURED_MULTIPLE for two featured videos, before any write', async () => {
    const { svc, writes } = setup();
    expect(
      await codeOf(
        save(svc, {
          videos: [
            yt({ position: 0, poster_url: POSTER }),
            yt({ position: 0, poster_url: POSTER }),
          ],
        }),
      ),
    ).toBe('VIDEO_FEATURED_MULTIPLE');
    expect(writes).toEqual([]);
  });

  it('VIDEO_FEATURED_REQUIRES_POSTER with the index of the featured video', async () => {
    const { svc, writes } = setup();
    let response: Row | undefined;
    try {
      await save(svc, {
        videos: [yt(), yt({ position: 0, poster_url: '  ' })],
      });
    } catch (e) {
      response = (e as BadRequestException).getResponse() as Row;
    }
    expect(response).toMatchObject({
      code: 'VIDEO_FEATURED_REQUIRES_POSTER',
      index: 1,
    });
    expect(writes).toEqual([]);
  });

  it('a featured video still needs a product-level image (VIDEO_REQUIRES_IMAGE)', async () => {
    const { svc } = setup({ images: 0 });
    expect(
      await codeOf(
        // ADMIN skips the poster ownership check (no image to match here).
        save(
          svc,
          { videos: [yt({ position: 0, poster_url: POSTER })] },
          UserRole.ADMIN,
        ),
      ),
    ).toBe('VIDEO_REQUIRES_IMAGE');
  });

  it('swaps the featured video between two stored rows in one save (write order 3.3)', async () => {
    const { svc, db, videoCalls } = setup({
      videos: [
        storedRow({ id: V1, position: 0, sort_order: 0 }),
        storedRow({ id: V2, position: 1, sort_order: 1 }),
      ],
    });
    await save(svc, {
      videos: [
        yt({ id: V2, position: 0, poster_url: POSTER }),
        yt({ id: V1, position: 1, poster_url: POSTER }),
      ],
    });
    // The old featured row moves away before the new one takes slot 0.
    expect(videoCalls).toEqual([`update:${V1}:1`, `update:${V2}:0`]);
    expect(db.videos.find((v) => v.id === V2)!.position).toBe(0);
    expect(db.videos.find((v) => v.id === V1)!.position).toBe(1);
  });

  it('a new featured video is created after the old featured row moved', async () => {
    const { svc, db, videoCalls } = setup({
      videos: [storedRow({ id: V1, position: 0 })],
    });
    await save(svc, {
      videos: [
        yt({ position: 0, poster_url: POSTER }),
        yt({ id: V1, position: 1, poster_url: POSTER }),
      ],
    });
    expect(videoCalls).toEqual([`update:${V1}:1`, 'create:0']);
    expect(db.videos.filter((v) => v.position === 0)).toHaveLength(1);
  });

  it('a unique violation that still escapes maps to VIDEO_FEATURED_MULTIPLE', async () => {
    const { svc, prisma } = setup();
    prisma.productVideo.create = jest.fn(() =>
      Promise.reject(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      ),
    );
    expect(
      await codeOf(
        save(svc, { videos: [yt({ position: 0, poster_url: POSTER })] }),
      ),
    ).toBe('VIDEO_FEATURED_MULTIPLE');
  });

  it('absent autoplay / loop on a stored id keep the stored values (older dashboard)', async () => {
    const { svc, db, prisma } = setup({
      videos: [storedRow({ autoplay: true, loop: true })],
    });
    await save(svc, { videos: [yt({ id: V1, poster_url: POSTER })] });
    expect(db.videos[0]).toMatchObject({ autoplay: true, loop: true });
    const data = prisma.productVideo.update.mock.calls[0][0].data as Row;
    expect('autoplay' in data).toBe(false);
    expect('loop' in data).toBe(false);
  });

  it('absent autoplay / loop on a new row store false; present values are stored', async () => {
    const { svc, db } = setup();
    await save(svc, {
      videos: [yt(), yt({ autoplay: true, loop: true })],
    });
    expect(db.videos.map((v) => [v.autoplay, v.loop])).toEqual([
      [false, false],
      [true, true],
    ]);
    const b = setup({ videos: [storedRow({ autoplay: true, loop: true })] });
    await save(b.svc, {
      videos: [yt({ id: V1, poster_url: POSTER, autoplay: false })],
    });
    expect(b.db.videos[0]).toMatchObject({ autoplay: false, loop: true });
  });
});

describe('ProductsService.duplicate videos', () => {
  it('copies the video rows with new ids and the same files', async () => {
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
      productVideo: {
        createMany: jest.fn(({ data }: Row) => {
          created.push(...data);
          return Promise.resolve({});
        }),
      },
      productFaq: { create: jest.fn() },
      productCustomField: { create: jest.fn() },
    };
    const prisma = {
      product: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            id: 'src',
            translations: [],
            images: [],
            videos: [
              {
                id: 'v-src',
                product_id: 'src',
                kind: 'FILE',
                url: FILE_A,
                poster_url: '/uploads/products/p.webp',
                alt_text: 'A',
                duration_s: 10,
                width: 1080,
                height: 1920,
                position: 2,
                sort_order: 1,
                autoplay: true,
                loop: true,
                created_at: new Date(),
                updated_at: new Date(),
              },
              {
                id: 'v-feat',
                product_id: 'src',
                kind: 'YOUTUBE',
                url: YT_CANON,
                poster_url: '/uploads/products/f.webp',
                alt_text: null,
                duration_s: null,
                width: null,
                height: null,
                position: 0,
                sort_order: 0,
                autoplay: false,
                loop: false,
                created_at: new Date(),
                updated_at: new Date(),
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
    expect(created).toEqual([
      {
        product_id: 'new-product',
        kind: 'FILE',
        url: FILE_A,
        poster_url: '/uploads/products/p.webp',
        alt_text: 'A',
        duration_s: 10,
        width: 1080,
        height: 1920,
        position: 2,
        sort_order: 1,
        autoplay: true,
        loop: true,
      },
      {
        product_id: 'new-product',
        kind: 'YOUTUBE',
        url: YT_CANON,
        poster_url: '/uploads/products/f.webp',
        alt_text: null,
        duration_s: null,
        width: null,
        height: null,
        position: 0,
        sort_order: 0,
        autoplay: false,
        loop: false,
      },
    ]);
  });
});

describe('ProductsService.getImportDetails videos (D5, creator import view)', () => {
  it('carries the base product videos, mapped', async () => {
    const prisma = {
      product: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            id: 'base',
            provider_id: 'prov',
            status: 'PUBLISHED',
            shipping_profile: { id: 'sp' },
            videos: [
              {
                id: 'v1',
                kind: 'FILE',
                url: FILE_A,
                poster_url: null,
                alt_text: 'Demo',
                duration_s: 12,
                width: null,
                height: null,
                position: 1,
                sort_order: 0,
                created_at: new Date('2026-11-13T00:00:00Z'),
              },
            ],
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
        include: expect.objectContaining({ videos: expect.anything() }),
      }),
    );
    expect(out.videos).toEqual([
      expect.objectContaining({
        id: 'v1',
        kind: 'file',
        alt: 'Demo',
        url: FILE_A,
      }),
    ]);
  });
});

describe('ProductsService.delete of a provider product', () => {
  it('revalidates the reselling stores read before the delete', async () => {
    const order: string[] = [];
    const prisma = {
      product: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            id: 'base',
            provider_id: 'prov',
            creator_id: null,
          }),
        ),
        delete: jest.fn(() => {
          order.push('delete');
          return Promise.resolve({ id: 'base' });
        }),
      },
    };
    const revalidation = {
      revalidateStoreByCreatorId: jest.fn(),
      storeSlugsByBaseProductId: jest.fn(() => {
        order.push('slugs');
        return Promise.resolve(['noroj']);
      }),
      revalidateStoreSlugs: jest.fn(() => {
        order.push('revalidate');
        return Promise.resolve();
      }),
    };
    const svc = new ProductsService(
      prisma as unknown as PrismaService,
      {} as never,
      revalidation as never,
      {} as never,
    );
    (svc as unknown as Record<string, unknown>).checkOwnership = jest.fn(() =>
      Promise.resolve(),
    );
    await svc.delete('base', 'u', UserRole.PROVIDER);
    expect(order).toEqual(['slugs', 'delete', 'revalidate']);
    expect(revalidation.revalidateStoreSlugs).toHaveBeenCalledWith(['noroj']);
  });
});

describe('ProductsService.findById videos (editor GET)', () => {
  it('always carries `videos`, mapped, possibly []', async () => {
    const make = (videos: Row[] | undefined) => {
      const prisma = {
        product: {
          findUnique: jest.fn(() =>
            Promise.resolve({
              id: 'p1',
              provider_id: null,
              creator_id: null,
              videos,
            }),
          ),
        },
      };
      return new ProductsService(
        prisma as unknown as PrismaService,
        {} as never,
        {} as never,
        {} as never,
      );
    };
    const empty = (await make([]).findById('p1', 'u', UserRole.ADMIN)) as Row;
    expect(empty.videos).toEqual([]);
    const one = (await make([
      {
        id: 'v1',
        kind: 'YOUTUBE',
        url: YT_CANON,
        poster_url: null,
        alt_text: null,
        duration_s: null,
        width: null,
        height: null,
        position: 1,
        sort_order: 0,
        created_at: new Date('2026-11-13T00:00:00Z'),
      },
    ]).findById('p1', 'u', UserRole.ADMIN)) as Row;
    expect(one.videos).toEqual([
      expect.objectContaining({ id: 'v1', kind: 'youtube', alt: null }),
    ]);
  });
});
