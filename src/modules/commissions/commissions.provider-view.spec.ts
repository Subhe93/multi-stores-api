import { UserRole } from '@prisma/client';
import { CommissionsService } from './commissions.service';
import type { PrismaService } from '../../prisma/prisma.service';

// Supplier privacy between providers: on an order shared by two providers
// the commission split must not give one provider the other's amount
// (with two providers that is the other one's cost price x quantity).

const sharedLines = [
  {
    fulfiller_type: 'PROVIDER',
    fulfiller_id: 'prov-newroj',
    provider_base_amount: 90,
  },
  {
    fulfiller_type: 'PROVIDER',
    fulfiller_id: 'prov-x',
    provider_base_amount: 40,
  },
  { fulfiller_type: 'CREATOR', fulfiller_id: 'c1', provider_base_amount: 0 },
];
const ownLinesOnly = sharedLines.filter(
  (l) => l.fulfiller_id !== 'prov-newroj',
);

const commission = (provider_amount: number) => ({
  id: 'com1',
  order_id: 'o1',
  provider_amount,
  platform_amount: 30,
  creator_amount: 100,
  vat_amount: 80,
  currency: 'SEK',
  status: 'PENDING',
  created_at: new Date('2026-11-18T10:00:00Z'),
});

function setup(lines: typeof sharedLines, providerAmount: number) {
  const prisma = {
    order: {
      findUnique: jest.fn(() =>
        Promise.resolve({ store_id: 's1', deleted_at: null, items: lines }),
      ),
    },
    provider: {
      findUnique: jest.fn(() => Promise.resolve({ id: 'prov-x' })),
    },
    creator: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'c1', store: { id: 's1' } }),
      ),
    },
    orderCommission: {
      findUnique: jest.fn(() => Promise.resolve(commission(providerAmount))),
      findMany: jest.fn(() =>
        Promise.resolve([
          { ...commission(providerAmount), order: { items: lines } },
        ]),
      ),
    },
  };
  return {
    svc: new CommissionsService(prisma as unknown as PrismaService),
    prisma,
  };
}

describe('GET /commissions/order/:id as PROVIDER', () => {
  it('shared order: its own share only, platform and creator amounts hidden', async () => {
    const { svc } = setup(sharedLines, 130);
    const res = await svc.getByOrder('o1', 'u-prov-x', UserRole.PROVIDER);
    expect(res).toMatchObject({
      provider_amount: 40,
      platform_amount: null,
      creator_amount: null,
    });
  });

  it('order with no other provider: the whole split as before', async () => {
    const { svc } = setup(ownLinesOnly, 40);
    const res = await svc.getByOrder('o1', 'u-prov-x', UserRole.PROVIDER);
    expect(res).toMatchObject({
      provider_amount: 40,
      platform_amount: 30,
      creator_amount: 100,
    });
  });

  it('a provider that fulfils no line of the order: 403', async () => {
    const { svc } = setup(
      sharedLines.filter((l) => l.fulfiller_id !== 'prov-x'),
      90,
    );
    await expect(
      svc.getByOrder('o1', 'u-prov-x', UserRole.PROVIDER),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('the store creator keeps the whole split', async () => {
    const { svc } = setup(sharedLines, 130);
    const res = await svc.getByOrder('o1', 'u-creator', UserRole.CREATOR);
    expect(res).toMatchObject({
      provider_amount: 130,
      platform_amount: 30,
      creator_amount: 100,
    });
  });
});

describe('GET /commissions/summary as provider', () => {
  it('counts its own share of a shared order, not the aggregate', async () => {
    const { svc, prisma } = setup(sharedLines, 130);
    const res = await svc.getSummary('u-prov-x', 'provider');
    expect(res.total_earnings).toBe(40);
    expect(res.pending).toBe(40);
    expect(prisma.orderCommission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          order: {
            select: {
              items: {
                select: {
                  fulfiller_type: true,
                  fulfiller_id: true,
                  provider_base_amount: true,
                },
              },
            },
          },
        },
      }),
    );
  });

  it('the creator summary is unchanged (no order lines loaded)', async () => {
    const { svc, prisma } = setup(sharedLines, 130);
    const res = await svc.getSummary('u-creator', 'creator');
    expect(res.total_earnings).toBe(100);
    const args = (
      prisma.orderCommission.findMany.mock.calls[0] as unknown as [
        Record<string, unknown>,
      ]
    )[0];
    expect(Object.keys(args)).toEqual(['where']);
  });
});
