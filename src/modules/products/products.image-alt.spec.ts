import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { BadRequestException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  OWNER_PRODUCT_IMAGES,
  ProductsService,
  redactProductForNonOwner,
} from './products.service';
import { ProductImageSyncDto } from './dto/product.dto';
import {
  PRISMA_GLOBAL_OMIT,
  type PrismaService,
} from '../../prisma/prisma.service';

// M170 A: ProductImage.alt_translations (alt text per locale). The column is
// omitted globally; the owner product read / write / duplicate and the
// storefront product page opt in. Image rows are deleted and recreated on
// every save, so the map is carried over by url when a client does not send
// it (older dashboards).

type Row = Record<string, unknown>;

describe('alt_translations (global omit)', () => {
  it('PrismaService omits ProductImage.alt_translations by default', () => {
    expect(PRISMA_GLOBAL_OMIT.productImage).toEqual({ alt_translations: true });
  });

  it('the owner include opts in explicitly', () => {
    expect(OWNER_PRODUCT_IMAGES).toEqual({
      omit: { alt_translations: false },
    });
  });

  /** Non-spec source files under src/ that mention `alt_translations`. */
  function filesNaming(): string[] {
    const root = join(__dirname, '..', '..');
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (
          name.endsWith('.ts') &&
          !name.endsWith('.spec.ts') &&
          readFileSync(p, 'utf8').includes('alt_translations')
        )
          out.push(relative(root, p).split(sep).join('/'));
      }
    };
    walk(root);
    return out.sort();
  }

  it('only the owner product paths and the storefront product page name the column', () => {
    // A new reader must be a deliberate, reviewed addition to this list;
    // lists, cards, cart, feeds and sitemap must never appear. The importer
    // apply and rollback only carry the stored map over when they replace
    // the image rows (they never return it).
    expect(filesNaming()).toEqual([
      'common/catalog/image-alt-translations.ts',
      'modules/importer/apply/apply-products.ts',
      'modules/importer/apply/rollback.ts',
      'modules/products/dto/product.dto.ts',
      'modules/products/products.service.ts',
      'modules/storefront/storefront.service.ts',
      'prisma/prisma.service.ts',
    ]);
  });

  it('non-owner product reads keep the alt texts (public text)', () => {
    const out = redactProductForNonOwner({
      id: 'p1',
      cost_price: 10,
      external_ref: 'x',
      translations: [],
      images: [{ url: '/a.webp', alt_translations: { de: 'Pferd' } }],
    }) as { images: Row[] };
    expect(out.images).toEqual([
      { url: '/a.webp', alt_translations: { de: 'Pferd' } },
    ]);
  });
});

describe('ProductImageSyncDto alt_translations', () => {
  const errs = async (extra: Row) =>
    (
      await validate(
        plainToInstance(ProductImageSyncDto, {
          url: '/uploads/products/a.webp',
          ...extra,
        }),
      )
    ).map((e) => e.property);

  it('accepts an object, null and absent', async () => {
    expect(await errs({ alt_translations: { de: 'Pferd' } })).toEqual([]);
    expect(await errs({ alt_translations: {} })).toEqual([]);
    expect(await errs({ alt_translations: null })).toEqual([]);
    expect(await errs({})).toEqual([]);
  });

  it('refuses a string or an array', async () => {
    expect(await errs({ alt_translations: 'Pferd' })).toEqual([
      'alt_translations',
    ]);
    expect(await errs({ alt_translations: ['de'] })).toEqual([
      'alt_translations',
    ]);
  });

  it('alt_text is not tightened: a long imported value still validates', async () => {
    expect(await errs({ alt_text: 'x'.repeat(2000) })).toEqual([]);
  });
});

describe('ProductsService.findById alt_translations', () => {
  it('the owner editor read opts in on the images include', async () => {
    const findUnique = jest.fn((_args: { include: Row }) =>
      Promise.resolve({
        id: 'p1',
        cost_price: 10,
        external_ref: null,
        provider_id: null,
        creator_id: 'c1',
        status: 'DRAFT',
        translations: [],
        images: [{ url: '/a.webp', alt_translations: { de: 'Pferd' } }],
        videos: [],
        stories: [],
      }),
    );
    const svc = new ProductsService(
      {
        product: { findUnique },
        creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
        provider: { findUnique: jest.fn(() => Promise.resolve(null)) },
        platformConfig: {
          findFirst: jest.fn(() =>
            Promise.resolve({ require_provider_approval: false }),
          ),
        },
      } as unknown as PrismaService,
      {} as never,
      {} as never,
      {} as never,
    );
    const p = (await svc.findById('p1', 'u', UserRole.CREATOR)) as {
      images: Row[];
    };
    expect(findUnique.mock.calls[0][0].include.images).toEqual({
      omit: { alt_translations: false },
      orderBy: { sort_order: 'asc' },
    });
    expect(p.images[0].alt_translations).toEqual({ de: 'Pferd' });
  });
});

/**
 * A service whose image sync runs for real against a fake transaction.
 * `stored` = the product-level image rows before the save; `primary` = the
 * store primary locale.
 */
function saveSetup(
  stored: { url: string; alt_translations: unknown }[],
  primary = 'sv',
) {
  const order: string[] = [];
  const createMany = jest.fn((_args: { data: Row[] }) => {
    order.push('createMany');
    return Promise.resolve({ count: 0 });
  });
  const deleteMany = jest.fn((_args: unknown) => {
    order.push('deleteMany');
    return Promise.resolve({ count: 0 });
  });
  const findMany = jest.fn((_args: { where: Row; select: Row }) => {
    order.push('findMany');
    return Promise.resolve(stored);
  });
  const productUpdate = jest.fn((_args: unknown) => {
    order.push('product.update');
    return Promise.resolve({});
  });
  const tx = { productImage: { deleteMany, createMany } };
  const prisma = {
    product: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'p1',
          creator_id: 'c1',
          variant_option_config: null,
        }),
      ),
      update: productUpdate,
    },
    productImage: { findMany, count: jest.fn(() => Promise.resolve(0)) },
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 's1',
          language_config: { primary_locale: primary },
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
  internals.assertTaxClassAllowed = jest.fn(() => Promise.resolve());
  internals.assertShippingProfileAllowed = jest.fn(() => Promise.resolve());
  internals.prepareVideos = jest.fn(() => Promise.resolve(undefined));
  internals.prepareStories = jest.fn(() => Promise.resolve(undefined));
  internals.assertVideosKeepAnImage = jest.fn(() => Promise.resolve());
  internals.revalidateForCreator = jest.fn(() => Promise.resolve());
  internals.revalidateForProduct = jest.fn(() => Promise.resolve());
  internals.findById = jest.fn((id: string) => Promise.resolve({ id }));
  const written = () =>
    createMany.mock.calls.length ? createMany.mock.calls[0][0].data : [];
  return {
    svc,
    internals,
    prisma,
    findMany,
    createMany,
    deleteMany,
    productUpdate,
    order,
    written,
  };
}

const img = (url: string, extra: Row = {}) => ({ url, ...extra });

describe('ProductsService.update image alt translations', () => {
  const stored = [
    { url: '/a.webp', alt_translations: { de: 'A-de', en: 'A-en' } },
    { url: '/b.webp', alt_translations: null },
    { url: '/c.webp', alt_translations: { de: 'C-de' } },
  ];

  it('undefined keeps the stored map of the same url, also after a reorder', async () => {
    const { svc, written, findMany } = saveSetup(stored);
    await svc.update('p1', 'u', UserRole.CREATOR, {
      images: [
        img('/c.webp', { alt_text: 'C' }),
        img('/a.webp'),
        img('/b.webp'),
      ],
    });
    expect(
      written().map((r) => [r.url, r.alt_text, r.alt_translations]),
    ).toEqual([
      ['/c.webp', 'C', { de: 'C-de' }],
      ['/a.webp', null, { de: 'A-de', en: 'A-en' }],
      ['/b.webp', null, Prisma.DbNull],
    ]);
    // The stored read names the column (opts in) and reads product-level rows only.
    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({ product_id: 'p1', variant_id: null });
    expect(args.select).toEqual({ url: true, alt_translations: true });
  });

  it('the stored maps are read before the rows are deleted', async () => {
    const { svc, order } = saveSetup(stored);
    await svc.update('p1', 'u', UserRole.CREATOR, {
      images: [img('/a.webp')],
    });
    expect(order).toEqual([
      'findMany',
      'product.update',
      'deleteMany',
      'createMany',
    ]);
  });

  it('null and {} clear the map; a sent map is normalised and replaces it', async () => {
    const { svc, written } = saveSetup(stored);
    await svc.update('p1', 'u', UserRole.CREATOR, {
      images: [
        img('/a.webp', { alt_translations: null }),
        img('/c.webp', { alt_translations: {} }),
        img('/b.webp', {
          alt_translations: { de: '  B   de ', en: '', sv: 'B-sv' },
        }),
      ],
    });
    // `sv` is the store primary locale: alt_text is its only source.
    expect(written().map((r) => [r.url, r.alt_translations])).toEqual([
      ['/a.webp', Prisma.DbNull],
      ['/c.webp', Prisma.DbNull],
      ['/b.webp', { de: 'B de' }],
    ]);
  });

  it('an explicit payload (new dashboard) does not need the stored read', async () => {
    const { svc, findMany } = saveSetup(stored);
    await svc.update('p1', 'u', UserRole.CREATOR, {
      images: [
        img('/a.webp', { alt_translations: { de: 'A' } }),
        img('/b.webp', { alt_translations: null }),
      ],
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('a replaced image (new url) starts without a map', async () => {
    const { svc, written } = saveSetup(stored);
    await svc.update('p1', 'u', UserRole.CREATOR, {
      images: [img('/a.webp'), img('/new.webp')],
    });
    expect(written().map((r) => [r.url, r.alt_translations])).toEqual([
      ['/a.webp', { de: 'A-de', en: 'A-en' }],
      ['/new.webp', Prisma.DbNull],
    ]);
  });

  it('a save without `images` touches no image row', async () => {
    const { svc, findMany, deleteMany, createMany } = saveSetup(stored);
    await svc.update('p1', 'u', UserRole.CREATOR, { base_price: 10 });
    expect(findMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it('an invalid map is a coded 400 before any write', async () => {
    const { svc, productUpdate, deleteMany, createMany } = saveSetup(stored);
    const err = await svc
      .update('p1', 'u', UserRole.CREATOR, {
        images: [
          img('/a.webp'),
          img('/b.webp', { alt_translations: { de: 'x'.repeat(301) } }),
        ],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'PRODUCT_IMAGE_ALT_INVALID',
      fields: ['images'],
    });
    expect(productUpdate).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it('alt_text keeps saving as before (long imported values included)', async () => {
    const { svc, written } = saveSetup([]);
    const long = 'x'.repeat(2000);
    await svc.update('p1', 'u', UserRole.CREATOR, {
      images: [img('/a.webp', { alt_text: long, is_featured: true })],
    });
    expect(written()).toEqual([
      {
        product_id: 'p1',
        url: '/a.webp',
        alt_text: long,
        alt_translations: Prisma.DbNull,
        sort_order: 0,
        is_featured: true,
      },
    ]);
  });
});

describe('ProductsService create image alt translations', () => {
  type Internals = {
    prepareImageAlts: (
      product: null,
      images: unknown[] | undefined,
      primaryLocale: string,
    ) => Promise<unknown[] | undefined>;
    syncVariantsAndImages: (...args: unknown[]) => Promise<void>;
  };

  it('writes the normalised map of each image (no stored read)', async () => {
    const { internals, written, findMany } = saveSetup([]);
    const i = internals as unknown as Internals;
    const images = [
      img('/a.webp', { alt_translations: { de: ' Pferd ', sv: 'Häst' } }),
      img('/b.webp'),
    ];
    const alts = await i.prepareImageAlts(null, images, 'sv');
    expect(alts).toEqual([{ de: 'Pferd' }, null]);
    expect(findMany).not.toHaveBeenCalled();
    await i.syncVariantsAndImages(
      'p1',
      undefined,
      images,
      undefined,
      undefined,
      alts,
    );
    expect(written().map((r) => [r.url, r.alt_translations])).toEqual([
      ['/a.webp', { de: 'Pferd' }],
      ['/b.webp', Prisma.DbNull],
    ]);
  });

  it('no images in the payload: nothing prepared', async () => {
    const { internals } = saveSetup([]);
    const i = internals as unknown as Internals;
    expect(await i.prepareImageAlts(null, undefined, 'sv')).toBeUndefined();
    expect(await i.prepareImageAlts(null, [], 'sv')).toEqual([]);
  });

  it('an invalid map throws the coded error', async () => {
    const { internals } = saveSetup([]);
    const i = internals as unknown as Internals;
    await expect(
      i.prepareImageAlts(
        null,
        [img('/a.webp', { alt_translations: { 'de-at': 'x' } })],
        'sv',
      ),
    ).rejects.toMatchObject({
      response: { code: 'PRODUCT_IMAGE_ALT_INVALID' },
    });
  });
});

describe('ProductsService.duplicate image alt translations', () => {
  it('opts in to the column and copies the maps', async () => {
    const imgCreateMany = jest.fn((_args: { data: Row[] }) => undefined);
    const tx = {
      product: { create: jest.fn(() => Promise.resolve({ id: 'new' })) },
      productTranslation: {
        createMany: jest.fn(),
        findFirst: jest.fn(() => Promise.resolve(null)),
      },
      customProductTranslation: {
        findFirst: jest.fn(() => Promise.resolve(null)),
      },
      productTag: { createMany: jest.fn() },
      productAttribute: { createMany: jest.fn() },
      productVariant: { create: jest.fn(() => Promise.resolve({ id: 'v2' })) },
      productImage: { createMany: imgCreateMany },
      productFaq: { create: jest.fn() },
      productCustomField: { create: jest.fn() },
    };
    const findUnique = jest.fn((_args: { include: Row }) =>
      Promise.resolve({
        id: 'src',
        translations: [],
        images: [
          {
            url: '/a.webp',
            variant_id: null,
            alt_text: 'Häst',
            alt_translations: { de: 'Pferd' },
            sort_order: 0,
            is_featured: true,
          },
          {
            url: '/b.webp',
            variant_id: null,
            alt_text: null,
            alt_translations: null,
            sort_order: 1,
            is_featured: false,
          },
        ],
        attributes: [],
        variants: [],
        tags: [],
        faqs: [],
        custom_fields: [],
        shipping_profile_id: null,
        variant_option_config: null,
      }),
    );
    const prisma = {
      product: { findUnique },
      $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
      store: { findUnique: jest.fn(() => Promise.resolve(null)) },
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

    expect(findUnique.mock.calls[0][0].include.images).toEqual({
      omit: { alt_translations: false },
    });
    expect(
      imgCreateMany.mock.calls[0][0].data.map((r) => [
        r.url,
        r.alt_text,
        r.alt_translations,
      ]),
    ).toEqual([
      ['/a.webp', 'Häst', { de: 'Pferd' }],
      ['/b.webp', null, Prisma.DbNull],
    ]);
  });
});
