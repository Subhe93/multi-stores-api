import {
  PLATFORM_EMAIL_LOCALES,
  buildPlatformEmailTemplates,
} from '../../../prisma/platform-email-templates';
import { ONBOARDING_EVENTS } from './onboarding-templates';
import {
  accountCreatedEmail,
  customerLoginLinkEmail,
  passwordResetEmail,
  welcomeEmail,
  ACCOUNT_CREATED_TEXT,
  CUSTOMER_LOGIN_LINK_TEXT,
} from './templates';
import {
  companyPhrases,
  emailPhrases,
  formatPaymentMethod,
  pickLocale,
} from './order-mail.helpers';
import { FOOTER_PHRASES } from './mail.service';
import { TAX_LABEL } from '../taxes/tax-seed';
import { EXEMPT_LABELS, exemptLabel } from '../taxes/tax.service';
import {
  formatEstimatedDays,
  nameStatesDeliveryTime,
} from '../payments/kustom/kustom.mapper';
import { label } from '../themes/apply-chrome';

// Kurdish (Kurmanji, `ku`): every shopper-facing phrase map has its own `ku`
// text (no silent English fallback), keeps the source tokens and stays LTR.

const tokensOf = (s: string): string[] =>
  Array.from(s.match(/\{\{?[a-z_#/ ]+\}?\}/gi) ?? []).sort();

describe('Kurdish (ku) email and shopper texts', () => {
  const all = buildPlatformEmailTemplates();

  it('ku is a platform email locale; onboarding events stay without ku', () => {
    expect(PLATFORM_EMAIL_LOCALES).toContain('ku');
    for (const event of ONBOARDING_EVENTS) {
      expect([event, Object.keys(all[event]).includes('ku')]).toEqual([
        event,
        false,
      ]);
    }
  });

  it('every core and account event has a translated ku text, ltr', () => {
    const events = Object.keys(all).filter(
      (e) => !(ONBOARDING_EVENTS as readonly string[]).includes(e),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        'password_reset',
        'order_confirmation',
        'order_shipped',
        'order_delivered',
        'order_fulfilled',
        'order_cancelled',
        'order_refunded',
        'new_order_owner',
        'welcome',
        'account_created',
      ]),
    );
    for (const event of events) {
      const ku = all[event].ku;
      const en = all[event].en;
      expect([event, Boolean(ku)]).toEqual([event, true]);
      for (const field of ['subject', 'body_html', 'body_text'] as const) {
        expect([event, field, ku[field] === en[field]]).toEqual([
          event,
          field,
          false,
        ]);
      }
      expect(ku.body_html).not.toContain('dir="rtl"');
    }
  });

  it('bundled account emails render Kurmanji with the same values', () => {
    const reset = passwordResetEmail(
      'https://s.example/reset?t=1',
      { storeName: 'Newroj' },
      'ku',
    );
    expect(reset.subject).toBe('Şîfreya xwe ya Newroj nû bikin');
    expect(reset.text).toContain('https://s.example/reset?t=1');
    expect(reset.html).not.toContain('dir="rtl"');

    const welcome = welcomeEmail(
      { name: 'Rojda', loginUrl: 'https://s.example/login' },
      { storeName: 'Newroj' },
      'ku',
    );
    expect(welcome.subject).toBe('Bi xêr hatin bo Newroj');
    expect(welcome.html).toContain('Silav Rojda,');
    expect(welcome.text).toContain('Têkeve: https://s.example/login');

    const created = accountCreatedEmail(
      {
        name: 'Rojda',
        email: 'r@example.com',
        password: 'Pw123456',
        magicUrl: 'https://s.example/magic',
        loginUrl: 'https://s.example/login',
        expiresHours: 72,
      },
      { storeName: 'Newroj' },
      'ku',
    );
    expect(created.subject).toBe('Hesabê we li Newroj');
    expect(created.html).toContain('72 saetan');
    expect(created.html).not.toContain('dir="rtl"');

    const link = customerLoginLinkEmail(
      {
        magicUrl: 'https://s.example/magic',
        loginUrl: 'https://s.example/login',
        expiresHours: 24,
      },
      { storeName: 'Newroj' },
      'ku-IQ',
    );
    expect(link.subject).toBe('Girêdana têketinê ya we ji bo Newroj');
    expect(link.text.startsWith('Silav,')).toBe(true);
  });

  it('ku phrase maps keep the English tokens', () => {
    for (const map of [ACCOUNT_CREATED_TEXT, CUSTOMER_LOGIN_LINK_TEXT]) {
      for (const [key, value] of Object.entries(map.en)) {
        expect([key, tokensOf((map.ku as Record<string, string>)[key])]).toEqual(
          [key, tokensOf(value)],
        );
      }
    }
    for (const [key, value] of Object.entries(FOOTER_PHRASES.en)) {
      expect([
        key,
        tokensOf((FOOTER_PHRASES.ku as Record<string, string>)[key]),
      ]).toEqual([key, tokensOf(value)]);
    }
    expect(companyPhrases('ku').reverseChargeNote).toContain('{vat}');
    expect(emailPhrases('ku').itemN).toContain('{i}');
  });

  it('order phrases, totals and company labels resolve to ku', () => {
    expect(pickLocale('ku')).toBe('ku');
    expect(emailPhrases('ku').subtotal).toBe('Jêrgiştî');
    expect(emailPhrases('ku').viewOrder).not.toBe(emailPhrases('en').viewOrder);
    expect(formatPaymentMethod({ payment_method: 'COD' }, 'ku')).toBe(
      'Dayîn di dema gihandinê de',
    );
    expect(companyPhrases('ku').vatNumber).toBe('Hejmara bacê');
    // Untouched locales keep their text.
    expect(emailPhrases('sv').subtotal).toBe('Delsumma');
    expect(pickLocale('xx')).toBe('en');
  });

  it('tax, Kustom and chrome maps carry ku', () => {
    expect(TAX_LABEL.ku).toBe('Bac');
    expect(EXEMPT_LABELS.REVERSE_CHARGE.ku).toBe('Bacdana berevajî');
    expect(exemptLabel('CUSTOMER_EXEMPT', 'ku')).toBe('Ji bacê azad');
    expect(formatEstimatedDays({ min: 2, max: 4 }, 'ku')).toBe(
      '2–4 rojên kar',
    );
    expect(formatEstimatedDays({ min: 1, max: 1 }, 'ku')).toBe('1 roja kar');
    expect(nameStatesDeliveryTime('Şandina standard (2–4 rojên kar)')).toBe(
      true,
    );
    expect(nameStatesDeliveryTime('Şandina standard')).toBe(false);
    expect(label('home', 'ku')).toBe('Destpêk');
    expect(label('copyright', 'ku')).toContain('{year} {store}');
  });
});
