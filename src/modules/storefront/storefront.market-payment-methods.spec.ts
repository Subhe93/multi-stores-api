import { StoreStatus, StoreType } from '@prisma/client';
import { StorefrontService } from './storefront.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import type { MarketPricingService } from '../markets/market-pricing.service';
import type { TaxService } from '../taxes/tax.service';
import type { MarketContext } from '../markets/market-context';
import type { MarketPaymentMethod } from '../markets/market.types';

// M157: the storefront store payload narrows card_payments_enabled,
// kustom_enabled and cod_enabled for the request market. No new key; a
// market without the setting (and the app off) produce byte-identical JSON.

function marketCtx(
  key: string,
  paymentMethods: MarketPaymentMethod[] | null | undefined,
  currency = 'SEK',
): MarketContext {
  return {
    id: `m-${key}`,
    key,
    name: key,
    countries: [],
    defaultLocale: 'sv',
    locales: [],
    currency,
    storeCurrency: 'SEK',
    rate: 1,
    priceRule: { mode: 'convert' },
    isDefault: key === 'default',
    status: 'LIVE',
    indexing: 'AUTO',
    primaryHostname: null,
    hostnames: [],
    ...(paymentMethods !== undefined ? { paymentMethods } : {}),
  };
}

function build(
  market: MarketContext | null,
  opts: { cod?: boolean; card?: boolean; kustom?: boolean } = {},
) {
  const store = {
    id: 's1',
    slug: 'namez-se',
    name: 'Namez',
    logo_url: null,
    creator_id: 'c1',
    store_type: StoreType.INDEPENDENT,
    currency: 'SEK',
    status: StoreStatus.LIVE,
    is_active: true,
    cod_enabled: opts.cod ?? true,
    stripe_keys: null,
    theme_key: 'minimal',
    theme_customizations: {},
    theme_config: {},
    tax_pricing_mode: 'INCLUSIVE',
    tax_basis: 'SHIPPING',
    tax_country: 'SE',
    oss_registered: false,
    use_platform_tax_rates: true,
    shipping_tax_class_id: null,
    display_prices_incl_tax: true,
    clarity_project_id: null,
    consent_required: true,
    checkout_settings: null,
    language_config: {
      primary_locale: 'sv',
      secondary_locales: [],
      auto_translate: false,
      fallback_locale: 'en',
    },
    static_pages: [],
    creator: {
      id: 'c1',
      display_name: 'N',
      avatar_url: null,
      bio: null,
      cover_url: null,
      stripe_payouts_enabled: false,
      stripe_charges_enabled: opts.card ?? true,
      stripe_account_type: 'standard',
    },
  };
  const prisma = {
    store: {
      findUnique: jest.fn(() => Promise.resolve(store)),
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'EUR' })),
    },
    creator: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          (opts.kustom ?? true)
            ? {
                kustom_enabled: true,
                kustom_merchant_id: 'M1',
                kustom_shared_secret: 'enc',
              }
            : {
                kustom_enabled: false,
                kustom_merchant_id: null,
                kustom_shared_secret: null,
              },
        ),
      ),
    },
    page: {
      findMany: jest.fn(() => Promise.resolve([])),
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
    staticPage: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    menu: { findMany: jest.fn(() => Promise.resolve([])) },
    legalPage: { findMany: jest.fn(() => Promise.resolve([])) },
  };
  const markets = {
    resolve: jest.fn(() => Promise.resolve(market)),
    listLive: jest.fn(() => Promise.resolve(market ? [] : null)),
  };
  const service = new StorefrontService(
    prisma as unknown as PrismaService,
    {
      storefrontApps: jest.fn(() => Promise.resolve({})),
      isEnabled: jest.fn(() => Promise.resolve(false)),
    } as unknown as StoreAppsService,
    markets as unknown as MarketsContextService,
    {} as MarketPricingService,
    {} as TaxService,
  );
  return { service, markets };
}

type Flags = {
  card_payments_enabled: boolean;
  kustom_enabled: boolean;
  cod_enabled: boolean;
};

async function payload(
  market: MarketContext | null,
  opts?: Parameters<typeof build>[1],
  key?: string,
  preview?: boolean,
) {
  const { service } = build(market, opts);
  return (await service.getStore('namez-se', key, preview, null)) as Flags &
    Record<string, unknown>;
}

const flags = (p: Flags) => ({
  card: p.card_payments_enabled,
  kustom: p.kustom_enabled,
  cod: p.cod_enabled,
});

describe('storefront payload per market payment methods (M157)', () => {
  it('regression: unset / hand-built / app off -> byte-identical JSON (key order too)', async () => {
    const unsetDefault = await payload(marketCtx('default', null));
    const handBuilt = await payload(marketCtx('default', undefined));
    expect(JSON.stringify(unsetDefault)).toBe(JSON.stringify(handBuilt));
    expect(flags(unsetDefault)).toEqual({
      card: true,
      kustom: true,
      cod: true,
    });

    const appOffA = await payload(null);
    expect(flags(appOffA)).toEqual({ card: true, kustom: true, cod: true });
    // The app-off payload has no market keys (unchanged contract).
    expect(appOffA).not.toHaveProperty('market');
  });

  it('a setting with every method yields the same JSON as no setting', async () => {
    const unset = await payload(marketCtx('default', null));
    const all = await payload(marketCtx('default', ['card', 'kustom', 'cod']));
    expect(JSON.stringify(all)).toBe(JSON.stringify(unset));
  });

  it('no new payload key; the flags keep their position', async () => {
    const unset = await payload(marketCtx('default', null));
    const narrowed = await payload(marketCtx('default', ['kustom']));
    expect(Object.keys(narrowed)).toEqual(Object.keys(unset));
    expect(narrowed).not.toHaveProperty('payment_methods');
    expect(
      (narrowed.market as Record<string, unknown>) ?? {},
    ).not.toHaveProperty('payment_methods');
  });

  it('Namez SE (kustom only): card and COD off, Kustom on', async () => {
    const p = await payload(marketCtx('default', ['kustom']));
    expect(flags(p)).toEqual({ card: false, kustom: true, cod: false });
  });

  it('Namez eu (card only, EUR): card on, Kustom and COD off', async () => {
    const p = await payload(marketCtx('eu', ['card'], 'EUR'), {}, 'eu');
    expect(flags(p)).toEqual({ card: true, kustom: false, cod: false });
  });

  it('preview market: narrowed the same way', async () => {
    const m = { ...marketCtx('eu', ['card'], 'EUR'), preview: true as const };
    const { service, markets } = build(m);
    const p = (await service.getStore('namez-se', 'eu', true, null)) as Flags;
    expect(markets.resolve).toHaveBeenCalledWith('s1', 'eu', { preview: true });
    expect(flags(p)).toEqual({ card: true, kustom: false, cod: false });
  });

  it('only narrows: a market cannot enable a method the store lacks', async () => {
    const p = await payload(marketCtx('default', ['card', 'kustom', 'cod']), {
      card: false,
      kustom: false,
      cod: false,
    });
    expect(flags(p)).toEqual({ card: false, kustom: false, cod: false });
  });

  it('a malformed stored value ([]) turns every method off (fail-closed)', async () => {
    const p = await payload(marketCtx('default', []));
    expect(flags(p)).toEqual({ card: false, kustom: false, cod: false });
  });
});
