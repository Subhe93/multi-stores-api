import { ConfigService } from '@nestjs/config';
import { MarketStatus, Prisma } from '@prisma/client';
import { MarketsService } from './markets.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsContextService } from './markets-context.service';
import { FxService } from './fx.service';
import { DomainsService } from './domains.service';
import { MarketPricingService } from './market-pricing.service';
import { PaymentCheckService } from './payment-check.service';
import type { CreateMarketDto } from './dto/market.dto';

// M156: the service persists locale_paths (validated), clears them with
// null / [], keeps them when omitted, and a later change of countries or
// locales turns rows inactive instead of failing.

const USER_ID = 'u1';
const STORE_ID = 's1';
const EU_COUNTRIES = [
  'DE',
  'FI',
  'AT',
  'NL',
  'BE',
  'FR',
  'ES',
  'IT',
  'IE',
  'PT',
];
const NAMEZ = [
  { path: 'de-de', locale: 'de', country: 'DE', hreflang: ['de-DE', 'de'] },
  { path: 'de-at', locale: 'de', country: 'AT', hreflang: ['de-AT'] },
  { path: 'fr-fr', locale: 'fr', country: 'FR', hreflang: ['fr-FR', 'fr'] },
  { path: 'fr-be', locale: 'fr', country: 'BE', hreflang: ['fr-BE'] },
  { path: 'nl-nl', locale: 'nl', country: 'NL', hreflang: ['nl-NL', 'nl'] },
  { path: 'nl-be', locale: 'nl', country: 'BE', hreflang: ['nl-BE'] },
  { path: 'ar', locale: 'ar', country: null, hreflang: ['ar'] },
];

type Row = Record<string, unknown> & { id: string; locale_paths: unknown };

function market(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    store_id: STORE_ID,
    key: id,
    name: id,
    countries: EU_COUNTRIES,
    default_locale: 'en',
    locales: ['de', 'fr', 'ar'],
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

/** Prisma writes DbNull as SQL NULL; the fake stores null. */
function stored(data: Record<string, unknown>): Record<string, unknown> {
  return data.locale_paths === Prisma.DbNull
    ? { ...data, locale_paths: null }
    : data;
}

function build(rows: Row[]) {
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
          Object.assign(row, stored(data));
          return Promise.resolve(row);
        },
      ),
      create: jest.fn(({ data }: { data: Row }) => {
        const row = market(`m-${String(data.key)}`, stored(data));
        rows.push(row);
        return Promise.resolve(row);
      }),
    },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'SEK' })),
    },
    platformFxRate: { findUnique: jest.fn(() => Promise.resolve(null)) },
    storeLanguageConfig: { upsert: jest.fn(() => Promise.resolve({})) },
    store: { update: jest.fn(() => Promise.resolve({})) },
  };
  const ctx = { invalidate: jest.fn() };
  const service = new MarketsService(
    prisma as unknown as PrismaService,
    { get: () => 'https://stores.platform.test' } as unknown as ConfigService,
    {
      revalidateStoreById: jest.fn(() => Promise.resolve()),
    } as unknown as RevalidationService,
    {} as StoreAppsService,
    ctx as unknown as MarketsContextService,
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
  return { service, prisma, ctx };
}

describe('MarketsService locale_paths (M156)', () => {
  it('update persists the validated rows and the view lists every row with its status', async () => {
    const rows = [market('m-eu')];
    const { service, ctx } = build(rows);
    const view = await service.update(USER_ID, 'm-eu', {
      locale_paths: NAMEZ,
    });
    expect(rows[0].locale_paths).toEqual(NAMEZ);
    expect(view.locale_paths.map((v) => [v.path, v.inactive_reason])).toEqual([
      ['de-de', null],
      ['de-at', null],
      ['fr-fr', null],
      ['fr-be', null],
      ['nl-nl', 'locale_unsupported'],
      ['nl-be', 'locale_unsupported'],
      ['ar', null],
    ]);
    expect(ctx.invalidate).toHaveBeenCalledWith(STORE_ID);
  });

  it('an invalid row is a 400 with its index and nothing is written', async () => {
    const rows = [market('m-eu')];
    const { service, prisma } = build(rows);
    await expect(
      service.update(USER_ID, 'm-eu', {
        locale_paths: [
          NAMEZ[0],
          { path: 'de-ch', locale: 'de', country: 'CH', hreflang: ['de-CH'] },
        ],
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'MARKET_LOCALE_PATH_COUNTRY', index: 1 },
    });
    expect(prisma.market.update).not.toHaveBeenCalled();
    expect(rows[0].locale_paths).toBeNull();
  });

  it('validates against the countries and default locale sent in the same body', async () => {
    const rows = [market('m-eu', { countries: ['DE'] })];
    const { service } = build(rows);
    // AT arrives in the same request: accepted.
    await service.update(USER_ID, 'm-eu', {
      countries: ['DE', 'AT'],
      locale_paths: [NAMEZ[1]],
    });
    expect(rows[0].locale_paths).toEqual([NAMEZ[1]]);
    // A new default locale `de` makes a de row invalid.
    await expect(
      service.update(USER_ID, 'm-eu', {
        default_locale: 'de',
        locales: ['en'],
        locale_paths: [NAMEZ[1]],
      }),
    ).rejects.toMatchObject({
      response: { code: 'MARKET_LOCALE_PATH_DEFAULT_LOCALE', index: 0 },
    });
  });

  it('omitted keeps the rows; the write carries no locale_paths', async () => {
    const rows = [market('m-eu', { locale_paths: NAMEZ })];
    const { service, prisma } = build(rows);
    await service.update(USER_ID, 'm-eu', { name: 'EU' });
    expect(rows[0].locale_paths).toEqual(NAMEZ);
    expect(prisma.market.update.mock.calls[0][0].data).not.toHaveProperty(
      'locale_paths',
    );
  });

  it.each([
    ['null', null],
    ['[]', []],
  ])('%s clears the column to SQL NULL (DbNull)', async (_l, value) => {
    const rows = [market('m-eu', { locale_paths: NAMEZ })];
    const { service, prisma } = build(rows);
    const view = await service.update(USER_ID, 'm-eu', {
      locale_paths: value,
    });
    expect(prisma.market.update.mock.calls[0][0].data.locale_paths).toBe(
      Prisma.DbNull,
    );
    expect(rows[0].locale_paths).toBeNull();
    expect(view.locale_paths).toEqual([]);
  });

  it('a later countries change makes a row country_not_in_market, no 400', async () => {
    const rows = [market('m-eu', { locale_paths: NAMEZ })];
    const { service } = build(rows);
    const view = await service.update(USER_ID, 'm-eu', {
      countries: ['DE', 'FR', 'BE', 'NL'],
    });
    const at = view.locale_paths.find((v) => v.path === 'de-at')!;
    expect(at).toMatchObject({
      active: false,
      inactive_reason: 'country_not_in_market',
    });
    expect(rows[0].locale_paths).toEqual(NAMEZ);
  });

  it('a later locales change makes rows locale_not_enabled, no 400', async () => {
    const rows = [market('m-eu', { locale_paths: NAMEZ })];
    const { service } = build(rows);
    const view = await service.update(USER_ID, 'm-eu', { locales: ['de'] });
    expect(
      view.locale_paths
        .filter((v) => v.inactive_reason === 'locale_not_enabled')
        .map((v) => v.path),
    ).toEqual(['fr-fr', 'fr-be', 'ar']);
  });

  it('create stores the rows; without them the column stays unset', async () => {
    const dto = {
      key: 'eu',
      name: 'EU',
      countries: EU_COUNTRIES,
      default_locale: 'en',
      locales: ['de', 'fr', 'ar'],
      currency: 'SEK',
    } as CreateMarketDto;
    const rows: Row[] = [];
    const { service, prisma } = build(rows);
    const view = await service.create(USER_ID, { ...dto, locale_paths: NAMEZ });
    expect(prisma.market.create.mock.calls[0][0].data.locale_paths).toEqual(
      NAMEZ,
    );
    expect(view.locale_paths).toHaveLength(7);

    await service.create(USER_ID, { ...dto, key: 'us' });
    await service.create(USER_ID, { ...dto, key: 'uk', locale_paths: null });
    for (const call of prisma.market.create.mock.calls.slice(1)) {
      expect(call[0].data).not.toHaveProperty('locale_paths');
    }
  });

  it('regression: a market without the column reads locale_paths []', async () => {
    const rows = [market('m-eu')];
    const { service } = build(rows);
    expect((await service.get(USER_ID, 'm-eu')).locale_paths).toEqual([]);
  });
});
