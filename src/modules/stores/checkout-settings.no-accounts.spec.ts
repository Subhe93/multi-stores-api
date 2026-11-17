import { BadRequestException } from '@nestjs/common';
import { StoresService } from './stores.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { OrdersService } from '../orders/orders.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsService } from '../markets/markets.service';
import { MarketsContextService } from '../markets/markets-context.service';
import type { RedirectsService } from '../redirects/redirects.service';
import type { ReauthService } from '../security/reauth.service';
import type { SecurityAuditService } from '../security/security-audit.service';
import {
  DEFAULT_CHECKOUT_SETTINGS,
  changedExternalFields,
  compactCheckoutSettings,
  isDefaultCheckoutSettings,
  normalizeCheckoutSettingsInput,
  publicCheckoutSettings,
  readStoredCheckoutSettings,
  withStoredCheckoutSettings,
  withStoredExternalReturn,
} from './checkout-settings';

// "Store without customer accounts" (`no_customer_accounts`) and the label of
// the return button on the paid confirmation page (`return_label`). Both keys
// exist only when set, so a store that never used them keeps byte-identical
// stored JSON and public payload.

const SITE = 'https://example.se/';
const BASE = {
  after_add_to_cart: 'stay',
  phone_required: false,
  pay_button_label: null,
  coupon_param: ['coupon'],
  coupon_autoapply: false,
};
const SITE_BLOCK = {
  ...BASE,
  external_site_url: SITE,
  return_url: null,
  return_mode: 'button',
  back_label: null,
};

function expectInvalid(fn: () => unknown, message: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toEqual({
      code: 'STORE_CHECKOUT_SETTINGS_INVALID',
      message,
    });
    return;
  }
  throw new Error('expected a 400');
}

describe('no_customer_accounts (settings model)', () => {
  it('true is stored as the default object plus the key; false / null remove it', () => {
    expect(
      normalizeCheckoutSettingsInput({ no_customer_accounts: true }),
    ).toStrictEqual({ ...BASE, no_customer_accounts: true });
    expect(
      normalizeCheckoutSettingsInput({ no_customer_accounts: false }),
    ).toBeNull();
    expect(
      normalizeCheckoutSettingsInput({ no_customer_accounts: null }),
    ).toBeNull();
    expect(
      normalizeCheckoutSettingsInput({
        phone_required: true,
        no_customer_accounts: false,
      }),
    ).toStrictEqual({ ...BASE, phone_required: true });
  });

  it('any other type is a 400', () => {
    for (const bad of ['true', 1, {}, []])
      expectInvalid(
        () => normalizeCheckoutSettingsInput({ no_customer_accounts: bad }),
        'no_customer_accounts must be a boolean',
      );
  });

  it('works with an external site and is not an external key', () => {
    expect(
      normalizeCheckoutSettingsInput({
        external_site_url: SITE,
        no_customer_accounts: true,
      }),
    ).toStrictEqual({ ...SITE_BLOCK, no_customer_accounts: true });
  });

  it('read / isDefault / public: only ever true, never false', () => {
    const on = readStoredCheckoutSettings({ no_customer_accounts: true });
    expect(on.no_customer_accounts).toBe(true);
    expect(isDefaultCheckoutSettings(on)).toBe(false);
    for (const raw of [
      { no_customer_accounts: false },
      { no_customer_accounts: 'true' },
      { no_customer_accounts: 1 },
      {},
    ]) {
      const off = readStoredCheckoutSettings(raw);
      expect('no_customer_accounts' in off).toBe(false);
      expect(off).toStrictEqual({ ...DEFAULT_CHECKOUT_SETTINGS });
      expect(publicCheckoutSettings(raw)).toBeUndefined();
    }
    expect(
      publicCheckoutSettings({ no_customer_accounts: true }),
    ).toStrictEqual({ ...BASE, no_customer_accounts: true });
    expect(
      compactCheckoutSettings({
        ...DEFAULT_CHECKOUT_SETTINGS,
        no_customer_accounts: false,
      }),
    ).toStrictEqual(BASE);
  });

  it('the DEFAULT object has neither new key', () => {
    expect('no_customer_accounts' in DEFAULT_CHECKOUT_SETTINGS).toBe(false);
    expect('return_label' in DEFAULT_CHECKOUT_SETTINGS).toBe(false);
  });
});

describe('withStoredCheckoutSettings', () => {
  const stored = { ...BASE, no_customer_accounts: true };

  it('an object body that omits the key keeps the stored switch', () => {
    expect(
      withStoredCheckoutSettings({ phone_required: true }, stored),
    ).toEqual({ phone_required: true, no_customer_accounts: true });
    expect(withStoredCheckoutSettings({}, stored)).toEqual({
      no_customer_accounts: true,
    });
  });

  it('an explicit false / null, or a null body, clears it', () => {
    const off = { no_customer_accounts: false };
    expect(withStoredCheckoutSettings(off, stored)).toBe(off);
    expect(
      normalizeCheckoutSettingsInput(withStoredCheckoutSettings(off, stored)),
    ).toBeNull();
    const nul = { no_customer_accounts: null };
    expect(withStoredCheckoutSettings(nul, stored)).toBe(nul);
    expect(withStoredCheckoutSettings(null, stored)).toBeNull();
  });

  it('clearing the external site does not touch it', () => {
    const withSite = { ...SITE_BLOCK, no_customer_accounts: true };
    const carried = withStoredCheckoutSettings(
      { external_site_url: null },
      withSite,
    );
    expect(normalizeCheckoutSettingsInput(carried)).toStrictEqual({
      ...BASE,
      no_customer_accounts: true,
    });
  });

  it('a store without the keys gets the very same body back', () => {
    const body = { phone_required: true };
    expect(withStoredCheckoutSettings(body, null)).toBe(body);
    expect(withStoredCheckoutSettings(body, { ...BASE })).toBe(body);
    // With a stored site the external keys are carried exactly as before:
    // no `return_label` key appears for a store that never had one.
    const carried = withStoredCheckoutSettings(body, SITE_BLOCK);
    expect(carried).toStrictEqual(withStoredExternalReturn(body, SITE_BLOCK));
    expect(carried).toStrictEqual({
      phone_required: true,
      external_site_url: SITE,
      return_url: null,
      return_mode: 'button',
      back_label: null,
    });
    expect(normalizeCheckoutSettingsInput(carried)).toStrictEqual({
      ...SITE_BLOCK,
      phone_required: true,
    });
  });
});

describe('return_label (settings model)', () => {
  it('is validated like back_label: trimmed, empty entries dropped', () => {
    expect(
      normalizeCheckoutSettingsInput({
        external_site_url: SITE,
        return_label: { sv: '  Till bokningsbekräftelsen ', en: '   ' },
      }),
    ).toStrictEqual({
      ...SITE_BLOCK,
      return_label: { sv: 'Till bokningsbekräftelsen' },
    });
  });

  it('null / {} / all-empty leave no key at all (never null)', () => {
    for (const value of [null, {}, { sv: '  ' }]) {
      const out = normalizeCheckoutSettingsInput({
        external_site_url: SITE,
        return_label: value,
      });
      expect(out).toStrictEqual(SITE_BLOCK);
      expect('return_label' in (out as object)).toBe(false);
    }
  });

  it('type and limit errors are 400s', () => {
    expectInvalid(
      () =>
        normalizeCheckoutSettingsInput({
          external_site_url: SITE,
          return_label: 'Tillbaka',
        }),
      'return_label must be an object keyed by locale',
    );
    expectInvalid(
      () =>
        normalizeCheckoutSettingsInput({
          external_site_url: SITE,
          return_label: { sv: 'x'.repeat(61) },
        }),
      'return_label.sv must be at most 60 characters',
    );
    expectInvalid(
      () =>
        normalizeCheckoutSettingsInput({
          external_site_url: SITE,
          return_label: { 'not a locale': 'x' },
        }),
      'return_label: "not a locale" is not a locale key',
    );
    expectInvalid(
      () =>
        normalizeCheckoutSettingsInput({
          external_site_url: SITE,
          return_label: { sv: 5 },
        }),
      'return_label.sv must be a string',
    );
    expectInvalid(
      () =>
        normalizeCheckoutSettingsInput({
          external_site_url: SITE,
          return_label: Object.fromEntries(
            Array.from({ length: 21 }, (_, i) => [
              `a${String.fromCharCode(97 + i)}`,
              'x',
            ]),
          ),
        }),
      'return_label may hold at most 20 locales',
    );
  });

  it('without a site it is silently dropped (write, read and public)', () => {
    expect(
      normalizeCheckoutSettingsInput({ return_label: { sv: 'Tillbaka' } }),
    ).toBeNull();
    expect(
      normalizeCheckoutSettingsInput({
        phone_required: true,
        return_label: { sv: 'Tillbaka' },
      }),
    ).toStrictEqual({ ...BASE, phone_required: true });
    const read = readStoredCheckoutSettings({
      return_label: { sv: 'Tillbaka' },
    });
    expect(read).toStrictEqual({ ...DEFAULT_CHECKOUT_SETTINGS });
    expect(
      publicCheckoutSettings({ return_label: { sv: 'Tillbaka' } }),
    ).toBeUndefined();
  });

  it('read / public: a non-empty map next to a valid site only', () => {
    const raw = { external_site_url: SITE, return_label: { sv: ' Klar ' } };
    expect(readStoredCheckoutSettings(raw).return_label).toEqual({
      sv: 'Klar',
    });
    expect(publicCheckoutSettings(raw)).toStrictEqual({
      ...SITE_BLOCK,
      return_label: { sv: 'Klar' },
    });
    const empty = { external_site_url: SITE, return_label: { sv: '' } };
    expect('return_label' in readStoredCheckoutSettings(empty)).toBe(false);
    expect(publicCheckoutSettings(empty)).toStrictEqual(SITE_BLOCK);
    expect(publicCheckoutSettings({ external_site_url: SITE })).toStrictEqual(
      SITE_BLOCK,
    );
  });

  it('is carried when omitted and cleared with the site', () => {
    const stored = { ...SITE_BLOCK, return_label: { sv: 'Klar' } };
    expect(
      normalizeCheckoutSettingsInput(
        withStoredCheckoutSettings({ phone_required: true }, stored),
      ),
    ).toStrictEqual({ ...stored, phone_required: true });
    for (const cleared of [null, {}, { sv: '' }])
      expect(
        normalizeCheckoutSettingsInput(
          withStoredCheckoutSettings({ return_label: cleared }, stored),
        ),
      ).toStrictEqual(SITE_BLOCK);
    expect(
      normalizeCheckoutSettingsInput(
        withStoredCheckoutSettings({ external_site_url: null }, stored),
      ),
    ).toBeNull();
  });
});

describe('changedExternalFields (return_label)', () => {
  const read = readStoredCheckoutSettings;
  const site = { external_site_url: SITE };

  it.each([
    [site, { ...site, return_label: { sv: 'Klar' } }, ['return_label']],
    [
      { ...site, return_label: { sv: 'Klar' } },
      { ...site, return_label: { sv: 'Klart' } },
      ['return_label'],
    ],
    [
      { ...site, return_label: { sv: 'Klar' } },
      { ...site, return_label: { sv: 'Klar', en: 'Done' } },
      ['return_label'],
    ],
    [
      { ...site, return_label: { sv: 'Klar' } },
      site,
      ['return_label (cleared)'],
    ],
    [
      { ...site, return_label: { sv: 'Klar', en: 'Done' } },
      { ...site, return_label: { en: 'Done', sv: 'Klar' } },
      [],
    ],
    [site, site, []],
    [
      { ...site, return_label: { sv: 'Klar' } },
      null,
      ['external_site_url (cleared)', 'return_label (cleared)'],
    ],
    [{ no_customer_accounts: true }, null, []],
    [null, { no_customer_accounts: true }, []],
  ])('%j -> %j = %j', (before, after, fields) => {
    expect(changedExternalFields(read(before), read(after))).toEqual(fields);
  });
});

// ── StoresService: audit / re-auth / admin path ─────────────────────────────

function build(stored: unknown = null) {
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    user: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'u1',
          email: 'owner@example.se',
          role: 'CREATOR',
        }),
      ),
    },
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 's1',
          slug: 'prima',
          store_type: 'INDEPENDENT',
          custom_domain: null,
          checkout_settings: stored,
        }),
      ),
      findFirst: jest.fn(() => Promise.resolve(null)),
      update: jest.fn((args: { data: unknown }) =>
        Promise.resolve({ id: 's1', slug: 'prima', ...(args.data as object) }),
      ),
    },
  };
  const reauth = {
    verify: jest.fn(() =>
      Promise.resolve({ id: 'u1', email: 'owner@example.se', role: 'CREATOR' }),
    ),
  };
  const audit = {
    record: jest.fn(() => Promise.resolve()),
    alert: jest.fn(),
    localeFor: jest.fn(() => Promise.resolve('sv')),
  };
  const service = new StoresService(
    prisma as unknown as PrismaService,
    {
      revalidateStoreBySlug: jest.fn(() => Promise.resolve()),
    } as unknown as RevalidationService,
    {} as OrdersService,
    {
      isEnabled: jest.fn(() => Promise.resolve(false)),
    } as unknown as StoreAppsService,
    {} as MarketsService,
    { invalidate: jest.fn() } as unknown as MarketsContextService,
    {
      versionFor: jest.fn(() => Promise.resolve(null)),
    } as unknown as RedirectsService,
    undefined,
    undefined,
    undefined,
    reauth as unknown as ReauthService,
    audit as unknown as SecurityAuditService,
  );
  return { service, prisma, reauth, audit };
}

function writtenSettings(prisma: ReturnType<typeof build>['prisma']): unknown {
  const call = prisma.store.update.mock.calls[0] as unknown as [
    { data: { checkout_settings?: unknown } },
  ];
  return call[0].data.checkout_settings;
}

describe('StoresService.update no_customer_accounts', () => {
  it('turning it on needs no password and writes no audit row', async () => {
    const { service, prisma, reauth, audit } = build();
    await service.update('u1', {
      checkout_settings: { no_customer_accounts: true },
    });
    expect(writtenSettings(prisma)).toStrictEqual({
      ...BASE,
      no_customer_accounts: true,
    });
    expect(reauth.verify).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(audit.alert).not.toHaveBeenCalled();
  });

  it('a body from an older client keeps it; an explicit false clears it', async () => {
    const stored = { ...BASE, no_customer_accounts: true };
    const kept = build(stored);
    await kept.service.update('u1', {
      checkout_settings: { phone_required: true },
    });
    expect(writtenSettings(kept.prisma)).toStrictEqual({
      ...BASE,
      phone_required: true,
      no_customer_accounts: true,
    });

    const cleared = build(stored);
    await cleared.service.update('u1', {
      checkout_settings: { phone_required: true, no_customer_accounts: false },
    });
    expect(writtenSettings(cleared.prisma)).toStrictEqual({
      ...BASE,
      phone_required: true,
    });
    expect(cleared.audit.record).not.toHaveBeenCalled();
  });

  it('the admin path may switch it and keeps it when omitted', async () => {
    const on = build();
    await on.service.adminUpdateByCreatorId('c1', {
      checkout_settings: { no_customer_accounts: true },
    });
    expect(writtenSettings(on.prisma)).toStrictEqual({
      ...BASE,
      no_customer_accounts: true,
    });

    const kept = build({ ...BASE, no_customer_accounts: true });
    await kept.service.adminUpdateByCreatorId('c1', {
      checkout_settings: { phone_required: true },
    });
    expect(writtenSettings(kept.prisma)).toStrictEqual({
      ...BASE,
      phone_required: true,
      no_customer_accounts: true,
    });
  });

  it('a store that never used the options writes exactly the former JSON', async () => {
    const plain = build();
    await plain.service.update('u1', {
      checkout_settings: { phone_required: true },
    });
    expect(writtenSettings(plain.prisma)).toStrictEqual({
      ...BASE,
      phone_required: true,
    });

    const withSite = build(SITE_BLOCK);
    await withSite.service.update('u1', {
      checkout_settings: { phone_required: true },
    });
    expect(writtenSettings(withSite.prisma)).toStrictEqual({
      ...SITE_BLOCK,
      phone_required: true,
    });
    expect(withSite.audit.record).not.toHaveBeenCalled();
  });
});

describe('StoresService.update return_label', () => {
  it('a change is audited (and alerted) without a password prompt', async () => {
    const { service, prisma, reauth, audit } = build(SITE_BLOCK);
    await service.update('u1', {
      checkout_settings: { return_label: { sv: 'Till bokningen' } },
    });
    expect(reauth.verify).not.toHaveBeenCalled();
    expect(writtenSettings(prisma)).toStrictEqual({
      ...SITE_BLOCK,
      return_label: { sv: 'Till bokningen' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'checkout.external_return.updated',
        fields: ['return_label'],
      }),
    );
    expect(audit.alert).toHaveBeenCalledWith(
      ['owner@example.se'],
      'external_return_changed',
      expect.objectContaining({ fields: ['return_label'] }),
      'sv',
    );
  });

  it('clearing it is audited as "return_label (cleared)"', async () => {
    const { service, prisma, reauth, audit } = build({
      ...SITE_BLOCK,
      return_label: { sv: 'Till bokningen' },
    });
    await service.update('u1', { checkout_settings: { return_label: null } });
    expect(reauth.verify).not.toHaveBeenCalled();
    expect(writtenSettings(prisma)).toStrictEqual(SITE_BLOCK);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ fields: ['return_label (cleared)'] }),
    );
  });

  it('an unchanged label (other key order) is not audited', async () => {
    const { service, audit } = build({
      ...SITE_BLOCK,
      return_label: { sv: 'Klar', en: 'Done' },
    });
    await service.update('u1', {
      checkout_settings: { return_label: { en: 'Done', sv: 'Klar' } },
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('the admin path may not change it, but keeps the stored one', async () => {
    const refused = build(SITE_BLOCK);
    await expect(
      refused.service.adminUpdateByCreatorId('c1', {
        checkout_settings: { return_label: { sv: 'Klar' } },
      }),
    ).rejects.toMatchObject({
      response: { code: 'CHECKOUT_EXTERNAL_URL_OWNER_ONLY' },
    });
    expect(refused.prisma.store.update).not.toHaveBeenCalled();

    const stored = { ...SITE_BLOCK, return_label: { sv: 'Klar' } };
    const kept = build(stored);
    await kept.service.adminUpdateByCreatorId('c1', {
      checkout_settings: { phone_required: true },
    });
    expect(writtenSettings(kept.prisma)).toStrictEqual({
      ...stored,
      phone_required: true,
    });
  });
});
