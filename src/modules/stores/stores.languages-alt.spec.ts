import { Prisma } from '@prisma/client';
import { StoresService } from './stores.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';
import type { OrdersService } from '../orders/orders.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { MarketsService } from '../markets/markets.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import type { RedirectsService } from '../redirects/redirects.service';
import type { CorsOriginService } from '../../common/cors/cors-origin.service';

// M170 A: changing the store primary language keeps every image alt under
// the language it was written in (`alt_text` = alt of the primary language).

type ImageRow = {
  id: string;
  alt_text: string | null;
  alt_translations: Record<string, string> | null;
};

type UpdateArgs = { where: { id: string }; data: Record<string, unknown> };

function build(existingPrimary: string | null, images: ImageRow[]) {
  const update = jest.fn((args: UpdateArgs) => args);
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    store: { findUnique: jest.fn(() => Promise.resolve({ id: 's1' })) },
    storeLanguageConfig: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          existingPrimary ? { primary_locale: existingPrimary } : null,
        ),
      ),
      upsert: jest.fn(
        (args: {
          update: { primary_locale?: string; secondary_locales?: string[] };
        }) =>
          Promise.resolve({
            store_id: 's1',
            primary_locale:
              args.update.primary_locale ?? existingPrimary ?? 'en',
            secondary_locales: args.update.secondary_locales ?? [],
          }),
      ),
    },
    productImage: {
      findMany: jest.fn(() => Promise.resolve(images)),
      update,
    },
    $transaction: jest.fn((ops: unknown[]) => Promise.resolve(ops)),
  };
  const service = new StoresService(
    prisma as unknown as PrismaService,
    {
      revalidateStoreById: jest.fn(() => Promise.resolve()),
    } as unknown as RevalidationService,
    {} as OrdersService,
    {
      isEnabled: jest.fn(() => Promise.resolve(false)),
    } as unknown as StoreAppsService,
    {
      mirrorLanguagesIntoDefault: jest.fn(() => Promise.resolve()),
    } as unknown as MarketsService,
    {} as MarketsContextService,
    {} as RedirectsService,
    {} as CorsOriginService,
  );
  return { service, prisma, update };
}

describe('StoresService.updateLanguages: image alts follow the primary language', () => {
  const images: ImageRow[] = [
    {
      id: 'i1',
      alt_text: 'Röd dalahäst',
      alt_translations: { en: 'Red horse' },
    },
    {
      id: 'i2',
      alt_text: 'Blå häst',
      alt_translations: { de: 'Blaues Pferd' },
    },
    {
      id: 'i3',
      alt_text: null,
      alt_translations: { en: 'Green horse', de: 'Grün' },
    },
  ];

  it('sv -> en: swaps alt_text with the en alt, only on images that have one, in one transaction', async () => {
    const { service, prisma, update } = build('sv', images);
    await service.updateLanguages('u1', { primary_locale: 'en' });

    // Only this store's images that carry a map are read, column opted in.
    expect(prisma.productImage.findMany).toHaveBeenCalledWith({
      where: {
        product: { creator: { store: { id: 's1' } } },
        alt_translations: { not: Prisma.DbNull },
      },
      select: { id: true, alt_text: true, alt_translations: true },
    });
    expect(update.mock.calls.map(([a]) => a)).toEqual([
      {
        where: { id: 'i1' },
        data: {
          alt_text: 'Red horse',
          alt_translations: { sv: 'Röd dalahäst' },
        },
      },
      {
        where: { id: 'i3' },
        data: { alt_text: 'Green horse', alt_translations: { de: 'Grün' } },
      },
    ]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('a map emptied by the swap is stored as SQL NULL', async () => {
    const { service, update } = build('sv', [
      { id: 'i1', alt_text: null, alt_translations: { en: 'Red horse' } },
    ]);
    await service.updateLanguages('u1', { primary_locale: 'en' });
    expect(update.mock.calls[0][0].data).toEqual({
      alt_text: 'Red horse',
      alt_translations: Prisma.DbNull,
    });
  });

  it('no primary change (same value, or only secondary languages sent): images are not read', async () => {
    const { service, prisma } = build('sv', images);
    await service.updateLanguages('u1', { primary_locale: 'sv' });
    await service.updateLanguages('u1', { secondary_locales: ['en'] });
    expect(prisma.productImage.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a store without a config row was on the en default', async () => {
    const { service, update } = build(null, [
      {
        id: 'i1',
        alt_text: 'Red horse',
        alt_translations: { sv: 'Röd häst' },
      },
    ]);
    await service.updateLanguages('u1', { primary_locale: 'sv' });
    expect(update.mock.calls[0][0]).toEqual({
      where: { id: 'i1' },
      data: { alt_text: 'Röd häst', alt_translations: { en: 'Red horse' } },
    });
  });

  it('nothing to swap: no transaction is opened', async () => {
    const { service, prisma } = build('sv', [images[1]]);
    await service.updateLanguages('u1', { primary_locale: 'en' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
