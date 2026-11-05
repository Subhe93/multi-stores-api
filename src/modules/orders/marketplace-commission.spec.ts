import {
  OrderStatus,
  StoreType,
  TaxBasis,
  TaxExemptReason,
  TaxPricingMode,
} from '@prisma/client';
import {
  computeTaxes,
  type TaxClassRow,
  type TaxContext,
  type TaxLineInput,
  type TaxRateRow,
} from '../taxes/tax.service';
import {
  computeMarketplaceCommission,
  couponBreaksProviderFloor,
} from './marketplace-commission';
import { splitProviderShares } from '../../common/money/provider-share.util';
import { OrdersService } from './orders.service';

// Marketplace VAT fix (2026-11-16): the platform is the seller of record, so
// the order's VAT is reserved for it and the platform % / provider / creator
// split runs on the NET merchandise revenue. Every scenario runs the real tax
// engine first, exactly like OrdersService.create().

const COMMISSION = 15;

const CLASSES: TaxClassRow[] = [
  {
    id: 'std',
    store_id: null,
    key: 'standard',
    name: { en: 'standard' },
    is_default: true,
  },
  {
    id: 'red',
    store_id: null,
    key: 'reduced',
    name: { en: 'reduced' },
    is_default: false,
  },
];
const rate = (id: string, classId: string, bp: number): TaxRateRow => ({
  id,
  store_id: null,
  tax_class_id: classId,
  country: 'SE',
  region: null,
  postcode_pattern: null,
  rate_bp: bp,
  label: { en: 'VAT' },
  priority: 0,
  applies_to_shipping: true,
  is_active: true,
});
const RATES: TaxRateRow[] = [rate('r1', 'std', 2500), rate('r2', 'red', 1200)];

function ctx(over: Partial<TaxContext> = {}): TaxContext {
  return {
    registrant: 'PLATFORM',
    storeId: 'store-1',
    rateStoreId: 'store-1',
    taxCountry: 'SE',
    pricingMode: TaxPricingMode.INCLUSIVE,
    basis: TaxBasis.SHIPPING,
    ossRegistered: false,
    usePlatformRates: true,
    shippingTaxClassId: null,
    displayPricesInclTax: true,
    ...over,
  } as TaxContext;
}

const line = (amount: number, cls: string | null = null): TaxLineInput => ({
  amount,
  tax_class_id: cls,
  tax_exempt: false,
});

/** Tax engine + split, as OrdersService.create() wires them. */
function order(input: {
  lines: TaxLineInput[];
  shipping?: number;
  discount?: number;
  providerBase: number;
  ctx?: Partial<TaxContext>;
}) {
  const subtotal =
    Math.round(input.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const discount = input.discount ?? 0;
  const tax = computeTaxes({
    ctx: ctx(input.ctx),
    data: { classes: CLASSES, rates: RATES },
    currency: 'EUR',
    locale: 'en',
    lines: input.lines,
    shipping_cost: input.shipping ?? 0,
    discount_amount: discount,
    shipping: { country: 'SE' },
  });
  const split = computeMarketplaceCommission({
    subtotal,
    discountAmount: discount,
    netItems: tax.net_items,
    providerBaseTotal: input.providerBase,
    commissionPercent: COMMISSION,
  });
  return { tax, split, vat: tax.tax_total };
}

const cents = (n: number) => Math.round(n * 100);

/** platform + provider + creator + VAT + net shipping == total, to the cent. */
function expectExactSum(o: ReturnType<typeof order>) {
  const { tax, split, vat } = o;
  expect(
    cents(split.platformAmount) +
      cents(split.providerAmount) +
      cents(split.creatorAmount) +
      cents(vat) +
      cents(tax.net_shipping),
  ).toBe(cents(tax.total));
  // Every part is a whole number of minor units.
  for (const v of [
    split.platformAmount,
    split.providerAmount,
    split.creatorAmount,
  ]) {
    expect(Math.abs(v * 100 - Math.round(v * 100))).toBeLessThan(1e-6);
  }
}

describe('computeMarketplaceCommission: VAT reserved for the platform', () => {
  it('ORD-MW3G4KPG-XG0J: 2 x 25 EUR incl. 25% VAT, provider base 15/unit', () => {
    const o = order({ lines: [line(50)], providerBase: 30 });
    expect(o.tax.total).toBe(50);
    expect(o.vat).toBe(10);
    expect(o.tax.net_items).toBe(40);
    // Current rules on 40 net: 15% = 6.00; provider floor 30 x 0.85 = 25.50;
    // the creator gets the rest of the pool (34 - 25.50).
    expect(o.split).toEqual({
      platformAmount: 6,
      providerAmount: 25.5,
      creatorAmount: 8.5,
    });
    // The platform keeps commission + VAT = 16.00.
    expect(o.split.platformAmount + o.vat).toBe(16);
    expectExactSum(o);
  });

  it('reproduces the old (gross) split when fed the gross amount', () => {
    // What production showed before the fix: 7.50 / 17.00 / 25.50.
    expect(
      computeMarketplaceCommission({
        subtotal: 50,
        discountAmount: 0,
        netItems: 50,
        providerBaseTotal: 30,
        commissionPercent: COMMISSION,
      }),
    ).toEqual({ platformAmount: 7.5, providerAmount: 25.5, creatorAmount: 17 });
  });

  it('shipping VAT is reserved too; net shipping stays outside the split', () => {
    const o = order({ lines: [line(50)], shipping: 10, providerBase: 30 });
    expect(o.tax.total).toBe(60);
    expect(o.tax.shipping_tax_amount).toBe(2);
    expect(o.vat).toBe(12);
    expect(o.tax.net_shipping).toBe(8);
    expect(o.split).toEqual({
      platformAmount: 6,
      providerAmount: 25.5,
      creatorAmount: 8.5,
    });
    expectExactSum(o);
  });

  it('coupon: the discount comes out of the creator margin, provider keeps the floor', () => {
    // 50 - 10 coupon = 40 gross = 32 net + 8 VAT.
    const o = order({ lines: [line(50)], discount: 10, providerBase: 30 });
    expect(o.vat).toBe(8);
    expect(o.tax.net_items).toBe(32);
    expect(o.split).toEqual({
      platformAmount: 4.8,
      providerAmount: 25.5,
      creatorAmount: 1.7,
    });
    expectExactSum(o);
  });

  it('deep coupon: the platform commission gives way to the provider floor', () => {
    // 50 - 14 = 36 gross = 28.80 net + 7.20 VAT. 15% would be 4.32, but only
    // 28.80 - 25.50 = 3.30 is left above the provider floor.
    const o = order({ lines: [line(50)], discount: 14, providerBase: 30 });
    expect(o.vat).toBe(7.2);
    expect(o.split).toEqual({
      platformAmount: 3.3,
      providerAmount: 25.5,
      creatorAmount: 0,
    });
    expectExactSum(o);
  });

  it('two providers: aggregate share, then exact per-provider transfers', () => {
    // A: 2 x 25 (base 2 x 15); B: 1 x 12.50 (base 7.50). All 25% VAT.
    const o = order({ lines: [line(50), line(12.5)], providerBase: 37.5 });
    expect(o.vat).toBe(12.5);
    expect(o.tax.net_items).toBe(50);
    expect(o.split).toEqual({
      platformAmount: 7.5,
      providerAmount: 31.88,
      creatorAmount: 10.62,
    });
    expectExactSum(o);
    const shares = splitProviderShares(cents(o.split.providerAmount), [
      { fulfiller_id: 'prov-a', provider_base_amount: 15 },
      { fulfiller_id: 'prov-b', provider_base_amount: 7.5 },
      { fulfiller_id: 'prov-a', provider_base_amount: 15 },
    ]);
    expect(shares.get('prov-a')).toBe(2550);
    expect(shares.get('prov-b')).toBe(638);
    expect([...shares.values()].reduce((s, v) => s + v, 0)).toBe(3188);
  });

  it('reduced rate (12%): VAT 12 on 112, split on 100 net', () => {
    const o = order({ lines: [line(112, 'red')], providerBase: 60 });
    expect(o.vat).toBe(12);
    expect(o.split).toEqual({
      platformAmount: 15,
      providerAmount: 51,
      creatorAmount: 34,
    });
    expectExactSum(o);
  });

  it('mixed rates + shipping + coupon: the parts add up to the total to the cent', () => {
    const o = order({
      lines: [line(29.97), line(13.37, 'red'), line(9.99)],
      shipping: 4.99,
      discount: 3.33,
      providerBase: 21.11,
    });
    expect(o.vat).toBeGreaterThan(0);
    expectExactSum(o);
  });

  it('rounding: many odd amounts always sum exactly', () => {
    const amounts = [0.01, 0.99, 1.01, 9.99, 19.95, 33.33, 49.9, 99.99, 123.45];
    for (const a of amounts) {
      for (const disc of [0, 0.01, a / 3]) {
        const discount = Math.min(Math.round(disc * 100) / 100, a);
        const half = Math.max(0.01, Math.round((a / 2) * 100) / 100);
        const o = order({
          lines: [line(a), line(half, 'red')],
          shipping: 3.33,
          discount,
          providerBase: Math.round(a * 0.4 * 100) / 100,
        });
        expectExactSum(o);
      }
    }
  });

  it('reverse charge (valid EU VAT number): VAT 0, split exactly as before', () => {
    const o = order({
      lines: [line(50)],
      providerBase: 30,
      ctx: { exemption: { reason: TaxExemptReason.REVERSE_CHARGE } },
    });
    expect(o.vat).toBe(0);
    expect(o.split).toEqual({
      platformAmount: 7.5,
      providerAmount: 25.5,
      creatorAmount: 17,
    });
    expectExactSum(o);
  });

  it('EXCLUSIVE store: VAT already on top, split unchanged (40 net + 10)', () => {
    const o = order({
      lines: [line(40)],
      providerBase: 30,
      ctx: {
        pricingMode: TaxPricingMode.EXCLUSIVE,
        displayPricesInclTax: false,
      },
    });
    expect(o.tax.total).toBe(50);
    expect(o.vat).toBe(10);
    expect(o.split).toEqual({
      platformAmount: 6,
      providerAmount: 25.5,
      creatorAmount: 8.5,
    });
    expectExactSum(o);
  });
});

describe('splitProviderShares', () => {
  it('largest remainder: never pays one cent more than the pool', () => {
    // Plain per-provider Math.round would send 51 + 51 = 102.
    const shares = splitProviderShares(101, [
      { fulfiller_id: 'prov-b', provider_base_amount: 10 },
      { fulfiller_id: 'prov-a', provider_base_amount: 10 },
    ]);
    expect(shares.get('prov-a')).toBe(51);
    expect(shares.get('prov-b')).toBe(50);
  });

  it('does not depend on the order the items were loaded in', () => {
    const items = [
      { fulfiller_id: 'p1', provider_base_amount: 3.33 },
      { fulfiller_id: 'p2', provider_base_amount: 3.33 },
      { fulfiller_id: 'p3', provider_base_amount: 3.34 },
    ];
    const a = splitProviderShares(1000, items);
    const b = splitProviderShares(1000, [...items].reverse());
    expect([...a.entries()]).toEqual([...b.entries()]);
    expect([...a.values()].reduce((s, v) => s + v, 0)).toBe(1000);
  });
});

describe('OrdersService.recomputeCommissionForOrder', () => {
  function service(orderRow: Record<string, unknown>, payouts = 0) {
    const prisma = {
      order: { findUnique: jest.fn(() => Promise.resolve(orderRow)) },
      orderPayout: { count: jest.fn(() => Promise.resolve(payouts)) },
      store: {
        findUnique: jest.fn(() =>
          Promise.resolve({ store_type: orderRow.__storeType }),
        ),
      },
      platformConfig: {
        findFirst: jest.fn(() => Promise.resolve({ commission_value: 15 })),
      },
      orderCommission: { upsert: jest.fn(() => Promise.resolve({})) },
    };
    const svc = Object.create(OrdersService.prototype) as OrdersService;
    (svc as unknown as { prisma: unknown }).prisma = prisma;
    return { svc, prisma };
  }

  const base = {
    id: 'o1',
    store_id: 's1',
    currency: 'EUR',
    status: OrderStatus.PENDING,
    payment_status: 'awaiting_payment',
    subtotal: 50,
    discount_amount: 0,
    shipping_cost: 0,
    shipping_tax_amount: 0,
    tax_amount: 10,
    tax_pricing_mode: TaxPricingMode.INCLUSIVE,
    total: 50,
    items: [{ provider_base_amount: 30, fulfiller_type: 'PROVIDER' }],
    commission: null,
    __storeType: StoreType.MARKETPLACE,
  };

  it('unpaid marketplace order: net split + VAT recorded', async () => {
    const { svc, prisma } = service(base);
    await svc.recomputeCommissionForOrder('o1');
    expect(prisma.orderCommission.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          platform_amount: 6,
          provider_amount: 25.5,
          creator_amount: 8.5,
          vat_amount: 10,
        },
      }),
    );
  });

  it('independent store: unchanged, the creator keeps the total, no VAT', async () => {
    const { svc, prisma } = service({
      ...base,
      __storeType: StoreType.INDEPENDENT,
    });
    await svc.recomputeCommissionForOrder('o1');
    expect(prisma.orderCommission.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          platform_amount: 0,
          provider_amount: 0,
          creator_amount: 50,
          vat_amount: null,
        },
      }),
    );
  });

  it.each([
    ['paid', { payment_status: 'paid' }, 0],
    ['refunded', { payment_status: 'refunded' }, 0],
    [
      'delivered COD',
      { payment_status: 'pending', status: OrderStatus.DELIVERED },
      0,
    ],
    ['returned', { status: OrderStatus.RETURNED }, 0],
    ['with payout rows', {}, 1],
  ])('settled history is never re-derived: %s', async (_l, over, payouts) => {
    const { svc, prisma } = service({ ...base, ...over }, payouts);
    await svc.recomputeCommissionForOrder('o1');
    expect(prisma.orderCommission.upsert).not.toHaveBeenCalled();
  });
});

describe('couponBreaksProviderFloor', () => {
  // Price 110 incl. VAT, provider base 100.
  it('10 % VAT (net 100): a 1.00 coupon (net 99.09) is refused', () => {
    expect(
      couponBreaksProviderFloor({
        discountAmount: 1,
        netItemsAfter: 99.09,
        netItemsBefore: 100,
        providerBaseTotal: 100,
      }),
    ).toBe(true);
  });

  it('free-shipping / zero-amount coupons always pass', () => {
    expect(
      couponBreaksProviderFloor({
        discountAmount: 0,
        netItemsAfter: 88,
        netItemsBefore: 88,
        providerBaseTotal: 100,
      }),
    ).toBe(false);
  });

  it('25 % VAT (net 88, already under base): a 5.00 coupon (net 84) is refused', () => {
    expect(
      couponBreaksProviderFloor({
        discountAmount: 5,
        netItemsAfter: 84,
        netItemsBefore: 88,
        providerBaseTotal: 100,
      }),
    ).toBe(true);
  });

  it('a coupon that keeps net revenue above the base passes', () => {
    // 2 x 110 at 10 % = net 200, base 100: a 22.00 coupon leaves net 180.
    expect(
      couponBreaksProviderFloor({
        discountAmount: 22,
        netItemsAfter: 180,
        netItemsBefore: 200,
        providerBaseTotal: 100,
      }),
    ).toBe(false);
  });
});
