import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  NotFoundException,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { UserRole, FulfillerType, StoreType } from '@prisma/client';
import type { OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  storeClosed,
  storeNotLive,
} from '../../common/stores/store-gate';
import {
  cartItemsUnavailable,
  unavailableOrderItems,
} from '../orders/cart-items-availability';
import { CryptoService } from '../../common/crypto/crypto.service';
import {
  toStripeAmount,
  fromStripeAmount,
  resolveOrderCurrency,
} from '../../common/money/currency.util';
import { splitProviderShares } from '../../common/money/provider-share.util';
import { MarketsContextService } from '../markets/markets-context.service';
import {
  OrdersService,
  type AbandonedPaymentCheckOptions,
  type AbandonedPaymentDecision,
} from '../orders/orders.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../mail/mail.service';
import { InvoiceTriggersService } from '../invoices/invoice-triggers.service';
import { DesignerTriggersService } from '../designer/designer-triggers.service';
import {
  isKustomEnabledForStore,
  kustomCreatorSelect,
} from './kustom/kustom.eligibility';
import {
  OWN_KEY_API,
  OWN_KEY_ERRORS,
  type OwnKeyApi,
} from './own-key/own-key.types';
import {
  isStripeAuthError,
  redactStripeSecrets,
  resolvePaymentRoute,
  routeOfOrder,
  type PaymentRoute,
} from './payment-route';

// The stripe package does not surface the `Stripe.*` resource namespace through
// its package entry under nodenext, so we derive the types we need from the
// client instance signatures instead.
type StripeClient = InstanceType<typeof Stripe>;
type StripeEvent = ReturnType<StripeClient['webhooks']['constructEvent']>;
type StripePaymentIntent = Awaited<
  ReturnType<StripeClient['paymentIntents']['retrieve']>
>;
type StripeAccount = Awaited<ReturnType<StripeClient['accounts']['retrieve']>>;
type StripeCharge = Awaited<ReturnType<StripeClient['charges']['retrieve']>>;
type PaymentIntentCreateParams = Parameters<
  StripeClient['paymentIntents']['create']
>[0];
type StripeRequestOptions = { stripeAccount: string } | undefined;

/** The Stripe client + request options an order's objects live behind. */
interface OrderStripe {
  route: PaymentRoute;
  storeId: string | null;
  stripe: StripeClient;
  opts: StripeRequestOptions;
  /** OWN_KEY: fingerprint of the key behind `stripe` (null otherwise). */
  fingerprint?: string | null;
  /** OWN_KEY: mode of the key behind `stripe` (undefined otherwise). */
  livemode?: boolean;
}

/** Customer-facing error codes of the card checkout (web maps them). */
export const PAYMENT_ERRORS = {
  /** The payment route changed and the old attempt could not be closed. */
  ROUTE_CHANGED_RETRY: 'PAYMENT_ROUTE_CHANGED_RETRY',
  /** Total below the Stripe minimum charge for the currency. */
  AMOUNT_TOO_SMALL: 'PAYMENT_AMOUNT_TOO_SMALL',
  /** Generic provider failure (own-key stores: no merchant Stripe text). */
  PROVIDER_ERROR: 'PAYMENT_PROVIDER_ERROR',
  PROCESSING: 'PAYMENT_PROCESSING',
} as const;

/**
 * Stripe minimum charge per presentment currency, in minor units
 * (docs.stripe.com/currencies#minimum-and-maximum-charge-amounts). Stripe
 * checks the settlement currency too, so a Stripe `amount_too_small` error
 * is mapped to the same code as a fallback.
 */
const STRIPE_MIN_AMOUNT: Record<string, number> = {
  usd: 50, eur: 50, gbp: 30, chf: 50, aud: 50, cad: 50, nzd: 50, sgd: 50,
  sek: 300, nok: 300, dkk: 250, pln: 200, czk: 1500, huf: 17500, ron: 200,
  bgn: 100, hkd: 400, jpy: 50, mxn: 1000, aed: 200, inr: 50, brl: 50,
  thb: 1000, myr: 200,
};

export function belowStripeMinimum(minor: number, currency: string): boolean {
  const min = STRIPE_MIN_AMOUNT[currency.toLowerCase()];
  return min !== undefined && minor < min;
}

/**
 * POST /payments/create-intent: a client secret to confirm, or the order's
 * payment state when there is nothing to confirm (already paid, a zero
 * total, or a payment Stripe is still processing).
 */
export type CreateIntentResult =
  | { clientSecret: string; paymentIntentId: string; route: PaymentRoute }
  | { status: 'paid' | 'processing' };

/**
 * Whether an intent's payment really failed: canceled, or back to
 * `requires_payment_method` AFTER a declined attempt (last_payment_error).
 * A never-confirmed intent is also `requires_payment_method` — that is not
 * a failure (the customer may still pay).
 */
export function intentHasFailed(pi: {
  status: string;
  last_payment_error?: unknown;
}): boolean {
  return (
    pi.status === 'canceled' ||
    (pi.status === 'requires_payment_method' && !!pi.last_payment_error)
  );
}



/** Timeline note of an order confirmed without a payment (total 0). */
export const ZERO_TOTAL_PAID_NOTE = 'No payment required (total 0)';

/**
 * A Stripe failure worth a retry with a NEW idempotency key: 5xx (Stripe
 * caches it under the key for 24h) or no response at all (connection).
 */
export function isRetryableStripeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { statusCode?: number; type?: string };
  return (
    (typeof e.statusCode === 'number' && e.statusCode >= 500) ||
    e.type === 'StripeConnectionError' ||
    e.type === 'StripeAPIError'
  );
}

/** A Stripe failure that will not clear on a retry (401 / 403 / 404). */
export function isPermanentStripeError(err: unknown): boolean {
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return status === 401 || status === 403 || status === 404;
}

/**
 * Which webhook endpoint delivered an event. `ownKeyStoreId` is set for the
 * per-store own-key endpoint; null for the platform / Connect endpoints.
 * Handlers called without a context (reconcile, refund sync) skip the
 * endpoint check because they act on an order they already resolved.
 */
export interface WebhookContext {
  ownKeyStoreId: string | null;
}

/** Fields of a Refund object the refund.* handlers read. */
interface RefundLike {
  id?: string;
  charge?: string | { id: string } | null;
  payment_intent?: string | { id: string } | null;
  status?: string | null;
  amount?: number;
  currency?: string;
  failure_reason?: string | null;
}

/** Fields of a Dispute object the charge.dispute.* handler reads. */
interface DisputeLike {
  charge?: string | { id: string } | null;
  payment_intent?: string | { id: string } | null;
  amount?: number;
  currency?: string;
  status?: string;
  reason?: string;
}

/** Order fields the route / endpoint decisions of webhook handlers need. */
const ORDER_ROUTE_SELECT = {
  id: true,
  order_number: true,
  store_id: true,
  payment_route: true,
  stripe_account_id: true,
  stripe_payment_id: true,
  stripe_key_fingerprint: true,
  payment_status: true,
} as const;

@Injectable()
export class PaymentsService implements OnModuleInit {
  private readonly logger = new Logger(PaymentsService.name);
  // Cached client + the secret it was built from, so we rebuild only when the
  // admin changes the key. Platform keys live in PlatformConfig (admin-managed)
  // and fall back to the STRIPE_* environment variables when unset.
  private stripe: StripeClient | null = null;
  private stripeKeyUsed: string | null = null;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private crypto: CryptoService,
    private orders: OrdersService,
    private notifications: NotificationsService,
    private mail: MailService,
    private markets: MarketsContextService,
    // Invoices app (M3 D5): optional; no-op without the app.
    @Optional() private readonly invoices?: InvoiceTriggersService,
    // Designer app (M4.2 WP5): optional and last; no-op without the app.
    @Optional() private readonly designerTriggers?: DesignerTriggersService,
    // Own Stripe key of INDEPENDENT stores (restricted key, no Connect).
    // Optional so the payment flow keeps working without the own-key module.
    @Optional()
    @Inject(OWN_KEY_API)
    private readonly ownKey?: OwnKeyApi,
  ) {}

  /**
   * The abandonment sweep (OrdersService) asks us before releasing a card
   * order that has a PaymentIntent, so an async payment (bank debit,
   * wallet, 3DS in progress) is never failed while it may still succeed.
   */
  onModuleInit(): void {
    this.orders.registerAbandonedPaymentChecker?.((order, opts) =>
      this.checkAbandonedOrder(order, opts),
    );
  }

  // ── Config resolution (DB first, env fallback) ─────────────────────────────

  private async resolveSecretKey(): Promise<string | null> {
    const cfg = await this.prisma.platformConfig.findFirst({
      select: { stripe_secret_key: true },
    });
    // DB value is encrypted at rest; decrypt before use. Env fallback is plain.
    return (
      this.crypto.decrypt(cfg?.stripe_secret_key) ||
      this.config.get<string>('STRIPE_SECRET_KEY') ||
      null
    );
  }

  private async resolveStripe(): Promise<StripeClient | null> {
    const secret = await this.resolveSecretKey();
    if (!secret) {
      this.stripe = null;
      this.stripeKeyUsed = null;
      return null;
    }
    if (this.stripe && this.stripeKeyUsed === secret) return this.stripe;
    this.stripe = new Stripe(secret);
    this.stripeKeyUsed = secret;
    return this.stripe;
  }

  private async requireStripe(): Promise<StripeClient> {
    const stripe = await this.resolveStripe();
    if (!stripe) {
      throw new BadRequestException('Stripe is not configured');
    }
    return stripe;
  }

  // ── Payment routes (own key / connect direct / platform) ───────────────────

  /** Whether the store's own Stripe key is ACTIVE (false without the module). */
  private async ownKeyActive(
    storeId: string | null | undefined,
    allowTest = false,
  ): Promise<boolean> {
    if (!storeId || !this.ownKey) return false;
    try {
      return await this.ownKey.isActive(storeId, { allowTest });
    } catch (err) {
      this.logger.warn(
        `Own key status lookup failed for store ${storeId}: ${this.describe(err)}`,
      );
      return false;
    }
  }

  /**
   * Route for a NEW payment of a store: OWN_KEY > CONNECT_DIRECT > PLATFORM.
   * A TEST-mode own key only routes with `allowTest` (the owner / an admin
   * previewing the store); the public checkout never pays on a test key.
   */
  async resolveRouteForStore(
    store: { id: string; store_type: StoreType | string } | null,
    opts: { allowTest?: boolean } = {},
  ): Promise<PaymentRoute> {
    const independent = store?.store_type === StoreType.INDEPENDENT;
    return resolvePaymentRoute({
      storeType: store?.store_type,
      ownKeyActive: independent
        ? await this.ownKeyActive(store.id, opts.allowTest === true)
        : false,
    });
  }

  private ownKeyNotActive(): BadRequestException {
    return new BadRequestException({
      code: OWN_KEY_ERRORS.NOT_ACTIVE,
      message:
        'This store cannot accept card payments right now. Please choose another payment method.',
    });
  }

  /**
   * The store's own merchant client (throws OWN_KEY_NOT_ACTIVE). With the
   * order's key fingerprint, an order paid with a replaced key is read back
   * with that (retained, read-only) key.
   */
  private async merchantCtx(
    storeId: string | null,
    fingerprint?: string | null,
  ): Promise<OrderStripe> {
    if (!storeId || !this.ownKey) throw this.ownKeyNotActive();
    try {
      const entry = await this.ownKey.getClientEntry(storeId, { fingerprint });
      return {
        route: 'OWN_KEY',
        storeId,
        stripe: entry.client,
        opts: undefined,
        fingerprint: entry.fingerprint,
        livemode: entry.livemode,
      };
    } catch {
      throw this.ownKeyNotActive();
    }
  }

  /** True for the OWN_KEY_NOT_ACTIVE error (client missing or revoked). */
  private isOwnKeyUnavailable(err: unknown): boolean {
    if (!(err instanceof HttpException)) return false;
    const res = err.getResponse() as { code?: unknown } | string;
    return typeof res === 'object' && res?.code === OWN_KEY_ERRORS.NOT_ACTIVE;
  }

  /**
   * Client + request options for an order's Stripe objects, picked by
   * `order.payment_route` (null = legacy: a connected-account snapshot means
   * a direct charge, else the platform).
   */
  private async stripeForOrder(order: {
    payment_route?: string | null;
    stripe_account_id?: string | null;
    store_id?: string | null;
    stripe_key_fingerprint?: string | null;
  }): Promise<OrderStripe> {
    const route = routeOfOrder(order);
    const storeId = order.store_id ?? null;
    if (route === 'OWN_KEY') {
      return this.merchantCtx(storeId, order.stripe_key_fingerprint ?? null);
    }
    return {
      route,
      storeId,
      stripe: await this.requireStripe(),
      opts:
        route === 'CONNECT_DIRECT' && order.stripe_account_id
          ? { stripeAccount: order.stripe_account_id }
          : undefined,
    };
  }

  /**
   * Run a call on an order's client. A 401 on a merchant key means the key
   * was revoked or expired: flag it (NEEDS_RECONNECT + owner notice) and
   * surface OWN_KEY_NOT_ACTIVE instead of a raw Stripe error.
   */
  private async callStripe<T>(
    ctx: OrderStripe,
    fn: (stripe: StripeClient, opts: StripeRequestOptions) => Promise<T>,
  ): Promise<T> {
    try {
      return await fn(ctx.stripe, ctx.opts);
    } catch (err) {
      if (ctx.route === 'OWN_KEY' && isStripeAuthError(err)) {
        if (ctx.storeId && this.ownKey) {
          try {
            await this.ownKey.markRevoked(
              ctx.storeId,
              'auth_failed',
              ctx.fingerprint ?? null,
            );
          } catch (markErr) {
            this.logger.error(
              `Could not flag the own key of store ${ctx.storeId}: ${this.describe(markErr)}`,
            );
          }
        }
        this.logger.warn(
          `Own Stripe key of store ${ctx.storeId} was rejected (401); marked for reconnect`,
        );
        throw this.ownKeyNotActive();
      }
      throw err;
    }
  }

  /**
   * Webhook endpoint isolation: the per-store endpoint only touches OWN_KEY
   * orders of THAT store; the platform / Connect endpoints never touch an
   * OWN_KEY order (its objects live on the merchant's own account).
   */
  private webhookMayTouch(
    ctx: WebhookContext | undefined,
    order: {
      id: string;
      store_id: string | null;
      payment_route?: string | null;
      stripe_account_id?: string | null;
    },
    eventType: string,
  ): boolean {
    if (!ctx) return true;
    const route = routeOfOrder(order);
    const ok = ctx.ownKeyStoreId
      ? order.store_id === ctx.ownKeyStoreId && route === 'OWN_KEY'
      : route !== 'OWN_KEY';
    if (!ok) {
      this.logger.warn(
        `Ignoring ${eventType} for order ${order.id}: not handled by this webhook endpoint` +
          (ctx.ownKeyStoreId ? ` (store ${ctx.ownKeyStoreId})` : ''),
      );
    }
    return ok;
  }

  private describe(err: unknown): string {
    return redactStripeSecrets(
      err instanceof Error ? err.message : String(err),
    );
  }

  async isStripeConfigured(): Promise<boolean> {
    return (await this.resolveStripe()) !== null;
  }

  async getPublishableKey(): Promise<string | null> {
    const cfg = await this.prisma.platformConfig.findFirst({
      select: { stripe_publishable_key: true },
    });
    return (
      cfg?.stripe_publishable_key ||
      this.config.get<string>('STRIPE_PUBLISHABLE_KEY') ||
      null
    );
  }

  /**
   * Public payment config for the storefront. Without a store slug (or for a
   * MARKETPLACE store) this is the platform config with stripeAccount: null.
   * For an INDEPENDENT store, stripeAccount is the creator's Standard connected
   * account (so Stripe.js can confirm the direct-charge PaymentIntent on it) —
   * and the store only counts as configured once that account is ready.
   * `kustomEnabled` follows the same independent-store rule for Kustom Checkout,
   * evaluated against the market currency when the markets app resolves one
   * for `marketKey` (the default market without a key; null when the app is
   * off, in which case the store currency decides as before).
   */
  async getPublicConfig(
    storeSlug?: string,
    marketKey?: string,
    preview?: boolean,
    /**
     * Whether the caller (optional bearer, StorefrontViewerGuard) is the
     * store's owner or an admin. Only they may pay on a TEST-mode own key
     * (`test_mode: true`) and read the config of a store that is not live.
     */
    viewerCanPreview?: (storeId: string) => Promise<boolean>,
  ) {
    const stripeConfigured = await this.isStripeConfigured();
    const publishableKey = await this.getPublishableKey();

    // Inactive stores get platform defaults, mirroring storefront.getStore's
    // is_active handling — an unpublished store must not leak its account
    // (its owner / an admin previewing it excepted).
    const row = storeSlug
      ? await this.prisma.store.findUnique({
          where: { slug: storeSlug },
          select: {
            id: true,
            is_active: true,
            store_type: true,
            currency: true,
            creator: {
              select: {
                stripe_account_id: true,
                stripe_account_type: true,
                stripe_charges_enabled: true,
                ...kustomCreatorSelect,
              },
            },
          },
        })
      : null;
    let ownerPreview = false;
    if (row && viewerCanPreview) {
      ownerPreview = await viewerCanPreview(row.id).catch(() => false);
    }
    const store = row && (row.is_active !== false || ownerPreview) ? row : null;

    if (!store || store.store_type !== StoreType.INDEPENDENT) {
      return {
        stripeConfigured,
        publishableKey,
        stripeAccount: null,
        route: 'PLATFORM' as PaymentRoute,
        kustomEnabled: false,
      };
    }

    // Kustom also needs a currency it can process: the market's when the
    // markets app applies, else the store's.
    // FIXES-1 item 4: an owner previewing a store that is not LIVE can only
    // test Stripe (TEST own key); Kustom would answer STORE_NOT_LIVE.
    const kustomEnabled = async () =>
      store.is_active !== false &&
      isKustomEnabledForStore({
        ...store,
        currency: resolveOrderCurrency(
          store,
          (
            await this.prisma.platformConfig.findFirst({
              select: { default_currency: true },
            })
          )?.default_currency,
          preview && marketKey
            ? await this.markets.resolve(store.id, marketKey, {
                preview: true,
              })
            : await this.markets.resolve(store.id, marketKey),
        ),
      });

    // Own Stripe key: Stripe.js runs on the merchant's own publishable key,
    // no connected account involved.
    const route = await this.resolveRouteForStore(store, {
      allowTest: ownerPreview,
    });
    if (route === 'OWN_KEY') {
      const ownPublishableKey =
        (await this.ownKey?.getPublishableKey(store.id)) ?? null;
      // Only reached with a test key when the viewer may preview.
      const testMode = ownPublishableKey?.startsWith('pk_test_') === true;
      return {
        stripeConfigured: Boolean(ownPublishableKey),
        publishableKey: ownPublishableKey,
        stripeAccount: null,
        route,
        kustomEnabled: await kustomEnabled(),
        ...(testMode ? { test_mode: true } : {}),
      };
    }

    const creator = store.creator;
    const stripeAccount =
      creator.stripe_account_type === 'standard' &&
      creator.stripe_charges_enabled
        ? creator.stripe_account_id
        : null;
    return {
      stripeConfigured:
        Boolean(publishableKey) && stripeConfigured && stripeAccount != null,
      publishableKey,
      stripeAccount,
      route,
      kustomEnabled: await kustomEnabled(),
    };
  }

  private async resolveWebhookSecret(): Promise<string | null> {
    const cfg = await this.prisma.platformConfig.findFirst({
      select: { stripe_webhook_secret: true },
    });
    // DB value is encrypted at rest; decrypt before use. Env fallback is plain.
    return (
      this.crypto.decrypt(cfg?.stripe_webhook_secret) ||
      this.config.get<string>('STRIPE_WEBHOOK_SECRET') ||
      null
    );
  }

  // Signing secret of the Connect (connected accounts) webhook endpoint, which
  // receives direct-charge events from independent stores' Standard accounts.
  private async resolveConnectWebhookSecret(): Promise<string | null> {
    const cfg = await this.prisma.platformConfig.findFirst({
      select: { stripe_connect_webhook_secret: true },
    });
    // DB value is encrypted at rest; decrypt before use. Env fallback is plain.
    return (
      this.crypto.decrypt(cfg?.stripe_connect_webhook_secret) ||
      this.config.get<string>('STRIPE_CONNECT_WEBHOOK_SECRET') ||
      null
    );
  }

  // ── Admin platform settings (ADMIN only; never returns secrets) ─────────────

  async getAdminSettings() {
    const cfg = await this.prisma.platformConfig.findFirst({
      select: {
        stripe_publishable_key: true,
        stripe_secret_key: true,
        stripe_webhook_secret: true,
        stripe_connect_webhook_secret: true,
        kustom_partner_id: true,
      },
    });
    const envSecret = Boolean(this.config.get<string>('STRIPE_SECRET_KEY'));
    const envWebhook = Boolean(
      this.config.get<string>('STRIPE_WEBHOOK_SECRET'),
    );
    const envConnectWebhook = Boolean(
      this.config.get<string>('STRIPE_CONNECT_WEBHOOK_SECRET'),
    );
    const connectWebhookSecretConfigured =
      Boolean(cfg?.stripe_connect_webhook_secret) || envConnectWebhook;
    // Independent stores charge on their own accounts, so their events — most
    // importantly refunds the creator makes from their own Stripe dashboard —
    // only reach us through the Connect endpoint. Without its signing secret
    // every one of those events is rejected, so flag it rather than let
    // refunds silently never sync.
    const independentStores = await this.prisma.store.count({
      where: { store_type: StoreType.INDEPENDENT },
    });
    return {
      publishableKey: cfg?.stripe_publishable_key || null,
      secretKeyConfigured: Boolean(cfg?.stripe_secret_key) || envSecret,
      webhookSecretConfigured:
        Boolean(cfg?.stripe_webhook_secret) || envWebhook,
      connectWebhookSecretConfigured,
      connectWebhookRequired: independentStores > 0,
      independentStoreCount: independentStores,
      // True when no DB secret is set but an env key is in use (legacy fallback).
      usingEnvFallback: !cfg?.stripe_secret_key && envSecret,
      // Platform's Kustom partner id (plain text, not a secret).
      kustomPartnerId: cfg?.kustom_partner_id || null,
    };
  }

  async updateAdminSettings(dto: {
    secret_key?: string;
    publishable_key?: string;
    webhook_secret?: string;
    connect_webhook_secret?: string;
    kustom_partner_id?: string;
  }) {
    let config = await this.prisma.platformConfig.findFirst();
    if (!config) config = await this.prisma.platformConfig.create({ data: {} });

    // Only touch provided fields; an explicit empty string clears the value.
    const data: {
      stripe_secret_key?: string | null;
      stripe_publishable_key?: string | null;
      stripe_webhook_secret?: string | null;
      stripe_connect_webhook_secret?: string | null;
      kustom_partner_id?: string | null;
    } = {};
    // Secret key and webhook secrets are encrypted at rest; the publishable key
    // is a public value and stays plaintext.
    if (dto.secret_key !== undefined)
      data.stripe_secret_key = this.crypto.encrypt(dto.secret_key.trim());
    if (dto.publishable_key !== undefined)
      data.stripe_publishable_key = dto.publishable_key.trim() || null;
    if (dto.webhook_secret !== undefined)
      data.stripe_webhook_secret = this.crypto.encrypt(
        dto.webhook_secret.trim(),
      );
    if (dto.connect_webhook_secret !== undefined)
      data.stripe_connect_webhook_secret = this.crypto.encrypt(
        dto.connect_webhook_secret.trim(),
      );
    // The partner id is an identifier Kustom sends back in headers, not a
    // credential — stored plain so the admin can read it back.
    if (dto.kustom_partner_id !== undefined)
      data.kustom_partner_id = dto.kustom_partner_id.trim() || null;

    await this.prisma.platformConfig.update({
      where: { id: config.id },
      data,
    });
    // Invalidate the cached client so the next call picks up the new key.
    this.stripe = null;
    this.stripeKeyUsed = null;
    return this.getAdminSettings();
  }

  /**
   * Run a Stripe SDK call and turn provider errors into a 400 carrying the
   * Stripe message, so the client sees the real cause (e.g. "Connect is not
   * enabled on this account") instead of an opaque 500.
   */
  private async runStripe<T>(
    fn: () => Promise<T>,
    action: string,
    route?: PaymentRoute,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      // Already a client-facing error (e.g. OWN_KEY_NOT_ACTIVE): keep it.
      if (err instanceof HttpException) throw err;
      const message = this.describe(err);
      this.logger.error(
        `Stripe error while trying to ${action}${route ? ` (${route})` : ''}: ${message}`,
      );
      if ((err as { code?: unknown } | null)?.code === 'amount_too_small') {
        throw this.amountTooSmall();
      }
      // The text of a merchant's own Stripe account (OWN_KEY) can name its
      // settings / account; customers get a generic message + code, the
      // redacted detail stays in the log above.
      if (route === 'OWN_KEY') {
        throw new BadRequestException({
          code: PAYMENT_ERRORS.PROVIDER_ERROR,
          message:
            'The card payment could not be started. Please try again or choose another payment method.',
        });
      }
      throw new BadRequestException(`Stripe error: ${message}`);
    }
  }

  // ── Stripe Connect onboarding (creators AND providers) ──────────────────────
  // Both parties are payout recipients in the separate-charges-and-transfers
  // model, so the platform never charges on their accounts — they only need the
  // `transfers` capability. "Onboarded" therefore means payouts_enabled.

  private async resolveParty(userId: string, role: UserRole) {
    if (role === UserRole.PROVIDER) {
      const p = await this.prisma.provider.findUnique({
        where: { user_id: userId },
        include: { user: { select: { email: true } } },
      });
      if (!p) throw new NotFoundException('Provider profile not found');
      return {
        kind: 'provider' as const,
        id: p.id,
        email: p.user.email,
        stripeAccountId: p.stripe_account_id,
        // Providers are always payout recipients — Express + transfers only.
        accountType: 'express' as string | null,
        independentStore: false,
        chargesEnabled: p.stripe_charges_enabled,
        payoutsEnabled: p.stripe_payouts_enabled,
        onboardingCompleted: Boolean(p.stripe_onboarding_completed_at),
        dashboardPath: '/provider/settings',
      };
    }
    const c = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      include: {
        user: { select: { email: true } },
        store: { select: { store_type: true } },
      },
    });
    if (!c) throw new NotFoundException('Creator profile not found');
    return {
      kind: 'creator' as const,
      id: c.id,
      email: c.user.email,
      stripeAccountId: c.stripe_account_id,
      accountType: c.stripe_account_type,
      // Independent-store creators charge directly on a Standard account, so
      // their "ready" signal is charges_enabled rather than payouts_enabled.
      independentStore: c.store?.store_type === StoreType.INDEPENDENT,
      chargesEnabled: c.stripe_charges_enabled,
      payoutsEnabled: c.stripe_payouts_enabled,
      onboardingCompleted: Boolean(c.stripe_onboarding_completed_at),
      dashboardPath: '/creator/settings',
    };
  }

  private async saveAccountId(
    kind: 'creator' | 'provider',
    id: string,
    accountId: string,
    accountType: 'express' | 'standard',
  ) {
    if (kind === 'provider') {
      // Providers only ever get Express accounts; no type column needed.
      await this.prisma.provider.update({
        where: { id },
        data: { stripe_account_id: accountId },
      });
    } else {
      await this.prisma.creator.update({
        where: { id },
        data: {
          stripe_account_id: accountId,
          stripe_account_type: accountType,
        },
      });
    }
  }

  /**
   * Connect is phased out for INDEPENDENT stores: they take payments on their
   * own Stripe account (restricted key). A creator of an independent store
   * without a connected account gets 409 USE_OWN_STRIPE_KEY; stores already
   * on Connect, marketplace creators and providers are unchanged.
   */
  private assertConnectAllowed(party: {
    kind: 'creator' | 'provider';
    independentStore: boolean;
    stripeAccountId: string | null;
  }) {
    if (
      party.kind === 'creator' &&
      party.independentStore &&
      !party.stripeAccountId
    ) {
      throw new ConflictException({
        code: OWN_KEY_ERRORS.USE_OWN_STRIPE_KEY,
        message:
          'Independent stores connect their own Stripe account with a restricted key.',
      });
    }
  }

  /**
   * Ensure the party has a Stripe connected account, creating one on first
   * call. Payout recipients (providers, marketplace creators) get an Express
   * account with the `transfers` capability; creators of INDEPENDENT stores
   * get a Standard account so their store can charge cards directly.
   * Returns the connected account id. An existing account is returned as-is,
   * except for an independent-store creator stuck on a non-Standard account,
   * which is replaced (see below) — converting account types in place is not
   * possible in Stripe.
   */
  async getOrCreateConnectedAccount(
    userId: string,
    role: UserRole,
  ): Promise<string> {
    const party = await this.resolveParty(userId, role);
    this.assertConnectAllowed(party);
    const stripe = await this.requireStripe();

    const useStandard = party.kind === 'creator' && party.independentStore;
    // Stripe cannot convert an account's type in place, so a mismatch is fixed
    // by creating a brand-new account of the right kind and pointing our
    // records at it. This goes both ways: an independent-store creator stuck
    // on Express (cannot take direct charges), and a marketplace creator stuck
    // on Standard (created without the transfers capability, so payouts would
    // fail after the platform captured the charge). The old account stays
    // intact in Stripe — we simply stop referencing it.
    const wantType = useStandard ? 'standard' : 'express';
    const replaceMismatched =
      Boolean(party.stripeAccountId) &&
      party.kind === 'creator' &&
      party.accountType !== wantType;
    if (party.stripeAccountId && !replaceMismatched) {
      return party.stripeAccountId;
    }

    const account = await this.runStripe(
      () =>
        useStandard
          ? stripe.accounts.create({
              type: 'standard',
              email: party.email,
              metadata: { party_kind: party.kind, party_id: party.id },
            })
          : stripe.accounts.create({
              type: 'express',
              email: party.email,
              metadata: { party_kind: party.kind, party_id: party.id },
              capabilities: { transfers: { requested: true } },
            }),
      'create connected account',
    );

    await this.saveAccountId(
      party.kind,
      party.id,
      account.id,
      useStandard ? 'standard' : 'express',
    );
    if (replaceMismatched) {
      // The stored flags described the OLD account — reset them so onboarding
      // status reflects the brand-new (not yet onboarded) account.
      await this.prisma.creator.update({
        where: { id: party.id },
        data: {
          stripe_charges_enabled: false,
          stripe_payouts_enabled: false,
          stripe_onboarding_completed_at: null,
        },
      });
    }
    return account.id;
  }

  /**
   * Generate a one-time onboarding link for the party to complete KYC. The
   * return/refresh URLs point back at the relevant dashboard payout settings.
   */
  async createOnboardingLink(
    userId: string,
    role: UserRole,
  ): Promise<{ url: string }> {
    const party = await this.resolveParty(userId, role);
    this.assertConnectAllowed(party);
    const stripe = await this.requireStripe();
    const accountId = await this.getOrCreateConnectedAccount(userId, role);
    const dashboardUrl =
      this.config.get<string>('DASHBOARD_URL') || 'http://localhost:3002';

    const link = await this.runStripe(
      () =>
        stripe.accountLinks.create({
          account: accountId,
          refresh_url: `${dashboardUrl}${party.dashboardPath}?stripe=refresh`,
          return_url: `${dashboardUrl}${party.dashboardPath}?stripe=return`,
          type: 'account_onboarding',
        }),
      'create onboarding link',
    );
    return { url: link.url };
  }

  /**
   * Unlink the party's connected Stripe account. The account itself stays
   * intact in Stripe (historic charges keep working through the per-order
   * account snapshots) — we only drop our reference, which disables card
   * payments for their store until a new account is connected.
   */
  async disconnectConnectedAccount(userId: string, role: UserRole) {
    const party = await this.resolveParty(userId, role);
    if (!party.stripeAccountId) {
      throw new BadRequestException('No Stripe account is connected.');
    }
    if (party.kind === 'provider') {
      await this.prisma.provider.update({
        where: { id: party.id },
        data: {
          stripe_account_id: null,
          stripe_charges_enabled: false,
          stripe_payouts_enabled: false,
          stripe_onboarding_completed_at: null,
        },
      });
    } else {
      await this.prisma.creator.update({
        where: { id: party.id },
        data: {
          stripe_account_id: null,
          stripe_account_type: null,
          stripe_charges_enabled: false,
          stripe_payouts_enabled: false,
          stripe_onboarding_completed_at: null,
        },
      });
    }
    return { disconnected: true };
  }

  /** Onboarding status for the creator/provider dashboard. */
  async getConnectStatus(userId: string, role: UserRole) {
    let party = await this.resolveParty(userId, role);

    // If the account exists but isn't enabled yet, reconcile live from Stripe.
    // The account.updated webhook may not have arrived (or isn't configured),
    // e.g. immediately after the user returns from onboarding. Independent
    // stores charge directly, so their "enabled" signal is charges_enabled.
    const needsRefresh = party.independentStore
      ? !party.chargesEnabled
      : !party.payoutsEnabled;
    if (party.stripeAccountId && needsRefresh) {
      const stripe = await this.resolveStripe();
      if (stripe) {
        try {
          const account = await stripe.accounts.retrieve(party.stripeAccountId);
          await this.syncConnectAccount(account);
          party = await this.resolveParty(userId, role);
        } catch (err) {
          this.logger.warn(
            `Could not refresh Connect status for ${party.kind} ${party.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    return {
      connected: Boolean(party.stripeAccountId),
      charges_enabled: party.chargesEnabled,
      payouts_enabled: party.payoutsEnabled,
      onboarding_completed: party.onboardingCompleted,
      account_type: party.accountType,
      // Account type must match the store model in BOTH directions: an
      // independent store cannot charge on a legacy Express account, and a
      // marketplace store cannot receive transfers on a Standard account (it
      // was created without the transfers capability, so payouts would fail
      // after the platform already captured the charge). The dashboard shows a
      // "reconnect required" state; the next onboarding-link request replaces
      // the account with the right kind.
      requires_relink:
        Boolean(party.stripeAccountId) &&
        (party.independentStore
          ? party.accountType !== 'standard'
          : party.accountType === 'standard'),
    };
  }

  /**
   * Sync local onboarding flags from a Stripe account (account.updated webhook).
   * The event doesn't say whether the account belongs to a creator or provider,
   * so we try both. Completion is keyed on payouts_enabled (transfers model),
   * except for Standard accounts (direct charges) which key on charges_enabled.
   */
  private async syncConnectAccount(account: StripeAccount) {
    const completedAt = account.payouts_enabled ? new Date() : null;

    const creator = await this.prisma.creator.findFirst({
      where: { stripe_account_id: account.id },
      select: {
        id: true,
        stripe_onboarding_completed_at: true,
        stripe_account_type: true,
      },
    });
    if (creator) {
      const creatorCompletedAt =
        creator.stripe_account_type === 'standard'
          ? account.charges_enabled
            ? new Date()
            : null
          : completedAt;
      await this.prisma.creator.update({
        where: { id: creator.id },
        data: {
          stripe_charges_enabled: account.charges_enabled,
          stripe_payouts_enabled: account.payouts_enabled,
          stripe_onboarding_completed_at:
            creator.stripe_onboarding_completed_at ?? creatorCompletedAt,
        },
      });
      return;
    }

    const provider = await this.prisma.provider.findFirst({
      where: { stripe_account_id: account.id },
      select: { id: true, stripe_onboarding_completed_at: true },
    });
    if (provider) {
      await this.prisma.provider.update({
        where: { id: provider.id },
        data: {
          stripe_charges_enabled: account.charges_enabled,
          stripe_payouts_enabled: account.payouts_enabled,
          stripe_onboarding_completed_at:
            provider.stripe_onboarding_completed_at ?? completedAt,
        },
      });
    }
  }

  // ── Payment intent (order-first) ────────────────────────────────────────────

  /**
   * Create a PaymentIntent for an existing order. The amount and currency are
   * derived server-side from the order so the client cannot tamper with them.
   *
   * Funds are collected on the PLATFORM account (separate charges & transfers):
   * after the payment succeeds the webhook splits the money out to each payout
   * recipient (every involved provider + the store creator) via transfers, and
   * the platform keeps its commission. We therefore require every recipient to
   * have completed Connect onboarding before allowing a card payment.
   *
   * INDEPENDENT stores charge directly: on the owner's own Stripe account
   * when their restricted key is ACTIVE (OWN_KEY), else on the legacy
   * Standard connected account (CONNECT_DIRECT). Every route enables the
   * payment methods the charging account has turned on (Payment Element).
   */
  async createPaymentIntentForOrder(
    userId: string,
    orderId: string,
    /**
     * Whether the storefront viewer (X-Storefront-Viewer: the same preview /
     * edit-hint or session bearer /payments/config is called with) is the
     * store's owner or an admin. Decides ONLY whether a TEST-mode own key
     * may take this payment; order ownership comes from the customer JWT.
     */
    viewerCanPreview?: (storeId: string) => Promise<boolean>,
  ): Promise<CreateIntentResult> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { user_id: true } },
        items: {
          select: {
            fulfiller_type: true,
            fulfiller_id: true,
            quantity: true,
            product_id: true,
            variant_id: true,
            custom_product_id: true,
            product: { select: { status: true } },
            variant: { select: { is_active: true } },
            custom_product: { select: { status: true } },
          },
        },
      },
    });

    if (!order) throw new NotFoundException('Order not found');
    if (order.customer.user_id !== userId) {
      throw new ForbiddenException('You can only pay for your own orders');
    }
    // Already paid (a webhook / confirm won the race, or a reload after
    // paying): answer 200 so the checkout goes straight to confirmation.
    if (order.payment_status === 'paid') return { status: 'paid' };
    if (order.payment_status === 'refunded') {
      throw new BadRequestException('Order is already paid');
    }

    // FIXES-1 item 5: a product of the unpaid order was deleted / archived /
    // unpublished since the order was placed. Nothing can be charged for it:
    // the order is failed (stock and coupon back) and the checkout drops the
    // lines and places a new order. Skipped while the order already has a
    // PaymentIntent (redirect / bank debit / 3DS may still succeed): failing
    // it here would release stock and coupon under a live payment, so the
    // normal reuse path and the abandonment sweep decide instead.
    const hasIntent = !!order.stripe_payment_id || !!order.payment_processing_at;
    const unavailable = hasIntent ? [] : unavailableOrderItems(order.items);
    if (unavailable.length) {
      try {
        await this.orders.markOrderFailed(
          order.id,
          'An item of the order is no longer available',
        );
      } catch (err) {
        this.logger.warn(
          `Could not fail order ${order.id} with unavailable items: ${this.describe(err)}`,
        );
      }
      throw cartItemsUnavailable(unavailable);
    }

    // FIXES-1 item 4: a store that is not LIVE only takes the payment of a
    // test order (the owner's pre-live checkout); its route is checked below.
    // Independent stores charge the customer DIRECTLY on the creator's Standard
    // connected account (direct charge) — no platform commission, no transfers.
    const store = order.store_id
      ? await this.prisma.store.findUnique({
          where: { id: order.store_id },
          select: {
            id: true,
            store_type: true,
            status: true,
            is_active: true,
            creator: {
              select: {
                user_id: true,
                stripe_account_id: true,
                stripe_account_type: true,
                stripe_charges_enabled: true,
              },
            },
          },
        })
      : null;
    const storeIsClosed = storeClosed(store);
    if (storeIsClosed && !order.is_test) throw storeNotLive();

    // Zero total (100% discount): nothing to charge, never sent to Stripe.
    // The order is confirmed as paid right away through the same finalize
    // path as a Stripe payment (invoices, designer, emails), minus transfers.
    if (!(Number(order.total) > 0)) {
      await this.recomputeCommission(order.id);
      const result = await this.orders.markOrderPaid(
        order.id,
        undefined,
        'none',
        { note: ZERO_TOTAL_PAID_NOTE },
      );
      await this.finalizePaidOrder(order.id, order.store_id, result, {
        transfers: false,
      });
      return { status: 'paid' };
    }
    const amount = toStripeAmount(Number(order.total), order.currency);
    if (belowStripeMinimum(amount, order.currency)) {
      throw this.amountTooSmall();
    }

    await this.recomputeCommission(order.id);

    const isIndependent = store?.store_type === StoreType.INDEPENDENT;
    // A TEST-mode own key only takes payments from the store owner or an
    // admin previewing the checkout, decided with the same storefront viewer
    // as /payments/config (the customer JWT is a per-store customer account
    // and never the owner). Real customers never pay on a test key.
    const allowTest =
      isIndependent &&
      !!store &&
      !!viewerCanPreview &&
      (await viewerCanPreview(store.id).catch(() => false));
    const route = await this.resolveRouteForStore(store, { allowTest });
    // FIXES-1 item 4: on a store that is not LIVE only the owner / an admin
    // pays, and only through the ACTIVE own key in TEST mode. Live keys,
    // Connect and the platform account stay refused.
    if (storeIsClosed) {
      const mode =
        allowTest && route === 'OWN_KEY' && store
          ? await this.ownKey?.getMode(store.id)
          : null;
      if (!mode || mode.status !== 'ACTIVE' || mode.livemode) {
        throw storeNotLive();
      }
    }

    let directAccountId: string | null = null;
    if (isIndependent) {
      // Defense in depth — order creation already rejects provider items for
      // independent stores, but never charge a mixed order directly.
      const allCreatorItems = order.items.every(
        (i) => i.fulfiller_type === FulfillerType.CREATOR,
      );
      if (!allCreatorItems) {
        throw new BadRequestException(
          'This store can only sell its own products.',
        );
      }
      const creator = store.creator;
      if (route === 'OWN_KEY') {
        // The owner's own account: no connected account, no transfers.
      } else if (
        !creator?.stripe_account_id ||
        !creator.stripe_charges_enabled ||
        creator.stripe_account_type !== 'standard'
      ) {
        throw new BadRequestException(
          'This store cannot accept card payments yet. Please choose cash on delivery.',
        );
      } else {
        directAccountId = creator.stripe_account_id;
      }
    } else {
      // Every payout recipient must be able to receive transfers before we take
      // the customer's money, otherwise the funds could not be split out.
      await this.assertRecipientsOnboarded(order.store_id, order.items);
    }

    // Calling create-intent again (retry, reload, deferred-intent submit)
    // reuses the order's open intent instead of opening a second one that
    // could also charge the customer.
    const reused = await this.reuseOpenIntent(order, route, directAccountId);
    if (reused) return reused;

    // The PaymentIntent carries the total (line-item detail isn't supported by
    // PaymentIntents — the itemized invoice lives in our order). We still attach
    // a description + metadata so the payment is traceable in Stripe.
    const lineCount = order.items.length;
    const unitCount = order.items.reduce((s, i) => s + i.quantity, 0);

    const params: PaymentIntentCreateParams = {
      // Not a plain ×100: zero-decimal currencies (JPY, KRW…) are already in
      // their smallest unit, so multiplying would charge 100× the total.
      amount,
      currency: order.currency.toLowerCase(),
      description: `Order ${order.order_number} — ${unitCount} item(s)`,
      metadata: {
        order_id: order.id,
        order_number: order.order_number,
        line_items: String(lineCount),
        unit_count: String(unitCount),
        ...(order.store_id ? { store_id: order.store_id } : {}),
        // b2b app: who bought, for reconciliation in the Stripe dashboard.
        // Absent for a person, so existing intents are built identically.
        ...(order.customer_type === 'COMPANY'
          ? {
              buyer_type: 'COMPANY',
              company_name: order.company_name ?? '',
              org_number: order.org_number ?? '',
            }
          : {}),
        // b2b app M2.5: why the intent carries no VAT (absent otherwise).
        ...(order.tax_exempt_reason
          ? { tax_exempt_reason: order.tax_exempt_reason }
          : {}),
      },
      // Every method the charging account enabled (card, wallets, Link,
      // Klarna, bank debits...) through the Payment Element; redirect-based
      // methods return to the checkout's return_url.
      automatic_payment_methods: { enabled: true },
    };

    // Every route: scoped to the route / account, the order, the amount and
    // the intent this order already has, so a double submit reuses one
    // intent while a later retry (after a failed / canceled attempt, or a
    // changed total) gets a fresh one.
    const ctx: OrderStripe =
      route === 'OWN_KEY'
        ? await this.merchantCtx(store!.id)
        : {
            route,
            storeId: order.store_id,
            stripe: await this.requireStripe(),
            opts: directAccountId
              ? { stripeAccount: directAccountId }
              : undefined,
          };
    // FIXES-1 item 4: the client actually used must be a TEST key on a store
    // that is not LIVE (the DB mode read above could race a key swap).
    if (storeIsClosed && ctx.livemode !== false) throw storeNotLive();
    // Stripe caches the response of an idempotency key for 24h, a 500 too:
    // after a 5xx / connection error the order's attempt counter is bumped
    // so the retry gets a fresh key (absent while 0: keys stay unchanged).
    const attempt = order.stripe_intent_attempt ?? 0;
    const idempotencyKey = [
      'pi',
      route,
      route === 'OWN_KEY' ? (ctx.fingerprint ?? '') : (directAccountId ?? 'platform'),
      order.id,
      `${params.amount}${params.currency}`,
      order.stripe_payment_id ?? 'first',
      ...(attempt > 0 ? [`a${attempt}`] : []),
    ].join('_');
    const testKey = route === 'OWN_KEY' && ctx.livemode === false;
    const intent = await this.runStripe(
      async () => {
        try {
          return await this.callStripe(ctx, (s, o) =>
            s.paymentIntents.create(params, { ...(o ?? {}), idempotencyKey }),
          );
        } catch (err) {
          if (isRetryableStripeError(err)) await this.bumpIntentAttempt(order.id);
          throw err;
        }
      },
      'create payment intent',
      route,
    );

    // Record the intent id on the order up front to aid reconciliation, plus
    // the route + connected account (or own-key fingerprint) it lives on —
    // every later retrieval of this PaymentIntent/charge must target that
    // same account / key.
    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        stripe_payment_id: intent.id,
        stripe_account_id: directAccountId,
        payment_route: route,
        stripe_key_fingerprint:
          route === 'OWN_KEY' ? (ctx.fingerprint ?? null) : null,
        payment_processing_at: null,
        // FIXES-1 item 1: paid through a TEST-mode own key = a test order
        // (excluded from every stats / earnings figure). Written only when
        // it is or was a test order, so real orders keep their update.
        ...(testKey || order.is_test ? { is_test: testKey } : {}),
      },
    });

    return {
      clientSecret: intent.client_secret!,
      paymentIntentId: intent.id,
      route,
    };
  }

  /** Next PaymentIntent create of the order uses a fresh idempotency key. */
  private async bumpIntentAttempt(orderId: string): Promise<void> {
    try {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { stripe_intent_attempt: { increment: 1 } },
      });
    } catch (err) {
      this.logger.warn(
        `Could not bump the intent attempt of order ${orderId}: ${this.describe(err)}`,
      );
    }
  }

  /**
   * Best-effort: re-derive the commission split from the store's CURRENT
   * store_type before charging, so an admin flipping the type while the
   * order sat unpaid can't leave a stale ledger driving the wrong payouts.
   * Never blocks payment: a failure just keeps the existing row.
   */
  private async recomputeCommission(orderId: string): Promise<void> {
    try {
      await this.orders.recomputeCommissionForOrder(orderId);
    } catch (err) {
      this.logger.warn(
        `Could not recompute commission for order ${orderId}: ${this.describe(err)}`,
      );
    }
  }

  /**
   * Everything that follows an order becoming paid, shared by a Stripe
   * payment (onPaymentSucceeded) and a zero total: card details, invoice,
   * designer renders, payouts (only `transfers`: a PLATFORM charge; no-op
   * for direct routes inside issueOrderTransfers) and, the first time, the
   * customer / owner notifications + emails. Steps that are not gated on
   * `changed` are idempotent, so a retried delivery heals a partial run.
   */
  private async finalizePaidOrder(
    orderId: string,
    storeId: string | null,
    result: Awaited<ReturnType<OrdersService['markOrderPaid']>>,
    opts: {
      chargeId?: string | null;
      transfers: boolean;
      rethrowTransfers?: boolean;
    },
  ): Promise<void> {
    // Capture the card/receipt details for tracking (best-effort, non-fatal).
    if (opts.chargeId) {
      await this.captureChargeDetails(orderId, opts.chargeId);
    }

    // Invoices app: issue after the card label is captured and before the
    // transfers (which may throw) and the confirmation email (which attaches
    // the invoice). Not gated on `changed`, so a retried delivery heals a
    // failed issuance; issuing is idempotent.
    await this.invoices?.onOrderPaid({
      id: orderId,
      store_id: storeId,
      payment_status: 'paid',
    });

    // Designer app: queue the print renders of the order's designed items
    // (enqueue only, never throws; idempotent on a replayed event).
    await this.designerTriggers?.onOrderPaid({
      id: orderId,
      store_id: storeId,
      payment_status: 'paid',
    });

    // Split the captured funds out to the payout recipients. Always attempted
    // (not gated on `changed`) so a webhook retry after a partial failure still
    // completes the transfers; Stripe idempotency keys prevent duplicates.
    if (opts.transfers) {
      await this.issueOrderTransfers(orderId, {
        rethrow: opts.rethrowTransfers !== false,
      });
    }

    if (result?.changed) await this.afterOrderPaid(orderId, result);
  }

  private amountTooSmall(): BadRequestException {
    return new BadRequestException({
      code: PAYMENT_ERRORS.AMOUNT_TOO_SMALL,
      message:
        'The order total is below the minimum card payment amount. Please choose another payment method.',
    });
  }

  /** Customer + owner notifications and emails of a newly paid order. */
  private async afterOrderPaid(
    orderId: string,
    result: { order: { customer: { user_id: string }; order_number: string } },
  ) {
    await this.notifications.create(
      result.order.customer.user_id,
      'order_paid',
      'Payment received',
      `We received your payment for order ${result.order.order_number}.`,
      { order_id: orderId },
    );
    // Send the paid order confirmation email + notify the owner (best-effort).
    // The dispatcher loads the order with items and resolves locale from the
    // store, so this stays a one-liner per event.
    await this.mail.dispatchOrderEmail(orderId, 'order_confirmation');
    await this.mail.dispatchOrderEmail(orderId, 'new_order_owner');
  }

  /**
   * The order's existing PaymentIntent, when it can still be confirmed on the
   * same account for exactly the order total. A succeeded intent finalises
   * the order (`{ status: 'paid' }`); a processing one answers
   * `{ status: 'processing' }`; a stale one (other route / account, other
   * amount) is canceled so at most one live intent exists per order. When
   * the route changed and the old intent cannot be read or canceled, the
   * call is refused (409 PAYMENT_ROUTE_CHANGED_RETRY) rather than opening a
   * second intent that could also charge. Returns null when a fresh intent
   * must be created.
   */
  private async reuseOpenIntent(
    order: {
      id: string;
      order_number?: string;
      store_id: string | null;
      payment_route: string | null;
      stripe_account_id: string | null;
      stripe_payment_id: string | null;
      stripe_key_fingerprint?: string | null;
      total: unknown;
      currency: string;
    },
    route: PaymentRoute,
    directAccountId: string | null,
  ): Promise<CreateIntentResult | null> {
    if (!order.stripe_payment_id) return null;
    const piId = order.stripe_payment_id;
    const sameAccount =
      routeOfOrder(order) === route &&
      (route !== 'CONNECT_DIRECT' ||
        order.stripe_account_id === directAccountId);
    const routeChanged = () =>
      new ConflictException({
        code: PAYMENT_ERRORS.ROUTE_CHANGED_RETRY,
        message:
          'The payment setup of this store changed. Please try again in a moment or choose another payment method.',
      });
    /**
     * The previous intent lives on ANOTHER route and could not be read or
     * canceled. Opening a second intent while the old one may still be
     * confirmable risks a double charge, so the first such call answers
     * 409 (a transient Stripe error usually clears on the retry). When it
     * is permanently unreachable (own key revoked / removed, 401 / 403 /
     * 404) or the retry fails again, the old attempt is recorded as
     * `abandoned_unreachable` (timeline + owner notification) and the order
     * switches to the new route. Should the abandoned intent still be paid,
     * onPaymentSucceeded flags it PAYMENT_STALE_INTENT for a refund.
     * Only reached for an order that is not paid (checked by the caller).
     */
    const abandonOrRetry = async (err: unknown): Promise<null> => {
      if (!isPermanentStripeError(err) && !this.isOwnKeyUnavailable(err)) {
        const first = await this.orders.recordPaymentNote(
          order.id,
          'PAYMENT_ROUTE_RETRY',
          `The previous payment attempt (${piId}) could not be closed; retry requested`,
        );
        if (first.changed) throw routeChanged();
      }
      const noted = await this.orders.recordPaymentNote(
        order.id,
        'PAYMENT_INTENT_ABANDONED',
        `abandoned_unreachable: the previous payment attempt (${piId}) could not be closed after the payment setup changed; check it in Stripe`,
      );
      if (noted.changed) {
        await this.notifyStoreCreator(
          order.store_id,
          'order_payment_attempt_abandoned',
          'Old payment attempt left open',
          `Order ${order.order_number ?? order.id} switched to your new payment setup, but its previous payment attempt (${piId}) could not be closed. If it is ever paid, refund it in that Stripe account.`,
          order.id,
        );
      }
      this.logger.warn(
        `Order ${order.id}: previous intent abandoned_unreachable, switching route`,
      );
      return null;
    };

    let ctx: OrderStripe;
    let pi: StripePaymentIntent;
    try {
      ctx = await this.stripeForOrder(order);
      pi = await this.callStripe(ctx, (s, o) =>
        s.paymentIntents.retrieve(piId, undefined, o),
      );
    } catch (err) {
      this.logger.warn(
        `Could not read the previous intent of order ${order.id}: ${this.describe(err)}`,
      );
      // A merchant 401 on the CURRENT route must reach the client.
      if (sameAccount && err instanceof HttpException) throw err;
      // The old attempt may still be confirmable on the other account.
      if (!sameAccount) return abandonOrRetry(err);
      return null;
    }

    if (pi.status === 'succeeded') {
      await this.onPaymentSucceeded(pi, { rethrowTransfers: false });
      return { status: 'paid' };
    }
    if (pi.status === 'processing' || pi.status === 'requires_capture') {
      return { status: 'processing' };
    }
    if (pi.status === 'canceled') return null;

    const reusable =
      pi.status === 'requires_payment_method' ||
      pi.status === 'requires_confirmation' ||
      pi.status === 'requires_action';
    const matches =
      pi.amount === toStripeAmount(Number(order.total), order.currency) &&
      (pi.currency ?? '').toLowerCase() === order.currency.toLowerCase();
    if (sameAccount && reusable && matches && pi.client_secret) {
      return {
        clientSecret: pi.client_secret,
        paymentIntentId: pi.id,
        route,
      };
    }

    // Stale intent: close it so it can never charge alongside the new one.
    try {
      await this.callStripe(ctx, (s, o) =>
        // 'duplicate' tells the canceled webhook this was our own
        // replacement, not a failed payment (see onPaymentFailed).
        s.paymentIntents.cancel(piId, { cancellation_reason: 'duplicate' }, o),
      );
    } catch (err) {
      this.logger.warn(
        `Could not cancel the previous intent of order ${order.id}: ${this.describe(err)}`,
      );
      if (!sameAccount) return abandonOrRetry(err);
    }
    return null;
  }

  /**
   * Throw a 400 unless the store creator and every provider whose items are in
   * the order have completed Connect onboarding (payouts enabled).
   */
  private async assertRecipientsOnboarded(
    storeId: string | null,
    items: { fulfiller_type: FulfillerType; fulfiller_id: string }[],
  ) {
    if (storeId) {
      const store = await this.prisma.store.findUnique({
        where: { id: storeId },
        select: {
          creator: {
            select: {
              stripe_account_id: true,
              stripe_account_type: true,
              stripe_payouts_enabled: true,
            },
          },
        },
      });
      const creator = store?.creator;
      if (!creator?.stripe_account_id || !creator.stripe_payouts_enabled) {
        throw new BadRequestException(
          'This store cannot accept card payments yet. Please choose cash on delivery.',
        );
      }
      // A Standard account left over from an independent phase has payouts
      // enabled but was created without the transfers capability, so the
      // platform would capture the charge and then fail to pay the creator.
      // Refuse the card up front instead of stranding the money.
      if (creator.stripe_account_type === 'standard') {
        throw new BadRequestException(
          'This store cannot accept card payments yet. Please choose cash on delivery.',
        );
      }
    }

    const providerIds = [
      ...new Set(
        items
          .filter((i) => i.fulfiller_type === FulfillerType.PROVIDER)
          .map((i) => i.fulfiller_id),
      ),
    ];
    if (providerIds.length === 0) return;

    const providers = await this.prisma.provider.findMany({
      where: { id: { in: providerIds } },
      select: {
        id: true,
        stripe_account_id: true,
        stripe_payouts_enabled: true,
      },
    });
    const ready = (id: string) => {
      const p = providers.find((x) => x.id === id);
      return Boolean(p?.stripe_account_id && p.stripe_payouts_enabled);
    };
    if (!providerIds.every(ready)) {
      throw new BadRequestException(
        'One of the suppliers for these items cannot receive payments yet. Please choose cash on delivery.',
      );
    }
  }

  // ── Reconcile (no hard dependency on the webhook) ───────────────────────────

  /**
   * Reconcile an order's payment by reading the PaymentIntent live from Stripe
   * and finalising it (mark paid + capture details + payouts, or mark failed).
   * Used right after the client confirms a card payment and as an admin "verify"
   * action, so order status doesn't depend on the webhook arriving.
   */
  async reconcilePayment(orderId: string): Promise<{
    payment_status: string;
    intent_status?: string;
    code?: string;
  }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        payment_status: true,
        stripe_payment_id: true,
        stripe_account_id: true,
        payment_route: true,
        stripe_key_fingerprint: true,
        store_id: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    // Already paid: a refund may have happened since — especially on an
    // independent store, where the creator refunds from their own Stripe
    // dashboard and the connect webhook is the only thing that would tell us.
    // Checking here makes this the manual fallback when that webhook is
    // missing or was never delivered.
    if (order.payment_status === 'paid') {
      const refunded = await this.syncRefundState(orderId);
      if (refunded) return { payment_status: 'refunded' };
      // Re-attempt payouts so a previously failed transfer can be retried
      // (idempotent — paid payouts are skipped). Don't rethrow: a failed
      // transfer is recorded and surfaced, not turned into a 500.
      await this.issueOrderTransfers(orderId, { rethrow: false });
      return { payment_status: 'paid' };
    }
    if (!order.stripe_payment_id) {
      return { payment_status: order.payment_status ?? 'awaiting_payment' };
    }

    // Direct-charge intents live on the connected account (or the owner's own
    // account for OWN_KEY), not the platform.
    let pi: StripePaymentIntent;
    try {
      const ctx = await this.stripeForOrder(order);
      pi = await this.runStripe(
        () =>
          this.callStripe(ctx, (s, opts) =>
            s.paymentIntents.retrieve(order.stripe_payment_id!, undefined, opts),
          ),
        'retrieve payment intent',
        routeOfOrder(order),
      );
    } catch (err) {
      // The store's own key is gone / revoked: the order is left open (the
      // per-store webhook or the owner reconnecting finishes it).
      if (this.isOwnKeyUnavailable(err)) {
        return {
          payment_status: order.payment_status ?? 'awaiting_payment',
          code: OWN_KEY_ERRORS.NOT_ACTIVE,
        };
      }
      throw err;
    }

    if (pi.status === 'succeeded') {
      await this.onPaymentSucceeded(pi, { rethrowTransfers: false });
      return { payment_status: 'paid' };
    }
    if (intentHasFailed(pi)) {
      await this.onPaymentFailed(pi);
      return { payment_status: 'failed' };
    }
    if (pi.status === 'processing') {
      await this.markProcessing(orderId);
    }
    // e.g. `processing` (bank debits, some wallets), or an intent that was
    // never confirmed (`requires_payment_method` without an error: a confirm
    // call after a network blip must not kill a good order): the order keeps
    // waiting. `intent_status` lets the checkout tell them apart.
    return {
      payment_status: order.payment_status ?? 'awaiting_payment',
      intent_status: pi.status,
    };
  }

  /** Flags an order whose payment Stripe is processing (sweep skips it). */
  private async markProcessing(orderId: string): Promise<void> {
    await this.prisma.order.updateMany({
      where: {
        id: orderId,
        payment_processing_at: null,
        payment_status: { notIn: ['paid', 'refunded'] },
      },
      data: { payment_processing_at: new Date() },
    });
  }

  /**
   * Live check of an order the abandonment sweep wants to release
   * (OrdersService.releaseExpiredAwaitingPaymentOrders): succeeded -> paid;
   * processing / requires_action / requires_capture -> keep; an intent that
   * can no longer be paid or was never paid -> canceled first (so a late
   * confirmation cannot charge a released order) and then failed. Unknown
   * state (Stripe unreachable, own key revoked / removed) -> keep: the
   * webhook or the owner reconnecting finishes those.
   */
  async checkAbandonedOrder(
    order: {
      id: string;
      store_id: string | null;
      payment_route: string | null;
      stripe_account_id: string | null;
      stripe_payment_id: string | null;
      stripe_key_fingerprint?: string | null;
    },
    caps: AbandonedPaymentCheckOptions = {},
  ): Promise<AbandonedPaymentDecision> {
    if (!order.stripe_payment_id) return 'fail';
    // Past the hard caps (OrdersService): an order nobody can finish is
    // failed instead of being kept forever.
    const hardCap = caps.hardCap === true || caps.processingExpired === true;
    const piId = order.stripe_payment_id;
    let ctx: OrderStripe;
    let pi: StripePaymentIntent;
    try {
      ctx = await this.stripeForOrder(order);
      pi = await this.callStripe(ctx, (s, o) =>
        s.paymentIntents.retrieve(piId, undefined, o),
      );
    } catch (err) {
      const status = (err as { statusCode?: unknown } | null)?.statusCode;
      if (status === 404) return 'fail';
      this.logger.warn(
        `Sweep: could not check the intent of order ${order.id}: ${this.describe(err)}` +
          (hardCap ? ' (past the maximum age: released)' : ''),
      );
      // Unreadable (Stripe down, own key revoked / removed): kept until the
      // hard cap, then failed; a late success still lands (late-pay path).
      return hardCap ? 'fail' : 'keep';
    }
    if (pi.status === 'succeeded') {
      await this.onPaymentSucceeded(pi, { rethrowTransfers: false });
      return 'paid';
    }
    if (pi.status === 'processing' || pi.status === 'requires_capture') {
      // Async payments (SEPA can take several business days) are kept up to
      // PROCESSING_PAYMENT_MAX_AGE_MS. Stripe cannot cancel a processing
      // intent; past the cap the order is released and a late success is
      // still accepted by markOrderPaid.
      if (caps.processingExpired) {
        await this.cancelForSweep(ctx, piId, order.id);
        return 'fail';
      }
      await this.markProcessing(order.id);
      return 'keep';
    }
    if (pi.status === 'requires_action') {
      if (!hardCap) return 'keep';
      // 3DS / redirect never finished within the cap: close it, then fail.
      await this.cancelForSweep(ctx, piId, order.id);
      return 'fail';
    }
    if (pi.status === 'canceled') return 'fail';
    // requires_payment_method / requires_confirmation: abandoned. Close the
    // intent first; if that fails (e.g. it was just confirmed), keep.
    try {
      await this.callStripe(ctx, (s, o) =>
        s.paymentIntents.cancel(
          piId,
          { cancellation_reason: 'abandoned' },
          o,
        ),
      );
      return 'fail';
    } catch (err) {
      this.logger.warn(
        `Sweep: could not cancel the intent of order ${order.id}: ${this.describe(err)}`,
      );
      return hardCap ? 'fail' : 'keep';
    }
  }

  /** Best-effort cancel of an intent the sweep releases past its cap. */
  private async cancelForSweep(
    ctx: OrderStripe,
    piId: string,
    orderId: string,
  ): Promise<void> {
    try {
      await this.callStripe(ctx, (s, o) =>
        s.paymentIntents.cancel(piId, { cancellation_reason: 'abandoned' }, o),
      );
    } catch (err) {
      this.logger.warn(
        `Sweep: could not cancel the intent of order ${orderId} (released anyway): ${this.describe(err)}`,
      );
    }
  }

  /**
   * Read the order's charge live and apply any refund we haven't seen yet.
   * Returns true when the order ends up fully refunded. Best-effort: this runs
   * inside reconcile, which must keep working even if the charge can't be read.
   */
  private async syncRefundState(orderId: string): Promise<boolean> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        stripe_charge_id: true,
        stripe_account_id: true,
        payment_route: true,
        stripe_key_fingerprint: true,
        store_id: true,
      },
    });
    if (!order?.stripe_charge_id) return false;
    try {
      const ctx = await this.stripeForOrder(order);
      const charge = await this.callStripe(ctx, (s, opts) =>
        s.charges.retrieve(order.stripe_charge_id!, undefined, opts),
      );
      if (!charge.refunded && charge.amount_refunded === 0) return false;
      // Reuse the webhook path so both routes apply identical effects.
      await this.onChargeRefunded(charge as StripeCharge);
      return charge.refunded;
    } catch (err) {
      this.logger.error(
        `Refund sync failed for order ${orderId}: ${this.describe(err)}`,
      );
      return false;
    }
  }

  /** Customer-facing: confirm own order's payment after card confirmation. */
  async confirmOrderPayment(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { customer: { select: { user_id: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.customer.user_id !== userId) {
      throw new ForbiddenException('You can only confirm your own orders');
    }
    return this.reconcilePayment(orderId);
  }

  // ── Webhook ──────────────────────────────────────────────────────────────

  async constructWebhookEvent(
    rawBody: Buffer,
    signature: string,
  ): Promise<StripeEvent> {
    const stripe = await this.requireStripe();
    const secret = await this.resolveWebhookSecret();
    if (!secret) {
      throw new BadRequestException('Stripe webhook secret is not configured');
    }
    return stripe.webhooks.constructEvent(rawBody, signature, secret);
  }

  // Same as above, but verified with the Connect endpoint's own signing secret.
  // Connect events carry `event.account` (the connected account they occurred
  // on); order resolution still goes through the PaymentIntent metadata.
  async constructConnectWebhookEvent(
    rawBody: Buffer,
    signature: string,
  ): Promise<StripeEvent> {
    const stripe = await this.requireStripe();
    const secret = await this.resolveConnectWebhookSecret();
    if (!secret) {
      throw new BadRequestException(
        'Stripe Connect webhook secret is not configured',
      );
    }
    return stripe.webhooks.constructEvent(rawBody, signature, secret);
  }

  /**
   * Verify an event from an INDEPENDENT store's own Stripe account, delivered
   * to that store's endpoint (`/payments/webhook/store/:storeId`) and signed
   * with the secret stored when the endpoint was created. Verification is
   * local (static helper), so no merchant API call is needed.
   */
  async constructStoreWebhookEvent(
    storeId: string,
    rawBody: Buffer,
    signature: string,
  ): Promise<StripeEvent> {
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }
    // The current endpoint's secret and, while a replaced key is retained,
    // the secret of the endpoint left on that key's account.
    const secrets = this.ownKey
      ? await this.ownKey.getWebhookSecrets(storeId)
      : [];
    if (!secrets.length) {
      throw new BadRequestException('Store webhook is not configured');
    }
    let lastErr: unknown = null;
    for (const secret of secrets) {
      try {
        return Stripe.webhooks.constructEvent(
          rawBody,
          signature,
          secret,
        ) as StripeEvent;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new BadRequestException('Invalid webhook signature');
  }

  /**
   * Dispatch a verified Stripe event. Errors are logged and rethrown so the
   * controller returns 5xx and Stripe retries the delivery — important because
   * a transient failure here happens *after* the customer was already charged.
   * Unknown orders / unhandled event types resolve normally (no retry).
   *
   * `ctx` names the endpoint: the platform / Connect endpoints (default) never
   * touch OWN_KEY orders; the per-store endpoint only touches OWN_KEY orders
   * of its own store, and reads them back with that store's merchant client.
   */
  async handleWebhookEvent(
    event: StripeEvent,
    ctx: WebhookContext = { ownKeyStoreId: null },
  ): Promise<void> {
    try {
      switch (event.type) {
        case 'payment_intent.succeeded': {
          const pi = event.data.object as StripePaymentIntent;
          await this.onPaymentSucceeded(pi, { webhook: ctx });
          break;
        }
        case 'payment_intent.payment_failed': {
          const pi = event.data.object as StripePaymentIntent;
          await this.onPaymentFailed(pi, { webhook: ctx });
          break;
        }
        case 'payment_intent.canceled': {
          const pi = event.data.object as StripePaymentIntent;
          await this.onPaymentFailed(pi, {
            webhook: ctx,
            canceled: true,
          });
          break;
        }
        case 'payment_intent.processing': {
          const pi = event.data.object as StripePaymentIntent;
          await this.onPaymentProcessing(pi, ctx);
          break;
        }
        case 'charge.refunded': {
          const charge = event.data.object as StripeCharge;
          await this.onChargeRefunded(charge, ctx);
          break;
        }
        case 'refund.created':
        case 'refund.updated':
        case 'refund.failed':
        case 'charge.refund.updated': {
          await this.onRefundEvent(
            event.data.object as unknown as RefundLike,
            ctx,
            event.type,
          );
          break;
        }
        case 'charge.dispute.created':
        case 'charge.dispute.updated':
        case 'charge.dispute.closed': {
          await this.onDisputeEvent(
            event.type,
            event.data.object as unknown as DisputeLike,
            ctx,
          );
          break;
        }
        case 'account.updated': {
          // Connect only — an own-key account has no Connect onboarding.
          if (ctx.ownKeyStoreId) break;
          await this.syncConnectAccount(event.data.object as StripeAccount);
          break;
        }
        default:
          // Unhandled event types are acknowledged and ignored.
          break;
      }
    } catch (err) {
      this.logger.error(
        `Failed handling Stripe event ${event.type} (${event.id})`,
        redactStripeSecrets(
          err instanceof Error ? (err.stack ?? err.message) : String(err),
        ),
      );
      // Rethrow so the webhook responds 5xx and Stripe retries the delivery.
      throw err;
    }
  }

  private async onPaymentSucceeded(
    pi: StripePaymentIntent,
    opts: { rethrowTransfers?: boolean; webhook?: WebhookContext } = {},
  ) {
    const orderId = pi.metadata?.order_id;
    if (!orderId) return;

    const orderRow = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        order_number: true,
        stripe_account_id: true,
        payment_route: true,
        stripe_key_fingerprint: true,
        stripe_payment_id: true,
        payment_status: true,
        store_id: true,
        total: true,
        currency: true,
      },
    });
    if (!orderRow) return;
    if (
      !this.webhookMayTouch(
        opts.webhook,
        { id: orderId, ...orderRow },
        'payment_intent.succeeded',
      )
    ) {
      return;
    }

    // SECURITY: never trust the (possibly replayed/forged-metadata) event
    // payload alone — re-read the PaymentIntent live from Stripe and only mark
    // the order paid when Stripe itself says it succeeded. A retrieval failure
    // propagates (the webhook handler logs + rethrows so Stripe retries).
    //
    // One exception: an OWN_KEY event delivered to the store's own endpoint
    // (signature verified with that store's secret, so the payload comes from
    // the merchant's account) while the merchant key is revoked / removed.
    // The customer has paid; the order is finished from the payload under the
    // same checks (order id, intent id, amount, currency) instead of failing
    // every retry with a 5xx.
    let live: StripePaymentIntent;
    try {
      const ctx = await this.stripeForOrder(orderRow);
      live = await this.callStripe(ctx, (s, o) =>
        s.paymentIntents.retrieve(pi.id, undefined, o),
      );
    } catch (err) {
      const fromStoreEndpoint =
        !!opts.webhook?.ownKeyStoreId &&
        routeOfOrder(orderRow) === 'OWN_KEY' &&
        orderRow.store_id === opts.webhook.ownKeyStoreId;
      if (!fromStoreEndpoint || !this.isOwnKeyUnavailable(err)) throw err;
      if (!orderRow.stripe_payment_id || pi.id !== orderRow.stripe_payment_id) {
        this.logger.warn(
          `Ignoring payment_intent.succeeded for order ${orderId}: own key unavailable and the event is not the order's intent`,
        );
        return;
      }
      this.logger.warn(
        `Own key of store ${orderRow.store_id} unavailable: finishing order ${orderId} from the verified webhook payload`,
      );
      live = pi;
    }
    if (live.status !== 'succeeded') {
      this.logger.warn(
        `Ignoring payment_intent.succeeded for order ${orderId}: live status is ${live.status}`,
      );
      return;
    }
    if (live.metadata?.order_id !== orderId) {
      this.logger.warn(
        `Ignoring payment_intent.succeeded for order ${orderId}: live intent belongs to a different order`,
      );
      return;
    }
    // An older attempt of this order (replaced by a newer intent, e.g. after a
    // route change or a total change) that still got paid: never counted as
    // the order's payment, whatever amount it collected (checked BEFORE the
    // amount, an old attempt usually carries the old total). The owner is
    // told to refund it in Stripe.
    if (orderRow.stripe_payment_id && live.id !== orderRow.stripe_payment_id) {
      this.logger.error(
        `payment_intent.succeeded for order ${orderId} is not its current intent (${live.id}); flagged for refund`,
      );
      const noted = await this.orders.recordPaymentNote(
        orderId,
        'PAYMENT_STALE_INTENT',
        `A payment was received on an old payment attempt (${live.id}); refund it in Stripe`,
      );
      if (noted.changed) {
        await this.notifyStoreCreator(
          orderRow.store_id,
          'order_payment_stale_intent',
          'Payment received on an old attempt',
          `Order ${orderRow.order_number} received a payment on an old payment attempt (${live.id}). Refund that payment in your Stripe dashboard.`,
          orderId,
        );
      }
      return;
    }
    // The intent must have collected exactly the order total, in the order
    // currency. An intent built elsewhere (an independent store's own Stripe
    // account can create one with any amount and this order id in metadata)
    // never marks the order paid.
    const expected = toStripeAmount(Number(orderRow.total), orderRow.currency);
    if (
      live.amount_received !== expected ||
      (live.currency ?? '').toLowerCase() !== orderRow.currency.toLowerCase()
    ) {
      this.logger.error(
        `Refusing payment_intent.succeeded for order ${orderId}: received ${live.amount_received} ${live.currency}, expected ${expected} ${orderRow.currency.toLowerCase()}`,
      );
      return;
    }

    const result = await this.orders.markOrderPaid(orderId, live.id);

    const chargeId =
      typeof live.latest_charge === 'string'
        ? live.latest_charge
        : live.latest_charge?.id;

    await this.finalizePaidOrder(orderId, orderRow.store_id, result, {
      chargeId,
      transfers: true,
      rethrowTransfers: opts.rethrowTransfers,
    });
  }

  /**
   * Distribute an order's captured payment to its providers and store creator
   * via Stripe transfers. Per-provider amounts are derived from each item's
   * stored provider base; the creator receives their margin. Idempotency keys
   * (per order + destination) make repeated webhook deliveries safe.
   *
   * Transfers are linked to the charge via source_transaction (so the funds are
   * drawn from that charge and don't require a separately-funded balance), and
   * are issued in the charge's SETTLEMENT currency at the charge's actual FX
   * rate. This is what makes a store charging in one currency (e.g. SEK) work
   * even when the platform settles in another (e.g. USD). The payout ledger
   * still records amounts in the order (presentment) currency for clarity.
   *
   * `rethrow` controls failure behaviour: the webhook rethrows (so Stripe
   * retries the delivery); the manual reconcile/confirm path swallows so it can
   * return gracefully with the failure recorded on the payout.
   */
  private async issueOrderTransfers(
    orderId: string,
    opts: { rethrow?: boolean } = {},
  ) {
    const rethrow = opts.rethrow !== false;
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          select: {
            fulfiller_type: true,
            fulfiller_id: true,
            provider_base_amount: true,
          },
        },
        commission: true,
      },
    });
    if (!order || !order.commission) return;

    // Direct charge (independent store, connected account or own key): the
    // money was captured straight on the owner's account — nothing to split,
    // no payout ledger rows.
    if (routeOfOrder(order) !== 'PLATFORM') return;
    const stripe = await this.requireStripe();

    // Resolve the charge and its settlement currency/FX rate.
    let chargeId = order.stripe_charge_id;
    if (!chargeId && order.stripe_payment_id) {
      const pi = await stripe.paymentIntents.retrieve(order.stripe_payment_id);
      chargeId =
        typeof pi.latest_charge === 'string'
          ? pi.latest_charge
          : (pi.latest_charge?.id ?? null);
    }
    if (!chargeId) return;

    // Resolve the charge's settlement currency + FX rate from its balance
    // transaction. If the balance transaction isn't ready yet (newly captured
    // charges can have a short pending window), DEFER the transfer instead of
    // attempting one with wrong params — sending a "best-guess" transfer in the
    // presentment currency would (a) be rejected by Stripe when settlement
    // currencies differ, and (b) burn the idempotency key with the wrong params,
    // poisoning the retry. The next webhook / verify-payment call will retry.
    let transferCurrency: string;
    let fxRate: number;
    try {
      const charge = await stripe.charges.retrieve(chargeId, {
        expand: ['balance_transaction'],
      });
      const btxn = charge.balance_transaction;
      if (!btxn || typeof btxn !== 'object' || charge.amount <= 0) {
        this.logger.warn(
          `Order ${orderId}: balance_transaction not ready — deferring payouts (will retry).`,
        );
        return;
      }
      transferCurrency = btxn.currency;
      fxRate = btxn.amount / charge.amount;
    } catch (err) {
      this.logger.warn(
        `Could not resolve settlement currency for order ${orderId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    // Minor units differ per currency, and the two sides of a transfer can be
    // in different currencies: amounts go out in the order's presentment
    // currency, the transfer itself in the account's settlement currency.
    const toCents = (n: unknown) => toStripeAmount(Number(n), order.currency);
    const finalChargeId = chargeId;

    // Create one transfer per recipient and record it in the payout ledger.
    // `presentmentCents` is in the order currency (used for the ledger); the
    // transfer is issued in the settlement currency at the charge's FX rate.
    const payout = async (
      recipientType: FulfillerType,
      recipientId: string,
      destination: string,
      presentmentCents: number,
    ) => {
      if (presentmentCents <= 0) return;
      const key = {
        order_id_recipient_type_recipient_id: {
          order_id: orderId,
          recipient_type: recipientType,
          recipient_id: recipientId,
        },
      };
      const existing = await this.prisma.orderPayout.findUnique({ where: key });
      if (existing?.status === 'paid') return;

      const ledgerAmount = fromStripeAmount(presentmentCents, order.currency);
      // fxRate is derived from the charge's balance transaction, so both sides
      // are already in their own smallest unit — a plain multiply is correct
      // even when the two currencies have different minor units.
      const settlementCents = Math.round(presentmentCents * fxRate);
      try {
        const tr = await stripe.transfers.create(
          {
            amount: settlementCents,
            currency: transferCurrency,
            destination,
            source_transaction: finalChargeId,
            metadata: {
              order_id: orderId,
              recipient_type: recipientType,
              recipient_id: recipientId,
            },
          },
          // Key includes the transfer currency so a prior attempt that ran with
          // a different settlement currency (e.g. before balance_transaction was
          // ready) can't poison this retry. v5: the largest-remainder
          // provider split can move a share by a cent, so a v4 key must not
          // replay a transfer with a different amount.
          {
            idempotencyKey: `transfer_${orderId}_${destination}_${transferCurrency}_v5`,
          },
        );
        await this.prisma.orderPayout.upsert({
          where: key,
          create: {
            order_id: orderId,
            recipient_type: recipientType,
            recipient_id: recipientId,
            stripe_account_id: destination,
            stripe_transfer_id: tr.id,
            amount: ledgerAmount,
            currency: order.currency,
            status: 'paid',
          },
          update: {
            stripe_account_id: destination,
            stripe_transfer_id: tr.id,
            amount: ledgerAmount,
            currency: order.currency,
            status: 'paid',
            error: null,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Payout transfer failed for order ${orderId}: ${message}`,
        );
        await this.prisma.orderPayout.upsert({
          where: key,
          create: {
            order_id: orderId,
            recipient_type: recipientType,
            recipient_id: recipientId,
            stripe_account_id: destination,
            amount: ledgerAmount,
            currency: order.currency,
            status: 'failed',
            error: message,
          },
          update: { status: 'failed', error: message },
        });
        if (rethrow) throw err;
      }
    };

    // ── Providers: split the aggregate provider_amount by each provider's base
    // (largest remainder, so the transfers add up to provider_amount exactly).
    const providerItems = order.items.filter(
      (i) => i.fulfiller_type === FulfillerType.PROVIDER,
    );
    const providerBaseTotal = providerItems.reduce(
      (s, i) => s + Number(i.provider_base_amount),
      0,
    );
    const providerAmountCents = toCents(order.commission.provider_amount);
    if (providerBaseTotal > 0 && providerAmountCents > 0) {
      const shareByProvider = splitProviderShares(
        providerAmountCents,
        providerItems,
      );
      const providers = await this.prisma.provider.findMany({
        where: { id: { in: [...shareByProvider.keys()] } },
        select: { id: true, stripe_account_id: true },
      });
      for (const [providerId, share] of shareByProvider) {
        const acct = providers.find(
          (p) => p.id === providerId,
        )?.stripe_account_id;
        if (!acct) continue;
        await payout(FulfillerType.PROVIDER, providerId, acct, share);
      }
    }

    // ── Creator: their margin on the order.
    const creatorAmountCents = toCents(order.commission.creator_amount);
    if (order.store_id && creatorAmountCents > 0) {
      const store = await this.prisma.store.findUnique({
        where: { id: order.store_id },
        select: { creator: { select: { id: true, stripe_account_id: true } } },
      });
      const acct = store?.creator?.stripe_account_id;
      if (acct && store?.creator) {
        await payout(
          FulfillerType.CREATOR,
          store.creator.id,
          acct,
          creatorAmountCents,
        );
      }
    }
  }

  /**
   * payment_intent.payment_failed / canceled. From a webhook, the order must
   * belong to the delivering endpoint; a cancellation only counts for the
   * order's CURRENT intent (an older abandoned intent being canceled must not
   * fail an order that is being paid with a newer one).
   */
  private async onPaymentFailed(
    pi: StripePaymentIntent,
    opts: { webhook?: WebhookContext; canceled?: boolean } = {},
  ) {
    const orderId = pi.metadata?.order_id;
    if (!orderId) return;
    const row = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: ORDER_ROUTE_SELECT,
    });
    if (!row) return;
    const type = opts.canceled
      ? 'payment_intent.canceled'
      : 'payment_intent.payment_failed';
    if (!this.webhookMayTouch(opts.webhook, row, type)) return;
    // Only the order's CURRENT intent fails it: an older attempt failing or
    // being canceled says nothing about the newer one being paid.
    if (row.stripe_payment_id && row.stripe_payment_id !== pi.id) return;
    // Replaced by a newer intent for the same order (reuseOpenIntent).
    if (opts.canceled && pi.cancellation_reason === 'duplicate') return;
    const result = await this.orders.markOrderFailed(
      orderId,
      ...(opts.canceled ? ['Stripe payment was canceled'] : []),
    );

    // Record the failure reason on the order for tracking.
    const err = pi.last_payment_error;
    if (err) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: {
          payment_failure_code: err.code ?? err.decline_code ?? null,
          payment_failure_message: err.message ?? null,
        },
      });
    }

    if (result?.changed) {
      await this.notifications.create(
        result.order.customer.user_id,
        'order_payment_failed',
        'Payment failed',
        `Your payment for order ${result.order.order_number} could not be completed.`,
        { order_id: orderId },
      );
    }
  }

  /**
   * A charge was refunded (from the Stripe dashboard of the platform OR of an
   * independent store's own account). When the charge is FULLY refunded, mark
   * the order's payment as refunded, record it on the timeline and notify the
   * store creator. The fulfillment status is left alone — the admin manages it.
   */
  /**
   * payment_intent.processing (bank debits, some wallets): the order stays
   * awaiting payment until payment_intent.succeeded; the timeline records
   * that Stripe is processing it.
   */
  private async onPaymentProcessing(
    pi: StripePaymentIntent,
    ctx?: WebhookContext,
  ) {
    const orderId = pi.metadata?.order_id;
    if (!orderId) return;
    const row = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: ORDER_ROUTE_SELECT,
    });
    if (!row) return;
    if (!this.webhookMayTouch(ctx, row, 'payment_intent.processing')) return;
    if (row.stripe_payment_id && row.stripe_payment_id !== pi.id) return;
    if (row.payment_status === 'paid' || row.payment_status === 'refunded') {
      return;
    }
    // The abandonment sweep never releases an order in this state.
    await this.markProcessing(orderId);
    await this.orders.recordPaymentNote(
      orderId,
      'PAYMENT_PROCESSING',
      'Stripe is processing the payment; the order is confirmed once it succeeds',
    );
  }

  /**
   * refund.* / charge.refund.updated (refunds are made in the merchant's own
   * Stripe dashboard): re-sync the refund state from the live charge through
   * the same path as charge.refunded. A failed refund (refund.failed, or an
   * update to status `failed`) also gets a timeline note + owner notice; the
   * re-sync then counts only succeeded refunds, so an order a failed full
   * refund had moved to REFUNDED goes back to paid.
   */
  private async onRefundEvent(
    refund: RefundLike,
    ctx?: WebhookContext,
    type?: string,
  ) {
    const chargeId =
      typeof refund.charge === 'string' ? refund.charge : refund.charge?.id;
    if (!chargeId) return;
    const piId =
      typeof refund.payment_intent === 'string'
        ? refund.payment_intent
        : (refund.payment_intent?.id ?? null);
    if (type === 'refund.failed' || refund.status === 'failed') {
      await this.onRefundFailed(refund, chargeId, piId, ctx);
    }
    await this.onChargeRefunded(
      {
        id: chargeId,
        payment_intent: piId,
        metadata: {},
      } as unknown as StripeCharge,
      ctx,
    );
  }

  private async onRefundFailed(
    refund: RefundLike,
    chargeId: string,
    piId: string | null,
    ctx?: WebhookContext,
  ) {
    let order = await this.prisma.order.findFirst({
      where: { stripe_charge_id: chargeId },
      select: ORDER_ROUTE_SELECT,
    });
    if (!order && piId) {
      order = await this.prisma.order.findFirst({
        where: { stripe_payment_id: piId },
        select: ORDER_ROUTE_SELECT,
      });
    }
    if (!order) return;
    if (!this.webhookMayTouch(ctx, order, 'refund.failed')) return;
    const amount =
      typeof refund.amount === 'number' && refund.currency
        ? ` ${fromStripeAmount(refund.amount, refund.currency)} ${refund.currency.toUpperCase()}`
        : '';
    const noted = await this.orders.recordPaymentNote(
      order.id,
      'REFUND_FAILED',
      `Stripe refund failed${refund.id ? ` (${refund.id})` : ''}:${amount}${
        refund.failure_reason ? ` (${refund.failure_reason})` : ''
      }`,
    );
    if (noted.changed) {
      await this.notifyStoreCreator(
        order.store_id,
        'order_refund_failed',
        'Refund failed',
        `A refund on order ${order.order_number} failed in Stripe; the money was not returned to the customer. Check the refund in your Stripe dashboard.`,
        order.id,
      );
    }
  }

  /**
   * charge.dispute.*: there is no dispute model, so the dispute is recorded
   * on the order timeline (deduplicated per status) and the store owner is
   * notified when one opens. Money movement follows Stripe's own flow.
   */
  private async onDisputeEvent(
    type: string,
    dispute: DisputeLike,
    ctx?: WebhookContext,
  ) {
    const chargeId =
      typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
    const piId =
      typeof dispute.payment_intent === 'string'
        ? dispute.payment_intent
        : (dispute.payment_intent?.id ?? null);
    let order = chargeId
      ? await this.prisma.order.findFirst({
          where: { stripe_charge_id: chargeId },
          select: ORDER_ROUTE_SELECT,
        })
      : null;
    if (!order && piId) {
      order = await this.prisma.order.findFirst({
        where: { stripe_payment_id: piId },
        select: ORDER_ROUTE_SELECT,
      });
    }
    if (!order) return;
    if (!this.webhookMayTouch(ctx, order, type)) return;

    const amount =
      typeof dispute.amount === 'number' && dispute.currency
        ? ` ${fromStripeAmount(dispute.amount, dispute.currency)} ${dispute.currency.toUpperCase()}`
        : '';
    const note = `Stripe dispute ${dispute.status ?? 'updated'}${
      dispute.reason ? ` (${dispute.reason})` : ''
    }:${amount}`;
    const recorded = await this.orders.recordPaymentNote(
      order.id,
      'PAYMENT_DISPUTE',
      note,
    );
    if (recorded.changed && type === 'charge.dispute.created') {
      await this.notifyStoreCreator(
        order.store_id,
        'order_disputed',
        'Payment disputed',
        `A payment dispute was opened for order ${order.order_number}. Respond in your Stripe dashboard.`,
        order.id,
      );
    }
  }

  private async onChargeRefunded(charge: StripeCharge, ctx?: WebhookContext) {
    // Resolve the order: by charge id first, then by the PaymentIntent's
    // metadata (charges inherit the PI metadata), then by the PI id itself.
    const piId =
      typeof charge.payment_intent === 'string'
        ? charge.payment_intent
        : charge.payment_intent?.id;
    let order = await this.prisma.order.findFirst({
      where: { stripe_charge_id: charge.id },
      select: {
        id: true,
        order_number: true,
        payment_status: true,
        store_id: true,
        stripe_account_id: true,
        payment_route: true,
        stripe_payment_id: true,
        stripe_key_fingerprint: true,
      },
    });
    if (!order && charge.metadata?.order_id) {
      order = await this.prisma.order.findUnique({
        where: { id: charge.metadata.order_id },
        select: {
          id: true,
          order_number: true,
          payment_status: true,
          store_id: true,
          stripe_account_id: true,
          payment_route: true,
          stripe_payment_id: true,
          stripe_key_fingerprint: true,
        },
      });
    }
    if (!order && piId) {
      order = await this.prisma.order.findFirst({
        where: { stripe_payment_id: piId },
        select: {
          id: true,
          order_number: true,
          payment_status: true,
          store_id: true,
          stripe_account_id: true,
          payment_route: true,
          stripe_payment_id: true,
          stripe_key_fingerprint: true,
        },
      });
    }
    if (!order) return;
    if (!this.webhookMayTouch(ctx, order, 'charge.refunded')) return;

    // SECURITY: mirror onPaymentSucceeded — never trust the event payload
    // alone. Re-read the charge live from Stripe (from the connected account
    // for direct charges, the owner's own account for OWN_KEY) and act on
    // what Stripe itself reports. A retrieval failure propagates (the webhook
    // handler logs + rethrows so Stripe retries the delivery) — except an
    // OWN_KEY store whose key is revoked / removed: retries cannot help, so
    // the event is acknowledged and the owner re-syncs after reconnecting.
    let stripeCtx: OrderStripe;
    let live: StripeCharge;
    try {
      stripeCtx = await this.stripeForOrder(order);
      live = await this.callStripe(stripeCtx, (s, o) =>
        s.charges.retrieve(charge.id, undefined, o),
      );
    } catch (err) {
      if (ctx?.ownKeyStoreId && this.isOwnKeyUnavailable(err)) {
        this.logger.warn(
          `Refund sync of order ${order.id} skipped: the store's own Stripe key is unavailable`,
        );
        return;
      }
      throw err;
    }

    // The charge must belong to this order's payment: a charge found through
    // its (copyable) metadata but made by another PaymentIntent never moves
    // this order to refunded.
    const livePi =
      typeof live.payment_intent === 'string'
        ? live.payment_intent
        : live.payment_intent?.id;
    if (order.stripe_payment_id && livePi !== order.stripe_payment_id) {
      this.logger.warn(
        `Ignoring charge.refunded for order ${order.id}: charge belongs to another payment`,
      );
      return;
    }

    // Only SUCCEEDED refunds count: a pending one may still fail, and a
    // failed one returned nothing. (charge.amount_refunded includes pending
    // refunds, so the refund list decides when it can be read.)
    const refundedMinor = await this.succeededRefundTotal(stripeCtx, live);
    const capturedMinor =
      typeof live.amount_captured === 'number' && live.amount_captured > 0
        ? live.amount_captured
        : typeof live.amount === 'number'
          ? live.amount
          : null;
    const fullyRefunded =
      refundedMinor > 0 &&
      (capturedMinor !== null
        ? refundedMinor >= capturedMinor
        : live.refunded === true);

    if (!fullyRefunded) {
      // A full refund that later failed: back to paid (see revertRefund
      // for what is and is not undone).
      if (order.payment_status === 'refunded') {
        const reverted = await this.orders.revertRefund(
          order.id,
          'A refund failed in Stripe; the order is paid again',
        );
        if (reverted?.changed) {
          await this.notifyStoreCreator(
            order.store_id,
            'order_refund_reverted',
            'Refund failed — order paid again',
            `The refund of order ${order.order_number} failed in Stripe, so the order is marked paid again. Check the credit note and the customer email that went out with the refund.`,
            order.id,
          );
        }
      }
      // Partial refund: the order stands, but the money movement is recorded
      // so it isn't invisible to the creator and admin.
      if (refundedMinor > 0) {
        const amount = fromStripeAmount(refundedMinor, live.currency);
        // The running succeeded total is what the invoices app expects as
        // `cumulativeRefunded`.
        const recorded = await this.orders.recordPartialRefund(
          order.id,
          amount,
          live.currency,
          'Stripe',
          { cumulativeRefunded: amount, storeId: order.store_id },
        );
        if (recorded.changed) {
          await this.notifyStoreCreator(
            order.store_id,
            'order_refunded',
            'Partial refund',
            `${amount} ${live.currency.toUpperCase()} was refunded on order ${order.order_number}.`,
            order.id,
          );
        }
      }
      return;
    }

    // Full refund — OrdersService brings the order to the same state an admin
    // REFUNDED transition would (status, commission, stock, customer email)
    // and is idempotent, so a replayed event is a no-op.
    const result = await this.orders.markOrderRefunded(order.id);
    if (!result?.changed) return;

    await this.notifyStoreCreator(
      order.store_id,
      'order_refunded',
      'Order refunded',
      `The payment for order ${order.order_number} was fully refunded.`,
      order.id,
    );
  }

  /**
   * Sum of the charge's SUCCEEDED refunds (minor units). Falls back to the
   * charge's amount_refunded when the refund list cannot be read.
   */
  private async succeededRefundTotal(
    ctx: OrderStripe,
    charge: StripeCharge,
  ): Promise<number> {
    try {
      const list = await this.callStripe(ctx, (s, o) =>
        s.refunds.list({ charge: charge.id, limit: 100 }, o),
      );
      if (!list || !Array.isArray(list.data)) return charge.amount_refunded;
      return list.data
        .filter((r) => r.status === 'succeeded')
        .reduce((sum, r) => sum + (r.amount ?? 0), 0);
    } catch (err) {
      if (this.isOwnKeyUnavailable(err)) throw err;
      this.logger.warn(
        `Could not list the refunds of charge ${charge.id}: ${this.describe(err)}`,
      );
      return charge.amount_refunded;
    }
  }

  /** Best-effort in-app notification to the store's owner. */
  private async notifyStoreCreator(
    storeId: string | null,
    type: string,
    title: string,
    body: string,
    orderId: string,
  ) {
    if (!storeId) return;
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { creator: { select: { user_id: true } } },
    });
    if (!store?.creator) return;
    await this.notifications.create(store.creator.user_id, type, title, body, {
      order_id: orderId,
    });
  }

  /** Store the charge's card brand/last4 + receipt URL on the order. */
  private async captureChargeDetails(orderId: string, chargeId?: string) {
    if (!chargeId) return;
    try {
      // Direct-charge orders keep their charge on the connected account (or
      // the owner's own account for OWN_KEY).
      const orderRow = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: {
          stripe_account_id: true,
          payment_route: true,
          stripe_key_fingerprint: true,
          store_id: true,
        },
      });
      if (routeOfOrder(orderRow ?? {}) !== 'OWN_KEY') {
        // Legacy behaviour: no platform client means nothing to capture.
        if (!(await this.resolveStripe())) return;
      }
      const ctx = await this.stripeForOrder(orderRow ?? {});
      const charge = await this.callStripe(ctx, (s, o) =>
        s.charges.retrieve(chargeId, undefined, o),
      );
      const card = charge.payment_method_details?.card;
      await this.prisma.order.update({
        where: { id: orderId },
        data: {
          stripe_charge_id: charge.id,
          card_brand: card?.brand ?? null,
          card_last4: card?.last4 ?? null,
          receipt_url: charge.receipt_url ?? null,
          payment_failure_code: null,
          payment_failure_message: null,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Could not capture charge details for order ${orderId}: ${this.describe(err)}`,
      );
    }
  }
}
