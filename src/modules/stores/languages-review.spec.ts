import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StoresService } from './stores.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { OrdersService } from '../orders/orders.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsService } from '../markets/markets.service';
import { MarketsContextService } from '../markets/markets-context.service';
import type { RedirectsService } from '../redirects/redirects.service';
import { CorsOriginService } from '../../common/cors/cors-origin.service';
import type { FxService } from '../markets/fx.service';
import type { DomainsService } from '../markets/domains.service';
import type { MarketPricingService } from '../markets/market-pricing.service';
import type { PaymentCheckService } from '../markets/payment-check.service';
import type { CreateMarketDto, UpdateMarketDto } from '../markets/dto/market.dto';
import { REVIEW_LOCALES } from '../markets/market.types';
import {
  STORE_LANGUAGE_IN_REVIEW,
  assertNotReviewPrimaryLocale,
} from '../markets/review-locale';

// Locales in review (REVIEW_LOCALES, today 'ku') may only be a secondary
// language: a primary / market default locale has no URL prefix and could
// not be hidden from the storefront switcher.

describe('review locales', () => {
  it("REVIEW_LOCALES holds 'ku' while Kurmanji is in review", () => {
    expect(REVIEW_LOCALES).toContain('ku');
  });

  describe('assertNotReviewPrimaryLocale', () => {
    it.each(['ku', ' KU ', 'Ku'])('rejects %p with 400', (code) => {
      let err: unknown;
      try {
        assertNotReviewPrimaryLocale(code);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: STORE_LANGUAGE_IN_REVIEW,
      });
    });

    it.each([undefined, null, '', 'en', 'ar', 'sv'])('accepts %p', (code) => {
      expect(() => assertNotReviewPrimaryLocale(code)).not.toThrow();
    });
  });
});

describe('StoresService.updateLanguages with a review locale', () => {
  function build(existingPrimary = 'en') {
    const prisma = {
      creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
      store: { findUnique: jest.fn(() => Promise.resolve({ id: 's1' })) },
      storeLanguageConfig: {
        findUnique: jest.fn(() =>
          Promise.resolve({ primary_locale: existingPrimary }),
        ),
        upsert: jest.fn(
          (args: {
            update: { primary_locale?: string; secondary_locales?: string[] };
          }) =>
            Promise.resolve({
              store_id: 's1',
              primary_locale: args.update.primary_locale ?? existingPrimary,
              secondary_locales: args.update.secondary_locales ?? [],
            }),
        ),
      },
    };
    const storeApps = { isEnabled: jest.fn(() => Promise.resolve(false)) };
    const markets = {
      mirrorLanguagesIntoDefault: jest.fn(() => Promise.resolve()),
    };
    const revalidation = {
      revalidateStoreById: jest.fn(() => Promise.resolve()),
    };
    const service = new StoresService(
      prisma as unknown as PrismaService,
      revalidation as unknown as RevalidationService,
      {} as OrdersService,
      storeApps as unknown as StoreAppsService,
      markets as unknown as MarketsService,
      {} as MarketsContextService,
      {} as RedirectsService,
      {} as CorsOriginService,
    );
    return { service, prisma, markets };
  }

  it("refuses 'ku' as primary before any read or write", async () => {
    const { service, prisma, markets } = build();
    await expect(
      service.updateLanguages('u1', {
        primary_locale: 'ku',
        secondary_locales: ['en'],
      }),
    ).rejects.toMatchObject({ response: { code: STORE_LANGUAGE_IN_REVIEW } });
    expect(prisma.creator.findUnique).not.toHaveBeenCalled();
    expect(prisma.storeLanguageConfig.upsert).not.toHaveBeenCalled();
    expect(markets.mirrorLanguagesIntoDefault).not.toHaveBeenCalled();
  });

  it("accepts 'ku' as a secondary language and mirrors it unchanged", async () => {
    const { service, prisma, markets } = build('sv');
    const config = await service.updateLanguages('u1', {
      primary_locale: 'sv',
      secondary_locales: ['en', 'ku', 'ku', 'sv'],
    });
    expect(prisma.storeLanguageConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { primary_locale: 'sv', secondary_locales: ['en', 'ku'] },
      }),
    );
    expect(config.secondary_locales).toEqual(['en', 'ku']);
    expect(markets.mirrorLanguagesIntoDefault).toHaveBeenCalledWith(
      's1',
      'sv',
      ['en', 'ku'],
    );
  });

  it('a secondary-only update passes without a primary in the body', async () => {
    const { service, prisma } = build('en');
    await service.updateLanguages('u1', { secondary_locales: ['ku'] });
    expect(prisma.storeLanguageConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { secondary_locales: ['ku'] } }),
    );
  });
});

describe('MarketsService default locale with a review locale', () => {
  const marketRow = {
    id: 'm2',
    store_id: 's1',
    key: 'se',
    name: 'Sweden',
    countries: ['SE'],
    default_locale: 'sv',
    locales: ['en'],
    currency: 'SEK',
    is_default: false,
    status: 'DRAFT',
    indexing: 'AUTO',
    price_rule: { mode: 'convert', source: 'manual', rate: 1 },
    payment_check: null,
    domains: [],
  };

  function build() {
    const written = new Error('market written');
    const prisma = {
      creator: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            store: {
              id: 's1',
              slug: 'shop',
              name: 'Shop',
              creator_id: 'c1',
              store_type: 'INDEPENDENT',
              currency: 'SEK',
            },
          }),
        ),
      },
      store: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            name: 'Shop',
            store_type: 'INDEPENDENT',
            currency: 'SEK',
            language_config: { primary_locale: 'sv', secondary_locales: [] },
          }),
        ),
      },
      platformConfig: {
        findFirst: jest.fn(() => Promise.resolve({ default_currency: 'SEK' })),
      },
      market: {
        // ensureDefaultMarket: the default market exists with the same
        // currency; rowOf: the market being edited.
        findFirst: jest.fn((args: { where: { is_default?: boolean } }) =>
          Promise.resolve(
            args.where.is_default
              ? { ...marketRow, id: 'm1', key: 'default', is_default: true }
              : marketRow,
          ),
        ),
        // Stop right after the write: the test only inspects its data.
        update: jest.fn(() => Promise.reject(written)),
        create: jest.fn(() => Promise.reject(written)),
      },
    };
    const paymentCheck = {
      checkMarket: jest.fn(() => Promise.resolve({ stripe: 'ok' })),
    };
    const service = new MarketsService(
      prisma as unknown as PrismaService,
      {} as ConfigService,
      {} as RevalidationService,
      {} as StoreAppsService,
      { invalidate: jest.fn() } as unknown as MarketsContextService,
      {} as FxService,
      {} as DomainsService,
      {} as MarketPricingService,
      paymentCheck as unknown as PaymentCheckService,
    );
    return { service, prisma, written };
  }

  it("create refuses 'ku' as default locale", async () => {
    const { service, prisma } = build();
    await expect(
      service.create('u1', {
        key: 'kurdistan',
        name: 'Kurdistan',
        countries: ['IQ'],
        default_locale: 'ku',
        locales: ['en'],
        currency: 'SEK',
      } as CreateMarketDto),
    ).rejects.toMatchObject({ response: { code: STORE_LANGUAGE_IN_REVIEW } });
    expect(prisma.market.create).not.toHaveBeenCalled();
  });

  it("update refuses 'ku' as default locale", async () => {
    const { service, prisma } = build();
    await expect(
      service.update('u1', 'm2', {
        default_locale: 'KU',
        locales: ['en'],
      } as UpdateMarketDto),
    ).rejects.toMatchObject({ response: { code: STORE_LANGUAGE_IN_REVIEW } });
    expect(prisma.market.update).not.toHaveBeenCalled();
  });

  it("update accepts 'ku' in locales", async () => {
    const { service, prisma, written } = build();
    await expect(
      service.update('u1', 'm2', { locales: ['en', 'ku'] } as UpdateMarketDto),
    ).rejects.toBe(written);
    expect(prisma.market.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ locales: ['en', 'ku'] }),
      }),
    );
  });

  it('an update without default_locale is not affected', async () => {
    const { service, prisma, written } = build();
    await expect(
      service.update('u1', 'm2', { name: 'Sverige' } as UpdateMarketDto),
    ).rejects.toBe(written);
    expect(prisma.market.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: 'Sverige' } }),
    );
  });
});
