import { PaymentMethod } from '@prisma/client';
import { KustomService } from './kustom.service';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { CryptoService } from '../../../common/crypto/crypto.service';
import type { OrdersService } from '../../orders/orders.service';
import type { NotificationsService } from '../../notifications/notifications.service';
import type { MailService } from '../../mail/mail.service';
import type { RevalidationService } from '../../../common/revalidation/revalidation.service';
import type { TaxService } from '../../taxes/tax.service';
import type { MarketsContextService } from '../../markets/markets-context.service';
import type { B2bService } from '../../b2b/b2b.service';
import type { StoreAppsService } from '../../store-apps/store-apps.service';

// Merchant / redirect URLs without a market host fall back to the store's
// public host (storefront-hosts): legacy custom_domain with the markets app
// off, the default LIVE market's primary host with it on (Namez keeps a
// retired custom_domain), the slug URL with neither.

const namezSe = {
  hostname: 'namez.se',
  is_primary: true,
  redirect_to: null,
  status: 'ACTIVE',
  market: { is_default: true, status: 'LIVE' },
};

function build(opts: {
  customDomain: string | null;
  marketsEnabled: boolean;
  domains?: unknown[];
  storeApps?: boolean;
}) {
  const store = {
    id: 's1',
    slug: 'namez-se',
    name: 'Namez',
    custom_domain: opts.customDomain,
    store_type: 'INDEPENDENT',
    is_active: false,
    currency: 'SEK',
    language_config: { primary_locale: 'sv' },
    creator: { id: 'c1' },
  };
  const prisma = {
    store: { findUnique: jest.fn(() => Promise.resolve(store)) },
    storeDomain: {
      findMany: jest.fn(() => Promise.resolve(opts.domains ?? [])),
    },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'SEK' })),
    },
    page: { findFirst: jest.fn(() => Promise.resolve(null)) },
    staticPage: { findFirst: jest.fn(() => Promise.resolve(null)) },
    order: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 'o1',
          total: 299,
          currency: 'SEK',
          payment_status: 'awaiting_payment',
          payment_method: PaymentMethod.KUSTOM,
          kustom_order_id: 'k-1',
          kustom_push_token: 'tok',
          store_id: 's1',
          hostname: null,
        }),
      ),
    },
  };
  const storeApps = {
    isEnabled: jest.fn(() => Promise.resolve(opts.marketsEnabled)),
  };
  const config = {
    get: jest.fn((k: string) =>
      k === 'STOREFRONT_URL' ? 'https://stores.example.com' : undefined,
    ),
  };
  const service = new KustomService(
    config as unknown as ConfigService,
    prisma as unknown as PrismaService,
    {} as CryptoService,
    { registerShippedHook: jest.fn() } as unknown as OrdersService,
    {} as NotificationsService,
    {} as MailService,
    {} as RevalidationService,
    {} as TaxService,
    {} as MarketsContextService,
    {} as B2bService,
    undefined,
    undefined,
    opts.storeApps === false
      ? undefined
      : (storeApps as unknown as StoreAppsService),
  );
  return { service, prisma };
}

describe('KustomService public host fallback', () => {
  it('keeps the legacy custom domain with the markets app off', async () => {
    const { service, prisma } = build({
      customDomain: 'mybrand.se',
      marketsEnabled: false,
    });
    expect((await service.loadStoreContext('s1'))?.customDomain).toBe(
      'mybrand.se',
    );
    const res = await service.handleValidation('o1', 'tok', {});
    expect(res).toEqual({
      ok: false,
      redirectUrl:
        'https://mybrand.se/checkout/kustom?orderId=o1&error=kustom_validation',
    });
    expect(prisma.storeDomain.findMany).not.toHaveBeenCalled();
  });

  it('uses the default market primary host over a retired custom domain', async () => {
    const { service } = build({
      customDomain: 'resumely.net',
      marketsEnabled: true,
      domains: [namezSe],
    });
    expect((await service.loadStoreContext('s1'))?.customDomain).toBe(
      'namez.se',
    );
    const res = await service.handleValidation('o1', 'tok', {});
    expect(res).toMatchObject({
      redirectUrl:
        'https://namez.se/checkout/kustom?orderId=o1&error=kustom_validation',
    });
  });

  it('falls back to the slug URL with neither', async () => {
    const { service } = build({ customDomain: null, marketsEnabled: true });
    expect((await service.loadStoreContext('s1'))?.customDomain).toBeNull();
    const res = await service.handleValidation('o1', 'tok', {});
    expect(res).toMatchObject({
      redirectUrl:
        'https://stores.example.com/store/namez-se/checkout/kustom?orderId=o1&error=kustom_validation',
    });
  });

  it('treats the markets app as off without StoreAppsService', async () => {
    const { service } = build({
      customDomain: 'resumely.net',
      marketsEnabled: true,
      domains: [namezSe],
      storeApps: false,
    });
    expect((await service.loadStoreContext('s1'))?.customDomain).toBe(
      'resumely.net',
    );
  });
});
