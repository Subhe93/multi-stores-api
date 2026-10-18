import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateShippingProfileDto } from './dto/shipping.dto';
import { ShippingMethodType } from '@prisma/client';
import { ShippingService } from './shipping.service';
import { PrismaService } from '../../prisma/prisma.service';

// Quotes with ShippingZone.hide_others_when_free (WooCommerce "Hide shipping
// methods", hide_all mode) and the profile rename route.

const method = (over: Record<string, unknown>) => ({
  id: 'm',
  name: 'Method',
  translations: null,
  type: ShippingMethodType.DELIVERY,
  base_cost: 0,
  per_item_cost: 0,
  free_threshold: null,
  estimated_days_min: 1,
  estimated_days_max: 3,
  is_active: true,
  ...over,
});

// The namez.se setup: paid postal delivery free from 499, paid express,
// and a 0 kr pickup.
const namezMethods = () => [
  method({
    id: 'postal',
    name: 'Postal',
    base_cost: 59,
    free_threshold: 499,
  }),
  method({ id: 'express', name: 'Express', base_cost: 129 }),
  method({
    id: 'pickup',
    name: 'Pickup',
    type: ShippingMethodType.PICKUP,
    base_cost: 0,
  }),
];

const zone = (over: Record<string, unknown>) => ({
  id: 'z',
  countries: ['SE'],
  base_cost: 0,
  per_item_cost: 0,
  free_threshold: null,
  estimated_days_min: 1,
  estimated_days_max: 2,
  hide_others_when_free: false,
  methods: namezMethods(),
  ...over,
});

function build(profiles: { id: string; zones: unknown[] }[]) {
  const prisma = {
    product: {
      findMany: jest.fn(() =>
        Promise.resolve(
          profiles.map((p, i) => ({
            id: `p${i + 1}`,
            shipping_profile_id: p.id,
            provider_id: null,
            creator_id: 'c1',
          })),
        ),
      ),
    },
    customProduct: { findMany: jest.fn(() => Promise.resolve([])) },
    shippingProfile: {
      findMany: jest.fn(() => Promise.resolve(profiles)),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  };
  return {
    service: new ShippingService(prisma as unknown as PrismaService),
    prisma,
  };
}

const quote = (service: ShippingService, subtotal: number, n = 1) =>
  service.quoteForItems({
    product_ids: Array.from({ length: n }, (_, i) => `p${i + 1}`),
    country_code: 'SE',
    item_count: 1,
    subtotal,
  });

const ids = (q: { methods: { id: string }[] }) => q.methods.map((m) => m.id);

describe('ShippingService quotes: hide_others_when_free', () => {
  it('flag off: every active method, the threshold only zeroes its own method', async () => {
    const { service } = build([{ id: 'sp1', zones: [zone({})] }]);
    const below = await quote(service, 100);
    expect(ids(below)).toEqual(['postal', 'express', 'pickup']);
    const above = await quote(service, 600);
    expect(above.methods).toEqual([
      expect.objectContaining({ id: 'postal', cost: 0, free_shipping: true }),
      expect.objectContaining({ id: 'express', cost: 129 }),
      expect.objectContaining({ id: 'pickup', cost: 0, free_shipping: true }),
    ]);
  });

  it('flag on, below the threshold: every active method', async () => {
    const { service } = build([
      { id: 'sp1', zones: [zone({ hide_others_when_free: true })] },
    ]);
    const q = await quote(service, 498.99);
    expect(ids(q)).toEqual(['postal', 'express', 'pickup']);
    expect(q.methods[0].cost).toBe(59);
  });

  it('flag on, at/above the threshold: only the threshold-free method (0 kr pickup hidden too)', async () => {
    const { service } = build([
      { id: 'sp1', zones: [zone({ hide_others_when_free: true })] },
    ]);
    for (const subtotal of [499, 1000]) {
      const q = await quote(service, subtotal);
      expect(q.available).toBe(true);
      expect(q.methods).toEqual([
        expect.objectContaining({ id: 'postal', cost: 0, free_shipping: true }),
      ]);
    }
  });

  it('flag on: inactive threshold methods never count, several free ones are all kept', async () => {
    const { service } = build([
      {
        id: 'sp1',
        zones: [
          zone({
            hide_others_when_free: true,
            methods: [
              method({
                id: 'off',
                base_cost: 10,
                free_threshold: 1,
                is_active: false,
              }),
              method({ id: 'a', base_cost: 49, free_threshold: 300 }),
              method({ id: 'b', base_cost: 99 }),
              method({ id: 'c', base_cost: 79, free_threshold: 200 }),
            ],
          }),
        ],
      },
    ]);
    expect(ids(await quote(service, 100))).toEqual(['a', 'b', 'c']);
    expect(ids(await quote(service, 250))).toEqual(['c']);
    expect(ids(await quote(service, 300))).toEqual(['a', 'c']);
  });

  it('zone without methods keeps the legacy fallback with the flag on', async () => {
    const { service } = build([
      {
        id: 'sp1',
        zones: [
          zone({
            hide_others_when_free: true,
            base_cost: 39,
            free_threshold: 200,
            methods: [],
          }),
        ],
      },
    ]);
    const q = await quote(service, 250);
    expect(q.methods).toEqual([
      expect.objectContaining({ id: 'zone:z', cost: 0, free_shipping: true }),
    ]);
  });

  it('multiple profiles: merge runs on the filtered lists', async () => {
    // Profile 1 hides others once free; profile 2 (flag off) offers all.
    const { service } = build([
      { id: 'sp1', zones: [zone({ hide_others_when_free: true })] },
      {
        id: 'sp2',
        zones: [
          zone({
            id: 'z2',
            methods: [
              method({ id: 'postal2', name: 'postal ', base_cost: 69 }),
              method({ id: 'pickup2', name: 'Pickup', base_cost: 0 }),
            ],
          }),
        ],
      },
    ]);
    // Below the threshold both profiles share Postal and Pickup.
    const below = await quote(service, 100, 2);
    expect(below.methods).toEqual([
      expect.objectContaining({ id: 'postal', cost: 69 }),
      expect.objectContaining({ id: 'pickup', cost: 0 }),
    ]);
    // Above it profile 1 offers Postal only; the common method is Postal,
    // priced at the highest cost across profiles.
    const above = await quote(service, 600, 2);
    expect(above.methods).toEqual([
      expect.objectContaining({ id: 'postal', cost: 69, free_shipping: false }),
    ]);
  });
});

describe('ShippingService.updateProfile (rename)', () => {
  it('renames an owned profile (trimmed) and returns it', async () => {
    const { service, prisma } = build([]);
    prisma.shippingProfile.findFirst.mockResolvedValue({ id: 'sp1' });
    prisma.shippingProfile.update.mockResolvedValue({
      id: 'sp1',
      name: 'Sweden',
      zones: [],
    });
    await expect(
      service.updateProfile('sp1', { name: '  Sweden ' }, 'c1', 'creator'),
    ).resolves.toEqual({ id: 'sp1', name: 'Sweden', zones: [] });
    expect(prisma.shippingProfile.findFirst).toHaveBeenCalledWith({
      where: { id: 'sp1', creator_id: 'c1' },
    });
    expect(prisma.shippingProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sp1' },
        data: { name: 'Sweden' },
      }),
    );
  });

  it("404 for another owner's profile, nothing updated", async () => {
    const { service, prisma } = build([]);
    prisma.shippingProfile.findFirst.mockResolvedValue(null);
    await expect(
      service.updateProfile('sp9', { name: 'X' }, 'pr1', 'provider'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.shippingProfile.findFirst).toHaveBeenCalledWith({
      where: { id: 'sp9', provider_id: 'pr1' },
    });
    expect(prisma.shippingProfile.update).not.toHaveBeenCalled();
  });
});

describe('UpdateShippingProfileDto', () => {
  const errorsFor = (body: unknown) =>
    validateSync(plainToInstance(UpdateShippingProfileDto, body));

  it('accepts a trimmed 1–120 character name', () => {
    expect(errorsFor({ name: '  Sweden  ' })).toHaveLength(0);
    expect(errorsFor({ name: 'x'.repeat(120) })).toHaveLength(0);
  });

  it('rejects a missing, blank or too long name', () => {
    expect(errorsFor({})).not.toHaveLength(0);
    expect(errorsFor({ name: '   ' })).not.toHaveLength(0);
    expect(errorsFor({ name: 'x'.repeat(121) })).not.toHaveLength(0);
  });
});
