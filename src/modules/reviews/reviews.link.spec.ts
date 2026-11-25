/* eslint-disable @typescript-eslint/no-unsafe-assignment -- in-memory Prisma fake rows are untyped in tests */
import { Logger } from '@nestjs/common';
import { IDS, TEST_JWT_SECRET, reviewRow } from './reviews-fake-db.mockspec';
import {
  buildReviews,
  errorOf,
  submission,
  submissionFields,
  type ReviewsHarness,
} from './reviews-harness.mockspec';
import { REVIEW_LINK_TOKEN_TYPE } from './review-link-token.service';

const A = IDS.storeA;

/** The body of PUT reviews/link for a token. */
const linkBody = (token: string, over: Record<string, unknown> = {}) => {
  const { product_id: _p, ...fields } = submissionFields(over);
  void _p;
  return { ...fields, token } as never;
};

const meta = { ip: '203.0.113.9' };

const INVALID = { status: 401, code: 'REVIEW_LINK_INVALID' };

describe('ReviewsService: owner creates review links', () => {
  it('one link per distinct product of the order, bound to its first line', async () => {
    const h = buildReviews();
    h.reviews().push(
      reviewRow({
        product_id: IDS.ring,
        customer_id: IDS.anna,
        status: 'APPROVED',
      }),
    );
    const { links } = await h.service.createLinks(IDS.ownerA, IDS.annaOrder);
    expect(links.map((l) => l.order_item_id)).toEqual([
      IDS.annaOrderLine,
      IDS.annaOrderRingLine,
      IDS.annaMugLine,
    ]);
    // Titles in the store primary locale; status of the buyer's own review.
    expect(links.map((l) => [l.product_title, l.review_status])).toEqual([
      ['Namnhalsband', null],
      ['Ring', 'APPROVED'],
      ['Mugg', null],
    ]);
    for (const link of links) {
      expect(link.url).toMatch(
        /^https:\/\/shop\.example\.test\/store\/alpha\/reviews\/write#token=[\w-]+\.[\w-]+\.[\w-]+$/,
      );
      expect(new Date(link.expires_at).getTime()).toBeGreaterThan(
        Date.now() + 89 * 24 * 3600 * 1000,
      );
    }
  });

  it('the token of a link is bound to store + order + line + buyer, ids only', async () => {
    const h = buildReviews();
    const { links } = await h.service.createLinks(IDS.ownerA, IDS.annaOrder);
    const token = links[1].url.split('#token=')[1];
    const payload = h.jwt.decode<Record<string, unknown>>(token);
    expect(payload).toMatchObject({
      type: REVIEW_LINK_TOKEN_TYPE,
      sub: IDS.annaUser,
      sid: A,
      oid: IDS.annaOrder,
      oi: IDS.annaOrderRingLine,
    });
    expect(JSON.stringify(payload)).not.toContain('example.test');
    expect(JSON.stringify(payload)).not.toContain('Anna');
    // And it opens the form of exactly that product.
    const ctx = await h.service.linkContext(A, token);
    expect(ctx.product.id).toBe(IDS.ring);
  });

  it('origin: the order host while it is an ACTIVE domain of the store, else the platform URL', async () => {
    const h = buildReviews();
    const order = h.db.order.find((o) => o.id === IDS.annaOrder)!;
    order.hostname = 'Namez.SE';
    h.db.storeDomain.push({
      id: 'd1',
      store_id: A,
      hostname: 'namez.se',
      status: 'ACTIVE',
    });
    let { links } = await h.service.createLinks(IDS.ownerA, IDS.annaOrder);
    expect(
      links[0].url.startsWith('https://namez.se/reviews/write#token='),
    ).toBe(true);

    // Not active any more, or a host of another store: never trusted.
    h.db.storeDomain[0].status = 'PENDING';
    ({ links } = await h.service.createLinks(IDS.ownerA, IDS.annaOrder));
    expect(
      links[0].url.startsWith('https://shop.example.test/store/alpha/'),
    ).toBe(true);
    h.db.storeDomain[0].status = 'ACTIVE';
    h.db.storeDomain[0].store_id = IDS.storeB;
    ({ links } = await h.service.createLinks(IDS.ownerA, IDS.annaOrder));
    expect(
      links[0].url.startsWith('https://shop.example.test/store/alpha/'),
    ).toBe(true);

    // Legacy custom domain of the store.
    h.db.store.find((s) => s.id === A)!.custom_domain = 'alpha.example';
    ({ links } = await h.service.createLinks(IDS.ownerA, IDS.annaOrder));
    expect(
      links[0].url.startsWith('https://alpha.example/reviews/write#token='),
    ).toBe(true);
  });

  it('a product that left the store gets no link', async () => {
    const h = buildReviews();
    h.db.product.find((p) => p.id === IDS.ring)!.creator_id = 'someone-else';
    const { links } = await h.service.createLinks(IDS.ownerA, IDS.annaOrder);
    expect(links.map((l) => l.order_item_id)).toEqual([
      IDS.annaOrderLine,
      IDS.annaMugLine,
    ]);
  });

  it('app off -> 409 REVIEWS_NOT_ENABLED', async () => {
    const h = buildReviews({ enabled: [IDS.storeB] });
    expect(
      await errorOf(h.service.createLinks(IDS.ownerA, IDS.annaOrder)),
    ).toEqual({ status: 409, code: 'REVIEWS_NOT_ENABLED' });
  });

  it('an order of another store (or unknown) -> 404 ORDER_NOT_FOUND, no token is signed', async () => {
    const h = buildReviews();
    const sign = jest.spyOn(h.tokens, 'sign');
    for (const orderId of [IDS.ceciliaOrder, IDS.necklace]) {
      expect(await errorOf(h.service.createLinks(IDS.ownerA, orderId))).toEqual(
        {
          status: 404,
          code: 'ORDER_NOT_FOUND',
        },
      );
    }
    // And the other way round.
    expect(
      await errorOf(h.service.createLinks(IDS.ownerB, IDS.annaOrder)),
    ).toEqual({ status: 404, code: 'ORDER_NOT_FOUND' });
    expect(sign).not.toHaveBeenCalled();
  });

  it.each([
    ['unpaid', { payment_status: 'pending' }],
    ['cancelled', { status: 'CANCELLED' }],
    ['refunded', { status: 'REFUNDED', payment_status: 'refunded' }],
    ['test', { is_test: true }],
    ['trashed', { deleted_at: new Date() }],
  ])(
    'an order that is %s -> 409 REVIEW_ORDER_NOT_ELIGIBLE',
    async (_l, over) => {
      const h = buildReviews();
      Object.assign(h.db.order.find((o) => o.id === IDS.annaOrder)!, over);
      expect(
        await errorOf(h.service.createLinks(IDS.ownerA, IDS.annaOrder)),
      ).toEqual({ status: 409, code: 'REVIEW_ORDER_NOT_ELIGIBLE' });
    },
  );

  it('a blocked buyer gets no link (it could never open)', async () => {
    const h = buildReviews();
    h.db.user.find((u) => u.id === IDS.annaUser)!.status = 'BANNED';
    expect(
      await errorOf(h.service.createLinks(IDS.ownerA, IDS.annaOrder)),
    ).toEqual({ status: 409, code: 'REVIEW_ORDER_NOT_ELIGIBLE' });
  });

  it('writes one log line with store, order and acting user, never a token', async () => {
    const h = buildReviews();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    try {
      const { links } = await h.service.createLinks(IDS.ownerA, IDS.annaOrder);
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0][0]);
      expect(line).toContain(`store=${A}`);
      expect(line).toContain(`order=${IDS.annaOrder}`);
      expect(line).toContain(`by=${IDS.ownerA}`);
      for (const link of links) {
        expect(line).not.toContain(link.url.split('#token=')[1]);
      }
      expect(line).not.toContain('eyJ');
    } finally {
      log.mockRestore();
    }
  });
});

describe('ReviewsService: review link (no login)', () => {
  it('context: product, name suggestion, no review yet, expiry; no email, no order number', async () => {
    const h = buildReviews();
    const ctx = await h.service.linkContext(A, await h.linkToken());
    expect(ctx).toEqual({
      product: {
        id: IDS.necklace,
        translations: [
          { locale: 'sv', title: 'Namnhalsband', slug: 'namnhalsband' },
          { locale: 'de', title: 'Namenskette', slug: 'namenskette' },
        ],
        image_url: '/uploads/necklace.jpg',
      },
      display_name_suggestion: 'Anna S.',
      review: null,
      expires_at: expect.any(String),
    });
    const json = JSON.stringify(ctx);
    expect(json).not.toContain('example.test');
    expect(json).not.toContain('ORD-');
    expect(json).not.toContain('Svensson');
  });

  it('context of a custom-product line, and of an existing review (no id)', async () => {
    const h = buildReviews();
    h.reviews().push(
      reviewRow({
        custom_product_id: IDS.customMug,
        customer_id: IDS.anna,
        status: 'REJECTED',
        rating: 2,
        title: 'Hm',
      }),
    );
    const ctx = await h.service.linkContext(
      A,
      await h.linkToken({ orderItemId: IDS.annaMugLine }),
    );
    expect(ctx.product).toEqual({
      id: IDS.customMug,
      translations: [{ locale: 'sv', title: 'Mugg', slug: 'mugg' }],
      image_url: '/uploads/mug-base.jpg',
    });
    expect(ctx.review).toEqual({
      rating: 2,
      title: 'Hm',
      body: 'A perfectly fine review text.',
      display_name: 'Anna S.',
      status: 'REJECTED',
    });
  });

  it('submit: creates a PENDING review with source LINK for the line of the token', async () => {
    const h = buildReviews();
    const res = await h.service.submitLink(
      A,
      linkBody(await h.linkToken()),
      meta,
    );
    expect(res).toEqual({ id: expect.any(String), status: 'PENDING' });
    expect(h.reviews()[0]).toMatchObject({
      store_id: A,
      customer_id: IDS.anna,
      product_id: IDS.necklace,
      order_id: IDS.annaOrder,
      order_item_id: IDS.annaOrderLine,
      source: 'LINK',
      status: 'PENDING',
      verified_purchase: true,
    });
    expect(h.reviews()[0]).not.toHaveProperty('token');
  });

  it('the same link edits the same review (not single use), nothing else', async () => {
    const h = buildReviews();
    const token = await h.linkToken();
    const first = await h.service.submitLink(A, linkBody(token), meta);
    const second = await h.service.submitLink(
      A,
      linkBody(token, {
        rating: 1,
        body: 'Changed my mind completely, sorry.',
      }),
      meta,
    );
    expect(second.id).toBe(first.id);
    expect(h.reviews()).toHaveLength(1);
    expect(h.reviews()[0].rating).toBe(1);
  });

  it('the link and the account write the same row (one review per customer and product)', async () => {
    const h = buildReviews();
    const viaAccount = await h.service.submitMine(
      {
        id: IDS.annaUser,
        email: 'x',
        role: 'CUSTOMER',
        status: 'ACTIVE',
        storeId: A,
      },
      A,
      submission(),
    );
    const viaLink = await h.service.submitLink(
      A,
      linkBody(await h.linkToken(), { rating: 4 }),
      meta,
    );
    expect(viaLink.id).toBe(viaAccount.id);
    expect(h.reviews()).toHaveLength(1);
    expect(h.reviews()[0]).toMatchObject({ rating: 4, source: 'LINK' });
  });

  it('auto_publish applies to the link too', async () => {
    const h = buildReviews();
    h.apps.settings.set(A, { auto_publish: true });
    const res = await h.service.submitLink(
      A,
      linkBody(await h.linkToken()),
      meta,
    );
    expect(res.status).toBe('APPROVED');
    expect(h.revalidation.revalidateStoreById).toHaveBeenCalledWith(A);
  });

  it('honeypot: 200-style answer, nothing verified, nothing written', async () => {
    const h = buildReviews({ captcha: true });
    const verify = jest.spyOn(h.tokens, 'verify');
    const res = await h.service.submitLink(
      A,
      linkBody('whatever', { website: 'spam' }),
      meta,
    );
    expect(res).toEqual({ id: null, status: 'PENDING' });
    expect(verify).not.toHaveBeenCalled();
    expect(h.turnstile.verifyCustomer).not.toHaveBeenCalled();
    expect(h.reviews()).toHaveLength(0);
  });

  describe('captcha', () => {
    it('off (TURNSTILE_CUSTOMERS not on): never called, no host lookup', async () => {
      const h = buildReviews();
      await h.service.submitLink(A, linkBody(await h.linkToken()), meta);
      expect(h.turnstile.verifyCustomer).not.toHaveBeenCalled();
      expect(h.prisma.storeDomain.findMany).not.toHaveBeenCalled();
    });

    it('on: verified with the token, the client ip and the hosts of the store', async () => {
      const h = buildReviews({ captcha: true });
      h.db.storeDomain.push({
        id: 'd1',
        store_id: A,
        hostname: 'namez.se',
        status: 'ACTIVE',
      });
      await h.service.submitLink(
        A,
        linkBody(await h.linkToken(), { turnstile_token: 'cf-token' }),
        meta,
      );
      expect(h.turnstile.verifyCustomer).toHaveBeenCalledTimes(1);
      const [token, ip, hosts] = h.turnstile.verifyCustomer.mock.calls[0];
      expect(token).toBe('cf-token');
      expect(ip).toBe('203.0.113.9');
      expect(hosts).toContain('namez.se');
      expect(h.reviews()).toHaveLength(1);
    });

    it('a failed captcha writes nothing', async () => {
      const h = buildReviews({ captcha: true });
      h.turnstile.verifyCustomer.mockRejectedValue(
        Object.assign(new Error('captcha'), { code: 'AUTH_CAPTCHA_FAILED' }),
      );
      await expect(
        h.service.submitLink(A, linkBody(await h.linkToken()), meta),
      ).rejects.toThrow('captcha');
      expect(h.reviews()).toHaveLength(0);
    });

    it('text rules run before the captcha (a typo never burns the answer)', async () => {
      const h = buildReviews({ captcha: true });
      expect(
        await errorOf(
          h.service.submitLink(
            A,
            linkBody(await h.linkToken(), { body: 'short' }),
            meta,
          ),
        ),
      ).toEqual({ status: 400, code: 'REVIEW_BODY_TOO_SHORT' });
      expect(h.turnstile.verifyCustomer).not.toHaveBeenCalled();
    });

    it('an invalid link is refused before the captcha is asked', async () => {
      const h = buildReviews({ captcha: true });
      expect(
        await errorOf(h.service.submitLink(A, linkBody('nope'), meta)),
      ).toEqual(INVALID);
      expect(h.turnstile.verifyCustomer).not.toHaveBeenCalled();
    });
  });

  describe('every mismatch between the token and the database is the same 401', () => {
    const both = async (h: ReviewsHarness, token: string, storeId = A) => {
      expect(await errorOf(h.service.linkContext(storeId, token))).toEqual(
        INVALID,
      );
      expect(
        await errorOf(h.service.submitLink(storeId, linkBody(token), meta)),
      ).toEqual(INVALID);
      expect(h.reviews()).toHaveLength(0);
    };

    it('a token of store A on the slug of store B', async () => {
      const h = buildReviews();
      await both(h, await h.linkToken(), IDS.storeB);
    });

    it('a token whose store claim is not the store of the slug, even when the order is', async () => {
      // Never signed by us; the claim is still checked on its own, not only
      // through the order lookup.
      const h = buildReviews();
      await both(h, await h.linkToken({ storeId: IDS.storeB }), A);
    });

    it('a token that names store B but an order of store A', async () => {
      const h = buildReviews();
      await both(h, await h.linkToken({ storeId: IDS.storeB }), IDS.storeB);
    });

    it("an order that belongs to another customer (Bertil's order, Anna as subject)", async () => {
      const h = buildReviews();
      await both(
        h,
        await h.linkToken({
          orderId: IDS.bertilOrder,
          orderItemId: IDS.bertilOrderLine,
        }),
      );
    });

    it('a subject of another store (Cecilia) on an order of store A', async () => {
      const h = buildReviews();
      await both(h, await h.linkToken({ userId: IDS.ceciliaUser }));
    });

    it('a line that is not a line of the order', async () => {
      const h = buildReviews();
      await both(h, await h.linkToken({ orderItemId: IDS.bertilOrderLine }));
    });

    it('unknown order / line / user ids', async () => {
      const h = buildReviews();
      await both(h, await h.linkToken({ orderId: IDS.necklace }));
      await both(h, await h.linkToken({ orderItemId: IDS.necklace }));
      await both(h, await h.linkToken({ userId: IDS.necklace }));
    });

    it.each(['SUSPENDED', 'BANNED', 'PENDING'])(
      'a customer whose account is %s',
      async (status) => {
        const h = buildReviews();
        h.db.user.find((u) => u.id === IDS.annaUser)!.status = status;
        await both(h, await h.linkToken());
      },
    );

    it('a staff account as subject', async () => {
      const h = buildReviews();
      await both(h, await h.linkToken({ userId: IDS.ownerA }));
    });

    it('an order moved to another store after the link was made', async () => {
      const h = buildReviews();
      const token = await h.linkToken();
      h.db.order.find((o) => o.id === IDS.annaOrder)!.store_id = IDS.storeB;
      await both(h, token);
    });

    it('forged, expired, foreign-purpose and session tokens', async () => {
      const h = buildReviews();
      const good = await h.linkToken();
      const [head, payload] = good.split('.');
      await both(h, `${head}.${payload}.AAAA`);
      const sign = (p: object, expiresIn = 600, secret = TEST_JWT_SECRET) =>
        h.jwt.signAsync(p, { secret, algorithm: 'HS256', expiresIn });
      const claims = {
        sub: IDS.annaUser,
        sid: A,
        oid: IDS.annaOrder,
        oi: IDS.annaOrderLine,
      };
      await both(
        h,
        await sign({ ...claims, type: REVIEW_LINK_TOKEN_TYPE }, -5),
      );
      await both(
        h,
        await sign(
          { ...claims, type: REVIEW_LINK_TOKEN_TYPE },
          600,
          'another-secret-0123456789abcdefgh',
        ),
      );
      await both(h, await sign({ ...claims, type: 'guest_order' }));
      // A customer access token (a session) is not a review link.
      await both(
        h,
        await sign({
          sub: IDS.annaUser,
          email: 'a@example.test',
          role: 'CUSTOMER',
          store_id: A,
        }),
      );
      await both(h, '');
      await both(h, 'x'.repeat(2000));
    });
  });

  describe('valid signature, order no longer a real purchase -> 409', () => {
    it.each([
      ['refunded', { status: 'REFUNDED', payment_status: 'refunded' }],
      ['cancelled', { status: 'CANCELLED' }],
      ['flagged test', { is_test: true }],
      ['trashed', { deleted_at: new Date() }],
      ['unpaid again', { payment_status: 'failed' }],
    ])('%s', async (_label, over) => {
      const h = buildReviews();
      const token = await h.linkToken();
      Object.assign(h.db.order.find((o) => o.id === IDS.annaOrder)!, over);
      const expected = { status: 409, code: 'REVIEW_ORDER_NOT_ELIGIBLE' };
      expect(await errorOf(h.service.linkContext(A, token))).toEqual(expected);
      expect(
        await errorOf(h.service.submitLink(A, linkBody(token), meta)),
      ).toEqual(expected);
      expect(h.reviews()).toHaveLength(0);
    });
  });

  it('a line whose product no longer belongs to the store -> 404 REVIEW_PRODUCT_NOT_FOUND', async () => {
    const h = buildReviews();
    const token = await h.linkToken();
    h.db.product.find((p) => p.id === IDS.necklace)!.creator_id = 'gone';
    const expected = { status: 404, code: 'REVIEW_PRODUCT_NOT_FOUND' };
    expect(await errorOf(h.service.linkContext(A, token))).toEqual(expected);
    expect(
      await errorOf(h.service.submitLink(A, linkBody(token), meta)),
    ).toEqual(expected);
    expect(h.reviews()).toHaveLength(0);
  });

  it('a guest record without a name: the form must ask for the public name', async () => {
    const h = buildReviews();
    const token = await h.linkToken({
      userId: IDS.guestUser,
      orderId: IDS.guestOrder,
      orderItemId: IDS.guestOrderLine,
    });
    const ctx = await h.service.linkContext(A, token);
    expect(ctx.display_name_suggestion).toBe('');
    expect(
      await errorOf(
        h.service.submitLink(A, linkBody(token, { display_name: '' }), meta),
      ),
    ).toEqual({ status: 400, code: 'REVIEW_DISPLAY_NAME_INVALID' });
    const res = await h.service.submitLink(
      A,
      linkBody(token, { display_name: 'Guest G.' }),
      meta,
    );
    expect(res.status).toBe('PENDING');
    expect(h.reviews()[0]).toMatchObject({
      customer_id: IDS.guest,
      product_id: IDS.ring,
      display_name: 'Guest G.',
    });
  });
});
