import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { isSupportedCurrency } from '../../common/money/currency.util';
import {
  isKustomCreatorReady,
  kustomCreatorSelect,
  type KustomCreatorFields,
} from '../payments/kustom/kustom.eligibility';
import {
  checkKustomCountries,
  isKustomMarketCurrency,
} from '../payments/kustom/kustom.markets';
import type { PaymentCheck, PaymentProviderCheck } from './market.types';

/** What the check needs to know about a market. */
export interface PaymentCheckMarket {
  id?: string;
  currency: string;
  countries: string[];
}

/**
 * The slice of the Stripe client the check uses. Kept as an interface so the
 * spec can stand in a fake and so this module does not depend on the
 * `Stripe.*` resource namespace (not surfaced under nodenext).
 */
export interface StripeCheckClient {
  accounts: {
    retrieve(id: string): Promise<{
      id: string;
      country?: string;
      default_currency?: string;
      charges_enabled?: boolean;
      capabilities?: { card_payments?: string };
    }>;
  };
  countrySpecs: {
    retrieve(country: string): Promise<{
      supported_payment_currencies?: string[];
    }>;
  };
}

type StripeDetails = NonNullable<PaymentCheck['details']['stripe']>;
type KustomDetails = NonNullable<PaymentCheck['details']['kustom']>;

interface CreatorPaymentFields extends KustomCreatorFields {
  stripe_account_id: string | null;
  stripe_account_type: string | null;
}

/**
 * Whether a market's currency can actually be charged by the creator's
 * payment providers (Stripe direct charges, Kustom). The result is stored on
 * the market and gates `status: LIVE` — at least one provider must be `ok`
 * (M1-DESIGN §3.6).
 *
 * Stripe: a presentment currency is accepted on every Standard account that
 * can take card payments (settlement converts to the account's default
 * currency), so the check is "account exists and is ready" plus "currency is
 * one Stripe accepts"; the country spec only adds the informative
 * `settlement_currency_supported` flag. Kustom: creator readiness plus the
 * static country→currency table, since Kustom exposes no market listing.
 *
 * MarketsModule cannot import PaymentsModule (it imports OrdersModule, which
 * imports MarketsModule), so the platform Stripe client is built here from
 * the same PlatformConfig secret PaymentsService.resolveStripe() reads.
 */
@Injectable()
export class PaymentCheckService {
  private readonly logger = new Logger(PaymentCheckService.name);
  private stripe: StripeCheckClient | null = null;
  private stripeKeyUsed: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
  ) {}

  async checkMarket(
    storeId: string,
    market: PaymentCheckMarket,
  ): Promise<PaymentCheck> {
    const currency = market.currency.trim().toUpperCase();
    const creator = await this.creatorOf(storeId);
    const [stripe, kustom] = await Promise.all([
      this.checkStripe(creator, currency),
      Promise.resolve(this.checkKustom(creator, currency, market.countries)),
    ]);
    return {
      stripe: stripe.status,
      kustom: kustom.status,
      checked_at: new Date().toISOString(),
      details: { stripe: stripe.details, kustom: kustom.details },
    };
  }

  private async creatorOf(
    storeId: string,
  ): Promise<CreatorPaymentFields | null> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: {
        creator: {
          select: {
            stripe_account_id: true,
            stripe_account_type: true,
            ...kustomCreatorSelect,
          },
        },
      },
    });
    return store?.creator ?? null;
  }

  // ── Stripe ──────────────────────────────────────────────────────────────

  private async checkStripe(
    creator: CreatorPaymentFields | null,
    currency: string,
  ): Promise<{ status: PaymentProviderCheck; details: StripeDetails }> {
    // 1. Direct charges need the creator's own Standard account.
    if (
      !creator?.stripe_account_id ||
      creator.stripe_account_type !== 'standard'
    ) {
      return {
        status: 'missing',
        details: { reason_code: 'no_standard_account' },
      };
    }
    const accountId = creator.stripe_account_id;
    // 2. Only currencies our Stripe-derived list accepts can be presented.
    if (!isSupportedCurrency(currency)) {
      return {
        status: 'missing',
        details: {
          account_id: accountId,
          currency_supported: false,
          reason_code: 'currency_not_supported_by_stripe',
        },
      };
    }
    // 3. The account must be able to take card payments right now.
    const stripe = await this.resolveStripe();
    if (!stripe) {
      return {
        status: 'unknown',
        details: { account_id: accountId, currency_supported: true },
      };
    }
    let account: Awaited<ReturnType<StripeCheckClient['accounts']['retrieve']>>;
    try {
      account = await stripe.accounts.retrieve(accountId);
    } catch (err) {
      this.logger.warn(
        `Stripe account check failed for ${accountId}: ${this.describe(err)}`,
      );
      return {
        status: 'unknown',
        details: { account_id: accountId, currency_supported: true },
      };
    }
    const cardPayments = account.capabilities?.card_payments ?? 'inactive';
    const details: StripeDetails = {
      account_id: accountId,
      account_country: account.country,
      charges_enabled: Boolean(account.charges_enabled),
      card_payments: cardPayments,
      currency_supported: true,
    };
    if (!account.charges_enabled || cardPayments !== 'active') {
      return {
        status: 'missing',
        details: { ...details, reason_code: 'account_not_ready' },
      };
    }
    // 4. Informative only: whether the market currency can also settle
    //    without conversion in the account's country.
    if (account.country) {
      try {
        const spec = await stripe.countrySpecs.retrieve(account.country);
        details.settlement_currency_supported = (
          spec.supported_payment_currencies ?? []
        ).includes(currency.toLowerCase());
      } catch (err) {
        this.logger.warn(
          `Stripe country spec lookup failed for ${account.country}: ${this.describe(err)}`,
        );
      }
    }
    return { status: 'ok', details };
  }

  /** Platform secret from PlatformConfig (encrypted at rest), env fallback. */
  private async resolveStripe(): Promise<StripeCheckClient | null> {
    let secret: string | null;
    try {
      const cfg = await this.prisma.platformConfig.findFirst({
        select: { stripe_secret_key: true },
      });
      secret =
        this.crypto.decrypt(cfg?.stripe_secret_key) ||
        this.config.get<string>('STRIPE_SECRET_KEY') ||
        null;
    } catch (err) {
      this.logger.warn(`Stripe secret lookup failed: ${this.describe(err)}`);
      return null;
    }
    if (!secret) {
      this.stripe = null;
      this.stripeKeyUsed = null;
      return null;
    }
    if (this.stripe && this.stripeKeyUsed === secret) return this.stripe;
    this.stripe = this.newStripe(secret);
    this.stripeKeyUsed = secret;
    return this.stripe;
  }

  /** Factory the spec overrides; never log the secret. */
  protected newStripe(secret: string): StripeCheckClient {
    return new Stripe(secret) as unknown as StripeCheckClient;
  }

  // ── Kustom ──────────────────────────────────────────────────────────────

  private checkKustom(
    creator: CreatorPaymentFields | null,
    currency: string,
    countries: string[],
  ): { status: PaymentProviderCheck; details: KustomDetails } {
    if (!isKustomCreatorReady(creator)) {
      return {
        status: 'missing',
        details: {
          configured: false,
          by_country: {},
          reason_code: 'not_configured',
        },
      };
    }
    if (!isKustomMarketCurrency(currency)) {
      return {
        status: 'missing',
        details: {
          configured: true,
          by_country: {},
          reason_code: 'currency_not_supported',
        },
      };
    }
    const matrix = checkKustomCountries(countries, currency);
    return {
      status: matrix.status,
      details: {
        configured: true,
        by_country: matrix.by_country,
        ...(matrix.expected_currency
          ? { expected_currency: matrix.expected_currency }
          : {}),
      },
    };
  }

  private describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The LIVE gate: at least one provider can charge the market currency. */
export function paymentCheckPasses(
  check: PaymentCheck | null | undefined,
): boolean {
  return check?.stripe === 'ok' || check?.kustom === 'ok';
}
