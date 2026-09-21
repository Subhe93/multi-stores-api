import {
  buildKustomCheckoutPayload,
  buildKustomOrderLines,
  buildKustomSessionPayload,
  buildKustomShippingOptions,
  resolveKustomLocale,
  resolveStoreBase,
  splitFullName,
  sumKustomTax,
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

describe('tax', () => {
  const taxed = () =>
    buildKustomOrderLines(order({ discount_amount: 30, total: 269 }), 'sv', {
      taxRateBp: 2500,
    });

  it('splits 25 % VAT out of every line and sums it into the order', () => {
    const lines = taxed();
    assertLineInvariants(lines);
    for (const line of lines) {
      expect(line.tax_rate).toBe(2500);
      expect(line.total_tax_amount).toBe(
        Math.round(line.total_amount - (line.total_amount * 10000) / 12500),
      );
    }
    // The discount line carries negative tax so the sum stays consistent.
    const discount = lines.find((l) => l.type === 'discount');
    expect(discount?.total_tax_amount).toBe(-600);

    const payload = buildKustomCheckoutPayload(
      order({ discount_amount: 30, total: 269 }),
      { ...ctx, taxRateBp: 2500 },
    );
    const sum = payload.order_lines.reduce((s, l) => s + l.total_tax_amount, 0);
    expect(payload.order_tax_amount).toBe(sum);
    // Totals are tax inclusive: the amount never moves.
    expect(payload.order_amount).toBe(26900);
    expect(payload.order_tax_amount).toBe(5380);
  });

  it('275 kr at 25 % includes 55 kr of VAT (27500 → 5500 minor)', () => {
    const lines = buildKustomOrderLines(
      order({
        items: [
          {
            id: 'item-1',
            quantity: 1,
            unit_price: 275,
            total_price: 275,
            product: { translations: [{ locale: 'sv', title: 'Väska' }] },
          },
        ],
        shipping_cost: 0,
        discount_amount: 0,
        total: 275,
      }),
      'sv',
      { taxRateBp: 2500 },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].total_amount).toBe(27500);
    expect(lines[0].total_tax_amount).toBe(5500);
    expect(sumKustomTax(lines)).toBe(5500);
  });

  it('sends tax-free lines when the rate is zero', () => {
    const lines = buildKustomOrderLines(order(), 'sv');
    expect(
      lines.every((l) => l.tax_rate === 0 && l.total_tax_amount === 0),
    ).toBe(true);
  });
});

describe('buildKustomShippingOptions', () => {
  it('prices each quote with tax and preselects the chosen one', () => {
    const options = buildKustomShippingOptions(
      [
        {
          id: 'standard',
          name: 'Standardfrakt',
          type: 'delivery',
          cost: 49,
          estimated_days: { min: 2, max: 5 },
        },
        { id: 'pickup', name: 'Hämta i butik', type: 'pickup', cost: 0 },
      ],
      'SEK',
      2500,
      'pickup',
    );
    expect(options).toEqual([
      {
        id: 'standard',
        name: 'Standardfrakt',
        description: '2–5 days',
        price: 4900,
        tax_rate: 2500,
        tax_amount: 980,
        preselected: false,
        shipping_method: 'Home',
      },
      {
        id: 'pickup',
        name: 'Hämta i butik',
        price: 0,
        tax_rate: 2500,
        tax_amount: 0,
        preselected: true,
        shipping_method: 'PickUpStore',
      },
    ]);
  });

  it('offers delivery + pickup methods with their own description and kind', () => {
    // Two ShippingMethod rows quoted for one zone: a paid home delivery and
    // a free in-store pickup whose description is the localized pickup text
    // rather than an estimated-days range. Nothing selected yet → the first
    // method is preselected.
    const options = buildKustomShippingOptions(
      [
        {
          id: 'm-delivery',
          name: 'Standard shipping',
          type: 'delivery',
          cost: 59,
          estimated_days: { min: 3, max: 3 },
        },
        {
          id: 'm-pickup',
          name: 'Pick up in store',
          type: 'pickup',
          description: 'Pick up in store',
          cost: 0,
          estimated_days: { min: 0, max: 1 },
        },
      ],
      'SEK',
      2500,
      null,
    );
    expect(options).toEqual([
      {
        id: 'm-delivery',
        name: 'Standard shipping',
        description: '3 days',
        price: 5900,
        tax_rate: 2500,
        tax_amount: 1180,
        preselected: true,
        shipping_method: 'Home',
      },
      {
        id: 'm-pickup',
        name: 'Pick up in store',
        description: 'Pick up in store',
        price: 0,
        tax_rate: 2500,
        tax_amount: 0,
        preselected: false,
        shipping_method: 'PickUpStore',
      },
    ]);
    expect(options.filter((o) => o.preselected)).toHaveLength(1);
  });

  it('falls back to the first option when the selected id is gone', () => {
    const options = buildKustomShippingOptions(
      [{ id: 'standard', name: 'Standard', type: 'delivery', cost: 10 }],
      'SEK',
      0,
      'express',
    );
    expect(options[0].preselected).toBe(true);
  });
});

describe('buildKustomSessionPayload', () => {
  const sessionCtx = {
    storeSlug: 'my-shop',
    primaryLocale: 'sv',
    storefrontBase: 'https://shop.example.com/',
    apiBase: 'https://api.example.com/',
    sessionId: 'sess-1',
    token: 'tok',
    callbackToken: 'cb-secret',
    taxRateBp: 2500,
  };
  const input = {
    currency: 'SEK',
    shipping_cost: 49,
    discount_amount: 0,
    total: 299,
    items: order().items,
    purchaseCountry: 'se',
    reference: 'sess-1',
    email: 'anna@example.com',
    shippingOptions: [
      {
        id: 'standard',
        name: 'Standardfrakt',
        type: 'delivery' as const,
        cost: 49,
        estimated_days: { min: 2, max: 5 },
      },
    ],
    selectedShippingId: 'standard',
  };

  it('keys the callbacks by the callback token, the confirmation by the storefront token, and mirrors the option as a line', () => {
    const payload = buildKustomSessionPayload(input, sessionCtx);
    expect(payload.merchant_reference1).toBe('sess-1');
    expect(payload.purchase_country).toBe('SE');
    expect(payload.order_amount).toBe(29900);
    expect(payload.order_tax_amount).toBe(
      payload.order_lines.reduce((s, l) => s + l.total_tax_amount, 0),
    );
    expect(payload.shipping_options?.[0]).toMatchObject({
      id: 'standard',
      price: 4900,
      preselected: true,
    });
    const shippingLine = payload.order_lines.find(
      (l) => l.type === 'shipping_fee',
    );
    expect(shippingLine?.name).toBe('Standardfrakt');
    expect(shippingLine?.total_amount).toBe(4900);
    expect(payload.billing_address).toEqual({
      email: 'anna@example.com',
      country: 'SE',
    });
    expect(payload.merchant_urls).toEqual({
      terms: 'https://shop.example.com/store/my-shop/legal/terms',
      checkout:
        'https://shop.example.com/store/my-shop/checkout?kustom_session=sess-1',
      confirmation:
        'https://shop.example.com/store/my-shop/checkout/kustom/confirmation?session=sess-1&token=tok&kustom_order_id={checkout.order.id}',
      push: 'https://api.example.com/api/payments/kustom/checkout/push?session_id=sess-1&token=cb-secret&kustom_order_id={checkout.order.id}',
      validation:
        'https://api.example.com/api/payments/kustom/checkout/validation?session_id=sess-1&token=cb-secret',
      address_update:
        'https://api.example.com/api/payments/kustom/checkout/address-update?session_id=sess-1&token=cb-secret',
      shipping_option_update:
        'https://api.example.com/api/payments/kustom/checkout/shipping-option-update?session_id=sess-1&token=cb-secret',
    });
    // The storefront token must never reach a server-side callback URL.
    for (const key of [
      'push',
      'validation',
      'address_update',
      'shipping_option_update',
    ] as const) {
      expect(payload.merchant_urls[key]).not.toContain('token=tok');
    }
  });

  it('omits shipping options (and the shipping line) until a destination is known', () => {
    const payload = buildKustomSessionPayload(
      { ...input, shipping_cost: 0, total: 250, shippingOptions: [] },
      sessionCtx,
    );
    expect(payload.shipping_options).toBeUndefined();
    expect(payload.order_lines.some((l) => l.type === 'shipping_fee')).toBe(
      false,
    );
    expect(payload.order_amount).toBe(25000);
  });
});
