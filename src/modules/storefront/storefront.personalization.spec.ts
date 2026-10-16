import { StoreType } from '@prisma/client';
import { StorefrontService } from './storefront.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { TaxService } from '../taxes/tax.service';
import { PersonalizationService } from '../personalization/personalization.service';
import { ShippingService } from '../shipping/shipping.service';
import {
  C_COLOR,
  C_NAME,
  F_NAME,
  F_REP,
  OPTION_CONFIG,
  appFields,
  plainFields,
  plainFieldsM40,
} from '../personalization/__fixtures__/app-fields';

// M4.1 storefront shaping (D10, C36): with the app off — or on, for a
// product without M4.1 config — GET product is the M4.0 payload; with the
// app on it carries the field tree, the card config and the
// `personalization` block (threshold in the request currency).

function build(opts: {
  fields: unknown[];
  optionConfig?: unknown;
  appOn: boolean;
  withService?: boolean;
}) {
  const store = {
    id: 's1',
    slug: 'namez',
    creator_id: 'c1',
    store_type: StoreType.INDEPENDENT,
    currency: 'SEK',
    tax_country: 'SE',
    creator: { id: 'c1' },
  };
  const product = {
    id: 'p1',
    creator_id: 'c1',
    provider_id: null,
    base_price: 299,
    compare_at_price: null,
    variant_option_config: opts.optionConfig ?? null,
    tax_class_id: null,
    tax_exempt: false,
    translations: [],
    images: [],
    attributes: [],
    variants: [],
    tags: [],
    category: null,
    creator_categories: [],
    custom_fields: opts.fields,
    faqs: [],
    shipping_profile: null,
  };
  const prisma = {
    store: { findUnique: jest.fn(() => Promise.resolve(store)) },
    product: { findFirst: jest.fn(() => Promise.resolve(product)) },
    promotion: { findMany: jest.fn(() => Promise.resolve([])) },
    bundle: { findMany: jest.fn(() => Promise.resolve([])) },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'EUR' })),
    },
  };
  const storeApps = {
    isEnabled: jest.fn((_s: string, key: string) =>
      Promise.resolve(key === 'personalization' ? opts.appOn : false),
    ),
    getSettings: jest.fn(() => Promise.resolve({})),
  };
  const shipping = { freeThresholdFor: jest.fn(() => Promise.resolve(499)) };
  const personalization = new PersonalizationService(
    prisma as unknown as PrismaService,
    storeApps as unknown as StoreAppsService,
    undefined,
    shipping as unknown as ShippingService,
  );
  const service = new StorefrontService(
    prisma as unknown as PrismaService,
    storeApps as unknown as StoreAppsService,
    {
      resolve: jest.fn(() => Promise.resolve(null)),
    } as unknown as MarketsContextService,
    {} as MarketPricingService,
    {} as TaxService,
    opts.withService === false ? undefined : personalization,
  );
  return { service, storeApps, shipping };
}

const get = (service: StorefrontService) =>
  service.getProduct('namez', 'produkt', 'sv') as Promise<
    Record<string, unknown>
  >;

describe('StorefrontService.getProduct personalization (M4.1)', () => {
  it('product without M4.1 config: the M4.0 rows (new null columns removed), no app query', async () => {
    for (const appOn of [false, true]) {
      const { service, storeApps } = build({ fields: plainFields(), appOn });
      const payload = await get(service);
      // Byte-identical to the pre-M4.1 rows (keys and order).
      expect(JSON.stringify(payload.custom_fields)).toBe(
        JSON.stringify(plainFieldsM40()),
      );
      expect(payload).not.toHaveProperty('personalization');
      expect(payload.variant_option_config).toBeNull();
      expect(storeApps.isEnabled).not.toHaveBeenCalledWith(
        's1',
        'personalization',
      );
    }
  });

  it('without the runtime service the payload is the same M4.0 one', async () => {
    const { service } = build({
      fields: plainFields(),
      appOn: true,
      withService: false,
    });
    const payload = await get(service);
    expect(JSON.stringify(payload.custom_fields)).toBe(
      JSON.stringify(plainFieldsM40()),
    );
  });

  it('app off with stored M4.1 config: app rows dropped, columns stripped, cards shown as text', async () => {
    const { service } = build({
      fields: appFields(),
      optionConfig: OPTION_CONFIG,
      appOn: false,
    });
    const payload = await get(service);
    const fields = payload.custom_fields as Record<string, unknown>[];
    expect(fields.map((f) => f.id)).toEqual([F_NAME]);
    for (const k of ['parent_id', 'ui', 'preset_key', 'children']) {
      expect(fields[0]).not.toHaveProperty(k);
    }
    const tr = (fields[0].translations as Record<string, unknown>[])[0];
    expect(tr).not.toHaveProperty('display_label');
    expect(tr).not.toHaveProperty('messages');
    const config = payload.variant_option_config as Record<string, unknown>[];
    expect(config[0]).toEqual({
      name: 'Välj antal',
      style: 'text',
      values: ['1 produkt', '2 produkter', '3 produkter'],
    });
    expect(config[1]).toEqual(OPTION_CONFIG[1]);
    expect(payload).not.toHaveProperty('personalization');
  });

  it('app on: field tree, card config and the personalization block', async () => {
    const { service, shipping } = build({
      fields: appFields(),
      optionConfig: OPTION_CONFIG,
      appOn: true,
    });
    const payload = await get(service);
    const fields = payload.custom_fields as Record<string, unknown>[];
    expect(fields.map((f) => f.id)).toEqual([F_NAME, F_REP]);
    expect(fields[0].children).toEqual([]);
    expect(
      (fields[1].children as Record<string, unknown>[]).map((c) => c.id),
    ).toEqual([C_COLOR, C_NAME]);
    // Contract keys kept; importer bookkeeping not exposed.
    expect(fields[1]).toMatchObject({
      parent_id: null,
      conditions: null,
      pricing: { mode: 'per_item', amount: 25 },
      repeat: expect.objectContaining({ start_index: 2 }) as unknown,
      ui: expect.any(Object) as unknown,
    });
    expect(fields[1]).not.toHaveProperty('preset_ref');
    expect(fields[1]).not.toHaveProperty('preset_key');
    const tr = (fields[0].translations as Record<string, unknown>[])[0];
    expect(tr).toMatchObject({ display_label: 'Namn' });
    expect(payload.variant_option_config).toEqual(OPTION_CONFIG);
    expect(payload.personalization).toEqual({
      enabled: true,
      free_shipping_threshold: 499,
      currency: 'SEK',
    });
    expect(shipping.freeThresholdFor).toHaveBeenCalledWith('p1', 'SE');
  });

  it('app on, cards only (no M4.1 fields): block present, plain fields keep the contract keys', async () => {
    const { service } = build({
      fields: plainFields(),
      optionConfig: OPTION_CONFIG,
      appOn: true,
    });
    const payload = await get(service);
    expect(payload.personalization).toMatchObject({ enabled: true });
    expect(
      (payload.custom_fields as Record<string, unknown>[])[0],
    ).toMatchObject({
      id: expect.any(String) as unknown,
      parent_id: null,
      children: [],
    });
  });
});
