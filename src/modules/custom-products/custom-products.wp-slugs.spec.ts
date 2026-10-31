import { CustomProductsService } from './custom-products.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RedirectsService } from '../redirects/redirects.service';
import { storeRow, table } from '../../common/slug/__fixtures__/fake-slug-db';

// Custom products: WP slugs on create / edit / duplicate / check-slug; a
// slug taken by an own product or another custom product is suffixed
// instead of the former 400 "Slug already in use".

type Row = Record<string, unknown>;

const own = (slug: string, productId = 'p1') => ({
  id: `t-${slug}`,
  locale: 'sv',
  slug,
  product: { id: productId, creator_id: 'c1' },
});
const cust = (slug: string, cpId: string, locale = 'sv') => ({
  id: `u-${slug}-${locale}`,
  locale,
  slug,
  custom_product_id: cpId,
  custom_product: { id: cpId, creator_id: 'c1' },
});

function setup(opts: { own?: Row[]; custom?: Row[]; existing?: Row } = {}) {
  const productTranslation = table(opts.own ?? []);
  const customProductTranslation = table(opts.custom ?? []);
  const cpCreate = jest.fn((args: { data: Row }) =>
    Promise.resolve({ id: 'cp-new', ...args.data }),
  );
  const cpUpdate = jest.fn((args: { data: Row }) =>
    Promise.resolve({ id: 'cp1', ...args.data }),
  );
  const trCreateMany = jest.fn();
  const tx = {
    customProduct: { create: jest.fn(() => Promise.resolve({ id: 'cp-dup' })) },
    customProductTranslation: {
      ...customProductTranslation,
      createMany: trCreateMany,
    },
    productTranslation,
    customProductImage: { createMany: jest.fn() },
    customProductVariant: { createMany: jest.fn() },
    customProductFieldValue: { createMany: jest.fn() },
    customProductFaq: { create: jest.fn() },
  };
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    store: table([storeRow('s1', 'c1', 'sv')]),
    product: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          status: 'PUBLISHED',
          provider_id: 'prov',
          variants: [],
        }),
      ),
      findFirst: jest.fn(({ where }: { where: Row }) =>
        Promise.resolve(
          (opts.own ?? []).find(
            (r) => r.slug === (where.translations as { some: Row }).some.slug,
          )
            ? { id: 'p1' }
            : null,
        ),
      ),
    },
    customProduct: {
      create: cpCreate,
      update: cpUpdate,
      findUnique: jest.fn(() => Promise.resolve(opts.existing ?? null)),
      findFirst: jest.fn(({ where }: { where: Row }) =>
        Promise.resolve(
          (opts.custom ?? []).find(
            (r) =>
              r.slug === (where.translations as { some: Row }).some.slug &&
              r.custom_product_id !==
                (where.id as { not?: string } | undefined)?.not,
          )
            ? { id: 'x' }
            : null,
        ),
      ),
    },
    productTranslation,
    customProductTranslation: {
      ...customProductTranslation,
      findMany: jest.fn(({ where }: { where: Row }) =>
        where.custom_product_id
          ? Promise.resolve(
              (opts.custom ?? []).filter(
                (r) => r.custom_product_id === where.custom_product_id,
              ),
            )
          : customProductTranslation.findMany({ where }),
      ),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
  const redirects = {
    applySlugChangeRedirects: jest.fn(() => Promise.resolve(null)),
    releaseLivePaths: jest.fn(() => Promise.resolve(0)),
  };
  const svc = new CustomProductsService(
    prisma as unknown as PrismaService,
    {} as never,
    redirects as unknown as RedirectsService,
  );
  const internals = svc as unknown as Record<string, unknown>;
  internals.assertStoreAllowsCustomProducts = jest.fn(() => Promise.resolve());
  internals.validatePricing = jest.fn();
  internals.applyPrimaryCreatorCategory = jest.fn(() => Promise.resolve());
  internals.loadById = jest.fn((id: string) => Promise.resolve({ id }));
  internals.assertCreatorOwns = jest.fn(() =>
    Promise.resolve({ id: 'src', creator_id: 'c1' }),
  );
  return { svc, cpCreate, cpUpdate, trCreateMany, redirects, prisma };
}

describe('CustomProductsService WP slugs', () => {
  it('create: sanitizes and suffixes instead of rejecting a taken slug', async () => {
    const { svc, cpCreate } = setup({
      own: [own('present-till-svarfar')],
      custom: [cust('present-till-svarfar-2', 'cp9')],
    });
    await svc.create('u', {
      product_id: 'base',
      import_mode: 'AS_IS',
      pricing_type: 'SINGLE',
      final_price: 10,
      translations: [
        {
          locale: 'sv',
          title: 'Present till svärfar',
          slug: 'Present till svärfar',
        },
        { locale: 'ar', title: 'هدية لأمي', slug: '' },
      ],
    } as never);
    const tr = (cpCreate.mock.calls[0][0] as { data: Row }).data
      .translations as { create: Row[] };
    expect(tr.create.map((t) => [t.locale, t.slug])).toEqual([
      ['sv', 'present-till-svarfar-3'],
      ['ar', 'هدية-لأمي'],
    ]);
  });

  it('update: unchanged kept, changed sanitized, 301 for a published one', async () => {
    const { svc, cpUpdate, redirects } = setup({
      custom: [cust('tröja', 'cp1'), cust('shirt', 'cp1', 'en')],
      existing: {
        id: 'cp1',
        creator_id: 'c1',
        status: 'PUBLISHED',
        pricing_type: 'SINGLE',
        creator: { user_id: 'u' },
        product: { provider_id: null, base_price: 1 },
      },
    });
    await svc.update(
      'cp1',
      {
        translations: [
          { locale: 'sv', title: 'Tröja', slug: 'tröja' },
          { locale: 'en', title: 'T-shirt', slug: 'T-Shirt' },
        ],
      } as never,
      'u',
    );
    const tr = (cpUpdate.mock.calls[0][0] as { data: Row }).data
      .translations as { create: Row[] };
    expect(tr.create.map((t) => [t.locale, t.slug])).toEqual([
      ['sv', 'tröja'], // stored decoded slug kept as is
      ['en', 't-shirt'],
    ]);
    expect(redirects.applySlugChangeRedirects).toHaveBeenCalledWith('s1', [
      { from: '/products/shirt', to: '/products/t-shirt' },
      { from: '/en/products/shirt', to: '/en/products/t-shirt' },
    ]);
  });

  it('duplicate: WP suffix instead of -copy-<id>', async () => {
    const { svc, trCreateMany, prisma } = setup({
      custom: [cust('hoodie', 'src')],
    });
    prisma.customProduct.findUnique.mockResolvedValueOnce({
      id: 'src',
      creator_id: 'c1',
      translations: [
        { locale: 'sv', title: 'Hoodie', description: '', slug: 'hoodie' },
      ],
      mockup_images: [],
      selected_variants: [],
      field_values: [],
      faqs: [],
    } as never);
    await svc.duplicate('src', 'u');
    const [args] = trCreateMany.mock.calls[0] as [{ data: Row[] }];
    const rows = args.data;
    expect(rows.map((r) => r.slug)).toEqual(['hoodie-2']);
  });

  it('check-slug returns the sanitized slug and the suffix a save would get', async () => {
    const { svc } = setup({ own: [own('klader')] });
    await expect(svc.checkSlug('u', 'Kläder')).resolves.toEqual({
      available: false,
      slug: 'klader',
      suggestion: 'klader-2',
      conflictsWith: 'product',
    });
    await expect(svc.checkSlug('u', 'هدية لأمي')).resolves.toMatchObject({
      available: true,
      slug: 'هدية-لأمي',
    });
    await expect(svc.checkSlug('u', '!!!')).resolves.toEqual({
      available: false,
      reason: 'empty',
    });
  });
});
