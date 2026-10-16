import { NotFoundException } from '@nestjs/common';
import { REQUIRE_APP_KEY } from '../../common/decorators';
import { PersonalizationStorefrontController } from './personalization-storefront.controller';
import { PersonalizationService } from './personalization.service';
import { StoreAppsService } from '../store-apps/store-apps.service';

// M4.1 D14: the public validate route is app-gated (RequireApp via the store
// slug), throttled, and answers the service's ValidateResult.

describe('PersonalizationStorefrontController (M4.1)', () => {
  const result = {
    ok: true,
    errors: [],
    custom_fields: {},
    price_delta: 0,
    unit_price: 499,
    currency: 'SEK',
    display: [],
  };

  function build(storeId: string | null) {
    const storeApps = {
      storeIdBySlug: jest.fn(() => Promise.resolve(storeId)),
    };
    const service = {
      validateForStorefront: jest.fn(() => Promise.resolve(result)),
    };
    const controller = new PersonalizationStorefrontController(
      storeApps as unknown as StoreAppsService,
      service as unknown as PersonalizationService,
    );
    return { controller, service };
  }

  it('resolves the store by slug and returns the ValidateResult', async () => {
    const { controller, service } = build('s1');
    const body = { product_id: 'p', custom_fields: {}, quantity: 1 };
    await expect(controller.validate('namez', body)).resolves.toBe(result);
    expect(service.validateForStorefront).toHaveBeenCalledWith('s1', body);
  });

  it('unknown store: 404', async () => {
    const { controller } = build(null);
    await expect(
      controller.validate('nope', { product_id: 'p' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is gated by the personalization app and throttled (60 / minute)', () => {
    expect(
      Reflect.getMetadata(REQUIRE_APP_KEY, PersonalizationStorefrontController),
    ).toBe('personalization');
    const handler = Object.getOwnPropertyDescriptor(
      PersonalizationStorefrontController.prototype,
      'validate',
    )!.value as object;
    const keys = Reflect.getMetadataKeys(handler) as string[];
    const limitKey = keys.find((k) => String(k).includes('LIMIT'));
    expect(limitKey).toBeDefined();
    expect(Reflect.getMetadata(limitKey!, handler)).toBe(60);
    expect(Reflect.getMetadata('path', handler)).toBe(
      ':slug/personalization/validate',
    );
  });
});

describe('PersonalizationStorefrontController store hand-off (M4.1 fixes)', () => {
  it('uses the store the RequireAppGuard resolved (no second lookup)', async () => {
    const storeApps = { storeIdBySlug: jest.fn() };
    const service = {
      validateForStorefront: jest.fn(() => Promise.resolve({ ok: true })),
    };
    const controller = new PersonalizationStorefrontController(
      storeApps as unknown as StoreAppsService,
      service as unknown as PersonalizationService,
    );
    const body = { product_id: 'p' };
    await controller.validate('namez', body, { appStoreId: 's7' });
    expect(service.validateForStorefront).toHaveBeenCalledWith('s7', body);
    expect(storeApps.storeIdBySlug).not.toHaveBeenCalled();
  });
});
