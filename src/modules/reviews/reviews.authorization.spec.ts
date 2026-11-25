/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- in-memory Prisma fake rows are untyped in tests */
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { RequireAppGuard } from '../../common/guards/require-app.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserThrottlerGuard } from '../../common/guards/user-throttler.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { GuestOrderTokenService } from '../auth/guest-order-token.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { ReviewsCreatorController } from './reviews-creator.controller';
import { ReviewsStorefrontController } from './reviews-storefront.controller';
import { ReviewsService } from './reviews.service';
import { IDS, TEST_JWT_SECRET, reviewRow } from './reviews-fake-db.mockspec';
import {
  USERS,
  buildReviews,
  submission,
  submissionFields,
  type ReviewsHarness,
} from './reviews-harness.mockspec';

/**
 * Authorization of EVERY reviews endpoint over HTTP: the real controllers,
 * guards (JWT strategy, roles, app gate), global pipe and error filter, and
 * the real service on the in-memory database. Only the throttler is relaxed
 * (its own block at the end uses the real one).
 */

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
interface Route {
  method: Method;
  path: string;
  body?: Record<string, unknown>;
}

const REVIEW_ID = '11111111-1111-4111-8111-111111111111';

const { product_id: _pid, ...fields } = submissionFields();
void _pid;

/** The four customer routes of a store slug. */
const customerRoutes = (slug: string): Route[] => [
  {
    method: 'get',
    path: `/storefront/${slug}/reviews/mine/eligibility?product_id=${IDS.necklace}`,
  },
  {
    method: 'get',
    path: `/storefront/${slug}/reviews/mine/orders/${IDS.annaOrder}`,
  },
  {
    method: 'put',
    path: `/storefront/${slug}/reviews/mine`,
    body: submissionFields(),
  },
  { method: 'delete', path: `/storefront/${slug}/reviews/mine/${REVIEW_ID}` },
];

/** The seven owner routes. */
const ownerRoutes = (
  reviewId = REVIEW_ID,
  orderId = IDS.annaOrder,
): Route[] => [
  { method: 'get', path: '/stores/my/reviews' },
  { method: 'get', path: '/stores/my/reviews/pending-count' },
  {
    method: 'patch',
    path: `/stores/my/reviews/${reviewId}/status`,
    body: { status: 'APPROVED' },
  },
  {
    method: 'put',
    path: `/stores/my/reviews/${reviewId}/reply`,
    body: { body: 'Thank you!' },
  },
  { method: 'delete', path: `/stores/my/reviews/${reviewId}/reply` },
  { method: 'delete', path: `/stores/my/reviews/${reviewId}` },
  {
    method: 'post',
    path: '/stores/my/reviews/links',
    body: { order_id: orderId },
  },
];

async function bootApp(h: ReviewsHarness, realThrottler = false) {
  const builder = Test.createTestingModule({
    imports: [
      PassportModule,
      ThrottlerModule.forRoot([{ ttl: 60000, limit: 300 }]),
    ],
    controllers: [ReviewsStorefrontController, ReviewsCreatorController],
    providers: [
      { provide: ReviewsService, useValue: h.service },
      { provide: StoreAppsService, useValue: h.apps },
      { provide: PrismaService, useValue: h.prisma },
      { provide: ConfigService, useValue: h.config },
      { provide: JwtService, useValue: h.jwt },
      RequireAppGuard,
      RolesGuard,
      JwtStrategy,
      ...(realThrottler
        ? [{ provide: APP_GUARD, useClass: ThrottlerGuard }]
        : []),
    ],
  });
  if (!realThrottler) {
    builder
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true });
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  return app;
}

describe('reviews endpoints: authorization (HTTP)', () => {
  let h: ReviewsHarness;
  let app: INestApplication;

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  /** An access token as AuthService issues it. */
  const access = (
    userId: string,
    role: string,
    storeId: string | null = null,
  ) =>
    h.jwt.signAsync(
      { sub: userId, email: 'x@example.test', role, store_id: storeId },
      { secret: TEST_JWT_SECRET, algorithm: 'HS256', expiresIn: 600 },
    );

  const tokens = {
    anna: () => access(IDS.annaUser, 'CUSTOMER', IDS.storeA),
    bertil: () => access(IDS.bertilUser, 'CUSTOMER', IDS.storeA),
    cecilia: () => access(IDS.ceciliaUser, 'CUSTOMER', IDS.storeB),
    ownerA: () => access(IDS.ownerA, 'CREATOR'),
    ownerB: () => access(IDS.ownerB, 'CREATOR'),
    admin: () => access(IDS.admin, 'ADMIN'),
    provider: () => access(IDS.provider, 'PROVIDER'),
  };

  const call = (route: Route, bearer?: string) => {
    let req = request(http())[route.method](route.path);
    if (bearer) req = req.set('Authorization', `Bearer ${bearer}`);
    return route.body ? req.send(route.body) : req;
  };

  /** A moderation route carrying the version of the row as stored now. */
  const fresh = (route: Route, reviewId: string): Route => ({
    ...route,
    body: {
      ...route.body,
      expected_updated_at: (
        h.reviews().find((r) => r.id === reviewId)?.updated_at as Date
      ).toISOString(),
    },
  });

  /** A stored review of Anna (store A) and one of Cecilia (store B). */
  function seedReviews() {
    const a = reviewRow({
      product_id: IDS.necklace,
      customer_id: IDS.anna,
      order_id: IDS.annaOrder,
      order_item_id: IDS.annaOrderLine,
      status: 'PENDING',
      published_at: null,
    });
    const b = reviewRow({
      store_id: IDS.storeB,
      product_id: IDS.productB,
      customer_id: IDS.cecilia,
      order_id: IDS.ceciliaOrder,
      order_item_id: IDS.ceciliaOrderLine,
      status: 'PENDING',
      published_at: null,
    });
    h.reviews().push(a, b);
    return { a, b };
  }

  beforeEach(async () => {
    h = buildReviews();
    app = await bootApp(h);
  });
  afterEach(() => app.close());

  // -- Anonymous -------------------------------------------------------------

  describe('anonymous', () => {
    it.each(customerRoutes('alpha'))(
      'customer route $method $path -> 401',
      async (route) => {
        await call(route).expect(401);
        expect(h.reviews()).toHaveLength(0);
      },
    );

    it.each(ownerRoutes())(
      'owner route $method $path -> 401',
      async (route) => {
        await call(route).expect(401);
      },
    );

    it('a malformed bearer -> 401', async () => {
      for (const route of [...customerRoutes('alpha'), ...ownerRoutes()]) {
        await call(route, 'not-a-token').expect(401);
      }
    });

    it('the public read needs no login', async () => {
      const res = await call({
        method: 'get',
        path: '/storefront/alpha/products/namnhalsband/reviews',
      }).expect(200);
      expect(res.body.summary.count).toBe(0);
    });
  });

  // -- Purpose tokens are not sessions --------------------------------------

  describe('purpose tokens on JWT routes', () => {
    it('a review-link token as Bearer -> 401 on every customer and owner route', async () => {
      const link = await h.linkToken();
      for (const route of [...customerRoutes('alpha'), ...ownerRoutes()]) {
        await call(route, link).expect(401);
      }
      expect(h.reviews()).toHaveLength(0);
    });

    it('a guest-order token as Bearer -> 401', async () => {
      const guest = await new GuestOrderTokenService(
        h.jwt,
        h.config as unknown as ConfigService,
      ).sign({
        userId: IDS.annaUser,
        orderId: IDS.annaOrder,
        storeId: IDS.storeA,
      });
      for (const route of customerRoutes('alpha')) {
        await call(route, guest.guest_token).expect(401);
      }
    });

    it('a customer token without the store claim, or of a blocked account -> 401', async () => {
      const noStore = await access(IDS.annaUser, 'CUSTOMER', null);
      await call(customerRoutes('alpha')[2], noStore).expect(401);
      const anna = await tokens.anna();
      h.db.user.find((u) => u.id === IDS.annaUser)!.status = 'SUSPENDED';
      await call(customerRoutes('alpha')[2], anna).expect(401);
      expect(h.reviews()).toHaveLength(0);
    });
  });

  // -- Customer routes -------------------------------------------------------

  describe('customer routes', () => {
    it.each(['ownerA', 'admin', 'provider'] as const)(
      'a %s token -> 403 on every customer route, nothing written',
      async (who) => {
        const bearer = await tokens[who]();
        for (const route of customerRoutes('alpha')) {
          await call(route, bearer).expect(403);
        }
        expect(h.reviews()).toHaveLength(0);
      },
    );

    it('a customer of store B on store A -> 403 CUSTOMER_STORE_MISMATCH on every route', async () => {
      const { a } = seedReviews();
      const bearer = await tokens.cecilia();
      const routes = customerRoutes('alpha');
      routes[3] = {
        method: 'delete',
        path: `/storefront/alpha/reviews/mine/${a.id}`,
      };
      for (const route of routes) {
        const res = await call(route, bearer).expect(403);
        expect(res.body.code).toBe('CUSTOMER_STORE_MISMATCH');
      }
      // And the other way round.
      const res = await call(customerRoutes('beta')[2], await tokens.anna());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('CUSTOMER_STORE_MISMATCH');
      expect(h.reviews()).toHaveLength(2);
      expect(h.reviews().every((r) => r.status === 'PENDING')).toBe(true);
    });

    it('a customer without a purchase -> 403 REVIEW_NOT_PURCHASED', async () => {
      const res = await call(
        {
          method: 'put',
          path: '/storefront/alpha/reviews/mine',
          body: submissionFields({ product_id: IDS.ring }),
        },
        await tokens.bertil(),
      ).expect(403);
      expect(res.body.code).toBe('REVIEW_NOT_PURCHASED');
      expect(h.reviews()).toHaveLength(0);
    });

    it("customer A on customer B's review id (DELETE) and order id -> 404, nothing deleted", async () => {
      const { a } = seedReviews();
      const bearer = await tokens.bertil();
      const del = await call(
        { method: 'delete', path: `/storefront/alpha/reviews/mine/${a.id}` },
        bearer,
      ).expect(404);
      expect(del.body.code).toBe('REVIEW_NOT_FOUND');
      const order = await call(
        {
          method: 'get',
          path: `/storefront/alpha/reviews/mine/orders/${IDS.annaOrder}`,
        },
        bearer,
      ).expect(404);
      expect(order.body.code).toBe('ORDER_NOT_FOUND');
      expect(h.reviews()).toHaveLength(2);
    });

    it('the buyer: eligibility, order items, submit and delete all work', async () => {
      const bearer = await tokens.anna();
      const [eligibility, orderItems, put] = customerRoutes('alpha');
      const e = await call(eligibility, bearer).expect(200);
      expect(e.body).toMatchObject({ eligible: true, reason: null });
      const o = await call(orderItems, bearer).expect(200);
      expect(o.body.items).toHaveLength(3);
      const s = await call(put, bearer).expect(200);
      expect(s.body).toEqual({ id: expect.any(String), status: 'PENDING' });
      await call(
        {
          method: 'delete',
          path: `/storefront/alpha/reviews/mine/${s.body.id}`,
        },
        bearer,
      ).expect(200, { deleted: true });
      expect(h.reviews()).toHaveLength(0);
    });

    it('the body is validated: unknown fields and wrong types are refused, a store id cannot be injected', async () => {
      const bearer = await tokens.anna();
      const put = (body: Record<string, unknown>) =>
        call(
          { method: 'put', path: '/storefront/alpha/reviews/mine', body },
          bearer,
        );
      const base = submissionFields();
      await put({ ...base, store_id: IDS.storeB }).expect(400);
      await put({ ...base, status: 'APPROVED' }).expect(400);
      await put({ ...base, customer_id: IDS.bertil }).expect(400);
      await put({ ...base, verified_purchase: true }).expect(400);
      await put({ ...base, product_id: 'not-a-uuid' }).expect(400);
      await put({ ...base, body: 'x'.repeat(10001) }).expect(400);
      expect(h.reviews()).toHaveLength(0);
      // Semantic rules answer a coded error a client can translate.
      const res = await put({ ...base, rating: 9 }).expect(400);
      expect(res.body.code).toBe('REVIEW_RATING_INVALID');
    });

    it('honeypot answers 200 and writes nothing', async () => {
      const res = await call(
        {
          method: 'put',
          path: '/storefront/alpha/reviews/mine',
          body: submissionFields({ website: 'https://spam.example' }),
        },
        await tokens.anna(),
      ).expect(200);
      expect(res.body).toEqual({ id: null, status: 'PENDING' });
      expect(h.reviews()).toHaveLength(0);
    });
  });

  // -- Review link routes ----------------------------------------------------

  describe('review link routes', () => {
    const context = (slug: string, token: unknown) =>
      request(http())
        .post(`/storefront/${slug}/reviews/link/context`)
        .send({ token });
    const submit = (
      slug: string,
      token: unknown,
      over: Record<string, unknown> = {},
    ) =>
      request(http())
        .put(`/storefront/${slug}/reviews/link`)
        .send({ ...fields, ...over, token });

    it('a valid link works without a login (context 200, submit 200)', async () => {
      const token = await h.linkToken();
      const ctx = await context('alpha', token).expect(200);
      expect(ctx.body.product.id).toBe(IDS.necklace);
      const res = await submit('alpha', token).expect(200);
      expect(res.body.status).toBe('PENDING');
      expect(h.reviews()[0]).toMatchObject({
        customer_id: IDS.anna,
        source: 'LINK',
      });
    });

    it('a token of store A on the slug of store B -> 401', async () => {
      const token = await h.linkToken();
      const ctx = await context('beta', token).expect(401);
      expect(ctx.body.code).toBe('REVIEW_LINK_INVALID');
      const res = await submit('beta', token).expect(401);
      expect(res.body.code).toBe('REVIEW_LINK_INVALID');
      expect(h.reviews()).toHaveLength(0);
    });

    it('a token whose order belongs to another customer or another store -> 401', async () => {
      const otherCustomer = await h.linkToken({
        orderId: IDS.bertilOrder,
        orderItemId: IDS.bertilOrderLine,
      });
      const otherStore = await h.linkToken({
        orderId: IDS.ceciliaOrder,
        orderItemId: IDS.ceciliaOrderLine,
      });
      for (const token of [otherCustomer, otherStore]) {
        await context('alpha', token).expect(401);
        await submit('alpha', token).expect(401);
      }
      expect(h.reviews()).toHaveLength(0);
    });

    it('a token whose customer is blocked -> 401', async () => {
      const token = await h.linkToken();
      h.db.user.find((u) => u.id === IDS.annaUser)!.status = 'BANNED';
      await context('alpha', token).expect(401);
      await submit('alpha', token).expect(401);
      expect(h.reviews()).toHaveLength(0);
    });

    it.each([
      ['refunded', { status: 'REFUNDED', payment_status: 'refunded' }],
      ['flagged test', { is_test: true }],
    ])('a token used after the order was %s -> 409', async (_l, over) => {
      const token = await h.linkToken();
      Object.assign(h.db.order.find((o) => o.id === IDS.annaOrder)!, over);
      const ctx = await context('alpha', token).expect(409);
      expect(ctx.body.code).toBe('REVIEW_ORDER_NOT_ELIGIBLE');
      const res = await submit('alpha', token).expect(409);
      expect(res.body.code).toBe('REVIEW_ORDER_NOT_ELIGIBLE');
      expect(h.reviews()).toHaveLength(0);
    });

    it('a session token in the body is not a review link -> 401', async () => {
      const session = await tokens.anna();
      await context('alpha', session).expect(401);
      await submit('alpha', session).expect(401);
    });

    it('the token is accepted in the body only: over-long, missing or non-string -> 400', async () => {
      await context('alpha', 'x'.repeat(1025)).expect(400);
      await context('alpha', undefined).expect(400);
      await context('alpha', 123).expect(400);
      await submit('alpha', 'x'.repeat(1025)).expect(400);
      // Never read from the query string or a header.
      const token = await h.linkToken();
      await request(http())
        .post(`/storefront/alpha/reviews/link/context?token=${token}`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(400);
      // The link cannot name another product.
      await submit('alpha', token, { product_id: IDS.ring }).expect(400);
      expect(h.reviews()).toHaveLength(0);
    });

    it('honeypot answers 200 and writes nothing', async () => {
      const res = await submit('alpha', await h.linkToken(), {
        website: 'spam',
      }).expect(200);
      expect(res.body).toEqual({ id: null, status: 'PENDING' });
      expect(h.reviews()).toHaveLength(0);
    });
  });

  // -- Owner routes ----------------------------------------------------------

  describe('owner routes', () => {
    it.each(['anna', 'provider', 'admin'] as const)(
      'a %s token -> 403 on every owner route, nothing written',
      async (who) => {
        const { a } = seedReviews();
        const before = { ...a };
        const bearer = await tokens[who]();
        for (const route of ownerRoutes(a.id)) {
          await call(route, bearer).expect(403);
        }
        expect(h.reviews()).toHaveLength(2);
        expect(h.reviews()[0]).toEqual(before);
      },
    );

    it('owner A on a review / order of store B -> 404 on status, reply, delete and links; nothing written', async () => {
      const { b } = seedReviews();
      const before = { ...b };
      const bearer = await tokens.ownerA();
      const sign = jest.spyOn(h.tokens, 'sign');
      const [, , status, reply, removeReply, remove, links] = ownerRoutes(
        b.id,
        IDS.ceciliaOrder,
      );
      for (const route of [status, reply, removeReply, remove]) {
        const res = await call(route, bearer).expect(404);
        expect(res.body.code).toBe('REVIEW_NOT_FOUND');
      }
      const res = await call(links, bearer).expect(404);
      expect(res.body.code).toBe('ORDER_NOT_FOUND');
      expect(sign).not.toHaveBeenCalled();
      expect(h.reviews().find((r) => r.id === b.id)).toEqual(before);
      // The list and the badge of owner A never count store B.
      const list = await call(ownerRoutes()[0], bearer).expect(200);
      expect(list.body.items.map((i: { id: string }) => i.id)).not.toContain(
        b.id,
      );
      expect(list.body.total).toBe(1);
      const count = await call(ownerRoutes()[1], bearer).expect(200);
      expect(count.body).toEqual({ count: 1 });
    });

    it('the owner moderates their own store', async () => {
      const { a } = seedReviews();
      const bearer = await tokens.ownerA();
      const [, , status, reply, removeReply, remove, links] = ownerRoutes(a.id);
      const approved = await call(fresh(status, a.id), bearer).expect(200);
      expect(approved.body).toMatchObject({ id: a.id, status: 'APPROVED' });
      const replied = await call(fresh(reply, a.id), bearer).expect(200);
      expect(replied.body.reply.body).toBe('Thank you!');
      await call(removeReply, bearer).expect(200);
      const made = await call(links, bearer).expect(201);
      expect(made.body.links).toHaveLength(3);
      await call(remove, bearer).expect(200, { deleted: true });
      expect(h.reviews().map((r) => r.id)).not.toContain(a.id);
    });

    it('approve / reply without the version the owner read, or with a stale one -> 409 REVIEW_CHANGED, nothing written', async () => {
      const { a } = seedReviews();
      const bearer = await tokens.ownerA();
      const [, , status, reply] = ownerRoutes(a.id);
      const before = { ...a };
      // No version at all (an old client): refused, never applied blindly.
      for (const route of [status, reply]) {
        const res = await call(route, bearer).expect(409);
        expect(res.body.code).toBe('REVIEW_CHANGED');
      }
      // The owner read the row, then the customer edited it.
      const staleStatus = fresh(status, a.id);
      const staleReply = fresh(reply, a.id);
      await h.service.submitMine(
        USERS.anna,
        IDS.storeA,
        submission({ rating: 1, body: 'Edited after the owner opened it.' }),
      );
      const edited = { ...h.reviews().find((r) => r.id === a.id) };
      for (const route of [staleStatus, staleReply]) {
        const res = await call(route, bearer).expect(409);
        expect(res.body.code).toBe('REVIEW_CHANGED');
      }
      expect(before.status).toBe('PENDING');
      expect(h.reviews().find((r) => r.id === a.id)).toEqual(edited);
      expect(edited).toMatchObject({ status: 'PENDING', reply_body: null });
      // Junk instead of a date is the same coded answer (no validator text).
      const junk = await call(
        { ...status, body: { status: 'APPROVED', expected_updated_at: 'x' } },
        bearer,
      ).expect(409);
      expect(junk.body.code).toBe('REVIEW_CHANGED');
    });

    it('no route lets the owner create a review or edit rating / text / name', async () => {
      const { a } = seedReviews();
      const before = { ...a };
      const bearer = await tokens.ownerA();
      const tries: Route[] = [
        {
          method: 'post',
          path: '/stores/my/reviews',
          body: submissionFields(),
        },
        { method: 'put', path: '/stores/my/reviews', body: submissionFields() },
        {
          method: 'put',
          path: `/stores/my/reviews/${a.id}`,
          body: { rating: 5 },
        },
        {
          method: 'patch',
          path: `/stores/my/reviews/${a.id}`,
          body: { rating: 5 },
        },
      ];
      for (const route of tries) await call(route, bearer).expect(404);
      // Extra fields on the moderation bodies are refused, not applied.
      await call(
        {
          method: 'patch',
          path: `/stores/my/reviews/${a.id}/status`,
          body: { status: 'APPROVED', rating: 5 },
        },
        bearer,
      ).expect(400);
      await call(
        {
          method: 'put',
          path: `/stores/my/reviews/${a.id}/reply`,
          body: { body: 'Hi', display_name: 'Owner' },
        },
        bearer,
      ).expect(400);
      await call(
        {
          method: 'patch',
          path: `/stores/my/reviews/${a.id}/status`,
          body: { status: 'PENDING' },
        },
        bearer,
      ).expect(400);
      // The owner is not a customer: the write routes of the storefront
      // refuse the token, and a review link of the store's own making is the
      // only (documented) way in.
      await call(customerRoutes('alpha')[2], bearer).expect(403);
      expect(h.reviews().find((r) => r.id === a.id)).toEqual(before);
    });

    it('ADMIN has no review routes in v1', async () => {
      const bearer = await tokens.admin();
      for (const route of ownerRoutes()) await call(route, bearer).expect(403);
    });
  });

  // -- Feature switch --------------------------------------------------------

  describe('app off', () => {
    beforeEach(() => {
      h.apps.on.clear();
    });

    it('every storefront route -> 403 STORE_APP_NOT_ENABLED, nothing read or written', async () => {
      const bearer = await tokens.anna();
      const token = await h.linkToken();
      const routes: [Route, string | undefined][] = [
        [
          {
            method: 'get',
            path: '/storefront/alpha/products/namnhalsband/reviews',
          },
          undefined,
        ],
        ...customerRoutes('alpha').map(
          (r) => [r, bearer] as [Route, string | undefined],
        ),
        [
          {
            method: 'post',
            path: '/storefront/alpha/reviews/link/context',
            body: { token },
          },
          undefined,
        ],
        [
          {
            method: 'put',
            path: '/storefront/alpha/reviews/link',
            body: { ...fields, token },
          },
          undefined,
        ],
      ];
      for (const [route, auth] of routes) {
        const res = await call(route, auth).expect(403);
        expect(res.body.code).toBe('STORE_APP_NOT_ENABLED');
      }
      expect(h.reviews()).toHaveLength(0);
      expect(h.prisma.productReview.findMany).not.toHaveBeenCalled();
      expect(h.prisma.productReview.groupBy).not.toHaveBeenCalled();
      expect(h.prisma.productReview.create).not.toHaveBeenCalled();
    });

    it('link creation -> 409 REVIEWS_NOT_ENABLED, while owner moderation still works', async () => {
      const { a } = seedReviews();
      const bearer = await tokens.ownerA();
      const [list, count, status, reply, removeReply, remove, links] =
        ownerRoutes(a.id);
      const res = await call(links, bearer).expect(409);
      expect(res.body.code).toBe('REVIEWS_NOT_ENABLED');
      await call(list, bearer).expect(200);
      await call(count, bearer).expect(200);
      await call(fresh(status, a.id), bearer).expect(200);
      await call(fresh(reply, a.id), bearer).expect(200);
      await call(removeReply, bearer).expect(200);
      await call(remove, bearer).expect(200);
      expect(h.revalidation.revalidateStoreById).not.toHaveBeenCalled();
    });

    it('an unknown or inactive store slug -> 403 as well', async () => {
      h.apps.on.add(IDS.storeA);
      h.db.store.find((s) => s.id === IDS.storeA)!.is_active = false;
      await call({
        method: 'get',
        path: '/storefront/alpha/products/namnhalsband/reviews',
      }).expect(403);
      await call({
        method: 'get',
        path: '/storefront/nope/products/namnhalsband/reviews',
      }).expect(403);
    });

    it('the app of ANOTHER store being on does not open this one', async () => {
      h.apps.on.add(IDS.storeB);
      await call({
        method: 'get',
        path: '/storefront/alpha/products/namnhalsband/reviews',
      }).expect(403);
      await call({
        method: 'get',
        path: '/storefront/beta/products/namnhalsband/reviews',
      }).expect(200);
    });
  });

  // -- Public read -----------------------------------------------------------

  describe('public read', () => {
    it('junk page values read page 1; DRAFT / unknown products are 404', async () => {
      h.reviews().push(
        reviewRow({ product_id: IDS.necklace, customer_id: IDS.anna }),
      );
      for (const page of ['0', '-1', 'abc', '9999', '1.5']) {
        const res = await call({
          method: 'get',
          path: `/storefront/alpha/products/namnhalsband/reviews?page=${page}`,
        }).expect(200);
        expect(res.body.page).toBe(1);
        expect(res.body.items).toHaveLength(1);
      }
      const res = await call({
        method: 'get',
        path: '/storefront/alpha/products/utkast/reviews',
      }).expect(404);
      expect(res.body.code).toBe('STOREFRONT_PRODUCT_NOT_FOUND');
    });

    it('`limit` is not a parameter (one cache entry per product and page)', async () => {
      for (let i = 0; i < 12; i++) {
        h.reviews().push(
          reviewRow({ product_id: IDS.necklace, customer_id: `c-${i}` }),
        );
      }
      const res = await call({
        method: 'get',
        path: '/storefront/alpha/products/namnhalsband/reviews?limit=100',
      }).expect(200);
      expect(res.body.items).toHaveLength(10);
    });
  });
});

describe('reviews endpoints: rate limits (real throttler)', () => {
  let h: ReviewsHarness;
  let app: INestApplication;
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  beforeEach(async () => {
    h = buildReviews();
    app = await bootApp(h, true);
  });
  afterEach(() => app.close());

  it('PUT reviews/link: 5 per minute per IP, then 429', async () => {
    const body = { ...fields, token: 'invalid' };
    for (let i = 0; i < 5; i++) {
      await request(http())
        .put('/storefront/alpha/reviews/link')
        .send(body)
        .expect(401);
    }
    await request(http())
      .put('/storefront/alpha/reviews/link')
      .send(body)
      .expect(429);
  });

  it('POST reviews/link/context: 20 per minute per IP, then 429', async () => {
    for (let i = 0; i < 20; i++) {
      await request(http())
        .post('/storefront/alpha/reviews/link/context')
        .send({ token: 'invalid' })
        .expect(401);
    }
    await request(http())
      .post('/storefront/alpha/reviews/link/context')
      .send({ token: 'invalid' })
      .expect(429);
  });

  it('PUT reviews/mine: 10 per hour, then 429', async () => {
    const bearer = await h.jwt.signAsync(
      {
        sub: IDS.annaUser,
        email: 'x@example.test',
        role: 'CUSTOMER',
        store_id: IDS.storeA,
      },
      { secret: TEST_JWT_SECRET, algorithm: 'HS256', expiresIn: 600 },
    );
    const put = () =>
      request(http())
        .put('/storefront/alpha/reviews/mine')
        .set('Authorization', `Bearer ${bearer}`)
        .send(submissionFields({ website: 'honeypot' }));
    for (let i = 0; i < 10; i++) await put().expect(200);
    await put().expect(429);
  });

  it('the public read is not throttled (it comes from the Next server IP)', async () => {
    for (let i = 0; i < 320; i++) {
      await request(http())
        .get('/storefront/alpha/products/namnhalsband/reviews')
        .expect(200);
    }
  });
});
