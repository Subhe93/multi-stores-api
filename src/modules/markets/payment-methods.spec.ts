import { BadRequestException } from '@nestjs/common';
import {
  MARKET_PAYMENT_METHODS,
  marketAllowsMethod,
  marketPaymentMethodNotAllowed,
  normalizePaymentMethods,
  parsePaymentMethods,
  paymentCheckPassesFor,
  paymentMethodOfOrder,
  samePaymentMethods,
} from './payment-methods';
import { paymentCheckPasses } from './payment-check.service';
import type { PaymentCheck, PaymentProviderCheck } from './market.types';

// M157: pure helpers of the per-market payment methods.

function bodyOf(fn: () => unknown): Record<string, unknown> {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse() as Record<
      string,
      unknown
    >;
  }
  throw new Error('expected a BadRequestException');
}

function check(
  stripe: PaymentProviderCheck,
  kustom: PaymentProviderCheck,
): PaymentCheck {
  return { stripe, kustom, checked_at: '2026-11-21T00:00:00Z', details: {} };
}

describe('normalizePaymentMethods (M157)', () => {
  it('null passes through (clear = the store methods)', () => {
    expect(normalizePaymentMethods(null)).toBeNull();
  });

  it('accepts known methods, trims and lower-cases, sorts in contract order', () => {
    expect(normalizePaymentMethods(['card'])).toEqual(['card']);
    expect(normalizePaymentMethods([' Kustom ', 'CARD'])).toEqual([
      'card',
      'kustom',
    ]);
    expect(normalizePaymentMethods(['cod', 'kustom', 'card'])).toEqual([
      ...MARKET_PAYMENT_METHODS,
    ]);
    expect(normalizePaymentMethods(['kustom', 'card'])).toEqual(
      normalizePaymentMethods(['card', 'kustom']),
    );
  });

  it('unknown value -> MARKET_PAYMENT_METHODS_INVALID / unknown with value', () => {
    expect(bodyOf(() => normalizePaymentMethods(['card', 'paypal']))).toEqual(
      expect.objectContaining({
        code: 'MARKET_PAYMENT_METHODS_INVALID',
        reason: 'unknown',
        value: 'paypal',
      }),
    );
    expect(bodyOf(() => normalizePaymentMethods([1]))).toEqual(
      expect.objectContaining({ reason: 'unknown', value: '1' }),
    );
  });

  it('unknown wins over a duplicate (rule order)', () => {
    expect(
      bodyOf(() => normalizePaymentMethods(['card', 'card', 'x'])).reason,
    ).toBe('unknown');
  });

  it('duplicate -> reason duplicate (also after case folding)', () => {
    expect(bodyOf(() => normalizePaymentMethods(['card', 'CARD']))).toEqual(
      expect.objectContaining({
        code: 'MARKET_PAYMENT_METHODS_INVALID',
        reason: 'duplicate',
      }),
    );
  });

  it('more than 3 entries with a duplicate -> reason duplicate (the DTO only caps abuse)', () => {
    expect(
      bodyOf(() => normalizePaymentMethods(['card', 'card', 'kustom', 'cod'])),
    ).toEqual(
      expect.objectContaining({
        code: 'MARKET_PAYMENT_METHODS_INVALID',
        reason: 'duplicate',
      }),
    );
  });

  it('non-string entries -> reason unknown (never coerced into a method)', () => {
    for (const raw of [null, {}, ['card'], true]) {
      expect(bodyOf(() => normalizePaymentMethods(['card', raw]))).toEqual(
        expect.objectContaining({
          code: 'MARKET_PAYMENT_METHODS_INVALID',
          reason: 'unknown',
        }),
      );
    }
  });

  it('[] -> reason empty (not a synonym for null)', () => {
    expect(bodyOf(() => normalizePaymentMethods([]))).toEqual(
      expect.objectContaining({
        code: 'MARKET_PAYMENT_METHODS_INVALID',
        reason: 'empty',
      }),
    );
  });
});

describe('parsePaymentMethods (M157, fail-closed)', () => {
  it('SQL NULL / undefined -> null (unrestricted)', () => {
    expect(parsePaymentMethods(null)).toBeNull();
    expect(parsePaymentMethods(undefined)).toBeNull();
  });

  it('non-array -> [] (nothing allowed)', () => {
    expect(parsePaymentMethods({})).toEqual([]);
    expect(parsePaymentMethods('card')).toEqual([]);
    expect(parsePaymentMethods(1)).toEqual([]);
  });

  it('drops unknown entries, removes duplicates, sorts', () => {
    expect(parsePaymentMethods(['kustom', 'x', 'card', 'kustom', 3])).toEqual([
      'card',
      'kustom',
    ]);
    expect(parsePaymentMethods(['CARD'])).toEqual([]);
    expect(parsePaymentMethods([])).toEqual([]);
  });
});

describe('marketAllowsMethod (M157)', () => {
  it('no market / unset / undefined -> every method allowed', () => {
    for (const m of MARKET_PAYMENT_METHODS) {
      expect(marketAllowsMethod(null, m)).toBe(true);
      expect(marketAllowsMethod(undefined, m)).toBe(true);
      expect(marketAllowsMethod({}, m)).toBe(true);
      expect(marketAllowsMethod({ paymentMethods: null }, m)).toBe(true);
    }
  });

  it('set -> only the listed methods; [] -> none', () => {
    const eu = { paymentMethods: ['card' as const] };
    expect(marketAllowsMethod(eu, 'card')).toBe(true);
    expect(marketAllowsMethod(eu, 'kustom')).toBe(false);
    expect(marketAllowsMethod(eu, 'cod')).toBe(false);
    for (const m of MARKET_PAYMENT_METHODS) {
      expect(marketAllowsMethod({ paymentMethods: [] }, m)).toBe(false);
    }
  });
});

describe('marketPaymentMethodNotAllowed (M157)', () => {
  it('is a coded 400 naming the method', () => {
    const err = marketPaymentMethodNotAllowed('kustom');
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toEqual(
      expect.objectContaining({
        code: 'MARKET_PAYMENT_METHOD_NOT_ALLOWED',
        method: 'kustom',
      }),
    );
  });
});

describe('paymentMethodOfOrder (M157)', () => {
  it('maps order methods; anything else is card', () => {
    expect(paymentMethodOfOrder('COD')).toBe('cod');
    expect(paymentMethodOfOrder('KUSTOM')).toBe('kustom');
    expect(paymentMethodOfOrder('STRIPE')).toBe('card');
    expect(paymentMethodOfOrder(undefined)).toBe('card');
    expect(paymentMethodOfOrder('SOMETHING')).toBe('card');
  });
});

describe('paymentCheckPassesFor (M157 go-live gate)', () => {
  const states: PaymentProviderCheck[] = ['ok', 'missing', 'unknown'];
  const settings = [
    null,
    ['card'],
    ['kustom'],
    ['cod'],
    ['card', 'kustom'],
    ['card', 'cod'],
    ['kustom', 'cod'],
    ['card', 'kustom', 'cod'],
  ] as const;

  it('full truth table', () => {
    for (const stripe of states) {
      for (const kustom of states) {
        const c = check(stripe, kustom);
        for (const methods of settings) {
          const list = methods as readonly ('card' | 'kustom' | 'cod')[] | null;
          const expected =
            list === null
              ? stripe === 'ok' || kustom === 'ok'
              : (list.includes('card') && stripe === 'ok') ||
                (list.includes('kustom') && kustom === 'ok');
          expect(paymentCheckPassesFor(c, list)).toBe(expected);
        }
      }
    }
  });

  it('null equals the old gate; cod alone never passes; no check never passes', () => {
    for (const stripe of states) {
      for (const kustom of states) {
        const c = check(stripe, kustom);
        expect(paymentCheckPassesFor(c, null)).toBe(paymentCheckPasses(c));
        expect(paymentCheckPassesFor(c, ['cod'])).toBe(false);
      }
    }
    expect(paymentCheckPassesFor(null, null)).toBe(false);
    expect(paymentCheckPassesFor(undefined, ['card'])).toBe(false);
  });

  it('Namez eu: card only, Stripe ok, Kustom ok on paper -> passes; Stripe missing -> fails', () => {
    expect(paymentCheckPassesFor(check('ok', 'ok'), ['card'])).toBe(true);
    expect(paymentCheckPassesFor(check('ok', 'missing'), ['card'])).toBe(true);
    expect(paymentCheckPassesFor(check('missing', 'ok'), ['card'])).toBe(false);
  });
});

describe('samePaymentMethods (M157)', () => {
  it('order-insensitive; null only equals null', () => {
    expect(samePaymentMethods(null, null)).toBe(true);
    expect(samePaymentMethods(null, ['card'])).toBe(false);
    expect(samePaymentMethods(['card'], null)).toBe(false);
    expect(samePaymentMethods(['kustom', 'card'], ['card', 'kustom'])).toBe(
      true,
    );
    expect(samePaymentMethods(['card'], ['card', 'kustom'])).toBe(false);
    expect(samePaymentMethods([], [])).toBe(true);
  });
});
