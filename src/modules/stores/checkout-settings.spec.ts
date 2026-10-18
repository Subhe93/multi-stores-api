import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_CHECKOUT_SETTINGS,
  isDefaultCheckoutSettings,
  normalizeCheckoutSettingsInput,
  publicCheckoutSettings,
  readStoredCheckoutSettings,
} from './checkout-settings';

// M5 W2-A: the store checkout settings validator and the storefront
// projection. The projection must be ABSENT for every store that never
// overrode a default (G0: byte-identical storefront payloads).

describe('normalizeCheckoutSettingsInput', () => {
  it('null / {} / all-default input clears the overrides (stored as NULL)', () => {
    expect(normalizeCheckoutSettingsInput(null)).toBeNull();
    expect(normalizeCheckoutSettingsInput({})).toBeNull();
    expect(
      normalizeCheckoutSettingsInput({
        after_add_to_cart: 'stay',
        phone_required: false,
        pay_button_label: {},
        coupon_param: ['coupon'],
        coupon_autoapply: false,
      }),
    ).toBeNull();
  });

  it('fills omitted keys with the defaults and trims labels / params', () => {
    expect(
      normalizeCheckoutSettingsInput({
        after_add_to_cart: 'checkout',
        pay_button_label: { sv: '  Betala med kort ', en: '   ' },
        coupon_param: [' coupon ', 'coupon1', 'coupon1', ''],
        coupon_autoapply: true,
      }),
    ).toEqual({
      after_add_to_cart: 'checkout',
      phone_required: false,
      pay_button_label: { sv: 'Betala med kort' },
      coupon_param: ['coupon', 'coupon1'],
      coupon_autoapply: true,
    });
  });

  it('an emptied coupon_param list falls back to the default key', () => {
    expect(
      normalizeCheckoutSettingsInput({ coupon_autoapply: true, coupon_param: [''] }),
    ).toEqual({ ...DEFAULT_CHECKOUT_SETTINGS, coupon_autoapply: true });
  });

  it.each([
    ['not an object', 'x'],
    ['unknown key', { nope: 1 }],
    ['bad destination', { after_add_to_cart: 'home' }],
    ['phone_required not boolean', { phone_required: 'yes' }],
    ['coupon_autoapply not boolean', { coupon_autoapply: 1 }],
    ['label not keyed by locale', { pay_button_label: { 'Sv!': 'x' } }],
    ['label not a string', { pay_button_label: { sv: 1 } }],
    ['label too long', { pay_button_label: { sv: 'x'.repeat(61) } }],
    ['coupon_param not an array', { coupon_param: 'coupon' }],
    ['coupon_param bad chars', { coupon_param: ['cou pon'] }],
    ['coupon_param too many', { coupon_param: ['a', 'b', 'c', 'd', 'e', 'f'] }],
  ])('rejects %s with STORE_CHECKOUT_SETTINGS_INVALID', (_label, input) => {
    let caught: unknown;
    try {
      normalizeCheckoutSettingsInput(input);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getResponse()).toMatchObject({
      code: 'STORE_CHECKOUT_SETTINGS_INVALID',
    });
  });
});

describe('readStoredCheckoutSettings / publicCheckoutSettings', () => {
  it('reads a stored row defensively (unknown and malformed keys ignored)', () => {
    expect(
      readStoredCheckoutSettings({
        after_add_to_cart: 'cart',
        phone_required: 'no',
        pay_button_label: { sv: 'Betala', de: '' },
        coupon_param: ['coupon1', 7],
        extra: true,
      }),
    ).toEqual({
      after_add_to_cart: 'cart',
      phone_required: false,
      pay_button_label: { sv: 'Betala' },
      coupon_param: ['coupon1'],
      coupon_autoapply: false,
    });
    expect(readStoredCheckoutSettings('garbage')).toEqual(DEFAULT_CHECKOUT_SETTINGS);
    expect(isDefaultCheckoutSettings(readStoredCheckoutSettings(null))).toBe(true);
  });

  it('G0: NULL and an all-default row project to nothing', () => {
    expect(publicCheckoutSettings(null)).toBeUndefined();
    expect(publicCheckoutSettings(undefined)).toBeUndefined();
    expect(publicCheckoutSettings({ ...DEFAULT_CHECKOUT_SETTINGS })).toBeUndefined();
  });

  it('a store with overrides projects the full normalized object', () => {
    expect(publicCheckoutSettings({ phone_required: true })).toEqual({
      ...DEFAULT_CHECKOUT_SETTINGS,
      phone_required: true,
    });
  });
});
