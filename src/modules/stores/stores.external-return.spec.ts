import { Prisma } from '@prisma/client';
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

// Headless booking P3 (R1): the external site / return URL keys need the
// owner's step-up (password, + 2FA code when on) when a site URL is set or
// replaced, and every URL change writes an audit row + owner alert.

const SITE = 'https://example.se/';
const RETURN = 'https://www.example.se/tack?order={order_number}';
const META = { ip: '1.2.3.4', userAgent: 'jest' };

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

describe('StoresService.update external return (P3)', () => {
  it('setting external_site_url re-authenticates, then audits and alerts', async () => {
    const { service, prisma, reauth, audit } = build();
    await service.update(
      'u1',
      {
        checkout_settings: {
          external_site_url: 'https://Example.se',
          return_url: RETURN,
        },
        current_password: 'pw',
        totp_code: '123456',
      },
      META,
    );
    expect(reauth.verify).toHaveBeenCalledWith(
      'u1',
      { current_password: 'pw', totp_code: '123456' },
      { purpose: 'checkout.external_return.updated', meta: META },
    );
    const data = (
      prisma.store.update.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data).not.toHaveProperty('current_password');
    expect(data).not.toHaveProperty('totp_code');
    expect(data.checkout_settings).toMatchObject({
      external_site_url: SITE,
      return_url: RETURN,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'checkout.external_return.updated',
        targetType: 'store',
        targetId: 's1',
        targetLabel: 'prima',
        fields: ['external_site_url', 'return_url'],
        meta: META,
      }),
    );
    expect(audit.alert).toHaveBeenCalledWith(
      ['owner@example.se'],
      'external_return_changed',
      expect.objectContaining({ fields: ['external_site_url', 'return_url'] }),
      'sv',
    );
  });

  it('a failed re-auth writes nothing and records nothing', async () => {
    const { service, prisma, reauth, audit } = build();
    reauth.verify.mockRejectedValueOnce(
      Object.assign(new Error('x'), { response: { code: 'REAUTH_REQUIRED' } }),
    );
    await expect(
      service.update(
        'u1',
        { checkout_settings: { external_site_url: SITE } },
        META,
      ),
    ).rejects.toMatchObject({ response: { code: 'REAUTH_REQUIRED' } });
    expect(prisma.store.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('a foreign return host is refused before any re-auth or write', async () => {
    const { service, prisma, reauth } = build();
    await expect(
      service.update('u1', {
        checkout_settings: {
          external_site_url: SITE,
          return_url: 'https://evil.com/tack',
        },
        current_password: 'pw',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'CHECKOUT_EXTERNAL_URL_NOT_ALLOWED',
        field: 'return_url',
      },
    });
    expect(reauth.verify).not.toHaveBeenCalled();
    expect(prisma.store.update).not.toHaveBeenCalled();
  });

  it('changing only return_url is audited without a password prompt', async () => {
    const { service, reauth, audit } = build({ external_site_url: SITE });
    await service.update('u1', {
      checkout_settings: { external_site_url: SITE, return_url: RETURN },
    });
    expect(reauth.verify).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ fields: ['return_url'] }),
    );
  });

  it('clearing the site is audited (cleared) without a password prompt', async () => {
    const { service, prisma, reauth, audit } = build({
      external_site_url: SITE,
      return_url: RETURN,
    });
    await service.update('u1', { checkout_settings: null });
    expect(reauth.verify).not.toHaveBeenCalled();
    expect(writtenSettings(prisma)).toBe(Prisma.JsonNull);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: ['external_site_url (cleared)', 'return_url (cleared)'],
      }),
    );
  });

  it('a body without the external keys keeps the stored ones (no prompt, no audit)', async () => {
    const stored = {
      after_add_to_cart: 'stay',
      phone_required: false,
      pay_button_label: null,
      coupon_param: ['coupon'],
      coupon_autoapply: false,
      external_site_url: SITE,
      return_url: RETURN,
      return_mode: 'auto',
      back_label: null,
    };
    const { service, prisma, reauth, audit } = build(stored);
    await service.update('u1', { checkout_settings: { phone_required: true } });
    expect(reauth.verify).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(writtenSettings(prisma)).toEqual({
      ...stored,
      phone_required: true,
    });
  });

  it('a partial body (a label only) keeps the stored site and return target', async () => {
    const stored = {
      external_site_url: SITE,
      return_url: RETURN,
      return_mode: 'auto',
      back_label: { sv: 'Tillbaka' },
    };
    const { service, prisma, reauth, audit } = build(stored);
    await service.update('u1', {
      checkout_settings: { back_label: { sv: 'Till startsidan' } },
    });
    expect(reauth.verify).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(writtenSettings(prisma)).toMatchObject({
      external_site_url: SITE,
      return_url: RETURN,
      return_mode: 'auto',
      back_label: { sv: 'Till startsidan' },
    });
  });

  it('an audit failure after the save is logged, not returned as an error', async () => {
    const { service, prisma, audit } = build({ external_site_url: SITE });
    audit.record.mockImplementationOnce(() =>
      Promise.reject(new Error('audit down')),
    );
    const logSpy = jest
      .spyOn((service as unknown as { logger: { error: () => void } }).logger, 'error')
      .mockImplementation(() => undefined);
    await expect(
      service.update('u1', {
        checkout_settings: { external_site_url: SITE, return_url: RETURN },
      }),
    ).resolves.toBeDefined();
    expect(prisma.store.update).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
    // The owner alert still goes out.
    expect(audit.alert).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('stores without an external site: no prompt, no audit, unchanged stored shape', async () => {
    const { service, prisma, reauth, audit } = build();
    await service.update('u1', {
      checkout_settings: { after_add_to_cart: 'cart' },
    });
    await service.update('u1', { name: 'Namez' });
    expect(reauth.verify).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(writtenSettings(prisma)).toStrictEqual({
      after_add_to_cart: 'cart',
      phone_required: false,
      pay_button_label: null,
      coupon_param: ['coupon'],
      coupon_autoapply: false,
    });
  });

  it('fails closed when the security services are not wired', async () => {
    const { prisma } = build();
    const lean = new StoresService(
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
    );
    await expect(
      lean.update('u1', { checkout_settings: { external_site_url: SITE } }),
    ).rejects.toThrow('not wired');
    expect(prisma.store.update).not.toHaveBeenCalled();
  });

  it('the admin path may not change the external URLs', async () => {
    const { service, prisma } = build();
    await expect(
      service.adminUpdateByCreatorId('c1', {
        checkout_settings: { external_site_url: SITE },
      }),
    ).rejects.toMatchObject({
      response: { code: 'CHECKOUT_EXTERNAL_URL_OWNER_ONLY' },
    });
    expect(prisma.store.update).not.toHaveBeenCalled();
  });
});

// Focused storefront (`external_focus`): no password prompt of its own (the
// site URL already asked for it), audited with the same action, and the
// external site may never be one of the store's own hosts.
describe('StoresService.update focused storefront (external_focus)', () => {
  it('turning it on for a stored site is audited without a password prompt', async () => {
    const { service, prisma, reauth, audit } = build({
      external_site_url: SITE,
    });
    await service.update('u1', { checkout_settings: { external_focus: true } });
    expect(reauth.verify).not.toHaveBeenCalled();
    expect(writtenSettings(prisma)).toMatchObject({
      external_site_url: SITE,
      external_focus: true,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'checkout.external_return.updated',
        fields: ['external_focus'],
      }),
    );
  });

  it('turning it off is audited without a password prompt and drops the key', async () => {
    const { service, prisma, reauth, audit } = build({
      external_site_url: SITE,
      external_focus: true,
    });
    await service.update('u1', {
      checkout_settings: { external_focus: false },
    });
    expect(reauth.verify).not.toHaveBeenCalled();
    expect(writtenSettings(prisma)).toStrictEqual({
      after_add_to_cart: 'stay',
      phone_required: false,
      pay_button_label: null,
      coupon_param: ['coupon'],
      coupon_autoapply: false,
      external_site_url: SITE,
      return_url: null,
      return_mode: 'button',
      back_label: null,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ fields: ['external_focus (cleared)'] }),
    );
  });

  it('set together with a new site: one re-auth, both fields audited', async () => {
    const { service, reauth, audit } = build();
    await service.update('u1', {
      checkout_settings: { external_site_url: SITE, external_focus: true },
      current_password: 'pw',
    });
    expect(reauth.verify).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: ['external_site_url', 'external_focus'],
      }),
    );
  });

  it('a body without it keeps the stored flag (no prompt, no audit)', async () => {
    const { service, prisma, reauth, audit } = build({
      external_site_url: SITE,
      external_focus: true,
    });
    await service.update('u1', { checkout_settings: { phone_required: true } });
    expect(reauth.verify).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(writtenSettings(prisma)).toMatchObject({
      external_site_url: SITE,
      external_focus: true,
      phone_required: true,
    });
  });

  it('true without a site is refused before any re-auth or write', async () => {
    const { service, prisma, reauth } = build();
    await expect(
      service.update('u1', { checkout_settings: { external_focus: true } }),
    ).rejects.toMatchObject({
      response: {
        code: 'CHECKOUT_EXTERNAL_URL_NOT_ALLOWED',
        field: 'external_focus',
        reason: 'external_site_url_required',
      },
    });
    expect(reauth.verify).not.toHaveBeenCalled();
    expect(prisma.store.update).not.toHaveBeenCalled();
  });

  it("the store's own custom domain is refused as the external site", async () => {
    const { service, prisma, reauth } = build();
    (
      prisma.store.findUnique as unknown as jest.Mock<Promise<unknown>>
    ).mockImplementation(() =>
      Promise.resolve({
        id: 's1',
        slug: 'prima',
        store_type: 'INDEPENDENT',
        custom_domain: 'www.example.se',
        checkout_settings: null,
      }),
    );
    await expect(
      service.update('u1', {
        checkout_settings: { external_site_url: SITE, external_focus: true },
        current_password: 'pw',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'CHECKOUT_EXTERNAL_URL_NOT_ALLOWED',
        field: 'external_site_url',
        reason: 'store_host_not_allowed',
      },
    });
    expect(reauth.verify).not.toHaveBeenCalled();
    expect(prisma.store.update).not.toHaveBeenCalled();
  });

  describe('host rules run only when the site or the focus changes', () => {
    const env = { ...process.env };
    beforeEach(() => {
      process.env.STOREFRONT_URL = 'https://shopsdoor.test';
    });
    afterEach(() => {
      process.env = { ...env };
    });
    const PLATFORM_SITE = 'https://other.shopsdoor.test/';

    it('a new site on a platform host is refused', async () => {
      const { service, prisma, reauth } = build();
      await expect(
        service.update('u1', {
          checkout_settings: { external_site_url: PLATFORM_SITE },
          current_password: 'pw',
        }),
      ).rejects.toMatchObject({
        response: {
          code: 'CHECKOUT_EXTERNAL_URL_NOT_ALLOWED',
          field: 'external_site_url',
          reason: 'store_host_not_allowed',
        },
      });
      expect(reauth.verify).not.toHaveBeenCalled();
      expect(prisma.store.update).not.toHaveBeenCalled();
    });

    it('a store whose stored site is a platform host can still save another key', async () => {
      const { service, prisma } = build({ external_site_url: PLATFORM_SITE });
      await service.update('u1', {
        checkout_settings: { phone_required: true },
      });
      expect(prisma.store.update).toHaveBeenCalled();
    });

    it('the same store can still change only the return URL', async () => {
      const { service, prisma } = build({ external_site_url: PLATFORM_SITE });
      await service.update('u1', {
        checkout_settings: {
          return_url: 'https://other.shopsdoor.test/tack/?order={order_number}',
        },
      });
      expect(prisma.store.update).toHaveBeenCalled();
    });

    it('turning the focused storefront on for such a stored site is refused', async () => {
      const { service, prisma } = build({ external_site_url: PLATFORM_SITE });
      await expect(
        service.update('u1', { checkout_settings: { external_focus: true } }),
      ).rejects.toMatchObject({
        response: { reason: 'store_host_not_allowed' },
      });
      expect(prisma.store.update).not.toHaveBeenCalled();
    });
  });

  it('the admin path may not switch it', async () => {
    const { service, prisma } = build({ external_site_url: SITE });
    await expect(
      service.adminUpdateByCreatorId('c1', {
        checkout_settings: { external_focus: true },
      }),
    ).rejects.toMatchObject({
      response: { code: 'CHECKOUT_EXTERNAL_URL_OWNER_ONLY' },
    });
    expect(prisma.store.update).not.toHaveBeenCalled();
  });
});
