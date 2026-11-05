import { RedirectsService, productPublicPaths } from './redirects.service';
import { RedirectsCreatorController } from './redirects-creator.controller';
import type { PrismaService } from '../../prisma/prisma.service';

// The dashboard writes redirects for deleted products itself: it reads the
// store's locale prefixes and every public path of an item BEFORE deleting
// it. Paths follow productSlugMoves / the storefront's canonical URLs.

type Item = {
  id: string;
  creator_id: string;
  translations: { locale: string; slug: string }[];
};

const STORES = {
  mkt: { id: 'store-mkt', creator_id: 'c-mkt', store_type: 'MARKETPLACE' },
  ind: { id: 'store-ind', creator_id: 'c-ind', store_type: 'INDEPENDENT' },
} as const;
const USERS: Record<string, string> = { 'u-mkt': 'c-mkt', 'u-ind': 'c-ind' };

function setup(opts: {
  cfg?: { primary_locale: string; secondary_locales: string[] } | null;
  markets?: { locales: string[] }[];
  products?: Item[];
  custom?: Item[];
}) {
  const pick =
    (list: Item[]) =>
    ({ where }: { where: { id: { in: string[] }; creator_id: string } }) =>
      Promise.resolve(
        list.filter(
          (p) =>
            where.id.in.includes(p.id) && p.creator_id === where.creator_id,
        ),
      );
  const prisma = {
    creator: {
      findUnique: jest.fn(({ where }: { where: { user_id: string } }) => {
        const cid = USERS[where.user_id];
        const store = Object.values(STORES).find((s) => s.creator_id === cid);
        return Promise.resolve(cid ? { store: { id: store!.id } } : null);
      }),
    },
    store: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          Object.values(STORES).find((s) => s.id === where.id) ?? null,
        ),
      ),
    },
    storeLanguageConfig: {
      findUnique: jest.fn(() => Promise.resolve(opts.cfg ?? null)),
    },
    market: { findMany: jest.fn(() => Promise.resolve(opts.markets ?? [])) },
    product: { findMany: jest.fn(pick(opts.products ?? [])) },
    customProduct: { findMany: jest.fn(pick(opts.custom ?? [])) },
  };
  const svc = new RedirectsService(prisma as unknown as PrismaService);
  return { ctrl: new RedirectsCreatorController(svc), prisma };
}

const shirt: Item = {
  id: 'p1',
  creator_id: 'c-mkt',
  translations: [
    { locale: 'sv', slug: 'troja' },
    { locale: 'en', slug: 'shirt' },
    { locale: 'de', slug: 'hemd' },
  ],
};

describe('GET redirects/my/locale-prefixes', () => {
  it('primary locale + secondary and market prefixes (primary excluded, unknown dropped)', async () => {
    const { ctrl } = setup({
      cfg: { primary_locale: 'SV', secondary_locales: ['en', 'sv', 'xx'] },
      markets: [{ locales: ['DE', 'en'] }],
    });
    await expect(ctrl.localePrefixes('u-mkt')).resolves.toEqual({
      primary_locale: 'sv',
      prefixes: ['en', 'de'],
    });
  });

  it("falls back to 'en' without a language config", async () => {
    const { ctrl } = setup({ cfg: null });
    await expect(ctrl.localePrefixes('u-ind')).resolves.toEqual({
      primary_locale: 'en',
      prefixes: [],
    });
  });
});

describe('redirects/my/product-paths', () => {
  const cfg = { primary_locale: 'sv', secondary_locales: ['en', 'fr'] };

  it('single: every slug unprefixed + each prefix with its own slug (primary fallback)', async () => {
    const { ctrl } = setup({ cfg, products: [shirt] });
    await expect(ctrl.productPaths('u-mkt', 'product', 'p1')).resolves.toEqual({
      paths: [
        '/products/troja',
        '/products/shirt',
        '/products/hemd',
        '/en/products/shirt',
        '/fr/products/troja',
      ],
    });
  });

  it("single: another store's item, unknown id or bad kind", async () => {
    const { ctrl } = setup({ cfg, products: [shirt] });
    await expect(
      ctrl.productPaths('u-ind', 'product', 'p1'),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'REDIRECT_ITEM_NOT_FOUND' },
    });
    await expect(
      ctrl.productPaths('u-mkt', 'product', 'nope'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      ctrl.productPaths('u-mkt', 'collection', 'p1'),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'REDIRECT_INVALID_KIND' },
    });
  });

  it('custom products: served on MARKETPLACE, owned but pathless on INDEPENDENT', async () => {
    const mug: Item = {
      id: 'c1',
      creator_id: 'c-mkt',
      translations: [{ locale: 'sv', slug: 'mugg' }],
    };
    const indMug: Item = { ...mug, id: 'c2', creator_id: 'c-ind' };
    const { ctrl } = setup({ cfg, custom: [mug, indMug] });
    await expect(
      ctrl.productPaths('u-mkt', 'custom-product', 'c1'),
    ).resolves.toEqual({
      paths: ['/products/mugg', '/en/products/mugg', '/fr/products/mugg'],
    });
    await expect(
      ctrl.productPaths('u-ind', 'custom-product', 'c2'),
    ).resolves.toEqual({ paths: [] });
  });

  it('batch: request order kept, foreign / unknown items get []', async () => {
    const mug: Item = {
      id: 'c1',
      creator_id: 'c-mkt',
      translations: [{ locale: 'sv', slug: 'Kläder' }],
    };
    const foreign: Item = { ...shirt, id: 'p9', creator_id: 'c-ind' };
    const { ctrl, prisma } = setup({
      cfg: { primary_locale: 'sv', secondary_locales: [] },
      products: [shirt, foreign],
      custom: [mug],
    });
    const p1 = ['/products/troja', '/products/shirt', '/products/hemd'];
    await expect(
      ctrl.productPathsBatch('u-mkt', {
        items: [
          { kind: 'custom-product', id: 'c1' },
          { kind: 'product', id: 'p9' },
          { kind: 'product', id: 'p1' },
          { kind: 'product', id: 'p1' },
        ],
      }),
    ).resolves.toEqual({
      items: [
        {
          kind: 'custom-product',
          id: 'c1',
          paths: [expect.stringMatching(/^\/products\/kl%c3%a4der$/i)],
        },
        { kind: 'product', id: 'p9', paths: [] },
        { kind: 'product', id: 'p1', paths: p1 },
        { kind: 'product', id: 'p1', paths: p1 },
      ],
    });
    // One query per kind, ids deduplicated.
    expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.product.findMany.mock.calls[0][0].where.id.in).toEqual([
      'p9',
      'p1',
    ]);
  });

  it('batch: an empty list makes no queries', async () => {
    const { ctrl, prisma } = setup({ cfg });
    await expect(
      ctrl.productPathsBatch('u-mkt', { items: [] }),
    ).resolves.toEqual({ items: [] });
    expect(prisma.store.findUnique).not.toHaveBeenCalled();
  });
});

describe('productPublicPaths', () => {
  it('dedupes shared slugs, ignores empty slugs, compares locales case-insensitively', () => {
    expect(
      productPublicPaths(
        [
          { locale: 'SV', slug: 'x' },
          { locale: 'en', slug: 'x' },
          { locale: 'de', slug: '' },
        ],
        'sv',
        ['en', 'de'],
      ),
    ).toEqual(['/products/x', '/en/products/x', '/de/products/x']);
    expect(productPublicPaths([], 'sv', ['en'])).toEqual([]);
  });

  it('without a primary-locale slug the first slug is the fallback', () => {
    expect(
      productPublicPaths([{ locale: 'en', slug: 'a' }], 'sv', ['de']),
    ).toEqual(['/products/a', '/de/products/a']);
  });
});
