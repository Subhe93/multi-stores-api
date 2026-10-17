import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import type { MarketContext } from '../markets/market-context';
import { parsePersonalizationSettings } from './personalization-settings';
import {
  C_COLOR,
  C_NAME,
  F_NAME,
  F_REP,
  OPTION_CONFIG,
  PRODUCT_ID,
  VARIANT,
  appFields,
  validValues,
} from './__fixtures__/app-fields';
import { buildPersonalizationService } from './__fixtures__/personalization-service.factory';

// M4.1 WP-C: the runtime service — line evaluation (context, palette from
// active variants), the public validate endpoint and the card threshold.

const MARKET: MarketContext = {
  id: 'm-eu',
  key: 'eu',
  name: 'EU',
  countries: ['DE'],
  defaultLocale: 'de',
  locales: [],
  currency: 'EUR',
  storeCurrency: 'SEK',
  rate: 0.1,
  priceRule: { kind: 'convert' } as unknown as MarketContext['priceRule'],
  isDefault: false,
  status: 'LIVE',
  primaryHostname: null,
  hostnames: [],
};

function build(
  opts: {
    product?: unknown;
    variant?: unknown;
    market?: MarketContext | null;
    threshold?: number | null;
  } = {},
) {
  const prisma = {
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 's1',
          creator_id: 'c1',
          store_type: 'INDEPENDENT',
          currency: 'SEK',
          language_config: { primary_locale: 'sv' },
        }),
      ),
    },
    product: {
      findFirst: jest.fn(() =>
        Promise.resolve(
          opts.product === undefined
            ? {
                id: PRODUCT_ID,
                base_price: 299,
                variant_option_config: OPTION_CONFIG,
              }
            : opts.product,
        ),
      ),
    },
    productVariant: {
      findFirst: jest.fn(() =>
        Promise.resolve(opts.variant === undefined ? VARIANT : opts.variant),
      ),
      findMany: jest.fn(() =>
        Promise.resolve([
          { options: { 'Välj antal': '1 produkt', Färg: 'Röd' } },
          { options: { 'Välj antal': '3 produkter', Färg: 'Blå' } },
        ]),
      ),
    },
    productCustomField: {
      findMany: jest.fn(() => Promise.resolve(appFields())),
    },
    productMarketPrice: { findMany: jest.fn(() => Promise.resolve([])) },
    platformConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve({
          default_currency: 'SEK',
          platform_tax_country: 'SE',
        }),
      ),
    },
  };
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(true)),
    enabledOrUnknown: jest.fn(() => Promise.resolve(true)),
    getSettings: jest.fn(() => Promise.resolve({})),
  };
  const shipping = {
    freeThresholdFor: jest.fn(() =>
      Promise.resolve(opts.threshold === undefined ? 499 : opts.threshold),
    ),
  };
  const markets = {
    resolve: jest.fn(() => Promise.resolve(opts.market ?? null)),
  };
  const marketPricing = new MarketPricingService(
    prisma as unknown as PrismaService,
  );
  const service = buildPersonalizationService({
    prisma,
    storeApps,
    shipping,
    markets,
    marketPricing,
  });
  return { service, prisma, storeApps, shipping, markets };
}

describe('PersonalizationService (M4.1 WP-C)', () => {
  describe('validateForStorefront', () => {
    it('valid line: canonical values, per-item delta, unit price before bundle, grouped display', async () => {
      const { service } = build();
      const res = await service.validateForStorefront('s1', {
        product_id: PRODUCT_ID,
        variant_id: VARIANT.id,
        custom_fields: validValues(),
        locale: 'sv',
        market: null,
        quantity: 2,
      });
      expect(res.ok).toBe(true);
      expect(res.errors).toEqual([]);
      // Repeater per_item 25 × 2 items (2 and 3), per unit.
      expect(res.price_delta).toBe(50);
      expect(res.unit_price).toBe(549); // 299 + 200 + 50
      expect(res.currency).toBe('SEK');
      // Canonical: trimmed child text, dense repeater array.
      expect(res.custom_fields).toEqual({
        [F_NAME]: 'Kristofer',
        [F_REP]: [
          { [C_COLOR]: 'Blå', [C_NAME]: 'karin' },
          { [C_COLOR]: 'Röd', [C_NAME]: 'Olle' },
        ],
      });
      // Lead item 1 = name + variant colour (OPTION, hex), then items 2..3.
      expect(res.display).toEqual([
        {
          id: `${F_NAME}#1`,
          label: 'Namn',
          value: 'Kristofer',
          display: null,
          group_key: 'dnc_items',
          group_index: 1,
          group_label: 'Artikel 1',
          source: 'FIELD',
        },
        {
          id: 'option:Färg#1',
          label: 'Färg',
          value: 'Röd',
          display: null,
          group_key: 'dnc_items',
          group_index: 1,
          group_label: 'Artikel 1',
          hex: '#dd3333',
          source: 'OPTION',
        },
        {
          id: `${C_COLOR}#2`,
          label: 'Färg',
          value: 'Blå',
          display: null,
          group_key: 'dnc_items',
          group_index: 2,
          group_label: 'Artikel 2',
          hex: '#3333dd',
          source: 'FIELD',
        },
        expect.objectContaining({ id: `${C_NAME}#2`, value: 'karin' }),
        expect.objectContaining({ id: `${C_COLOR}#3`, value: 'Röd' }),
        expect.objectContaining({ id: `${C_NAME}#3`, value: 'Olle' }),
      ]);
    });

    it('invalid line: 200 with ok:false and contract errors (repeater child → repeater id + child + group)', async () => {
      const { service } = build();
      const res = await service.validateForStorefront('s1', {
        product_id: PRODUCT_ID,
        variant_id: VARIANT.id,
        custom_fields: {
          [F_NAME]: 'Kristofer',
          [F_REP]: [
            { [C_NAME]: 'Karin' },
            { [C_COLOR]: 'Röd', [C_NAME]: 'Olle' },
          ],
        },
        locale: 'sv',
        market: null,
        quantity: 1,
      });
      expect(res.ok).toBe(false);
      expect(res.errors).toEqual([
        {
          code: 'CUSTOM_FIELD_REQUIRED',
          field_id: F_REP,
          field_name: 'dnc_items',
          child_id: C_COLOR,
          child_name: 'color',
          group_index: 2,
          message: 'Artikel 2: Färg måste väljas',
        },
      ]);
    });

    it('palette: a colour not on an active variant is refused (olivgrön fix)', async () => {
      const { service, prisma } = build();
      prisma.productVariant.findMany.mockResolvedValueOnce([
        { options: { 'Välj antal': '3 produkter', Färg: 'Röd' } },
      ]);
      const res = await service.validateForStorefront('s1', {
        product_id: PRODUCT_ID,
        variant_id: VARIANT.id,
        custom_fields: validValues(), // item 2 is Blå
        locale: 'sv',
      });
      expect(res.ok).toBe(false);
      expect(res.errors[0]).toMatchObject({
        code: 'CUSTOM_FIELD_INVALID_OPTION',
        child_id: C_COLOR,
        group_index: 2,
      });
    });

    it('market: unit price and delta in the market currency (converted like options)', async () => {
      const { service } = build({ market: MARKET });
      const res = await service.validateForStorefront('s1', {
        product_id: PRODUCT_ID,
        variant_id: VARIANT.id,
        custom_fields: validValues(),
        locale: 'de',
        market: 'eu',
      });
      expect(res.currency).toBe('EUR');
      expect(res.price_delta).toBe(5); // 50 SEK × 0.1
      expect(res.unit_price).toBe(54.9); // 499 × 0.1 + 5
    });

    it('a product of another creator (or unpublished) is a 404', async () => {
      const { service } = build({ product: null });
      await expect(
        service.validateForStorefront('s1', {
          product_id: PRODUCT_ID,
          custom_fields: {},
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a variant that is not an active variant of the product is a 404', async () => {
      const { service } = build({ variant: null });
      await expect(
        service.validateForStorefront('s1', {
          product_id: PRODUCT_ID,
          variant_id: '00000000-0000-4000-8000-000000000000',
          custom_fields: {},
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('contextFor', () => {
    it('queries active variants only when a palette reads an option', async () => {
      const { service, prisma } = build();
      const plain = appFields().filter((f) => f.id === F_NAME);
      const ctx = await service.contextFor({
        product: { id: PRODUCT_ID, variant_option_config: OPTION_CONFIG },
        variantOptions: VARIANT.options,
        defs: plain,
        locale: 'sv',
        primaryLocale: 'sv',
      });
      expect(prisma.productVariant.findMany).not.toHaveBeenCalled();
      expect(ctx.activeOptionValues).toBeUndefined();
      const full = await service.contextFor({
        product: { id: PRODUCT_ID, variant_option_config: OPTION_CONFIG },
        variantOptions: VARIANT.options,
        defs: appFields(),
        locale: 'sv',
      });
      expect(prisma.productVariant.findMany).toHaveBeenCalledTimes(1);
      expect(full.activeOptionValues).toEqual({
        'Välj antal': ['1 produkt', '3 produkter'],
        Färg: ['Röd', 'Blå'],
      });
      expect(full.appEnabled).toBe(true);
      expect(full.primaryLocale).toBe('sv');
    });
  });

  describe('freeShippingThreshold', () => {
    const settings = (raw: unknown = {}) => parsePersonalizationSettings(raw);

    it('store tax country, base currency without a market', async () => {
      const { service, shipping } = build();
      await expect(
        service.freeShippingThreshold(
          PRODUCT_ID,
          { tax_country: 'SE' },
          null,
          settings(),
        ),
      ).resolves.toBe(499);
      expect(shipping.freeThresholdFor).toHaveBeenCalledWith(PRODUCT_ID, 'SE');
    });

    it('settings country wins; market converts to the request currency', async () => {
      const { service, shipping } = build();
      await expect(
        service.freeShippingThreshold(
          PRODUCT_ID,
          { tax_country: 'SE' },
          MARKET,
          settings({ free_shipping_country: 'no' }),
        ),
      ).resolves.toBe(49.9);
      expect(shipping.freeThresholdFor).toHaveBeenCalledWith(PRODUCT_ID, 'NO');
    });

    it('market country before the store country; platform country last', async () => {
      const { service, shipping } = build();
      await service.freeShippingThreshold(
        PRODUCT_ID,
        { tax_country: 'SE' },
        MARKET,
        settings(),
      );
      expect(shipping.freeThresholdFor).toHaveBeenLastCalledWith(
        PRODUCT_ID,
        'DE',
      );
      await service.freeShippingThreshold(
        PRODUCT_ID,
        { tax_country: null },
        null,
        settings(),
      );
      expect(shipping.freeThresholdFor).toHaveBeenLastCalledWith(
        PRODUCT_ID,
        'SE',
      );
    });

    it('null when the badge is off, no threshold exists or the market has no rate', async () => {
      const { service, shipping } = build({ threshold: null });
      await expect(
        service.freeShippingThreshold(
          PRODUCT_ID,
          { tax_country: 'SE' },
          null,
          settings({ free_shipping_badge: false }),
        ),
      ).resolves.toBeNull();
      expect(shipping.freeThresholdFor).not.toHaveBeenCalled();
      await expect(
        service.freeShippingThreshold(
          PRODUCT_ID,
          { tax_country: 'SE' },
          null,
          settings(),
        ),
      ).resolves.toBeNull();
      const withRate = build();
      await expect(
        withRate.service.freeShippingThreshold(
          PRODUCT_ID,
          { tax_country: 'SE' },
          { ...MARKET, rate: null },
          settings(),
        ),
      ).resolves.toBeNull();
    });
  });
});

describe('PersonalizationService (M4.1 fixes)', () => {
  it('freeShippingThreshold passes an already-loaded profile on', async () => {
    const { service, shipping } = build();
    const profile = { zones: [] };
    await service.freeShippingThreshold(
      PRODUCT_ID,
      { tax_country: 'SE' },
      null,
      parsePersonalizationSettings({}),
      profile as never,
    );
    expect(shipping.freeThresholdFor).toHaveBeenCalledWith(
      PRODUCT_ID,
      'SE',
      profile,
    );
  });

  it('isEnabledStrict: an unreadable app state is 503 PERSONALIZATION_UNAVAILABLE', async () => {
    const { service, storeApps } = build();
    storeApps.enabledOrUnknown.mockResolvedValue(null as never);
    await expect(service.isEnabledStrict('s1')).rejects.toMatchObject({
      status: 503,
      response: { code: 'PERSONALIZATION_UNAVAILABLE' },
    });
    storeApps.enabledOrUnknown.mockResolvedValue(false as never);
    await expect(service.isEnabledStrict('s1')).resolves.toBe(false);
  });

  it('activeVariants is one query per product per request cache', async () => {
    const { service, prisma } = build();
    const cache = new Map();
    const findMany = prisma.productVariant.findMany as jest.Mock;
    findMany.mockClear();
    await service.activeVariants(PRODUCT_ID, cache);
    await service.activeVariants(PRODUCT_ID, cache);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
