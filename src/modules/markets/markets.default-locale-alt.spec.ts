import { ConfigService } from '@nestjs/config';
import { MarketStatus } from '@prisma/client';
import { MarketsService } from './markets.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsContextService } from './markets-context.service';
import { FxService } from './fx.service';
import { DomainsService } from './domains.service';
import { MarketPricingService } from './market-pricing.service';
import { PaymentCheckService } from './payment-check.service';

// M170 A: with the markets app on, the default market's `default_locale` IS
// the store primary language. Changing it there must move the image alts the
// same way the languages page does (swapPrimaryAlt).

const USER_ID = 'u1';
const STORE_ID = 's1';

type Row = Record<string, unknown> & { id: string };
type UpdateArgs = { where: { id: string }; data: Record<string, unknown> };

function market(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    store_id: STORE_ID,
    key: id,
    name: id,
    countries: ['SE'],
    default_locale: 'sv',
    locales: ['en'],
    currency: 'SEK',
    is_default: false,
    is_x_default: false,
    status: MarketStatus.DRAFT,
    indexing: 'AUTO',
    price_rule: { mode: 'convert', source: 'manual', rate: 1 },
    payment_check: null,
    domains: [],
    locale_paths: null,
    ...over,
  };
}

function build(rows: Row[]) {
  const imageUpdate = jest.fn((args: UpdateArgs) => args);
  const prisma = {
    creator: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          store: {
            id: STORE_ID,
            slug: 'namez-se',
            name: 'Namez',
            creator_id: 'c1',
            store_type: 'INDEPENDENT',
            currency: 'SEK',
          },
        }),
      ),
    },
    market: {
      findFirst: jest.fn(({ where }: { where: { id?: string } }) =>
        Promise.resolve(rows.find((r) => r.id === where.id) ?? null),
      ),
      findUnique: jest.fn(() => Promise.resolve(null)),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Row }) => {
          const row = rows.find((r) => r.id === where.id)!;
          // Copy: `update` must see the row as it was before the write.
          const next = { ...row, ...data };
          rows[rows.indexOf(row)] = next;
          return Promise.resolve(next);
        },
      ),
    },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'SEK' })),
    },
    platformFxRate: { findUnique: jest.fn(() => Promise.resolve(null)) },
    storeLanguageConfig: { upsert: jest.fn(() => Promise.resolve({})) },
    store: { update: jest.fn(() => Promise.resolve({})) },
    productImage: {
      findMany: jest.fn(() =>
        Promise.resolve([
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
        ]),
      ),
      update: imageUpdate,
    },
    $transaction: jest.fn((ops: unknown[]) => Promise.resolve(ops)),
  };
  const service = new MarketsService(
    prisma as unknown as PrismaService,
    { get: () => 'https://stores.platform.test' } as unknown as ConfigService,
    {
      revalidateStoreById: jest.fn(() => Promise.resolve()),
    } as unknown as RevalidationService,
    {} as StoreAppsService,
    { invalidate: jest.fn() } as unknown as MarketsContextService,
    new FxService(prisma as unknown as PrismaService),
    { toView: (d: unknown) => d } as unknown as DomainsService,
    {} as MarketPricingService,
    {
      checkMarket: jest.fn(() => Promise.resolve({ providers: [] })),
    } as unknown as PaymentCheckService,
  );
  jest
    .spyOn(service, 'ensureDefaultMarket')
    .mockResolvedValue(undefined as never);
  return { service, prisma, imageUpdate };
}

describe('MarketsService.update: image alts follow the default market locale (M170)', () => {
  it('default market sv -> en: the en alt becomes alt_text, the old default moves under sv', async () => {
    const { service, prisma, imageUpdate } = build([
      market('m-default', { is_default: true }),
    ]);
    await service.update(USER_ID, 'm-default', {
      default_locale: 'en',
      locales: ['sv'],
    });
    expect(prisma.storeLanguageConfig.upsert).toHaveBeenCalledTimes(1);
    expect(imageUpdate.mock.calls.map(([a]) => a)).toEqual([
      {
        where: { id: 'i1' },
        data: {
          alt_text: 'Red horse',
          alt_translations: { sv: 'Röd dalahäst' },
        },
      },
    ]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('default market, only the secondary locales change: images are not read', async () => {
    const { service, prisma } = build([
      market('m-default', { is_default: true }),
    ]);
    await service.update(USER_ID, 'm-default', { locales: ['en', 'de'] });
    expect(prisma.storeLanguageConfig.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.productImage.findMany).not.toHaveBeenCalled();
  });

  it('a non-default market changing its default locale never touches the images', async () => {
    const { service, prisma } = build([market('m-eu')]);
    await service.update(USER_ID, 'm-eu', {
      default_locale: 'en',
      locales: ['sv'],
    });
    expect(prisma.storeLanguageConfig.upsert).not.toHaveBeenCalled();
    expect(prisma.productImage.findMany).not.toHaveBeenCalled();
  });
});
