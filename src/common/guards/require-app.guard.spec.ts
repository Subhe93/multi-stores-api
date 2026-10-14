import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequireAppGuard } from './require-app.guard';
import { REQUIRE_APP_KEY } from '../decorators';
import { StoreAppsService } from '../../modules/store-apps/store-apps.service';

// The guard is exercised with a stub Reflector (the @RequireApp metadata) and
// a stub StoreAppsService, checking which store it resolves and when it
// refuses with STORE_APP_NOT_ENABLED.

function makeContext(request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => 'handler',
    getClass: () => 'class',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function makeReflector(key: string | undefined) {
  return {
    getAllAndOverride: jest.fn((metadataKey: string) =>
      metadataKey === REQUIRE_APP_KEY ? key : undefined,
    ),
  } as unknown as Reflector;
}

function makeStoreApps(enabled: Record<string, string[]>) {
  return {
    isEnabled: jest.fn((storeId: string, key: string) =>
      Promise.resolve((enabled[storeId] ?? []).includes(key)),
    ),
    storeIdBySlug: jest.fn((slug: string) =>
      Promise.resolve(slug === 'my-shop' ? 's1' : null),
    ),
    storeIdByUser: jest.fn((userId: string) =>
      Promise.resolve(userId === 'u1' ? 's1' : null),
    ),
  };
}

async function expectNotEnabled(p: Promise<boolean>) {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ForbiddenException);
  expect((err as ForbiddenException).getResponse()).toMatchObject({
    code: 'STORE_APP_NOT_ENABLED',
  });
}

describe('RequireAppGuard', () => {
  it('passes routes without @RequireApp untouched', async () => {
    const storeApps = makeStoreApps({});
    const guard = new RequireAppGuard(
      makeReflector(undefined),
      storeApps as unknown as StoreAppsService,
    );
    await expect(guard.canActivate(makeContext({ params: {} }))).resolves.toBe(
      true,
    );
    expect(storeApps.isEnabled).not.toHaveBeenCalled();
  });

  it('resolves the store from params.storeId first', async () => {
    const storeApps = makeStoreApps({ s9: ['b2b'] });
    const guard = new RequireAppGuard(
      makeReflector('b2b'),
      storeApps as unknown as StoreAppsService,
    );
    await expect(
      guard.canActivate(
        makeContext({
          params: { storeId: 's9', slug: 'my-shop' },
          user: { id: 'u1' },
        }),
      ),
    ).resolves.toBe(true);
    expect(storeApps.isEnabled).toHaveBeenCalledWith('s9', 'b2b');
    expect(storeApps.storeIdBySlug).not.toHaveBeenCalled();
  });

  it('falls back to params.slug, then to the creator user', async () => {
    const storeApps = makeStoreApps({ s1: ['markets'] });
    const guard = new RequireAppGuard(
      makeReflector('markets'),
      storeApps as unknown as StoreAppsService,
    );
    await expect(
      guard.canActivate(makeContext({ params: { slug: 'my-shop' } })),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(makeContext({ params: {}, user: { id: 'u1' } })),
    ).resolves.toBe(true);
    expect(storeApps.isEnabled).toHaveBeenCalledTimes(2);
    expect(storeApps.isEnabled).toHaveBeenLastCalledWith('s1', 'markets');
  });

  it('refuses when the app is not in effect for the store', async () => {
    const storeApps = makeStoreApps({ s1: ['b2b'] });
    const guard = new RequireAppGuard(
      makeReflector('markets'),
      storeApps as unknown as StoreAppsService,
    );
    await expectNotEnabled(
      guard.canActivate(makeContext({ params: { slug: 'my-shop' } })),
    );
  });

  it('refuses when no store can be resolved', async () => {
    const storeApps = makeStoreApps({ s1: ['b2b'] });
    const guard = new RequireAppGuard(
      makeReflector('b2b'),
      storeApps as unknown as StoreAppsService,
    );
    await expectNotEnabled(
      guard.canActivate(makeContext({ params: { slug: 'unknown' } })),
    );
    await expectNotEnabled(
      guard.canActivate(makeContext({ params: {}, user: { id: 'nobody' } })),
    );
    await expectNotEnabled(guard.canActivate(makeContext({})));
    expect(storeApps.isEnabled).not.toHaveBeenCalled();
  });
});
