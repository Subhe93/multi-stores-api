import { StoreType } from '@prisma/client';
import { buildOrderCreate } from './__fixtures__/order-create.harness';
import type { MarketContext } from '../markets/market-context';
import type { MarketPaymentMethod } from '../markets/market.types';

// M157: orders.create refuses a payment method the request market excludes,
// before any stock or coupon work. It is the single entry for cart orders,
// guest orders (GuestOrderService -> create) and the Kustom session order
// (KustomCheckoutService.handleValidation -> create). Without the setting
// (or with the app off) every method behaves as before.

type Method = 'STRIPE' | 'COD' | 'KUSTOM';

function sek(paymentMethods: MarketPaymentMethod[] | null | undefined) {
  const ctx: MarketContext = {
    id: 'm-default',
    key: 'default',
    name: 'Sweden',
    countries: ['SE'],
    defaultLocale: 'sv',
    locales: [],
    currency: 'SEK',
    storeCurrency: 'SEK',
    rate: 1,
    priceRule: { mode: 'convert', source: 'manual', rate: 1 },
    isDefault: true,
    status: 'LIVE',
    indexing: 'AUTO',
    primaryHostname: null,
    hostnames: [],
    ...(paymentMethods !== undefined ? { paymentMethods } : {}),
  };
  return ctx;
}

const catalogue = () => ({
  products: {
    p1: {
      creator_id: 'c1',
      provider_id: null,
      track_inventory: true,
      stock_quantity: 5,
    },
  },
});

function place(market: MarketContext | null, method: Method) {
  const h = buildOrderCreate({
    ...catalogue(),
    storeType: StoreType.INDEPENDENT,
    kustomReady: true,
    market,
  });
  const run = h.service.create(
    'u1',
    { address_id: 'a1', store_id: 's1', payment_method: method } as never,
    {
      lines: [{ product_id: 'p1', variant_id: null, quantity: 1 }],
    } as never,
  );
  return { h, run };
}

const METHOD_OF: Record<Method, MarketPaymentMethod> = {
  STRIPE: 'card',
  COD: 'cod',
  KUSTOM: 'kustom',
};

describe('orders.create per market payment methods (M157)', () => {
  const methods: Method[] = ['STRIPE', 'COD', 'KUSTOM'];

  it.each(methods)(
    '%s excluded by the market -> 400 before any stock decrement',
    async (method) => {
      const allowed = (['card', 'kustom', 'cod'] as const).filter(
        (m) => m !== METHOD_OF[method],
      );
      const { h, run } = place(sek([...allowed]), method);
      await expect(run).rejects.toMatchObject({
        response: {
          code: 'MARKET_PAYMENT_METHOD_NOT_ALLOWED',
          method: METHOD_OF[method],
        },
      });
      expect(h.products.get('p1')?.stock_quantity).toBe(5);
      expect(h.prisma.product.updateMany).not.toHaveBeenCalled();
      expect(h.prisma.order.create).not.toHaveBeenCalled();
    },
  );

  it.each(methods)(
    '%s allowed by the market -> order placed',
    async (method) => {
      const { h, run } = place(sek([METHOD_OF[method]]), method);
      await expect(run).resolves.toBeDefined();
      expect(h.products.get('p1')?.stock_quantity).toBe(4);
    },
  );

  it.each(methods)(
    'regression: %s with an unset market / app off -> placed as before',
    async (method) => {
      for (const market of [null, sek(null), sek(undefined)]) {
        const { h, run } = place(market, method);
        await expect(run).resolves.toBeDefined();
        expect(h.products.get('p1')?.stock_quantity).toBe(4);
      }
    },
  );

  it('Namez SE (kustom only): a forged card order is refused', async () => {
    const { run } = place(sek(['kustom']), 'STRIPE');
    await expect(run).rejects.toMatchObject({
      response: { code: 'MARKET_PAYMENT_METHOD_NOT_ALLOWED', method: 'card' },
    });
  });

  it('a malformed stored setting ([]) refuses every method (fail-closed)', async () => {
    for (const method of methods) {
      const { run } = place(sek([]), method);
      await expect(run).rejects.toMatchObject({
        response: { code: 'MARKET_PAYMENT_METHOD_NOT_ALLOWED' },
      });
    }
  });

  it('the store rule still comes first: COD off stays ORDER_COD_DISABLED', async () => {
    const h = buildOrderCreate({
      ...catalogue(),
      storeType: StoreType.MARKETPLACE,
      market: sek(['cod']),
    });
    await expect(
      h.service.create(
        'u1',
        { address_id: 'a1', store_id: 's1', payment_method: 'COD' } as never,
        {
          lines: [{ product_id: 'p1', variant_id: null, quantity: 1 }],
        } as never,
      ),
    ).rejects.toMatchObject({ response: { code: 'ORDER_COD_DISABLED' } });
  });
});
