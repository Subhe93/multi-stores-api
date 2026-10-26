import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { StoreType } from '@prisma/client';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { personalizationCoreArgs } from '../personalization/__fixtures__/personalization-service.factory';
import { PromotionsService } from '../promotions/promotions.service';
import { ShippingService } from '../shipping/shipping.service';
import { MailService } from '../mail/mail.service';
import { TaxService } from '../taxes/tax.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { B2bService } from '../b2b/b2b.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import type { CreateOrderDto } from './dto/order.dto';
import {
  DesignerCartService,
  type DesignerLine,
} from '../designer/designer-cart.service';
import type { DesignsService } from '../designer/designs.service';
import type { DesignerAssetsService } from '../designer/designer-assets.service';
import type { DesignerUrlsService } from '../designer/designer-urls';
import type { DesignerTriggersPort } from '../../common/ports/designer-triggers.port';
import { normalizeCartLine } from '../cart/cart-line';

// M4.2 WP4: designer lines in quote / order create (C29, D11, C19), the
// designer trigger call sites and the app-off G0 parity.

const STORE_ID = 's1';
const DESIGN = '99999999-9999-4999-8999-999999999999';

function positional(prisma: unknown, storeApps: unknown, mail?: unknown) {
  return [
    prisma as PrismaService,
    { validateCoupon: jest.fn() } as unknown as PromotionsService,
    {
      quoteForItems: jest.fn(() =>
        Promise.resolve({
          available: true,
          methods: [
            {
              id: 'std',
              name: 'Standard',
              type: 'STANDARD',
              cost: 49,
              estimated_days: { min: 2, max: 5 },
              free_shipping: false,
            },
          ],
        }),
      ),
    } as unknown as ShippingService,
    (mail ?? {
      dispatchOrderEmail: jest.fn(() => Promise.resolve()),
    }) as MailService,
    {
      contextFor: jest.fn(() => Promise.resolve({ pricingMode: 'INCLUSIVE' })),
      loadTaxData: jest.fn(() => Promise.resolve({})),
      computeTaxes: jest.fn(
        (input: { lines: { amount: number }[]; shipping_cost: number }) => ({
          items: input.lines.map(() => ({
            tax_rate_bp: 2500,
            tax_amount: 0,
            tax_class_key: 'standard',
          })),
          headline_rate_bp: 2500,
          tax_total: 0,
          tax_lines: [],
          tax_pricing_mode: 'INCLUSIVE',
          tax_basis_country: 'SE',
          shipping_tax_amount: 0,
          shipping_tax_rate_bp: 2500,
          total:
            input.lines.reduce((s, l) => s + l.amount, 0) + input.shipping_cost,
        }),
      ),
    } as unknown as TaxService,
    {
      resolve: jest.fn(() => Promise.resolve(null)),
    } as unknown as MarketsContextService,
    new MarketPricingService(prisma as PrismaService),
    { get: () => undefined } as unknown as ConfigService,
    new B2bService(storeApps as StoreAppsService),
    ...personalizationCoreArgs(prisma),
  ] as const;
}

const REQUIRED_FIELD = {
  id: 'f1',
  product_id: 'p1',
  name: 'namn',
  type: 'TEXT',
  is_required: true,
  sort_order: 0,
  parent_id: null,
  options: null,
  validation_rules: null,
  linked_validation: null,
  placeholder: null,
  translations: [{ locale: 'sv', label: 'Namn' }],
};

function makePrisma(fields: unknown[] = []) {
  const prisma = {
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: STORE_ID,
          slug: 'namez',
          store_type: StoreType.INDEPENDENT,
          creator_id: 'c1',
          currency: 'SEK',
          cod_enabled: true,
          is_active: true,
          language_config: { primary_locale: 'sv' },
          creator: {
            kustom_enabled: false,
            kustom_merchant_id: null,
            kustom_shared_secret: null,
          },
        }),
      ),
    },
    product: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'p1',
          creator_id: 'c1',
          provider_id: null,
          status: 'PUBLISHED',
          base_price: 299,
          tax_class_id: null,
          tax_exempt: false,
          track_inventory: false,
          stock_quantity: null,
        }),
      ),
    },
    productVariant: { findUnique: jest.fn(() => Promise.resolve(null)) },
    productMarketPrice: { findMany: jest.fn(() => Promise.resolve([])) },
    platformConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve({ default_currency: 'EUR', commission_value: 15 }),
      ),
    },
    customer: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'cust1', user_id: 'u1' }),
      ),
    },
    cart: { findUnique: jest.fn(() => Promise.resolve(null)) },
    cartItem: { deleteMany: jest.fn(() => Promise.resolve({ count: 1 })) },
    address: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'a1',
          country_code: 'SE',
          state: null,
          postal_code: '11123',
        }),
      ),
    },
    order: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: (data.id as string) ?? 'o1',
          ...data,
          items: [],
          timeline: [],
          address: {},
        }),
      ),
    },
    orderCommission: { create: jest.fn(() => Promise.resolve({})) },
    productCustomField: { findMany: jest.fn(() => Promise.resolve(fields)) },
    customProduct: { findMany: jest.fn(() => Promise.resolve([])) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  );
  return prisma;
}

const SNAPSHOT_CREATE = {
  order_id: 'set-by-test',
  store_id: STORE_ID,
  design_id: DESIGN,
  template_id: 't1',
  template_version_id: 'v1',
  template_spec: {},
  state: {},
  assets: [],
  text_values: [{ element_id: 'namn', label: 'Namn', value: 'Anna' }],
  price_breakdown: { designer_delta: 0, addons: [] },
  renderer_version: '1.1.0',
  proof_key: null,
  print_status: 'PENDING',
  print_requested_at: null,
};

/** A DesignerCartService stub whose designer lines are the ones with a design_id. */
function designerStub() {
  const line = {
    design: { id: DESIGN, state_version: 4 },
    priceDelta: 0,
  } as unknown as DesignerLine;
  return {
    planLines: jest.fn((_s: string, lines: { design_id?: string | null }[]) =>
      Promise.resolve(lines.map((l) => (l.design_id ? line : null))),
    ),
    snapshot: jest.fn((_l: unknown, o: { orderId: string }) =>
      Promise.resolve({
        create: { ...SNAPSHOT_CREATE, order_id: o.orderId },
        designTexts: [
          { element_id: 'namn', label: { sv: 'Namn' }, value: 'Anna' },
        ],
        textValues: [],
      }),
    ),
    markOrdered: jest.fn(() => Promise.resolve()),
    orderItemProofUrl: jest.fn((d: { id: string } | null) =>
      d ? `https://api.test/proof-${d.id}` : null,
    ),
    orderItemBackProofUrl: jest.fn(
      (d: { id: string; proof_back_key?: string | null } | null) =>
        d?.proof_back_key ? `https://api.test/proof-back-${d.id}` : null,
    ),
  };
}

function build(opts: {
  fields?: unknown[];
  designer?: unknown;
  triggers?: Partial<DesignerTriggersPort>;
  mail?: unknown;
}) {
  const prisma = makePrisma(opts.fields);
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(false)),
    getSettings: jest.fn(() => Promise.resolve(null)),
  };
  const service = new OrdersService(
    ...positional(prisma, storeApps, opts.mail),
    undefined,
    undefined,
    undefined,
    undefined,
    opts.designer as DesignerCartService | undefined,
    opts.triggers as DesignerTriggersPort | undefined,
  );
  return { service, prisma, storeApps };
}

const DTO = {
  address_id: 'a1',
  store_id: STORE_ID,
  payment_method: 'COD',
  locale: 'sv',
} as CreateOrderDto;

type CreateData = {
  id?: string;
  items: {
    create: Record<string, unknown>[];
  };
};
const createdData = (prisma: ReturnType<typeof makePrisma>) =>
  (prisma.order.create.mock.calls[0] as unknown as [{ data: CreateData }])[0]
    .data;

describe('OrdersService designer lines (M4.2 WP4)', () => {
  it('G0: app off, no design — create() data identical with and without the designer service', async () => {
    const lines = { lines: [{ product_id: 'p1', quantity: 2 }] };
    const plain = build({});
    await plain.service.create('u1', DTO, lines as never);
    const storeAppsOff = {
      isEnabled: jest.fn(() => Promise.resolve(false)),
      getSettings: jest.fn(() => Promise.resolve(null)),
    };
    const realOff = new DesignerCartService(
      {} as PrismaService,
      storeAppsOff as unknown as StoreAppsService,
      {} as DesignsService,
      {} as DesignerAssetsService,
      {} as DesignerUrlsService,
    );
    const withSvc = build({ designer: realOff });
    await withSvc.service.create('u1', DTO, lines as never);
    const strip = (d: Record<string, unknown>) => ({
      ...d,
      order_number: 'x',
    });
    expect(strip(createdData(withSvc.prisma) as never)).toEqual(
      strip(createdData(plain.prisma) as never),
    );
    expect(createdData(withSvc.prisma)).not.toHaveProperty('id');
    expect(withSvc.prisma.$transaction).not.toHaveBeenCalled();
    expect(storeAppsOff.isEnabled).toHaveBeenCalledWith(STORE_ID, 'designer');
  });

  it('designer line: frozen design nested in the same insert, DESIGN rows, fields dropped, price unchanged', async () => {
    const designer = designerStub();
    const { service, prisma } = build({ fields: [REQUIRED_FIELD], designer });
    await service.create('u1', DTO, {
      lines: [
        {
          product_id: 'p1',
          quantity: 1,
          design_id: DESIGN,
          // Sent values are dropped; the required field is not enforced.
          custom_fields: { f1: 'ignored' },
        },
      ],
      verifiedDesignIds: [DESIGN],
    });
    const data = createdData(prisma);
    expect(data.id).toMatch(/^[0-9a-f-]{36}$/);
    const item = data.items.create[0];
    expect(item.unit_price).toBe(299);
    expect(item.design).toEqual({
      create: { ...SNAPSHOT_CREATE, order_id: data.id },
    });
    expect(item.custom_field_values).toEqual({
      create: [
        {
          custom_field_id: null,
          value: 'Anna',
          field_name: 'namn',
          field_type: 'TEXT',
          field_label: { sv: 'Namn' },
          sort_order: 10000,
          source: 'DESIGN',
        },
      ],
    });
    // The ordered design is frozen inside the same transaction.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Frozen at the state_version that was validated and snapshotted.
    expect(designer.markOrdered).toHaveBeenCalledWith(prisma, [
      { id: DESIGN, state_version: 4 },
    ]);
    expect(designer.planLines).toHaveBeenCalledWith(
      STORE_ID,
      [expect.objectContaining({ product_id: 'p1', design_id: DESIGN })],
      expect.objectContaining({
        mode: 'snapshot',
        customerId: 'cust1',
        verifiedDesignIds: [DESIGN],
      }),
    );
    expect(designer.snapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orderId: data.id,
        locale: 'sv',
        primaryLocale: 'sv',
      }),
    );
  });

  it('create response: designed orders include the item design (proof + design block); others keep items: true', async () => {
    const createInclude = (prisma: ReturnType<typeof makePrisma>) =>
      (
        prisma.order.create.mock.calls[0] as unknown as [
          { include: { items: unknown } },
        ]
      )[0].include.items;
    const designer = designerStub();
    const withDesign = build({ designer });
    await withDesign.service.create('u1', DTO, {
      lines: [{ product_id: 'p1', quantity: 1, design_id: DESIGN }],
      verifiedDesignIds: [DESIGN],
    });
    expect(createInclude(withDesign.prisma)).toEqual({
      include: {
        design: {
          select: {
            id: true,
            store_id: true,
            proof_key: true,
            files_purged_at: true,
            back_mode: true,
            proof_back_key: true,
            text_values: true,
          },
        },
      },
    });
    const plain = build({ designer: designerStub() });
    await plain.service.create('u1', DTO, {
      lines: [{ product_id: 'p1', quantity: 1 }],
    } as never);
    expect(createInclude(plain.prisma)).toBe(true);
  });

  it('the same line without a design still enforces the required field (control)', async () => {
    const { service } = build({
      fields: [REQUIRED_FIELD],
      designer: designerStub(),
    });
    await expect(
      service.create('u1', DTO, { lines: [{ product_id: 'p1', quantity: 1 }] }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'CUSTOM_FIELD_REQUIRED',
      }) as unknown,
    });
  });

  it('server cart: mode order with the customer; COD order fires onCodOrderCreated once', async () => {
    const designer = designerStub();
    const triggers = {
      onCodOrderCreated: jest.fn(() => Promise.resolve()),
      onOrderPaid: jest.fn(),
      onStatusChanged: jest.fn(),
    };
    const { service, prisma } = build({ designer, triggers });
    prisma.cart.findUnique.mockResolvedValue({
      id: 'cart1',
      items: [
        {
          id: 'row1',
          product_id: 'p1',
          variant_id: null,
          custom_product_id: null,
          bundle_offer_id: null,
          quantity: 1,
          custom_fields: null,
          design_id: DESIGN,
        },
      ],
    } as never);
    const order = (await service.create('u1', DTO)) as { id: string };
    expect((designer.planLines.mock.calls[0] as unknown[])[2]).toMatchObject({
      mode: 'order',
      customerId: 'cust1',
      refs: [{ line_id: 'row1' }],
    });
    expect(triggers.onCodOrderCreated).toHaveBeenCalledWith({
      id: order.id,
      store_id: STORE_ID,
      payment_method: 'COD',
    });
  });

  it('orders without designs never call the COD trigger', async () => {
    const triggers = {
      onCodOrderCreated: jest.fn(() => Promise.resolve()),
      onOrderPaid: jest.fn(),
      onStatusChanged: jest.fn(),
    };
    const { service } = build({ designer: designerStub(), triggers });
    await service.create('u1', DTO, {
      lines: [{ product_id: 'p1', quantity: 1 }],
    } as never);
    expect(triggers.onCodOrderCreated).not.toHaveBeenCalled();
  });

  it('quote parity: same unit price as the order; tokens reach the check (mode quote)', async () => {
    const designer = designerStub();
    const { service } = build({ fields: [REQUIRED_FIELD], designer });
    const quote = await service.quoteLines(
      STORE_ID,
      [
        {
          product_id: 'p1',
          quantity: 2,
          design_id: DESIGN,
          design_token: 'tok',
        },
      ],
      { countryCode: null },
    );
    expect(quote.items[0]).toMatchObject({ unit_price: 299, total_price: 598 });
    expect(designer.planLines).toHaveBeenCalledWith(
      STORE_ID,
      [expect.objectContaining({ design_id: DESIGN, design_token: 'tok' })],
      expect.objectContaining({ mode: 'quote' }),
    );
  });

  it('Kustom snapshot lines keep design_id, never the token (normalizeCartLine)', () => {
    expect(
      normalizeCartLine({
        product_id: 'p1',
        quantity: 1,
        design_id: DESIGN,
        design_token: 'secret',
      }),
    ).toEqual({
      product_id: 'p1',
      custom_product_id: null,
      variant_id: null,
      bundle_offer_id: null,
      quantity: 1,
      custom_fields: null,
      design_id: DESIGN,
    });
    // Lines without a design: the exact pre-M4.2 shape (no key).
    expect(
      normalizeCartLine({ product_id: 'p1', quantity: 1 }),
    ).not.toHaveProperty('design_id');
  });

  it('read paths: designed lines show the signed proof; other lines lose the null relation key', () => {
    const { service } = build({ designer: designerStub() });
    const shaped = (
      service as unknown as {
        withItemImages(o: unknown): { items: Record<string, unknown>[] };
      }
    ).withItemImages({
      id: 'o1',
      items: [
        { id: 'i1', design: null, product: { images: [{ url: '/p.jpg' }] } },
        {
          id: 'i2',
          design: {
            id: 'oid1',
            store_id: STORE_ID,
            proof_key: 'k',
            files_purged_at: null,
          },
          product: { images: [{ url: '/p.jpg' }] },
        },
      ],
    });
    expect(shaped.items[0]).toEqual({
      id: 'i1',
      product: { images: [{ url: '/p.jpg' }] },
      image_url: '/p.jpg',
    });
    expect(shaped.items[1]).toMatchObject({
      image_url: 'https://api.test/proof-oid1',
      design: { id: 'oid1', proof_url: 'https://api.test/proof-oid1' },
    });
  });

  it('M5.6 read paths: a double-sided line adds its back proof + back texts; single-sided lines keep the exact block', () => {
    const { service } = build({ designer: designerStub() });
    const shaped = (
      service as unknown as {
        withItemImages(o: unknown): { items: Record<string, unknown>[] };
      }
    ).withItemImages({
      id: 'o1',
      items: [
        {
          id: 'i1',
          design: {
            id: 'oid1',
            store_id: STORE_ID,
            proof_key: 'k',
            files_purged_at: null,
            back_mode: null,
            proof_back_key: null,
            text_values: [{ element_id: 'namn', label: 'Namn', value: 'Anna' }],
          },
        },
        {
          id: 'i2',
          design: {
            id: 'oid2',
            store_id: STORE_ID,
            proof_key: 'k',
            files_purged_at: null,
            back_mode: 'other',
            proof_back_key: 'kb',
            text_values: [
              { element_id: 'namn', label: 'Namn', value: 'Anna' },
              {
                element_id: 'back:datum',
                label: 'Datum',
                value: '2026',
                side: 'back',
              },
            ],
          },
        },
        {
          id: 'i3',
          design: {
            id: 'oid3',
            store_id: STORE_ID,
            proof_key: 'k',
            files_purged_at: null,
            back_mode: 'same',
            proof_back_key: null,
            text_values: [
              { element_id: 'namn', label: 'Namn', value: 'Anna' },
              {
                element_id: 'back:namn',
                label: 'Namn',
                value: 'Anna',
                side: 'back',
              },
            ],
          },
        },
      ],
    });
    // Single-sided: no `back` key at all (G0).
    expect(shaped.items[0].design).toEqual({
      id: 'oid1',
      proof_url: 'https://api.test/proof-oid1',
    });
    expect(shaped.items[1].design).toEqual({
      id: 'oid2',
      proof_url: 'https://api.test/proof-oid2',
      back: {
        mode: 'other',
        proof_url: 'https://api.test/proof-back-oid2',
        texts: [{ label: 'Datum', value: '2026' }],
      },
    });
    // 'same' prints the front again: no duplicated texts, proof when rendered.
    expect(shaped.items[2].design).toEqual({
      id: 'oid3',
      proof_url: 'https://api.test/proof-oid3',
      back: { mode: 'same', proof_url: null, texts: [] },
    });
  });

  it('full refund fires onStatusChanged(REFUNDED); a throwing trigger never breaks the flow', async () => {
    const triggers = {
      onCodOrderCreated: jest.fn(),
      onOrderPaid: jest.fn(),
      onStatusChanged: jest.fn(() => Promise.reject(new Error('boom'))),
    };
    const mail = { dispatchOrderEmail: jest.fn(() => Promise.resolve()) };
    const { service, prisma } = build({ triggers, mail });
    const order = {
      id: 'o1',
      store_id: STORE_ID,
      status: 'DELIVERED',
      payment_status: 'paid',
      payment_method: 'STRIPE',
      total: 100,
    };
    Object.assign(prisma.order, {
      findUnique: jest.fn(() => Promise.resolve(order)),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    });
    Object.assign(prisma, {
      orderTimeline: { create: jest.fn(() => Promise.resolve({})) },
      orderItem: { findMany: jest.fn(() => Promise.resolve([])) },
    });
    Object.assign(prisma.orderCommission, {
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    });
    await expect(service.markOrderRefunded('o1')).resolves.toMatchObject({
      changed: true,
    });
    expect(triggers.onStatusChanged).toHaveBeenCalledWith(
      order,
      'DELIVERED',
      'REFUNDED',
    );
    expect(mail.dispatchOrderEmail).toHaveBeenCalled();
  });
  describe('payment failure / released authorization (M4.2 fixes)', () => {
    function lifecycle() {
      const triggers = {
        onCodOrderCreated: jest.fn(),
        onOrderPaid: jest.fn(),
        onStatusChanged: jest.fn(() => Promise.resolve()),
        onPaymentFailed: jest.fn(() => Promise.resolve()),
      };
      const { service, prisma } = build({ triggers });
      const order = {
        id: 'o1',
        store_id: STORE_ID,
        status: 'PENDING',
        payment_status: 'awaiting_payment',
        payment_method: 'KUSTOM',
        total: 100,
      };
      Object.assign(prisma.order, {
        findUnique: jest.fn(() => Promise.resolve(order)),
        updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      });
      Object.assign(prisma, {
        orderTimeline: { create: jest.fn(() => Promise.resolve({})) },
        orderItem: { findMany: jest.fn(() => Promise.resolve([])) },
      });
      Object.assign(prisma.orderCommission, {
        updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      });
      return { service, triggers, order };
    }

    it('markOrderFailed fires onPaymentFailed (terminal rows, designs released)', async () => {
      const { service, triggers, order } = lifecycle();
      await expect(service.markOrderFailed('o1')).resolves.toMatchObject({
        changed: true,
      });
      expect(triggers.onPaymentFailed).toHaveBeenCalledWith(order);
    });

    it('markAuthorizationReleased fires onStatusChanged(→ CANCELLED)', async () => {
      const { service, triggers, order } = lifecycle();
      Object.assign(order, { status: 'CONFIRMED', payment_status: 'paid' });
      await expect(
        service.markAuthorizationReleased('o1', 'released'),
      ).resolves.toEqual({ changed: true });
      expect(triggers.onStatusChanged).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'o1' }),
        'CONFIRMED',
        'CANCELLED',
      );
    });
  });
});

// M5.5: paid add-ons of designed lines (server-priced, base currency in the
// designer line, converted per unit for a market, frozen with the design).
describe('OrdersService designer add-ons (M5.5)', () => {
  const ADDONS = [
    {
      key: 'double',
      type: 'toggle' as const,
      label: { sv: 'Dubbelsidig' },
      qty: 1,
      unit_price: 149,
      amount: 149,
    },
    {
      key: 'poster',
      type: 'quantity' as const,
      label: { sv: 'Poster' },
      qty: 2,
      unit_price: 179,
      amount: 358,
    },
  ];
  function addonStub() {
    const stub = designerStub();
    const line = {
      design: { id: DESIGN, state_version: 4 },
      priceDelta: 507,
      addons: ADDONS,
    } as unknown as DesignerLine;
    stub.planLines.mockImplementation(
      (_s: string, lines: { design_id?: string | null }[]) =>
        Promise.resolve(lines.map((l) => (l.design_id ? line : null))),
    );
    return stub;
  }

  it('order: unit = base + Σ add-ons, total = unit × qty, tax on the product class, add-ons frozen in SEK', async () => {
    const designer = addonStub();
    const { service, prisma } = build({ designer });
    // A product with its own tax class: the add-ons must follow it.
    const product = await prisma.product.findUnique();
    (prisma.product.findUnique as jest.Mock).mockImplementation(() =>
      Promise.resolve({ ...product, tax_class_id: 'tc-reduced' }),
    );
    await service.create('u1', DTO, {
      lines: [{ product_id: 'p1', quantity: 2, design_id: DESIGN }],
      verifiedDesignIds: [DESIGN],
    });
    const item = createdData(prisma).items.create[0];
    expect(item.unit_price).toBe(299 + 149 + 358);
    expect(item.total_price).toBe((299 + 507) * 2);
    expect(designer.snapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        addons: ADDONS,
        addonsTotal: 507,
        currency: 'SEK',
      }),
    );
    // The add-ons ride on the product line: one tax line, product class.
    const tax = (
      service as unknown as { taxService: { computeTaxes: jest.Mock } }
    ).taxService;
    const calls = tax.computeTaxes.mock.calls as [
      { lines: { amount: number; tax_class_id: string | null }[] },
    ][];
    const taxInput = calls[calls.length - 1][0];
    expect(taxInput.lines).toEqual([
      expect.objectContaining({ amount: 1612, tax_class_id: 'tc-reduced' }),
    ]);
  });

  it('quote: same unit price and the add-ons on the item (Kustom names them)', async () => {
    const designer = addonStub();
    const { service } = build({ designer });
    const quote = await service.quoteLines(
      STORE_ID,
      [{ product_id: 'p1', quantity: 1, design_id: DESIGN }],
      { countryCode: null },
    );
    expect(quote.items[0]).toMatchObject({
      unit_price: 806,
      total_price: 806,
      designer_addons: ADDONS,
    });
  });

  it('quote without add-ons keeps the item shape (no designer_addons key)', async () => {
    const designer = designerStub();
    const { service } = build({ designer });
    const quote = await service.quoteLines(
      STORE_ID,
      [{ product_id: 'p1', quantity: 1, design_id: DESIGN }],
      { countryCode: null },
    );
    expect('designer_addons' in quote.items[0]).toBe(false);
    expect(quote.items[0].unit_price).toBe(299);
  });

  it('market: each add-on unit price goes through MarketPricingService.convertMoney', async () => {
    const designer = addonStub();
    const { service } = build({ designer });
    const svc = service as unknown as {
      markets: { resolve: jest.Mock };
      marketPricing: MarketPricingService;
    };
    svc.markets.resolve.mockResolvedValue({
      id: 'm-eu',
      key: 'eu',
      name: 'EU',
      countries: ['DE'],
      defaultLocale: 'de',
      locales: [],
      currency: 'EUR',
      storeCurrency: 'SEK',
      rate: 0.1,
      priceRule: { mode: 'convert', rate: 0.1 },
      isDefault: false,
      indexing: 'AUTO',
      status: 'LIVE',
      primaryHostname: null,
      hostnames: [],
    });
    const spy = jest.spyOn(svc.marketPricing, 'convertMoney');
    const quote = await service.quoteLines(
      STORE_ID,
      [{ product_id: 'p1', quantity: 1, design_id: DESIGN }],
      { countryCode: null, marketKey: 'eu' },
    );
    const converted = spy.mock.calls.map((c) => c[1]);
    expect(converted).toEqual(expect.arrayContaining([149, 179]));
    const base = quote.items[0].unit_price - (14.9 + 2 * 17.9);
    expect(quote.items[0].designer_addons).toEqual([
      expect.objectContaining({
        key: 'double',
        unit_price: 14.9,
        amount: 14.9,
      }),
      expect.objectContaining({
        key: 'poster',
        unit_price: 17.9,
        amount: 35.8,
      }),
    ]);
    expect(base).toBeGreaterThan(0);
  });

  it('market: an add-on that cannot be converted fails the quote (never priced in the base currency)', async () => {
    const designer = addonStub();
    const { service } = build({ designer });
    const svc = service as unknown as {
      markets: { resolve: jest.Mock };
      marketPricing: MarketPricingService;
    };
    svc.markets.resolve.mockResolvedValue({
      id: 'm-eu',
      key: 'eu',
      name: 'EU',
      countries: ['DE'],
      defaultLocale: 'de',
      locales: [],
      currency: 'EUR',
      storeCurrency: 'SEK',
      rate: 0.1,
      priceRule: { mode: 'convert', rate: 0.1 },
      isDefault: false,
      indexing: 'AUTO',
      status: 'LIVE',
      primaryHostname: null,
      hostnames: [],
    });
    // An unspied instance converts the base price (convertMoney is pure).
    const real = new MarketPricingService({} as PrismaService);
    // Only the add-on amounts lose their rate: the base price still converts.
    jest
      .spyOn(svc.marketPricing, 'convertMoney')
      .mockImplementation((ctx, amount) => {
        if (amount === 149 || amount === 179) {
          throw new BadRequestException({ code: 'TEST_ADDON_RATE_MISSING' });
        }
        return real.convertMoney(ctx, amount);
      });
    await expect(
      service.quoteLines(
        STORE_ID,
        [{ product_id: 'p1', quantity: 1, design_id: DESIGN }],
        { countryCode: null, marketKey: 'eu' },
      ),
    ).rejects.toMatchObject({
      response: { code: 'TEST_ADDON_RATE_MISSING' },
    });
  });
});
