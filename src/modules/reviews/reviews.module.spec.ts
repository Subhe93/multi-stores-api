import { Global, Module, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { REQUIRE_APP_KEY, ROLES_KEY } from '../../common/decorators';
import { RequireAppGuard } from '../../common/guards/require-app.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserThrottlerGuard } from '../../common/guards/user-throttler.guard';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { ReviewsCreatorController } from './reviews-creator.controller';
import { ReviewsStorefrontController } from './reviews-storefront.controller';
import { ReviewsModule } from './reviews.module';
import { ReviewsService } from './reviews.service';
import { fakeConfig } from './reviews-fake-db.mockspec';

// The globals ReviewsModule relies on (Prisma, Config, StoreApps,
// Revalidation are global modules in the real application).
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: StoreAppsService, useValue: {} },
    { provide: RevalidationService, useValue: {} },
    { provide: ConfigService, useValue: fakeConfig() },
  ],
  exports: [
    PrismaService,
    StoreAppsService,
    RevalidationService,
    ConfigService,
  ],
})
class GlobalsModule {}

type Handler = (...args: unknown[]) => unknown;

/** `METHOD path` -> handler of every route of a controller. */
function routesOf(controller: { prototype: object }): Map<string, Handler> {
  const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
  const out = new Map<string, Handler>();
  const proto = controller.prototype as Record<string, Handler>;
  for (const name of Object.getOwnPropertyNames(proto)) {
    const handler = proto[name];
    if (name === 'constructor' || typeof handler !== 'function') continue;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as
      | string
      | undefined;
    if (path === undefined) continue;
    const method =
      RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
    out.set(`${method} /${base}${path === '/' ? '' : `/${path}`}`, handler);
  }
  return out;
}

const guardsOf = (target: object): unknown[] =>
  (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ?? [];

// AuthGuard(type) is memoized: the same class for the same strategy name.
const isJwtGuard = (guard: unknown) => guard === AuthGuard('jwt');

describe('ReviewsModule', () => {
  it('resolves with nothing but the global modules (no cycle with OrdersModule)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        GlobalsModule,
        ThrottlerModule.forRoot([{ ttl: 60000, limit: 300 }]),
        ReviewsModule,
      ],
    }).compile();
    expect(moduleRef.get(ReviewsService)).toBeInstanceOf(ReviewsService);
    await moduleRef.close();
  });
});

describe('reviews route table', () => {
  const storefront = routesOf(ReviewsStorefrontController);
  const owner = routesOf(ReviewsCreatorController);

  it('storefront: exactly these routes', () => {
    expect([...storefront.keys()].sort()).toEqual(
      [
        'GET /storefront/:slug/products/:productSlug/reviews',
        'GET /storefront/:slug/reviews/mine/eligibility',
        'GET /storefront/:slug/reviews/mine/orders/:orderId',
        'PUT /storefront/:slug/reviews/mine',
        'DELETE /storefront/:slug/reviews/mine/:id',
        'POST /storefront/:slug/reviews/link/context',
        'PUT /storefront/:slug/reviews/link',
      ].sort(),
    );
  });

  it('owner: exactly these routes (none creates a review or edits its rating / text)', () => {
    expect([...owner.keys()].sort()).toEqual(
      [
        'GET /stores/my/reviews',
        'GET /stores/my/reviews/pending-count',
        'PATCH /stores/my/reviews/:id/status',
        'PUT /stores/my/reviews/:id/reply',
        'DELETE /stores/my/reviews/:id/reply',
        'DELETE /stores/my/reviews/:id',
        'POST /stores/my/reviews/links',
      ].sort(),
    );
  });

  it('every storefront route is behind the reviews app gate', () => {
    expect(
      Reflect.getMetadata(REQUIRE_APP_KEY, ReviewsStorefrontController),
    ).toBe('reviews');
    for (const [route, handler] of storefront) {
      expect([route, guardsOf(handler).includes(RequireAppGuard)]).toEqual([
        route,
        true,
      ]);
    }
  });

  it('every customer route needs a CUSTOMER session: JWT, then role, then the app gate', () => {
    const mine = [...storefront].filter(([route]) =>
      route.includes('/reviews/mine'),
    );
    expect(mine).toHaveLength(4);
    for (const [route, handler] of mine) {
      const guards = guardsOf(handler);
      expect([route, isJwtGuard(guards[0])]).toEqual([route, true]);
      expect(guards[1]).toBe(RolesGuard);
      expect(guards[2]).toBe(RequireAppGuard);
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([
        UserRole.CUSTOMER,
      ]);
    }
  });

  it('the public read and the link routes take no session', () => {
    const open = [...storefront].filter(
      ([route]) => !route.includes('/reviews/mine'),
    );
    expect(open).toHaveLength(3);
    for (const [, handler] of open) {
      expect(guardsOf(handler)).toEqual([RequireAppGuard]);
    }
  });

  it('owner controller: JWT + CREATOR role on the class, no app gate (moderation survives switching the app off)', () => {
    const guards = guardsOf(ReviewsCreatorController);
    expect(isJwtGuard(guards[0])).toBe(true);
    expect(guards[1]).toBe(RolesGuard);
    expect(Reflect.getMetadata(ROLES_KEY, ReviewsCreatorController)).toEqual([
      UserRole.CREATOR,
    ]);
    expect(
      Reflect.getMetadata(REQUIRE_APP_KEY, ReviewsCreatorController),
    ).toBeUndefined();
    for (const [, handler] of owner) {
      // No handler widens the roles or drops the guards.
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined();
      expect(Reflect.getMetadata(REQUIRE_APP_KEY, handler)).toBeUndefined();
    }
  });

  it('throttles: account write 10/hour per user, link context 20/min, link write 5/min, links 30/min; public read skipped', () => {
    const limit = (handler: Handler): unknown[] => [
      Reflect.getMetadata('THROTTLER:LIMITdefault', handler) as unknown,
      Reflect.getMetadata('THROTTLER:TTLdefault', handler) as unknown,
    ];
    const put = storefront.get('PUT /storefront/:slug/reviews/mine')!;
    expect(limit(put)).toEqual([10, 3600000]);
    expect(guardsOf(put)).toContain(UserThrottlerGuard);
    expect(
      limit(storefront.get('POST /storefront/:slug/reviews/link/context')!),
    ).toEqual([20, 60000]);
    expect(
      limit(storefront.get('PUT /storefront/:slug/reviews/link')!),
    ).toEqual([5, 60000]);
    expect(limit(owner.get('POST /stores/my/reviews/links')!)).toEqual([
      30, 60000,
    ]);
    expect(
      Reflect.getMetadata(
        'THROTTLER:SKIPdefault',
        storefront.get('GET /storefront/:slug/products/:productSlug/reviews')!,
      ),
    ).toBe(true);
  });
});
