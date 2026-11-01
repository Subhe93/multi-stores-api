import { CUSTOMER_LOGIN_LINK_TEXT, customerLoginLinkEmail } from './templates';
import {
  NotificationTemplatesService,
  PLATFORM_ONLY_EVENTS,
} from '../notification-templates/notification-templates.service';

const data = {
  name: '<b>Anna</b>',
  magicUrl: 'https://shop.example/auth/magic#token=abc"def',
  loginUrl: 'https://shop.example/auth/login',
  expiresHours: 72,
};

describe('customer_login_link email', () => {
  it('bundles the six locales with identical keys', () => {
    const locales = Object.keys(CUSTOMER_LOGIN_LINK_TEXT).sort();
    expect(locales).toEqual(['ar', 'de', 'en', 'fr', 'sv', 'tr']);
    const keys = Object.keys(CUSTOMER_LOGIN_LINK_TEXT.en).sort();
    for (const l of locales) {
      expect(Object.keys(CUSTOMER_LOGIN_LINK_TEXT[l]).sort()).toEqual(keys);
    }
  });

  it('escapes values, shows the link once, brands with the store', () => {
    const parts = customerLoginLinkEmail(
      data,
      { storeName: 'Shop & Co', storeId: 's1' },
      'sv',
    );
    expect(parts.subject).toBe('Din inloggningslänk till Shop & Co');
    expect(parts.html).not.toContain('<b>Anna</b>');
    expect(parts.html).toContain('&lt;b&gt;Anna&lt;/b&gt;');
    expect(parts.html).toContain('Shop &amp; Co');
    expect(parts.html.split('token=abc&quot;def').length - 1).toBe(1);
    expect(parts.text).toContain(data.magicUrl);
    expect(parts.text).toContain('72');
  });

  it('Arabic renders right-to-left; unknown locales fall back to English', () => {
    expect(customerLoginLinkEmail(data, undefined, 'ar').html).toContain('rtl');
    expect(customerLoginLinkEmail(data, undefined, 'xx').subject).toMatch(
      /^Your login link for /,
    );
  });

  it('is platform-only and listed in the event catalog', () => {
    expect(PLATFORM_ONLY_EVENTS.has('customer_login_link')).toBe(true);
    expect(
      NotificationTemplatesService.EVENT_CATALOG.some(
        (e) => e.event === 'customer_login_link',
      ),
    ).toBe(true);
  });
});
