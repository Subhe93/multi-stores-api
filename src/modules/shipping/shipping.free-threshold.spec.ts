import { ShippingMethodType } from '@prisma/client';
import { ShippingService } from './shipping.service';
import { PrismaService } from '../../prisma/prisma.service';

// M4.1 §4.7: the free-shipping threshold a variation card compares its
// price with — same profile / zone resolution as checkout, lowest
// threshold of the zone's active DELIVERY methods, legacy zone column when
// the zone has no methods.

const method = (over: Record<string, unknown>) => ({
  id: 'm',
  is_active: true,
  type: ShippingMethodType.DELIVERY,
  free_threshold: null,
  ...over,
});

function build(opts: {
  product?: Record<string, unknown> | null;
  zones?: unknown[];
}) {
  const prisma = {
    product: {
      findMany: jest.fn(() =>
        Promise.resolve(
          opts.product === null
            ? []
            : [
                {
                  id: 'p1',
                  shipping_profile_id: 'sp1',
                  provider_id: null,
                  creator_id: 'c1',
                  ...opts.product,
                },
              ],
        ),
      ),
    },
    customProduct: { findMany: jest.fn(() => Promise.resolve([])) },
    shippingProfile: {
      findFirst: jest.fn(() => Promise.resolve({ id: 'sp-default' })),
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'sp1', zones: opts.zones ?? [] }),
      ),
    },
  };
  return {
    service: new ShippingService(prisma as unknown as PrismaService),
    prisma,
  };
}

describe('ShippingService.freeThresholdFor (M4.1)', () => {
  it('lowest threshold of the active DELIVERY methods of the matching zone', async () => {
    const { service } = build({
      zones: [
        { countries: ['NO'], methods: [method({ free_threshold: 100 })] },
        {
          countries: [' se '],
          free_threshold: 999,
          methods: [
            method({ free_threshold: 699 }),
            method({ free_threshold: 499 }),
            method({ free_threshold: 199, is_active: false }),
            method({ free_threshold: 99, type: ShippingMethodType.PICKUP }),
            method({ free_threshold: null }),
          ],
        },
      ],
    });
    await expect(service.freeThresholdFor('p1', 'se')).resolves.toBe(499);
  });

  it('zone without methods: its legacy column; no threshold → null', async () => {
    const legacy = build({
      zones: [{ countries: ['SE'], free_threshold: 599, methods: [] }],
    });
    await expect(legacy.service.freeThresholdFor('p1', 'SE')).resolves.toBe(
      599,
    );
    const none = build({
      zones: [{ countries: ['SE'], methods: [method({})] }],
    });
    await expect(none.service.freeThresholdFor('p1', 'SE')).resolves.toBeNull();
  });

  it('null without a zone for the country, without a profile or a country', async () => {
    const { service } = build({ zones: [{ countries: ['NO'], methods: [] }] });
    await expect(service.freeThresholdFor('p1', 'SE')).resolves.toBeNull();
    await expect(service.freeThresholdFor('p1', null)).resolves.toBeNull();
    const noProduct = build({ product: null });
    await expect(
      noProduct.service.freeThresholdFor('p1', 'SE'),
    ).resolves.toBeNull();
  });

  it('a product without its own profile uses the creator default (as checkout)', async () => {
    const { service, prisma } = build({
      product: { shipping_profile_id: null },
      zones: [
        { countries: ['SE'], methods: [method({ free_threshold: 499 })] },
      ],
    });
    await expect(service.freeThresholdFor('p1', 'SE')).resolves.toBe(499);
    expect(prisma.shippingProfile.findFirst).toHaveBeenCalledWith({
      where: { creator_id: 'c1', is_default: true },
      select: { id: true },
    });
    expect(prisma.shippingProfile.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sp-default' } }),
    );
  });
});
