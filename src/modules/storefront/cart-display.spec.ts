import { NotFoundException } from '@nestjs/common';
import { StoreStatus } from '@prisma/client';
import { resolveCartDisplay, type CartDisplayData } from './cart-display';
import { StorefrontService } from './storefront.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import type { MarketPricingService } from '../markets/market-pricing.service';
import type { TaxService } from '../taxes/tax.service';

// M160: guest cart line titles / variant labels in the page locale.

const DE_LABELS = {
  names: { Färg: 'Farbe', Storlek: 'Größe' },
  values: { Färg: { Silver: 'Silber' } },
};

const product = {
  id: 'p1',
  translations: [
    { locale: 'sv', title: 'Dalahäst silver', variant_option_labels: null },
    { locale: 'en', title: 'Dala horse silver', variant_option_labels: null },
    {
      locale: 'fr',
      title: 'Cheval de Dalécarlie',
      variant_option_labels: null,
    },
    {
      locale: 'de',
      title: 'Dalapferd Silber',
      variant_option_labels: DE_LABELS,
    },
  ],
};

const blank = {
  id: 'p2',
  translations: [
    { locale: 'sv', title: 'T-shirt', variant_option_labels: null },
    { locale: 'de', title: 'T-Shirt', variant_option_labels: DE_LABELS },
  ],
};

function data(): CartDisplayData {
  return {
    products: new Map([[product.id, product]]),
    customProducts: new Map([
      [
        'cp1',
        {
          id: 'cp1',
          product_id: 'p2',
          translations: [{ locale: 'sv', title: 'Min tröja' }],
          product: { translations: blank.translations },
        },
      ],
    ]),
    variants: new Map([
      [
        'v1',
        {
          id: 'v1',
          product_id: 'p1',
          options: { Färg: 'Silver', Storlek: 'M' },
        },
      ],
      ['v2', { id: 'v2', product_id: 'p2', options: { Färg: 'Silver' } }],
    ]),
  };
}

describe('resolveCartDisplay', () => {
  it('title and variant label in the request locale', () => {
    const [entry] = resolveCartDisplay(
      [{ product_id: 'p1', variant_id: 'v1' }],
      data(),
      'de',
      'sv',
    );
    expect(entry).toEqual({
      title: 'Dalapferd Silber',
      variant: 'Farbe: Silber / Größe: M',
    });
  });

  it('regional locale uses the base language', () => {
    const [entry] = resolveCartDisplay(
      [{ product_id: 'p1', variant_id: 'v1' }],
      data(),
      'de-AT',
      'sv',
    );
    expect(entry?.title).toBe('Dalapferd Silber');
    expect(entry?.variant).toBe('Farbe: Silber / Größe: M');
  });

  it('a missing locale falls back to the store canonical title; labels stay canonical keys', () => {
    const [entry] = resolveCartDisplay(
      [{ product_id: 'p1', variant_id: 'v1' }],
      data(),
      'it',
      'sv',
    );
    expect(entry).toEqual({
      title: 'Dalahäst silver',
      variant: 'Färg: Silver / Storlek: M',
    });
  });

  it('custom product: own title, else the base product title; variant of the base product', () => {
    const [sv, de] = resolveCartDisplay(
      [
        { custom_product_id: 'cp1', variant_id: 'v2' },
        { custom_product_id: 'cp1', product_id: 'cp1', variant_id: 'v2' },
      ],
      data(),
      'de',
      'sv',
    );
    // No de row on the custom product: canonical sv custom title wins over the base product.
    expect(sv).toEqual({ title: 'Min tröja', variant: 'Farbe: Silber' });
    expect(de).toEqual(sv);
  });

  it('a variant of another product gives no label', () => {
    const [entry] = resolveCartDisplay(
      [{ product_id: 'p1', variant_id: 'v2' }],
      data(),
      'de',
      'sv',
    );
    expect(entry).toEqual({ title: 'Dalapferd Silber', variant: null });
  });

  it('unknown / foreign products and empty lines answer null, order kept', () => {
    const out = resolveCartDisplay(
      [
        { product_id: 'nope' },
        { product_id: 'p1' },
        {},
        { custom_product_id: 'x' },
      ],
      data(),
      'de',
      'sv',
    );
    expect(out).toEqual([
      null,
      { title: 'Dalapferd Silber', variant: null },
      null,
      null,
    ]);
  });
});

describe('StorefrontService.getCartDisplay', () => {
  function build(status: StoreStatus | null) {
    const prisma = {
      store: {
        findUnique: jest.fn(() =>
          Promise.resolve(
            status === null
              ? null
              : {
                  id: 's1',
                  slug: 'namez',
                  status,
                  creator: { id: 'c1' },
                  language_config: { primary_locale: 'sv' },
                },
          ),
        ),
      },
      product: {
        findMany: jest.fn(
          ({
            where,
          }: {
            where: { id: { in: string[] }; creator_id: string; status: string };
          }) =>
            Promise.resolve(
              where.creator_id === 'c1' && where.status === 'PUBLISHED'
                ? [product].filter((p) => where.id.in.includes(p.id))
                : [],
            ),
        ),
      },
      customProduct: { findMany: jest.fn(() => Promise.resolve([])) },
      productVariant: {
        findMany: jest.fn(() =>
          Promise.resolve([
            { id: 'v1', product_id: 'p1', options: { Färg: 'Silver' } },
          ]),
        ),
      },
    };
    const service = new StorefrontService(
      prisma as unknown as PrismaService,
      {} as StoreAppsService,
      {} as MarketsContextService,
      {} as MarketPricingService,
      {} as TaxService,
    );
    return { service, prisma };
  }

  it('answers own published products, null for others', async () => {
    const { service, prisma } = build(StoreStatus.LIVE);
    const res = await service.getCartDisplay('namez', {
      locale: 'de',
      lines: [
        { product_id: 'p1', variant_id: 'v1' },
        { product_id: 'foreign' },
      ],
    });
    expect(res.items).toEqual([
      { title: 'Dalapferd Silber', variant: 'Farbe: Silber' },
      null,
    ]);
    const where = (
      prisma.product.findMany.mock.calls[0] as unknown as [
        { where: Record<string, unknown> },
      ]
    )[0].where;
    expect(where).toMatchObject({ creator_id: 'c1', status: 'PUBLISHED' });
    expect(prisma.customProduct.findMany).not.toHaveBeenCalled();
  });

  it('a closed store answers nulls without reading products', async () => {
    const { service, prisma } = build(StoreStatus.DRAFT);
    const res = await service.getCartDisplay('namez', {
      locale: 'de',
      lines: [{ product_id: 'p1' }, { product_id: 'p1' }],
    });
    expect(res.items).toEqual([null, null]);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it('an unknown store is a 404', async () => {
    const { service } = build(null);
    await expect(
      service.getCartDisplay('x', { lines: [] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
