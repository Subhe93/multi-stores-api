import { UserRole } from '@prisma/client';
import { ProductsService } from './products.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RedirectsService } from '../redirects/redirects.service';
import { storeRow, table } from '../../common/slug/__fixtures__/fake-slug-db';

// Own products follow WordPress sanitize_title (store content locale) on
// create, edit and duplicate; duplicates get `-2`, `-3`; a published product
// whose slug changes leaves an old-slug 301.

type Row = Record<string, unknown>;

function setup(
  opts: {
    locale?: string;
    existing?: Row[]; // productTranslation rows of the creator's catalog
    custom?: Row[];
    product?: Row; // the product being updated / duplicated
  } = {},
) {
  const productTranslation = table(opts.existing ?? []);
  const createMany = jest.fn((_args: { data: Row[] }) => Promise.resolve({}));
  const productCreate = jest.fn((args: { data: Row }) =>
    Promise.resolve({ id: 'new-p', ...args.data }),
  );
  const tx = {
    product: { create: jest.fn(() => Promise.resolve({ id: 'dup-p' })) },
    productTranslation: {
      createMany,
      findFirst: productTranslation.findFirst,
    },
    customProductTranslation: table(opts.custom ?? []),
    productTag: { createMany: jest.fn() },
    productAttribute: { createMany: jest.fn() },
    productVariant: { create: jest.fn() },
    productImage: { createMany: jest.fn() },
    productFaq: { create: jest.fn() },
    productCustomField: { create: jest.fn() },
  };
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    store: table([storeRow('s1', 'c1', opts.locale ?? 'sv')]),
    product: {
      findUnique: jest.fn(() => Promise.resolve(opts.product ?? null)),
      create: productCreate,
      update: jest.fn(),
    },
    productTranslation: {
      ...productTranslation,
      findMany: jest.fn(({ where }: { where: Row }) =>
        where.product_id
          ? Promise.resolve(
              (opts.existing ?? []).filter(
                (r) => (r.product as Row).id === where.product_id,
              ),
            )
          : productTranslation.findMany({ where }),
      ),
      deleteMany: jest.fn(),
      createMany,
    },
    customProductTranslation: tx.customProductTranslation,
    $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
  const redirects = {
    applySlugChangeRedirects: jest.fn(() => Promise.resolve(null)),
    releaseLivePaths: jest.fn(() => Promise.resolve(0)),
  };
  const svc = new ProductsService(
    prisma as unknown as PrismaService,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    redirects as unknown as RedirectsService,
  );
  const internals = svc as unknown as Record<string, unknown>;
  internals.checkOwnership = jest.fn(() => Promise.resolve());
  internals.assertTaxClassAllowed = jest.fn(() => Promise.resolve());
  internals.assertShippingProfileAllowed = jest.fn(() => Promise.resolve());
  internals.syncVariantsAndImages = jest.fn(() => Promise.resolve());
  internals.revalidateForCreator = jest.fn(() => Promise.resolve());
  internals.findById = jest.fn((id: string) => Promise.resolve({ id }));
  return { svc, productCreate, createMany, redirects };
}

const ptr = (id: string, productId: string, locale: string, slug: string) => ({
  id,
  locale,
  slug,
  product: { id: productId, creator_id: 'c1' },
});

const created = (productCreate: jest.Mock) =>
  (
    (productCreate.mock.calls[0] as [{ data: Row }])[0].data.translations as {
      create: Row[];
    }
  ).create.map((t) => [t.locale, t.slug]);

describe('ProductsService WP slugs: create', () => {
  it('sanitizes with the store locale; Arabic kept; empty slug from the title', async () => {
    const { svc, productCreate } = setup({ locale: 'sv' });
    await svc.create('u', UserRole.CREATOR, {
      base_price: 1,
      translations: [
        { locale: 'sv', title: 'Kläder', description: '', slug: 'Kläder' },
        { locale: 'ar', title: 'هدية لأمي', description: '', slug: '' },
        {
          locale: 'en',
          title: 'Present till svärfar',
          description: '',
          slug: '',
        },
      ],
    } as never);
    expect(created(productCreate)).toEqual([
      ['sv', 'klader'],
      ['ar', 'هدية-لأمي'],
      ['en', 'present-till-svarfar'],
    ]);
  });

  it('a German store folds ß/ä the German way', async () => {
    const { svc, productCreate } = setup({ locale: 'de' });
    await svc.create('u', UserRole.CREATOR, {
      base_price: 1,
      translations: [
        { locale: 'de', title: 'Straße', description: '', slug: '' },
      ],
    } as never);
    expect(created(productCreate)).toEqual([['de', 'strasse']]);
  });

  it('a slug taken by another product or custom product gets -2 / -3 (no error)', async () => {
    const { svc, productCreate } = setup({
      existing: [ptr('t1', 'p1', 'sv', 'mugg')],
      custom: [
        {
          id: 'u1',
          locale: 'sv',
          slug: 'mugg-2',
          custom_product: { id: 'cp1', creator_id: 'c1' },
        },
      ],
    });
    await svc.create('u', UserRole.CREATOR, {
      base_price: 1,
      translations: [
        { locale: 'sv', title: 'Mugg', description: '', slug: 'mugg' },
      ],
    } as never);
    expect(created(productCreate)).toEqual([['sv', 'mugg-3']]);
  });

  it('nothing usable: id fallback product-<8 hex>', async () => {
    const { svc, productCreate } = setup();
    await svc.create('u', UserRole.CREATOR, {
      base_price: 1,
      translations: [{ locale: 'sv', title: '!!!', description: '', slug: '' }],
    } as never);
    expect(created(productCreate)[0][1]).toMatch(/^product-[0-9a-f]{8}$/);
  });
});

describe('ProductsService WP slugs: update', () => {
  const product = {
    id: 'p1',
    creator_id: 'c1',
    status: 'PUBLISHED',
    variant_option_config: null,
  };

  it('keeps an unchanged stored slug, sanitizes a changed one, writes the 301s', async () => {
    const { svc, createMany, redirects } = setup({
      product,
      existing: [
        ptr('t1', 'p1', 'sv', 'straße'),
        ptr('t2', 'p1', 'en', 'cup'),
        ptr('t9', 'p2', 'sv', 'mug'),
      ],
    });
    await svc.update('p1', 'u', UserRole.CREATOR, {
      translations: [
        { locale: 'sv', title: 'Gata', description: '', slug: 'straße' },
        { locale: 'en', title: 'Mug', description: '', slug: 'Mug' },
      ],
    } as never);
    const rows = (createMany.mock.calls[0][0] as { data: Row[] }).data;
    // `straße` is kept (re-sanitizing would give `strase`); `Mug` -> `mug`
    // is taken by p2 -> `mug-2`.
    expect(rows.map((r) => [r.locale, r.slug])).toEqual([
      ['sv', 'straße'],
      ['en', 'mug-2'],
    ]);
    expect(redirects.applySlugChangeRedirects).toHaveBeenCalledWith('s1', [
      { from: '/products/cup', to: '/products/mug-2' },
      { from: '/en/products/cup', to: '/en/products/mug-2' },
    ]);
  });

  it('a new locale reusing a stored slug of the product keeps it as is', async () => {
    const { svc, createMany } = setup({
      product,
      existing: [ptr('t1', 'p1', 'sv', 'straße')],
    });
    await svc.update('p1', 'u', UserRole.CREATOR, {
      translations: [
        { locale: 'sv', title: 'Gata', description: '', slug: 'straße' },
        { locale: 'de', title: 'Straße', description: '', slug: 'straße' },
      ],
    } as never);
    const [args] = createMany.mock.calls[0] as [{ data: Row[] }];
    expect(args.data.map((r) => r.slug)).toEqual(['straße', 'straße']);
  });

  it('a draft product changes its slug without a redirect', async () => {
    const { svc, redirects } = setup({
      product: { ...product, status: 'DRAFT' },
      existing: [ptr('t1', 'p1', 'sv', 'mugg')],
    });
    await svc.update('p1', 'u', UserRole.CREATOR, {
      translations: [
        { locale: 'sv', title: 'x', description: '', slug: 'kopp' },
      ],
    } as never);
    expect(redirects.applySlugChangeRedirects).not.toHaveBeenCalled();
  });
});

describe('ProductsService WP slugs: duplicate', () => {
  it('the copy gets the WP suffix instead of -copy-<id>; a decoded slug is kept', async () => {
    const { svc, createMany } = setup({
      existing: [
        ptr('t1', 'src', 'sv', 'kläder'),
        ptr('t2', 'src', 'en', 'clothes'),
        ptr('t3', 'other', 'en', 'clothes-2'),
      ],
      product: {
        id: 'src',
        creator_id: 'c1',
        translations: [
          { locale: 'sv', title: 'Kläder', description: '', slug: 'kläder' },
          { locale: 'en', title: 'Clothes', description: '', slug: 'clothes' },
        ],
        images: [],
        attributes: [],
        variants: [],
        tags: [],
        faqs: [],
        custom_fields: [],
        shipping_profile_id: null,
        variant_option_config: null,
      },
    });
    await svc.duplicate('src', 'u', UserRole.CREATOR);
    const rows = (createMany.mock.calls[0][0] as { data: Row[] }).data;
    expect(rows.map((r) => [r.locale, r.slug, r.title])).toEqual([
      ['sv', 'kläder-2', 'Kläder (Copy)'],
      ['en', 'clothes-3', 'Clothes (Copy)'],
    ]);
  });
});
