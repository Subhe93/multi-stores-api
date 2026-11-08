import Stripe from 'stripe';
import { ConflictException } from '@nestjs/common';
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
import type { OwnKeyApi } from './own-key/own-key.types';

// Own Stripe key payment flow (plans/stripe-restricted-keys/SPEC.md):
// route resolution, public config, PaymentIntent params per route, the
// per-store webhook (signature + cross-store isolation), merchant-client
// reads, 401 -> markRevoked, legacy orders and the Connect gating.

type Internals = Record<string, (...args: unknown[]) => Promise<unknown>>;
type Fn = jest.Mock;

const WEBHOOK_SECRET = 'whsec_test_store_secret';

/** Test signature header (the SDK fills timestamp / scheme defaults). */
const signHeader = (o: { payload: string; secret: string }) =>
  Stripe.webhooks.generateTestHeaderString(
    o as Parameters<typeof Stripe.webhooks.generateTestHeaderString>[0],
  );

function fakeStripe(label: string) {
  return {
    label,
    paymentIntents: {
      create: jest.fn(() =>
        Promise.resolve({ id: `pi_${label}`, client_secret: `cs_${label}` }),
      ),
      cancel: jest.fn(() =>
        Promise.resolve({ id: 'pi_1', status: 'canceled' }),
      ),
      retrieve: jest.fn(() =>
        Promise.resolve({
          id: 'pi_1',
          status: 'succeeded',
          metadata: { order_id: 'o1' },
          amount_received: 29900,
          currency: 'sek',
          latest_charge: 'ch_1',
        }),
      ),
    },
    charges: {
      retrieve: jest.fn(() =>
        Promise.resolve({
          id: 'ch_1',
          payment_intent: 'pi_1',
          refunded: false,
          amount_refunded: 5000,
          currency: 'sek',
          payment_method_details: { card: { brand: 'visa', last4: '4242' } },
          receipt_url: 'https://r',
        }),
      ),
    },
    transfers: { create: jest.fn() },
    accounts: {
      create: jest.fn(() => Promise.resolve({ id: 'acct_new' })),
    },
    accountLinks: {
      create: jest.fn(() => Promise.resolve({ url: 'https://onboard' })),
    },
  };
}

interface OrderRow {
  id: string;
  order_number: string;
  store_id: string | null;
  payment_route: string | null;
  stripe_account_id: string | null;
  stripe_payment_id: string | null;
  stripe_charge_id: string | null;
  payment_status: string | null;
  total: number;
  currency: string;
  is_test?: boolean;
}

function build(
  opts: {
    order?: Partial<OrderRow>;
    store?: Record<string, unknown> | null;
    ownKeyActive?: boolean;
    creator?: Record<string, unknown> | null;
  } = {},
) {
  const order: OrderRow = {
    id: 'o1',
    order_number: 'MS-1',
    store_id: 's1',
    payment_route: 'OWN_KEY',
    stripe_account_id: null,
    stripe_payment_id: 'pi_1',
    stripe_charge_id: 'ch_1',
    payment_status: 'awaiting_payment',
    total: 299,
    currency: 'SEK',
    ...opts.order,
  };
  const store =
    opts.store === undefined
      ? {
          id: 's1',
          store_type: StoreType.INDEPENDENT,
          currency: 'SEK',
          creator: {
            stripe_account_id: null,
            stripe_account_type: null,
            stripe_charges_enabled: false,
          },
        }
      : opts.store;
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
    store: {
      findUnique: jest.fn(() => Promise.resolve(store)),
    },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'EUR' })),
    },
    creator: {
      findUnique: jest.fn(() => Promise.resolve(opts.creator ?? null)),
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
    markOrderFailed: jest.fn(() =>
      Promise.resolve({
        changed: true,
        order: { customer: { user_id: 'u1' }, order_number: 'MS-1' },
      }),
    ),
    markOrderRefunded: jest.fn(() => Promise.resolve({ changed: true })),
    recordPartialRefund: jest.fn(() => Promise.resolve({ changed: true })),
    recordPaymentNote: jest.fn(() => Promise.resolve({ changed: true })),
    revertRefund: jest.fn(() => Promise.resolve({ changed: true })),
    registerAbandonedPaymentChecker: jest.fn(),
  };
  const notifications = { create: jest.fn(() => Promise.resolve()) };
  const mail = { dispatchOrderEmail: jest.fn(() => Promise.resolve()) };
  const markets = { resolve: jest.fn(() => Promise.resolve(null)) };
  const merchant = fakeStripe('merchant');
  const platform = fakeStripe('platform');
  const ownKey: { [K in keyof OwnKeyApi]: Fn } = {
    getStatus: jest.fn(() => Promise.resolve(null)),
    isActive: jest.fn(() => Promise.resolve(opts.ownKeyActive ?? true)),
    getPublishableKey: jest.fn(() => Promise.resolve('pk_live_own')),
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
    getWebhookSecret: jest.fn(() => Promise.resolve(WEBHOOK_SECRET)),
    getWebhookSecrets: jest.fn(() => Promise.resolve([WEBHOOK_SECRET])),
    markRevoked: jest.fn(() => Promise.resolve()),
    invalidate: jest.fn(),
  };
  const service = new PaymentsService(
    { get: () => undefined } as unknown as ConfigService,
    prisma as unknown as PrismaService,
    {} as CryptoService,
    orders as unknown as OrdersService,
    notifications as unknown as NotificationsService,
    mail as unknown as MailService,
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
  return {
    service,
    internals,
    prisma,
    orders,
    notifications,
    merchant,
    platform,
    ownKey,
  };
}

function event(type: string, object: Record<string, unknown>) {
  return {
    id: 'evt_1',
    type,
    data: { object },
  } as unknown as Parameters<PaymentsService['handleWebhookEvent']>[0];
}

const succeededPi = { id: 'pi_1', metadata: { order_id: 'o1' } };

describe('PaymentsService own key — public config', () => {
  it('OWN_KEY: own publishable key, no connected account', async () => {
    const b = build();
    const cfg = await b.service.getPublicConfig('shop');
    expect(cfg).toEqual({
      stripeConfigured: true,
      publishableKey: 'pk_live_own',
      stripeAccount: null,
      route: 'OWN_KEY',
      kustomEnabled: false,
    });
    expect(b.ownKey.isActive).toHaveBeenCalledWith('s1', { allowTest: false });
  });

  it('CONNECT_DIRECT: unchanged legacy shape + route', async () => {
    const b = build({
      ownKeyActive: false,
      store: {
        id: 's1',
        store_type: StoreType.INDEPENDENT,
        currency: 'SEK',
        creator: {
          stripe_account_id: 'acct_1',
          stripe_account_type: 'standard',
          stripe_charges_enabled: true,
        },
      },
    });
    const cfg = await b.service.getPublicConfig('shop');
    expect(cfg).toEqual({
      stripeConfigured: true,
      publishableKey: 'pk_test_platform',
      stripeAccount: 'acct_1',
      route: 'CONNECT_DIRECT',
      kustomEnabled: false,
    });
  });

  it('PLATFORM: marketplace store and no store', async () => {
    const b = build({
      store: { id: 's1', store_type: StoreType.MARKETPLACE, creator: {} },
    });
    const expected = {
      stripeConfigured: true,
      publishableKey: 'pk_test_platform',
      stripeAccount: null,
      route: 'PLATFORM',
      kustomEnabled: false,
    };
    expect(await b.service.getPublicConfig('shop')).toEqual(expected);
    expect(await b.service.getPublicConfig()).toEqual(expected);
    expect(b.ownKey.isActive).not.toHaveBeenCalled();
  });
});

describe('PaymentsService own key — PaymentIntent per route', () => {
  it('OWN_KEY: merchant client, automatic methods, no transfers, route saved', async () => {
    const b = build({ order: { stripe_payment_id: null } });
    const res = await b.service.createPaymentIntentForOrder('u1', 'o1');
    expect(res).toEqual({
      clientSecret: 'cs_merchant',
      paymentIntentId: 'pi_merchant',
      route: 'OWN_KEY',
    });
    expect(b.platform.paymentIntents.create).not.toHaveBeenCalled();
    const [params, options] = b.merchant.paymentIntents.create.mock
      .calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(params.automatic_payment_methods).toEqual({ enabled: true });
    expect(params).not.toHaveProperty('payment_method_types');
    expect(params).not.toHaveProperty('transfer_data');
    expect(params).not.toHaveProperty('application_fee_amount');
    expect(params.amount).toBe(29900);
    expect(params.currency).toBe('sek');
    expect(params.metadata).toMatchObject({ order_id: 'o1', store_id: 's1' });
    expect(options).not.toHaveProperty('stripeAccount');
    expect(options.idempotencyKey).toBe(
      'pi_OWN_KEY_fp_current_o1_29900sek_first',
    );
    expect(b.prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: {
        stripe_payment_id: 'pi_merchant',
        stripe_account_id: null,
        payment_route: 'OWN_KEY',
        stripe_key_fingerprint: 'fp_current',
        payment_processing_at: null,
      },
    });
  });

  it('CONNECT_DIRECT: platform client on the connected account', async () => {
    const b = build({
      ownKeyActive: false,
      order: { stripe_payment_id: null },
      store: {
        id: 's1',
        store_type: StoreType.INDEPENDENT,
        creator: {
          stripe_account_id: 'acct_1',
          stripe_account_type: 'standard',
          stripe_charges_enabled: true,
        },
      },
    });
    await b.service.createPaymentIntentForOrder('u1', 'o1');
    const [params, options] = b.platform.paymentIntents.create.mock
      .calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(params.automatic_payment_methods).toEqual({ enabled: true });
    expect(options).toEqual({
      stripeAccount: 'acct_1',
      idempotencyKey: 'pi_CONNECT_DIRECT_acct_1_o1_29900sek_first',
    });
    expect(b.merchant.paymentIntents.create).not.toHaveBeenCalled();
    expect(b.prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: {
        stripe_payment_id: 'pi_platform',
        stripe_account_id: 'acct_1',
        payment_route: 'CONNECT_DIRECT',
        stripe_key_fingerprint: null,
        payment_processing_at: null,
      },
    });
  });

  it('PLATFORM: platform client, automatic methods, route saved', async () => {
    const b = build({
      store: { id: 's1', store_type: StoreType.MARKETPLACE, creator: {} },
      order: { stripe_payment_id: null },
    });
    jest
      .spyOn(b.internals, 'assertRecipientsOnboarded')
      .mockResolvedValue(undefined);
    await b.service.createPaymentIntentForOrder('u1', 'o1');
    const call = b.platform.paymentIntents.create.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(call[0].automatic_payment_methods).toEqual({ enabled: true });
    // Idempotency on the platform route too (no connected account).
    expect(call[1]).toEqual({
      idempotencyKey: 'pi_PLATFORM_platform_o1_29900sek_first',
    });
    expect(b.prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ payment_route: 'PLATFORM' }),
      }),
    );
  });

  it('OWN_KEY 401: marks the key revoked and answers OWN_KEY_NOT_ACTIVE', async () => {
    const b = build({ order: { stripe_payment_id: null } });
    b.merchant.paymentIntents.create.mockRejectedValueOnce(
      Object.assign(new Error('Invalid API Key provided: rk_test_xxx'), {
        statusCode: 401,
        type: 'StripeAuthenticationError',
      }),
    );
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1'),
    ).rejects.toMatchObject({
      response: { code: 'OWN_KEY_NOT_ACTIVE' },
    });
    expect(b.ownKey.markRevoked).toHaveBeenCalledWith(
      's1',
      'auth_failed',
      'fp_current',
    );
    expect(b.prisma.order.update).not.toHaveBeenCalled();
  });

  it('OWN_KEY client unavailable -> OWN_KEY_NOT_ACTIVE', async () => {
    const b = build({ order: { stripe_payment_id: null } });
    b.ownKey.getClientEntry.mockRejectedValueOnce(
      new Error('OWN_KEY_NOT_ACTIVE'),
    );
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1'),
    ).rejects.toMatchObject({ response: { code: 'OWN_KEY_NOT_ACTIVE' } });
  });
});

describe('PaymentsService create-intent reuse (deferred intent / retries)', () => {
  const open = {
    id: 'pi_1',
    status: 'requires_payment_method',
    amount: 29900,
    currency: 'sek',
    client_secret: 'cs_existing',
    metadata: { order_id: 'o1' },
  };

  it('reuses the open intent of the same route and amount', async () => {
    const b = build();
    b.merchant.paymentIntents.retrieve.mockResolvedValueOnce(open as never);
    const res = await b.service.createPaymentIntentForOrder('u1', 'o1');
    expect(res).toEqual({
      clientSecret: 'cs_existing',
      paymentIntentId: 'pi_1',
      route: 'OWN_KEY',
    });
    expect(b.merchant.paymentIntents.create).not.toHaveBeenCalled();
    expect(b.merchant.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it('cancels a stale intent (other amount) as duplicate and creates a new one', async () => {
    const b = build();
    b.merchant.paymentIntents.retrieve.mockResolvedValueOnce({
      ...open,
      amount: 100,
    } as never);
    const res = await b.service.createPaymentIntentForOrder('u1', 'o1');
    expect(b.merchant.paymentIntents.cancel).toHaveBeenCalledWith(
      'pi_1',
      { cancellation_reason: 'duplicate' },
      undefined,
    );
    expect(res).toMatchObject({ paymentIntentId: 'pi_merchant' });
    const [, options] = b.merchant.paymentIntents.create.mock
      .calls[0] as unknown as [unknown, { idempotencyKey: string }];
    expect(options.idempotencyKey).toBe('pi_OWN_KEY_fp_current_o1_29900sek_pi_1');
  });

  it('an intent on another route is canceled with its own client', async () => {
    const b = build({
      ownKeyActive: true,
      order: { payment_route: null, stripe_account_id: 'acct_1' },
    });
    b.platform.paymentIntents.retrieve.mockResolvedValueOnce(open as never);
    await b.service.createPaymentIntentForOrder('u1', 'o1');
    expect(b.platform.paymentIntents.cancel).toHaveBeenCalledWith(
      'pi_1',
      { cancellation_reason: 'duplicate' },
      { stripeAccount: 'acct_1' },
    );
    expect(b.merchant.paymentIntents.create).toHaveBeenCalled();
  });

  it('a processing intent answers 200 { status: processing }, no second intent', async () => {
    const b = build();
    b.merchant.paymentIntents.retrieve.mockResolvedValueOnce({
      ...open,
      status: 'processing',
    } as never);
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1'),
    ).resolves.toEqual({ status: 'processing' });
    expect(b.merchant.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('a succeeded intent finalises the order: 200 { status: paid }', async () => {
    const b = build();
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1'),
    ).resolves.toEqual({ status: 'paid' });
    expect(b.orders.markOrderPaid).toHaveBeenCalledWith('o1', 'pi_1');
    expect(b.merchant.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('our own duplicate cancellation never fails the order', async () => {
    const b = build();
    await b.service.handleWebhookEvent(
      event('payment_intent.canceled', {
        id: 'pi_1',
        cancellation_reason: 'duplicate',
        metadata: { order_id: 'o1' },
      }),
      { ownKeyStoreId: 's1' },
    );
    expect(b.orders.markOrderFailed).not.toHaveBeenCalled();
  });

  it('confirm: a redirect-returned failure marks the order failed', async () => {
    const b = build();
    b.merchant.paymentIntents.retrieve.mockResolvedValueOnce({
      ...open,
      last_payment_error: { code: 'card_declined', message: 'declined' },
    } as never);
    await expect(b.service.confirmOrderPayment('u1', 'o1')).resolves.toEqual({
      payment_status: 'failed',
    });
    expect(b.orders.markOrderFailed).toHaveBeenCalledWith('o1');
  });

  it('confirm: succeeded -> paid, using the route client', async () => {
    const b = build();
    await expect(b.service.confirmOrderPayment('u1', 'o1')).resolves.toEqual({
      payment_status: 'paid',
    });
    expect(b.merchant.paymentIntents.retrieve).toHaveBeenCalled();
    expect(b.platform.paymentIntents.retrieve).not.toHaveBeenCalled();
  });
});

describe('PaymentsService own key — store webhook', () => {
  const payload = JSON.stringify({
    id: 'evt_1',
    object: 'event',
    type: 'payment_intent.processing',
    data: { object: { id: 'pi_1', metadata: { order_id: 'o1' } } },
  });

  it('verifies with the store secret', async () => {
    const b = build();
    const header = signHeader({
      payload,
      secret: WEBHOOK_SECRET,
    });
    const ev = await b.service.constructStoreWebhookEvent(
      's1',
      Buffer.from(payload),
      header,
    );
    expect(ev.type).toBe('payment_intent.processing');
    expect(b.ownKey.getWebhookSecrets).toHaveBeenCalledWith('s1');
  });

  it('rejects another secret and a store without one', async () => {
    const b = build();
    const header = signHeader({
      payload,
      secret: 'whsec_other',
    });
    await expect(
      b.service.constructStoreWebhookEvent('s1', Buffer.from(payload), header),
    ).rejects.toThrow();
    b.ownKey.getWebhookSecrets.mockResolvedValueOnce([]);
    await expect(
      b.service.constructStoreWebhookEvent('s1', Buffer.from(payload), header),
    ).rejects.toThrow('Store webhook is not configured');
  });

  it('payment_intent.succeeded: merchant client re-read, order paid, no transfers', async () => {
    const b = build();
    await b.service.handleWebhookEvent(
      event('payment_intent.succeeded', succeededPi),
      { ownKeyStoreId: 's1' },
    );
    expect(b.merchant.paymentIntents.retrieve).toHaveBeenCalledWith(
      'pi_1',
      undefined,
      undefined,
    );
    expect(b.orders.markOrderPaid).toHaveBeenCalledWith('o1', 'pi_1');
    expect(b.merchant.charges.retrieve).toHaveBeenCalled();
    expect(b.platform.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(b.platform.charges.retrieve).not.toHaveBeenCalled();
    expect(b.platform.transfers.create).not.toHaveBeenCalled();
    expect(b.merchant.transfers.create).not.toHaveBeenCalled();
  });

  it('cross-store isolation: another store endpoint never touches the order', async () => {
    const b = build();
    await b.service.handleWebhookEvent(
      event('payment_intent.succeeded', succeededPi),
      { ownKeyStoreId: 's2' },
    );
    await b.service.handleWebhookEvent(
      event('charge.refunded', { id: 'ch_1', payment_intent: 'pi_1' }),
      { ownKeyStoreId: 's2' },
    );
    expect(b.merchant.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(b.merchant.charges.retrieve).not.toHaveBeenCalled();
    expect(b.orders.markOrderPaid).not.toHaveBeenCalled();
    expect(b.orders.markOrderRefunded).not.toHaveBeenCalled();
  });

  it('the store endpoint ignores non-OWN_KEY orders of the same store', async () => {
    const b = build({ order: { payment_route: 'PLATFORM' } });
    await b.service.handleWebhookEvent(
      event('payment_intent.succeeded', succeededPi),
      { ownKeyStoreId: 's1' },
    );
    expect(b.orders.markOrderPaid).not.toHaveBeenCalled();
  });

  it('the platform endpoint ignores OWN_KEY orders', async () => {
    const b = build();
    await b.service.handleWebhookEvent(
      event('payment_intent.succeeded', succeededPi),
    );
    await b.service.handleWebhookEvent(
      event('payment_intent.payment_failed', succeededPi),
    );
    expect(b.orders.markOrderPaid).not.toHaveBeenCalled();
    expect(b.orders.markOrderFailed).not.toHaveBeenCalled();
  });

  it('payment_intent.processing: timeline note, order stays awaiting payment', async () => {
    const b = build();
    await b.service.handleWebhookEvent(
      event('payment_intent.processing', succeededPi),
      { ownKeyStoreId: 's1' },
    );
    expect(b.orders.recordPaymentNote).toHaveBeenCalledWith(
      'o1',
      'PAYMENT_PROCESSING',
      expect.any(String),
    );
    expect(b.orders.markOrderPaid).not.toHaveBeenCalled();
    expect(b.orders.markOrderFailed).not.toHaveBeenCalled();
  });

  it('payment_intent.canceled: fails the order for its current intent only', async () => {
    const b = build();
    await b.service.handleWebhookEvent(
      event('payment_intent.canceled', {
        id: 'pi_old',
        metadata: { order_id: 'o1' },
      }),
      { ownKeyStoreId: 's1' },
    );
    expect(b.orders.markOrderFailed).not.toHaveBeenCalled();
    await b.service.handleWebhookEvent(
      event('payment_intent.canceled', succeededPi),
      { ownKeyStoreId: 's1' },
    );
    expect(b.orders.markOrderFailed).toHaveBeenCalledWith(
      'o1',
      'Stripe payment was canceled',
    );
  });

  it('refund.updated: re-reads the charge with the merchant client', async () => {
    const b = build({ order: { payment_status: 'paid' } });
    await b.service.handleWebhookEvent(
      event('refund.updated', {
        id: 're_1',
        charge: 'ch_1',
        payment_intent: 'pi_1',
      }),
      { ownKeyStoreId: 's1' },
    );
    expect(b.merchant.charges.retrieve).toHaveBeenCalledWith(
      'ch_1',
      undefined,
      undefined,
    );
    expect(b.orders.recordPartialRefund).toHaveBeenCalledWith(
      'o1',
      50,
      'sek',
      'Stripe',
      { cumulativeRefunded: 50, storeId: 's1' },
    );
  });

  it('charge.refunded full refund marks the order refunded', async () => {
    const b = build({ order: { payment_status: 'paid' } });
    b.merchant.charges.retrieve.mockResolvedValueOnce({
      id: 'ch_1',
      payment_intent: 'pi_1',
      refunded: true,
      amount_refunded: 29900,
      currency: 'sek',
    } as never);
    await b.service.handleWebhookEvent(
      event('charge.refunded', { id: 'ch_1', payment_intent: 'pi_1' }),
      { ownKeyStoreId: 's1' },
    );
    expect(b.orders.markOrderRefunded).toHaveBeenCalledWith('o1');
  });

  it('charge.dispute.created: timeline note + owner notification', async () => {
    const b = build({ order: { payment_status: 'paid' } });
    b.prisma.store.findUnique.mockResolvedValueOnce({
      creator: { user_id: 'owner' },
    } as never);
    await b.service.handleWebhookEvent(
      event('charge.dispute.created', {
        charge: 'ch_1',
        payment_intent: 'pi_1',
        amount: 29900,
        currency: 'sek',
        status: 'needs_response',
        reason: 'fraudulent',
      }),
      { ownKeyStoreId: 's1' },
    );
    expect(b.orders.recordPaymentNote).toHaveBeenCalledWith(
      'o1',
      'PAYMENT_DISPUTE',
      'Stripe dispute needs_response (fraudulent): 299 SEK',
    );
    expect(b.notifications.create).toHaveBeenCalledWith(
      'owner',
      'order_disputed',
      'Payment disputed',
      expect.any(String),
      { order_id: 'o1' },
    );
  });

  it('a 401 during the webhook re-read marks the key revoked (payload not trusted without its checks)', async () => {
    const b = build();
    b.merchant.paymentIntents.retrieve.mockRejectedValueOnce(
      Object.assign(new Error('expired'), { statusCode: 401 }),
    );
    // The payload here has no status / amount: nothing is marked paid.
    await b.service.handleWebhookEvent(
      event('payment_intent.succeeded', succeededPi),
      { ownKeyStoreId: 's1' },
    );
    expect(b.ownKey.markRevoked).toHaveBeenCalledWith(
      's1',
      'auth_failed',
      'fp_current',
    );
    expect(b.orders.markOrderPaid).not.toHaveBeenCalled();
  });
});

describe('PaymentsService own key — reconcile and legacy orders', () => {
  it('OWN_KEY reconcile reads with the merchant client; processing is surfaced', async () => {
    const b = build();
    b.merchant.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_1',
      status: 'processing',
      metadata: { order_id: 'o1' },
    } as never);
    const res = await b.service.reconcilePayment('o1');
    expect(res).toEqual({
      payment_status: 'awaiting_payment',
      intent_status: 'processing',
    });
    expect(b.merchant.paymentIntents.retrieve).toHaveBeenCalledWith(
      'pi_1',
      undefined,
      undefined,
    );
  });

  it('legacy null route + account snapshot: platform client on that account', async () => {
    const b = build({
      order: { payment_route: null, stripe_account_id: 'acct_1' },
    });
    await b.service.reconcilePayment('o1');
    expect(b.platform.paymentIntents.retrieve).toHaveBeenCalledWith(
      'pi_1',
      undefined,
      { stripeAccount: 'acct_1' },
    );
    expect(b.merchant.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(b.ownKey.getClient).not.toHaveBeenCalled();
  });

  it('legacy null route without account: platform client, platform webhook still handles it', async () => {
    const b = build({ order: { payment_route: null } });
    jest.spyOn(b.internals, 'issueOrderTransfers').mockResolvedValue(undefined);
    await b.service.handleWebhookEvent(
      event('payment_intent.succeeded', succeededPi),
    );
    expect(b.platform.paymentIntents.retrieve).toHaveBeenCalledWith(
      'pi_1',
      undefined,
      undefined,
    );
    expect(b.orders.markOrderPaid).toHaveBeenCalledWith('o1', 'pi_1');
    expect(b.ownKey.getClient).not.toHaveBeenCalled();
  });

  it('transfers are never attempted for OWN_KEY orders', async () => {
    const b = build();
    await b.internals.issueOrderTransfers('o1', { rethrow: true });
    expect(b.internals.requireStripe).not.toHaveBeenCalled();
    expect(b.platform.transfers.create).not.toHaveBeenCalled();
  });
});

describe('PaymentsService own key — Connect gating', () => {
  const creator = (stripeAccountId: string | null, storeType: StoreType) => ({
    id: 'c1',
    user: { email: 'o@example.com' },
    store: { store_type: storeType },
    stripe_account_id: stripeAccountId,
    stripe_account_type: stripeAccountId ? 'standard' : null,
    stripe_charges_enabled: Boolean(stripeAccountId),
    stripe_payouts_enabled: Boolean(stripeAccountId),
    stripe_onboarding_completed_at: null,
  });

  it('independent creator without an account -> 409 USE_OWN_STRIPE_KEY', async () => {
    const b = build({ creator: creator(null, StoreType.INDEPENDENT) });
    const create = b.service.getOrCreateConnectedAccount(
      'u1',
      UserRole.CREATOR,
    );
    await expect(create).rejects.toBeInstanceOf(ConflictException);
    await expect(
      b.service.createOnboardingLink('u1', UserRole.CREATOR),
    ).rejects.toMatchObject({ response: { code: 'USE_OWN_STRIPE_KEY' } });
    expect(b.platform.accounts.create).not.toHaveBeenCalled();
  });

  it('independent creator already connected keeps working', async () => {
    const b = build({ creator: creator('acct_1', StoreType.INDEPENDENT) });
    await expect(
      b.service.getOrCreateConnectedAccount('u1', UserRole.CREATOR),
    ).resolves.toBe('acct_1');
  });

  it('marketplace creator still gets a new Express account', async () => {
    const b = build({ creator: creator(null, StoreType.MARKETPLACE) });
    await expect(
      b.service.getOrCreateConnectedAccount('u1', UserRole.CREATOR),
    ).resolves.toBe('acct_new');
  });
});

// ── Hardening (audit fixes 2026-11-07) ─────────────────────────────────────

const independentNoConnect = {
  id: 's1',
  store_type: StoreType.INDEPENDENT,
  is_active: true,
  currency: 'SEK',
  creator: {
    user_id: 'owner1',
    stripe_account_id: null,
    stripe_account_type: null,
    stripe_charges_enabled: false,
  },
};

/** isActive that honours allowTest (a TEST key) like the real service. */
function testKey(b: ReturnType<typeof build>) {
  b.ownKey.isActive.mockImplementation(
    (_id: string, o?: { allowTest?: boolean }) =>
      Promise.resolve(o?.allowTest === true),
  );
  b.ownKey.getPublishableKey.mockResolvedValue('pk_test_own');
}

const stripeErr = (statusCode: number, message: string, code?: string) =>
  Object.assign(new Error(message), { statusCode, code });

describe('PaymentsService hardening — test-mode own key', () => {
  it('public config never exposes a TEST key; the owner preview gets test_mode', async () => {
    const b = build({ store: independentNoConnect });
    testKey(b);
    const pub = await b.service.getPublicConfig('shop');
    expect(pub.route).toBe('CONNECT_DIRECT');
    expect(pub.stripeConfigured).toBe(false);
    expect(pub).not.toHaveProperty('test_mode');

    const preview = jest.fn(() => Promise.resolve(true));
    const own = await b.service.getPublicConfig(
      'shop',
      undefined,
      false,
      preview,
    );
    expect(preview).toHaveBeenCalledWith('s1');
    expect(own).toMatchObject({
      route: 'OWN_KEY',
      publishableKey: 'pk_test_own',
      stripeConfigured: true,
      test_mode: true,
    });
  });

  it('an inactive store answers platform defaults unless the viewer may preview', async () => {
    const b = build({ store: { ...independentNoConnect, is_active: false } });
    expect((await b.service.getPublicConfig('shop')).route).toBe('PLATFORM');
    const own = await b.service.getPublicConfig('shop', undefined, false, () =>
      Promise.resolve(true),
    );
    expect(own.route).toBe('OWN_KEY');
  });

  it('create-intent: owner preview viewer pays on a TEST key; nobody else does', async () => {
    const b = build({
      store: independentNoConnect,
      order: { stripe_payment_id: null },
    });
    testKey(b);
    // Anonymous (no X-Storefront-Viewer): no test key.
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1'),
    ).rejects.toThrow('cannot accept card payments');
    // A viewer that is not the owner (customer / other store's token).
    const notOwner = jest.fn(() => Promise.resolve(false));
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1', notOwner),
    ).rejects.toThrow('cannot accept card payments');
    expect(notOwner).toHaveBeenCalledWith('s1');
    // A viewer check that blows up counts as "not the owner".
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1', () =>
        Promise.reject(new Error('bad token')),
      ),
    ).rejects.toThrow('cannot accept card payments');
    expect(b.merchant.paymentIntents.create).not.toHaveBeenCalled();

    // The owner's preview / edit-hint token (same check as /payments/config).
    const owner = jest.fn(() => Promise.resolve(true));
    const res = await b.service.createPaymentIntentForOrder('u1', 'o1', owner);
    expect(res).toMatchObject({ route: 'OWN_KEY' });
    expect(b.ownKey.isActive).toHaveBeenLastCalledWith('s1', {
      allowTest: true,
    });
  });

  it('the customer JWT alone never unlocks a TEST key (even an admin / owner account)', async () => {
    const b = build({
      store: {
        ...independentNoConnect,
        creator: { ...independentNoConnect.creator, user_id: 'u1' },
      },
      order: { stripe_payment_id: null },
    });
    testKey(b);
    b.prisma.user.findUnique.mockResolvedValue({
      role: UserRole.ADMIN,
    } as never);
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1'),
    ).rejects.toThrow('cannot accept card payments');
    expect(b.ownKey.isActive).toHaveBeenLastCalledWith('s1', {
      allowTest: false,
    });
  });
});

describe('PaymentsService hardening — create-intent states and amounts', () => {
  it('an already-paid order answers 200 { status: paid } without Stripe', async () => {
    const b = build({ order: { payment_status: 'paid' } });
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1'),
    ).resolves.toEqual({ status: 'paid' });
    expect(b.merchant.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(b.merchant.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('a zero total never goes to Stripe: marked paid, { status: paid }', async () => {
    const b = build({ order: { total: 0, stripe_payment_id: null } });
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1'),
    ).resolves.toEqual({ status: 'paid' });
    expect(b.orders.markOrderPaid).toHaveBeenCalledWith('o1', undefined, 'none', {
      note: 'No payment required (total 0)',
    });
    expect(b.merchant.paymentIntents.create).not.toHaveBeenCalled();
    expect(b.notifications.create).toHaveBeenCalled();
  });

  it('a zero total runs the shared finalize: commission, invoice, designer, emails, no transfers', async () => {
    const invoices = { onOrderPaid: jest.fn(() => Promise.resolve()) };
    const designer = { onOrderPaid: jest.fn(() => Promise.resolve()) };
    const b = build({ order: { total: 0, stripe_payment_id: null } });
    Object.assign(b.service as unknown as Record<string, unknown>, {
      invoices,
      designerTriggers: designer,
    });
    const transfers = jest
      .spyOn(b.internals, 'issueOrderTransfers')
      .mockResolvedValue(undefined);
    const mail = (b.service as unknown as { mail: { dispatchOrderEmail: Fn } })
      .mail;
    await b.service.createPaymentIntentForOrder('u1', 'o1');
    expect(b.orders.recomputeCommissionForOrder).toHaveBeenCalledWith('o1');
    const paid = { id: 'o1', store_id: 's1', payment_status: 'paid' };
    expect(invoices.onOrderPaid).toHaveBeenCalledWith(paid);
    expect(designer.onOrderPaid).toHaveBeenCalledWith(paid);
    expect(transfers).not.toHaveBeenCalled();
    expect(mail.dispatchOrderEmail).toHaveBeenCalledWith(
      'o1',
      'order_confirmation',
    );
    expect(mail.dispatchOrderEmail).toHaveBeenCalledWith('o1', 'new_order_owner');
  });

  it('a Stripe payment runs the same finalize, transfers included', async () => {
    const invoices = { onOrderPaid: jest.fn(() => Promise.resolve()) };
    const designer = { onOrderPaid: jest.fn(() => Promise.resolve()) };
    const b = build();
    Object.assign(b.service as unknown as Record<string, unknown>, {
      invoices,
      designerTriggers: designer,
    });
    const transfers = jest
      .spyOn(b.internals, 'issueOrderTransfers')
      .mockResolvedValue(undefined);
    await b.service.reconcilePayment('o1');
    expect(b.orders.markOrderPaid).toHaveBeenCalledWith('o1', 'pi_1');
    expect(invoices.onOrderPaid).toHaveBeenCalled();
    expect(designer.onOrderPaid).toHaveBeenCalled();
    expect(transfers).toHaveBeenCalledWith('o1', { rethrow: false });
    expect(b.notifications.create).toHaveBeenCalled();
  });

  it('below the Stripe minimum -> 400 PAYMENT_AMOUNT_TOO_SMALL', async () => {
    const b = build({ order: { total: 1, stripe_payment_id: null } });
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1'),
    ).rejects.toMatchObject({
      response: { code: 'PAYMENT_AMOUNT_TOO_SMALL' },
    });
    expect(b.merchant.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('a Stripe amount_too_small error maps to the same code', async () => {
    const b = build({ order: { stripe_payment_id: null } });
    b.merchant.paymentIntents.create.mockRejectedValueOnce(
      stripeErr(400, 'Amount must convert to at least 50 cents', 'amount_too_small'),
    );
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1'),
    ).rejects.toMatchObject({
      response: { code: 'PAYMENT_AMOUNT_TOO_SMALL' },
    });
  });

  it('a Stripe 5xx bumps the attempt so the retry gets a fresh idempotency key', async () => {
    const b = build({ order: { stripe_payment_id: null } });
    b.merchant.paymentIntents.create.mockRejectedValueOnce(
      stripeErr(500, 'An unknown error occurred'),
    );
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1'),
    ).rejects.toBeDefined();
    expect(b.prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'o1' },
      data: { stripe_intent_attempt: { increment: 1 } },
    });
    // The retry (attempt now 1) uses another key than the cached 500.
    const b2 = build({
      order: { stripe_payment_id: null, stripe_intent_attempt: 1 } as never,
    });
    await b2.service.createPaymentIntentForOrder('u1', 'o1');
    const [, options] = b2.merchant.paymentIntents.create.mock
      .calls[0] as unknown as [unknown, { idempotencyKey: string }];
    expect(options.idempotencyKey).toBe(
      'pi_OWN_KEY_fp_current_o1_29900sek_first_a1',
    );
  });

  it('a connection error bumps the attempt too; a 4xx does not', async () => {
    const b = build({ order: { stripe_payment_id: null } });
    b.merchant.paymentIntents.create.mockRejectedValueOnce(
      Object.assign(new Error('socket hang up'), {
        type: 'StripeConnectionError',
      }),
    );
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1'),
    ).rejects.toBeDefined();
    expect(b.prisma.order.update).toHaveBeenCalledTimes(1);
    b.merchant.paymentIntents.create.mockRejectedValueOnce(
      stripeErr(400, 'Invalid currency'),
    );
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1'),
    ).rejects.toBeDefined();
    expect(b.prisma.order.update).toHaveBeenCalledTimes(1);
  });

  it('OWN_KEY: a merchant Stripe error reaches the customer as a generic code', async () => {
    const b = build({ order: { stripe_payment_id: null } });
    b.merchant.paymentIntents.create.mockRejectedValueOnce(
      stripeErr(400, 'Your account acct_123456789 cannot currently make live charges.'),
    );
    const err = (await b.service
      .createPaymentIntentForOrder('u1', 'o1')
      .catch((e: unknown) => e)) as {
      response: { code: string; message: string };
    };
    expect(err.response.code).toBe('PAYMENT_PROVIDER_ERROR');
    expect(JSON.stringify(err.response)).not.toContain('acct_');
  });

  it('route switch: a transient read error -> 409 once, then abandoned_unreachable + switch', async () => {
    const b = build({
      order: { payment_route: 'CONNECT_DIRECT', stripe_account_id: 'acct_1' },
    });
    b.prisma.store.findUnique
      .mockResolvedValueOnce(independentNoConnect as never)
      .mockResolvedValueOnce(independentNoConnect as never)
      .mockResolvedValue({ creator: { user_id: 'owner' } } as never);
    b.platform.paymentIntents.retrieve.mockRejectedValue(new Error('network'));
    // Second call: the retry marker already exists.
    b.orders.recordPaymentNote
      .mockResolvedValueOnce({ changed: true })
      .mockResolvedValueOnce({ changed: false })
      .mockResolvedValueOnce({ changed: true });
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1'),
    ).rejects.toMatchObject({
      response: { code: 'PAYMENT_ROUTE_CHANGED_RETRY' },
    });
    expect(b.merchant.paymentIntents.create).not.toHaveBeenCalled();
    const res = await b.service.createPaymentIntentForOrder('u1', 'o1');
    expect(res).toMatchObject({ route: 'OWN_KEY' });
    expect(b.orders.recordPaymentNote).toHaveBeenLastCalledWith(
      'o1',
      'PAYMENT_INTENT_ABANDONED',
      expect.stringContaining('abandoned_unreachable'),
    );
    expect(b.notifications.create).toHaveBeenCalledWith(
      'owner',
      'order_payment_attempt_abandoned',
      expect.any(String),
      expect.any(String),
      { order_id: 'o1' },
    );
  });

  it('route switch: a revoked old own key switches at once (no 409 loop)', async () => {
    const b = build({
      ownKeyActive: false,
      order: { payment_route: 'OWN_KEY' },
      store: {
        id: 's1',
        store_type: StoreType.INDEPENDENT,
        creator: {
          stripe_account_id: 'acct_1',
          stripe_account_type: 'standard',
          stripe_charges_enabled: true,
        },
      },
    });
    b.ownKey.getClientEntry.mockRejectedValue(new Error('OWN_KEY_NOT_ACTIVE'));
    const res = await b.service.createPaymentIntentForOrder('u1', 'o1');
    expect(res).toMatchObject({ route: 'CONNECT_DIRECT' });
    expect(b.orders.recordPaymentNote).toHaveBeenCalledTimes(1);
    expect(b.orders.recordPaymentNote).toHaveBeenCalledWith(
      'o1',
      'PAYMENT_INTENT_ABANDONED',
      expect.stringContaining('abandoned_unreachable'),
    );
    expect(b.platform.paymentIntents.create).toHaveBeenCalled();
  });

  it('route switch: an unreadable previous intent -> 409 PAYMENT_ROUTE_CHANGED_RETRY', async () => {
    const b = build({
      order: { payment_route: 'CONNECT_DIRECT', stripe_account_id: 'acct_1' },
    });
    b.platform.paymentIntents.retrieve.mockRejectedValueOnce(
      new Error('network'),
    );
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1'),
    ).rejects.toMatchObject({
      response: { code: 'PAYMENT_ROUTE_CHANGED_RETRY' },
    });
    expect(b.merchant.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('route switch: a previous intent that cannot be canceled -> 409', async () => {
    const b = build({
      order: { payment_route: 'CONNECT_DIRECT', stripe_account_id: 'acct_1' },
    });
    b.platform.paymentIntents.retrieve.mockResolvedValueOnce({
      id: 'pi_1',
      status: 'requires_payment_method',
      amount: 29900,
      currency: 'sek',
      client_secret: 'cs_old',
      metadata: { order_id: 'o1' },
    } as never);
    b.platform.paymentIntents.cancel.mockRejectedValueOnce(new Error('nope'));
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1'),
    ).rejects.toMatchObject({
      response: { code: 'PAYMENT_ROUTE_CHANGED_RETRY' },
    });
    expect(b.merchant.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('an order paid with a replaced key is read back with that key', async () => {
    const b = build({ order: { stripe_key_fingerprint: 'fp_old' } as never });
    await b.service.reconcilePayment('o1');
    expect(b.ownKey.getClientEntry).toHaveBeenCalledWith('s1', {
      fingerprint: 'fp_old',
    });
  });
});

describe('PaymentsService hardening — confirm / reconcile', () => {
  const unconfirmed = {
    id: 'pi_1',
    status: 'requires_payment_method',
    metadata: { order_id: 'o1' },
  };

  it('a never-confirmed intent (no last_payment_error) keeps the order open', async () => {
    const b = build();
    b.merchant.paymentIntents.retrieve.mockResolvedValueOnce(
      unconfirmed as never,
    );
    await expect(b.service.confirmOrderPayment('u1', 'o1')).resolves.toEqual({
      payment_status: 'awaiting_payment',
      intent_status: 'requires_payment_method',
    });
    expect(b.orders.markOrderFailed).not.toHaveBeenCalled();
  });

  it('processing: flags payment_processing_at so the sweep skips the order', async () => {
    const b = build();
    b.merchant.paymentIntents.retrieve.mockResolvedValueOnce({
      ...unconfirmed,
      status: 'processing',
    } as never);
    await b.service.reconcilePayment('o1');
    expect(b.prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'o1',
          payment_processing_at: null,
        }),
        data: { payment_processing_at: expect.any(Date) },
      }),
    );
  });

  it('own key revoked / removed: awaiting_payment + code, no 500', async () => {
    const b = build();
    b.ownKey.getClientEntry.mockRejectedValueOnce(new Error('gone'));
    await expect(b.service.confirmOrderPayment('u1', 'o1')).resolves.toEqual({
      payment_status: 'awaiting_payment',
      code: 'OWN_KEY_NOT_ACTIVE',
    });
  });
});

describe('PaymentsService hardening — webhooks', () => {
  const paidPayload = {
    id: 'pi_1',
    status: 'succeeded',
    metadata: { order_id: 'o1' },
    amount_received: 29900,
    currency: 'sek',
    latest_charge: 'ch_1',
  };

  it('key revoked after payment: the store endpoint finishes the order from the verified payload', async () => {
    const b = build();
    b.ownKey.getClientEntry.mockRejectedValue(new Error('not active'));
    await b.service.handleWebhookEvent(
      event('payment_intent.succeeded', paidPayload),
      { ownKeyStoreId: 's1' },
    );
    expect(b.orders.markOrderPaid).toHaveBeenCalledWith('o1', 'pi_1');
  });

  it('payload fallback still checks amount, intent id and endpoint', async () => {
    const b = build();
    b.ownKey.getClientEntry.mockRejectedValue(new Error('not active'));
    await b.service.handleWebhookEvent(
      event('payment_intent.succeeded', {
        ...paidPayload,
        amount_received: 100,
      }),
      { ownKeyStoreId: 's1' },
    );
    await b.service.handleWebhookEvent(
      event('payment_intent.succeeded', { ...paidPayload, id: 'pi_other' }),
      { ownKeyStoreId: 's1' },
    );
    expect(b.orders.markOrderPaid).not.toHaveBeenCalled();
    // Platform endpoint: never touches the OWN_KEY order at all.
    await b.service.handleWebhookEvent(
      event('payment_intent.succeeded', paidPayload),
    );
    expect(b.orders.markOrderPaid).not.toHaveBeenCalled();
  });

  it('a succeeded OLD intent never pays the order; the owner is told to refund it', async () => {
    const b = build();
    b.prisma.store.findUnique.mockResolvedValue({
      creator: { user_id: 'owner' },
    } as never);
    b.merchant.paymentIntents.retrieve.mockResolvedValueOnce({
      ...paidPayload,
      id: 'pi_old',
    } as never);
    await b.service.handleWebhookEvent(
      event('payment_intent.succeeded', { ...paidPayload, id: 'pi_old' }),
      { ownKeyStoreId: 's1' },
    );
    expect(b.orders.markOrderPaid).not.toHaveBeenCalled();
    expect(b.orders.recordPaymentNote).toHaveBeenCalledWith(
      'o1',
      'PAYMENT_STALE_INTENT',
      expect.stringContaining('pi_old'),
    );
    expect(b.notifications.create).toHaveBeenCalledWith(
      'owner',
      'order_payment_stale_intent',
      expect.any(String),
      expect.any(String),
      { order_id: 'o1' },
    );
  });

  it('an OLD intent paid with another amount is still flagged PAYMENT_STALE_INTENT', async () => {
    const b = build();
    b.prisma.store.findUnique.mockResolvedValue({
      creator: { user_id: 'owner' },
    } as never);
    const old = {
      ...paidPayload,
      id: 'pi_old',
      amount_received: 19900,
      amount: 19900,
    };
    b.merchant.paymentIntents.retrieve.mockResolvedValueOnce(old as never);
    await b.service.handleWebhookEvent(
      event('payment_intent.succeeded', old),
      { ownKeyStoreId: 's1' },
    );
    expect(b.orders.markOrderPaid).not.toHaveBeenCalled();
    expect(b.orders.recordPaymentNote).toHaveBeenCalledWith(
      'o1',
      'PAYMENT_STALE_INTENT',
      expect.stringContaining('pi_old'),
    );
    expect(b.notifications.create).toHaveBeenCalledWith(
      'owner',
      'order_payment_stale_intent',
      expect.any(String),
      expect.any(String),
      { order_id: 'o1' },
    );
  });

  it('payment_failed of an old intent never fails the order', async () => {
    const b = build();
    await b.service.handleWebhookEvent(
      event('payment_intent.payment_failed', {
        id: 'pi_old',
        metadata: { order_id: 'o1' },
      }),
      { ownKeyStoreId: 's1' },
    );
    expect(b.orders.markOrderFailed).not.toHaveBeenCalled();
  });

  it('payment_intent.processing sets payment_processing_at', async () => {
    const b = build();
    await b.service.handleWebhookEvent(
      event('payment_intent.processing', succeededPi),
      { ownKeyStoreId: 's1' },
    );
    expect(b.prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { payment_processing_at: expect.any(Date) },
      }),
    );
  });

  it('verifies with the retained previous endpoint secret too', async () => {
    const b = build();
    b.ownKey.getWebhookSecrets.mockResolvedValueOnce([
      'whsec_current',
      WEBHOOK_SECRET,
    ]);
    const payload = JSON.stringify({
      id: 'evt_2',
      object: 'event',
      type: 'payment_intent.processing',
      data: { object: { id: 'pi_1', metadata: { order_id: 'o1' } } },
    });
    const ev = await b.service.constructStoreWebhookEvent(
      's1',
      Buffer.from(payload),
      signHeader({ payload, secret: WEBHOOK_SECRET }),
    );
    expect(ev.id).toBe('evt_2');
  });

  it('a missing signature is refused before any lookup', async () => {
    const b = build();
    await expect(
      b.service.constructStoreWebhookEvent('s1', Buffer.from('{}'), ''),
    ).rejects.toThrow('Missing stripe-signature header');
    expect(b.ownKey.getWebhookSecrets).not.toHaveBeenCalled();
  });
});

describe('PaymentsService hardening — refunds', () => {
  const withRefunds = (b: ReturnType<typeof build>, data: unknown[]) => {
    (b.merchant as unknown as { refunds: unknown }).refunds = {
      list: jest.fn(() => Promise.resolve({ data })),
    };
  };
  const charge = {
    id: 'ch_1',
    payment_intent: 'pi_1',
    amount: 29900,
    amount_captured: 29900,
    currency: 'sek',
  };

  it('only succeeded refunds count (a pending one is ignored)', async () => {
    const b = build({ order: { payment_status: 'paid' } });
    b.merchant.charges.retrieve.mockResolvedValueOnce({
      ...charge,
      refunded: true,
      amount_refunded: 29900,
    } as never);
    withRefunds(b, [
      { status: 'succeeded', amount: 5000 },
      { status: 'pending', amount: 24900 },
    ]);
    await b.service.handleWebhookEvent(event('charge.refunded', charge), {
      ownKeyStoreId: 's1',
    });
    expect(b.orders.markOrderRefunded).not.toHaveBeenCalled();
    expect(b.orders.recordPartialRefund).toHaveBeenCalledWith(
      'o1',
      50,
      'sek',
      'Stripe',
      { cumulativeRefunded: 50, storeId: 's1' },
    );
  });

  it('refund.failed: timeline note + owner notice; a REFUNDED order goes back to paid', async () => {
    const b = build({ order: { payment_status: 'refunded' } });
    b.prisma.store.findUnique.mockResolvedValue({
      creator: { user_id: 'owner' },
    } as never);
    b.merchant.charges.retrieve.mockResolvedValueOnce({
      ...charge,
      refunded: false,
      amount_refunded: 0,
    } as never);
    withRefunds(b, [{ status: 'failed', amount: 29900 }]);
    await b.service.handleWebhookEvent(
      event('refund.failed', {
        id: 're_1',
        charge: 'ch_1',
        payment_intent: 'pi_1',
        status: 'failed',
        amount: 29900,
        currency: 'sek',
        failure_reason: 'expired_or_canceled_card',
      }),
      { ownKeyStoreId: 's1' },
    );
    expect(b.orders.recordPaymentNote).toHaveBeenCalledWith(
      'o1',
      'REFUND_FAILED',
      expect.stringContaining('re_1'),
    );
    expect(b.orders.revertRefund).toHaveBeenCalledWith(
      'o1',
      expect.any(String),
    );
    expect(b.orders.markOrderRefunded).not.toHaveBeenCalled();
    const types = b.notifications.create.mock.calls.map(
      (c) => (c as unknown[])[1],
    );
    expect(types).toEqual(
      expect.arrayContaining(['order_refund_failed', 'order_refund_reverted']),
    );
  });

  it('own key unavailable: refund events are acknowledged, not retried forever', async () => {
    const b = build({ order: { payment_status: 'paid' } });
    b.ownKey.getClientEntry.mockRejectedValue(new Error('gone'));
    await expect(
      b.service.handleWebhookEvent(event('charge.refunded', charge), {
        ownKeyStoreId: 's1',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('PaymentsService hardening — abandonment sweep check', () => {
  const order = {
    id: 'o1',
    store_id: 's1',
    payment_route: 'OWN_KEY',
    stripe_account_id: null,
    stripe_payment_id: 'pi_1',
    stripe_key_fingerprint: 'fp_current',
  };
  const pi = (status: string) =>
    ({ id: 'pi_1', status, metadata: { order_id: 'o1' } }) as never;

  it('registers itself with the orders sweep', () => {
    const b = build();
    b.service.onModuleInit();
    expect(b.orders.registerAbandonedPaymentChecker).toHaveBeenCalledWith(
      expect.any(Function),
    );
  });

  it('succeeded -> paid (marked paid now)', async () => {
    const b = build();
    await expect(b.service.checkAbandonedOrder(order)).resolves.toBe('paid');
    expect(b.orders.markOrderPaid).toHaveBeenCalledWith('o1', 'pi_1');
  });

  it('processing / requires_action -> keep', async () => {
    const b = build();
    b.merchant.paymentIntents.retrieve.mockResolvedValueOnce(pi('processing'));
    await expect(b.service.checkAbandonedOrder(order)).resolves.toBe('keep');
    expect(b.prisma.order.updateMany).toHaveBeenCalled();
    b.merchant.paymentIntents.retrieve.mockResolvedValueOnce(
      pi('requires_action'),
    );
    await expect(b.service.checkAbandonedOrder(order)).resolves.toBe('keep');
    expect(b.orders.markOrderFailed).not.toHaveBeenCalled();
  });

  it('abandoned intent: canceled first, then fail; a cancel failure keeps it', async () => {
    const b = build();
    b.merchant.paymentIntents.retrieve.mockResolvedValueOnce(
      pi('requires_payment_method'),
    );
    await expect(b.service.checkAbandonedOrder(order)).resolves.toBe('fail');
    expect(b.merchant.paymentIntents.cancel).toHaveBeenCalledWith(
      'pi_1',
      { cancellation_reason: 'abandoned' },
      undefined,
    );
    b.merchant.paymentIntents.retrieve.mockResolvedValueOnce(
      pi('requires_payment_method'),
    );
    b.merchant.paymentIntents.cancel.mockRejectedValueOnce(
      new Error('just paid'),
    );
    await expect(b.service.checkAbandonedOrder(order)).resolves.toBe('keep');
  });

  it('past 48 h: requires_action is canceled + failed; unreadable -> fail', async () => {
    const b = build();
    b.merchant.paymentIntents.retrieve.mockResolvedValueOnce(
      pi('requires_action'),
    );
    await expect(
      b.service.checkAbandonedOrder(order, { hardCap: true }),
    ).resolves.toBe('fail');
    expect(b.merchant.paymentIntents.cancel).toHaveBeenCalledWith(
      'pi_1',
      { cancellation_reason: 'abandoned' },
      undefined,
    );
    // Own key unavailable past the cap: released (late-pay path covers it).
    b.ownKey.getClientEntry.mockRejectedValueOnce(new Error('gone'));
    await expect(
      b.service.checkAbandonedOrder(order, { hardCap: true }),
    ).resolves.toBe('fail');
    // A cancel failure past the cap no longer keeps it.
    b.merchant.paymentIntents.retrieve.mockResolvedValueOnce(
      pi('requires_payment_method'),
    );
    b.merchant.paymentIntents.cancel.mockRejectedValueOnce(new Error('nope'));
    await expect(
      b.service.checkAbandonedOrder(order, { hardCap: true }),
    ).resolves.toBe('fail');
    // A succeeded payment still wins.
    await expect(
      b.service.checkAbandonedOrder(order, { hardCap: true }),
    ).resolves.toBe('paid');
  });

  it('processing: kept past 48 h, released after 7 days (cancel attempted)', async () => {
    const b = build();
    b.merchant.paymentIntents.retrieve.mockResolvedValueOnce(pi('processing'));
    await expect(
      b.service.checkAbandonedOrder(order, { hardCap: true }),
    ).resolves.toBe('keep');
    b.merchant.paymentIntents.retrieve.mockResolvedValueOnce(pi('processing'));
    b.merchant.paymentIntents.cancel.mockRejectedValueOnce(
      new Error('cannot cancel a processing intent'),
    );
    await expect(
      b.service.checkAbandonedOrder(order, {
        hardCap: true,
        processingExpired: true,
      }),
    ).resolves.toBe('fail');
    expect(b.merchant.paymentIntents.cancel).toHaveBeenCalled();
  });

  it('own key revoked / missing or Stripe unreachable -> keep; unknown intent -> fail', async () => {
    const b = build();
    b.ownKey.getClientEntry.mockRejectedValueOnce(new Error('gone'));
    await expect(b.service.checkAbandonedOrder(order)).resolves.toBe('keep');
    b.merchant.paymentIntents.retrieve.mockRejectedValueOnce(
      new Error('timeout'),
    );
    await expect(b.service.checkAbandonedOrder(order)).resolves.toBe('keep');
    b.merchant.paymentIntents.retrieve.mockRejectedValueOnce(
      stripeErr(404, 'No such payment_intent'),
    );
    await expect(b.service.checkAbandonedOrder(order)).resolves.toBe('fail');
  });
});

describe('PaymentsController create-intent X-Storefront-Viewer', () => {
  function controller(viewer: unknown, owner: boolean) {
    const payments = {
      createPaymentIntentForOrder: jest.fn(
        async (
          _u: string,
          _o: string,
          canPreview?: (storeId: string) => Promise<boolean>,
        ) => ({ preview: canPreview ? await canPreview('s1') : null }),
      ),
    };
    const gate = {
      viewerFromHeader: jest.fn(() => Promise.resolve(viewer)),
      isOwnerOrAdmin: jest.fn(() => Promise.resolve(owner)),
    };
    const ctrl = new PaymentsController(
      payments as never,
      {} as never,
      gate as never,
    );
    return { ctrl, payments, gate };
  }

  it('owner token -> preview allowed; checked against the order store', async () => {
    const viewer = { kind: 'edit-hint', store_id: 's1', user_id: 'owner' };
    const c = controller(viewer, true);
    const res = await c.ctrl.createIntent('u1', { order_id: 'o1' }, 'Bearer tok');
    expect(c.gate.viewerFromHeader).toHaveBeenCalledWith('Bearer tok');
    expect(c.gate.isOwnerOrAdmin).toHaveBeenCalledWith('s1', viewer);
    expect(res).toEqual({ preview: true });
  });

  it('no header / invalid token -> no preview callback at all', async () => {
    const c = controller(null, true);
    const res = await c.ctrl.createIntent('u1', { order_id: 'o1' }, undefined);
    expect(res).toEqual({ preview: null });
    expect(c.gate.isOwnerOrAdmin).not.toHaveBeenCalled();
  });

  it('customer / other-store token -> preview denied', async () => {
    const c = controller({ id: 'cust', role: UserRole.CUSTOMER }, false);
    const res = await c.ctrl.createIntent('u1', { order_id: 'o1' }, 'Bearer x');
    expect(res).toEqual({ preview: false });
  });
});

// ── FIXES-1 (2026-11-08): test orders + owner pre-live checkout ───────────

describe('PaymentsService FIXES-1 — test orders and pre-live checkout', () => {
  const draftStore = { ...independentNoConnect, status: 'DRAFT', is_active: false };
  const owner = () => jest.fn(() => Promise.resolve(true));
  const testMode = (b: ReturnType<typeof build>) => {
    testKey(b);
    b.ownKey.getMode.mockResolvedValue({ status: 'ACTIVE', livemode: false });
    b.ownKey.getClientEntry.mockResolvedValue({
      client: b.merchant,
      fingerprint: 'fp_test',
      previous: false,
      livemode: false,
    });
  };
  const updateData = (b: ReturnType<typeof build>) =>
    (b.prisma.order.update.mock.calls as unknown as [
      { data: Record<string, unknown> },
    ][])
      .map((c) => c[0].data)
      .find((d) => 'payment_route' in d);

  it('a TEST-key payment on a LIVE store marks the order is_test', async () => {
    const b = build({
      store: independentNoConnect,
      order: { stripe_payment_id: null },
    });
    testMode(b);
    const res = await b.service.createPaymentIntentForOrder('u1', 'o1', owner());
    expect(res).toMatchObject({ route: 'OWN_KEY' });
    expect(updateData(b)).toMatchObject({
      payment_route: 'OWN_KEY',
      is_test: true,
    });
  });

  it('a live-key payment never writes is_test', async () => {
    const b = build({ order: { stripe_payment_id: null } });
    await b.service.createPaymentIntentForOrder('u1', 'o1');
    expect(updateData(b)).not.toHaveProperty('is_test');
  });

  it('a non-LIVE store refuses a real (non-test) order with STORE_NOT_LIVE', async () => {
    const b = build({ store: draftStore, order: { stripe_payment_id: null } });
    testMode(b);
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1', owner()),
    ).rejects.toMatchObject({ response: { code: 'STORE_NOT_LIVE' } });
    expect(b.merchant.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('a non-LIVE store takes the owner test order on the TEST own key', async () => {
    const b = build({
      store: draftStore,
      order: { stripe_payment_id: null, is_test: true },
    });
    testMode(b);
    const res = await b.service.createPaymentIntentForOrder('u1', 'o1', owner());
    expect(res).toMatchObject({ route: 'OWN_KEY' });
    expect(updateData(b)).toMatchObject({ is_test: true });
  });

  it('a non-LIVE store refuses the test order without an owner viewer or with a live key', async () => {
    const anon = build({
      store: draftStore,
      order: { stripe_payment_id: null, is_test: true },
    });
    testMode(anon);
    await expect(
      anon.service.createPaymentIntentForOrder('u1', 'o1'),
    ).rejects.toMatchObject({ response: { code: 'STORE_NOT_LIVE' } });

    const live = build({
      store: draftStore,
      order: { stripe_payment_id: null, is_test: true },
    });
    // Live key (default mocks): route OWN_KEY but livemode true.
    await expect(
      live.service.createPaymentIntentForOrder('u1', 'o1', owner()),
    ).rejects.toMatchObject({ response: { code: 'STORE_NOT_LIVE' } });
    expect(live.merchant.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('an order item whose product was deleted -> 409 CART_ITEMS_UNAVAILABLE, order failed', async () => {
    const b = build({ order: { stripe_payment_id: null } });
    b.prisma.order.findUnique.mockResolvedValueOnce({
      id: 'o1',
      store_id: 's1',
      total: 299,
      currency: 'SEK',
      payment_status: 'awaiting_payment',
      customer: { user_id: 'u1' },
      items: [
        {
          fulfiller_type: FulfillerType.CREATOR,
          fulfiller_id: 'c1',
          quantity: 1,
          product_id: 'p-ok',
          variant_id: null,
          custom_product_id: null,
          product: { status: 'PUBLISHED' },
          variant: null,
          custom_product: null,
        },
        {
          fulfiller_type: FulfillerType.CREATOR,
          fulfiller_id: 'c1',
          quantity: 1,
          product_id: 'p-archived',
          variant_id: null,
          custom_product_id: null,
          product: { status: 'ARCHIVED' },
          variant: null,
          custom_product: null,
        },
      ],
    } as never);
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1'),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'CART_ITEMS_UNAVAILABLE',
        unavailable: [{ product_id: 'p-archived' }],
      },
    });
    expect(b.orders.markOrderFailed).toHaveBeenCalledWith(
      'o1',
      expect.any(String),
    );
    expect(b.merchant.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('public config of a non-LIVE store never offers Kustom to the owner preview', async () => {
    const b = build({
      store: {
        ...draftStore,
        creator: {
          ...independentNoConnect.creator,
          kustom_enabled: true,
          kustom_merchant_id: 'm1',
          kustom_onboarding_status: 'COMPLETE',
        },
      },
    });
    testMode(b);
    const cfg = await b.service.getPublicConfig('shop', undefined, false, owner());
    expect(cfg).toMatchObject({ route: 'OWN_KEY', kustomEnabled: false });
  });
});

describe('PaymentsService FIXES-1 audit — SF1 / SF2', () => {
  const draftStore = { ...independentNoConnect, status: 'DRAFT', is_active: false };
  const archivedItem = {
    fulfiller_type: FulfillerType.CREATOR,
    fulfiller_id: 'c1',
    quantity: 1,
    product_id: 'p-archived',
    variant_id: null,
    custom_product_id: null,
    product: { status: 'ARCHIVED' },
    variant: null,
    custom_product: null,
  };

  it('SF1: an order with a PaymentIntent in flight is never failed for unavailable items', async () => {
    const b = build();
    b.prisma.order.findUnique.mockResolvedValue({
      id: 'o1',
      order_number: 'MS-1',
      store_id: 's1',
      total: 299,
      currency: 'SEK',
      payment_route: 'OWN_KEY',
      payment_status: 'awaiting_payment',
      stripe_payment_id: 'pi_1',
      customer: { user_id: 'u1' },
      customer_type: 'PERSON',
      items: [archivedItem],
    } as never);
    await b.service.createPaymentIntentForOrder('u1', 'o1').catch(() => undefined);
    expect(b.orders.markOrderFailed).not.toHaveBeenCalled();
  });

  it('SF2: a non-LIVE store refuses when the client built is a LIVE key (key-swap race)', async () => {
    const b = build({
      store: draftStore,
      order: { stripe_payment_id: null, is_test: true },
    });
    testKey(b);
    // The DB row still says TEST, but the client entry is a live key.
    b.ownKey.getMode.mockResolvedValue({ status: 'ACTIVE', livemode: false });
    await expect(
      b.service.createPaymentIntentForOrder('u1', 'o1', () =>
        Promise.resolve(true),
      ),
    ).rejects.toMatchObject({ response: { code: 'STORE_NOT_LIVE' } });
    expect(b.merchant.paymentIntents.create).not.toHaveBeenCalled();
  });
});
