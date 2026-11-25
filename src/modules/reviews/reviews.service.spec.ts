/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- in-memory Prisma fake rows are untyped in tests */
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

/** Owner moderation on the version of the row the owner currently sees. */
const moderate = (
  h: ReviewsHarness,
  userId: string,
  reviewId: string,
  status: 'APPROVED' | 'REJECTED',
) => h.service.setStatus(userId, reviewId, status, versionOf(h, reviewId));

const reply = (
  h: ReviewsHarness,
  userId: string,
  reviewId: string,
  body: unknown,
) => h.service.setReply(userId, reviewId, body, versionOf(h, reviewId));

/** Seeds one stored review of Anna for the necklace and returns its row. */
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

describe('ReviewsService: submitting (signed-in customer)', () => {
  it('creates a PENDING verified review bound to the order line; no revalidation', async () => {
    const h = buildReviews();
    const res = await h.service.submitMine(USERS.anna, A, submission());
    expect(res).toEqual({ id: expect.any(String), status: 'PENDING' });
    expect(h.reviews()).toHaveLength(1);
    expect(h.reviews()[0]).toMatchObject({
      id: res.id,
      store_id: A,
      product_id: IDS.necklace,
      custom_product_id: null,
      customer_id: IDS.anna,
      order_id: IDS.annaOrder,
      order_item_id: IDS.annaOrderLine,
      verified_purchase: true,
      rating: 5,
      title: 'Perfect gift',
      body: 'Fast delivery and the engraving looks great.',
      display_name: 'Anna S.',
      locale: 'sv',
      status: 'PENDING',
      source: 'ACCOUNT',
      published_at: null,
    });
    expect(h.revalidation.revalidateStoreById).not.toHaveBeenCalled();
  });

  it('stores the normalised text and never a field outside the review', async () => {
    const h = buildReviews();
    await h.service.submitMine(
      USERS.anna,
      A,
      submission({
        title: '  <b>Great</b>  ',
        body: 'Line one\r\n\r\n\r\n\r\nLine two <script>x</script>',
        website: '',
        turnstile_token: 'ignored-on-the-account-route',
      }),
    );
    const row = h.reviews()[0];
    expect(row.title).toBe('<b>Great</b>');
    expect(row.body).toBe('Line one\n\nLine two <script>x</script>');
    expect(row).not.toHaveProperty('website');
    expect(row).not.toHaveProperty('turnstile_token');
    // The logged-in route asks for no captcha.
    expect(h.turnstile.verifyCustomer).not.toHaveBeenCalled();
  });

  it('a custom product is reviewed through custom_product_id', async () => {
    const h = buildReviews();
    await h.service.submitMine(
      USERS.anna,
      A,
      submission({ product_id: IDS.customMug }),
    );
    expect(h.reviews()[0]).toMatchObject({
      product_id: null,
      custom_product_id: IDS.customMug,
      order_item_id: IDS.annaMugLine,
    });
  });

  it('auto_publish: APPROVED at once, published_at set, store revalidated', async () => {
    const h = buildReviews();
    h.apps.settings.set(A, { auto_publish: true });
    const res = await h.service.submitMine(USERS.anna, A, submission());
    expect(res.status).toBe('APPROVED');
    expect(h.reviews()[0].status).toBe('APPROVED');
    expect(h.reviews()[0].published_at).toBeInstanceOf(Date);
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledTimes(1);
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledWith(A);
  });

  it('one row per customer and product; another buyer gets their own row', async () => {
    const h = buildReviews();
    await h.service.submitMine(USERS.anna, A, submission());
    await h.service.submitMine(
      USERS.anna,
      A,
      submission({ rating: 3, body: 'Changed my mind after a week of use.' }),
    );
    await h.service.submitMine(
      USERS.bertil,
      A,
      submission({ display_name: 'Bertil' }),
    );
    await h.service.submitMine(
      USERS.anna,
      A,
      submission({ product_id: IDS.ring }),
    );
    expect(h.reviews()).toHaveLength(3);
    expect(h.reviews().filter((r) => r.customer_id === IDS.anna)).toHaveLength(
      2,
    );
  });

  it('resubmission: replaces the text, back to PENDING, reply and moderation cleared, published_at kept', async () => {
    const h = buildReviews();
    const published = new Date('2026-11-01T08:00:00Z');
    const row = seedAnnaReview(h, {
      status: 'APPROVED',
      published_at: published,
      moderated_at: new Date(),
      moderated_by: IDS.ownerA,
      reply_body: 'Thank you!',
      replied_at: new Date(),
      source: 'LINK',
    });
    const res = await h.service.submitMine(
      USERS.anna,
      A,
      submission({
        rating: 2,
        title: '',
        body: 'It broke after two weeks, sadly.',
        display_name: 'Anna',
        locale: 'en',
      }),
    );
    expect(res).toEqual({ id: row.id, status: 'PENDING' });
    expect(h.reviews()).toHaveLength(1);
    expect(h.reviews()[0]).toMatchObject({
      id: row.id,
      rating: 2,
      title: null,
      body: 'It broke after two weeks, sadly.',
      display_name: 'Anna',
      locale: 'en',
      status: 'PENDING',
      source: 'ACCOUNT',
      moderated_at: null,
      moderated_by: null,
      reply_body: null,
      replied_at: null,
      published_at: published,
    });
    // It was public: the storefront must drop it.
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledTimes(1);
  });

  it('resubmission of a PENDING / REJECTED review revalidates nothing', async () => {
    for (const status of ['PENDING', 'REJECTED']) {
      const h = buildReviews();
      seedAnnaReview(h, { status, published_at: null });
      const res = await h.service.submitMine(
        USERS.anna,
        A,
        submission({ body: 'A different text than before, clearly.' }),
      );
      expect(res.status).toBe('PENDING');
      expect(h.revalidation.revalidateStoreById).not.toHaveBeenCalled();
    }
  });

  it('auto_publish resubmission keeps the first published_at (editing never re-dates)', async () => {
    const h = buildReviews();
    h.apps.settings.set(A, { auto_publish: true });
    const published = new Date('2026-11-01T08:00:00Z');
    seedAnnaReview(h, { status: 'APPROVED', published_at: published });
    const res = await h.service.submitMine(
      USERS.anna,
      A,
      submission({ body: 'Edited text, still happy with it.' }),
    );
    expect(res.status).toBe('APPROVED');
    expect(h.reviews()[0].published_at).toBe(published);
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledTimes(1);
  });

  it.each(['APPROVED', 'PENDING', 'REJECTED'])(
    'an identical resubmission of a %s review is a no-op',
    async (status) => {
      const h = buildReviews();
      const row = seedAnnaReview(h, {
        status,
        reply_body: 'Thank you!',
        replied_at: new Date('2026-11-21T08:00:00Z'),
        moderated_by: IDS.ownerA,
      });
      const before = { ...row };
      // Same content after normalisation; only the locale differs.
      const res = await h.service.submitMine(
        USERS.anna,
        A,
        submission({
          title: ' Perfect gift ',
          body: 'Fast delivery and the engraving looks great.\r\n',
          locale: 'en',
        }),
      );
      expect(res).toEqual({ id: row.id, status });
      expect(h.reviews()[0]).toEqual(before);
      expect(h.prisma.productReview.updateMany).not.toHaveBeenCalled();
      expect(h.revalidation.revalidateStoreById).not.toHaveBeenCalled();
    },
  );

  it('a concurrent first submit (P2002) falls back to the update', async () => {
    const h = buildReviews();
    // Between "no row yet" and the insert, the other request wins the index.
    h.prisma.failNextReviewCreateWithRace = () => {
      seedAnnaReview(h, {
        status: 'PENDING',
        published_at: null,
        body: 'The text of the request that won the race.',
      });
    };
    const res = await h.service.submitMine(USERS.anna, A, submission());
    expect(h.reviews()).toHaveLength(1);
    expect(res).toEqual({ id: h.reviews()[0].id, status: 'PENDING' });
    expect(h.reviews()[0].body).toBe(
      'Fast delivery and the engraving looks great.',
    );
  });

  it('a non-unique database error is not swallowed', async () => {
    const h = buildReviews();
    h.prisma.productReview.create.mockImplementationOnce(() => {
      throw new Error('connection lost');
    });
    await expect(
      h.service.submitMine(USERS.anna, A, submission()),
    ).rejects.toThrow('connection lost');
  });

  it('honeypot: answers like a success and writes nothing', async () => {
    const h = buildReviews();
    const res = await h.service.submitMine(
      USERS.anna,
      A,
      submission({ website: 'https://spam.example' }),
    );
    expect(res).toEqual({ id: null, status: 'PENDING' });
    expect(h.reviews()).toHaveLength(0);
    expect(h.prisma.productReview.create).not.toHaveBeenCalled();
  });

  it('validation errors are coded and nothing is written', async () => {
    const h = buildReviews();
    const cases: [Record<string, unknown>, string][] = [
      [{ rating: 6 }, 'REVIEW_RATING_INVALID'],
      [{ rating: 4.5 }, 'REVIEW_RATING_INVALID'],
      [{ body: 'short' }, 'REVIEW_BODY_TOO_SHORT'],
      [{ body: 'x'.repeat(2001) }, 'REVIEW_BODY_TOO_LONG'],
      [{ title: 'x'.repeat(121) }, 'REVIEW_TITLE_TOO_LONG'],
      [{ display_name: 'anna@example.com' }, 'REVIEW_DISPLAY_NAME_INVALID'],
      [{ locale: 'swedish' }, 'REVIEW_LOCALE_INVALID'],
      [
        { body: 'http://a.example http://b.example http://c.example' },
        'REVIEW_TEXT_INVALID',
      ],
    ];
    for (const [over, code] of cases) {
      expect(
        await errorOf(h.service.submitMine(USERS.anna, A, submission(over))),
      ).toEqual({ status: 400, code });
    }
    expect(h.reviews()).toHaveLength(0);
  });
});

describe('ReviewsService: who may write', () => {
  it('a customer without a purchase of the product -> 403 REVIEW_NOT_PURCHASED', async () => {
    const h = buildReviews();
    expect(
      await errorOf(
        h.service.submitMine(
          USERS.bertil,
          A,
          submission({ product_id: IDS.ring }),
        ),
      ),
    ).toEqual({ status: 403, code: 'REVIEW_NOT_PURCHASED' });
    expect(h.reviews()).toHaveLength(0);
  });

  it.each([
    ['unpaid', { payment_status: 'pending' }],
    ['refunded payment', { payment_status: 'refunded' }],
    ['cancelled', { status: 'CANCELLED' }],
    ['refunded', { status: 'REFUNDED' }],
    ['test', { is_test: true }],
    ['trashed', { deleted_at: new Date() }],
  ])('an order that is %s does not make a buyer', async (_label, over) => {
    const h = buildReviews();
    Object.assign(h.db.order.find((o) => o.id === IDS.annaOrder)!, over);
    expect(
      await errorOf(h.service.submitMine(USERS.anna, A, submission())),
    ).toEqual({ status: 403, code: 'REVIEW_NOT_PURCHASED' });
    const state = await h.service.eligibility(USERS.anna, A, IDS.necklace);
    expect(state).toMatchObject({ eligible: false, reason: 'NOT_PURCHASED' });
  });

  it('a product of another store, an unknown id or the base product of a custom product -> 404 REVIEW_PRODUCT_NOT_FOUND', async () => {
    const h = buildReviews();
    for (const product_id of [IDS.productB, IDS.baseMug, IDS.storeA]) {
      expect(
        await errorOf(
          h.service.submitMine(USERS.anna, A, submission({ product_id })),
        ),
      ).toEqual({ status: 404, code: 'REVIEW_PRODUCT_NOT_FOUND' });
    }
    expect(
      await errorOf(h.service.eligibility(USERS.anna, A, 'not-a-uuid')),
    ).toEqual({ status: 404, code: 'REVIEW_PRODUCT_NOT_FOUND' });
  });

  it('an INDEPENDENT store never accepts a custom product', async () => {
    const h = buildReviews();
    // A custom product of creator B, bought by Cecilia in store B.
    h.db.customProduct.push({
      id: IDS.draftProduct.replace(/^.{2}/, 'ee'),
      creator_id: IDS.creatorB,
      product_id: IDS.baseMug,
      status: 'PUBLISHED',
    });
    const customB = h.db.customProduct[h.db.customProduct.length - 1].id;
    h.db.orderItem.push({
      id: 'line-custom-b',
      order_id: IDS.ceciliaOrder,
      product_id: null,
      custom_product_id: customB,
    });
    expect(
      await errorOf(
        h.service.submitMine(
          USERS.cecilia,
          IDS.storeB,
          submission({ product_id: customB, display_name: 'Cecilia B.' }),
        ),
      ),
    ).toEqual({ status: 404, code: 'REVIEW_PRODUCT_NOT_FOUND' });
  });

  it('a customer of another store -> 403 CUSTOMER_STORE_MISMATCH before any read', async () => {
    const h = buildReviews();
    const calls = [
      () => h.service.submitMine(USERS.cecilia, A, submission()),
      () => h.service.eligibility(USERS.cecilia, A, IDS.necklace),
      () => h.service.myOrderItems(USERS.cecilia, A, IDS.annaOrder),
      () => h.service.deleteMine(USERS.cecilia, A, IDS.annaOrder),
    ];
    for (const call of calls) {
      expect(await errorOf(call())).toEqual({
        status: 403,
        code: 'CUSTOMER_STORE_MISMATCH',
      });
    }
    expect(h.prisma.order.findFirst).not.toHaveBeenCalled();
    expect(h.prisma.productReview.findFirst).not.toHaveBeenCalled();
  });

  it('a forged RequestUser (storeId of A, account of B) is still refused by the database check', async () => {
    const h = buildReviews();
    const forged = { ...USERS.cecilia, storeId: A };
    expect(
      await errorOf(h.service.submitMine(forged, A, submission())),
    ).toEqual({ status: 403, code: 'CUSTOMER_STORE_MISMATCH' });
  });

  it('a blocked customer cannot write', async () => {
    const h = buildReviews();
    h.db.user.find((u) => u.id === IDS.annaUser)!.status = 'SUSPENDED';
    expect(
      await errorOf(h.service.submitMine(USERS.anna, A, submission())),
    ).toEqual({ status: 403, code: 'CUSTOMER_STORE_MISMATCH' });
  });
});

describe('ReviewsService: customer reads and delete', () => {
  it('eligibility: eligible buyer, suggestion from the name, own review prefilled', async () => {
    const h = buildReviews();
    expect(await h.service.eligibility(USERS.anna, A, IDS.necklace)).toEqual({
      eligible: true,
      reason: null,
      display_name_suggestion: 'Anna S.',
      review: null,
    });
    const row = seedAnnaReview(h, { status: 'REJECTED' });
    const state = await h.service.eligibility(USERS.anna, A, IDS.necklace);
    expect(state.review).toEqual({
      id: row.id,
      rating: 5,
      title: 'Perfect gift',
      body: 'Fast delivery and the engraving looks great.',
      display_name: 'Anna S.',
      status: 'REJECTED',
    });
  });

  it('eligibility: a guest record with empty names suggests nothing (never the email)', async () => {
    const h = buildReviews();
    const state = await h.service.eligibility(USERS.guest, A, IDS.ring);
    expect(state.eligible).toBe(true);
    expect(state.display_name_suggestion).toBe('');
    expect(
      (await h.service.eligibility(USERS.bertil, A, IDS.necklace))
        .display_name_suggestion,
    ).toBe('Bertil');
  });

  it('eligibility never shows the review of another customer', async () => {
    const h = buildReviews();
    seedAnnaReview(h);
    const state = await h.service.eligibility(USERS.bertil, A, IDS.necklace);
    expect(state).toMatchObject({ eligible: true, review: null });
  });

  it('order items: one entry per distinct product (first line), with my review status', async () => {
    const h = buildReviews();
    seedAnnaReview(h, { status: 'PENDING' });
    expect(await h.service.myOrderItems(USERS.anna, A, IDS.annaOrder)).toEqual({
      eligible: true,
      items: [
        {
          order_item_id: IDS.annaOrderLine,
          product_id: IDS.necklace,
          review_status: 'PENDING',
        },
        {
          order_item_id: IDS.annaOrderRingLine,
          product_id: IDS.ring,
          review_status: null,
        },
        {
          order_item_id: IDS.annaMugLine,
          product_id: IDS.customMug,
          review_status: null,
        },
      ],
    });
    // Two queries after the scope lookups: the order with its lines, then
    // the reviews of those products.
    expect(h.prisma.order.findFirst).toHaveBeenCalledTimes(1);
    expect(h.prisma.productReview.findMany).toHaveBeenCalledTimes(1);
  });

  it('order items: a line whose product left the store is not offered; an ineligible order says so', async () => {
    const h = buildReviews();
    h.db.product.find((p) => p.id === IDS.ring)!.creator_id = 'someone-else';
    Object.assign(h.db.order.find((o) => o.id === IDS.annaOrder)!, {
      status: 'CANCELLED',
    });
    const res = await h.service.myOrderItems(USERS.anna, A, IDS.annaOrder);
    expect(res.eligible).toBe(false);
    expect(res.items.map((i) => i.product_id)).toEqual([
      IDS.necklace,
      IDS.customMug,
    ]);
  });

  it("order items: someone else's order, another store's order and an unknown id are the same 404", async () => {
    const h = buildReviews();
    for (const orderId of [
      IDS.bertilOrder,
      IDS.ceciliaOrder,
      IDS.necklace,
      'nope',
    ]) {
      expect(
        await errorOf(h.service.myOrderItems(USERS.anna, A, orderId)),
      ).toEqual({ status: 404, code: 'ORDER_NOT_FOUND' });
    }
  });

  it('delete mine: removes my review; revalidates only when it was public', async () => {
    const h = buildReviews();
    const approved = seedAnnaReview(h, { status: 'APPROVED' });
    expect(await h.service.deleteMine(USERS.anna, A, approved.id)).toEqual({
      deleted: true,
    });
    expect(h.reviews()).toHaveLength(0);
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledTimes(1);

    const pending = seedAnnaReview(h, { status: 'PENDING' });
    await h.service.deleteMine(USERS.anna, A, pending.id);
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledTimes(1);
  });

  it("delete mine: another customer's review id -> 404 and nothing is deleted", async () => {
    const h = buildReviews();
    const row = seedAnnaReview(h);
    for (const reviewId of [row.id, IDS.necklace, 'nope']) {
      expect(
        await errorOf(h.service.deleteMine(USERS.bertil, A, reviewId)),
      ).toEqual({ status: 404, code: 'REVIEW_NOT_FOUND' });
    }
    expect(h.reviews()).toHaveLength(1);
    expect(h.revalidation.revalidateStoreById).not.toHaveBeenCalled();
  });
});

describe('ReviewsService: public read', () => {
  /** Seeds `n` approved necklace reviews with ratings cycling 5,4,3. */
  function seedMany(h: ReviewsHarness, n: number) {
    for (let i = 0; i < n; i++) {
      h.db.customer.push({
        id: `cust-${i}`,
        user_id: `user-${i}`,
        first_name: 'X',
        last_name: 'Y',
      });
      h.reviews().push(
        reviewRow({
          product_id: IDS.necklace,
          customer_id: `cust-${i}`,
          rating: [5, 4, 3][i % 3],
          body: `Review number ${String(i).padStart(2, '0')} of the list.`,
          published_at: new Date(Date.UTC(2026, 10, 1, 0, i)),
        }),
      );
    }
  }

  it('summary, distribution and one-decimal average from one groupBy', async () => {
    const h = buildReviews();
    seedMany(h, 12);
    const page = await h.service.publicList(A, 'namnhalsband', 1);
    expect(page.summary).toEqual({
      average: 4,
      count: 12,
      distribution: { '1': 0, '2': 0, '3': 4, '4': 4, '5': 4 },
    });
    expect(page.total).toBe(12);
    expect(page.total_pages).toBe(2);
    expect(page.page).toBe(1);
    expect(page.items).toHaveLength(10);
    expect(h.prisma.productReview.groupBy).toHaveBeenCalledTimes(1);
    expect(h.prisma.productReview.findMany).toHaveBeenCalledTimes(1);
  });

  it('average is rounded to one decimal', async () => {
    const h = buildReviews();
    seedMany(h, 3); // 5, 4, 3
    h.reviews()[2].rating = 5; // 5, 4, 5 -> 4.666...
    const page = await h.service.publicList(A, 'namnhalsband', 1);
    expect(page.summary.average).toBe(4.7);
  });

  it('pagination: newest first, page 2 holds the rest, a page past the end is empty', async () => {
    const h = buildReviews();
    seedMany(h, 12);
    const p1 = await h.service.publicList(A, 'namnhalsband', 1);
    const p2 = await h.service.publicList(A, 'namnhalsband', 2);
    const p9 = await h.service.publicList(A, 'namnhalsband', 9);
    expect(p1.items[0].body).toBe('Review number 11 of the list.');
    expect(p1.items[9].body).toBe('Review number 02 of the list.');
    expect(p2.items.map((i) => i.body)).toEqual([
      'Review number 01 of the list.',
      'Review number 00 of the list.',
    ]);
    expect(p9.items).toEqual([]);
    // The summary is the same on every page (rating markup never without it).
    expect(p9.summary.count).toBe(12);
    expect(p9.total_pages).toBe(2);
  });

  it('only APPROVED reviews are public (list and summary)', async () => {
    const h = buildReviews();
    seedAnnaReview(h, { status: 'APPROVED', rating: 4 });
    h.reviews().push(
      reviewRow({
        product_id: IDS.necklace,
        customer_id: IDS.bertil,
        status: 'PENDING',
        rating: 1,
      }),
      reviewRow({
        product_id: IDS.necklace,
        customer_id: IDS.guest,
        status: 'REJECTED',
        rating: 1,
      }),
    );
    const page = await h.service.publicList(A, 'namnhalsband', 1);
    expect(page.items).toHaveLength(1);
    expect(page.summary).toMatchObject({ average: 4, count: 1 });
  });

  it('no approved review: zero summary, empty list', async () => {
    const h = buildReviews();
    expect(await h.service.publicList(A, 'namnhalsband', 1)).toEqual({
      summary: {
        average: 0,
        count: 0,
        distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
      },
      items: [],
      page: 1,
      total: 0,
      total_pages: 0,
    });
  });

  it('every translated slug of the product reads the same reviews (shared across locales / markets)', async () => {
    const h = buildReviews();
    seedAnnaReview(h);
    const sv = await h.service.publicList(A, 'namnhalsband', 1);
    const de = await h.service.publicList(A, 'namenskette', 1);
    expect(de).toEqual(sv);
    expect(sv.items[0].locale).toBe('sv');
  });

  it('a legacy-case slug resolves to the same product as the product page', async () => {
    const h = buildReviews();
    h.reviews().push(
      reviewRow({ product_id: IDS.ring, customer_id: IDS.anna, rating: 3 }),
    );
    for (const slug of ['Silver-Ring', 'silver-ring', 'SILVER-RING']) {
      const page = await h.service.publicList(A, slug, 1);
      expect(page.summary.count).toBe(1);
    }
  });

  it('a custom product slug reads the custom product reviews', async () => {
    const h = buildReviews();
    h.reviews().push(
      reviewRow({ custom_product_id: IDS.customMug, customer_id: IDS.anna }),
    );
    const page = await h.service.publicList(A, 'mugg', 1);
    expect(page.summary.count).toBe(1);
  });

  it('DRAFT product, unknown slug -> 404 STOREFRONT_PRODUCT_NOT_FOUND', async () => {
    const h = buildReviews();
    for (const slug of ['utkast', 'does-not-exist']) {
      expect(await errorOf(h.service.publicList(A, slug, 1))).toEqual({
        status: 404,
        code: 'STOREFRONT_PRODUCT_NOT_FOUND',
      });
    }
  });

  it("a review of another store's product never appears (same slug in both stores)", async () => {
    const h = buildReviews();
    seedAnnaReview(h, { rating: 5 });
    h.reviews().push(
      reviewRow({
        store_id: IDS.storeB,
        product_id: IDS.productB,
        customer_id: IDS.cecilia,
        rating: 1,
        body: 'A review that belongs to store B only.',
      }),
    );
    const a = await h.service.publicList(A, 'namnhalsband', 1);
    const b = await h.service.publicList(IDS.storeB, 'namnhalsband', 1);
    expect(a.items.map((i) => i.rating)).toEqual([5]);
    expect(b.items.map((i) => i.rating)).toEqual([1]);
    // A row whose store_id does not match its product is filtered out too.
    h.reviews().push(
      reviewRow({
        store_id: IDS.storeB,
        product_id: IDS.necklace,
        customer_id: IDS.bertil,
        rating: 2,
      }),
    );
    expect((await h.service.publicList(A, 'namnhalsband', 1)).total).toBe(1);
  });

  it('an INDEPENDENT store never resolves a custom product slug', async () => {
    const h = buildReviews();
    h.db.customProduct.push({
      id: 'custom-b',
      creator_id: IDS.creatorB,
      product_id: IDS.baseMug,
      status: 'PUBLISHED',
    });
    h.db.customProductTranslation.push({
      id: 'tr-custom-b',
      custom_product_id: 'custom-b',
      locale: 'en',
      title: 'Custom B',
      slug: 'custom-b',
    });
    expect(
      await errorOf(h.service.publicList(IDS.storeB, 'custom-b', 1)),
    ).toEqual({ status: 404, code: 'STOREFRONT_PRODUCT_NOT_FOUND' });
  });
});

describe('ReviewsService: owner moderation', () => {
  it('approve: APPROVED, published_at set once, moderator recorded, store revalidated', async () => {
    const h = buildReviews();
    const row = seedAnnaReview(h, { status: 'PENDING', published_at: null });
    const view = await moderate(h, IDS.ownerA, row.id, 'APPROVED');
    expect(view.status).toBe('APPROVED');
    expect(view.published_at).toEqual(expect.any(String));
    expect(h.reviews()[0]).toMatchObject({
      status: 'APPROVED',
      moderated_by: IDS.ownerA,
    });
    expect(h.reviews()[0].moderated_at).toBeInstanceOf(Date);
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledTimes(1);
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledWith(A);
  });

  it('re-approval keeps the first published_at', async () => {
    const h = buildReviews();
    const first = new Date('2026-10-01T00:00:00Z');
    const row = seedAnnaReview(h, { status: 'REJECTED', published_at: first });
    await moderate(h, IDS.ownerA, row.id, 'APPROVED');
    expect(h.reviews()[0].published_at).toBe(first);
  });

  it('reject an APPROVED review: revalidated; PENDING <-> REJECTED: not', async () => {
    const h = buildReviews();
    const row = seedAnnaReview(h, { status: 'APPROVED' });
    await moderate(h, IDS.ownerA, row.id, 'REJECTED');
    expect(h.reviews()[0].status).toBe('REJECTED');
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledTimes(1);

    const h2 = buildReviews();
    const pending = seedAnnaReview(h2, {
      status: 'PENDING',
      published_at: null,
    });
    await moderate(h2, IDS.ownerA, pending.id, 'REJECTED');
    expect(h2.reviews()[0].status).toBe('REJECTED');
    expect(h2.revalidation.revalidateStoreById).not.toHaveBeenCalled();
  });

  it('setting the status it already has changes nothing', async () => {
    const h = buildReviews();
    const row = seedAnnaReview(h, { status: 'APPROVED' });
    const before = { ...row };
    await moderate(h, IDS.ownerA, row.id, 'APPROVED');
    expect(h.reviews()[0]).toEqual(before);
    expect(h.revalidation.revalidateStoreById).not.toHaveBeenCalled();
  });

  it.each([
    ['flagged test', { is_test: true }],
    ['trashed', { deleted_at: new Date() }],
  ])(
    'approve is refused while the order is %s (409), reject still works',
    async (_label, over) => {
      const h = buildReviews();
      const row = seedAnnaReview(h, { status: 'PENDING', published_at: null });
      Object.assign(h.db.order.find((o) => o.id === IDS.annaOrder)!, over);
      expect(
        await errorOf(moderate(h, IDS.ownerA, row.id, 'APPROVED')),
      ).toEqual({ status: 409, code: 'REVIEW_ORDER_NOT_ELIGIBLE' });
      expect(h.reviews()[0].status).toBe('PENDING');
      await moderate(h, IDS.ownerA, row.id, 'REJECTED');
      expect(h.reviews()[0].status).toBe('REJECTED');
    },
  );

  it('approve is refused when the review has no order any more', async () => {
    const h = buildReviews();
    const row = seedAnnaReview(h, {
      status: 'PENDING',
      order_id: null,
      order_item_id: null,
    });
    expect(await errorOf(moderate(h, IDS.ownerA, row.id, 'APPROVED'))).toEqual({
      status: 409,
      code: 'REVIEW_ORDER_NOT_ELIGIBLE',
    });
  });

  it('a later refund / cancel of the order does not block approval (decision 4)', async () => {
    const h = buildReviews();
    const row = seedAnnaReview(h, { status: 'PENDING', published_at: null });
    Object.assign(h.db.order.find((o) => o.id === IDS.annaOrder)!, {
      status: 'REFUNDED',
      payment_status: 'refunded',
    });
    const view = await moderate(h, IDS.ownerA, row.id, 'APPROVED');
    expect(view.status).toBe('APPROVED');
  });

  it('reply: set, change, remove; revalidates only for a public review', async () => {
    const h = buildReviews();
    const row = seedAnnaReview(h, { status: 'APPROVED' });
    const view = await reply(h, IDS.ownerA, row.id, '  Thank you!\r\n');
    expect(view.reply).toEqual({
      body: 'Thank you!',
      replied_at: expect.any(String),
    });
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledTimes(1);
    // Same text again: nothing happens.
    await reply(h, IDS.ownerA, row.id, 'Thank you!');
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledTimes(1);
    const removed = await h.service.removeReply(IDS.ownerA, row.id);
    expect(removed.reply).toBeNull();
    expect(h.reviews()[0]).toMatchObject({
      reply_body: null,
      replied_at: null,
    });
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledTimes(2);
    // Removing a reply that is not there: nothing happens.
    await h.service.removeReply(IDS.ownerA, row.id);
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledTimes(2);

    const h2 = buildReviews();
    const pending = seedAnnaReview(h2, { status: 'PENDING' });
    await reply(h2, IDS.ownerA, pending.id, 'We are looking into it.');
    await h2.service.removeReply(IDS.ownerA, pending.id);
    expect(h2.revalidation.revalidateStoreById).not.toHaveBeenCalled();
  });

  it('reply: empty or over 1000 characters -> 400 REVIEW_REPLY_INVALID', async () => {
    const h = buildReviews();
    const row = seedAnnaReview(h);
    for (const body of ['', '   ', 'x'.repeat(1001)]) {
      expect(await errorOf(reply(h, IDS.ownerA, row.id, body))).toEqual({
        status: 400,
        code: 'REVIEW_REPLY_INVALID',
      });
    }
    expect(h.reviews()[0].reply_body).toBeNull();
  });

  it('a reply never touches rating, text or display name', async () => {
    const h = buildReviews();
    const row = seedAnnaReview(h);
    const before = { ...row };
    await reply(h, IDS.ownerA, row.id, 'Thanks');
    await moderate(h, IDS.ownerA, row.id, 'REJECTED');
    for (const key of ['rating', 'title', 'body', 'display_name', 'locale']) {
      expect(h.reviews()[0][key]).toEqual(before[key]);
    }
  });

  it('delete: removes the row; revalidates only when it was public', async () => {
    const h = buildReviews();
    const row = seedAnnaReview(h, { status: 'APPROVED' });
    expect(await h.service.ownerDelete(IDS.ownerA, row.id)).toEqual({
      deleted: true,
    });
    expect(h.reviews()).toHaveLength(0);
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledTimes(1);
    const rejected = seedAnnaReview(h, { status: 'REJECTED' });
    await h.service.ownerDelete(IDS.ownerA, rejected.id);
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledTimes(1);
  });

  it('app switched off: the owner still moderates, but nothing is revalidated', async () => {
    const h = buildReviews({ enabled: [] });
    const row = seedAnnaReview(h, { status: 'APPROVED' });
    await reply(h, IDS.ownerA, row.id, 'Thanks');
    await moderate(h, IDS.ownerA, row.id, 'REJECTED');
    await moderate(h, IDS.ownerA, row.id, 'APPROVED');
    await h.service.ownerDelete(IDS.ownerA, row.id);
    expect(h.reviews()).toHaveLength(0);
    expect(h.revalidation.revalidateStoreById).not.toHaveBeenCalled();
  });

  it('a failing revalidation never fails the moderation', async () => {
    const h = buildReviews();
    h.revalidation.revalidateStoreById.mockRejectedValue(new Error('down'));
    const row = seedAnnaReview(h, { status: 'PENDING', published_at: null });
    const view = await moderate(h, IDS.ownerA, row.id, 'APPROVED');
    expect(view.status).toBe('APPROVED');
  });

  it("another store's review: 404 on every owner action and nothing is written", async () => {
    const h = buildReviews();
    const row = seedAnnaReview(h, { status: 'PENDING', published_at: null });
    const before = { ...row };
    const calls = [
      () => moderate(h, IDS.ownerB, row.id, 'APPROVED'),
      () => moderate(h, IDS.ownerB, row.id, 'REJECTED'),
      () => reply(h, IDS.ownerB, row.id, 'Hello from store B'),
      () => h.service.removeReply(IDS.ownerB, row.id),
      () => h.service.ownerDelete(IDS.ownerB, row.id),
      () => moderate(h, IDS.ownerB, 'not-a-uuid', 'APPROVED'),
    ];
    for (const call of calls) {
      expect(await errorOf(call())).toEqual({
        status: 404,
        code: 'REVIEW_NOT_FOUND',
      });
    }
    expect(h.reviews()).toEqual([before]);
    expect(h.prisma.productReview.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.productReview.deleteMany).not.toHaveBeenCalled();
    expect(h.revalidation.revalidateStoreById).not.toHaveBeenCalled();
  });

  it('every write by review id carries store_id in the same where', async () => {
    const h = buildReviews();
    const row = seedAnnaReview(h, { status: 'PENDING', published_at: null });
    await moderate(h, IDS.ownerA, row.id, 'APPROVED');
    await reply(h, IDS.ownerA, row.id, 'Thanks');
    await h.service.removeReply(IDS.ownerA, row.id);
    await h.service.ownerDelete(IDS.ownerA, row.id);
    const wheres = [
      ...h.prisma.productReview.findFirst.mock.calls,
      ...h.prisma.productReview.updateMany.mock.calls,
      ...h.prisma.productReview.deleteMany.mock.calls,
    ].map(([args]) => args.where);
    expect(wheres.length).toBeGreaterThan(6);
    for (const where of wheres) {
      expect(where).toMatchObject({ id: row.id, store_id: A });
    }
  });

  it('a user without a store -> 404 STORE_NOT_FOUND', async () => {
    const h = buildReviews();
    expect(await errorOf(h.service.pendingCount(IDS.annaUser))).toEqual({
      status: 404,
      code: 'STORE_NOT_FOUND',
    });
  });
});

describe('ReviewsService: owner list', () => {
  function seedList(h: ReviewsHarness) {
    seedAnnaReview(h, {
      status: 'PENDING',
      rating: 5,
      source: 'LINK',
      created_at: new Date('2026-11-03T00:00:00Z'),
    });
    h.reviews().push(
      reviewRow({
        product_id: IDS.necklace,
        customer_id: IDS.bertil,
        order_id: IDS.bertilOrder,
        status: 'APPROVED',
        rating: 4,
        reply_body: 'Thanks Bertil',
        replied_at: new Date('2026-11-05T00:00:00Z'),
        created_at: new Date('2026-11-02T00:00:00Z'),
      }),
      reviewRow({
        custom_product_id: IDS.customMug,
        customer_id: IDS.anna,
        order_id: IDS.annaOrder,
        status: 'REJECTED',
        rating: 1,
        created_at: new Date('2026-11-01T00:00:00Z'),
      }),
      reviewRow({
        store_id: IDS.storeB,
        product_id: IDS.productB,
        customer_id: IDS.cecilia,
        order_id: IDS.ceciliaOrder,
        status: 'PENDING',
        rating: 2,
      }),
    );
  }

  it('lists only my store, newest first, with counts per status', async () => {
    const h = buildReviews();
    seedList(h);
    const page = await h.service.ownerList(IDS.ownerA, {});
    expect(page.total).toBe(3);
    expect(page.page).toBe(1);
    expect(page.limit).toBe(25);
    expect(page.counts).toEqual({ PENDING: 1, APPROVED: 1, REJECTED: 1 });
    expect(page.items.map((i) => i.status)).toEqual([
      'PENDING',
      'APPROVED',
      'REJECTED',
    ]);
    const b = await h.service.ownerList(IDS.ownerB, {});
    expect(b.total).toBe(1);
    expect(b.counts).toEqual({ PENDING: 1, APPROVED: 0, REJECTED: 0 });
    // One joined query + count + groupBy, no per-row reads.
    expect(h.prisma.productReview.findMany).toHaveBeenCalledTimes(2);
    expect(h.prisma.productReview.findFirst).not.toHaveBeenCalled();
    expect(h.prisma.product.findFirst).not.toHaveBeenCalled();
    expect(h.prisma.order.findFirst).not.toHaveBeenCalled();
  });

  it('the owner row: product, order number, customer name, source; no email or phone', async () => {
    const h = buildReviews();
    seedList(h);
    const page = await h.service.ownerList(IDS.ownerA, {});
    const [first, , third] = page.items;
    expect(first).toEqual({
      id: expect.any(String),
      status: 'PENDING',
      rating: 5,
      title: 'Perfect gift',
      body: 'Fast delivery and the engraving looks great.',
      display_name: 'Anna S.',
      locale: 'sv',
      verified: true,
      source: 'LINK',
      created_at: '2026-11-03T00:00:00.000Z',
      updated_at: expect.any(String),
      published_at: expect.any(String),
      reply: null,
      product: {
        id: IDS.necklace,
        kind: 'product',
        // Title in the store primary locale (sv).
        title: 'Namnhalsband',
        slug: 'namnhalsband',
        image_url: '/uploads/necklace.jpg',
      },
      order: { id: IDS.annaOrder, order_number: 'ORD-1' },
      customer: { id: IDS.anna, name: 'Anna Svensson' },
    });
    expect(third.product).toEqual({
      id: IDS.customMug,
      kind: 'custom_product',
      title: 'Mugg',
      slug: 'mugg',
      // No mockup: the base product image.
      image_url: '/uploads/mug-base.jpg',
    });
    const json = JSON.stringify(page);
    expect(json).not.toContain('example.test');
    expect(json).not.toContain('+46700000000');
    expect(json).not.toContain('moderated_by');
  });

  it('filters: status, rating, product (own or custom); counts follow rating / product, not status', async () => {
    const h = buildReviews();
    seedList(h);
    const byStatus = await h.service.ownerList(IDS.ownerA, {
      status: 'APPROVED',
    });
    expect(byStatus.total).toBe(1);
    expect(byStatus.counts).toEqual({ PENDING: 1, APPROVED: 1, REJECTED: 1 });

    const byRating = await h.service.ownerList(IDS.ownerA, { rating: '1' });
    expect(byRating.items.map((i) => i.rating)).toEqual([1]);
    expect(byRating.counts).toEqual({ PENDING: 0, APPROVED: 0, REJECTED: 1 });

    const byProduct = await h.service.ownerList(IDS.ownerA, {
      product_id: IDS.necklace,
    });
    expect(byProduct.total).toBe(2);
    const byCustom = await h.service.ownerList(IDS.ownerA, {
      product_id: IDS.customMug,
    });
    expect(byCustom.items.map((i) => i.product?.kind)).toEqual([
      'custom_product',
    ]);
    // The product filter never reaches into another store.
    const foreign = await h.service.ownerList(IDS.ownerA, {
      product_id: IDS.productB,
    });
    expect(foreign.total).toBe(0);
  });

  it('junk filters are ignored, paging is clamped', async () => {
    const h = buildReviews();
    seedList(h);
    const page = await h.service.ownerList(IDS.ownerA, {
      status: 'DELETED',
      rating: '9',
      product_id: "x' OR 1=1",
      page: '-3',
      limit: '5000',
    });
    expect(page.total).toBe(3);
    expect(page.page).toBe(1);
    expect(page.limit).toBe(100);
    const second = await h.service.ownerList(IDS.ownerA, {
      page: '2',
      limit: '2',
    });
    expect(second.items).toHaveLength(1);
    expect(second.total).toBe(3);
  });

  it('pending count: my store only', async () => {
    const h = buildReviews();
    seedList(h);
    expect(await h.service.pendingCount(IDS.ownerA)).toEqual({ count: 1 });
    expect(await h.service.pendingCount(IDS.ownerB)).toEqual({ count: 1 });
    h.reviews().length = 0;
    expect(await h.service.pendingCount(IDS.ownerA)).toEqual({ count: 0 });
  });
});

describe('ReviewsService: hooks', () => {
  it('hideForOrders: PENDING / APPROVED reviews of the orders become REJECTED without a moderator', async () => {
    const h = buildReviews();
    const approved = seedAnnaReview(h, {
      status: 'APPROVED',
      moderated_by: IDS.ownerA,
    });
    const pending = reviewRow({
      product_id: IDS.ring,
      customer_id: IDS.anna,
      order_id: IDS.annaOrder,
      status: 'PENDING',
    });
    const other = reviewRow({
      product_id: IDS.necklace,
      customer_id: IDS.bertil,
      order_id: IDS.bertilOrder,
      status: 'APPROVED',
    });
    h.reviews().push(pending, other);
    expect(await h.service.hideForOrders([IDS.annaOrder])).toEqual({
      hidden: 2,
    });
    expect(approved).toMatchObject({ status: 'REJECTED', moderated_by: null });
    expect(approved.moderated_at).toBeInstanceOf(Date);
    expect(pending.status).toBe('REJECTED');
    expect(other.status).toBe('APPROVED');
    // One was public: the store is revalidated once.
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledTimes(1);
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledWith(A);
  });

  it('hideForOrders: only PENDING reviews -> no revalidation; nothing to hide -> no write', async () => {
    const h = buildReviews();
    seedAnnaReview(h, { status: 'PENDING' });
    await h.service.hideForOrders([IDS.annaOrder]);
    expect(h.reviews()[0].status).toBe('REJECTED');
    expect(h.revalidation.revalidateStoreById).not.toHaveBeenCalled();

    h.prisma.productReview.updateMany.mockClear();
    expect(await h.service.hideForOrders([IDS.annaOrder])).toEqual({
      hidden: 0,
    });
    expect(await h.service.hideForOrders([])).toEqual({ hidden: 0 });
    expect(await h.service.hideForOrders([IDS.bertilOrder])).toEqual({
      hidden: 0,
    });
    expect(h.prisma.productReview.updateMany).not.toHaveBeenCalled();
  });

  it('hideForOrders: app off -> hidden, not revalidated', async () => {
    const h = buildReviews({ enabled: [] });
    seedAnnaReview(h, { status: 'APPROVED' });
    await h.service.hideForOrders([IDS.annaOrder]);
    expect(h.reviews()[0].status).toBe('REJECTED');
    expect(h.revalidation.revalidateStoreById).not.toHaveBeenCalled();
  });

  it('restoring the order does not re-approve (nothing listens to it)', async () => {
    const h = buildReviews();
    seedAnnaReview(h, { status: 'APPROVED' });
    await h.service.hideForOrders([IDS.annaOrder]);
    // The review stays hidden until the owner approves it again.
    const page = await h.service.publicList(A, 'namnhalsband', 1);
    expect(page.summary.count).toBe(0);
  });

  it('removeForCustomer: deletes every review of the customer and revalidates the stores that showed one', async () => {
    const h = buildReviews();
    seedAnnaReview(h, { status: 'APPROVED' });
    h.reviews().push(
      reviewRow({
        product_id: IDS.ring,
        customer_id: IDS.anna,
        status: 'PENDING',
      }),
      reviewRow({
        product_id: IDS.necklace,
        customer_id: IDS.bertil,
        status: 'APPROVED',
      }),
    );
    expect(await h.service.removeForCustomer(IDS.anna)).toEqual({ deleted: 2 });
    expect(h.reviews().map((r) => r.customer_id)).toEqual([IDS.bertil]);
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledTimes(1);
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledWith(A);
  });

  it('removeForCustomer: no public review -> no revalidation; no review -> no write', async () => {
    const h = buildReviews();
    seedAnnaReview(h, { status: 'REJECTED' });
    await h.service.removeForCustomer(IDS.anna);
    expect(h.reviews()).toHaveLength(0);
    expect(h.revalidation.revalidateStoreById).not.toHaveBeenCalled();
    h.prisma.productReview.deleteMany.mockClear();
    expect(await h.service.removeForCustomer(IDS.anna)).toEqual({ deleted: 0 });
    expect(await h.service.removeForCustomer('')).toEqual({ deleted: 0 });
    expect(h.prisma.productReview.deleteMany).not.toHaveBeenCalled();
  });
});
