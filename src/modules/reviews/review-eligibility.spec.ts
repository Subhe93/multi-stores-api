/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- in-memory Prisma fake rows are untyped in tests */
import {
  eligibleLineQuery,
  isReviewEligibleOrder,
  orderBlocksApproval,
  reviewEligibleOrderWhere,
  reviewTargetColumns,
  reviewTargetWhere,
  type ReviewOrderFacts,
} from './review-eligibility';
import { FakePrisma, IDS, seedWorld } from './reviews-fake-db.mockspec';

const base: ReviewOrderFacts = {
  store_id: IDS.storeA,
  status: 'CONFIRMED',
  payment_status: 'paid',
  payment_method: 'STRIPE',
  is_test: false,
  deleted_at: null,
};

// Every case runs through BOTH spellings of the rule: the predicate and the
// Prisma filter (applied by the in-memory double), so they cannot drift.
const cases: [string, Partial<ReviewOrderFacts>, boolean][] = [
  ['paid card order', {}, true],
  ['paid and shipped', { status: 'SHIPPED' }, true],
  ['paid and delivered', { status: 'DELIVERED' }, true],
  ['paid, later returned', { status: 'RETURNED' }, true],
  [
    'COD delivered (payment_status null)',
    { payment_method: 'COD', payment_status: null, status: 'DELIVERED' },
    true,
  ],
  [
    'COD not delivered yet',
    { payment_method: 'COD', payment_status: null, status: 'SHIPPED' },
    false,
  ],
  ['payment pending', { payment_status: 'pending' }, false],
  ['payment failed', { payment_status: 'failed' }, false],
  ['awaiting payment', { payment_status: 'awaiting_payment' }, false],
  ['no payment status on a card order', { payment_status: null }, false],
  ['refunded payment', { payment_status: 'refunded' }, false],
  ['status CANCELLED although paid', { status: 'CANCELLED' }, false],
  ['status REFUNDED although paid', { status: 'REFUNDED' }, false],
  [
    'card order DELIVERED but never paid',
    { payment_status: 'pending', status: 'DELIVERED' },
    false,
  ],
  ['test order', { is_test: true }, false],
  ['trashed order', { deleted_at: new Date() }, false],
  ['order of another store', { store_id: IDS.storeB }, false],
  ['order without a store', { store_id: null }, false],
];

describe('review eligibility', () => {
  it.each(cases)('%s -> %s', async (_label, over, expected) => {
    const order = { ...base, ...over };
    expect(isReviewEligibleOrder(order, IDS.storeA)).toBe(expected);

    const db = seedWorld();
    Object.assign(db.order.find((o) => o.id === IDS.annaOrder)!, over);
    const prisma = new FakePrisma(db);
    const found = await prisma.order.findFirst({
      where: { id: IDS.annaOrder, ...reviewEligibleOrderWhere(IDS.storeA) },
    });
    expect(found !== null).toBe(expected);
  });

  it('the filter carries every exclusion', () => {
    expect(reviewEligibleOrderWhere('s1')).toEqual({
      store_id: 's1',
      is_test: false,
      deleted_at: null,
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
      OR: [
        { payment_status: 'paid' },
        { payment_method: 'COD', status: 'DELIVERED' },
      ],
    });
  });

  describe('eligible line lookup (starts from Order by customer)', () => {
    const run = (
      customerId: string,
      target: Parameters<typeof eligibleLineQuery>[2],
      mutate?: (db: ReturnType<typeof seedWorld>) => void,
      storeId: string = IDS.storeA,
    ) => {
      const db = seedWorld();
      mutate?.(db);
      const prisma = new FakePrisma(db);
      return prisma.order.findFirst(
        eligibleLineQuery(storeId, customerId, target),
      );
    };

    it('finds the first matching line of the buyer', async () => {
      const order = await run(IDS.anna, { kind: 'product', id: IDS.necklace });
      expect(order).toEqual({
        id: IDS.annaOrder,
        items: [{ id: IDS.annaOrderLine }],
      });
    });

    it('finds a custom-product line', async () => {
      const order = await run(IDS.anna, {
        kind: 'custom_product',
        id: IDS.customMug,
      });
      expect(order.items).toEqual([{ id: IDS.annaMugLine }]);
    });

    it('other customer, other product, other store: nothing', async () => {
      // Cecilia (store B) never bought the necklace of store A.
      expect(
        await run(IDS.cecilia, { kind: 'product', id: IDS.necklace }),
      ).toBeNull();
      // Bertil bought the necklace only.
      expect(
        await run(IDS.bertil, { kind: 'product', id: IDS.ring }),
      ).toBeNull();
      // Anna's order is not an order of store B.
      expect(
        await run(
          IDS.anna,
          { kind: 'product', id: IDS.necklace },
          undefined,
          IDS.storeB,
        ),
      ).toBeNull();
      // A product id is never matched against the custom-product column.
      expect(
        await run(IDS.anna, { kind: 'custom_product', id: IDS.necklace }),
      ).toBeNull();
    });

    it('the newest eligible order wins; an ineligible newer one is skipped', async () => {
      const newer = {
        id: 'o-new',
        order_number: 'ORD-9',
        store_id: IDS.storeA,
        customer_id: IDS.anna,
        status: 'CONFIRMED',
        payment_status: 'paid',
        payment_method: 'STRIPE',
        is_test: false,
        deleted_at: null,
        created_at: new Date(Date.UTC(2026, 11, 1)),
      };
      const target = { kind: 'product' as const, id: IDS.necklace };
      const add = (over: object) => (db: ReturnType<typeof seedWorld>) => {
        db.order.push({ ...newer, ...over });
        db.orderItem.push({
          id: 'i-new',
          order_id: 'o-new',
          product_id: IDS.necklace,
          custom_product_id: null,
        });
      };
      expect((await run(IDS.anna, target, add({}))).id).toBe('o-new');
      expect((await run(IDS.anna, target, add({ is_test: true }))).id).toBe(
        IDS.annaOrder,
      );
      expect(
        (await run(IDS.anna, target, add({ payment_status: 'refunded' }))).id,
      ).toBe(IDS.annaOrder);
    });

    it('never scans OrderItem by product', () => {
      const q = eligibleLineQuery('s', 'c', { kind: 'product', id: 'p' });
      expect(q.where.customer_id).toBe('c');
      expect(q.where.items).toEqual({ some: { product_id: 'p' } });
    });
  });

  it('approval is blocked by a test, trashed or missing order only', () => {
    expect(orderBlocksApproval(null)).toBe(true);
    expect(orderBlocksApproval(undefined)).toBe(true);
    expect(orderBlocksApproval({ is_test: true, deleted_at: null })).toBe(true);
    expect(
      orderBlocksApproval({ is_test: false, deleted_at: new Date() }),
    ).toBe(true);
    expect(orderBlocksApproval({ is_test: false, deleted_at: null })).toBe(
      false,
    );
  });

  it('target columns: exactly one of the two is set', () => {
    expect(reviewTargetColumns({ kind: 'product', id: 'p' })).toEqual({
      product_id: 'p',
      custom_product_id: null,
    });
    expect(reviewTargetColumns({ kind: 'custom_product', id: 'c' })).toEqual({
      product_id: null,
      custom_product_id: 'c',
    });
    expect(reviewTargetWhere({ kind: 'product', id: 'p' })).toEqual({
      product_id: 'p',
    });
    expect(reviewTargetWhere({ kind: 'custom_product', id: 'c' })).toEqual({
      custom_product_id: 'c',
    });
  });
});
