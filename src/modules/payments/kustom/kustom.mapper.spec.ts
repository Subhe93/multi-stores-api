import {
  buildKustomCheckoutPayload,
  buildKustomOrderLines,
  resolveKustomLocale,
  resolveStoreBase,
  splitFullName,
  type KustomOrderInput,
} from './kustom.mapper';

// Kustom rejects the whole checkout when any of these invariants breaks, so
// the mapper is pinned down here: every line must satisfy
// total_amount == quantity * unit_price - total_discount_amount, and the
// order_amount must equal the sum of all line totals.

function order(overrides: Partial<KustomOrderInput> = {}): KustomOrderInput {
  return {
    id: 'order-1',
    order_number: 'MS-0001',
    currency: 'SEK',
    subtotal: 250,
    shipping_cost: 49,
    discount_amount: 0,
    total: 299,
    items: [
      {
        id: 'item-1',
        quantity: 2,
        unit_price: 125,
        total_price: 250,
        product: { translations: [{ locale: 'sv', title: 'Tröja' }] },
        variant: { sku: 'SKU-1', options: { size: 'M', color: 'Blå' } },
      },
    ],
    address: {
      full_name: 'Anna Maria Svensson',
      line1: 'Sturegatan 6',
      city: 'Stockholm',
      postal_code: '114 35',
      country_code: 'se',
      phone: '+46701234567',
    },
    customer: { user: { email: 'anna@example.com' } },
    ...overrides,
  };
}

const ctx = {
  storeSlug: 'my-shop',
  primaryLocale: 'sv',
  storefrontBase: 'https://shop.example.com/',
  apiBase: 'https://api.example.com/',
  pushToken: 'tok',
};

function assertLineInvariants(lines: ReturnType<typeof buildKustomOrderLines>) {
  for (const line of lines) {
    expect(line.total_amount).toBe(
      line.quantity * line.unit_price - line.total_discount_amount,
    );
    expect(line.total_discount_amount).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(line.unit_price)).toBe(true);
    expect(Number.isInteger(line.total_amount)).toBe(true);
  }
}

describe('buildKustomOrderLines', () => {
  it('sums to the order total and keeps every line consistent', () => {
    const lines = buildKustomOrderLines(order(), 'sv');
    assertLineInvariants(lines);
    const sum = lines.reduce((s, l) => s + l.total_amount, 0);
    expect(sum).toBe(29900);
    expect(lines.map((l) => l.type)).toEqual(['physical', 'shipping_fee']);
    expect(lines[0].name).toBe('Tröja (M / Blå)');
    expect(lines[0].reference).toBe('SKU-1');
  });

  it('adds a negative discount line and still matches the total', () => {
    const lines = buildKustomOrderLines(
      order({ discount_amount: 30, total: 269 }),
      'sv',
    );
    assertLineInvariants(lines);
    const discount = lines.find((l) => l.type === 'discount');
    expect(discount?.total_amount).toBe(-3000);
    expect(lines.reduce((s, l) => s + l.total_amount, 0)).toBe(26900);
  });

  it('absorbs rounding gaps between unit and line totals', () => {
    // 3 × 33.33 is stored as 99.99 for the line, 100 for the order.
    const lines = buildKustomOrderLines(
      order({
        items: [
          {
            id: 'item-1',
            quantity: 3,
            unit_price: 33.33,
            total_price: 99.99,
            product: { translations: [{ locale: 'en', title: 'Mug' }] },
          },
        ],
        shipping_cost: 0,
        total: 100,
      }),
      'en',
    );
    assertLineInvariants(lines);
    expect(lines.reduce((s, l) => s + l.total_amount, 0)).toBe(10000);
    expect(lines.some((l) => l.reference === 'rounding')).toBe(true);
  });

  it('handles zero-decimal currencies without scaling', () => {
    const lines = buildKustomOrderLines(
      order({
        currency: 'JPY',
        items: [
          {
            id: 'item-1',
            quantity: 1,
            unit_price: 1500,
            total_price: 1500,
            product: { translations: [{ locale: 'en', title: 'Cup' }] },
          },
        ],
        shipping_cost: 500,
        total: 2000,
      }),
      'en',
    );
    assertLineInvariants(lines);
    expect(lines.reduce((s, l) => s + l.total_amount, 0)).toBe(2000);
  });
});

describe('buildKustomCheckoutPayload', () => {
  it('builds the contract payload, urls and prefilled address', () => {
    const payload = buildKustomCheckoutPayload(order(), ctx);
    expect(payload.purchase_country).toBe('SE');
    expect(payload.purchase_currency).toBe('SEK');
    expect(payload.locale).toBe('sv-SE');
    expect(payload.order_amount).toBe(29900);
    expect(payload.order_tax_amount).toBe(0);
    expect(payload.merchant_reference1).toBe('order-1');
    expect(payload.merchant_reference2).toBe('MS-0001');
    expect(payload.options).toEqual({
      auto_capture: false,
      allow_separate_shipping_address: true,
      require_validate_callback_success: true,
    });
    expect(payload.billing_address).toEqual({
      given_name: 'Anna Maria',
      family_name: 'Svensson',
      street_address: 'Sturegatan 6',
      postal_code: '114 35',
      city: 'Stockholm',
      country: 'SE',
      email: 'anna@example.com',
      phone: '+46701234567',
    });
    expect(payload.merchant_urls).toEqual({
      terms: 'https://shop.example.com/store/my-shop/legal/terms',
      checkout:
        'https://shop.example.com/store/my-shop/checkout/kustom?orderId=order-1',
      confirmation:
        'https://shop.example.com/store/my-shop/checkout/kustom/confirmation?orderId=order-1&kustom_order_id={checkout.order.id}',
      push: 'https://api.example.com/api/payments/kustom/push?order_id=order-1&token=tok&kustom_order_id={checkout.order.id}',
      validation:
        'https://api.example.com/api/payments/kustom/validation?order_id=order-1&token=tok',
    });
  });
});

describe('resolveStoreBase', () => {
  it('uses the custom domain when the store has one, else the platform path', () => {
    expect(
      resolveStoreBase(
        'https://shop.example.com/',
        'my-shop',
        'www.mybrand.se',
      ),
    ).toBe('https://www.mybrand.se');
    expect(
      resolveStoreBase(
        'https://shop.example.com',
        'my-shop',
        'https://mybrand.se/',
      ),
    ).toBe('https://mybrand.se');
    expect(resolveStoreBase('https://shop.example.com', 'my-shop', null)).toBe(
      'https://shop.example.com/store/my-shop',
    );
    expect(
      buildKustomCheckoutPayload(order(), {
        ...ctx,
        customDomain: 'mybrand.se',
      }).merchant_urls.confirmation,
    ).toBe(
      'https://mybrand.se/checkout/kustom/confirmation?orderId=order-1&kustom_order_id={checkout.order.id}',
    );
  });
});

describe('resolveKustomLocale', () => {
  it('prefers the destination market, then the store language', () => {
    expect(resolveKustomLocale('en', 'SE')).toBe('sv-SE');
    expect(resolveKustomLocale('sv', 'DE')).toBe('de-DE');
    expect(resolveKustomLocale('tr', 'TR')).toBe('tr-TR');
    expect(resolveKustomLocale('ar', 'SA')).toBe('en-GB');
    expect(resolveKustomLocale(null, null)).toBe('en-GB');
  });
});

describe('splitFullName', () => {
  it('keeps the last word as the family name', () => {
    expect(splitFullName('Anna Maria Svensson')).toEqual({
      given_name: 'Anna Maria',
      family_name: 'Svensson',
    });
    expect(splitFullName('Cher')).toEqual({
      given_name: 'Cher',
      family_name: '',
    });
  });
});
