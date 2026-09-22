import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentMethod, Prisma, StoreType, UserRole } from '@prisma/client';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { CryptoService } from '../../../common/crypto/crypto.service';
import {
  fromStripeAmount,
  resolveStoreCurrency,
  toStripeAmount,
} from '../../../common/money/currency.util';
import { OrdersService } from '../../orders/orders.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { MailService } from '../../mail/mail.service';
import { RevalidationService } from '../../../common/revalidation/revalidation.service';
import {
  KustomAddress,
  KustomApiError,
  KustomClient,
  KustomCredentials,
  KustomEnvironment,
  KustomCheckoutOrder,
  KustomCheckoutPayload,
  KustomManagementOrder,
} from './kustom.client';
import {
  buildKustomCheckoutPayload,
  expectedKustomAmount,
  resolveStoreBase,
} from './kustom.mapper';
import {
  isKustomCurrencySupported,
  isKustomEnabledForStore,
  kustomCreatorSelect,
} from './kustom.eligibility';
import { UpdateKustomSettingsDto } from './dto/kustom.dto';
import {
  TaxService,
  type TaxDestination,
  type TaxLineInput,
} from '../../taxes/tax.service';

// Kustom order statuses (Order Management API) that mean the money is
// authorized on the creator's account and the order may be treated as paid.
const PAID_STATUSES = new Set(['AUTHORIZED', 'PART_CAPTURED', 'CAPTURED']);

const CHECKOUT_COMPLETE = 'checkout_complete';

/** What createSession loads: the order with everything the payload needs. */
const sessionOrderInclude = {
  items: {
    include: {
      product: { include: { translations: true } },
      custom_product: {
        include: {
          translations: true,
          // Tax class / exemption of a custom product live on the product
          // behind it (what OrdersService.priceLine reads).
          product: { select: { tax_class_id: true, tax_exempt: true } },
        },
      },
      variant: { select: { sku: true, options: true } },
    },
  },
  address: true,
  customer: { include: { user: { select: { email: true } } } },
} satisfies Prisma.OrderInclude;

type SessionOrder = Prisma.OrderGetPayload<{
  include: typeof sessionOrderInclude;
}>;

/** Who is asking for a capture/refund; null means an internal caller. */
interface Actor {
  userId: string;
  role: UserRole;
}

export interface StoreContext {
  id: string;
  slug: string;
  customDomain: string | null;
  store_type: StoreType;
  is_active: boolean;
  primaryLocale: string | null;
  /** Resolved presentment currency (store override or platform default). */
  currency: string;
  creator: {
    id: string;
    kustom_enabled: boolean;
    kustom_merchant_id: string | null;
    kustom_shared_secret: string | null;
    kustom_environment: string;
  };
}

/**
 * Kustom Checkout (former Klarna Checkout) for INDEPENDENT stores.
 *
 * Order-first, like Stripe: our order exists (payment_method KUSTOM,
 * awaiting_payment) before the Kustom session is created for it. Payment is
 * only authorized at checkout; it is captured when the order ships (via the
 * OrdersService shipped hook) or manually. Kustom's push notification is not
 * signed, so every money decision re-reads the order from Kustom with the
 * creator's own credentials and cross-checks our order id and total.
 */
@Injectable()
export class KustomService implements OnModuleInit {
  private readonly logger = new Logger(KustomService.name);

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private crypto: CryptoService,
    private orders: OrdersService,
    private notifications: NotificationsService,
    private mail: MailService,
    private revalidation: RevalidationService,
    private taxService: TaxService,
  ) {}

  // OrdersService cannot inject this service (PaymentsModule imports
  // OrdersModule), so capture-on-shipment is wired as a callback.
  onModuleInit(): void {
    this.orders.registerShippedHook((orderId) =>
      this.captureOnShipped(orderId),
    );
  }

  // ── Credentials / store context ─────────────────────────────────────────

  private async resolvePartnerId(): Promise<string | null> {
    const cfg = await this.prisma.platformConfig.findFirst({
      select: { kustom_partner_id: true },
    });
    return cfg?.kustom_partner_id || null;
  }

  /** Store + creator Kustom fields by id. Public for the session-first flow. */
  async loadStoreContext(storeId: string | null): Promise<StoreContext | null> {
    if (!storeId) return null;
    return this.toStoreContext({ id: storeId });
  }

  /** Same as loadStoreContext, keyed by the storefront slug. */
  async loadStoreContextBySlug(slug: string): Promise<StoreContext | null> {
    if (!slug) return null;
    return this.toStoreContext({ slug });
  }

  private async toStoreContext(
    where: { id: string } | { slug: string },
  ): Promise<StoreContext | null> {
    const store = await this.prisma.store.findUnique({
      where,
      select: {
        id: true,
        slug: true,
        custom_domain: true,
        store_type: true,
        is_active: true,
        currency: true,
        language_config: { select: { primary_locale: true } },
        creator: {
          select: {
            id: true,
            kustom_environment: true,
            ...kustomCreatorSelect,
          },
        },
      },
    });
    if (!store) return null;
    const platformConfig = await this.prisma.platformConfig.findFirst({
      select: { default_currency: true },
    });
    return {
      id: store.id,
      slug: store.slug,
      customDomain: store.custom_domain ?? null,
      store_type: store.store_type,
      is_active: store.is_active,
      primaryLocale: store.language_config?.primary_locale ?? null,
      currency: resolveStoreCurrency(store, platformConfig?.default_currency),
      creator: store.creator,
    };
  }

  /**
   * Credentials of the creator who owns the store. Only presence of merchant
   * id + secret is required here (not the `enabled` toggle or store status):
   * an order that was already paid through Kustom must stay manageable —
   * capture, refund, push — even after the creator switches Kustom off.
   */
  async credentialsFor(
    creator: StoreContext['creator'],
  ): Promise<KustomCredentials | null> {
    const secret = this.crypto.decrypt(creator.kustom_shared_secret);
    if (!creator.kustom_merchant_id || !secret) return null;
    return {
      merchantId: creator.kustom_merchant_id,
      sharedSecret: secret,
      environment: this.normalizeEnvironment(creator.kustom_environment),
      partnerId: await this.resolvePartnerId(),
    };
  }

  private normalizeEnvironment(
    value: string | null | undefined,
  ): KustomEnvironment {
    return value === 'production' ? 'production' : 'playground';
  }

  /** Client for an existing order's store, or a 400 when the creds are gone. */
  private async clientForStore(
    storeId: string | null,
  ): Promise<{ ctx: StoreContext; client: KustomClient }> {
    const ctx = await this.loadStoreContext(storeId);
    const creds = ctx ? await this.credentialsFor(ctx.creator) : null;
    if (!ctx || !creds) {
      throw new BadRequestException({
        code: 'KUSTOM_NOT_CONFIGURED',
        message: 'Kustom Checkout is not configured for this store.',
      });
    }
    return { ctx, client: new KustomClient(creds) };
  }

  urls(): { storefrontBase: string; apiBase: string } {
    return {
      storefrontBase:
        this.config.get<string>('STOREFRONT_URL') || 'http://localhost:3003',
      apiBase:
        this.config.get<string>('PUBLIC_API_URL') || 'http://localhost:3001',
    };
  }

  /**
   * Kustom calls the push/validation URLs itself and redirects the customer
   * to the storefront URLs, so all of them must be public https addresses.
   * A localhost or http base is rejected by Kustom with an opaque
   * "BAD_VALUE: push" — fail here with a message that names the fix instead.
   * Shared with the session-first flow (KustomCheckoutService).
   */
  requirePublicUrls(): { storefrontBase: string; apiBase: string } {
    const bases = this.urls();
    const isPublicHttps = (value: string) =>
      /^https:\/\/[^/\s]+/i.test(value) &&
      !/localhost|127\.0\.0\.1/i.test(value);
    const bad: string[] = [];
    if (!isPublicHttps(bases.apiBase)) bad.push('PUBLIC_API_URL');
    if (!isPublicHttps(bases.storefrontBase)) bad.push('STOREFRONT_URL');
    if (bad.length) {
      this.logger.error(
        `Kustom checkout blocked: ${bad.join(' and ')} must be public https URL(s) (api=${bases.apiBase}, storefront=${bases.storefrontBase})`,
      );
      throw new BadRequestException({
        code: 'KUSTOM_CALLBACK_URL_INVALID',
        message:
          'Kustom Checkout is not fully configured on the server (callback URLs are not public https). Please choose another payment method.',
      });
    }
    return bases;
  }

  /**
   * Turn a Kustom failure into the HTTP error the caller should see: 4xx from
   * Kustom is a request/config problem (400 with Kustom's message), anything
   * else (network, timeout, 5xx) is an upstream outage (502).
   */
  toHttpException(err: unknown, action: string): Error {
    if (err instanceof KustomApiError) {
      this.logger.error(
        `Kustom error while trying to ${action}: ${err.message}`,
      );
      if (err.status === 401 || err.status === 403) {
        return new BadRequestException({
          code: 'KUSTOM_CREDENTIALS_REJECTED',
          message:
            'Kustom rejected the store credentials. Check the Kustom settings.',
        });
      }
      if (err.status === 409) {
        return new BadRequestException({
          code: 'KUSTOM_CONFLICT',
          message: `Kustom could not ${action}: ${
            err.errorCode ??
            'the amount exceeds what is still allowed for this order'
          }.`,
        });
      }
      if (err.status >= 400 && err.status < 500) {
        return new BadRequestException(`Kustom error: ${err.message}`);
      }
      return new BadGatewayException(`Kustom is unavailable (${action}).`);
    }
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(`Unexpected error while trying to ${action}: ${message}`);
    return err instanceof Error ? err : new Error(message);
  }

  /** Constant-time secret comparison; false for any missing side. */
  safeTokenEqual(stored: string | null | undefined, given: string): boolean {
    if (!stored || !given) return false;
    const a = Buffer.from(stored, 'utf8');
    const b = Buffer.from(given, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // ── Session (customer) ──────────────────────────────────────────────────

  /**
   * Create — or reuse — the Kustom checkout session for one of the customer's
   * own orders and return the HTML snippet to embed. Idempotent: an existing
   * incomplete session is returned as-is (updated first when our total
   * changed), an expired one is replaced, a completed one is finalised.
   */
  async createSession(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: sessionOrderInclude,
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.customer.user_id !== userId) {
      throw new ForbiddenException('You can only pay for your own orders');
    }
    if (order.payment_method !== PaymentMethod.KUSTOM) {
      throw new BadRequestException({
        code: 'KUSTOM_ORDER_NOT_KUSTOM',
        message: 'This order is not paid through Kustom.',
      });
    }
    if (order.payment_status === 'paid') {
      throw new BadRequestException({
        code: 'KUSTOM_ORDER_ALREADY_PAID',
        message: 'This order is already paid.',
      });
    }
    if (order.payment_status !== 'awaiting_payment') {
      throw new BadRequestException({
        code: 'KUSTOM_ORDER_NOT_PAYABLE',
        message: 'This order can no longer be paid. Please place a new order.',
      });
    }

    const ctx = await this.loadStoreContext(order.store_id);
    const creds =
      ctx && isKustomEnabledForStore({ ...ctx, currency: order.currency })
        ? await this.credentialsFor(ctx.creator)
        : null;
    if (!ctx || !creds) {
      throw new BadRequestException({
        code: 'ORDER_KUSTOM_UNAVAILABLE',
        message: 'Kustom Checkout is not available for this store.',
      });
    }

    // Orders created before the token column existed (or by another path)
    // still need the callback secret before any URL is handed to Kustom.
    let pushToken = order.kustom_push_token;
    if (!pushToken) {
      pushToken = randomBytes(32).toString('hex');
      await this.prisma.order.update({
        where: { id: order.id },
        data: { kustom_push_token: pushToken },
      });
    }

    // Orders placed before the tax system existed carry no tax snapshot
    // (tax_lines is null; taxed orders store an array, possibly empty).
    // Kustom validates each line's tax against the order totals, so once the
    // store's tax context resolves a registration country the snapshot is
    // computed now, with the inputs create() would use, and persisted before
    // the payload is built — so payload, confirmation and capture all read
    // the same numbers. The local row is refreshed in place.
    if (order.tax_lines === null) {
      const refreshed = await this.backfillTaxSnapshot(
        order,
        ctx.primaryLocale,
      );
      if (refreshed) Object.assign(order, refreshed);
    }

    const payload = buildKustomCheckoutPayload(order, {
      storeSlug: ctx.slug,
      customDomain: ctx.customDomain,
      primaryLocale: ctx.primaryLocale,
      pushToken,
      ...this.requirePublicUrls(),
    });
    const client = new KustomClient(creds);

    const existingSession = await this.loadExistingSession(
      order,
      client,
      payload,
    );
    if (existingSession) return existingSession;

    let created: KustomCheckoutOrder;
    try {
      created = await client.createCheckout(payload);
    } catch (err) {
      throw this.toHttpException(err, 'create the checkout session');
    }

    // Claim the session slot atomically. Two concurrent session requests for
    // the same order (double navigation, React strict mode) both reach this
    // point; only the first claim wins and the other must hand back the
    // winner's session — otherwise the customer could pay in a session we
    // never stored, and its push would be rejected forever.
    const claim = await this.prisma.order.updateMany({
      where: {
        id: order.id,
        OR: [
          { kustom_order_id: null },
          // Replacing a session we know has expired (loadExistingSession
          // returned null for a stored id) is also a legitimate claim.
          ...(order.kustom_order_id
            ? [{ kustom_order_id: order.kustom_order_id }]
            : []),
        ],
      },
      data: { kustom_order_id: created.order_id },
    });
    if (claim.count === 0) {
      const winner = await this.prisma.order.findUnique({
        where: { id: order.id },
        select: { kustom_order_id: true },
      });
      if (
        winner?.kustom_order_id &&
        winner.kustom_order_id !== created.order_id
      ) {
        this.logger.warn(
          `Order ${order.id}: discarding duplicate Kustom session ${created.order_id} in favour of ${winner.kustom_order_id}`,
        );
        const stored = await this.loadExistingSession(
          { ...order, kustom_order_id: winner.kustom_order_id },
          client,
          payload,
        );
        if (stored) return stored;
      }
    }
    return {
      kustom_order_id: created.order_id,
      html_snippet: created.html_snippet ?? '',
      status: (created.status ?? '').toLowerCase(),
    };
  }

  /**
   * Tax backfill for a pre-tax-system order (tax_lines null): recompute the
   * snapshot with the same engine and inputs OrdersService.create() uses
   * (line totals + product tax class / exemption, shipping cost, discount,
   * address country / state / postcode, store pricing mode), persist it on
   * the order and its items, and return the reloaded row. Null — nothing
   * written — when the store has no registration country (its orders are
   * never taxed, exactly as create() would leave them) or the order has no
   * store. Order.total is deliberately left as the customer accepted it.
   */
  private async backfillTaxSnapshot(
    order: SessionOrder,
    locale: string | null,
  ): Promise<SessionOrder | null> {
    if (!order.store_id) return null;
    const taxCtx = await this.taxService.resolveStoreTaxContext(order.store_id);
    if (!taxCtx.taxCountry) return null;

    const data = await this.taxService.loadTaxData(taxCtx);
    const destination: TaxDestination = {
      country: order.address.country_code,
      region: order.address.state,
      postcode: order.address.postal_code,
    };
    const lines: TaxLineInput[] = order.items.map((item) => {
      const product = item.product ?? item.custom_product?.product ?? null;
      return {
        amount: Number(item.total_price),
        tax_class_id: product?.tax_class_id ?? null,
        tax_exempt: product?.tax_exempt ?? false,
      };
    });
    const tax = this.taxService.computeTaxes({
      ctx: taxCtx,
      data,
      currency: order.currency,
      locale,
      lines,
      shipping_cost: Number(order.shipping_cost),
      discount_amount: Number(order.discount_amount),
      shipping: destination,
      billing: destination,
    });

    await this.prisma.$transaction([
      this.prisma.order.update({
        where: { id: order.id },
        data: {
          tax_rate_bp: tax.headline_rate_bp,
          tax_amount: tax.tax_total,
          tax_pricing_mode: tax.tax_pricing_mode,
          tax_basis_country: tax.tax_basis_country,
          tax_lines: tax.tax_lines as unknown as Prisma.InputJsonValue,
          shipping_tax_rate_bp: tax.shipping_tax_rate_bp,
          shipping_tax_amount: tax.shipping_tax_amount,
        },
      }),
      ...order.items.map((item, i) =>
        this.prisma.orderItem.update({
          where: { id: item.id },
          data: {
            tax_class_key: tax.items[i]?.tax_class_key ?? null,
            tax_rate_bp: tax.items[i]?.tax_rate_bp ?? 0,
            tax_amount: tax.items[i]?.tax_amount ?? 0,
          },
        }),
      ),
    ]);
    this.logger.log(
      `Order ${order.id}: tax snapshot backfilled before the Kustom session (${tax.tax_pricing_mode}, ${tax.tax_lines.length} line(s))`,
    );
    return this.prisma.order.findUnique({
      where: { id: order.id },
      include: sessionOrderInclude,
    });
  }

  /**
   * Return the order's stored Kustom session when it is still usable:
   * incomplete (updated first when our total changed) or already completed
   * (finalised, so the storefront moves on to the confirmation page). Null
   * when there is no stored session or Kustom no longer knows it (expired).
   */
  private async loadExistingSession(
    order: {
      id: string;
      order_number: string;
      total: unknown;
      currency: string;
      kustom_order_id: string | null;
    },
    client: KustomClient,
    payload: KustomCheckoutPayload,
  ): Promise<{
    kustom_order_id: string;
    html_snippet: string;
    status: string;
  } | null> {
    const kustomOrderId = order.kustom_order_id;
    if (!kustomOrderId) return null;

    let existing: KustomCheckoutOrder;
    try {
      existing = await client.getCheckout(kustomOrderId);
    } catch (err) {
      // 404 = the 48h session expired; anything else is a real failure.
      if (err instanceof KustomApiError && err.status === 404) {
        this.logger.warn(
          `Kustom session ${kustomOrderId} for order ${order.id} expired — creating a new one`,
        );
        return null;
      }
      throw this.toHttpException(err, 'load the checkout session');
    }

    const status = (existing.status ?? '').toLowerCase();
    if (status === CHECKOUT_COMPLETE) {
      // Paid in another tab: finalise now. Errors here must NOT be mistaken
      // for an expired session — a completed checkout is never recreated.
      try {
        await this.processCompletedCheckout(order, client, kustomOrderId);
      } catch (err) {
        throw this.toHttpException(err, 'verify the payment');
      }
      return {
        kustom_order_id: kustomOrderId,
        html_snippet: existing.html_snippet ?? '',
        status,
      };
    }

    if (existing.order_amount !== payload.order_amount) {
      let updated: KustomCheckoutOrder;
      try {
        updated = await client.updateCheckout(kustomOrderId, payload);
      } catch (err) {
        throw this.toHttpException(err, 'update the checkout session');
      }
      return {
        kustom_order_id: kustomOrderId,
        html_snippet: updated.html_snippet ?? '',
        status: (updated.status ?? status).toLowerCase(),
      };
    }
    return {
      kustom_order_id: kustomOrderId,
      html_snippet: existing.html_snippet ?? '',
      status,
    };
  }

  // ── Confirmation (customer) ─────────────────────────────────────────────

  /**
   * Called by the confirmation page. Reads the checkout from Kustom; when it
   * is complete the order is marked paid (idempotent — the push may already
   * have done it), the shipping address synced and the order acknowledged.
   * Returns Kustom's confirmation snippet for the page to render.
   */
  async getConfirmation(userId: string, orderId: string) {
    const owner = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { customer: { select: { user_id: true } } },
    });
    if (!owner) throw new NotFoundException('Order not found');
    if (owner.customer.user_id !== userId) {
      throw new ForbiddenException('You can only confirm your own orders');
    }
    return this.confirmOrder(orderId);
  }

  /**
   * The confirmation processing itself, for a caller that has already
   * authorised access to the order (the customer above, or a session token
   * in the session-first flow).
   */
  async confirmOrder(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        order_number: true,
        total: true,
        currency: true,
        status: true,
        payment_status: true,
        payment_method: true,
        kustom_order_id: true,
        store_id: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (
      order.payment_method !== PaymentMethod.KUSTOM ||
      !order.kustom_order_id
    ) {
      throw new BadRequestException({
        code: 'KUSTOM_SESSION_MISSING',
        message: 'This order has no Kustom checkout session.',
      });
    }

    const { client } = await this.clientForStore(order.store_id);
    let checkout: KustomCheckoutOrder;
    try {
      checkout = await client.getCheckout(order.kustom_order_id);
    } catch (err) {
      throw this.toHttpException(err, 'read the checkout');
    }
    const checkoutStatus = (checkout.status ?? '').toLowerCase();
    if (checkoutStatus === CHECKOUT_COMPLETE) {
      try {
        await this.processCompletedCheckout(
          order,
          client,
          order.kustom_order_id,
        );
      } catch (err) {
        throw this.toHttpException(err, 'verify the payment');
      }
    }

    const fresh = await this.prisma.order.findUnique({
      where: { id: order.id },
      select: { status: true, payment_status: true },
    });
    // Completed on Kustom's side but still unpaid here means the authorized
    // order did not match ours; tell the page so it asks for support instead
    // of waiting for a push that will never mark it paid.
    const mismatch =
      checkoutStatus === CHECKOUT_COMPLETE &&
      fresh?.payment_status !== 'paid' &&
      (await this.hasMismatch(order.id));
    return {
      order_id: order.id,
      order_number: order.order_number,
      kustom_order_id: order.kustom_order_id,
      status: fresh?.status ?? order.status,
      checkout_status: mismatch ? 'mismatch' : checkoutStatus,
      payment_status: fresh?.payment_status ?? order.payment_status,
      html_snippet:
        checkoutStatus === CHECKOUT_COMPLETE
          ? (checkout.html_snippet ?? null)
          : null,
    };
  }

  // ── Push (Kustom → us) ──────────────────────────────────────────────────

  /**
   * Kustom's unsigned push. The URL carries our order id + the per-order
   * secret token; everything about the money is then re-read from Kustom with
   * the creator's credentials. Unknown order / bad token → 404 so the URL
   * space is not probeable; Kustom errors → 5xx so Kustom retries.
   */
  async handlePush(orderId: string, token: string, kustomOrderId: string) {
    if (!orderId || !token || !kustomOrderId) throw new NotFoundException();
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        order_number: true,
        total: true,
        currency: true,
        status: true,
        payment_status: true,
        payment_method: true,
        kustom_order_id: true,
        kustom_push_token: true,
        store_id: true,
      },
    });
    if (
      !order ||
      order.payment_method !== PaymentMethod.KUSTOM ||
      !this.safeTokenEqual(order.kustom_push_token, token)
    ) {
      throw new NotFoundException();
    }
    if (order.kustom_order_id && order.kustom_order_id !== kustomOrderId) {
      this.logger.warn(
        `Kustom push for order ${order.id} names checkout ${kustomOrderId} but we hold ${order.kustom_order_id}`,
      );
      throw new NotFoundException();
    }

    const ctx = await this.loadStoreContext(order.store_id);
    const creds = ctx ? await this.credentialsFor(ctx.creator) : null;
    if (!creds) {
      // Without credentials the push cannot be verified. Fail so Kustom keeps
      // retrying (48h) — the creator may restore the settings meanwhile.
      this.logger.error(
        `Kustom push for order ${order.id}: store credentials missing`,
      );
      throw new ServiceUnavailableException('Kustom credentials unavailable');
    }

    try {
      await this.processCompletedCheckout(
        order,
        new KustomClient(creds),
        kustomOrderId,
      );
    } catch (err) {
      throw this.toHttpException(err, 'process the push notification');
    }
    return { received: true };
  }

  // ── Validation (Kustom → us, before the purchase is approved) ───────────

  /**
   * Must answer within 3 s, so this is database-only: it never calls Kustom.
   * The posted body is only used for the amount comparison — approving it
   * does not mark anything paid; that still needs the verified push/confirm.
   */
  async handleValidation(
    orderId: string | undefined,
    token: string | undefined,
    body: unknown,
  ): Promise<{ ok: true } | { ok: false; redirectUrl: string }> {
    const { storefrontBase } = this.urls();
    // Send the customer back to the origin they shopped on (custom domain or
    // store subdomain) so their session is still there.
    // The Kustom page (not the cart checkout page, whose cart is already
    // emptied by order creation) reads `error` and reloads the session so the
    // customer can retry, or shows why the order is no longer payable.
    const reject = (
      store?: { slug: string; custom_domain: string | null } | null,
    ) => ({
      ok: false as const,
      redirectUrl: store
        ? `${resolveStoreBase(storefrontBase, store.slug, store.custom_domain)}/checkout/kustom?orderId=${encodeURIComponent(orderId ?? '')}&error=kustom_validation`
        : `${storefrontBase.replace(/\/$/, '')}/?error=kustom_validation`,
    });
    if (!orderId || !token) return reject();

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        total: true,
        currency: true,
        payment_status: true,
        payment_method: true,
        kustom_order_id: true,
        kustom_push_token: true,
        store_id: true,
      },
    });
    if (
      !order ||
      order.payment_method !== PaymentMethod.KUSTOM ||
      !this.safeTokenEqual(order.kustom_push_token, token)
    ) {
      return reject();
    }

    const store = order.store_id
      ? await this.prisma.store.findUnique({
          where: { id: order.store_id },
          select: { slug: true, custom_domain: true, is_active: true },
        })
      : null;
    if (!store?.is_active) return reject(store);
    if (order.payment_status !== 'awaiting_payment') return reject(store);

    const b = (body && typeof body === 'object' ? body : {}) as {
      order_id?: unknown;
      order_amount?: unknown;
      purchase_currency?: unknown;
      merchant_reference1?: unknown;
    };
    if (
      typeof b.order_amount !== 'number' ||
      b.order_amount !== expectedKustomAmount(order)
    ) {
      this.logger.warn(
        `Kustom validation rejected for order ${order.id}: amount ${String(b.order_amount)} != ${expectedKustomAmount(order)}`,
      );
      return reject(store);
    }
    if (
      b.merchant_reference1 !== undefined &&
      b.merchant_reference1 !== order.id
    ) {
      return reject(store);
    }
    if (
      order.kustom_order_id &&
      typeof b.order_id === 'string' &&
      b.order_id !== order.kustom_order_id
    ) {
      return reject(store);
    }
    if (
      typeof b.purchase_currency === 'string' &&
      b.purchase_currency.toUpperCase() !== order.currency.toUpperCase()
    ) {
      return reject(store);
    }
    return { ok: true };
  }

  // ── Shared: verify with Kustom and mark paid ────────────────────────────

  /**
   * The one place an order becomes paid through Kustom. Reads the order from
   * the Order Management API, checks it is ours (merchant_reference1), is
   * authorized, and carries exactly our total in our currency — only then is
   * markOrderPaid called. Idempotent; safe for push, confirmation and session
   * to all race each other.
   */
  async processCompletedCheckout(
    order: {
      id: string;
      order_number: string;
      total: unknown;
      currency: string;
      kustom_order_id: string | null;
    },
    client: KustomClient,
    kustomOrderId: string,
  ): Promise<{ paid: boolean; changed: boolean }> {
    const live = await client.getOrder(kustomOrderId);

    // A session-first checkout was created before the order existed, so its
    // reference is the session id; accept it when that session is the one
    // this order came from.
    let viaSession = false;
    if (live.merchant_reference1 !== order.id) {
      const session =
        typeof live.merchant_reference1 === 'string'
          ? await this.prisma.kustomCheckoutSession.findFirst({
              where: { id: live.merchant_reference1, order_id: order.id },
              select: { id: true },
            })
          : null;
      if (!session) {
        await this.recordMismatch(
          order.id,
          `Kustom order ${kustomOrderId} belongs to reference ${String(live.merchant_reference1)}`,
        );
        return { paid: false, changed: false };
      }
      viaSession = true;
    }
    const status = (live.status ?? '').toUpperCase();
    if (!PAID_STATUSES.has(status)) {
      // Not (yet) authorized — e.g. CANCELLED/EXPIRED. Not a mismatch, just
      // nothing to do.
      this.logger.warn(
        `Ignoring Kustom order ${kustomOrderId} for order ${order.id}: status ${status}`,
      );
      return { paid: false, changed: false };
    }
    const expected = expectedKustomAmount(order);
    if (
      live.order_amount !== expected ||
      (live.purchase_currency ?? '').toUpperCase() !==
        order.currency.toUpperCase()
    ) {
      await this.recordMismatch(
        order.id,
        `Kustom authorized ${live.order_amount} ${String(live.purchase_currency)}, order total is ${expected} ${order.currency}`,
      );
      return { paid: false, changed: false };
    }

    if (!order.kustom_order_id) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { kustom_order_id: kustomOrderId },
      });
    }

    const result = await this.orders.markOrderPaid(
      order.id,
      undefined,
      'Kustom',
    );
    const changed = Boolean(result?.changed);

    if (changed && result) {
      await this.notifications.create(
        result.order.customer.user_id,
        'order_paid',
        'Payment received',
        `We received your payment for order ${result.order.order_number}.`,
        { order_id: order.id },
      );
      // Same emails Stripe's success path sends; best-effort inside MailService.
      await this.mail.dispatchOrderEmail(order.id, 'order_confirmation');
      await this.mail.dispatchOrderEmail(order.id, 'new_order_owner');
    }

    // Captured from the Kustom merchant portal already? Record it so the
    // shipped hook does not try (and fail) to capture a second time.
    if (status === 'CAPTURED') {
      await this.prisma.order.updateMany({
        where: { id: order.id, kustom_captured_at: null },
        data: { kustom_captured_at: new Date() },
      });
    }

    await this.syncShippingAddress(order.id, live);

    // Best-effort: label the Kustom order with the real order id/number so
    // the merchant portal shows it instead of the session id. Later reads
    // then match on order.id directly; a failure changes nothing here.
    if (viaSession) {
      try {
        await client.updateMerchantReferences(kustomOrderId, {
          merchant_reference1: order.id,
          merchant_reference2: order.order_number,
        });
      } catch (err) {
        this.logger.warn(
          `Could not update merchant references of Kustom order ${kustomOrderId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    try {
      await client.acknowledge(kustomOrderId);
    } catch (err) {
      this.logger.warn(
        `Could not acknowledge Kustom order ${kustomOrderId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return { paid: true, changed };
  }

  /**
   * A Kustom order that is authorized but does not match ours (wrong
   * reference, amount or currency) must never be marked paid — but it must
   * not vanish into the logs either: the money is held on the creator's
   * account. One timeline row (deduplicated) makes it visible in the order
   * views; the confirmation endpoint reports it as `mismatch`.
   */
  private async recordMismatch(orderId: string, detail: string) {
    this.logger.error(`Order ${orderId}: Kustom payment mismatch — ${detail}`);
    const note = `Kustom payment could not be matched to this order: ${detail}`;
    const existing = await this.prisma.orderTimeline.findFirst({
      where: { order_id: orderId, status: 'PAYMENT_MISMATCH', note },
      select: { id: true },
    });
    if (existing) return;
    await this.prisma.orderTimeline.create({
      data: {
        order_id: orderId,
        status: 'PAYMENT_MISMATCH',
        note,
        actor: 'system',
      },
    });
  }

  private async hasMismatch(orderId: string): Promise<boolean> {
    const row = await this.prisma.orderTimeline.findFirst({
      where: { order_id: orderId, status: 'PAYMENT_MISMATCH' },
      select: { id: true },
    });
    return Boolean(row);
  }

  /**
   * The customer may change the shipping address inside the Kustom iframe.
   * When it differs from the address the order was placed with, a new
   * Address row is created for the customer and the order re-pointed to it;
   * the original row is left untouched (other orders may reference it).
   */
  private async syncShippingAddress(
    orderId: string,
    live: KustomManagementOrder,
  ) {
    const remote: KustomAddress | undefined =
      live.shipping_address ?? live.billing_address;
    if (
      !remote?.street_address ||
      !remote.city ||
      !remote.postal_code ||
      !remote.country
    ) {
      return;
    }
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { customer_id: true, address: true },
    });
    if (!order) return;

    const norm = (v: string | null | undefined) =>
      (v ?? '').trim().toLowerCase();
    const fullName = [remote.given_name, remote.family_name]
      .filter(Boolean)
      .join(' ')
      .trim();
    const current = order.address;
    const same =
      norm(current.full_name) === norm(fullName || current.full_name) &&
      norm(current.line1) === norm(remote.street_address) &&
      norm(current.line2) === norm(remote.street_address2) &&
      norm(current.city) === norm(remote.city) &&
      norm(current.postal_code) === norm(remote.postal_code) &&
      norm(current.country_code) === norm(remote.country);
    if (same) return;

    try {
      const data = {
        customer_id: order.customer_id,
        label: 'Kustom',
        full_name: fullName || current.full_name,
        line1: remote.street_address,
        line2: remote.street_address2 || null,
        city: remote.city,
        state: remote.region || null,
        postal_code: remote.postal_code,
        country_code: remote.country.toUpperCase().slice(0, 2),
        phone: remote.phone || current.phone || null,
        is_default: false,
      };
      // Push and confirmation can race here; reuse an identical row written
      // by the other caller instead of stacking duplicates on the customer.
      const existing = await this.prisma.address.findFirst({
        where: {
          customer_id: data.customer_id,
          label: data.label,
          full_name: data.full_name,
          line1: data.line1,
          line2: data.line2,
          city: data.city,
          postal_code: data.postal_code,
          country_code: data.country_code,
        },
        select: { id: true },
      });
      const address = existing ?? (await this.prisma.address.create({ data }));
      // Only repoint while the order still references the original address,
      // so the loser of the race does not overwrite the winner's row.
      await this.prisma.order.updateMany({
        where: { id: orderId, address_id: current.id },
        data: { address_id: address.id },
      });
      this.logger.log(`Order ${orderId}: shipping address updated from Kustom`);
    } catch (err) {
      this.logger.warn(
        `Could not sync Kustom shipping address for order ${orderId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ── Creator settings ────────────────────────────────────────────────────

  private async creatorForUser(userId: string) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: {
        id: true,
        kustom_environment: true,
        ...kustomCreatorSelect,
        store: { select: { id: true, store_type: true, currency: true } },
      },
    });
    if (!creator) throw new NotFoundException('Creator profile not found');
    const platformConfig = await this.prisma.platformConfig.findFirst({
      select: { default_currency: true },
    });
    return {
      ...creator,
      storeCurrency: resolveStoreCurrency(
        creator.store,
        platformConfig?.default_currency,
      ),
    };
  }

  private toSettings(
    creator: Awaited<ReturnType<KustomService['creatorForUser']>>,
  ) {
    const supported = creator.store?.store_type === StoreType.INDEPENDENT;
    const secretConfigured = Boolean(creator.kustom_shared_secret);
    const currencySupported = isKustomCurrencySupported(creator.storeCurrency);
    return {
      supported,
      enabled: creator.kustom_enabled,
      merchant_id: creator.kustom_merchant_id || null,
      // The secret is never returned, only whether one is stored.
      secret_configured: secretConfigured,
      environment: this.normalizeEnvironment(creator.kustom_environment),
      currency: creator.storeCurrency,
      currency_supported: currencySupported,
      ready:
        supported &&
        currencySupported &&
        creator.kustom_enabled &&
        Boolean(creator.kustom_merchant_id) &&
        secretConfigured,
    };
  }

  async getSettings(userId: string) {
    return this.toSettings(await this.creatorForUser(userId));
  }

  async updateSettings(userId: string, dto: UpdateKustomSettingsDto) {
    const creator = await this.creatorForUser(userId);
    const data: {
      kustom_merchant_id?: string | null;
      kustom_shared_secret?: string | null;
      kustom_environment?: string;
      kustom_enabled?: boolean;
    } = {};
    // Only touch provided fields; an explicit empty string clears the value.
    if (dto.merchant_id !== undefined)
      data.kustom_merchant_id = dto.merchant_id.trim() || null;
    if (dto.shared_secret !== undefined) {
      data.kustom_shared_secret = this.crypto.encrypt(dto.shared_secret.trim());
    }
    if (dto.environment !== undefined)
      data.kustom_environment = dto.environment;
    if (dto.enabled !== undefined) data.kustom_enabled = dto.enabled;

    await this.prisma.creator.update({ where: { id: creator.id }, data });
    // The storefront caches getStore (which carries kustom_enabled) per store,
    // so the checkout would keep offering — or hiding — Kustom until the
    // cache expired. Fire-and-forget, like the store settings endpoints.
    await this.revalidation.revalidateStoreByCreatorId(creator.id);
    return this.getSettings(userId);
  }

  /**
   * Probe the stored credentials against Kustom with a read of an order that
   * cannot exist: 404 proves the credentials were accepted, 401/403 that
   * they were not.
   */
  async testSettings(
    userId: string,
  ): Promise<{ ok: boolean; message: string }> {
    const creator = await this.creatorForUser(userId);
    const creds = await this.credentialsFor(creator);
    if (!creds) {
      return {
        ok: false,
        message: 'Enter a Merchant ID and shared secret first.',
      };
    }
    const client = new KustomClient(creds);
    try {
      await client.getCheckout('00000000-0000-0000-0000-000000000000');
      return {
        ok: true,
        message: `Connected to Kustom (${creds.environment}).`,
      };
    } catch (err) {
      if (err instanceof KustomApiError) {
        if (err.status === 404) {
          return {
            ok: true,
            message: `Connected to Kustom (${creds.environment}).`,
          };
        }
        if (err.status === 401 || err.status === 403) {
          return {
            ok: false,
            message:
              'Kustom rejected these credentials. Check the Merchant ID, secret and environment.',
          };
        }
        return { ok: false, message: err.message };
      }
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── Capture / refund (creator or admin) ─────────────────────────────────

  /**
   * Load a Kustom order for management. A creator may only touch orders of
   * their own store; foreign orders are a 404 so ids are not enumerable.
   */
  private async loadManagedOrder(orderId: string, actor: Actor | null) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        order_number: true,
        total: true,
        currency: true,
        status: true,
        payment_status: true,
        payment_method: true,
        kustom_order_id: true,
        kustom_capture_id: true,
        kustom_captured_at: true,
        store_id: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (actor && actor.role !== UserRole.ADMIN) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: actor.userId },
        select: { store: { select: { id: true } } },
      });
      if (!creator?.store || creator.store.id !== order.store_id) {
        throw new NotFoundException('Order not found');
      }
    }
    if (
      order.payment_method !== PaymentMethod.KUSTOM ||
      !order.kustom_order_id
    ) {
      throw new BadRequestException({
        code: 'KUSTOM_ORDER_NOT_KUSTOM',
        message: 'This order was not paid through Kustom.',
      });
    }
    return { ...order, kustom_order_id: order.kustom_order_id };
  }

  /** Capture the full authorized amount. Idempotent per order. */
  async captureOrder(orderId: string, actor: Actor | null = null) {
    const order = await this.loadManagedOrder(orderId, actor);
    if (order.kustom_captured_at) {
      return {
        captured: false,
        capture_id: order.kustom_capture_id ?? null,
        already_captured: true,
      };
    }
    if (order.payment_status !== 'paid') {
      throw new BadRequestException({
        code: 'KUSTOM_ORDER_NOT_AUTHORIZED',
        message:
          'The payment has not been authorized yet, so it cannot be captured.',
      });
    }

    const { client } = await this.clientForStore(order.store_id);
    const amount = expectedKustomAmount(order);
    let captureId: string | null = null;
    try {
      captureId = await client.capture(
        order.kustom_order_id,
        {
          captured_amount: amount,
          description: `Order ${order.order_number}`,
        },
        // One capture per order, so a retry after a timeout replays the same
        // key and Kustom deduplicates instead of capturing twice.
        `${order.id}:capture`,
      );
    } catch (err) {
      // Kustom refuses a second capture — it may already have been captured
      // from the merchant portal. Read the order to find out before failing.
      if (
        err instanceof KustomApiError &&
        (err.status === 403 || err.status === 409)
      ) {
        const live = await client
          .getOrder(order.kustom_order_id)
          .catch(() => null);
        if (live && (live.captured_amount ?? 0) >= amount) {
          await this.markCaptured(order.id, null, actor);
          return { captured: false, capture_id: null, already_captured: true };
        }
      }
      throw this.toHttpException(err, 'capture the payment');
    }

    await this.markCaptured(order.id, captureId, actor);
    return { captured: true, capture_id: captureId, already_captured: false };
  }

  private async markCaptured(
    orderId: string,
    captureId: string | null,
    actor: Actor | null,
  ) {
    // Guarded: the shipped hook and a manual click can race, and the loser
    // must neither overwrite a real capture id with null nor add a second
    // timeline row.
    const flip = await this.prisma.order.updateMany({
      where: { id: orderId, kustom_captured_at: null },
      data: { kustom_capture_id: captureId, kustom_captured_at: new Date() },
    });
    if (flip.count === 0) return;
    await this.prisma.orderTimeline.create({
      data: {
        order_id: orderId,
        status: 'CAPTURED',
        note: 'Payment captured via Kustom',
        actor: actor?.userId ?? 'system',
      },
    });
  }

  /**
   * Shipped hook: capture the authorization once the goods leave. Safe for
   * any order — a no-op unless it is a paid, not-yet-captured Kustom order.
   * Never throws; a failure is logged and can be retried manually.
   */
  async captureOnShipped(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        payment_method: true,
        payment_status: true,
        kustom_order_id: true,
        kustom_captured_at: true,
      },
    });
    if (
      !order ||
      order.payment_method !== PaymentMethod.KUSTOM ||
      !order.kustom_order_id ||
      order.kustom_captured_at ||
      order.payment_status !== 'paid'
    ) {
      return;
    }
    try {
      await this.captureOrder(orderId, null);
      this.logger.log(`Order ${orderId}: Kustom payment captured on shipment`);
    } catch (err) {
      this.logger.warn(
        `Order ${orderId}: Kustom capture on shipment failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Refund `amount` (major units; omitted = the whole order). Kustom can only
   * refund captured money, so a full refund of an uncaptured order releases
   * the authorization (cancel) instead. Our order state follows the same
   * paths the Stripe webhook uses.
   */
  async refundOrder(
    orderId: string,
    amountMajor: number | undefined,
    actor: Actor,
  ) {
    const order = await this.loadManagedOrder(orderId, actor);
    if (order.payment_status === 'refunded') {
      throw new BadRequestException({
        code: 'KUSTOM_ORDER_ALREADY_REFUNDED',
        message: 'This order is already refunded.',
      });
    }
    if (order.payment_status !== 'paid') {
      throw new BadRequestException({
        code: 'KUSTOM_ORDER_NOT_PAID',
        message: 'Only paid orders can be refunded.',
      });
    }

    const total = Number(order.total);
    const amount = amountMajor ?? total;
    if (!(amount > 0) || amount > total + 1e-6) {
      throw new BadRequestException({
        code: 'KUSTOM_REFUND_AMOUNT_INVALID',
        message: `The refund amount must be between 0 and ${total} ${order.currency}.`,
      });
    }
    const isFull = Math.abs(amount - total) < 0.005;
    const minor = toStripeAmount(amount, order.currency);
    const description = `Refund for order ${order.order_number}`;
    const { client } = await this.clientForStore(order.store_id);

    // Kustom is the ledger: bound the refund by what is actually captured
    // and not yet refunded there, so N partial refunds can never exceed the
    // capture and a capture made from the merchant portal is respected.
    let live: KustomManagementOrder;
    try {
      live = await client.getOrder(order.kustom_order_id);
    } catch (err) {
      throw this.toHttpException(err, 'read the order before refunding');
    }
    const capturedMinor = live.captured_amount ?? 0;
    const refundedMinor = live.refunded_amount ?? 0;
    const refundableMinor = capturedMinor - refundedMinor;
    const capturedOnKustom = capturedMinor > 0;

    try {
      if (!capturedOnKustom) {
        if (!isFull) {
          throw new BadRequestException({
            code: 'KUSTOM_CAPTURE_REQUIRED',
            message: 'Capture the payment before issuing a partial refund.',
          });
        }
        // Nothing captured: releasing the authorization is the refund.
        await client.cancel(order.kustom_order_id, `${order.id}:cancel`);
      } else {
        if (minor > refundableMinor) {
          throw new BadRequestException({
            code: 'KUSTOM_REFUND_EXCEEDS_CAPTURE',
            message: `Only ${fromStripeAmount(refundableMinor, order.currency)} ${order.currency} can still be refunded for this order.`,
          });
        }
        // Key = order + amount + how many refunds Kustom already holds: a
        // retry after a timeout replays the same key (deduplicated), while a
        // deliberate second refund of the same amount gets a new one.
        const refundCount = live.refunds?.length ?? 0;
        await client.refund(
          order.kustom_order_id,
          { refunded_amount: minor, description },
          `${order.id}:refund:${minor}:${refundCount}`,
        );
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw this.toHttpException(err, 'refund the payment');
    }

    // A capture made outside our API (Kustom portal) is now known — record
    // it so the order view and the shipped hook stop treating it as open.
    if (capturedOnKustom && !order.kustom_captured_at) {
      await this.markCaptured(order.id, null, actor);
    }

    if (isFull) {
      await this.orders.markOrderRefunded(order.id, 'Kustom');
    } else {
      await this.orders.recordPartialRefund(
        order.id,
        amount,
        order.currency,
        'Kustom',
      );
    }
    return { refunded: true, amount };
  }
}
