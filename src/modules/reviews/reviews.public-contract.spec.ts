/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- in-memory Prisma fake rows are untyped in tests */
import { StoreType } from '@prisma/client';
import { resolveProductTargetBySlug } from '../storefront/storefront.service';
import { IDS, reviewRow } from './reviews-fake-db.mockspec';
import { buildReviews } from './reviews-harness.mockspec';
import {
  ownerReviewSelect,
  publicReviewSelect,
  summarize,
  toPublicReview,
} from './reviews.types';

const A = IDS.storeA;

/** Every private fact of the seeded review, as it sits in the database. */
const PRIVATE = {
  customer_id: IDS.anna,
  order_id: IDS.annaOrder,
  order_item_id: IDS.annaOrderLine,
  moderated_by: IDS.ownerA,
};

function seeded() {
  const h = buildReviews();
  const row = reviewRow({
    product_id: IDS.necklace,
    ...PRIVATE,
    title: 'Perfect gift',
    body: 'Fast delivery and the engraving looks great.',
    display_name: 'Anna S.',
    locale: 'sv',
    rating: 5,
    source: 'LINK',
    status: 'APPROVED',
    published_at: new Date('2026-11-20T10:12:00.000Z'),
    moderated_at: new Date('2026-11-20T10:12:00.000Z'),
    reply_body: 'Thank you!',
    replied_at: new Date('2026-11-21T08:00:00.000Z'),
  });
  h.reviews().push(row);
  return { h, row };
}

describe('reviews public payload contract', () => {
  it('the response is exactly the documented shape', async () => {
    const { h, row } = seeded();
    const page = await h.service.publicList(A, 'namnhalsband', 1);
    expect(page).toEqual({
      summary: {
        average: 5,
        count: 1,
        distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 1 },
      },
      items: [
        {
          id: row.id,
          rating: 5,
          title: 'Perfect gift',
          body: 'Fast delivery and the engraving looks great.',
          display_name: 'Anna S.',
          locale: 'sv',
          verified: true,
          published_at: '2026-11-20T10:12:00.000Z',
          reply: { body: 'Thank you!', replied_at: '2026-11-21T08:00:00.000Z' },
        },
      ],
      page: 1,
      total: 1,
      total_pages: 1,
    });
  });

  it('a public item has exactly these keys (no customer, order, store, moderator, source, status)', async () => {
    const { h } = seeded();
    const page = await h.service.publicList(A, 'namnhalsband', 1);
    expect(Object.keys(page).sort()).toEqual(
      ['items', 'page', 'summary', 'total', 'total_pages'].sort(),
    );
    expect(Object.keys(page.items[0]).sort()).toEqual(
      [
        'body',
        'display_name',
        'id',
        'locale',
        'published_at',
        'rating',
        'reply',
        'title',
        'verified',
      ].sort(),
    );
    expect(Object.keys(page.items[0].reply!).sort()).toEqual([
      'body',
      'replied_at',
    ]);
  });

  it('no private value appears anywhere in the serialised payload', async () => {
    const { h } = seeded();
    const json = JSON.stringify(
      await h.service.publicList(A, 'namnhalsband', 1),
    );
    for (const value of [
      ...Object.values(PRIVATE),
      IDS.annaUser,
      IDS.storeA,
      IDS.necklace,
      'anna.svensson@example.test',
      'Svensson',
      '+46700000000',
      'ORD-1',
      'LINK',
      'APPROVED',
    ]) {
      expect(json).not.toContain(value);
    }
    for (const key of [
      'customer_id',
      'order_id',
      'order_item_id',
      'store_id',
      'product_id',
      'moderated_by',
      'moderated_at',
      'source',
      'status',
      'email',
      'verified_purchase',
      'reply_body',
      'created_at',
      'updated_at',
    ]) {
      expect(json).not.toContain(`"${key}"`);
    }
  });

  it('the query itself selects only the public columns (nothing private is even loaded)', async () => {
    const { h } = seeded();
    await h.service.publicList(A, 'namnhalsband', 1);
    const args = h.prisma.productReview.findMany.mock.calls[0][0];
    expect(args.select).toBe(publicReviewSelect);
    expect(Object.keys(publicReviewSelect).sort()).toEqual(
      [
        'body',
        'display_name',
        'id',
        'locale',
        'published_at',
        'rating',
        'replied_at',
        'reply_body',
        'title',
        'verified_purchase',
      ].sort(),
    );
    // No relation is joined into the public read.
    for (const value of Object.values(publicReviewSelect)) {
      expect(value).toBe(true);
    }
    // Every public query filters the store AND the target AND the status.
    for (const call of [
      args,
      h.prisma.productReview.groupBy.mock.calls[0][0],
    ]) {
      expect(call.where).toEqual({
        store_id: A,
        product_id: IDS.necklace,
        status: 'APPROVED',
      });
    }
  });

  it('toPublicReview copies key by key: an extra column on the row never leaks', () => {
    const row = {
      id: 'r1',
      rating: 4,
      title: null,
      body: 'Text of the review.',
      display_name: 'Bo',
      locale: 'sv',
      verified_purchase: true,
      published_at: null,
      reply_body: null,
      replied_at: null,
      // Columns a careless select (or a spread of a full row) would add.
      customer_id: 'secret-customer',
      order_id: 'secret-order',
      email: 'bo@example.test',
    };
    const out = toPublicReview(row);
    expect(out).toEqual({
      id: 'r1',
      rating: 4,
      title: null,
      body: 'Text of the review.',
      display_name: 'Bo',
      locale: 'sv',
      verified: true,
      published_at: null,
      reply: null,
    });
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('review text is returned as typed (plain text; the reader escapes it)', async () => {
    const h = buildReviews();
    const body =
      '<img src=x onerror=alert(1)> </script><script>alert(2)</script>';
    h.reviews().push(
      reviewRow({ product_id: IDS.necklace, customer_id: IDS.anna, body }),
    );
    const page = await h.service.publicList(A, 'namnhalsband', 1);
    expect(page.items[0].body).toBe(body);
  });

  it('the owner select never loads an email, phone or address', () => {
    const json = JSON.stringify(ownerReviewSelect);
    for (const key of ['email', 'phone', 'address', 'user', 'password']) {
      expect(json).not.toContain(key);
    }
    expect(ownerReviewSelect.customer.select).toEqual({
      id: true,
      first_name: true,
      last_name: true,
    });
    expect(ownerReviewSelect.order.select).toEqual({
      id: true,
      order_number: true,
    });
  });

  it('summarize ignores out-of-range ratings and rounds to one decimal', () => {
    expect(
      summarize([
        { rating: 5, count: 2 },
        { rating: 4, count: 1 },
        { rating: 9, count: 50 },
        { rating: 0, count: 50 },
      ]),
    ).toEqual({
      average: 4.7,
      count: 3,
      distribution: { '1': 0, '2': 0, '3': 0, '4': 1, '5': 2 },
    });
    expect(summarize([]).average).toBe(0);
    // 4.25 -> 4.3, 4.24 -> 4.2: a number with a dot, never a string.
    expect(
      summarize([
        { rating: 5, count: 1 },
        { rating: 4, count: 3 },
      ]).average,
    ).toBe(4.3);
  });
});

/**
 * The reviews read must resolve a slug to the SAME product as the product
 * page (StorefrontService.getProduct): own exact, custom exact, own
 * case-insensitive, custom case-insensitive; custom products only on a
 * non-INDEPENDENT store; PUBLISHED only.
 */
describe('resolveProductTargetBySlug (lookup order of the product page)', () => {
  type Hit = { id: string } | null;
  function client(answers: {
    ownExact?: Hit;
    customExact?: Hit;
    ownCi?: Hit;
    customCi?: Hit;
  }) {
    const calls: string[] = [];
    const isCi = (args: any) =>
      args.where.translations.some.slug.mode === 'insensitive';
    const prisma = {
      product: {
        findFirst: jest.fn((args: any) => {
          calls.push(isCi(args) ? 'ownCi' : 'ownExact');
          return Promise.resolve(
            (isCi(args) ? answers.ownCi : answers.ownExact) ?? null,
          );
        }),
      },
      customProduct: {
        findFirst: jest.fn((args: any) => {
          calls.push(isCi(args) ? 'customCi' : 'customExact');
          return Promise.resolve(
            (isCi(args) ? answers.customCi : answers.customExact) ?? null,
          );
        }),
      },
    };
    return { prisma: prisma as never, calls, raw: prisma };
  }
  const marketplace = {
    creator_id: 'creator-1',
    store_type: StoreType.MARKETPLACE,
  };
  const independent = {
    creator_id: 'creator-1',
    store_type: StoreType.INDEPENDENT,
  };

  it('own exact wins and nothing else is asked', async () => {
    const c = client({ ownExact: { id: 'p1' }, customExact: { id: 'c1' } });
    expect(
      await resolveProductTargetBySlug(c.prisma, marketplace, 'x'),
    ).toEqual({ kind: 'product', id: 'p1' });
    expect(c.calls).toEqual(['ownExact']);
  });

  it('custom exact wins over the own case-insensitive fallback', async () => {
    const c = client({ customExact: { id: 'c1' }, ownCi: { id: 'p2' } });
    expect(
      await resolveProductTargetBySlug(c.prisma, marketplace, 'x'),
    ).toEqual({ kind: 'custom_product', id: 'c1' });
    expect(c.calls).toEqual(['ownExact', 'customExact']);
  });

  it('then own case-insensitive, then custom case-insensitive', async () => {
    const own = client({ ownCi: { id: 'p2' }, customCi: { id: 'c2' } });
    expect(
      await resolveProductTargetBySlug(own.prisma, marketplace, 'x'),
    ).toEqual({ kind: 'product', id: 'p2' });
    expect(own.calls).toEqual(['ownExact', 'customExact', 'ownCi']);

    const custom = client({ customCi: { id: 'c2' } });
    expect(
      await resolveProductTargetBySlug(custom.prisma, marketplace, 'x'),
    ).toEqual({ kind: 'custom_product', id: 'c2' });
    expect(custom.calls).toEqual([
      'ownExact',
      'customExact',
      'ownCi',
      'customCi',
    ]);
  });

  it('an INDEPENDENT store never asks for custom products', async () => {
    const c = client({ customExact: { id: 'c1' }, customCi: { id: 'c2' } });
    expect(
      await resolveProductTargetBySlug(c.prisma, independent, 'x'),
    ).toBeNull();
    expect(c.calls).toEqual(['ownExact', 'ownCi']);
  });

  it('scoped to the creator, PUBLISHED only, id only, newest edit first', async () => {
    const c = client({});
    await resolveProductTargetBySlug(c.prisma, marketplace, 'Silver-Ring');
    for (const fn of [c.raw.product.findFirst, c.raw.customProduct.findFirst]) {
      for (const [args] of fn.mock.calls) {
        expect(args.where.creator_id).toBe('creator-1');
        expect(args.where.status).toBe('PUBLISHED');
        expect(args.select).toEqual({ id: true });
        expect(args.orderBy).toEqual({ updated_at: 'desc' });
      }
    }
    // The slug is normalised like the product page does (lower case).
    expect(
      c.raw.product.findFirst.mock.calls[0][0].where.translations.some.slug,
    ).toEqual({ equals: 'silver-ring' });
  });
});
