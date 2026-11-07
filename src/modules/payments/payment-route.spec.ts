import { StoreType } from '@prisma/client';
import {
  isOwnKeyCardReady,
  isOwnKeyTestMode,
  isStripeAuthError,
  redactStripeSecrets,
  resolvePaymentRoute,
  routeOfOrder,
} from './payment-route';

describe('payment route resolver', () => {
  it('INDEPENDENT + active own key -> OWN_KEY', () => {
    expect(
      resolvePaymentRoute({
        storeType: StoreType.INDEPENDENT,
        ownKeyActive: true,
      }),
    ).toBe('OWN_KEY');
  });

  it('INDEPENDENT without an active own key -> CONNECT_DIRECT', () => {
    expect(
      resolvePaymentRoute({
        storeType: StoreType.INDEPENDENT,
        ownKeyActive: false,
      }),
    ).toBe('CONNECT_DIRECT');
  });

  it('MARKETPLACE (even with an active key row) and no store -> PLATFORM', () => {
    expect(
      resolvePaymentRoute({
        storeType: StoreType.MARKETPLACE,
        ownKeyActive: true,
      }),
    ).toBe('PLATFORM');
    expect(resolvePaymentRoute({ storeType: null, ownKeyActive: false })).toBe(
      'PLATFORM',
    );
  });
});

describe('routeOfOrder', () => {
  it('uses payment_route when set', () => {
    expect(routeOfOrder({ payment_route: 'OWN_KEY' })).toBe('OWN_KEY');
    expect(
      routeOfOrder({ payment_route: 'PLATFORM', stripe_account_id: 'acct_1' }),
    ).toBe('PLATFORM');
  });

  it('legacy null: account snapshot -> CONNECT_DIRECT, else PLATFORM', () => {
    expect(
      routeOfOrder({ payment_route: null, stripe_account_id: 'acct_1' }),
    ).toBe('CONNECT_DIRECT');
    expect(routeOfOrder({ payment_route: null, stripe_account_id: null })).toBe(
      'PLATFORM',
    );
    expect(routeOfOrder({})).toBe('PLATFORM');
  });

  it('unknown values fall back to the legacy rule', () => {
    expect(routeOfOrder({ payment_route: 'BOGUS' })).toBe('PLATFORM');
  });
});

describe('own key helpers', () => {
  it('card-ready only for INDEPENDENT with an ACTIVE key row', () => {
    expect(
      isOwnKeyCardReady({
        store_type: StoreType.INDEPENDENT,
        stripe_keys: { status: 'ACTIVE', livemode: true },
      }),
    ).toBe(true);
    // A TEST key never counts for the public checkout; only for the owner /
    // an admin previewing the store.
    const testKey = {
      store_type: StoreType.INDEPENDENT,
      stripe_keys: { status: 'ACTIVE', livemode: false },
    };
    expect(isOwnKeyCardReady(testKey)).toBe(false);
    expect(isOwnKeyCardReady(testKey, { allowTest: true })).toBe(true);
    expect(isOwnKeyTestMode(testKey)).toBe(true);
    expect(
      isOwnKeyTestMode({
        store_type: StoreType.INDEPENDENT,
        stripe_keys: { status: 'ACTIVE', livemode: true },
      }),
    ).toBe(false);
    expect(
      isOwnKeyCardReady({
        store_type: StoreType.INDEPENDENT,
        stripe_keys: { status: 'NEEDS_RECONNECT' },
      }),
    ).toBe(false);
    expect(
      isOwnKeyCardReady({
        store_type: StoreType.MARKETPLACE,
        stripe_keys: { status: 'ACTIVE' },
      }),
    ).toBe(false);
    expect(
      isOwnKeyCardReady({
        store_type: StoreType.INDEPENDENT,
        stripe_keys: null,
      }),
    ).toBe(false);
  });

  it('detects Stripe 401s', () => {
    expect(isStripeAuthError({ statusCode: 401 })).toBe(true);
    expect(isStripeAuthError({ type: 'StripeAuthenticationError' })).toBe(true);
    expect(isStripeAuthError({ statusCode: 403 })).toBe(false);
    expect(isStripeAuthError(new Error('x'))).toBe(false);
    expect(isStripeAuthError(null)).toBe(false);
  });

  it('redacts secrets from messages', () => {
    expect(
      redactStripeSecrets('Invalid API Key provided: rk_live_abc123XYZ'),
    ).toBe('Invalid API Key provided: rk_***');
    expect(redactStripeSecrets('whsec_abc and sk_test_123')).toBe(
      'whsec_*** and sk_***',
    );
  });
});
