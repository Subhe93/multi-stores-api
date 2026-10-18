import { Prisma } from '@prisma/client';
import { StoresService } from './stores.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { OrdersService } from '../orders/orders.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsService } from '../markets/markets.service';
import { MarketsContextService } from '../markets/markets-context.service';
import type { RedirectsService } from '../redirects/redirects.service';

// PUT /stores/my/store with `checkout_settings` (M5 W2-A): the body is
// validated + normalized before it reaches Prisma, an all-default object is
// written as a typed NULL, and a store update that does not mention the key
// leaves the column alone (no accidental wipe — same rule as custom_domain).

function build() {
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    store: {
      findUnique: jest.fn(() => Promise.resolve({ id: 's1', store_type: 'INDEPENDENT' })),
      findFirst: jest.fn(() => Promise.resolve(null)),
      update: jest.fn((args: { data: unknown }) =>
        Promise.resolve({ id: 's1', slug: 'namez', ...(args.data as object) }),
      ),
    },
  };
  const service = new StoresService(
    prisma as unknown as PrismaService,
    { revalidateStoreBySlug: jest.fn(() => Promise.resolve()) } as unknown as RevalidationService,
    {} as OrdersService,
    { isEnabled: jest.fn(() => Promise.resolve(false)) } as unknown as StoreAppsService,
    {} as MarketsService,
    { invalidate: jest.fn() } as unknown as MarketsContextService,
    { versionFor: jest.fn(() => Promise.resolve(null)) } as unknown as RedirectsService,
  );
  return { service, prisma };
}

describe('StoresService.update checkout_settings', () => {
  it('stores the normalized object (defaults filled in)', async () => {
    const { service, prisma } = build();
    await service.update('u1', {
      checkout_settings: { after_add_to_cart: 'checkout', coupon_param: ['coupon1'] },
    });
    expect(prisma.store.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          checkout_settings: {
            after_add_to_cart: 'checkout',
            phone_required: false,
            pay_button_label: null,
            coupon_param: ['coupon1'],
            coupon_autoapply: false,
          },
        },
      }),
    );
  });

  it('null and an all-default object are written as a typed NULL', async () => {
    const { service, prisma } = build();
    await service.update('u1', { checkout_settings: null });
    await service.update('u1', { checkout_settings: { phone_required: false } });
    for (const call of prisma.store.update.mock.calls as unknown as [{ data: { checkout_settings: unknown } }][]) {
      expect(call[0].data.checkout_settings).toBe(Prisma.JsonNull);
    }
  });

  it('an update without the key does not touch the column', async () => {
    const { service, prisma } = build();
    await service.update('u1', { name: 'Namez' });
    const data = (prisma.store.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect('checkout_settings' in data).toBe(false);
  });

  it('an invalid body is a 400 and nothing is written', async () => {
    const { service, prisma } = build();
    await expect(
      service.update('u1', { checkout_settings: { after_add_to_cart: 'home' } }),
    ).rejects.toMatchObject({ response: { code: 'STORE_CHECKOUT_SETTINGS_INVALID' } });
    expect(prisma.store.update).not.toHaveBeenCalled();
  });
});
