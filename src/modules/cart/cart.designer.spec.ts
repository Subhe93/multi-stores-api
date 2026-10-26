import { BadRequestException, Logger } from '@nestjs/common';
import { CartService } from './cart.service';
import { PrismaService } from '../../prisma/prisma.service';
import { buildPersonalizationCore } from '../personalization/__fixtures__/personalization-service.factory';
import { TaxService } from '../taxes/tax.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { B2bService } from '../b2b/b2b.service';
import type { DesignerCartService } from '../designer/designer-cart.service';

// M4.2 WP4: designer lines in the server cart (C29 step 2, C11): the design
// is validated + claimed, field values are dropped, the token is never
// stored, the same design merges, and app-off / unlinked products behave
// exactly as before.

const DESIGN = '99999999-9999-4999-8999-999999999999';

type Row = Record<string, unknown> & { id: string; quantity: number };

const FIELDS = [
  {
    id: 'f1',
    product_id: 'p1',
    name: 'namn',
    type: 'TEXT',
    is_required: true,
    options: null,
    validation_rules: null,
    linked_validation: null,
    sort_order: 0,
    preset_key: 'npp_fallback',
    translations: [{ locale: 'sv', label: 'Namn' }],
  },
];

function makePrisma(fields: unknown[]) {
  const rows: Row[] = [];
  let n = 0;
  const matches = (r: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) =>
      k === 'id'
        ? typeof v === 'string'
          ? r.id === v
          : r.id !== (v as { not: string }).not
        : (r[k] ?? null) === v,
    );
  return {
    rows,
    customer: { findUnique: jest.fn(() => Promise.resolve({ id: 'cust1' })) },
    cart: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'cart1', customer_id: 'cust1' }),
      ),
    },
    productCustomField: { findMany: jest.fn(() => Promise.resolve(fields)) },
    customProduct: { findMany: jest.fn(() => Promise.resolve([])) },
    cartItem: {
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(rows.find((r) => matches(r, where)) ?? null),
      ),
      findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(rows.filter((r) => matches(r, where))),
      ),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `r${++n}`, quantity: 1, ...data } as Row;
        rows.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          const row = rows.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return Promise.resolve(row);
        },
      ),
    },
  };
}

function designerStub(mode: 'design' | 'none' | 'required') {
  return {
    resolveCartLine: jest.fn((line: { design_id?: string }) => {
      if (mode === 'required') {
        return Promise.reject(
          new BadRequestException({ code: 'DESIGNER_DESIGN_REQUIRED' }),
        );
      }
      return Promise.resolve(
        mode === 'design' && line.design_id
          ? { design: { id: line.design_id } }
          : null,
      );
    }),
    ensureProof: jest.fn(),
  };
}

function build(fields: unknown[], designer?: unknown) {
  const prisma = makePrisma(fields);
  const service = new CartService(
    prisma as unknown as PrismaService,
    {} as TaxService,
    {
      resolve: jest.fn(() => Promise.resolve(null)),
    } as unknown as MarketsContextService,
    new MarketPricingService(prisma as unknown as PrismaService),
    {} as B2bService,
    buildPersonalizationCore(prisma).core,
    undefined,
    designer as DesignerCartService | undefined,
  );
  const internals = service as unknown as Record<string, jest.Mock>;
  jest.spyOn(service, 'getCart').mockResolvedValue({} as never);
  internals.assertAvailableInMarket = jest.fn(() => Promise.resolve());
  return { service, prisma };
}

const add = (service: CartService, body: Record<string, unknown>) =>
  service.addItem(
    'u1',
    { product_id: 'p1', quantity: 1, ...body } as never,
    'sv',
  );

describe('CartService designer lines (M4.2 WP4)', () => {
  it('stores design_id, drops field values and the token; the required field is not checked', async () => {
    const designer = designerStub('design');
    const { service, prisma } = build(FIELDS, designer);
    await add(service, {
      design_id: DESIGN,
      design_token: 'secret',
      custom_fields: { f1: 'Anna' },
    });
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]).toEqual({
      id: 'r1',
      quantity: 1,
      cart_id: 'cart1',
      product_id: 'p1',
      design_id: DESIGN,
    });
    expect(designer.resolveCartLine).toHaveBeenCalledWith(
      expect.objectContaining({ design_id: DESIGN, design_token: 'secret' }),
      'p1',
      'cust1',
    );
    expect(designer.ensureProof).toHaveBeenCalledWith(DESIGN);
  });

  it('the same design merges; another design is another line; a plain line never merges into it', async () => {
    const { service, prisma } = build([], designerStub('design'));
    await add(service, { design_id: DESIGN });
    await add(service, { design_id: DESIGN });
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].quantity).toBe(2);
    await add(service, { design_id: '99999999-9999-4999-8999-000000000000' });
    expect(prisma.rows).toHaveLength(2);
    // After the designer is switched off for the product: a plain add.
    const off = build([], designerStub('none'));
    off.prisma.rows.push({
      id: 'd1',
      cart_id: 'cart1',
      product_id: 'p1',
      quantity: 1,
      design_id: DESIGN,
    });
    await add(off.service, {});
    expect(off.prisma.rows).toHaveLength(2);
    expect(off.prisma.rows[1]).not.toHaveProperty('design_id');
  });

  it('a linked product without design is refused (rule 2)', async () => {
    const { service, prisma } = build(FIELDS, designerStub('required'));
    await expect(
      add(service, { custom_fields: { f1: 'Anna' } }),
    ).rejects.toMatchObject({
      response: { code: 'DESIGNER_DESIGN_REQUIRED' },
    });
    expect(prisma.rows).toHaveLength(0);
  });

  it('G0: not a designer line → same row, same query as without the service', async () => {
    const withSvc = build(FIELDS, designerStub('none'));
    const without = build(FIELDS);
    for (const b of [withSvc, without]) {
      await add(b.service, { custom_fields: { f1: 'Anna' } });
    }
    expect(withSvc.prisma.rows).toEqual(without.prisma.rows);
    expect(withSvc.prisma.cartItem.findMany.mock.calls).toEqual(
      without.prisma.cartItem.findMany.mock.calls,
    );
  });

  it('without the service a sent design_id / token is never stored', async () => {
    const { service, prisma } = build([]);
    await add(service, { design_id: DESIGN, design_token: 't' });
    expect(prisma.rows[0]).not.toHaveProperty('design_id');
    expect(prisma.rows[0]).not.toHaveProperty('design_token');
  });

  it('custom_fields updates are ignored on designer rows', async () => {
    const { service, prisma } = build(FIELDS, designerStub('design'));
    await add(service, { design_id: DESIGN });
    await service.updateItem('u1', 'r1', {
      custom_fields: { f1: 'X' },
    } as never);
    expect(prisma.rows[0]).not.toHaveProperty('custom_fields');
    expect(prisma.productCustomField.findMany).toHaveBeenCalledTimes(1);
  });
});

// M5.5: the cart read prices a designed line with its add-ons (base
// currency from cartDesigns, converted per unit in a market) and hides the
// line when the add-ons cannot be converted (checkout refuses it too).
describe('CartService designer add-ons (M5.5, cart read)', () => {
  const MARKET = {
    id: 'm-eu',
    key: 'eu',
    name: 'EU',
    countries: ['DE'],
    defaultLocale: 'de',
    locales: [],
    currency: 'EUR',
    storeCurrency: 'SEK',
    rate: 0.1,
    priceRule: { mode: 'convert', source: 'manual', rate: 0.1 },
    isDefault: false,
    noindex: false,
    status: 'LIVE',
    primaryHostname: null,
    hostnames: [],
  };
  const ADDONS = [
    {
      key: 'double',
      type: 'toggle' as const,
      label: 'Dubbelsidig',
      qty: 1,
      unit_price: 149,
      amount: 149,
    },
    {
      key: 'poster',
      type: 'quantity' as const,
      label: 'Poster',
      qty: 2,
      unit_price: 179,
      amount: 358,
    },
  ];

  function buildRead(addons: typeof ADDONS | undefined) {
    const prisma = {
      product: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            id: 'p1',
            creator_id: 'c1',
            base_price: 299,
            variant_option_config: null,
            translations: [{ locale: 'sv', title: 'Flagga' }],
            images: [],
            custom_fields: [],
          }),
        ),
      },
      productImage: { findFirst: jest.fn(() => Promise.resolve(null)) },
      productVariant: { findMany: jest.fn(() => Promise.resolve([])) },
      productMarketPrice: { findMany: jest.fn(() => Promise.resolve([])) },
      platformConfig: {
        findFirst: jest.fn(() => Promise.resolve({ default_currency: 'SEK' })),
      },
      bundleOffer: { findUnique: jest.fn(() => Promise.resolve(null)) },
      customProduct: { findMany: jest.fn(() => Promise.resolve([])) },
    };
    const designer = {
      cartDesigns: jest.fn(() =>
        Promise.resolve(
          new Map([
            [
              DESIGN,
              {
                id: DESIGN,
                text_values: [],
                editable: true,
                proof_url: null,
                product_slug: 'flagga',
                ...(addons ? { addons } : {}),
              },
            ],
          ]),
        ),
      ),
    };
    const marketPricing = new MarketPricingService(
      prisma as unknown as PrismaService,
    );
    const service = new CartService(
      prisma as unknown as PrismaService,
      {} as TaxService,
      {
        resolve: jest.fn(() => Promise.resolve(null)),
      } as unknown as MarketsContextService,
      marketPricing,
      {} as B2bService,
      buildPersonalizationCore(prisma).core,
      undefined,
      designer as unknown as DesignerCartService,
    );
    const internals = service as unknown as {
      enrichCartItems: (
        items: Record<string, unknown>[],
        locale?: string,
        market?: unknown,
      ) => Promise<Record<string, unknown>[]>;
    };
    const enrich = (
      items: Record<string, unknown>[],
      locale?: string,
      market?: unknown,
    ): Promise<Record<string, unknown>[]> =>
      internals.enrichCartItems(items, locale, market);
    const line = {
      id: 'r1',
      cart_id: 'cart1',
      product_id: 'p1',
      variant_id: null,
      custom_product_id: null,
      bundle_offer_id: null,
      quantity: 2,
      custom_fields: null,
      design_id: DESIGN,
    };
    return { enrich, line, marketPricing };
  }

  it('unit price = base + Σ add-ons; detail rows in the cart currency', async () => {
    const { enrich, line } = buildRead(ADDONS);
    const [item] = await enrich([line], 'sv');
    expect(item.price).toBe(299 + 149 + 358);
    const design = item.design as { addons: { text: string }[] };
    expect(design.addons.map((a) => a.text)).toEqual([
      expect.stringContaining('149'),
      expect.stringMatching(/^× 2 \(\+.*358/),
    ]);
  });

  it('market: each add-on unit price is converted (amount = unit × qty)', async () => {
    const { enrich, line } = buildRead(ADDONS);
    const [item] = await enrich([line], 'de', MARKET);
    expect(item.currency).toBe('EUR');
    // 29.9 + 14.9 + 2 × 17.9
    expect(item.price).toBeCloseTo(80.6, 2);
    const design = item.design as { addons: { amount: number }[] };
    expect(design.addons.map((a) => a.amount)).toEqual([14.9, 35.8]);
  });

  it('market: add-ons that cannot be converted hide the line (never base-currency amounts)', async () => {
    const { enrich, line, marketPricing } = buildRead(ADDONS);
    // An unspied instance converts the base price (convertMoney is pure).
    const real = new MarketPricingService({} as PrismaService);
    jest
      .spyOn(marketPricing, 'convertMoney')
      .mockImplementation((ctx, amount) => {
        if (amount === 149 || amount === 179) {
          throw new BadRequestException({ code: 'MARKET_RATE_MISSING' });
        }
        return real.convertMoney(ctx, amount);
      });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const [item] = await enrich([line], 'de', MARKET);
    expect(item.unavailable_in_market).toBe(true);
    expect(item.design).not.toHaveProperty('addons');
  });

  it('G0: a design without add-ons keeps the M4.2 price and block', async () => {
    const { enrich, line } = buildRead(undefined);
    const [item] = await enrich([line], 'sv');
    expect(item.price).toBe(299);
    expect(item.design).not.toHaveProperty('addons');
  });
});
