import { roundMoney, toStripeAmount } from '../../common/money/currency.util';
import {
  includedTaxForOrder,
  includedTaxMinor,
} from '../../common/money/tax.util';
import {
  buildKustomSessionAmounts,
  expectedKustomAmount,
  sumKustomTax,
} from '../payments/kustom/kustom.mapper';

// The pricing loop in OrdersService is database-bound, so what is pinned
// down here are the pure pieces it is built from: money rounded at the
// source (roundMoney), the per-line tax rule (includedTaxForOrder) and the
// agreement between the stored order total and what the Kustom mapper sends
// and later verifies (expectedKustomAmount).

const ctx = {
  storeSlug: 'my-shop',
  primaryLocale: 'sv',
  storefrontBase: 'https://shop.example.com',
  apiBase: 'https://api.example.com',
  sessionId: 'sess-1',
  token: 'tok',
  callbackToken: 'cb',
  taxRateBp: 2500,
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
  it('rounds symmetrically so a discount line cancels its positive twin', () => {
    for (const amount of [1, 3, 5, 7, 13, 49, 1998, 2750]) {
      expect(includedTaxMinor(-amount, 2500)).toBe(
        -includedTaxMinor(amount, 2500),
      );
    }
  });
});

describe('order pricing vs. Kustom amounts', () => {
  // A 9.99 item bought twice, 49 shipping, at 25 % VAT — priced the way
  // OrdersService.priceLine / computeTotals now round it.
  const unitPrice = roundMoney(9.99);
  const quantity = 2;
  const totalPrice = roundMoney(unitPrice * quantity);
  const shipping = roundMoney(49);
  const discount = 0;
  const subtotal = roundMoney(totalPrice);
  const total = roundMoney(subtotal + shipping - discount);
  const items = [
    {
      id: 'item-1',
      quantity,
      unit_price: unitPrice,
      total_price: totalPrice,
      product: { translations: [{ locale: 'sv', title: 'Strumpor' }] },
    },
  ];

  it('stores 19.98 + 49 = 68.98 and Kustom is asked for exactly 6898', () => {
    expect(total).toBe(68.98);
    const amounts = buildKustomSessionAmounts(
      {
        currency: 'SEK',
        shipping_cost: shipping,
        discount_amount: discount,
        total,
        items,
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
    const taxMajor = includedTaxForOrder(
      { items, shipping_cost: shipping, discount_amount: discount },
      ctx.taxRateBp,
      'SEK',
    );
    const amounts = buildKustomSessionAmounts(
      {
        currency: 'SEK',
        shipping_cost: shipping,
        discount_amount: discount,
        total,
        items,
        purchaseCountry: 'SE',
        reference: 'sess-1',
        shippingOptions: [],
        selectedShippingId: null,
      },
      ctx,
    );
    expect(toStripeAmount(taxMajor, 'SEK')).toBe(
      sumKustomTax(amounts.order_lines),
    );
    expect(sumKustomTax(amounts.order_lines)).toBe(amounts.order_tax_amount);
    // 1998 → 400 (399.6), 4900 → 980: two roundings, one per line.
    expect(amounts.order_tax_amount).toBe(400 + 980);
  });

  it('keeps the line sum consistent with a discount line', () => {
    const disc = roundMoney(5.5);
    const totalWithDiscount = roundMoney(subtotal + shipping - disc);
    const taxMajor = includedTaxForOrder(
      { items, shipping_cost: shipping, discount_amount: disc },
      ctx.taxRateBp,
      'SEK',
    );
    const amounts = buildKustomSessionAmounts(
      {
        currency: 'SEK',
        shipping_cost: shipping,
        discount_amount: disc,
        total: totalWithDiscount,
        items,
        purchaseCountry: 'SE',
        reference: 'sess-1',
        shippingOptions: [],
        selectedShippingId: null,
      },
      ctx,
    );
    expect(amounts.order_amount).toBe(6348);
    expect(
      expectedKustomAmount({ total: totalWithDiscount, currency: 'SEK' }),
    ).toBe(6348);
    expect(toStripeAmount(taxMajor, 'SEK')).toBe(amounts.order_tax_amount);
  });
});
