import { MarketPricingService } from './market-pricing.service';
import type { MarketContext } from './market-context';
import type { ProductMarketRows } from './market-pricing.service';

// priceProduct: list/detail prices of one product in a market (SEK base,
// EUR market at 0.087 with a .99 ending).

const eu: MarketContext = {
  id: 'm-eu',
  key: 'eu',
  name: 'EU',
  countries: ['DE', 'FR'],
  defaultLocale: 'en',
  locales: ['sv'],
  currency: 'EUR',
  storeCurrency: 'SEK',
  rate: 0.087,
  priceRule: {
    mode: 'convert',
    source: 'manual',
    rate: 0.087,
    rounding: { ending: '.99' },
  },
  isDefault: false,
  indexing: 'AUTO',
  status: 'LIVE',
  primaryHostname: 'namez.shop',
  hostnames: ['namez.shop'],
};

const service = new MarketPricingService({} as never);

const rows = (product: ProductMarketRows['product']): ProductMarketRows => ({
  product,
  variants: new Map(),
});

describe('MarketPricingService.priceProduct', () => {
  it('converts base and compare-at prices with the rounding rule', () => {
    const out = service.priceProduct(
      eu,
      { id: 'p', base_price: 299, compare_at_price: 399, variants: [] },
      undefined,
    );
    expect(out.hidden).toBe(false);
    expect(out.base_price).toBe(25.99);
    expect(out.compare_at_price).toBe(34.99);
  });

  it('shows a compare-at override even when the base product has none', () => {
    const out = service.priceProduct(
      eu,
      { id: 'p', base_price: 299, compare_at_price: null, variants: [] },
      rows({ price: 24.9, compare_at_price: 29.9, available: true }),
    );
    expect(out.base_price).toBe(24.9);
    expect(out.compare_at_price).toBe(29.9);
  });

  it('shows no compare-at without a base value or an override', () => {
    const out = service.priceProduct(
      eu,
      { id: 'p', base_price: 299, compare_at_price: null, variants: [] },
      rows({ price: 24.9, compare_at_price: null, available: true }),
    );
    expect(out.compare_at_price).toBeUndefined();
  });

  it('hides a product switched off in the market', () => {
    const out = service.priceProduct(
      eu,
      { id: 'p', base_price: 299, variants: [] },
      rows({ price: null, compare_at_price: null, available: false }),
    );
    expect(out.hidden).toBe(true);
  });
});

describe('MarketPricingService money conversion', () => {
  it('converts base amounts (shipping, thresholds) and back', () => {
    expect(service.convertMoney(eu, 400)).toBe(34.8);
    expect(service.toBaseMoney(eu, 34.8)).toBe(400);
  });

  it('refuses to convert without a rate', () => {
    expect(() => service.convertMoney({ ...eu, rate: null }, 69)).toThrow();
  });
});
