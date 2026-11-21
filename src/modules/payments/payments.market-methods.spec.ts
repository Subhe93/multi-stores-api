import { BadRequestException } from '@nestjs/common';
import { FulfillerType, StoreType, UserRole } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CryptoService } from '../../common/crypto/crypto.service';
import type { OrdersService } from '../orders/orders.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { MailService } from '../mail/mail.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import type { MarketContext } from '../markets/market-context';
import type { MarketPaymentMethod } from '../markets/market.types';
import type { OwnKeyApi } from './own-key/own-key.types';

// M157: GET /payments/config and create-intent honour the market's payment
// methods. Unset markets (and the app off) answer exactly as before.

type Internals = Record<string, (...args: unknown[]) => Promise<unknown>>;

const KUSTOM_READY = {
  kustom_enabled: true,
  kustom_merchant_id: 'M1',
  kustom_shared_secret: 'enc',
};

function fakeStripe(label: string) {
  return {
    label,
    paymentIntents: {
      create: jest.fn(() =>
        Promise.resolve({ id: `pi_${label}`, client_secret: `cs_${label}` }),
      ),
      cancel: jest.fn(() => Promise.resolve({ id: 'pi_1' })),
      retrieve: jest.fn(() =>
        Promise.resolve({
          id: 'pi_1',
          status: 'requires_payment_method',
          amount: 29900,
          currency: 'sek',
          client_secret: 'cs_existing',
          metadata: { order_id: 'o1' },
        }),
      ),
    },
    transfers: { create: jest.fn() },
  };
}

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
  opts: {
    market?: MarketContext | null;
    connect?: boolean;
    ownKeyActive?: boolean;
    ownPublishableKey?: string;
    order?: Record<string, unknown>;
  } = {},
) {
  const store = {
    id: 's1',
    is_active: true,
    store_type: StoreType.INDEPENDENT,
    status: 'LIVE',
    currency: 'SEK',
    creator: {
      user_id: 'owner',
      stripe_account_id: opts.connect ? 'acct_1' : null,
      stripe_account_type: opts.connect ? 'standard' : null,
      stripe_charges_enabled: Boolean(opts.connect),
      ...KUSTOM_READY,
    },
  };
  const order = {
    id: 'o1',
    order_number: 'MS-1',
    store_id: 's1',
    market_id: null as string | null,
    payment_route: 'OWN_KEY',
    stripe_account_id: null,
    stripe_payment_id: null as string | null,
    stripe_charge_id: null,
    payment_status: 'awaiting_payment',
    total: 299,
    currency: 'SEK',
    ...opts.order,
  };
  const prisma = {
    order: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          ...order,
          customer: { user_id: 'u1' },
          customer_type: 'PERSON',
          tax_exempt_reason: null,
          items: [
            {
              fulfiller_type: FulfillerType.CREATOR,
              fulfiller_id: 'c1',
              quantity: 1,
              provider_base_amount: 0,
            },
          ],
          commission: { provider_amount: 0, creator_amount: 299 },
        }),
      ),
      findFirst: jest.fn(() => Promise.resolve({ ...order })),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    user: {
      findUnique: jest.fn(() => Promise.resolve({ role: UserRole.CUSTOMER })),
    },
    store: { findUnique: jest.fn(() => Promise.resolve(store)) },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'EUR' })),
    },
    creator: {
      findUnique: jest.fn(() => Promise.resolve(null)),
      update: jest.fn(() => Promise.resolve({})),
    },
  };
  const orders = {
    recomputeCommissionForOrder: jest.fn(() => Promise.resolve()),
    markOrderPaid: jest.fn(() =>
      Promise.resolve({
        changed: true,
        order: { customer: { user_id: 'u1' }, order_number: 'MS-1' },
      }),
    ),
    markOrderFailed: jest.fn(() => Promise.resolve({ changed: true })),
    registerAbandonedPaymentChecker: jest.fn(),
  };
  const market = opts.market === undefined ? null : opts.market;
  const markets = {
    resolve: jest.fn(() => Promise.resolve(market)),
    byId: jest.fn(() => Promise.resolve(market)),
  };
  const merchant = fakeStripe('merchant');
  const platform = fakeStripe('platform');
  const ownKey = {
    getStatus: jest.fn(() => Promise.resolve(null)),
    isActive: jest.fn(() => Promise.resolve(opts.ownKeyActive ?? true)),
    getPublishableKey: jest.fn(() =>
      Promise.resolve(opts.ownPublishableKey ?? 'pk_live_own'),
    ),
    getMode: jest.fn(() =>
      Promise.resolve({ status: 'ACTIVE', livemode: true }),
    ),
    getClient: jest.fn(() => Promise.resolve(merchant)),
    getClientEntry: jest.fn(() =>
      Promise.resolve({
        client: merchant,
        fingerprint: 'fp_current',
        previous: false,
        livemode: true,
      }),
    ),
    getWebhookSecret: jest.fn(() => Promise.resolve('whsec')),
    getWebhookSecrets: jest.fn(() => Promise.resolve(['whsec'])),
    markRevoked: jest.fn(() => Promise.resolve()),
    invalidate: jest.fn(),
  };
  const service = new PaymentsService(
    { get: () => undefined } as unknown as ConfigService,
    prisma as unknown as PrismaService,
    {} as CryptoService,
    orders as unknown as OrdersService,
    { create: jest.fn() } as unknown as NotificationsService,
    { dispatchOrderEmail: jest.fn() } as unknown as MailService,
    markets as unknown as MarketsContextService,
    undefined,
    undefined,
    ownKey as unknown as OwnKeyApi,
  );
  const internals = service as unknown as Internals;
  jest.spyOn(internals, 'requireStripe').mockResolvedValue(platform);
  jest.spyOn(internals, 'resolveStripe').mockResolvedValue(platform);
  jest
    .spyOn(internals, 'getPublishableKey')
    .mockResolvedValue('pk_test_platform');
  return { service, prisma, markets, merchant, platform, ownKey };
}

async function bodyOf(p: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse() as Record<
      string,
      unknown
    >;
  }
  throw new Error('expected a BadRequestException');
}

describe('PaymentsService.getPublicConfig per market (M157)', () => {
  // Pre-M157 answers (the market only decided kustomEnabled by currency).
  const OWN_KEY_BEFORE = {
    stripeConfigured: true,
    publishableKey: 'pk_live_own',
    stripeAccount: null,
    route: 'OWN_KEY',
    kustomEnabled: true,
  };
  const CONNECT_BEFORE = {
    stripeConfigured: true,
    publishableKey: 'pk_test_platform',
    stripeAccount: 'acct_1',
    route: 'CONNECT_DIRECT',
    kustomEnabled: true,
  };

  it.each([
    ['app off', null],
    ['market without the setting', marketCtx('default', null)],
    ['hand-built context (undefined)', marketCtx('default', undefined)],
    ['all three methods', marketCtx('default', ['card', 'kustom', 'cod'])],
  ])(
    'regression: %s -> the whole answer equals the pre-M157 one',
    async (_label, market) => {
      const own = build({ market });
      expect(await own.service.getPublicConfig('shop')).toEqual(OWN_KEY_BEFORE);
      expect(JSON.stringify(await own.service.getPublicConfig('shop'))).toBe(
        JSON.stringify(OWN_KEY_BEFORE),
      );
      const connect = build({ market, connect: true, ownKeyActive: false });
      expect(await connect.service.getPublicConfig('shop')).toEqual(
        CONNECT_BEFORE,
      );
    },
  );

  it('OWN_KEY, card only (Namez eu): card on, Kustom off', async () => {
    const b = build({ market: marketCtx('eu', ['card'], 'EUR') });
    expect(await b.service.getPublicConfig('shop', 'eu')).toEqual({
      ...OWN_KEY_BEFORE,
      kustomEnabled: false,
    });
  });

  it('OWN_KEY, kustom only (Namez SE): no key, no account, not configured', async () => {
    const b = build({ market: marketCtx('default', ['kustom']) });
    const cfg = await b.service.getPublicConfig('shop');
    expect(cfg).toEqual({
      stripeConfigured: false,
      publishableKey: null,
      stripeAccount: null,
      route: 'OWN_KEY',
      kustomEnabled: true,
    });
    // Stripe.js must not even load: the own publishable key is never read.
    expect(b.ownKey.getPublishableKey).not.toHaveBeenCalled();
  });

  it('OWN_KEY TEST key, card excluded: no test_mode either', async () => {
    const b = build({
      market: marketCtx('default', ['kustom']),
      ownPublishableKey: 'pk_test_own',
    });
    const cfg = await b.service.getPublicConfig('shop', undefined, false, () =>
      Promise.resolve(true),
    );
    expect(cfg).not.toHaveProperty('test_mode');
    expect(cfg.publishableKey).toBeNull();
  });

  it('CONNECT_DIRECT, kustom only: no key, no account', async () => {
    const b = build({
      market: marketCtx('default', ['kustom']),
      connect: true,
      ownKeyActive: false,
    });
    expect(await b.service.getPublicConfig('shop')).toEqual({
      stripeConfigured: false,
      publishableKey: null,
      stripeAccount: null,
      route: 'CONNECT_DIRECT',
      kustomEnabled: true,
    });
  });

  it('CONNECT_DIRECT, card only: Kustom off', async () => {
    const b = build({
      market: marketCtx('eu', ['card'], 'EUR'),
      connect: true,
      ownKeyActive: false,
    });
    expect(await b.service.getPublicConfig('shop', 'eu')).toEqual({
      ...CONNECT_BEFORE,
      kustomEnabled: false,
    });
  });

  it('cod only: neither card nor Kustom', async () => {
    const b = build({ market: marketCtx('default', ['cod']) });
    const cfg = await b.service.getPublicConfig('shop');
    expect(cfg.stripeConfigured).toBe(false);
    expect(cfg.kustomEnabled).toBe(false);
  });

  it('resolves the market once per request, with preview when asked', async () => {
    const b = build({ market: marketCtx('eu', ['card'], 'EUR') });
    await b.service.getPublicConfig('shop', 'eu', true);
    expect(b.markets.resolve).toHaveBeenCalledTimes(1);
    expect(b.markets.resolve).toHaveBeenCalledWith('s1', 'eu', {
      preview: true,
    });
    const c = build({ market: marketCtx('eu', ['card'], 'EUR') });
    await c.service.getPublicConfig('shop', 'eu');
    expect(c.markets.resolve).toHaveBeenCalledTimes(1);
    expect(c.markets.resolve).toHaveBeenCalledWith('s1', 'eu');
  });
});

describe('PaymentsService.createPaymentIntentForOrder per market (M157)', () => {
  it('order in a market that excludes card -> 400 before Stripe is touched', async () => {
    const b = build({
      market: marketCtx('default', ['kustom']),
      order: { market_id: 'm-default' },
    });
    const body = await bodyOf(
      b.service.createPaymentIntentForOrder('u1', 'o1'),
    );
    expect(body).toEqual(
      expect.objectContaining({
        code: 'MARKET_PAYMENT_METHOD_NOT_ALLOWED',
        method: 'card',
      }),
    );
    expect(b.markets.byId).toHaveBeenCalledWith('s1', 'm-default');
    for (const s of [b.merchant, b.platform]) {
      expect(s.paymentIntents.create).not.toHaveBeenCalled();
      expect(s.paymentIntents.retrieve).not.toHaveBeenCalled();
    }
    expect(b.prisma.order.update).not.toHaveBeenCalled();
  });

  it('an open intent is not reused either when the market excludes card', async () => {
    const b = build({
      market: marketCtx('default', ['kustom']),
      order: { market_id: 'm-default', stripe_payment_id: 'pi_1' },
    });
    await bodyOf(b.service.createPaymentIntentForOrder('u1', 'o1'));
    expect(b.merchant.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it('a paid order still answers { status: paid } (money already moved)', async () => {
    const b = build({
      market: marketCtx('default', ['kustom']),
      order: { market_id: 'm-default', payment_status: 'paid' },
    });
    expect(await b.service.createPaymentIntentForOrder('u1', 'o1')).toEqual({
      status: 'paid',
    });
  });

  it('card allowed (eu card only) -> intent created as before', async () => {
    const b = build({
      market: marketCtx('eu', ['card'], 'EUR'),
      order: { market_id: 'm-eu' },
    });
    const res = await b.service.createPaymentIntentForOrder('u1', 'o1');
    expect(res).toMatchObject({ paymentIntentId: 'pi_merchant' });
  });

  it('regression: no market id / market gone / unset setting -> today path', async () => {
    for (const setup of [
      { market: null, order: {} },
      { market: null, order: { market_id: 'm-gone' } },
      { market: marketCtx('default', null), order: { market_id: 'm-default' } },
    ]) {
      const b = build(setup);
      const res = await b.service.createPaymentIntentForOrder('u1', 'o1');
      expect(res).toMatchObject({ paymentIntentId: 'pi_merchant' });
    }
    // No market id: the market cache is not even asked.
    const plain = build({ market: marketCtx('default', ['kustom']) });
    await plain.service.createPaymentIntentForOrder('u1', 'o1');
    expect(plain.markets.byId).not.toHaveBeenCalled();
  });
});

describe('direct calls: both create-intent routes refuse an excluded card (M157)', () => {
  function controller() {
    const b = build({
      market: marketCtx('default', ['kustom']),
      order: { market_id: 'm-default' },
    });
    const gate = { viewerFromHeader: jest.fn(() => Promise.resolve(null)) };
    const ctrl = new PaymentsController(b.service, {} as never, gate as never);
    return { ...b, ctrl };
  }

  it('POST /payments/create-intent', async () => {
    const { ctrl, merchant } = controller();
    const body = await bodyOf(
      ctrl.createIntent('u1', { order_id: 'o1' } as never, undefined),
    );
    expect(body.code).toBe('MARKET_PAYMENT_METHOD_NOT_ALLOWED');
    expect(merchant.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('POST /payments/guest/create-intent', async () => {
    const { ctrl, merchant } = controller();
    const body = await bodyOf(
      ctrl.guestCreateIntent(
        { userId: 'u1', orderId: 'o1', storeId: 's1' },
        { order_id: 'o1' } as never,
        undefined,
      ),
    );
    expect(body.code).toBe('MARKET_PAYMENT_METHOD_NOT_ALLOWED');
    expect(merchant.paymentIntents.create).not.toHaveBeenCalled();
  });
});
