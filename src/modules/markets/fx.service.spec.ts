import { FxService } from './fx.service';
import { PrismaService } from '../../prisma/prisma.service';

// The admin-maintained platform FX table: lookup (direct / inverse) and the
// delete endpoint's contract (refreshed list, 404 when missing).

type Row = {
  id: string;
  base: string;
  quote: string;
  rate: number;
  updated_at: Date;
};

type LiveMarket = {
  key: string;
  currency: string;
  source: 'platform' | 'manual';
  storeCurrency: string;
};

function makePrisma(
  seed: { base: string; quote: string; rate: number }[],
  liveMarkets: LiveMarket[] = [],
) {
  const rows: Row[] = seed.map((r, i) => ({
    id: `fx${i}`,
    ...r,
    updated_at: new Date(),
  }));
  const byKey = (base: string, quote: string) =>
    rows.find((r) => r.base === base && r.quote === quote) ?? null;
  return {
    rows,
    platformFxRate: {
      findUnique: jest.fn(
        ({
          where,
        }: {
          where: { base_quote: { base: string; quote: string } };
        }) =>
          Promise.resolve(byKey(where.base_quote.base, where.base_quote.quote)),
      ),
      findMany: jest.fn(() => Promise.resolve([...rows])),
      delete: jest.fn(({ where }: { where: { id: string } }) => {
        rows.splice(
          rows.findIndex((r) => r.id === where.id),
          1,
        );
        return Promise.resolve({});
      }),
      upsert: jest.fn(),
    },
    market: {
      findMany: jest.fn(() =>
        Promise.resolve(
          liveMarkets.map((m) => ({
            key: m.key,
            currency: m.currency,
            price_rule: { mode: 'convert', source: m.source },
            store: {
              slug: 'namez',
              store_type: 'INDEPENDENT',
              currency: m.storeCurrency,
            },
          })),
        ),
      ),
    },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'EUR' })),
    },
  };
}

function build(
  seed: { base: string; quote: string; rate: number }[],
  liveMarkets: LiveMarket[] = [],
) {
  const prisma = makePrisma(seed, liveMarkets);
  return { service: new FxService(prisma as unknown as PrismaService), prisma };
}

describe('FxService.getRate', () => {
  it('is 1 for the same currency, direct row, inverse row, else null', async () => {
    const { service } = build([{ base: 'SEK', quote: 'EUR', rate: 0.09 }]);
    expect(await service.getRate('SEK', 'sek')).toBe(1);
    expect(await service.getRate('sek', 'eur')).toBe(0.09);
    expect(await service.getRate('EUR', 'SEK')).toBeCloseTo(1 / 0.09);
    expect(await service.getRate('SEK', 'DKK')).toBeNull();
  });
});

describe('FxService.deleteRate', () => {
  it('removes the pair (case-insensitive) and answers the refreshed list', async () => {
    const { service, prisma } = build([
      { base: 'SEK', quote: 'EUR', rate: 0.09 },
      { base: 'SEK', quote: 'DKK', rate: 0.65 },
    ]);
    const list = await service.deleteRate('sek', 'eur');
    expect(list).toEqual([
      {
        base: 'SEK',
        quote: 'DKK',
        rate: 0.65,
        updated_at: expect.any(Date) as Date,
      },
    ]);
    expect(prisma.platformFxRate.delete).toHaveBeenCalledTimes(1);
  });

  it('409s FX_RATE_IN_USE while a LIVE market converts through the pair (either direction)', async () => {
    const seed = [{ base: 'SEK', quote: 'EUR', rate: 0.09 }];
    for (const m of [
      {
        key: 'eu',
        currency: 'EUR',
        source: 'platform' as const,
        storeCurrency: 'SEK',
      },
      {
        key: 'se',
        currency: 'SEK',
        source: 'platform' as const,
        storeCurrency: 'EUR',
      },
    ]) {
      const { service, prisma } = build(seed, [m]);
      await expect(service.deleteRate('SEK', 'EUR')).rejects.toMatchObject({
        response: { code: 'FX_RATE_IN_USE' },
      });
      expect(prisma.platformFxRate.delete).not.toHaveBeenCalled();
    }
    // A manual-rate market or an unrelated pair does not block.
    const free = build(seed, [
      { key: 'eu', currency: 'EUR', source: 'manual', storeCurrency: 'SEK' },
      { key: 'dk', currency: 'DKK', source: 'platform', storeCurrency: 'SEK' },
    ]);
    expect(await free.service.deleteRate('SEK', 'EUR')).toEqual([]);
  });

  it('notifies rate listeners after upsert and delete', async () => {
    const { service, prisma } = build([
      { base: 'SEK', quote: 'EUR', rate: 0.09 },
    ]);
    const listener = jest.fn();
    service.onRatesChanged(listener);
    prisma.platformFxRate.upsert.mockResolvedValue({});
    await service.upsertRates([{ base: 'sek', quote: 'dkk', rate: 0.65 }]);
    await service.deleteRate('SEK', 'EUR');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('404s FX_RATE_NOT_FOUND when the pair does not exist', async () => {
    const { service, prisma } = build([
      { base: 'SEK', quote: 'EUR', rate: 0.09 },
    ]);
    await expect(service.deleteRate('EUR', 'SEK')).rejects.toMatchObject({
      response: { code: 'FX_RATE_NOT_FOUND' },
    });
    expect(prisma.platformFxRate.delete).not.toHaveBeenCalled();
  });
});
