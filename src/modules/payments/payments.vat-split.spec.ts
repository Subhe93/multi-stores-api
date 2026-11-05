import { FulfillerType } from '@prisma/client';
import { PaymentsService } from './payments.service';

// Marketplace VAT fix: the transfers are driven by the commission row only,
// so the VAT reserved for the platform never leaves its balance, and the
// per-provider transfers add up to provider_amount exactly.

function harness(commission: {
  provider_amount: number;
  creator_amount: number;
  platform_amount: number;
  vat_amount: number | null;
}) {
  const transfers: { destination: string; amount: number }[] = [];
  const keys: string[] = [];
  const stripe = {
    charges: {
      retrieve: jest.fn(() =>
        Promise.resolve({
          amount: 5000,
          balance_transaction: { currency: 'eur', amount: 5000 },
        }),
      ),
    },
    transfers: {
      create: jest.fn(
        (
          p: { destination: string; amount: number },
          o: { idempotencyKey: string },
        ) => {
          keys.push(o.idempotencyKey);
          transfers.push({ destination: p.destination, amount: p.amount });
          return Promise.resolve({ id: `tr_${transfers.length}` });
        },
      ),
    },
  };
  const prisma = {
    order: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'o1',
          currency: 'EUR',
          store_id: 's1',
          stripe_account_id: null,
          stripe_charge_id: 'ch_1',
          items: [
            {
              fulfiller_type: FulfillerType.PROVIDER,
              fulfiller_id: 'prov-b',
              provider_base_amount: 10,
            },
            {
              fulfiller_type: FulfillerType.PROVIDER,
              fulfiller_id: 'prov-a',
              provider_base_amount: 10,
            },
          ],
          commission,
        }),
      ),
    },
    orderPayout: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      upsert: jest.fn(() => Promise.resolve({})),
    },
    provider: {
      findMany: jest.fn(() =>
        Promise.resolve([
          { id: 'prov-a', stripe_account_id: 'acct_a' },
          { id: 'prov-b', stripe_account_id: 'acct_b' },
        ]),
      ),
    },
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          creator: { id: 'cr1', stripe_account_id: 'acct_creator' },
        }),
      ),
    },
  };
  const svc = Object.create(PaymentsService.prototype) as PaymentsService;
  const internals = svc as unknown as {
    prisma: unknown;
    logger: unknown;
    requireStripe: () => Promise<unknown>;
    issueOrderTransfers: (id: string) => Promise<void>;
  };
  internals.prisma = prisma;
  internals.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  internals.requireStripe = () => Promise.resolve(stripe);
  return { run: () => internals.issueOrderTransfers('o1'), transfers, keys };
}

describe('issueOrderTransfers: transfers == shares, VAT stays with the platform', () => {
  it('two providers with equal bases and an odd provider_amount', async () => {
    // 2 x 25 incl. 25% VAT: VAT 10 retained, platform 6.00, providers 25.51
    // (odd on purpose), creator 8.49. Transfers must total 25.51 + 8.49.
    const h = harness({
      platform_amount: 6,
      provider_amount: 25.51,
      creator_amount: 8.49,
      vat_amount: 10,
    });
    await h.run();
    const by = Object.fromEntries(
      h.transfers.map((t) => [t.destination, t.amount]),
    );
    expect(by).toEqual({ acct_a: 1276, acct_b: 1275, acct_creator: 849 });
    const sent = h.transfers.reduce((s, t) => s + t.amount, 0);
    expect(sent).toBe(2551 + 849);
    // What stays on the platform balance: commission + VAT.
    expect(5000 - sent).toBe(600 + 1000);
  });

  it('uses the v5 idempotency key (largest-remainder shares may differ by a cent from v4)', async () => {
    const h = harness({
      platform_amount: 6,
      provider_amount: 25.51,
      creator_amount: 8.49,
      vat_amount: 10,
    });
    await h.run();
    expect(h.keys).toContain('transfer_o1_acct_a_eur_v5');
    expect(h.keys.every((k) => k.endsWith('_v5'))).toBe(true);
  });
});
