import { ShippingMethodType } from '@prisma/client';
import { ShippingService } from './shipping.service';
import { PrismaService } from '../../prisma/prisma.service';

// Products that require no shipping (services / digital products) get no
// shipping rate: they resolve to no profile, never inherit a creator or
// provider default profile, and a set made only of them is never restricted
// to shipping zones. Every key added to the answers is present only then.

type ProductRow = {
  id: string;
  shipping_profile_id: string | null;
  provider_id: string | null;
  creator_id: string | null;
  requires_shipping?: boolean | null;
};

const method = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  name: 'Standard',
  type: ShippingMethodType.DELIVERY,
  is_active: true,
  base_cost: 49,
  per_item_cost: 10,
  free_threshold: null,
  estimated_days_min: 2,
  estimated_days_max: 5,
  translations: null,
  ...over,
});

const zone = (countries: string[], methods: unknown[]) => ({
  countries,
  base_cost: 0,
  per_item_cost: 0,
  free_threshold: null,
  estimated_days_min: 1,
  estimated_days_max: 3,
  methods,
});

function build(opts: {
  products: ProductRow[];
  customProducts?: { id: string; product: ProductRow }[];
  /** Profiles by id; `defaults` are returned by the is_default lookup. */
  profiles?: Record<string, { zones: unknown[] }>;
  defaultProfileId?: string | null;
}) {
  const profiles = opts.profiles ?? {};
  const prisma = {
    product: {
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          opts.products.filter((p) => where.id.in.includes(p.id)),
        ),
      ),
    },
    customProduct: {
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          (opts.customProducts ?? []).filter((c) => where.id.in.includes(c.id)),
        ),
      ),
    },
    shippingProfile: {
      findFirst: jest.fn(() =>
        Promise.resolve(
          opts.defaultProfileId ? { id: opts.defaultProfileId } : null,
        ),
      ),
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in
            .filter((id) => profiles[id])
            .map((id) => ({ id, ...profiles[id] })),
        ),
      ),
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          profiles[where.id] ? { id: where.id, ...profiles[where.id] } : null,
        ),
      ),
    },
  };
  return {
    service: new ShippingService(prisma as unknown as PrismaService),
    prisma,
  };
}

const physical = (id: string, profile: string | null): ProductRow => ({
  id,
  shipping_profile_id: profile,
  provider_id: null,
  creator_id: 'c1',
});

const service = (id: string, over: Partial<ProductRow> = {}): ProductRow => ({
  id,
  shipping_profile_id: null,
  provider_id: null,
  creator_id: 'c1',
  requires_shipping: false,
  ...over,
});

const SE_PROFILE = { zones: [zone(['SE'], [method()])] };

const estimateDto = (ids: string[], country = 'SE', count = 1) => ({
  product_ids: ids,
  country_code: country,
  item_count: count,
  subtotal: 100,
});

describe('a service never inherits a default profile', () => {
  it('creator default: not looked up, no methods, key false', async () => {
    const { service: svc, prisma } = build({
      products: [service('s1')],
      profiles: { def: SE_PROFILE },
      defaultProfileId: 'def',
    });
    await expect(svc.quoteForItems(estimateDto(['s1']))).resolves.toEqual({
      available: true,
      methods: [],
      requires_shipping: false,
    });
    expect(prisma.shippingProfile.findFirst).not.toHaveBeenCalled();
    expect(prisma.shippingProfile.findMany).not.toHaveBeenCalled();
  });

  it('provider default: not looked up either', async () => {
    const { service: svc, prisma } = build({
      products: [service('s1', { provider_id: 'prov1', creator_id: null })],
      profiles: { def: SE_PROFILE },
      defaultProfileId: 'def',
    });
    const quote = await svc.quoteForItems(estimateDto(['s1']));
    expect(quote).toEqual({
      available: true,
      methods: [],
      requires_shipping: false,
    });
    expect(prisma.shippingProfile.findFirst).not.toHaveBeenCalled();
  });

  it('its own stored profile is ignored (kept on the row, never used)', async () => {
    const { service: svc } = build({
      products: [service('s1', { shipping_profile_id: 'sp1' })],
      profiles: { sp1: SE_PROFILE },
    });
    // A country outside the profile's zones is not "unavailable".
    await expect(svc.quoteForItems(estimateDto(['s1'], 'US'))).resolves.toEqual(
      { available: true, methods: [], requires_shipping: false },
    );
  });

  it('the same product with the flag on still inherits the creator default', async () => {
    const { service: svc, prisma } = build({
      products: [physical('p1', null)],
      profiles: { def: SE_PROFILE },
      defaultProfileId: 'def',
    });
    const quote = await svc.quoteForItems(estimateDto(['p1']));
    expect(prisma.shippingProfile.findFirst).toHaveBeenCalledTimes(1);
    expect(quote.methods.map((m) => m.id)).toEqual(['m1']);
    expect('requires_shipping' in quote).toBe(false);
  });
});

describe('lines the caller already filtered (order quote, later per-variant override)', () => {
  // The order quote decides per line with the product AND its variant, and
  // sends only the shippable lines. A product whose own flag is off can then
  // still be in the list (a physical variant): it must get its rates.
  it('lines_prefiltered: the product flag is not applied again', async () => {
    const { service: svc, prisma } = build({
      products: [service('s1', { shipping_profile_id: 'sp1' })],
      profiles: { sp1: SE_PROFILE },
    });
    const quote = await svc.quoteForItems({
      ...estimateDto(['s1']),
      lines_prefiltered: true,
    });
    expect(prisma.shippingProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['sp1'] } } }),
    );
    expect(quote.available).toBe(true);
    expect(quote.methods.map((m) => m.id)).toEqual(['m1']);
    expect('requires_shipping' in quote).toBe(false);
  });

  it('lines_prefiltered: an unreachable country is still unavailable', async () => {
    const { service: svc } = build({
      products: [service('s1', { shipping_profile_id: 'sp1' })],
      profiles: { sp1: SE_PROFILE },
    });
    const quote = await svc.quoteForItems({
      ...estimateDto(['s1'], 'US'),
      lines_prefiltered: true,
    });
    expect(quote.available).toBe(false);
  });

  it('without the marker (public estimate) the same product gets no rates', async () => {
    const { service: svc } = build({
      products: [service('s1', { shipping_profile_id: 'sp1' })],
      profiles: { sp1: SE_PROFILE },
    });
    await expect(svc.quoteForItems(estimateDto(['s1']))).resolves.toEqual({
      available: true,
      methods: [],
      requires_shipping: false,
    });
  });

  it('lines_prefiltered changes nothing for products that ship', async () => {
    const make = () =>
      build({
        products: [physical('p1', 'sp1')],
        profiles: { sp1: SE_PROFILE },
      }).service;
    const plain = await make().quoteForItems(estimateDto(['p1']));
    const marked = await make().quoteForItems({
      ...estimateDto(['p1']),
      lines_prefiltered: true,
    });
    expect(marked).toEqual(plain);
  });
});

describe('mixed set', () => {
  it('resolves only the profiles of the shippable products', async () => {
    const { service: svc, prisma } = build({
      products: [
        physical('p1', 'sp1'),
        service('s1', { shipping_profile_id: 'sp2' }),
      ],
      profiles: {
        sp1: SE_PROFILE,
        // Would make SE unavailable if it were consulted.
        sp2: { zones: [zone(['NO'], [method({ id: 'm2' })])] },
      },
    });
    const quote = await svc.quoteForItems(estimateDto(['p1', 's1'], 'SE', 2));
    expect(prisma.shippingProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['sp1'] } } }),
    );
    expect(quote.available).toBe(true);
    expect(quote.methods.map((m) => m.id)).toEqual(['m1']);
    expect('requires_shipping' in quote).toBe(false);
  });

  it('still reports "unavailable" for a country the shippable product cannot reach', async () => {
    const { service: svc } = build({
      products: [physical('p1', 'sp1'), service('s1')],
      profiles: { sp1: SE_PROFILE },
    });
    const quote = await svc.quoteForItems(estimateDto(['p1', 's1'], 'US'));
    expect(quote.available).toBe(false);
    expect('requires_shipping' in quote).toBe(false);
  });

  it('countries: restricted by the shippable products only', async () => {
    const { service: svc } = build({
      products: [
        physical('p1', 'sp1'),
        service('s1', { shipping_profile_id: 'sp2' }),
      ],
      profiles: {
        sp1: { zones: [zone(['SE', 'NO'], [method()])] },
        sp2: { zones: [zone(['DE'], [method()])] },
      },
    });
    await expect(svc.shippableCountries(['p1', 's1'])).resolves.toEqual({
      restricted: true,
      countries: ['NO', 'SE'],
    });
  });
});

describe('set where nothing requires shipping', () => {
  it('countries are unrestricted, with the key', async () => {
    const { service: svc, prisma } = build({
      products: [service('s1', { shipping_profile_id: 'sp1' }), service('s2')],
      profiles: { sp1: SE_PROFILE },
      defaultProfileId: 'sp1',
    });
    await expect(svc.shippableCountries(['s1', 's2'])).resolves.toEqual({
      restricted: false,
      countries: [],
      requires_shipping: false,
    });
    expect(prisma.shippingProfile.findMany).not.toHaveBeenCalled();
  });

  it('estimate: free, no methods, with the key', async () => {
    const { service: svc } = build({ products: [service('s1')] });
    await expect(svc.estimate(estimateDto(['s1']))).resolves.toEqual({
      available: true,
      methods: [],
      requires_shipping: false,
      cost: 0,
      estimated_days: null,
      free_shipping: true,
    });
  });

  it('a custom product inherits the flag of its base product', async () => {
    const { service: svc } = build({
      products: [],
      customProducts: [
        {
          id: 'cp1',
          product: service('base1', {
            provider_id: 'prov1',
            creator_id: null,
            shipping_profile_id: 'sp1',
          }),
        },
      ],
      profiles: { sp1: SE_PROFILE },
      defaultProfileId: 'sp1',
    });
    await expect(
      svc.quoteForItems(estimateDto(['cp1'], 'US')),
    ).resolves.toEqual({
      available: true,
      methods: [],
      requires_shipping: false,
    });
    await expect(svc.shippableCountries(['cp1'])).resolves.toEqual({
      restricted: false,
      countries: [],
      requires_shipping: false,
    });
  });

  it('free threshold of a service is null', async () => {
    const { service: svc } = build({
      products: [service('s1', { shipping_profile_id: 'sp1' })],
      profiles: {
        sp1: { zones: [zone(['SE'], [method({ free_threshold: 500 })])] },
      },
      defaultProfileId: 'sp1',
    });
    await expect(svc.freeThresholdFor('s1', 'SE')).resolves.toBeNull();
  });
});

describe('unknown products and products without the column (unchanged)', () => {
  it('no product found: the former answers, no key', async () => {
    const { service: svc } = build({ products: [] });
    await expect(svc.quoteForItems(estimateDto(['ghost']))).resolves.toEqual({
      available: true,
      methods: [],
    });
    await expect(svc.shippableCountries(['ghost'])).resolves.toEqual({
      restricted: false,
      countries: [],
    });
  });

  it('a physical product without any profile: the former answers, no key', async () => {
    const { service: svc } = build({ products: [physical('p1', null)] });
    await expect(svc.estimate(estimateDto(['p1']))).resolves.toEqual({
      available: true,
      methods: [],
      cost: 0,
      estimated_days: null,
      free_shipping: true,
    });
    await expect(svc.shippableCountries(['p1'])).resolves.toEqual({
      restricted: false,
      countries: [],
    });
  });

  it('null and true both require shipping', async () => {
    const { service: svc } = build({
      products: [
        { ...physical('p1', 'sp1'), requires_shipping: null },
        { ...physical('p2', 'sp1'), requires_shipping: true },
      ],
      profiles: { sp1: SE_PROFILE },
    });
    const quote = await svc.quoteForItems(estimateDto(['p1', 'p2'], 'SE', 2));
    expect(quote.methods).toHaveLength(1);
    // base 49 + 2 units x 10.
    expect(quote.methods[0].cost).toBe(69);
    expect('requires_shipping' in quote).toBe(false);
  });
});
