import { Prisma, UserRole } from '@prisma/client';
import { ProductsService } from './products.service';
import type { PrismaService } from '../../prisma/prisma.service';

// M159: display labels of variant option names / values per translation
// locale (ProductTranslation.variant_option_labels). Canonical keys never
// change; the column is validated against the product's options, carried over
// when not sent, cleared with null, and never set on the primary locale.

type Row = Record<string, unknown>;

const DE = {
  names: { Färg: 'Farbe' },
  values: { Färg: { Svart: 'Schwarz', Vit: 'Weiß' } },
};

const tr = (locale: string, extra: Row = {}) => ({
  locale,
  title: `T-${locale}`,
  description: 'd',
  slug: `s-${locale}`,
  ...extra,
});

function setup(
  stored: Row[],
  variants: Row[] = [
    { options: { Färg: 'Svart' } },
    { options: { Färg: 'Vit' } },
  ],
) {
  const createMany = jest.fn((_args: { data: Row[] }) => undefined);
  const update = jest.fn((_args: { where: Row; data: Row }) => ({
    op: 'update',
  }));
  const productUpdate = jest.fn();
  const prisma = {
    product: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'p1',
          creator_id: 'c1',
          provider_id: null,
          variant_option_config: null,
        }),
      ),
      update: productUpdate,
    },
    productVariant: { findMany: jest.fn(() => Promise.resolve(variants)) },
    productTranslation: {
      findMany: jest.fn(() =>
        Promise.resolve(
          stored.map((r) => ({
            short_description: null,
            email_note: null,
            slug: `s-${String(r.locale)}`,
            ...r,
          })),
        ),
      ),
      findFirst: jest.fn(() => Promise.resolve(null)),
      deleteMany: jest.fn(),
      createMany,
      update,
    },
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 's1',
          language_config: { primary_locale: 'sv' },
        }),
      ),
    },
    customProductTranslation: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    $transaction: jest.fn((ops: unknown[]) => Promise.resolve(ops)),
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
  internals.syncVariantsAndImages = jest.fn(() => Promise.resolve());
  const revalidateForProduct = jest.fn(() => Promise.resolve());
  internals.revalidateForCreator = jest.fn(() => Promise.resolve());
  internals.revalidateForProduct = revalidateForProduct;
  internals.findById = jest.fn((id: string) => Promise.resolve({ id }));
  const written = () =>
    new Map(
      (createMany.mock.calls[0][0] as { data: Row[] }).data.map((r) => [
        r.locale,
        r.variant_option_labels,
      ]),
    );
  return { svc, prisma, written, update, productUpdate, revalidateForProduct };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as { getResponse(): Row }).getResponse();
  }
};

describe('ProductsService.update variant_option_labels', () => {
  it('stores sent labels (normalized) and DbNull elsewhere', async () => {
    const { svc, written } = setup([]);
    await svc.update('p1', 'u', UserRole.CREATOR, {
      translations: [
        tr('sv'),
        tr('de', {
          variant_option_labels: {
            names: { Färg: ' Farbe ' },
            values: { Färg: { Svart: 'Schwarz', Vit: '' } },
          },
        }),
      ],
    });
    const w = written();
    expect(w.get('sv')).toBe(Prisma.DbNull);
    expect(w.get('de')).toEqual({
      names: { Färg: 'Farbe' },
      values: { Färg: { Svart: 'Schwarz' } },
    });
  });

  it('undefined keeps the stored labels, null clears them', async () => {
    const { svc, written } = setup([
      { locale: 'sv', variant_option_labels: null },
      { locale: 'de', variant_option_labels: DE },
      { locale: 'en', variant_option_labels: { names: { Färg: 'Colour' } } },
    ]);
    await svc.update('p1', 'u', UserRole.CREATOR, {
      translations: [
        tr('sv'),
        tr('de'),
        tr('en', { variant_option_labels: null }),
      ],
    });
    const w = written();
    expect(w.get('de')).toEqual(DE);
    expect(w.get('en')).toBe(Prisma.DbNull);
  });

  it('carried labels are pruned silently after a value rename', async () => {
    const { svc, written } = setup([
      { locale: 'de', variant_option_labels: DE },
    ]);
    await svc.update('p1', 'u', UserRole.CREATOR, {
      variants: [
        { options: { Färg: 'Kolsvart' } },
        { options: { Färg: 'Vit' } },
      ],
      translations: [tr('sv'), tr('de')],
    });
    expect(written().get('de')).toEqual({
      names: { Färg: 'Farbe' },
      values: { Färg: { Vit: 'Weiß' } },
    });
  });

  it('a sent unknown value is a 400 with the path, before any write', async () => {
    const { svc, productUpdate } = setup([]);
    const res = await code(
      svc.update('p1', 'u', UserRole.CREATOR, {
        translations: [
          tr('sv'),
          tr('de', {
            variant_option_labels: { values: { Färg: { Lila: 'Lila' } } },
          }),
        ],
      }),
    );
    expect(res).toMatchObject({
      code: 'PRODUCT_OPTION_LABELS_UNKNOWN_OPTION',
      issues: [
        { locale: 'de', path: 'values.Färg.Lila', reason: 'unknown_option' },
      ],
    });
    expect(productUpdate).not.toHaveBeenCalled();
  });

  it('a bad shape is PRODUCT_OPTION_LABELS_INVALID', async () => {
    const { svc } = setup([]);
    const res = await code(
      svc.update('p1', 'u', UserRole.CREATOR, {
        translations: [tr('de', { variant_option_labels: { names: 'x' } })],
      }),
    );
    expect(res).toMatchObject({ code: 'PRODUCT_OPTION_LABELS_INVALID' });
  });

  it('labels on the primary locale are a 400; carried ones are dropped', async () => {
    const { svc } = setup([]);
    const res = await code(
      svc.update('p1', 'u', UserRole.CREATOR, {
        translations: [tr('sv', { variant_option_labels: DE })],
      }),
    );
    expect(res).toMatchObject({ code: 'PRODUCT_OPTION_LABELS_PRIMARY_LOCALE' });

    const second = setup([{ locale: 'sv', variant_option_labels: DE }]);
    await second.svc.update('p1', 'u', UserRole.CREATOR, {
      translations: [tr('sv')],
    });
    expect(second.written().get('sv')).toBe(Prisma.DbNull);
  });

  it('a product without labels reads nothing extra', async () => {
    const { svc, prisma, written } = setup([
      { locale: 'sv', variant_option_labels: null },
    ]);
    await svc.update('p1', 'u', UserRole.CREATOR, { translations: [tr('sv')] });
    expect(prisma.productVariant.findMany).not.toHaveBeenCalled();
    expect(prisma.productTranslation.findMany).toHaveBeenCalledTimes(1);
    expect(written().get('sv')).toBe(Prisma.DbNull);
  });
});

describe('ProductsService.setVariantOptionLabels', () => {
  it('updates only the column of existing rows and reports missing rows', async () => {
    const { svc, update, revalidateForProduct } = setup([
      { id: 't-sv', locale: 'sv', variant_option_labels: null },
      { id: 't-de', locale: 'de', variant_option_labels: null },
    ]);
    const res = await svc.setVariantOptionLabels('p1', 'u', UserRole.ADMIN, {
      de: DE,
      en: { names: { Färg: 'Colour' } },
    });
    expect(res).toEqual({ updated: ['de'], unchanged: [], missingRow: ['en'] });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toEqual({
      where: { id: 't-de' },
      data: { variant_option_labels: DE },
    });
    expect(revalidateForProduct).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: same labels write nothing', async () => {
    const { svc, update, revalidateForProduct } = setup([
      { id: 't-de', locale: 'de', variant_option_labels: DE },
    ]);
    const res = await svc.setVariantOptionLabels('p1', 'u', UserRole.ADMIN, {
      de: {
        values: { Färg: { Vit: 'Weiß', Svart: 'Schwarz' } },
        names: { Färg: 'Farbe' },
      },
    });
    expect(res).toEqual({ updated: [], unchanged: ['de'], missingRow: [] });
    expect(update).not.toHaveBeenCalled();
    expect(revalidateForProduct).not.toHaveBeenCalled();
  });

  it('validates like update (unknown key, primary locale)', async () => {
    const { svc } = setup([
      { id: 't-sv', locale: 'sv', variant_option_labels: null },
      { id: 't-de', locale: 'de', variant_option_labels: null },
    ]);
    expect(
      await code(
        svc.setVariantOptionLabels('p1', 'u', UserRole.ADMIN, {
          de: { names: { Djur: 'Tier' } },
        }),
      ),
    ).toMatchObject({ code: 'PRODUCT_OPTION_LABELS_UNKNOWN_OPTION' });
    expect(
      await code(
        svc.setVariantOptionLabels('p1', 'u', UserRole.ADMIN, { sv: DE }),
      ),
    ).toMatchObject({ code: 'PRODUCT_OPTION_LABELS_PRIMARY_LOCALE' });
  });

  it('null clears the column', async () => {
    const { svc, update } = setup([
      { id: 't-de', locale: 'de', variant_option_labels: DE },
    ]);
    await svc.setVariantOptionLabels('p1', 'u', UserRole.ADMIN, { de: null });
    expect(update.mock.calls[0][0].data).toEqual({
      variant_option_labels: Prisma.DbNull,
    });
  });
});

describe('ProductsService.duplicate variant_option_labels', () => {
  it('copies the labels', async () => {
    const trCreateMany = jest.fn((_args: { data: Row[] }) => undefined);
    const tx = {
      product: { create: jest.fn(() => Promise.resolve({ id: 'new' })) },
      productTranslation: {
        createMany: trCreateMany,
        findFirst: jest.fn(() => Promise.resolve(null)),
      },
      customProductTranslation: {
        findFirst: jest.fn(() => Promise.resolve(null)),
      },
      productAttribute: { createMany: jest.fn() },
      productVariant: { create: jest.fn(() => Promise.resolve({ id: 'v' })) },
      productImage: { createMany: jest.fn() },
    };
    const base = {
      title: 'T',
      description: 'd',
      meta_title: null,
      meta_desc: null,
      short_description: null,
      email_note: null,
    };
    const prisma = {
      product: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            id: 'src',
            translations: [
              { ...base, locale: 'sv', slug: 'a', variant_option_labels: null },
              { ...base, locale: 'de', slug: 'b', variant_option_labels: DE },
            ],
            images: [],
            attributes: [],
            variants: [],
            faqs: [],
            custom_fields: [],
            shipping_profile_id: null,
            variant_option_config: null,
          }),
        ),
      },
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
    const data = trCreateMany.mock.calls[0][0].data;
    expect(data[0].variant_option_labels).toBe(Prisma.DbNull);
    expect(data[1].variant_option_labels).toEqual(DE);
  });
});
