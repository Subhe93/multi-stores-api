import { CartService } from './cart.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TaxService } from '../taxes/tax.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { B2bService } from '../b2b/b2b.service';
import { buildPersonalizationCore } from '../personalization/__fixtures__/personalization-service.factory';

// M160: cart line titles in the request locale, with a base-language step
// (de-AT -> de) and the STORE canonical language before English.

type Row = {
  id: string;
  cart_id: string;
  product_id: string | null;
  variant_id: string | null;
  custom_product_id: string | null;
  bundle_offer_id: string | null;
  quantity: number;
  custom_fields: unknown;
};

function build(translations: { locale: string; title: string }[]) {
  const product = {
    id: 'p1',
    creator_id: 'c1',
    base_price: 100,
    variant_option_config: null,
    max_per_order: null,
    translations,
    images: [],
    custom_fields: [],
  };
  const prisma = {
    product: { findUnique: jest.fn(() => Promise.resolve(product)) },
    productImage: { findFirst: jest.fn(() => Promise.resolve(null)) },
    productVariant: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    customProduct: { findUnique: jest.fn(() => Promise.resolve(null)) },
    productMarketPrice: { findMany: jest.fn(() => Promise.resolve([])) },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'SEK' })),
    },
    bundleOffer: { findUnique: jest.fn(() => Promise.resolve(null)) },
  };
  const service = new CartService(
    prisma as unknown as PrismaService,
    {} as TaxService,
    {} as MarketsContextService,
    new MarketPricingService(prisma as unknown as PrismaService),
    {} as B2bService,
    buildPersonalizationCore(prisma).core,
  );
  const internals = service as unknown as {
    enrichCartItems: (
      items: Row[],
      locale?: string,
      market?: null,
      canonicalLocale?: string | null,
    ) => Promise<{ title: string | null }[]>;
  };
  return { internals };
}

const line: Row = {
  id: 'r1',
  cart_id: 'cart1',
  product_id: 'p1',
  variant_id: null,
  custom_product_id: null,
  bundle_offer_id: null,
  quantity: 1,
  custom_fields: null,
};

describe('CartService.enrichCartItems title locale (M160)', () => {
  it('the exact locale wins', async () => {
    const { internals } = build([
      { locale: 'en', title: 'Horse' },
      { locale: 'sv', title: 'Häst' },
      { locale: 'de', title: 'Pferd' },
    ]);
    const [item] = await internals.enrichCartItems([line], 'de', null, 'sv');
    expect(item.title).toBe('Pferd');
  });

  it('a regional locale uses its base language row', async () => {
    const { internals } = build([
      { locale: 'en', title: 'Horse' },
      { locale: 'sv', title: 'Häst' },
      { locale: 'de', title: 'Pferd' },
    ]);
    const [item] = await internals.enrichCartItems([line], 'de-AT', null, 'sv');
    expect(item.title).toBe('Pferd');
  });

  it('a missing locale falls back to the store canonical row, not en', async () => {
    const { internals } = build([
      { locale: 'en', title: 'Horse' },
      { locale: 'sv', title: 'Häst' },
    ]);
    const [item] = await internals.enrichCartItems([line], 'de', null, 'sv');
    expect(item.title).toBe('Häst');
  });

  it('without a canonical locale the chain ends at en', async () => {
    const { internals } = build([
      { locale: 'sv', title: 'Häst' },
      { locale: 'en', title: 'Horse' },
    ]);
    const [item] = await internals.enrichCartItems([line], 'de');
    expect(item.title).toBe('Horse');
  });
});
