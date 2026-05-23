import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { UserRole, FulfillerType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../mail/mail.service';

// The stripe package does not surface the `Stripe.*` resource namespace through
// its package entry under nodenext, so we derive the types we need from the
// client instance signatures instead.
type StripeClient = InstanceType<typeof Stripe>;
type StripeEvent = ReturnType<StripeClient['webhooks']['constructEvent']>;
type StripePaymentIntent = Awaited<
  ReturnType<StripeClient['paymentIntents']['retrieve']>
>;
type StripeAccount = Awaited<ReturnType<StripeClient['accounts']['retrieve']>>;
type PaymentIntentCreateParams = Parameters<
  StripeClient['paymentIntents']['create']
>[0];

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  // Cached client + the secret it was built from, so we rebuild only when the
  // admin changes the key. Platform keys live in PlatformConfig (admin-managed)
  // and fall back to the STRIPE_* environment variables when unset.
  private stripe: StripeClient | null = null;
  private stripeKeyUsed: string | null = null;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private orders: OrdersService,
    private notifications: NotificationsService,
    private mail: MailService,
  ) {}

  // ── Config resolution (DB first, env fallback) ─────────────────────────────

  private async resolveSecretKey(): Promise<string | null> {
    const cfg = await this.prisma.platformConfig.findFirst({
      select: { stripe_secret_key: true },
    });
    return (
      cfg?.stripe_secret_key ||
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

  private async resolveWebhookSecret(): Promise<string | null> {
    const cfg = await this.prisma.platformConfig.findFirst({
      select: { stripe_webhook_secret: true },
    });
    return (
      cfg?.stripe_webhook_secret ||
      this.config.get<string>('STRIPE_WEBHOOK_SECRET') ||
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
      },
    });
    const envSecret = Boolean(this.config.get<string>('STRIPE_SECRET_KEY'));
    const envWebhook = Boolean(this.config.get<string>('STRIPE_WEBHOOK_SECRET'));
    return {
      publishableKey: cfg?.stripe_publishable_key || null,
      secretKeyConfigured: Boolean(cfg?.stripe_secret_key) || envSecret,
      webhookSecretConfigured: Boolean(cfg?.stripe_webhook_secret) || envWebhook,
      // True when no DB secret is set but an env key is in use (legacy fallback).
      usingEnvFallback: !cfg?.stripe_secret_key && envSecret,
    };
  }

  async updateAdminSettings(dto: {
    secret_key?: string;
    publishable_key?: string;
    webhook_secret?: string;
  }) {
    let config = await this.prisma.platformConfig.findFirst();
    if (!config) config = await this.prisma.platformConfig.create({ data: {} });

    // Only touch provided fields; an explicit empty string clears the value.
    const data: {
      stripe_secret_key?: string | null;
      stripe_publishable_key?: string | null;
      stripe_webhook_secret?: string | null;
    } = {};
    if (dto.secret_key !== undefined)
      data.stripe_secret_key = dto.secret_key.trim() || null;
    if (dto.publishable_key !== undefined)
      data.stripe_publishable_key = dto.publishable_key.trim() || null;
    if (dto.webhook_secret !== undefined)
      data.stripe_webhook_secret = dto.webhook_secret.trim() || null;

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
  private async runStripe<T>(fn: () => Promise<T>, action: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Stripe error while trying to ${action}: ${message}`);
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
        chargesEnabled: p.stripe_charges_enabled,
        payoutsEnabled: p.stripe_payouts_enabled,
        onboardingCompleted: Boolean(p.stripe_onboarding_completed_at),
        dashboardPath: '/provider/settings',
      };
    }
    const c = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      include: { user: { select: { email: true } } },
    });
    if (!c) throw new NotFoundException('Creator profile not found');
    return {
      kind: 'creator' as const,
      id: c.id,
      email: c.user.email,
      stripeAccountId: c.stripe_account_id,
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
  ) {
    if (kind === 'provider') {
      await this.prisma.provider.update({
        where: { id },
        data: { stripe_account_id: accountId },
      });
    } else {
      await this.prisma.creator.update({
        where: { id },
        data: { stripe_account_id: accountId },
      });
    }
  }

  /**
   * Ensure the party has a Stripe Express connected account, creating one on
   * first call. Returns the connected account id.
   */
  async getOrCreateConnectedAccount(
    userId: string,
    role: UserRole,
  ): Promise<string> {
    const stripe = await this.requireStripe();
    const party = await this.resolveParty(userId, role);
    if (party.stripeAccountId) return party.stripeAccountId;

    const account = await this.runStripe(
      () =>
        stripe.accounts.create({
          type: 'express',
          email: party.email,
          metadata: { party_kind: party.kind, party_id: party.id },
          capabilities: { transfers: { requested: true } },
        }),
      'create connected account',
    );

    await this.saveAccountId(party.kind, party.id, account.id);
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
    const stripe = await this.requireStripe();
    const party = await this.resolveParty(userId, role);
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

  /** Onboarding status for the creator/provider dashboard. */
  async getConnectStatus(userId: string, role: UserRole) {
    let party = await this.resolveParty(userId, role);

    // If the account exists but isn't enabled yet, reconcile live from Stripe.
    // The account.updated webhook may not have arrived (or isn't configured),
    // e.g. immediately after the user returns from onboarding.
    if (party.stripeAccountId && !party.payoutsEnabled) {
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
    };
  }

  /**
   * Sync local onboarding flags from a Stripe account (account.updated webhook).
   * The event doesn't say whether the account belongs to a creator or provider,
   * so we try both. Completion is keyed on payouts_enabled (transfers model).
   */
  private async syncConnectAccount(account: StripeAccount) {
    const completedAt = account.payouts_enabled ? new Date() : null;

    const creator = await this.prisma.creator.findFirst({
      where: { stripe_account_id: account.id },
      select: { id: true, stripe_onboarding_completed_at: true },
    });
    if (creator) {
      await this.prisma.creator.update({
        where: { id: creator.id },
        data: {
          stripe_charges_enabled: account.charges_enabled,
          stripe_payouts_enabled: account.payouts_enabled,
          stripe_onboarding_completed_at:
            creator.stripe_onboarding_completed_at ?? completedAt,
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
   */
  async createPaymentIntentForOrder(userId: string, orderId: string) {
    const stripe = await this.requireStripe();

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { user_id: true } },
        items: {
          select: {
            fulfiller_type: true,
            fulfiller_id: true,
            quantity: true,
          },
        },
      },
    });

    if (!order) throw new NotFoundException('Order not found');
    if (order.customer.user_id !== userId) {
      throw new ForbiddenException('You can only pay for your own orders');
    }
    if (order.payment_status === 'paid') {
      throw new BadRequestException('Order is already paid');
    }

    // Every payout recipient must be able to receive transfers before we take
    // the customer's money, otherwise the funds could not be split out.
    await this.assertRecipientsOnboarded(order.store_id, order.items);

    // The PaymentIntent carries the total (line-item detail isn't supported by
    // PaymentIntents — the itemized invoice lives in our order). We still attach
    // a description + metadata so the payment is traceable in Stripe.
    const lineCount = order.items.length;
    const unitCount = order.items.reduce((s, i) => s + i.quantity, 0);

    const intent = await this.runStripe(
      () =>
        stripe.paymentIntents.create({
          amount: Math.round(Number(order.total) * 100),
          currency: order.currency.toLowerCase(),
          description: `Order ${order.order_number} — ${unitCount} item(s)`,
          metadata: {
            order_id: order.id,
            order_number: order.order_number,
            line_items: String(lineCount),
            unit_count: String(unitCount),
            ...(order.store_id ? { store_id: order.store_id } : {}),
          },
          automatic_payment_methods: {
            enabled: true,
            allow_redirects: 'never',
          },
        }),
      'create payment intent',
    );

    // Record the intent id on the order up front to aid reconciliation.
    await this.prisma.order.update({
      where: { id: order.id },
      data: { stripe_payment_id: intent.id },
    });

    return { clientSecret: intent.client_secret!, paymentIntentId: intent.id };
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
            select: { stripe_account_id: true, stripe_payouts_enabled: true },
          },
        },
      });
      const creator = store?.creator;
      if (!creator?.stripe_account_id || !creator.stripe_payouts_enabled) {
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
      select: { id: true, stripe_account_id: true, stripe_payouts_enabled: true },
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
  async reconcilePayment(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { payment_status: true, stripe_payment_id: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    // Already paid: still re-attempt payouts so a previously failed transfer can
    // be retried (idempotent — paid payouts are skipped). Don't rethrow: a
    // failed transfer is recorded and surfaced, not turned into a 500.
    if (order.payment_status === 'paid') {
      await this.issueOrderTransfers(orderId, { rethrow: false });
      return { payment_status: 'paid' };
    }
    if (!order.stripe_payment_id) {
      return { payment_status: order.payment_status ?? 'awaiting_payment' };
    }

    const stripe = await this.requireStripe();
    const pi = await this.runStripe(
      () => stripe.paymentIntents.retrieve(order.stripe_payment_id!),
      'retrieve payment intent',
    );

    if (pi.status === 'succeeded') {
      await this.onPaymentSucceeded(pi, { rethrowTransfers: false });
      return { payment_status: 'paid' };
    }
    if (pi.status === 'canceled' || pi.status === 'requires_payment_method') {
      await this.onPaymentFailed(pi);
      return { payment_status: 'failed' };
    }
    return { payment_status: order.payment_status ?? 'awaiting_payment' };
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

  /**
   * Dispatch a verified Stripe event. Errors are logged and rethrown so the
   * controller returns 5xx and Stripe retries the delivery — important because
   * a transient failure here happens *after* the customer was already charged.
   * Unknown orders / unhandled event types resolve normally (no retry).
   */
  async handleWebhookEvent(event: StripeEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'payment_intent.succeeded': {
          const pi = event.data.object as StripePaymentIntent;
          await this.onPaymentSucceeded(pi);
          break;
        }
        case 'payment_intent.payment_failed': {
          const pi = event.data.object as StripePaymentIntent;
          await this.onPaymentFailed(pi);
          break;
        }
        case 'account.updated': {
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
        err instanceof Error ? err.stack : String(err),
      );
      // Rethrow so the webhook responds 5xx and Stripe retries the delivery.
      throw err;
    }
  }

  private async onPaymentSucceeded(
    pi: StripePaymentIntent,
    opts: { rethrowTransfers?: boolean } = {},
  ) {
    const orderId = pi.metadata?.order_id;
    if (!orderId) return;
    const result = await this.orders.markOrderPaid(orderId, pi.id);

    const chargeId =
      typeof pi.latest_charge === 'string'
        ? pi.latest_charge
        : pi.latest_charge?.id;

    // Capture the card/receipt details for tracking (best-effort, non-fatal).
    await this.captureChargeDetails(orderId, chargeId);

    // Split the captured funds out to the payout recipients. Always attempted
    // (not gated on `changed`) so a webhook retry after a partial failure still
    // completes the transfers — Stripe idempotency keys prevent duplicates.
    await this.issueOrderTransfers(orderId, {
      rethrow: opts.rethrowTransfers !== false,
    });

    if (result?.changed) {
      await this.notifications.create(
        result.order.customer.user_id,
        'order_paid',
        'Payment received',
        `We received your payment for order ${result.order.order_number}.`,
        { order_id: orderId },
      );

      // Send the paid order confirmation email (best-effort). Locale comes
      // from the order's store so the email matches the storefront.
      const user = await this.prisma.user.findUnique({
        where: { id: result.order.customer.user_id },
        select: { email: true },
      });
      if (user?.email) {
        let mailLocale: string | undefined;
        if (result.order.store_id) {
          const store = await this.prisma.store.findUnique({
            where: { id: result.order.store_id },
            select: { language_config: { select: { primary_locale: true } } },
          });
          mailLocale = store?.language_config?.primary_locale;
        }
        await this.mail.sendOrderConfirmation(
          user.email,
          {
            orderNumber: result.order.order_number,
            total: `${result.order.currency} ${Number(result.order.total).toFixed(2)}`,
            paid: true,
          },
          mailLocale,
        );
      }
    }
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
    const stripe = await this.requireStripe();
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

    // Resolve the charge and its settlement currency/FX rate.
    let chargeId = order.stripe_charge_id;
    if (!chargeId && order.stripe_payment_id) {
      const pi = await stripe.paymentIntents.retrieve(order.stripe_payment_id);
      chargeId =
        typeof pi.latest_charge === 'string'
          ? pi.latest_charge
          : pi.latest_charge?.id ?? null;
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

    const toCents = (n: unknown) => Math.round(Number(n) * 100);
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

      const ledgerAmount = presentmentCents / 100; // order (presentment) currency
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
          // ready) can't poison this retry.
          { idempotencyKey: `transfer_${orderId}_${destination}_${transferCurrency}_v4` },
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
        this.logger.error(`Payout transfer failed for order ${orderId}: ${message}`);
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

    // ── Providers: split the aggregate provider_amount by each provider's base.
    const providerItems = order.items.filter(
      (i) => i.fulfiller_type === FulfillerType.PROVIDER,
    );
    const providerBaseTotal = providerItems.reduce(
      (s, i) => s + Number(i.provider_base_amount),
      0,
    );
    const providerAmountCents = toCents(order.commission.provider_amount);
    if (providerBaseTotal > 0 && providerAmountCents > 0) {
      const baseByProvider = new Map<string, number>();
      for (const i of providerItems) {
        baseByProvider.set(
          i.fulfiller_id,
          (baseByProvider.get(i.fulfiller_id) || 0) +
            Number(i.provider_base_amount),
        );
      }
      const providers = await this.prisma.provider.findMany({
        where: { id: { in: [...baseByProvider.keys()] } },
        select: { id: true, stripe_account_id: true },
      });
      for (const [providerId, base] of baseByProvider) {
        const acct = providers.find((p) => p.id === providerId)?.stripe_account_id;
        if (!acct) continue;
        const share = Math.round(providerAmountCents * (base / providerBaseTotal));
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

  private async onPaymentFailed(pi: StripePaymentIntent) {
    const orderId = pi.metadata?.order_id;
    if (!orderId) return;
    const result = await this.orders.markOrderFailed(orderId);

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

  /** Store the charge's card brand/last4 + receipt URL on the order. */
  private async captureChargeDetails(orderId: string, chargeId?: string) {
    if (!chargeId) return;
    const stripe = await this.resolveStripe();
    if (!stripe) return;
    try {
      const charge = await stripe.charges.retrieve(chargeId);
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
        `Could not capture charge details for order ${orderId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
