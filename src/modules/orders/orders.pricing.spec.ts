import { TaxBasis, TaxPricingMode } from '@prisma/client';
import { roundMoney, toStripeAmount } from '../../common/money/currency.util';
import { includedTaxMinor } from '../../common/money/tax.util';
import {
  buildKustomSessionAmounts,
  expectedKustomAmount,
  sumKustomTax,
} from '../payments/kustom/kustom.mapper';
import {
  computeTaxes,
  type TaxContext,
  type TaxData,
} from '../taxes/tax.service';

// The pricing loop in OrdersService is database-bound, so what is pinned
// down here are the pure pieces it is built from: money rounded at the
// source (roundMoney), the tax engine (computeTaxes) and the agreement
// between the stored order total / tax and what the Kustom mapper sends and
// later verifies (expectedKustomAmount, sumKustomTax).

const ctx = {
  storeSlug: 'my-shop',
  primaryLocale: 'sv',
  storefrontBase: 'https://shop.example.com',
  apiBase: 'https://api.example.com',
  sessionId: 'sess-1',
  token: 'tok',
  callbackToken: 'cb',
};

// An independent Swedish store, 25 % standard rate, prices tax inclusive.
const taxCtx: TaxContext = {
  registrant: 'STORE',
  storeId: 'store-1',
  rateStoreId: 'store-1',
  taxCountry: 'SE',
  pricingMode: TaxPricingMode.INCLUSIVE,
  basis: TaxBasis.SHIPPING,
  ossRegistered: false,
  usePlatformRates: true,
  shippingTaxClassId: null,
  displayPricesInclTax: true,
};
const taxData: TaxData = {
  classes: [
    { id: 'std', store_id: null, key: 'standard', name: {}, is_default: true },
  ],
  rates: [
    {
      id: 'se-std',
      store_id: null,
      tax_class_id: 'std',
      country: 'SE',
      region: null,
      postcode_pattern: null,
      rate_bp: 2500,
      label: { en: 'VAT', sv: 'Moms' },
      priority: 0,
      applies_to_shipping: true,
      is_active: true,
    },
  ],
};

describe('roundMoney', () => {
  it('rounds to the two decimals the database stores', () => {
    expect(roundMoney(9.99 * 3)).toBe(29.97);
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(33.333333)).toBe(33.33);
    expect(roundMoney(19.98 + 49 - 5.5)).toBe(63.48);
  });

  it('rounds zero-decimal currencies to whole units', () => {
    expect(roundMoney(1234.6, 'JPY')).toBe(1235);
    expect(roundMoney(1234.6, 'SEK')).toBe(1234.6);
  });
});

describe('includedTaxMinor', () => {
  it('rounds symmetrically so a negative line cancels its positive twin', () => {
    for (const amount of [1, 3, 5, 7, 13, 49, 1998, 2750]) {
      expect(includedTaxMinor(-amount, 2500)).toBe(
        -includedTaxMinor(amount, 2500),
      );
    }
  });
});

describe('order pricing vs. Kustom amounts', () => {
  // A 9.99 item bought twice, 49 shipping, at 25 % VAT — priced the way
  // OrdersService.priceLine / computeTotals round it.
  const unitPrice = roundMoney(9.99);
  const quantity = 2;
  const totalPrice = roundMoney(unitPrice * quantity);
  const shipping = roundMoney(49);
  const subtotal = roundMoney(totalPrice);

  /** What quoteLines()/create() store for these lines at `discount`. */
  function priced(discount: number) {
    const tax = computeTaxes({
      ctx: taxCtx,
      data: taxData,
      currency: 'SEK',
      locale: 'sv',
      lines: [{ amount: totalPrice, tax_class_id: null, tax_exempt: false }],
      shipping_cost: shipping,
      discount_amount: discount,
      shipping: { country: 'SE' },
    });
    const total = roundMoney(tax.total);
    const items = [
      {
        id: 'item-1',
        quantity,
        unit_price: unitPrice,
        total_price: totalPrice,
        tax_rate_bp: tax.items[0].tax_rate_bp,
        tax_amount: tax.items[0].tax_amount,
        product: { translations: [{ locale: 'sv', title: 'Strumpor' }] },
      },
    ];
    return { tax, total, items };
  }

  it('stores 19.98 + 49 = 68.98 and Kustom is asked for exactly 6898', () => {
    const { tax, total, items } = priced(0);
    expect(total).toBe(68.98);
    expect(total).toBe(roundMoney(subtotal + shipping));
    const amounts = buildKustomSessionAmounts(
      {
        currency: 'SEK',
        shipping_cost: shipping,
        discount_amount: 0,
        total,
        items,
        tax_pricing_mode: tax.tax_pricing_mode,
        shipping_tax_amount: tax.shipping_tax_amount,
        shipping_tax_rate_bp: tax.shipping_tax_rate_bp,
        purchaseCountry: 'SE',
        reference: 'sess-1',
        shippingOptions: [
          { id: 'std', name: 'Standard', type: 'delivery', cost: shipping },
        ],
        selectedShippingId: 'std',
      },
      ctx,
    );
    expect(amounts.order_amount).toBe(6898);
    // What validation compares: the stored Order.total, converted the same way.
    expect(expectedKustomAmount({ total, currency: 'SEK' })).toBe(
      amounts.order_amount,
    );
    // No rounding-adjustment line is needed when money is rounded at the source.
    expect(amounts.order_lines.some((l) => l.reference === 'rounding')).toBe(
      false,
    );
    expect(amounts.order_lines.reduce((s, l) => s + l.total_amount, 0)).toBe(
      6898,
    );
  });

  it('Order.tax_amount equals the order_tax_amount sent to Kustom', () => {
    const { tax, total, items } = priced(0);
    const amounts = buildKustomSessionAmounts(
      {
        currency: 'SEK',
        shipping_cost: shipping,
        discount_amount: 0,
        total,
        items,
        tax_pricing_mode: tax.tax_pricing_mode,
        shipping_tax_amount: tax.shipping_tax_amount,
        shipping_tax_rate_bp: tax.shipping_tax_rate_bp,
        purchaseCountry: 'SE',
        reference: 'sess-1',
        shippingOptions: [],
        selectedShippingId: null,
      },
      ctx,
    );
    expect(toStripeAmount(tax.tax_total, 'SEK')).toBe(
      sumKustomTax(amounts.order_lines),
    );
    expect(sumKustomTax(amounts.order_lines)).toBe(amounts.order_tax_amount);
    // 1998 → 400 (399.6), 4900 → 980: two roundings, one per line.
    expect(amounts.order_tax_amount).toBe(400 + 980);
    expect(tax.tax_lines).toEqual([
      { label: 'Moms', rate_bp: 2500, taxable_amount: 55.18, tax_amount: 13.8 },
    ]);
  });

  it('keeps the line sum consistent with a discount', () => {
    const disc = roundMoney(5.5);
    const { tax, total, items } = priced(disc);
    expect(total).toBe(roundMoney(subtotal + shipping - disc));
    const amounts = buildKustomSessionAmounts(
      {
        currency: 'SEK',
        shipping_cost: shipping,
        discount_amount: disc,
        total,
        items,
        tax_pricing_mode: tax.tax_pricing_mode,
        shipping_tax_amount: tax.shipping_tax_amount,
        shipping_tax_rate_bp: tax.shipping_tax_rate_bp,
        purchaseCountry: 'SE',
        reference: 'sess-1',
        shippingOptions: [],
        selectedShippingId: null,
      },
      ctx,
    );
    expect(amounts.order_amount).toBe(6348);
    expect(expectedKustomAmount({ total, currency: 'SEK' })).toBe(6348);
    expect(toStripeAmount(tax.tax_total, 'SEK')).toBe(amounts.order_tax_amount);
    // The discounted line: 1998 - 550 = 1448 → 290 (289.6) of tax.
    expect(amounts.order_lines[0]).toMatchObject({
      total_amount: 1448,
      total_discount_amount: 550,
      total_tax_amount: 290,
    });
  });
});
