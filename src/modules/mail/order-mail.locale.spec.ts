import { customerEmailLocale } from './order-mail.helpers';

// Markets app: a customer order email follows the storefront locale the
// order was placed in (namez.shop → en); orders without a market keep the
// store's primary locale (undefined = no override).

describe('customerEmailLocale', () => {
  it('is undefined without a market (today behaviour)', () => {
    expect(
      customerEmailLocale({ market_id: null, locale: 'en' }),
    ).toBeUndefined();
    expect(customerEmailLocale({ locale: 'en' })).toBeUndefined();
  });

  it("uses the market order's locale", () => {
    expect(customerEmailLocale({ market_id: 'm-eu', locale: 'en' })).toBe('en');
    expect(customerEmailLocale({ market_id: 'm-eu', locale: 'sv-SE' })).toBe(
      'sv',
    );
  });

  it('ignores a missing or unsupported locale', () => {
    expect(
      customerEmailLocale({ market_id: 'm-eu', locale: null }),
    ).toBeUndefined();
    expect(
      customerEmailLocale({ market_id: 'm-eu', locale: 'xx' }),
    ).toBeUndefined();
  });
});

describe('customerEmailLocale bounded by the market locales', () => {
  const marketLocales = { default_locale: 'en', locales: ['sv', 'ar'] };

  it('honours an order locale the market serves', () => {
    expect(
      customerEmailLocale({ market_id: 'm-eu', locale: 'sv', marketLocales }),
    ).toBe('sv');
  });

  it("falls back to the market's default locale for one it does not serve", () => {
    expect(
      customerEmailLocale({ market_id: 'm-eu', locale: 'de', marketLocales }),
    ).toBe('en');
    expect(
      customerEmailLocale({ market_id: 'm-eu', locale: null, marketLocales }),
    ).toBe('en');
  });

  it('is undefined when the market default is not a supported locale', () => {
    expect(
      customerEmailLocale({
        market_id: 'm-eu',
        locale: 'de',
        marketLocales: { default_locale: 'xx', locales: [] },
      }),
    ).toBeUndefined();
  });
});
