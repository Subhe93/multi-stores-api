import { BadRequestException, Logger } from '@nestjs/common';
import { PaymentMethod, StoreType } from '@prisma/client';
import { KustomService, type StoreContext } from './kustom.service';
import { KustomApiError, KustomClient } from './kustom.client';
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
import type { MarketContext } from '../../markets/market-context';
import type { MarketPaymentMethod } from '../../markets/market.types';

// M157 for the order-first Kustom flow: session creation and validation
// refuse an order whose market excludes Kustom; push / capture / refund are
// not gated. Plus the purchase_currency error mapping (requirement 2).

jest.mock('./kustom.client', () => ({
  ...jest.requireActual<typeof import('./kustom.client')>('./kustom.client'),
  KustomClient: jest.fn(),
}));

function marketCtx(
  paymentMethods: MarketPaymentMethod[] | null | undefined,
): MarketContext {
  return {
    id: 'm-eu',
    key: 'eu',
    name: 'eu',
    countries: ['DE'],
    defaultLocale: 'en',
    locales: [],
    currency: 'EUR',
    storeCurrency: 'SEK',
    rate: 0.1,
    priceRule: { mode: 'convert' },
    isDefault: false,
    status: 'LIVE',
    indexing: 'AUTO',
    primaryHostname: 'namez.shop',
    hostnames: ['namez.shop'],
    ...(paymentMethods !== undefined ? { paymentMethods } : {}),
  };
}

const storeCtx = (market: MarketContext | null): StoreContext => ({
  id: 's1',
  slug: 'namez-se',
  customDomain: null,
  name: 'Namez',
  termsPath: null,
  store_type: StoreType.INDEPENDENT,
  is_active: true,
  primaryLocale: 'sv',
  currency: market?.currency ?? 'SEK',
  creator: {
    id: 'c1',
    kustom_enabled: true,
    kustom_merchant_id: 'PK1',
    kustom_shared_secret: 'enc',
    kustom_environment: 'playground',
  },
  market,
});

const ORDER = {
  id: 'o1',
  order_number: 'MS-1',
  total: 29.9,
  currency: 'EUR',
  payment_method: PaymentMethod.KUSTOM,
  payment_status: 'awaiting_payment',
  kustom_order_id: null,
  kustom_push_token: 'push-token',
  store_id: 's1',
  market_id: 'm-eu',
  hostname: 'namez.shop',
  locale: null,
  customer: { user_id: 'u1' },
};

function build(market: MarketContext | null) {
  const prisma = {
    order: {
      findUnique: jest.fn(() => Promise.resolve({ ...ORDER })),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 's1',
          slug: 'namez-se',
          custom_domain: null,
          is_active: true,
        }),
      ),
    },
  };
  const markets = { byId: jest.fn(() => Promise.resolve(market)) };
  const service = new KustomService(
    { get: () => 'https://stores.example.com' } as unknown as ConfigService,
    prisma as unknown as PrismaService,
    {} as CryptoService,
    { registerShippedHook: jest.fn() } as unknown as OrdersService,
    {} as NotificationsService,
    {} as MailService,
    {} as RevalidationService,
    {} as TaxService,
    markets as unknown as MarketsContextService,
    {} as B2bService,
  );
  jest.spyOn(service, 'loadOrderContext').mockResolvedValue(storeCtx(market));
  jest.spyOn(service, 'credentialsFor').mockResolvedValue({
    merchantId: 'PK1',
    sharedSecret: 's',
    environment: 'playground',
    partnerId: null,
  });
  return { service, prisma, markets };
}

describe('KustomService order-first flow per market (M157)', () => {
  beforeEach(() => (KustomClient as unknown as jest.Mock).mockClear());

  it('createSession: the order market excludes Kustom -> 400, no Kustom client, nothing written', async () => {
    const { service, prisma } = build(marketCtx(['card']));
    await expect(service.createSession('u1', 'o1')).rejects.toMatchObject({
      response: { code: 'MARKET_PAYMENT_METHOD_NOT_ALLOWED', method: 'kustom' },
    });
    expect(KustomClient).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  const body = {
    order_id: 'k-1',
    order_amount: 2990,
    purchase_currency: 'EUR',
    merchant_reference1: 'o1',
  };

  it('validation: the order market excludes Kustom -> reject', async () => {
    const { service, markets } = build(marketCtx(['card']));
    const res = await service.handleValidation('o1', 'push-token', body);
    expect(res.ok).toBe(false);
    expect(markets.byId).toHaveBeenCalledWith('s1', 'm-eu');
    expect((res as { redirectUrl: string }).redirectUrl).toContain(
      'error=kustom_validation',
    );
  });

  it('regression: validation in an unset / kustom market (or market gone) is accepted as before', async () => {
    for (const market of [marketCtx(null), marketCtx(['kustom']), null]) {
      const { service } = build(market);
      expect(await service.handleValidation('o1', 'push-token', body)).toEqual({
        ok: true,
      });
    }
  });
});

describe('KustomService.toHttpException purchase_currency mapping (M157)', () => {
  const service = new KustomService(
    {} as ConfigService,
    {} as PrismaService,
    {} as CryptoService,
    { registerShippedHook: jest.fn() } as unknown as OrdersService,
    {} as NotificationsService,
    {} as MailService,
    {} as RevalidationService,
    {} as TaxService,
    {} as MarketsContextService,
    {} as B2bService,
  );
  const currencyError = new KustomApiError(
    400,
    {
      error_code: 'BAD_VALUE',
      error_messages: [
        'Bad value: purchase_currency (no configured currencies for order billing country: DE)',
      ],
    },
    'create checkout',
  );

  afterEach(() => jest.restoreAllMocks());

  it('maps to KUSTOM_CURRENCY_NOT_ENABLED and warns once with the context', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const err = service.toHttpException(
      currencyError,
      'create the checkout session',
      { storeId: 's1', currency: 'EUR', country: 'DE' },
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toEqual(
      expect.objectContaining({
        code: 'KUSTOM_CURRENCY_NOT_ENABLED',
        currency: 'EUR',
      }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toMatch(/^Kustom refused purchase_currency/);
    expect(line).toContain('store=s1 currency=EUR country=DE');
    expect(error).not.toHaveBeenCalled();
  });

  it('without context: still the code, no currency field', () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const err = service.toHttpException(currencyError, 'update');
    const res = (err as BadRequestException).getResponse() as Record<
      string,
      unknown
    >;
    expect(res.code).toBe('KUSTOM_CURRENCY_NOT_ENABLED');
    expect(res).not.toHaveProperty('currency');
  });

  it('other BAD_VALUE messages keep the generic 400 mapping', () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const other = new KustomApiError(
      400,
      { error_code: 'BAD_VALUE', error_messages: ['Bad value: order_lines'] },
      'create checkout',
    );
    const err = service.toHttpException(other, 'create the checkout session', {
      currency: 'EUR',
    });
    expect(err).toBeInstanceOf(BadRequestException);
    const res = (err as BadRequestException).getResponse() as Record<
      string,
      unknown
    >;
    expect(res.code).toBeUndefined();
    expect(String(res.message)).toMatch(/^Kustom error: /);
  });

  it('a non-400 with the same text is not the currency case', () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const err = service.toHttpException(
      new KustomApiError(
        403,
        {
          error_code: 'BAD_VALUE',
          error_messages: ['purchase_currency'],
        },
        'x',
      ),
      'create the checkout session',
    );
    expect(
      ((err as BadRequestException).getResponse() as { code?: string }).code,
    ).toBe('KUSTOM_REFUSED');
  });

  it('KustomApiError.errorMessages keeps strings only', () => {
    expect(
      new KustomApiError(400, { error_messages: ['a', 1, null, 'b'] }, 'x')
        .errorMessages,
    ).toEqual(['a', 'b']);
    expect(new KustomApiError(400, 'plain', 'x').errorMessages).toEqual([]);
    expect(new KustomApiError(400, null, 'x').errorMessages).toEqual([]);
  });
});
