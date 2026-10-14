import { ConfigService } from '@nestjs/config';
import { MarketStatus } from '@prisma/client';
import { MarketsService } from './markets.service';
import {
  PaymentCheckService,
  paymentCheckPasses,
  type StripeCheckClient,
} from './payment-check.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsContextService } from './markets-context.service';
import { FxService } from './fx.service';
import { DomainsService } from './domains.service';
import { MarketPricingService } from './market-pricing.service';
import type { PaymentCheck } from './market.types';
import { checkKustomCountries } from '../payments/kustom/kustom.markets';

// The LIVE gate (M1-DESIGN §3.6): a market goes live only when at least one
// provider can charge its currency. Stripe is checked against the creator's
// Standard account through a fake platform client; Kustom against creator
// readiness and the static country→currency table.

const USER_ID = 'u1';
const STORE_ID = 's1';

interface CreatorRow {
  stripe_account_id: string | null;
  stripe_account_type: string | null;
  kustom_enabled: boolean;
  kustom_merchant_id: string | null;
  kustom_shared_secret: string | null;
}

const readyCreator: CreatorRow = {
  stripe_account_id: 'acct_1',
  stripe_account_type: 'standard',
  kustom_enabled: true,
  kustom_merchant_id: 'PK12345',
  kustom_shared_secret: 'enc:secret',
};

function makeStripe(
  account: Partial<
    Awaited<ReturnType<StripeCheckClient['accounts']['retrieve']>>
  > = {},
  spec: { supported_payment_currencies?: string[] } = {
    supported_payment_currencies: ['sek', 'eur', 'usd'],
  },
) {
  return {
    accounts: {
      retrieve: jest.fn(() =>
        Promise.resolve({
          id: 'acct_1',
          country: 'SE',
          default_currency: 'sek',
          charges_enabled: true,
          capabilities: { card_payments: 'active' },
          ...account,
        }),
      ),
    },
    countrySpecs: {
      retrieve: jest.fn(() => Promise.resolve(spec)),
    },
  };
}

/** A PaymentCheckService whose Stripe client is the given fake. */
class TestPaymentCheckService extends PaymentCheckService {
  constructor(
    prisma: unknown,
    private readonly fake: StripeCheckClient | null,
  ) {
    super(
      prisma as PrismaService,
      { get: () => undefined } as unknown as ConfigService,
      { decrypt: (v: string | null) => v } as unknown as CryptoService,
    );
  }
  protected newStripe(): StripeCheckClient {
    if (!this.fake) throw new Error('no stripe');
    return this.fake;
  }
}

function makeCheckPrisma(
  creator: CreatorRow | null,
  opts: { secret?: string | null } = {},
) {
  return {
    store: {
      findUnique: jest.fn(() => Promise.resolve(creator ? { creator } : null)),
    },
    platformConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve({
          stripe_secret_key:
            opts.secret === undefined ? 'sk_test' : opts.secret,
          default_currency: 'EUR',
        }),
      ),
    },
  };
}

function checker(
  creator: CreatorRow | null,
  stripe: StripeCheckClient | null = makeStripe(),
  opts: { secret?: string | null } = {},
) {
  return new TestPaymentCheckService(makeCheckPrisma(creator, opts), stripe);
}

describe('PaymentCheckService — Stripe', () => {
  it('ok: Standard account, charges enabled, card payments active, currency supported', async () => {
    const stripe = makeStripe();
    const check = await checker(readyCreator, stripe).checkMarket(STORE_ID, {
      currency: 'eur',
      countries: ['DE'],
    });
    expect(check.stripe).toBe('ok');
    expect(check.details.stripe).toEqual({
      account_id: 'acct_1',
      account_country: 'SE',
      charges_enabled: true,
      card_payments: 'active',
      currency_supported: true,
      settlement_currency_supported: true,
    });
    expect(stripe.accounts.retrieve).toHaveBeenCalledWith('acct_1');
    expect(stripe.countrySpecs.retrieve).toHaveBeenCalledWith('SE');
    expect(typeof check.checked_at).toBe('string');
  });

  it('ok with the settlement-conversion note when the country does not settle in the currency', async () => {
    const check = await checker(
      readyCreator,
      makeStripe({}, { supported_payment_currencies: ['sek'] }),
    ).checkMarket(STORE_ID, { currency: 'EUR', countries: ['DE'] });
    expect(check.stripe).toBe('ok');
    expect(check.details.stripe?.settlement_currency_supported).toBe(false);
  });

  it('missing (no_standard_account) without an account or with an Express one', async () => {
    const none = await checker({
      ...readyCreator,
      stripe_account_id: null,
      stripe_account_type: null,
    }).checkMarket(STORE_ID, { currency: 'EUR', countries: ['DE'] });
    expect(none.stripe).toBe('missing');
    expect(none.details.stripe).toEqual({ reason_code: 'no_standard_account' });

    const express = await checker({
      ...readyCreator,
      stripe_account_type: 'express',
    }).checkMarket(STORE_ID, { currency: 'EUR', countries: ['DE'] });
    expect(express.details.stripe?.reason_code).toBe('no_standard_account');

    // A legacy creator row: account id present, stripe_account_type never
    // written (the type column came later). Direct charges elsewhere
    // (PaymentsService, storefront card_payments_enabled) also require the
    // type to be 'standard', so the check answers the same way.
    const legacy = await checker({
      ...readyCreator,
      stripe_account_id: 'acct_1TZhfj77lJH7b9t7',
      stripe_account_type: null,
    }).checkMarket(STORE_ID, { currency: 'EUR', countries: ['DE'] });
    expect(legacy.stripe).toBe('missing');
    expect(legacy.details.stripe?.reason_code).toBe('no_standard_account');

    const noStore = await checker(null).checkMarket(STORE_ID, {
      currency: 'EUR',
      countries: ['DE'],
    });
    expect(noStore.stripe).toBe('missing');
    expect(noStore.kustom).toBe('missing');
  });

  it('missing (account_not_ready) when charges are disabled or card payments inactive', async () => {
    const stripe = makeStripe({ charges_enabled: false });
    const disabled = await checker(readyCreator, stripe).checkMarket(STORE_ID, {
      currency: 'EUR',
      countries: ['DE'],
    });
    expect(disabled.stripe).toBe('missing');
    expect(disabled.details.stripe).toMatchObject({
      account_id: 'acct_1',
      charges_enabled: false,
      card_payments: 'active',
      reason_code: 'account_not_ready',
    });
    expect(stripe.countrySpecs.retrieve).not.toHaveBeenCalled();

    const pending = await checker(
      readyCreator,
      makeStripe({ capabilities: { card_payments: 'pending' } }),
    ).checkMarket(STORE_ID, { currency: 'EUR', countries: ['DE'] });
    expect(pending.details.stripe).toMatchObject({
      card_payments: 'pending',
      reason_code: 'account_not_ready',
    });
  });

  it('missing (currency_not_supported_by_stripe) before any API call', async () => {
    const stripe = makeStripe();
    const check = await checker(readyCreator, stripe).checkMarket(STORE_ID, {
      currency: 'XXX',
      countries: ['DE'],
    });
    expect(check.stripe).toBe('missing');
    expect(check.details.stripe).toEqual({
      account_id: 'acct_1',
      currency_supported: false,
      reason_code: 'currency_not_supported_by_stripe',
    });
    expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
  });

  it('unknown on a Stripe API error or when the platform key is not configured', async () => {
    const failing = makeStripe();
    failing.accounts.retrieve.mockRejectedValueOnce(new Error('rate limited'));
    const apiError = await checker(readyCreator, failing).checkMarket(
      STORE_ID,
      { currency: 'EUR', countries: ['DE'] },
    );
    expect(apiError.stripe).toBe('unknown');
    expect(apiError.details.stripe).toEqual({
      account_id: 'acct_1',
      currency_supported: true,
    });

    const unconfigured = await checker(readyCreator, null, {
      secret: null,
    }).checkMarket(STORE_ID, { currency: 'EUR', countries: ['DE'] });
    expect(unconfigured.stripe).toBe('unknown');
  });

  it('stays ok when only the country spec lookup fails', async () => {
    const stripe = makeStripe();
    stripe.countrySpecs.retrieve.mockRejectedValueOnce(new Error('boom'));
    const check = await checker(readyCreator, stripe).checkMarket(STORE_ID, {
      currency: 'EUR',
      countries: ['DE'],
    });
    expect(check.stripe).toBe('ok');
    expect(check.details.stripe?.settlement_currency_supported).toBeUndefined();
  });
});

describe('PaymentCheckService — Kustom', () => {
  const noStripe = {
    ...readyCreator,
    stripe_account_id: null,
    stripe_account_type: null,
  };

  it('ok for SE + SEK', async () => {
    const check = await checker(noStripe).checkMarket(STORE_ID, {
      currency: 'SEK',
      countries: ['SE'],
    });
    expect(check.kustom).toBe('ok');
    expect(check.details.kustom).toEqual({
      configured: true,
      by_country: { SE: 'ok' },
    });
    expect(paymentCheckPasses(check)).toBe(true);
  });

  it('missing for SE + EUR, expecting SEK', async () => {
    const check = await checker(noStripe).checkMarket(STORE_ID, {
      currency: 'EUR',
      countries: ['SE', 'FI'],
    });
    expect(check.kustom).toBe('missing');
    expect(check.details.kustom).toEqual({
      configured: true,
      by_country: { SE: 'mismatch', FI: 'ok' },
      expected_currency: 'SEK',
    });
    expect(check.details.kustom?.reason_code).toBeUndefined();
  });

  it('unknown for a country the table does not list (or no countries)', async () => {
    const check = await checker(noStripe).checkMarket(STORE_ID, {
      currency: 'EUR',
      countries: ['TR'],
    });
    expect(check.kustom).toBe('unknown');
    expect(check.details.kustom).toEqual({
      configured: true,
      by_country: { TR: 'unknown' },
    });
    expect(
      (
        await checker(noStripe).checkMarket(STORE_ID, {
          currency: 'EUR',
          countries: [],
        })
      ).kustom,
    ).toBe('unknown');
    // A known country next to an unknown one decides.
    expect(checkKustomCountries(['de', 'TR'], 'eur')).toEqual({
      status: 'ok',
      by_country: { DE: 'ok', TR: 'unknown' },
    });
  });

  it('missing (not_configured) when the creator is not ready or Kustom is switched off', async () => {
    const off = await checker({
      ...noStripe,
      kustom_enabled: false,
    }).checkMarket(STORE_ID, { currency: 'SEK', countries: ['SE'] });
    expect(off.kustom).toBe('missing');
    expect(off.details.kustom).toEqual({
      configured: false,
      by_country: {},
      reason_code: 'not_configured',
    });
    const noSecret = await checker({
      ...noStripe,
      kustom_shared_secret: null,
    }).checkMarket(STORE_ID, { currency: 'SEK', countries: ['SE'] });
    expect(noSecret.details.kustom?.reason_code).toBe('not_configured');
  });

  it('missing (currency_not_supported) for a currency Kustom never processes', async () => {
    const check = await checker(noStripe).checkMarket(STORE_ID, {
      currency: 'TRY',
      countries: ['SE'],
    });
    expect(check.kustom).toBe('missing');
    expect(check.details.kustom).toEqual({
      configured: true,
      by_country: {},
      reason_code: 'currency_not_supported',
    });
  });
});

describe('paymentCheckPasses', () => {
  it('passes when either provider is ok', () => {
    const base = { checked_at: '', details: {} } as const;
    expect(
      paymentCheckPasses({ ...base, stripe: 'ok', kustom: 'missing' }),
    ).toBe(true);
    expect(
      paymentCheckPasses({ ...base, stripe: 'missing', kustom: 'ok' }),
    ).toBe(true);
    expect(
      paymentCheckPasses({ ...base, stripe: 'missing', kustom: 'unknown' }),
    ).toBe(false);
    expect(
      paymentCheckPasses({ ...base, stripe: 'unknown', kustom: 'unknown' }),
    ).toBe(false);
    expect(paymentCheckPasses(null)).toBe(false);
  });
});

// ── MarketsService.setStatus LIVE gating ────────────────────────────────────

function makeMarketsPrisma(market: {
  id: string;
  is_default?: boolean;
  status?: MarketStatus;
  countries?: string[];
  domains?: { status: string; redirect_to: string | null }[];
  price_rule?: unknown;
  fx?: Record<string, number>;
}) {
  const fxRows = market.fx ?? {};
  const row = {
    id: market.id,
    store_id: STORE_ID,
    key: market.is_default ? 'default' : 'eu',
    name: 'EU',
    countries: market.countries ?? ['DE'],
    default_locale: 'en',
    locales: [],
    currency: 'EUR',
    is_default: market.is_default ?? false,
    status: market.status ?? MarketStatus.DRAFT,
    price_rule: market.price_rule ?? {
      mode: 'convert',
      source: 'manual',
      rate: 0.1,
    },
    payment_check: null as unknown,
    // One ACTIVE canonical host unless the test says otherwise.
    domains: market.domains ?? [{ status: 'ACTIVE', redirect_to: null }],
  };
  return {
    row,
    creator: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          store: {
            id: STORE_ID,
            slug: 'namez',
            name: 'Namez',
            creator_id: 'c1',
            store_type: 'INDEPENDENT',
            currency: 'SEK',
          },
        }),
      ),
    },
    market: {
      findFirst: jest.fn(
        ({ where }: { where: { id?: string; status?: string } }) =>
          Promise.resolve(where.id === row.id ? row : null),
      ),
      update: jest.fn(({ data }: { data: Partial<typeof row> }) => {
        Object.assign(row, data);
        return Promise.resolve(row);
      }),
    },
    platformConfig: {
      findFirst: jest.fn(() => Promise.resolve({ default_currency: 'EUR' })),
    },
    platformFxRate: {
      findUnique: jest.fn(
        ({
          where,
        }: {
          where: { base_quote: { base: string; quote: string } };
        }) => {
          const k = `${where.base_quote.base}:${where.base_quote.quote}`;
          return Promise.resolve(k in fxRows ? { rate: fxRows[k] } : null);
        },
      ),
    },
    storeLanguageConfig: { upsert: jest.fn(() => Promise.resolve({})) },
    store: { update: jest.fn(() => Promise.resolve({})) },
  };
}

function buildMarkets(
  market: {
    id: string;
    is_default?: boolean;
    status?: MarketStatus;
    domains?: { status: string; redirect_to: string | null }[];
    price_rule?: unknown;
    fx?: Record<string, number>;
  },
  check: Partial<PaymentCheck>,
) {
  const prisma = makeMarketsPrisma(market);
  const paymentCheck = checker(readyCreator);
  const checkSpy = jest.spyOn(paymentCheck, 'checkMarket').mockResolvedValue({
    stripe: 'unknown',
    kustom: 'unknown',
    checked_at: '2026-10-14T00:00:00.000Z',
    details: {},
    ...check,
  });
  const revalidation = {
    revalidateStoreById: jest.fn(() => Promise.resolve()),
  };
  const ctx = { invalidate: jest.fn() };
  const config = { get: () => 'https://stores.platform.test' };
  const service = new MarketsService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
    revalidation as unknown as RevalidationService,
    {} as StoreAppsService,
    ctx as unknown as MarketsContextService,
    new FxService(prisma as unknown as PrismaService),
    { toView: (d: unknown) => d } as unknown as DomainsService,
    {} as MarketPricingService,
    paymentCheck,
  );
  return { service, prisma, ctx, revalidation, checkSpy };
}

describe('MarketsService.setStatus LIVE gating', () => {
  it('refuses LIVE when both providers are unknown and stores the check', async () => {
    const { service, prisma } = buildMarkets({ id: 'm-eu' }, {});
    await expect(
      service.setStatus(USER_ID, 'm-eu', MarketStatus.LIVE),
    ).rejects.toMatchObject({
      response: { code: 'MARKET_PAYMENT_CHECK_FAILED' },
    });
    expect(prisma.row.status).toBe(MarketStatus.DRAFT);
    expect(prisma.row.payment_check).toMatchObject({
      stripe: 'unknown',
      kustom: 'unknown',
    });
  });

  it('refuses LIVE when both providers are missing', async () => {
    const { service } = buildMarkets(
      { id: 'm-eu' },
      { stripe: 'missing', kustom: 'missing' },
    );
    await expect(
      service.setStatus(USER_ID, 'm-eu', MarketStatus.LIVE),
    ).rejects.toMatchObject({
      response: { code: 'MARKET_PAYMENT_CHECK_FAILED' },
    });
  });

  it('goes LIVE when one provider is ok, then invalidates and revalidates', async () => {
    const { service, prisma, ctx, revalidation, checkSpy } = buildMarkets(
      { id: 'm-eu' },
      { stripe: 'ok', kustom: 'missing' },
    );
    const view = await service.setStatus(USER_ID, 'm-eu', MarketStatus.LIVE);
    expect(view.status).toBe(MarketStatus.LIVE);
    expect(prisma.row.status).toBe(MarketStatus.LIVE);
    expect(view.payment_check).toMatchObject({ stripe: 'ok' });
    expect(checkSpy).toHaveBeenCalledWith(STORE_ID, {
      id: 'm-eu',
      currency: 'EUR',
      countries: ['DE'],
    });
    expect(ctx.invalidate).toHaveBeenCalledWith(STORE_ID);
    expect(revalidation.revalidateStoreById).toHaveBeenCalledWith(STORE_ID);
  });

  it('refuses LIVE without an ACTIVE, non-redirecting host (before any payment check)', async () => {
    for (const domains of [
      [],
      [{ status: 'PENDING', redirect_to: null }],
      [{ status: 'VERIFIED', redirect_to: null }],
      [{ status: 'ACTIVE', redirect_to: 'namez.shop' }],
    ]) {
      const { service, prisma, checkSpy } = buildMarkets(
        { id: 'm-eu', domains },
        { stripe: 'ok', kustom: 'ok' },
      );
      await expect(
        service.setStatus(USER_ID, 'm-eu', MarketStatus.LIVE),
      ).rejects.toMatchObject({
        response: { code: 'MARKET_PRIMARY_DOMAIN_REQUIRED' },
      });
      expect(prisma.row.status).toBe(MarketStatus.DRAFT);
      expect(checkSpy).not.toHaveBeenCalled();
    }
  });

  it('an ACTIVE redirecting host plus an ACTIVE canonical one is enough', async () => {
    const { service } = buildMarkets(
      {
        id: 'm-eu',
        domains: [
          { status: 'ACTIVE', redirect_to: 'namez.shop' },
          { status: 'ACTIVE', redirect_to: null },
        ],
      },
      { stripe: 'ok', kustom: 'missing' },
    );
    const view = await service.setStatus(USER_ID, 'm-eu', MarketStatus.LIVE);
    expect(view.status).toBe(MarketStatus.LIVE);
  });

  it('refuses LIVE when the market has no usable rate (MARKET_FX_RATE_MISSING)', async () => {
    // convert/platform without a PlatformFxRate row, and fixed without a rate.
    for (const price_rule of [
      { mode: 'convert', source: 'platform' },
      { mode: 'fixed' },
    ]) {
      const { service, prisma, checkSpy } = buildMarkets(
        { id: 'm-eu', price_rule },
        { stripe: 'ok', kustom: 'ok' },
      );
      await expect(
        service.setStatus(USER_ID, 'm-eu', MarketStatus.LIVE),
      ).rejects.toMatchObject({
        response: { code: 'MARKET_FX_RATE_MISSING' },
      });
      expect(prisma.row.status).toBe(MarketStatus.DRAFT);
      expect(checkSpy).not.toHaveBeenCalled();
    }
    // With the platform row present it goes live.
    const ok = buildMarkets(
      {
        id: 'm-eu',
        price_rule: { mode: 'convert', source: 'platform' },
        fx: { 'SEK:EUR': 0.09 },
      },
      { stripe: 'ok', kustom: 'missing' },
    );
    expect(
      (await ok.service.setStatus(USER_ID, 'm-eu', MarketStatus.LIVE)).status,
    ).toBe(MarketStatus.LIVE);
  });

  it('goes LIVE on Kustom alone as well', async () => {
    const { service } = buildMarkets(
      { id: 'm-eu' },
      { stripe: 'missing', kustom: 'ok' },
    );
    const view = await service.setStatus(USER_ID, 'm-eu', MarketStatus.LIVE);
    expect(view.status).toBe(MarketStatus.LIVE);
  });

  it('update(): switching to a platform source without a rate row is refused', async () => {
    const { service, prisma } = buildMarkets({ id: 'm-eu' }, {});
    await expect(
      service.update(USER_ID, 'm-eu', {
        price_rule: { mode: 'convert', source: 'platform' },
      }),
    ).rejects.toMatchObject({ response: { code: 'MARKET_FX_RATE_MISSING' } });
    expect(prisma.row.price_rule).toEqual({
      mode: 'convert',
      source: 'manual',
      rate: 0.1,
    });
    const withRow = buildMarkets({ id: 'm-eu', fx: { 'SEK:EUR': 0.09 } }, {});
    const view = await withRow.service.update(USER_ID, 'm-eu', {
      price_rule: { mode: 'convert', source: 'platform' },
    });
    expect(view.price_rule).toEqual({ mode: 'convert', source: 'platform' });
    expect(view.effective_rate).toBe(0.09);
  });

  it('update(): a LIVE market keeps its values when the re-run check fails; DRAFT accepts', async () => {
    const live = buildMarkets(
      { id: 'm-eu', status: MarketStatus.LIVE },
      { stripe: 'missing', kustom: 'missing' },
    );
    await expect(
      live.service.update(USER_ID, 'm-eu', { countries: ['FR'] }),
    ).rejects.toMatchObject({
      response: { code: 'MARKET_PAYMENT_CHECK_FAILED' },
    });
    expect(live.prisma.row.countries).toEqual(['DE']);
    expect(live.prisma.row.status).toBe(MarketStatus.LIVE);
    expect(live.prisma.row.payment_check).toMatchObject({ stripe: 'missing' });
    expect(live.ctx.invalidate).toHaveBeenCalledWith(STORE_ID);

    const draft = buildMarkets(
      { id: 'm-eu' },
      { stripe: 'missing', kustom: 'missing' },
    );
    const view = await draft.service.update(USER_ID, 'm-eu', {
      countries: ['FR'],
    });
    expect(view.countries).toEqual(['FR']);
    expect(view.payment_check).toMatchObject({ stripe: 'missing' });
  });

  it('update(): the key "default" is reserved', async () => {
    const { service } = buildMarkets({ id: 'm-eu' }, {});
    await expect(
      service.update(USER_ID, 'm-eu', { key: 'default' }),
    ).rejects.toMatchObject({ response: { code: 'MARKET_DEFAULT_LOCKED' } });
  });

  it('back to DRAFT needs no check; the default market can never be DRAFT', async () => {
    const live = buildMarkets({ id: 'm-eu', status: MarketStatus.LIVE }, {});
    expect(
      (await live.service.setStatus(USER_ID, 'm-eu', MarketStatus.DRAFT))
        .status,
    ).toBe(MarketStatus.DRAFT);
    expect(live.checkSpy).not.toHaveBeenCalled();
    const def = buildMarkets(
      { id: 'm-default', is_default: true, status: MarketStatus.LIVE },
      {},
    );
    await expect(
      def.service.setStatus(USER_ID, 'm-default', MarketStatus.DRAFT),
    ).rejects.toMatchObject({
      response: { code: 'MARKET_DEFAULT_LOCKED' },
    });
  });
});
