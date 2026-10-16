import { UserRole } from '@prisma/client';
import { ProductsService } from './products.service';
import type { PrismaService } from '../../prisma/prisma.service';

// M4.4 X19/X20: product saves delete and recreate every translation, so a
// translation that omits `short_description` keeps the stored value of its
// locale (null/'' clears it); duplicate() copies it, never external refs.

type Row = Record<string, unknown>;

function updateSetup(
  stored: { locale: string; short_description: string | null }[],
) {
  const createMany = jest.fn();
  const findMany = jest.fn(() => Promise.resolve(stored));
  const prisma = {
    product: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'p1',
          creator_id: 'c1',
          variant_option_config: null,
        }),
      ),
      update: jest.fn(),
    },
    productTranslation: {
      findMany,
      deleteMany: jest.fn(),
      createMany,
    },
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
  internals.revalidateForCreator = jest.fn(() => Promise.resolve());
  internals.findById = jest.fn((id: string) => Promise.resolve({ id }));
  const written = () => (createMany.mock.calls[0][0] as { data: Row[] }).data;
  return { svc, findMany, written };
}

const tr = (locale: string, extra: Row = {}) => ({
  locale,
  title: `T-${locale}`,
  description: 'd',
  slug: `s-${locale}`,
  ...extra,
});

describe('ProductsService.update short_description carry-over (X19)', () => {
  it('undefined keeps the stored value per locale', async () => {
    const { svc, written } = updateSetup([
      { locale: 'sv', short_description: '<p>Kort</p>' },
      { locale: 'en', short_description: null },
    ]);
    await svc.update('p1', 'u', UserRole.CREATOR, {
      translations: [tr('sv'), tr('en'), tr('de')],
    });
    expect(written().map((r) => [r.locale, r.short_description])).toEqual([
      ['sv', '<p>Kort</p>'],
      ['en', null],
      ['de', null],
    ]);
  });

  it('a sent value replaces it; null or empty clears it', async () => {
    const { svc, written } = updateSetup([
      { locale: 'sv', short_description: '<p>Old</p>' },
      { locale: 'en', short_description: '<p>Old</p>' },
    ]);
    await svc.update('p1', 'u', UserRole.CREATOR, {
      translations: [
        tr('sv', { short_description: '<p>New</p>' }),
        tr('en', { short_description: null }),
      ],
    });
    expect(written().map((r) => [r.locale, r.short_description])).toEqual([
      ['sv', '<p>New</p>'],
      ['en', null],
    ]);
  });

  it('skips the extra read when every row carries the field', async () => {
    const { svc, findMany, written } = updateSetup([]);
    await svc.update('p1', 'u', UserRole.CREATOR, {
      translations: [tr('sv', { short_description: '' })],
    });
    expect(findMany).not.toHaveBeenCalled();
    expect(written()[0].short_description).toBeNull();
  });

  it('no translations in the payload: translations untouched', async () => {
    const { svc, findMany } = updateSetup([]);
    await svc.update('p1', 'u', UserRole.CREATOR, { base_price: 10 });
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('ProductsService.duplicate short_description (X20)', () => {
  it('copies short_description; external refs are not copied', async () => {
    const productCreate = jest.fn((_args: { data: Row }) =>
      Promise.resolve({ id: 'new-product' }),
    );
    const variantCreate = jest.fn((_args: { data: Row }) =>
      Promise.resolve({ id: 'new-v' }),
    );
    const trCreateMany = jest.fn();
    const tx = {
      product: { create: productCreate },
      productTranslation: { createMany: trCreateMany },
      productTag: { createMany: jest.fn() },
      productAttribute: { createMany: jest.fn() },
      productVariant: { create: variantCreate },
      productImage: { createMany: jest.fn() },
      productFaq: { create: jest.fn() },
      productCustomField: { create: jest.fn() },
    };
    const prisma = {
      product: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            id: 'src',
            external_ref: 'woo:namez.se:product:2229',
            translations: [
              {
                locale: 'sv',
                title: 'Namnskylt',
                description: 'd',
                slug: 'namnskylt',
                meta_title: null,
                meta_desc: null,
                short_description: '<p>Kort</p>',
              },
            ],
            images: [],
            attributes: [],
            variants: [
              {
                id: 'v1',
                external_ref: 'woo:namez.se:variation:2230',
                price_adjustment: 0,
                compare_at_price: null,
                stock_quantity: null,
                is_active: true,
                options: { Färg: 'Röd' },
              },
            ],
            tags: [],
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

    expect(trCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      locale: 'sv',
      short_description: '<p>Kort</p>',
    });
    expect(productCreate.mock.calls[0][0].data).not.toHaveProperty(
      'external_ref',
    );
    expect(variantCreate.mock.calls[0][0].data).not.toHaveProperty(
      'external_ref',
    );
  });
});
