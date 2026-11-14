import { ShippingService } from './shipping.service';
import { PrismaService } from '../../prisma/prisma.service';

// POST /shipping/countries: the checkout country list only offers the
// destinations every product of the cart can ship to, resolved like the
// estimate (first matching zone per profile, active methods or a legacy zone).

const zone = (countries: string[], methods: { is_active: boolean }[] = []) => ({
  countries,
  methods,
});

function build(opts: {
  products: Record<string, unknown>[];
  profiles: { id: string; zones: unknown[] }[];
}) {
  const prisma = {
    product: { findMany: jest.fn(() => Promise.resolve(opts.products)) },
    customProduct: { findMany: jest.fn(() => Promise.resolve([])) },
    shippingProfile: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve(opts.profiles)),
    },
  };
  return new ShippingService(prisma as unknown as PrismaService);
}

const product = (id: string, profile: string | null) => ({
  id,
  shipping_profile_id: profile,
  provider_id: null,
  creator_id: null,
});

describe('ShippingService.shippableCountries', () => {
  it('lists the countries of shipping zones, upper-cased and sorted', async () => {
    const service = build({
      products: [product('p1', 'sp1')],
      profiles: [
        {
          id: 'sp1',
          zones: [
            zone([' se ', 'no'], [{ is_active: true }]),
            zone(['FI']),
            zone(['Sweden']),
          ],
        },
      ],
    });
    await expect(service.shippableCountries(['p1'])).resolves.toEqual({
      restricted: true,
      countries: ['FI', 'NO', 'SE'],
    });
  });

  it('skips a country whose first zone has only inactive methods (estimate says unavailable)', async () => {
    const service = build({
      products: [product('p1', 'sp1')],
      profiles: [
        {
          id: 'sp1',
          zones: [
            zone(['DE'], [{ is_active: false }]),
            zone(['DE', 'SE'], [{ is_active: true }]),
          ],
        },
      ],
    });
    await expect(service.shippableCountries(['p1'])).resolves.toEqual({
      restricted: true,
      countries: ['SE'],
    });
  });

  it('intersects the countries of every profile of the cart', async () => {
    const service = build({
      products: [product('p1', 'sp1'), product('p2', 'sp2')],
      profiles: [
        { id: 'sp1', zones: [zone(['SE', 'NO', 'DE'])] },
        { id: 'sp2', zones: [zone(['SE', 'DE'], [{ is_active: true }])] },
      ],
    });
    await expect(service.shippableCountries(['p1', 'p2'])).resolves.toEqual({
      restricted: true,
      countries: ['DE', 'SE'],
    });
  });

  it('is unrestricted when no product has a shipping profile', async () => {
    const service = build({ products: [product('p1', null)], profiles: [] });
    await expect(service.shippableCountries(['p1'])).resolves.toEqual({
      restricted: false,
      countries: [],
    });
  });
});
