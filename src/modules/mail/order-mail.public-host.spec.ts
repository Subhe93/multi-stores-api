import type { PrismaClient } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import { loadOrderForEmail } from './order-mail.helpers';
import { MailService } from './mail.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CryptoService } from '../../common/crypto/crypto.service';
import type { NotificationTemplatesService } from '../notification-templates/notification-templates.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';

// Store links in order emails (and the template preview) fall back to the
// store's public host (storefront-hosts) when the order has no market host:
// legacy custom_domain with the markets app off, the default LIVE market's
// primary host with it on (Namez keeps a retired custom_domain), else the
// platform slug URL.

const namezSe = {
  hostname: 'namez.se',
  is_primary: true,
  redirect_to: null,
  status: 'ACTIVE',
  market: { is_default: true, status: 'LIVE' },
};

function mocks(opts: {
  customDomain: string | null;
  marketsEnabled: boolean;
  domains?: unknown[];
  orderHostname?: string | null;
}) {
  const prisma = {
    order: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'o1',
          store_id: 's1',
          market_id: null,
          hostname: opts.orderHostname ?? null,
        }),
      ),
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 's1',
          slug: 'namez-se',
          name: 'Namez',
          custom_domain: opts.customDomain,
          logo_url: null,
          currency: 'SEK',
          notification_email: null,
          language_config: { primary_locale: 'sv' },
          creator: { user: { email: 'owner@example.com' } },
        }),
      ),
    },
    storeDomain: {
      findMany: jest.fn(() => Promise.resolve(opts.domains ?? [])),
    },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
  };
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(opts.marketsEnabled)),
  };
  return { prisma, storeApps };
}

describe('loadOrderForEmail store host', () => {
  const load = async (opts: Parameters<typeof mocks>[0]) => {
    const { prisma, storeApps } = mocks(opts);
    const order = await loadOrderForEmail(
      prisma as unknown as PrismaClient,
      'o1',
      storeApps as unknown as StoreAppsService,
    );
    return { host: order?.storeCtx?.customDomain, prisma };
  };

  it('keeps the legacy custom domain with the markets app off', async () => {
    const { host, prisma } = await load({
      customDomain: 'mybrand.se',
      marketsEnabled: false,
    });
    expect(host).toBe('mybrand.se');
    expect(prisma.storeDomain.findMany).not.toHaveBeenCalled();
  });

  it('uses the default market primary host over a retired custom domain', async () => {
    const { host } = await load({
      customDomain: 'resumely.net',
      marketsEnabled: true,
      domains: [namezSe],
    });
    expect(host).toBe('namez.se');
  });

  it('leaves the host unset with neither (platform slug URL)', async () => {
    const { host } = await load({ customDomain: null, marketsEnabled: true });
    expect(host).toBeUndefined();
  });

  it('keeps the host the order was placed on first', async () => {
    const { host, prisma } = await load({
      customDomain: 'resumely.net',
      marketsEnabled: true,
      domains: [namezSe],
      orderHostname: 'namez.shop',
    });
    expect(host).toBe('namez.shop');
    expect(prisma.storeDomain.findMany).not.toHaveBeenCalled();
  });
});

describe('MailService template preview store_url', () => {
  const preview = async (opts: Parameters<typeof mocks>[0]) => {
    const { prisma, storeApps } = mocks(opts);
    const env: Record<string, string> = {
      STOREFRONT_URL: 'https://stores.example.com',
    };
    const service = new MailService(
      { get: (k: string) => env[k] } as unknown as ConfigService,
      prisma as unknown as PrismaService,
      {} as CryptoService,
      {} as NotificationTemplatesService,
      storeApps as unknown as StoreAppsService,
    );
    const vars = await service['sampleTemplateVars'](
      'order_confirmation',
      'en',
      's1',
    );
    return vars.store_url;
  };

  it('keeps the legacy custom domain with the markets app off', async () => {
    await expect(
      preview({ customDomain: 'mybrand.se', marketsEnabled: false }),
    ).resolves.toBe('https://mybrand.se');
  });

  it('uses the default market primary host over a retired custom domain', async () => {
    await expect(
      preview({
        customDomain: 'resumely.net',
        marketsEnabled: true,
        domains: [namezSe],
      }),
    ).resolves.toBe('https://namez.se');
  });

  it('falls back to the platform slug URL with neither', async () => {
    await expect(
      preview({ customDomain: null, marketsEnabled: true }),
    ).resolves.toBe('https://stores.example.com/store/namez-se');
  });
});
