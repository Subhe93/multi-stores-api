/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- in-memory Prisma fake rows are untyped in tests */
/**
 * Moderation guarantees of the reviews app (M171):
 *  - `auto_publish` never overrides a moderator decision (edit, review link,
 *    delete-and-write-again);
 *  - approve / reply act on the version of the review the owner read
 *    (409 REVIEW_CHANGED otherwise);
 *  - the same review sent again follows the customer's eligible order line;
 *  - the public page count is capped at the highest readable page.
 */
import { IDS, reviewRow } from './reviews-fake-db.mockspec';
import {
  USERS,
  buildReviews,
  errorOf,
  submission,
  type ReviewsHarness,
} from './reviews-harness.mockspec';

const A = IDS.storeA;

/** `updated_at` of a stored review, as the dashboard holds it. */
const versionOf = (h: ReviewsHarness, reviewId: string): string =>
  (
    (h.reviews().find((r) => r.id === reviewId)?.updated_at as
      | Date
      | undefined) ?? new Date(0)
  ).toISOString();

const moderate = (
  h: ReviewsHarness,
  reviewId: string,
  status: 'APPROVED' | 'REJECTED',
) => h.service.setStatus(IDS.ownerA, reviewId, status, versionOf(h, reviewId));

const reply = (h: ReviewsHarness, reviewId: string, body: unknown) =>
  h.service.setReply(IDS.ownerA, reviewId, body, versionOf(h, reviewId));

const holds = (h: ReviewsHarness) => h.prisma.db.productReviewHold;

function seedAnnaReview(h: ReviewsHarness, over: Record<string, unknown> = {}) {
  const row = reviewRow({
    product_id: IDS.necklace,
    customer_id: IDS.anna,
    order_id: IDS.annaOrder,
    order_item_id: IDS.annaOrderLine,
    title: 'Perfect gift',
    body: 'Fast delivery and the engraving looks great.',
    display_name: 'Anna S.',
    ...over,
  });
  h.reviews().push(row);
  return row;
}

describe('ReviewsService: auto_publish never overrides the moderator', () => {
  const autoPublish = () => {
    const h = buildReviews();
    h.apps.settings.set(A, { auto_publish: true });
    return h;
  };

  it('owner rejects, customer edits -> PENDING, nothing published or revalidated', async () => {
    const h = autoPublish();
    const first = await h.service.submitMine(USERS.anna, A, submission());
    expect(first.status).toBe('APPROVED');
    await moderate(h, first.id!, 'REJECTED');
    h.revalidation.revalidateStoreById.mockClear();

    const again = await h.service.submitMine(
      USERS.anna,
      A,
      submission({ body: 'Fast delivery and the engraving looks great!' }),
    );
    expect(again).toEqual({ id: first.id, status: 'PENDING' });
    expect(h.reviews()[0]).toMatchObject({ status: 'PENDING' });
    expect(h.revalidation.revalidateStoreById).not.toHaveBeenCalled();

    // A second edit of the waiting review does not publish it either.
    const third = await h.service.submitMine(
      USERS.anna,
      A,
      submission({ body: 'One more attempt with another text.' }),
    );
    expect(third.status).toBe('PENDING');
    expect(h.revalidation.revalidateStoreById).not.toHaveBeenCalled();
    expect(
      (await h.service.publicList(A, 'namnhalsband', 1)).summary.count,
    ).toBe(0);
  });

  it('the review link is no way around a rejection either', async () => {
    const h = autoPublish();
    const first = await h.service.submitMine(USERS.anna, A, submission());
    await moderate(h, first.id!, 'REJECTED');
    const res = await h.service.submitLink(
      A,
      {
        rating: 5,
        body: 'Sent again through the review link.',
        display_name: 'Anna S.',
        locale: 'sv',
        token: await h.linkToken(),
      } as never,
      { ip: null },
    );
    expect(res).toEqual({ id: first.id, status: 'PENDING' });
    expect(h.reviews()[0].status).toBe('PENDING');
  });

  it('a review hidden for its order comes back as PENDING, not public', async () => {
    const h = autoPublish();
    const first = await h.service.submitMine(USERS.anna, A, submission());
    await h.service.hideForOrders([IDS.annaOrder]);
    expect(h.reviews()[0].status).toBe('REJECTED');
    // The order is still a real purchase again; the customer edits.
    const again = await h.service.submitMine(
      USERS.anna,
      A,
      submission({ body: 'Edited after the order came back.' }),
    );
    expect(again).toEqual({ id: first.id, status: 'PENDING' });
  });

  it('an APPROVED review stays public when edited; approving again restores that after a rejection', async () => {
    const h = autoPublish();
    const first = await h.service.submitMine(USERS.anna, A, submission());
    const edited = await h.service.submitMine(
      USERS.anna,
      A,
      submission({ rating: 4 }),
    );
    expect(edited.status).toBe('APPROVED');
    await moderate(h, first.id!, 'REJECTED');
    await h.service.submitMine(USERS.anna, A, submission({ rating: 3 }));
    await moderate(h, first.id!, 'APPROVED');
    const later = await h.service.submitMine(
      USERS.anna,
      A,
      submission({ rating: 2 }),
    );
    expect(later.status).toBe('APPROVED');
  });

  it('owner deletes, customer writes again -> PENDING until the owner approves (hold)', async () => {
    const h = autoPublish();
    const first = await h.service.submitMine(USERS.anna, A, submission());
    await h.service.ownerDelete(IDS.ownerA, first.id!);
    expect(holds(h)).toEqual([
      expect.objectContaining({
        store_id: A,
        customer_id: IDS.anna,
        product_id: IDS.necklace,
        custom_product_id: null,
      }),
    ]);
    h.revalidation.revalidateStoreById.mockClear();

    const second = await h.service.submitMine(USERS.anna, A, submission());
    expect(second.status).toBe('PENDING');
    expect(h.revalidation.revalidateStoreById).not.toHaveBeenCalled();
    // The hold is about this customer and this product only.
    expect(
      (await h.service.submitMine(USERS.bertil, A, submission())).status,
    ).toBe('APPROVED');
    expect(
      (
        await h.service.submitMine(
          USERS.anna,
          A,
          submission({ product_id: IDS.ring }),
        )
      ).status,
    ).toBe('APPROVED');

    // Deleting twice keeps one hold; an approval lifts it.
    await h.service.ownerDelete(IDS.ownerA, second.id!);
    expect(holds(h)).toHaveLength(1);
    const third = await h.service.submitMine(USERS.anna, A, submission());
    expect(third.status).toBe('PENDING');
    await moderate(h, third.id!, 'APPROVED');
    expect(holds(h)).toHaveLength(0);
  });

  it('a hold on a custom product is kept apart from own products', async () => {
    const h = autoPublish();
    const mug = submission({ product_id: IDS.customMug });
    const first = await h.service.submitMine(USERS.anna, A, mug);
    await h.service.ownerDelete(IDS.ownerA, first.id!);
    expect(holds(h)[0]).toMatchObject({
      product_id: null,
      custom_product_id: IDS.customMug,
    });
    expect((await h.service.submitMine(USERS.anna, A, mug)).status).toBe(
      'PENDING',
    );
    expect(
      (await h.service.submitMine(USERS.anna, A, submission())).status,
    ).toBe('APPROVED');
  });

  it('customer deletes a REJECTED or waiting review and writes again -> still PENDING', async () => {
    const h = autoPublish();
    const first = await h.service.submitMine(USERS.anna, A, submission());
    await moderate(h, first.id!, 'REJECTED');
    await h.service.deleteMine(USERS.anna, A, first.id!);
    const second = await h.service.submitMine(USERS.anna, A, submission());
    expect(second.status).toBe('PENDING');
    // Deleting the waiting one and trying once more changes nothing.
    await h.service.deleteMine(USERS.anna, A, second.id!);
    const third = await h.service.submitMine(USERS.anna, A, submission());
    expect(third.status).toBe('PENDING');
    expect(holds(h)).toHaveLength(1);
  });

  it('no hold when a customer deletes a public review, or a pending one in a moderated store', async () => {
    const h = autoPublish();
    const first = await h.service.submitMine(USERS.anna, A, submission());
    await h.service.deleteMine(USERS.anna, A, first.id!);
    expect(holds(h)).toHaveLength(0);
    expect(
      (await h.service.submitMine(USERS.anna, A, submission())).status,
    ).toBe('APPROVED');

    const moderated = buildReviews();
    const pending = await moderated.service.submitMine(
      USERS.anna,
      A,
      submission(),
    );
    await moderated.service.deleteMine(USERS.anna, A, pending.id!);
    expect(holds(moderated)).toHaveLength(0);
  });

  it('removeForCustomer takes the holds of the customer with it', async () => {
    const h = autoPublish();
    const first = await h.service.submitMine(USERS.anna, A, submission());
    await h.service.ownerDelete(IDS.ownerA, first.id!);
    expect(holds(h)).toHaveLength(1);
    await h.service.removeForCustomer(IDS.anna);
    expect(holds(h)).toHaveLength(0);
  });

  it('the hold is written and read inside the store / customer scope', async () => {
    const h = autoPublish();
    const first = await h.service.submitMine(USERS.anna, A, submission());
    await h.service.ownerDelete(IDS.ownerA, first.id!);
    // Owner B cannot place a hold through a review of store A.
    const row = seedAnnaReview(h, { product_id: IDS.ring });
    expect(await errorOf(h.service.ownerDelete(IDS.ownerB, row.id))).toEqual({
      status: 404,
      code: 'REVIEW_NOT_FOUND',
    });
    expect(holds(h)).toHaveLength(1);
  });
});

describe('ReviewsService: moderation acts on the text the owner read', () => {
  it('stale approve: the customer edited after the owner loaded the row -> 409 REVIEW_CHANGED, stays PENDING', async () => {
    const h = buildReviews();
    const res = await h.service.submitMine(USERS.anna, A, submission());
    const seen = versionOf(h, res.id!);
    await h.service.submitMine(
      USERS.anna,
      A,
      submission({ rating: 1, body: 'Something the owner never read.' }),
    );
    expect(
      await errorOf(h.service.setStatus(IDS.ownerA, res.id!, 'APPROVED', seen)),
    ).toEqual({ status: 409, code: 'REVIEW_CHANGED' });
    expect(h.reviews()[0]).toMatchObject({
      status: 'PENDING',
      published_at: null,
      moderated_by: null,
    });
    expect(h.revalidation.revalidateStoreById).not.toHaveBeenCalled();
    // With the version of the edited row the same click goes through.
    const view = await moderate(h, res.id!, 'APPROVED');
    expect(view.status).toBe('APPROVED');
  });

  it('stale reply: never attached to a text it did not answer', async () => {
    const h = buildReviews();
    const row = seedAnnaReview(h);
    const seen = versionOf(h, row.id);
    await h.service.submitMine(
      USERS.anna,
      A,
      submission({ body: 'A completely different opinion now.' }),
    );
    expect(
      await errorOf(h.service.setReply(IDS.ownerA, row.id, 'Thank you!', seen)),
    ).toEqual({ status: 409, code: 'REVIEW_CHANGED' });
    expect(h.reviews()[0]).toMatchObject({
      reply_body: null,
      replied_at: null,
    });
  });

  it('the version is part of the UPDATE (an edit between read and write loses)', async () => {
    const h = buildReviews();
    const row = seedAnnaReview(h, { status: 'PENDING', published_at: null });
    await moderate(h, row.id, 'APPROVED');
    const where = h.prisma.productReview.updateMany.mock.calls.at(-1)![0].where;
    expect(where).toEqual({
      id: row.id,
      store_id: A,
      updated_at: expect.any(Date),
    });
    // The write itself misses: same coded answer.
    h.prisma.productReview.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await errorOf(moderate(h, row.id, 'REJECTED'))).toEqual({
      status: 409,
      code: 'REVIEW_CHANGED',
    });
    h.prisma.productReview.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await errorOf(reply(h, row.id, 'Hello'))).toEqual({
      status: 409,
      code: 'REVIEW_CHANGED',
    });
    expect(h.reviews()[0]).toMatchObject({
      status: 'APPROVED',
      reply_body: null,
    });
  });

  it('a missing or malformed version is refused, never applied blindly', async () => {
    const h = buildReviews();
    const row = seedAnnaReview(h, { status: 'PENDING', published_at: null });
    for (const version of [undefined, '', 'yesterday', 5, null]) {
      expect(
        await errorOf(
          h.service.setStatus(IDS.ownerA, row.id, 'APPROVED', version),
        ),
      ).toEqual({ status: 409, code: 'REVIEW_CHANGED' });
      expect(
        await errorOf(h.service.setReply(IDS.ownerA, row.id, 'Hi', version)),
      ).toEqual({ status: 409, code: 'REVIEW_CHANGED' });
    }
    expect(h.reviews()[0]).toMatchObject({
      status: 'PENDING',
      reply_body: null,
    });
  });

  it("another store's review stays a 404, whatever version is sent", async () => {
    const h = buildReviews();
    const row = seedAnnaReview(h);
    expect(
      await errorOf(
        h.service.setStatus(
          IDS.ownerB,
          row.id,
          'REJECTED',
          versionOf(h, row.id),
        ),
      ),
    ).toEqual({ status: 404, code: 'REVIEW_NOT_FOUND' });
  });
});

describe('ReviewsService: the same review sent again after its order changed', () => {
  const secondOrder = (h: ReviewsHarness) => {
    const orderId = 'aaaaaaaa-0000-4000-8000-000000000001';
    const lineId = 'aaaaaaaa-0000-4000-8000-000000000002';
    h.db.order.push({
      ...h.db.order.find((o) => o.id === IDS.annaOrder),
      id: orderId,
      order_number: 'ORD-99',
      created_at: new Date(Date.UTC(2026, 10, 20)),
    });
    h.db.orderItem.push({
      id: lineId,
      order_id: orderId,
      product_id: IDS.necklace,
      custom_product_id: null,
    });
    return { orderId, lineId };
  };
  const annaOrder = (h: ReviewsHarness) =>
    h.db.order.find((o) => o.id === IDS.annaOrder)!;

  it('hidden for a test order, bought again: the link moves, the review waits as PENDING and can be approved', async () => {
    const h = buildReviews();
    const first = await h.service.submitMine(USERS.anna, A, submission());
    await moderate(h, first.id!, 'APPROVED');
    const { orderId, lineId } = secondOrder(h);
    annaOrder(h).is_test = true;
    await h.service.hideForOrders([IDS.annaOrder]);
    expect(h.reviews()[0]).toMatchObject({
      status: 'REJECTED',
      moderated_by: null,
    });

    const again = await h.service.submitMine(USERS.anna, A, submission());
    expect(again).toEqual({ id: first.id, status: 'PENDING' });
    expect(h.reviews()[0]).toMatchObject({
      status: 'PENDING',
      order_id: orderId,
      order_item_id: lineId,
    });
    const view = await moderate(h, first.id!, 'APPROVED');
    expect(view.status).toBe('APPROVED');
  });

  it('a REJECTED by the moderator stays REJECTED; an APPROVED review is not pulled or re-dated', async () => {
    const h = buildReviews();
    const first = await h.service.submitMine(USERS.anna, A, submission());
    await moderate(h, first.id!, 'REJECTED');
    secondOrder(h);
    annaOrder(h).deleted_at = new Date();
    expect(
      (await h.service.submitMine(USERS.anna, A, submission())).status,
    ).toBe('REJECTED');
    expect(h.reviews()[0].moderated_by).toBe(IDS.ownerA);

    const h2 = buildReviews();
    const approved = await h2.service.submitMine(USERS.anna, A, submission());
    await moderate(h2, approved.id!, 'APPROVED');
    const publishedAt = h2.reviews()[0].published_at;
    const { lineId } = secondOrder(h2);
    annaOrder(h2).deleted_at = new Date();
    h2.revalidation.revalidateStoreById.mockClear();
    expect(
      (await h2.service.submitMine(USERS.anna, A, submission())).status,
    ).toBe('APPROVED');
    expect(h2.reviews()[0]).toMatchObject({
      status: 'APPROVED',
      order_item_id: lineId,
      published_at: publishedAt,
    });
    expect(h2.revalidation.revalidateStoreById).not.toHaveBeenCalled();
  });

  it('same content, same order line: nothing is written', async () => {
    const h = buildReviews();
    await h.service.submitMine(USERS.anna, A, submission());
    h.prisma.productReview.updateMany.mockClear();
    await h.service.submitMine(USERS.anna, A, submission());
    expect(h.prisma.productReview.updateMany).not.toHaveBeenCalled();
  });
});

describe('ReviewsService: public pagination cap', () => {
  it('total_pages never exceeds the highest page the read accepts', async () => {
    const h = buildReviews();
    h.prisma.productReview.groupBy.mockResolvedValueOnce([
      { rating: 5, _count: { _all: 2500 } },
    ]);
    const page = await h.service.publicList(A, 'namnhalsband', 1);
    expect(page.total).toBe(2500);
    expect(page.total_pages).toBe(200);
  });
});
