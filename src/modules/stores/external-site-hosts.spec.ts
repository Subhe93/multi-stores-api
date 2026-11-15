import {
  EXTERNAL_URL_ERROR_CODE,
  ExternalUrlRejected,
  assertExternalHostAllowed,
  externalSiteHosts,
  isExternalHostAllowed,
  parseExternalReturnUrl,
  tryParseExternalReturnUrl,
} from './external-site-hosts';
import {
  DEFAULT_CHECKOUT_SETTINGS,
  normalizeCheckoutSettingsInput,
  publicCheckoutSettings,
  readStoredCheckoutSettings,
  withStoredExternalReturn,
} from './checkout-settings';

// Headless booking P3 (PLAN §7 R-D4): the external site / return URL rules.
// Exact host (or its www twin) only; no registrable-domain fallback.

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExternalUrlRejected) {
      const body = e.getResponse() as { code: string; reason: string };
      expect(body.code).toBe(EXTERNAL_URL_ERROR_CODE);
      return body.reason;
    }
    throw e;
  }
  return undefined;
}

describe('parseExternalReturnUrl', () => {
  it('normalizes a valid https URL (lower-case host, default port dropped)', () => {
    expect(
      parseExternalReturnUrl(
        ' https://WWW.Example.se:443/ ',
        'external_site_url',
      ),
    ).toBe('https://www.example.se/');
    expect(
      parseExternalReturnUrl('https://example.se', 'external_site_url'),
    ).toBe('https://example.se/');
  });

  it('keeps {order_number} literally in the path, query or fragment', () => {
    expect(
      parseExternalReturnUrl(
        'https://example.se/tack?order={order_number}',
        'return_url',
      ),
    ).toBe('https://example.se/tack?order={order_number}');
    expect(
      parseExternalReturnUrl(
        'https://example.se/tack/{order_number}#x',
        'return_url',
      ),
    ).toBe('https://example.se/tack/{order_number}#x');
  });

  it.each([
    ['http scheme', 'http://example.se/', 'https_required'],
    ['javascript scheme', 'javascript:alert(1)', 'https_required'],
    ['protocol-relative', '//example.se/', 'https_required'],
    ['userinfo', 'https://user:pass@example.se/', 'userinfo_not_allowed'],
    ['bare userinfo', 'https://evil.com@example.se/', 'userinfo_not_allowed'],
    ['non-443 port', 'https://example.se:8443/', 'port_not_allowed'],
    ['IPv4 host', 'https://127.0.0.1/', 'host_not_allowed'],
    ['IPv6 host', 'https://[::1]/', 'host_not_allowed'],
    ['single-label host', 'https://localhost/', 'host_not_allowed'],
    [
      'placeholder in host',
      'https://{order_number}.example.se/',
      'placeholder_not_allowed',
    ],
    [
      'other placeholder',
      'https://example.se/?e={email}',
      'placeholder_not_allowed',
    ],
    ['stray brace', 'https://example.se/?a={', 'placeholder_not_allowed'],
    ['whitespace', 'https://example.se/a b', 'invalid_url'],
    ['backslash', 'https://example.se\\@evil.com/', 'invalid_url'],
    ['too long', `https://example.se/${'a'.repeat(500)}`, 'too_long'],
    ['not a string', 42, 'invalid_url'],
  ])('rejects %s', (_label, raw, reason) => {
    expect(reasonOf(() => parseExternalReturnUrl(raw, 'return_url'))).toBe(
      reason,
    );
  });

  it('the site URL never accepts a placeholder', () => {
    expect(
      reasonOf(() =>
        parseExternalReturnUrl(
          'https://example.se/{order_number}',
          'external_site_url',
        ),
      ),
    ).toBe('placeholder_not_allowed');
  });

  it('tryParse returns null instead of throwing', () => {
    expect(
      tryParseExternalReturnUrl('http://example.se', 'return_url'),
    ).toBeNull();
    expect(tryParseExternalReturnUrl(undefined, 'return_url')).toBeNull();
  });
});

describe('external site host check (exact host or www twin)', () => {
  const site = 'https://example.se/';

  it('allows the site host and its www twin, both ways', () => {
    expect(externalSiteHosts(site)).toEqual(['example.se', 'www.example.se']);
    expect(externalSiteHosts('https://www.example.se/')).toEqual([
      'www.example.se',
      'example.se',
    ]);
    expect(
      isExternalHostAllowed(
        'https://www.example.se/tack?o={order_number}',
        site,
      ),
    ).toBe(true);
    expect(
      isExternalHostAllowed('https://example.se/x', 'https://www.example.se/'),
    ).toBe(true);
  });

  it.each([
    ['foreign host', 'https://evil.com/'],
    ['subdomain of the site', 'https://shop.example.se/'],
    ['suffix trick', 'https://example.se.evil.com/'],
    ['prefix trick', 'https://notexample.se/'],
  ])('rejects %s', (_label, url) => {
    expect(reasonOf(() => assertExternalHostAllowed(url, site))).toBe(
      'host_not_allowed',
    );
  });

  it('co.uk-style hosts: no registrable-domain fallback', () => {
    const uk = 'https://shop.example.co.uk/';
    expect(isExternalHostAllowed('https://www.shop.example.co.uk/', uk)).toBe(
      true,
    );
    for (const url of [
      'https://example.co.uk/',
      'https://evil.co.uk/',
      'https://other.example.co.uk/',
      'https://www.example.co.uk/',
    ]) {
      expect(reasonOf(() => assertExternalHostAllowed(url, uk))).toBe(
        'host_not_allowed',
      );
    }
  });

  it('without a site URL every return target is refused', () => {
    expect(
      reasonOf(() => assertExternalHostAllowed('https://example.se/', null)),
    ).toBe('external_site_url_required');
  });
});

describe('checkout_settings external return keys', () => {
  it('normalizes a full external setup', () => {
    expect(
      normalizeCheckoutSettingsInput({
        external_site_url: 'https://Example.se',
        return_url: 'https://www.example.se/tack?order={order_number}',
        return_mode: 'auto',
        back_label: { sv: ' Tillbaka till Prima ', en: '' },
      }),
    ).toStrictEqual({
      ...DEFAULT_CHECKOUT_SETTINGS,
      external_site_url: 'https://example.se/',
      return_url: 'https://www.example.se/tack?order={order_number}',
      return_mode: 'auto',
      back_label: { sv: 'Tillbaka till Prima' },
    });
  });

  it('a foreign or co.uk-style return host is a 400 CHECKOUT_EXTERNAL_URL_NOT_ALLOWED', () => {
    for (const [siteUrl, ret] of [
      ['https://example.se', 'https://evil.com/tack'],
      ['https://shop.example.co.uk', 'https://evil.co.uk/tack'],
    ]) {
      expect(
        reasonOf(() =>
          normalizeCheckoutSettingsInput({
            external_site_url: siteUrl,
            return_url: ret,
          }),
        ),
      ).toBe('host_not_allowed');
    }
  });

  it.each([
    ['http', 'http://example.se'],
    ['userinfo', 'https://a@example.se'],
    ['non-443 port', 'https://example.se:8080'],
  ])('rejects a %s site URL', (_label, url) => {
    expect(
      reasonOf(() =>
        normalizeCheckoutSettingsInput({ external_site_url: url }),
      ),
    ).toBeDefined();
  });

  it('a return_url without a site URL is refused', () => {
    expect(
      reasonOf(() =>
        normalizeCheckoutSettingsInput({ return_url: 'https://example.se/' }),
      ),
    ).toBe('external_site_url_required');
  });

  it('mode / label without a site fall back to defaults (no stored change)', () => {
    expect(
      normalizeCheckoutSettingsInput({
        external_site_url: '',
        return_mode: 'auto',
        back_label: { sv: 'Tillbaka' },
      }),
    ).toBeNull();
  });

  it('rejects an unknown return_mode', () => {
    expect(() =>
      normalizeCheckoutSettingsInput({
        external_site_url: 'https://example.se',
        return_mode: 'instant',
      }),
    ).toThrow();
  });

  it('a hand-edited stored row is re-checked on read', () => {
    const read = readStoredCheckoutSettings({
      external_site_url: 'https://example.se/',
      return_url: 'https://evil.com/tack',
      return_mode: 'auto',
    });
    expect(read.external_site_url).toBe('https://example.se/');
    expect(read.return_url).toBeNull();
    expect(read.return_mode).toBe('auto');

    const bad = readStoredCheckoutSettings({
      external_site_url: 'http://example.se/',
      return_url: 'https://example.se/tack',
      return_mode: 'auto',
      back_label: { sv: 'x' },
    });
    expect(bad.external_site_url).toBeNull();
    expect(bad.return_url).toBeNull();
    expect(bad.return_mode).toBe('button');
    expect(bad.back_label).toBeNull();
    // ...and such a row projects to nothing on the storefront.
    expect(
      publicCheckoutSettings({ external_site_url: 'http://example.se/' }),
    ).toBeUndefined();
  });

  it('the storefront projection carries the keys only while a site is set', () => {
    expect(
      publicCheckoutSettings({
        external_site_url: 'https://example.se/',
        return_url: 'https://example.se/tack?order={order_number}',
      }),
    ).toStrictEqual({
      ...DEFAULT_CHECKOUT_SETTINGS,
      external_site_url: 'https://example.se/',
      return_url: 'https://example.se/tack?order={order_number}',
    });
    const plain = publicCheckoutSettings({ after_add_to_cart: 'cart' });
    expect(plain && Object.keys(plain).sort()).toEqual([
      'after_add_to_cart',
      'coupon_autoapply',
      'coupon_param',
      'pay_button_label',
      'phone_required',
    ]);
  });

  it('withStoredExternalReturn keeps stored keys only when the body omits all of them', () => {
    const stored = {
      external_site_url: 'https://example.se/',
      return_url: 'https://example.se/tack',
      return_mode: 'auto',
      back_label: null,
    };
    expect(withStoredExternalReturn({ phone_required: true }, stored)).toEqual({
      phone_required: true,
      ...stored,
    });
    const explicit = { phone_required: true, external_site_url: null };
    expect(withStoredExternalReturn(explicit, stored)).toBe(explicit);
    expect(withStoredExternalReturn(null, stored)).toBeNull();
    const body = { phone_required: true };
    expect(withStoredExternalReturn(body, null)).toBe(body);
  });
});
