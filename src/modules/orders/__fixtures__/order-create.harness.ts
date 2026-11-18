import { ConfigService } from '@nestjs/config';
import { PricingType, StoreType } from '@prisma/client';
import { OrdersService } from '../orders.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { personalizationCoreArgs } from '../../personalization/__fixtures__/personalization-service.factory';
import { PromotionsService } from '../../promotions/promotions.service';
import { ShippingService } from '../../shipping/shipping.service';
import { MailService } from '../../mail/mail.service';
import { TaxService } from '../../taxes/tax.service';
import { MarketsContextService } from '../../markets/markets-context.service';
import { MarketPricingService } from '../../markets/market-pricing.service';
import { B2bService } from '../../b2b/b2b.service';
import { StoreAppsService } from '../../store-apps/store-apps.service';
import { RevalidationService } from '../../../common/revalidation/revalidation.service';

/**
 * OrdersService.create() on an in-memory catalogue (specs only). The double
 * keeps the stock counts, so the conditional decrement, the restore and the
 * read after the commit all see the same rows. Products, variants and
 * custom products (imports of a provider product) are given per id.
 */

export const HARNESS_STORE_ID = 's1';
export const HARNESS_CREATOR_ID = 'c1';

export type HarnessProduct = {
  creator_id: string | null;
  provider_id: string | null;
  base_price?: number;
  status?: string;
  /** Tracked when true and stock_quantity is not null. */
  track_inventory: boolean;
  stock_quantity: number | null;
};

export type HarnessVariant = {
  product_id: string;
  stock_quantity: number | null;
  price_adjustment?: number;
  options?: Record<string, string>;
};

export type HarnessCustomProduct = {
  product_id: string;
  creator_id?: string;
  pricing_type?: PricingType;
  final_price?: number;
  status?: string;
};

export type HarnessLine = {
  product_id: string | null;
  variant_id: string | null;
  custom_product_id?: string | null;
  quantity: number;
};

type StockWrite = {
  where: {
    id: string;
    track_inventory?: boolean;
    stock_quantity?: { gte?: number };
  };
  data: { stock_quantity: { decrement?: number; increment?: number } };
};

export function buildOrderCreate(opts: {
  products?: Record<string, HarnessProduct>;
  variants?: Record<string, HarnessVariant>;
  customProducts?: Record<string, HarnessCustomProduct>;
  /** ConfigService values by key (anything else: the storefront URL). */
  config?: Record<string, string | undefined>;
  revalidation?: Pick<RevalidationService, 'revalidateStoresOfProduct'>;
  storeType?: StoreType;
  /** The store the order is placed in (default s1 of creator c1). */
  store?: { id: string; creator_id: string; slug: string };
}) {
  const store = opts.store ?? {
    id: HARNESS_STORE_ID,
    creator_id: HARNESS_CREATOR_ID,
    slug: 'shop-a',
  };
  const products = new Map(Object.entries(opts.products ?? {}));
  const variants = new Map(Object.entries(opts.variants ?? {}));
  const customProducts = new Map(Object.entries(opts.customProducts ?? {}));
  const productRow = (id: string) => {
    const p = products.get(id);
    if (!p) return null;
    return {
      id,
      creator_id: p.creator_id,
      provider_id: p.provider_id,
      status: p.status ?? 'PUBLISHED',
      base_price: p.base_price ?? 100,
      compare_at_price: null,
      tax_class_id: null,
      tax_exempt: false,
      track_inventory: p.track_inventory,
      stock_quantity: p.stock_quantity,
      variant_option_config: null,
    };
  };
  const variantRow = (id: string) => {
    const v = variants.get(id);
    if (!v) return null;
    return {
      id,
      product_id: v.product_id,
      is_active: true,
      price_adjustment: v.price_adjustment ?? 0,
      options: v.options ?? { size: 'M' },
      stock_quantity: v.stock_quantity,
      product: productRow(v.product_id),
    };
  };
  const owner = (id: string) => {
    const p = products.get(id);
    return {
      id,
      creator_id: p?.creator_id ?? null,
      provider_id: p?.provider_id ?? null,
    };
  };
  const tracked = (p: HarnessProduct | undefined) =>
    !!p && p.track_inventory && p.stock_quantity !== null;

  const prisma = {
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: store.id,
          slug: store.slug,
          store_type: opts.storeType ?? StoreType.MARKETPLACE,
          creator_id: store.creator_id,
          currency: 'SEK',
          cod_enabled: true,
          is_active: true,
          language_config: { primary_locale: 'sv' },
          creator: {
            kustom_enabled: false,
            kustom_merchant_id: null,
            kustom_shared_secret: null,
          },
        }),
      ),
    },
    product: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(productRow(where.id)),
      ),
      updateMany: jest.fn(({ where, data }: StockWrite) => {
        const p = products.get(where.id);
        if (!p || p.stock_quantity === null)
          return Promise.resolve({ count: 0 });
        if (where.track_inventory === true && !p.track_inventory) {
          return Promise.resolve({ count: 0 });
        }
        const gte = where.stock_quantity?.gte;
        if (gte !== undefined && p.stock_quantity < gte) {
          return Promise.resolve({ count: 0 });
        }
        p.stock_quantity +=
          (data.stock_quantity.increment ?? 0) -
          (data.stock_quantity.decrement ?? 0);
        return Promise.resolve({ count: 1 });
      }),
      update: jest.fn(({ where, data }: StockWrite) => {
        const p = products.get(where.id);
        if (p) {
          p.stock_quantity =
            (p.stock_quantity ?? 0) + (data.stock_quantity.increment ?? 0);
        }
        return Promise.resolve({});
      }),
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in
            .filter((id) => products.has(id))
            .map((id) => {
              const p = products.get(id);
              return {
                ...owner(id),
                track_inventory: tracked(p),
                stock_quantity: p?.stock_quantity ?? null,
              };
            }),
        ),
      ),
    },
    productVariant: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(variantRow(where.id)),
      ),
      updateMany: jest.fn(({ where, data }: StockWrite) => {
        const v = variants.get(where.id);
        if (!v || v.stock_quantity === null)
          return Promise.resolve({ count: 0 });
        const gte = where.stock_quantity?.gte;
        if (gte !== undefined && v.stock_quantity < gte) {
          return Promise.resolve({ count: 0 });
        }
        v.stock_quantity +=
          (data.stock_quantity.increment ?? 0) -
          (data.stock_quantity.decrement ?? 0);
        return Promise.resolve({ count: 1 });
      }),
      update: jest.fn(({ where, data }: StockWrite) => {
        const v = variants.get(where.id);
        if (v) {
          v.stock_quantity =
            (v.stock_quantity ?? 0) + (data.stock_quantity.increment ?? 0);
        }
        return Promise.resolve({});
      }),
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in
            .filter((id) => variants.has(id))
            .map((id) => ({
              id,
              stock_quantity: variants.get(id)?.stock_quantity ?? null,
              product: owner(variants.get(id)?.product_id ?? ''),
            })),
        ),
      ),
    },
    customProduct: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) => {
        const cp = customProducts.get(where.id);
        if (!cp) return Promise.resolve(null);
        return Promise.resolve({
          id: where.id,
          product_id: cp.product_id,
          creator_id: cp.creator_id ?? store.creator_id,
          status: cp.status ?? 'PUBLISHED',
          pricing_type: cp.pricing_type ?? PricingType.SINGLE,
          final_price: cp.final_price ?? 150,
          margin_amount: null,
          product: productRow(cp.product_id),
          selected_variants: [],
        });
      }),
      // PersonalizationCoreService.loadContexts.
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          where.id.in
            .filter((id) => customProducts.has(id))
            .map((id) => ({
              id,
              product_id: customProducts.get(id)?.product_id,
              field_values: [],
            })),
        ),
      ),
    },
    productMarketPrice: { findMany: jest.fn(() => Promise.resolve([])) },
    platformConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve({ default_currency: 'EUR', commission_value: 15 }),
      ),
    },
    customer: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'cust1', user_id: 'u1' }),
      ),
    },
    address: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'a1',
          country_code: 'SE',
          state: null,
          postal_code: '11123',
        }),
      ),
    },
    order: {
      create: jest.fn(
        ({
          data,
        }: {
          data: Record<string, unknown> & { items: { create: unknown[] } };
        }): Promise<unknown> =>
          Promise.resolve({
            id: 'o1',
            ...data,
            items: data.items.create,
            timeline: [],
            address: {},
          }),
      ),
    },
    orderCommission: { create: jest.fn(() => Promise.resolve({})) },
    productCustomField: { findMany: jest.fn(() => Promise.resolve([])) },
  };
  const shipping = {
    quoteForItems: jest.fn(() =>
      Promise.resolve({
        available: true,
        methods: [
          {
            id: 'std',
            name: 'Standard',
            type: 'STANDARD',
            cost: 49,
            estimated_days: { min: 2, max: 5 },
            free_shipping: false,
          },
        ],
      }),
    ),
  };
  const tax = {
    contextFor: jest.fn(() => Promise.resolve({ pricingMode: 'INCLUSIVE' })),
    loadTaxData: jest.fn(() => Promise.resolve({})),
    computeTaxes: jest.fn(
      (input: {
        lines: { amount: number }[];
        shipping_cost: number;
        discount_amount: number;
      }) => {
        const total =
          input.lines.reduce((s, l) => s + l.amount, 0) +
          input.shipping_cost -
          input.discount_amount;
        return {
          items: input.lines.map(() => ({
            tax_rate_bp: 2500,
            tax_amount: 0,
            tax_class_key: 'standard',
          })),
          headline_rate_bp: 2500,
          tax_total: 0,
          tax_lines: [],
          tax_pricing_mode: 'INCLUSIVE',
          tax_basis_country: 'SE',
          shipping_tax_amount: 0,
          shipping_tax_rate_bp: 2500,
          total,
          display_mode: 'incl',
          net_items: total,
          net_shipping: 0,
          net_total: total,
        };
      },
    ),
  };
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(false)),
    getSettings: jest.fn(() => Promise.resolve(null)),
  };
  const mail = { dispatchOrderEmail: jest.fn(() => Promise.resolve()) };
  const configValues = opts.config ?? {};
  const config = {
    get: jest.fn((key: string) =>
      key in configValues ? configValues[key] : 'https://stores.platform.test',
    ),
  };
  const service = new OrdersService(
    prisma as unknown as PrismaService,
    { validateCoupon: jest.fn() } as unknown as PromotionsService,
    shipping as unknown as ShippingService,
    mail as unknown as MailService,
    tax as unknown as TaxService,
    {
      resolve: jest.fn(() => Promise.resolve(null)),
    } as unknown as MarketsContextService,
    new MarketPricingService(prisma as unknown as PrismaService),
    config as unknown as ConfigService,
    new B2bService(storeApps as unknown as StoreAppsService),
    ...personalizationCoreArgs(prisma),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    opts.revalidation as unknown as RevalidationService | undefined,
  );
  const place = (lines: HarnessLine[]) =>
    service.create(
      'u1',
      {
        address_id: 'a1',
        store_id: store.id,
        payment_method: 'STRIPE',
      } as never,
      { lines } as never,
    );
  const quote = (lines: HarnessLine[]) =>
    service.quoteLines(store.id, lines as never, {
      countryCode: 'SE',
    });
  return { service, prisma, place, quote, products, variants, config };
}
