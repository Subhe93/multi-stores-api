import {
  EXTERNAL_URL_ERROR_CODE,
  ExternalUrlRejected,
  assertExternalSiteNotStoreHost,
} from './external-site-hosts';
import {
  DEFAULT_CHECKOUT_SETTINGS,
  changedExternalFields,
  normalizeCheckoutSettingsInput,
  publicCheckoutSettings,
  readStoredCheckoutSettings,
  withStoredExternalReturn,
} from './checkout-settings';

// Focused storefront (`checkout_settings.external_focus`): the store is a
// purchase step of the external site. The key is only accepted with an
// external site, stored and served only when true, and every store without
// it keeps the exact P3 shape.

const SITE = 'https://example.se/';

function rejection(fn: () => unknown): { field?: string; reason?: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExternalUrlRejected) {
      const body = e.getResponse() as {
        code: string;
        field: string;
        reason: string;
      };
      expect(body.code).toBe(EXTERNAL_URL_ERROR_CODE);
      return { field: body.field, reason: body.reason };
    }
    throw e;
  }
  return {};
}

describe('checkout_settings.external_focus (write)', () => {
  it('is accepted with a site sent in the same body and stored as true', () => {
    expect(
      normalizeCheckoutSettingsInput({
        external_site_url: 'https://Example.se',
        external_focus: true,
      }),
    ).toStrictEqual({
      ...DEFAULT_CHECKOUT_SETTINGS,
      external_site_url: SITE,
      external_focus: true,
    });
  });

  it('off (false / null / omitted) leaves the exact P3 shape', () => {
    const p3 = { ...DEFAULT_CHECKOUT_SETTINGS, external_site_url: SITE };
    for (const body of [
      { external_site_url: SITE, external_focus: false },
      { external_site_url: SITE, external_focus: null },
      { external_site_url: SITE },
    ]) {
      const out = normalizeCheckoutSettingsInput(body);
      expect(out).toStrictEqual(p3);
      expect(out && 'external_focus' in out).toBe(false);
    }
  });

  it('true without a site is refused with field + reason', () => {
    expect(
      rejection(() => normalizeCheckoutSettingsInput({ external_focus: true })),
    ).toEqual({
      field: 'external_focus',
      reason: 'external_site_url_required',
    });
    // Clearing the site in the same body does not keep it either.
    expect(
      rejection(() =>
        normalizeCheckoutSettingsInput({
          external_site_url: null,
          external_focus: true,
        }),
      ),
    ).toEqual({
      field: 'external_focus',
      reason: 'external_site_url_required',
    });
  });

  it('false without a site changes nothing (still stored as NULL)', () => {
    expect(
      normalizeCheckoutSettingsInput({ external_focus: false }),
    ).toBeNull();
    expect(
      normalizeCheckoutSettingsInput({
        phone_required: true,
        external_focus: false,
      }),
    ).toStrictEqual({
      after_add_to_cart: 'stay',
      phone_required: true,
      pay_button_label: null,
      coupon_param: ['coupon'],
      coupon_autoapply: false,
    });
  });

  it('a non-boolean value is a STORE_CHECKOUT_SETTINGS_INVALID 400', () => {
    let caught: { getResponse?: () => unknown } | undefined;
    try {
      normalizeCheckoutSettingsInput({
        external_site_url: SITE,
        external_focus: 'yes',
      });
    } catch (e) {
      caught = e as { getResponse: () => unknown };
    }
    expect(caught?.getResponse?.()).toMatchObject({
      code: 'STORE_CHECKOUT_SETTINGS_INVALID',
    });
  });
});

describe('checkout_settings.external_focus (carry-over)', () => {
  const stored = {
    external_site_url: SITE,
    return_url: 'https://example.se/tack',
    return_mode: 'auto',
    back_label: null,
    external_focus: true,
  };

  it('a body that omits it keeps the stored value', () => {
    const carried = withStoredExternalReturn({ phone_required: true }, stored);
    expect(carried).toEqual({ phone_required: true, ...stored });
    expect(normalizeCheckoutSettingsInput(carried)).toMatchObject({
      external_site_url: SITE,
      external_focus: true,
      phone_required: true,
    });
  });

  it('an explicit false turns it off and keeps the site', () => {
    const out = normalizeCheckoutSettingsInput(
      withStoredExternalReturn({ external_focus: false }, stored),
    );
    expect(out).toMatchObject({ external_site_url: SITE, return_mode: 'auto' });
    expect(out && 'external_focus' in out).toBe(false);
  });

  it('clearing the site clears it', () => {
    const body = { external_site_url: null };
    expect(withStoredExternalReturn(body, stored)).toBe(body);
    expect(normalizeCheckoutSettingsInput(body)).toBeNull();
    expect(normalizeCheckoutSettingsInput(null)).toBeNull();
  });

  it('a store without the flag carries nothing new', () => {
    const { external_focus: _focus, ...p3 } = stored;
    expect(withStoredExternalReturn({ phone_required: true }, p3)).toEqual({
      phone_required: true,
      ...p3,
    });
    const out = normalizeCheckoutSettingsInput(
      withStoredExternalReturn({ phone_required: true }, p3),
    );
    expect(out && 'external_focus' in out).toBe(false);
  });
});

describe('checkout_settings.external_focus (read + public payload)', () => {
  it('is read as true only next to a valid site', () => {
    expect(
      readStoredCheckoutSettings({
        external_site_url: SITE,
        external_focus: true,
      }).external_focus,
    ).toBe(true);
    // No site, an invalid site, or a non-boolean value: off.
    expect(
      readStoredCheckoutSettings({ external_focus: true }).external_focus,
    ).toBeUndefined();
    expect(
      readStoredCheckoutSettings({
        external_site_url: 'http://example.se/',
        external_focus: true,
      }).external_focus,
    ).toBeUndefined();
    expect(
      readStoredCheckoutSettings({
        external_site_url: SITE,
        external_focus: 'true',
      }).external_focus,
    ).toBeUndefined();
  });

  it('the public checkout block carries it only when true', () => {
    expect(
      publicCheckoutSettings({ external_site_url: SITE, external_focus: true }),
    ).toStrictEqual({
      ...DEFAULT_CHECKOUT_SETTINGS,
      external_site_url: SITE,
      external_focus: true,
    });
    // A site without the flag: byte-identical to the P3 payload.
    const p3 = publicCheckoutSettings({ external_site_url: SITE });
    expect(
      JSON.stringify(
        publicCheckoutSettings({
          external_site_url: SITE,
          external_focus: false,
        }),
      ),
    ).toBe(JSON.stringify(p3));
    expect(p3).toStrictEqual({
      ...DEFAULT_CHECKOUT_SETTINGS,
      external_site_url: SITE,
    });
    // A hand-edited flag without a site projects to nothing.
    expect(publicCheckoutSettings({ external_focus: true })).toBeUndefined();
  });
});

describe('changedExternalFields', () => {
  const read = (raw: unknown) => readStoredCheckoutSettings(raw);

  it.each([
    [
      'turned on',
      { external_site_url: SITE },
      { external_site_url: SITE, external_focus: true },
      ['external_focus'],
    ],
    [
      'turned off',
      { external_site_url: SITE, external_focus: true },
      { external_site_url: SITE },
      ['external_focus (cleared)'],
    ],
    [
      'cleared with the site',
      { external_site_url: SITE, external_focus: true },
      null,
      ['external_site_url (cleared)', 'external_focus (cleared)'],
    ],
    [
      'unchanged',
      { external_site_url: SITE, external_focus: true },
      { external_site_url: SITE, external_focus: true, phone_required: true },
      [],
    ],
  ])('%s', (_label, before, after, fields) => {
    expect(changedExternalFields(read(before), read(after))).toEqual(fields);
  });
});

describe('external site may not be a host of the platform or of the store', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.STOREFRONT_URL = 'https://shopsdoor.test';
    process.env.PLATFORM_HOSTS = 'old-platform.test';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it.each([
    'https://shopsdoor.test',
    'https://www.shopsdoor.test/',
    'https://mystore.shopsdoor.test/kurser',
    'https://other.old-platform.test',
  ])('refuses the platform host %s', (url) => {
    expect(
      rejection(() =>
        normalizeCheckoutSettingsInput({ external_site_url: url }),
      ),
    ).toEqual({
      field: 'external_site_url',
      reason: 'store_host_not_allowed',
    });
  });

  it('accepts a site of its own', () => {
    expect(
      normalizeCheckoutSettingsInput({
        external_site_url: 'https://mystore.vercel.app',
      }),
    ).toMatchObject({ external_site_url: 'https://mystore.vercel.app/' });
    // A look-alike that merely ends with the platform name is a foreign host.
    expect(
      normalizeCheckoutSettingsInput({
        external_site_url: 'https://notshopsdoor.test',
      }),
    ).toMatchObject({ external_site_url: 'https://notshopsdoor.test/' });
  });

  it('refuses a host that serves the store (exact host or www twin)', () => {
    const hosts = ['shop.example.se', 'WWW.Kurser.se.'];
    for (const url of [
      'https://shop.example.se/',
      'https://www.kurser.se/',
      'https://kurser.se/',
    ]) {
      expect(
        rejection(() => assertExternalSiteNotStoreHost(url, hosts)),
      ).toEqual({
        field: 'external_site_url',
        reason: 'store_host_not_allowed',
      });
    }
    expect(() =>
      assertExternalSiteNotStoreHost('https://example.se/', hosts),
    ).not.toThrow();
    expect(() =>
      assertExternalSiteNotStoreHost('https://example.se/', []),
    ).not.toThrow();
  });
});
