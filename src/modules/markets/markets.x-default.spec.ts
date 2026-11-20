import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { MarketStatus, Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MarketsService } from './markets.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsContextService } from './markets-context.service';
import { FxService } from './fx.service';
import { DomainsService } from './domains.service';
import { MarketPricingService } from './market-pricing.service';
import { PaymentCheckService } from './payment-check.service';
import { toMarketRoute, type MarketContext } from './market-context';
import { CreateMarketDto, UpdateMarketDto } from './dto/market.dto';

const USER_ID = 'u1';
const STORE_ID = 's1';

type Row = {
  id: string;
  store_id: string;
  key: string;
  name: string;
  countries: string[];
  default_locale: string;
  locales: string[];
  currency: string;
  is_default: boolean;
  is_x_default: boolean;
  status: MarketStatus;
  indexing: 'AUTO';
  price_rule: unknown;
  payment_check: unknown;
  domains: unknown[];
};

function market(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    store_id: STORE_ID,
    key: id,
    name: id,
    countries: [],
    default_locale: 'en',
    locales: [],
    currency: 'SEK',
    is_default: false,
    is_x_default: false,
    status: MarketStatus.LIVE,
    indexing: 'AUTO',
    price_rule: { mode: 'convert', source: 'manual', rate: 1 },
    payment_check: null,
    domains: [],
    ...over,
  };
}

/**
 * In-memory Market table that enforces the partial unique index
 * "Market_store_x_default_key" like Postgres would (checked after each
 * write), so the service is tested against the real constraint.
 */
function makePrisma(rows: Row[]) {
  const assertIndex = () => {
    const chosen = rows.filter((r) => r.is_x_default);
    if (new Set(chosen.map((r) => r.store_id)).size !== chosen.length) {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: 'test',
      });
    }
  };
  return {
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
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          const row = rows.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          try {
            assertIndex();
          } catch (err) {
            return Promise.reject(err);
          }
          return Promise.resolve(row);
        },
      ),
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: {
            store_id: string;
            is_x_default: boolean;
            id: { not: string };
          };
          data: Partial<Row>;
        }) => {
          const hit = rows.filter(
            (r) =>
              r.store_id === where.store_id &&
              r.is_x_default === where.is_x_default &&
              r.id !== where.id.not,
          );
          for (const r of hit) Object.assign(r, data);
          return Promise.resolve({ count: hit.length });
        },
      ),
    },
    // Array form only. The fakes run eagerly in call order (updateMany
    // before update), matching the sequential transaction semantics.
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'SEK' })),
    },
    platformFxRate: { findUnique: jest.fn(() => Promise.resolve(null)) },
    storeLanguageConfig: { upsert: jest.fn(() => Promise.resolve({})) },
    store: { update: jest.fn(() => Promise.resolve({})) },
  };
}

function build(rows: Row[]) {
  const prisma = makePrisma(rows);
  const ctx = { invalidate: jest.fn() };
  const revalidation = {
    revalidateStoreById: jest.fn(() => Promise.resolve()),
  };
  const service = new MarketsService(
    prisma as unknown as PrismaService,
    { get: () => 'https://stores.platform.test' } as unknown as ConfigService,
    revalidation as unknown as RevalidationService,
    {} as StoreAppsService,
    ctx as unknown as MarketsContextService,
    new FxService(prisma as unknown as PrismaService),
    { toView: (d: unknown) => d } as unknown as DomainsService,
    {} as MarketPricingService,
    {} as PaymentCheckService,
  );
  return { service, prisma, ctx };
}

describe('MarketsService.update is_x_default (one per store)', () => {
  it('sets the flag and clears it on every other market of the store', async () => {
    const rows = [
      market('m-se', { is_default: true }),
      market('m-eu'),
      market('m-us', { is_x_default: true }),
    ];
    const { service, prisma, ctx } = build(rows);
    const view = await service.update(USER_ID, 'm-eu', { is_x_default: true });
    expect(view.is_x_default).toBe(true);
    expect(rows.filter((r) => r.is_x_default).map((r) => r.id)).toEqual([
      'm-eu',
    ]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.market.updateMany).toHaveBeenCalledWith({
      where: { store_id: STORE_ID, is_x_default: true, id: { not: 'm-eu' } },
      data: { is_x_default: false },
    });
    expect(ctx.invalidate).toHaveBeenCalledWith(STORE_ID);
  });

  it('false unsets it without a transaction; other markets are untouched', async () => {
    const rows = [
      market('m-se', { is_default: true }),
      market('m-eu', { is_x_default: true }),
    ];
    const { service, prisma } = build(rows);
    const view = await service.update(USER_ID, 'm-eu', {
      is_x_default: false,
    });
    expect(view.is_x_default).toBe(false);
    expect(rows.some((r) => r.is_x_default)).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.market.updateMany).not.toHaveBeenCalled();
  });

  it('omitted or null leaves the flag unchanged', async () => {
    const rows = [
      market('m-se', { is_default: true }),
      market('m-eu', { is_x_default: true }),
    ];
    const { service, prisma } = build(rows);
    await service.update(USER_ID, 'm-eu', { name: 'EU' });
    await service.update(USER_ID, 'm-eu', {
      is_x_default: null as unknown as boolean,
    });
    expect(rows[1]!.is_x_default).toBe(true);
    for (const call of prisma.market.update.mock.calls) {
      expect(call[0].data).not.toHaveProperty('is_x_default');
    }
  });

  it('a lost race on the unique index becomes a friendly 409', async () => {
    const rows = [market('m-eu'), market('m-us', { is_x_default: true })];
    const { service, prisma } = build(rows);
    // Simulate a concurrent writer: the clearing step misses m-us.
    prisma.market.updateMany.mockImplementationOnce(() =>
      Promise.resolve({ count: 0 }),
    );
    await expect(
      service.update(USER_ID, 'm-eu', { is_x_default: true }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'MARKET_X_DEFAULT_CONFLICT' },
    });
  });
});

describe('Market DTOs is_x_default', () => {
  async function errorsFor(
    cls: typeof UpdateMarketDto,
    body: Record<string, unknown>,
  ): Promise<string[]> {
    const errors = await validate(plainToInstance(cls, body), {
      skipMissingProperties: true,
    });
    return errors.map((e) => e.property);
  }

  it.each([CreateMarketDto, UpdateMarketDto])(
    '%p accepts booleans only',
    async (cls) => {
      for (const ok of [true, false]) {
        expect(await errorsFor(cls, { is_x_default: ok })).toEqual([]);
      }
      expect(await errorsFor(cls, {})).toEqual([]);
      for (const bad of ['true', 1, 'eu']) {
        expect(await errorsFor(cls, { is_x_default: bad })).toEqual([
          'is_x_default',
        ]);
      }
    },
  );
});

describe('toMarketRoute is_x_default', () => {
  const base: MarketContext = {
    id: 'm-eu',
    key: 'eu',
    name: 'EU',
    countries: ['DE'],
    defaultLocale: 'en',
    locales: ['de'],
    currency: 'EUR',
    storeCurrency: 'SEK',
    rate: 0.09,
    priceRule: { mode: 'convert', source: 'manual', rate: 0.09 },
    isDefault: false,
    status: 'LIVE',
    indexing: 'AUTO',
    primaryHostname: 'namez.shop',
    hostnames: ['namez.shop'],
  };

  it('is absent unless chosen, so existing payloads are unchanged', () => {
    expect(toMarketRoute(base)).not.toHaveProperty('is_x_default');
    expect(toMarketRoute({ ...base, isXDefault: false })).not.toHaveProperty(
      'is_x_default',
    );
    expect(toMarketRoute({ ...base, isXDefault: true }).is_x_default).toBe(
      true,
    );
    expect(
      toMarketRoute({ ...base, isXDefault: true, preview: true }).is_x_default,
    ).toBe(true);
  });
});
