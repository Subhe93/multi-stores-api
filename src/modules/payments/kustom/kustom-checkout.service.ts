import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PaymentMethod, Prisma, UserRole } from '@prisma/client';
import type { KustomCheckoutSession } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { OrdersService, type OrderQuote } from '../../orders/orders.service';
import {
  type CartLineLike,
  type NormalizedCartLine,
  normalizeCartLine,
} from '../../cart/cart-line';
import { normalizeEmail } from '../../../common/email/email.util';
import { KustomService, type StoreContext } from './kustom.service';
import {
  KustomClient,
  type KustomAddress,
  type KustomCheckoutCallbackBody,
  type KustomCheckoutOrder,
  type KustomCheckoutUpdateResponse,
} from './kustom.client';
import {
  buildKustomSessionAmounts,
  buildKustomSessionPayload,
  expectedKustomAmount,
  resolveStoreBase,
  type KustomAddressInput,
  type KustomOrderItemInput,
  type KustomSessionInput,
  type KustomSessionMapperContext,
  type ShippingQuoteOption,
} from './kustom.mapper';
import { isKustomEnabledForStore } from './kustom.eligibility';
import {
  CreateKustomCheckoutSessionDto,
  UpdateKustomCheckoutSessionDto,
} from './dto/kustom-checkout.dto';

// Kustom keeps a checkout alive for 48 h; so do we.
const SESSION_TTL_MS = 48 * 60 * 60 * 1000;
// Sessions that expired this long ago are purged opportunistically: their
// Kustom checkout is long gone and no push can still arrive for them.
const PURGE_AFTER_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
// A validation that claimed the session but never finished (crash) is
// reclaimable after this long.
const ORDERING_STALE_MS = 30_000;
// A validation that finds another validation in progress waits this long
// for it to finish before giving up (Kustom's own budget is 3 s).
const CONCURRENT_VALIDATION_WAIT_MS = 2_000;
const CONCURRENT_VALIDATION_POLL_MS = 250;
// bcrypt cost for the random password of a guest's auto-created account.
// AuthService.register uses 12 (~300 ms); this runs inside Kustom's 3 s
// validation budget next to pricing, stock and order creation, so 10
// (~100 ms) is the compromise. The password is 32 random base64url
// characters that nobody knows — the account is claimed via "forgot
// password" — so the lower cost does not weaken it in practice.
const GUEST_PASSWORD_BCRYPT_COST = 10;
// Description shown under a PICKUP shipping option (delivery options show
// their estimated days instead), keyed by language.
const PICKUP_DESCRIPTIONS: Record<string, string> = {
  en: 'Pick up in store',
  sv: 'Hämta i butik',
  de: 'Abholung im Geschäft',
  fr: 'Retrait en magasin',
  tr: 'Mağazadan teslim al',
  ar: 'الاستلام من المتجر',
};
// Where a store is assumed to ship before Kustom reports an address: the
// currency's home market, else the store language's country.
const CURRENCY_COUNTRIES: Record<string, string> = {
  SEK: 'SE',
  NOK: 'NO',
  DKK: 'DK',
  GBP: 'GB',
  USD: 'US',
  CHF: 'CH',
  PLN: 'PL',
  CZK: 'CZ',
  HUF: 'HU',
  RON: 'RO',
  AUD: 'AU',
  NZD: 'NZ',
  CAD: 'CA',
};
const LOCALE_COUNTRIES: Record<string, string> = {
  sv: 'SE',
  nb: 'NO',
  no: 'NO',
  da: 'DK',
  fi: 'FI',
  de: 'DE',
  fr: 'FR',
  nl: 'NL',
  tr: 'TR',
  en: 'GB',
  pl: 'PL',
  es: 'ES',
};
// Kustom needs a purchase_country even when we have no idea where the shopper
// is; en-GB is the mapper's neutral locale, so GB is its country.
const FALLBACK_PURCHASE_COUNTRY = 'GB';
// Timeline note on an order abandoned by the session flow.
const STALE_ORDER_REASON = 'Kustom validation failed after order creation';
const REPLACED_ORDER_REASON =
  'Checkout changed before payment; the order was replaced';

type Session = KustomCheckoutSession;

/** Which of the session's two secrets a caller presents. */
type SessionSecret = 'callback' | 'storefront';

/** Outcome of a Kustom callback: a JSON body, or a 303 back to the storefront. */
export type KustomCallbackResult =
  | { ok: true; body?: unknown }
  | { ok: false; redirectUrl: string };

interface CustomerPrefill {
  email: string | null;
  phone: string | null;
  address: KustomAddressInput | null;
}

interface PricedSession {
  quote: OrderQuote;
  input: KustomSessionInput;
  /** The offered method Kustom preselects (null when none is offered). */
  selectedShippingId: string | null;
}

/** The order a session created that is still waiting for Kustom's money. */
interface PendingOrder {
  id: string;
  total: unknown;
  currency: string;
  shipping_method_id: string | null;
  address: {
    line1: string;
    city: string;
    postal_code: string;
    country_code: string;
  } | null;
}

type PriceResult =
  | { ok: true; priced: PricedSession }
  | { ok: false; shippingUnavailable: string };

/**
 * Kustom-first checkout (API-CONTRACT-B.md): the iframe is shown before any
 * order exists. A session snapshots the lines, coupon and notes; every
 * Kustom callback re-prices that snapshot on the server (never trusting
 * amounts from the body) and the order itself is created inside Kustom's
 * validation callback, right before the money is authorized.
 *
 * Two secrets per session: `token` goes to the browser and authenticates
 * the storefront endpoints plus the confirmation redirect; `callback_token`
 * is only ever placed in the merchant URLs Kustom calls server-to-server.
 * A leaked storefront token can therefore never approve a validation or
 * re-price a checkout.
 *
 * Money verification (push / confirmation / capture / refund) is the existing
 * KustomService — this class only adds the session lifecycle on top of it.
 */
@Injectable()
export class KustomCheckoutService {
  private readonly logger = new Logger(KustomCheckoutService.name);

  constructor(
    private prisma: PrismaService,
    private kustom: KustomService,
    private orders: OrdersService,
    private mail: MailService,
  ) {}

  // ── Session lookup / auth ───────────────────────────────────────────────

  /**
   * Unknown id or wrong secret are both a 404, so ids are not probeable.
   * `kind` says which secret the caller must hold: the callback token for
   * Kustom's server-side calls, the storefront token for the browser.
   */
  private async loadSession(
    sessionId: string,
    secret: string,
    kind: SessionSecret,
  ): Promise<Session> {
    if (!sessionId || !secret) throw new NotFoundException();
    const session = await this.prisma.kustomCheckoutSession.findUnique({
      where: { id: sessionId },
    });
    const expected =
      kind === 'callback' ? session?.callback_token : session?.token;
    if (!session || !this.kustom.safeTokenEqual(expected, secret)) {
      throw new NotFoundException();
    }
    return session;
  }

  private isExpired(session: Session): boolean {
    return (
      session.status === 'expired' || session.expires_at.getTime() < Date.now()
    );
  }

  /** Storefront endpoints: 410 when expired (and mark it so). */
  private async assertNotExpired(session: Session): Promise<void> {
    if (!this.isExpired(session)) return;
    await this.prisma.kustomCheckoutSession.updateMany({
      where: { id: session.id, status: 'open' },
      data: { status: 'expired' },
    });
    throw new GoneException({
      code: 'KUSTOM_SESSION_EXPIRED',
      message: 'This checkout session has expired. Please start again.',
    });
  }

  private orderedConflict(): ConflictException {
    return new ConflictException({
      code: 'KUSTOM_SESSION_ORDERED',
      message: 'This checkout session has already been completed.',
    });
  }

  private async storeForSession(session: Session): Promise<StoreContext> {
    const ctx = await this.kustom.loadStoreContext(session.store_id);
    if (!ctx) throw new NotFoundException();
    return ctx;
  }

  /** The store must still be eligible and the creator's credentials present. */
  private async clientFor(ctx: StoreContext): Promise<KustomClient> {
    const creds = isKustomEnabledForStore({ ...ctx, currency: ctx.currency })
      ? await this.kustom.credentialsFor(ctx.creator)
      : null;
    if (!creds) {
      throw new BadRequestException({
        code: 'ORDER_KUSTOM_UNAVAILABLE',
        message: 'Kustom Checkout is not available for this store.',
      });
    }
    return new KustomClient(creds);
  }

  private itemsOf(session: Pick<Session, 'items'>): NormalizedCartLine[] {
    const raw = session.items as unknown;
    return Array.isArray(raw)
      ? (raw as CartLineLike[]).map((l) => normalizeCartLine(l))
      : [];
  }

  private redirectUrl(
    ctx: StoreContext,
    error: string,
    reason?: string,
  ): string {
    const base = resolveStoreBase(
      this.kustom.urls().storefrontBase,
      ctx.slug,
      ctx.customDomain,
    );
    const query = reason
      ? `error=${error}&reason=${encodeURIComponent(reason)}`
      : `error=${error}`;
    return `${base}/checkout?${query}`;
  }

  // ── Pricing ─────────────────────────────────────────────────────────────

  /** Language the iframe shows: the session's locale, else the store's. */
  private sessionLocale(
    session: Pick<Session, 'locale'>,
    ctx: StoreContext,
  ): string {
    return session.locale ?? ctx.primaryLocale ?? 'en';
  }

  private pickupDescription(
    session: Pick<Session, 'locale'>,
    ctx: StoreContext,
  ): string {
    const lang = this.sessionLocale(session, ctx)
      .toLowerCase()
      .split(/[-_]/)[0];
    return PICKUP_DESCRIPTIONS[lang] ?? PICKUP_DESCRIPTIONS.en;
  }

  private defaultCountry(ctx: StoreContext): string | null {
    const byCurrency = CURRENCY_COUNTRIES[ctx.currency.toUpperCase()];
    if (byCurrency) return byCurrency;
    const lang = (ctx.primaryLocale ?? '').toLowerCase().split(/[-_]/)[0];
    return LOCALE_COUNTRIES[lang] ?? null;
  }

  /**
   * Price the session's snapshot for a destination through OrdersService —
   * the very code path create() uses — and attach the display data Kustom
   * needs. Every quoted shipping method becomes a Kustom option; the
   * previously selected one stays selected while it is still offered, else
   * the cheapest method is (the quote already applies that rule). A coupon
   * that grants free shipping makes every option free, exactly as the quote
   * charges nothing for the one that is chosen.
   * `shippingUnavailable` is returned rather than thrown so the callbacks
   * can answer with the contracted redirect.
   */
  private async priceSession(
    session: Pick<Session, 'id' | 'store_id' | 'items' | 'locale'>,
    ctx: StoreContext,
    opts: {
      countryCode: string | null;
      couponCode: string | null;
      selectedShippingId: string | null;
      prefill?: CustomerPrefill | null;
      /** purchase_country of the existing Kustom checkout (fixed on update). */
      purchaseCountry?: string | null;
    },
  ): Promise<PriceResult> {
    const lines = this.itemsOf(session);
    const quote = await this.orders.quoteLines(session.store_id, lines, {
      countryCode: opts.countryCode,
      couponCode: opts.couponCode,
      shippingMethodId: opts.selectedShippingId,
      locale: this.sessionLocale(session, ctx),
    });
    if (quote.shipping && !quote.shipping.available) {
      return { ok: false, shippingUnavailable: quote.shipping.message };
    }

    const freeShipping = quote.coupon?.free_shipping === true;
    const shippingOptions: ShippingQuoteOption[] = quote.shipping?.available
      ? quote.shipping.methods.map((m) => ({
          id: m.id,
          name: m.name,
          type: m.type === 'PICKUP' ? 'pickup' : 'delivery',
          cost: freeShipping ? 0 : m.cost,
          estimated_days: m.estimated_days,
          description:
            m.type === 'PICKUP'
              ? this.pickupDescription(session, ctx)
              : undefined,
        }))
      : [];
    const selected = quote.shipping?.available ? quote.shipping.method : null;

    const input: KustomSessionInput = {
      currency: quote.currency,
      shipping_cost: quote.shipping_cost,
      discount_amount: quote.discount_amount,
      total: quote.total,
      items: await this.describeItems(quote),
      purchaseCountry:
        opts.purchaseCountry ??
        opts.countryCode ??
        this.purchaseCountryFallback(ctx),
      reference: session.id,
      email: opts.prefill?.email ?? null,
      phone: opts.prefill?.phone ?? null,
      address: opts.prefill?.address ?? null,
      shippingOptions,
      selectedShippingId: selected?.id ?? null,
    };
    return {
      ok: true,
      priced: {
        quote,
        input,
        selectedShippingId: selected?.id ?? null,
      },
    };
  }

  private purchaseCountryFallback(ctx: StoreContext): string {
    return this.defaultCountry(ctx) ?? FALLBACK_PURCHASE_COUNTRY;
  }

  /** Titles, SKUs and option labels for the quoted lines, in three queries. */
  private async describeItems(
    quote: OrderQuote,
  ): Promise<KustomOrderItemInput[]> {
    const ids = (pick: (i: OrderQuote['items'][number]) => string | null) =>
      Array.from(new Set(quote.items.map(pick).filter(Boolean) as string[]));
    const productIds = ids((i) => i.product_id);
    const customProductIds = ids((i) => i.custom_product_id);
    const variantIds = ids((i) => i.variant_id);
    const translationSelect = { select: { locale: true, title: true } };

    const [products, customProducts, variants] = await Promise.all([
      productIds.length
        ? this.prisma.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, translations: translationSelect },
          })
        : [],
      customProductIds.length
        ? this.prisma.customProduct.findMany({
            where: { id: { in: customProductIds } },
            select: { id: true, translations: translationSelect },
          })
        : [],
      variantIds.length
        ? this.prisma.productVariant.findMany({
            where: { id: { in: variantIds } },
            select: { id: true, sku: true, options: true },
          })
        : [],
    ]);
    const byId = <T extends { id: string }>(rows: T[]) =>
      new Map(rows.map((r) => [r.id, r]));
    const productMap = byId(products);
    const customMap = byId(customProducts);
    const variantMap = byId(variants);

    return quote.items.map((item, index) => ({
      id:
        item.variant_id ??
        item.product_id ??
        item.custom_product_id ??
        `line-${index}`,
      quantity: item.quantity,
      unit_price: item.unit_price,
      total_price: item.total_price,
      product: item.product_id
        ? (productMap.get(item.product_id) ?? null)
        : null,
      custom_product: item.custom_product_id
        ? (customMap.get(item.custom_product_id) ?? null)
        : null,
      variant: item.variant_id
        ? (variantMap.get(item.variant_id) ?? null)
        : null,
    }));
  }

  private mapperContext(
    ctx: StoreContext,
    session: Pick<Session, 'id' | 'token' | 'callback_token'>,
    bases: { storefrontBase: string; apiBase: string },
  ): KustomSessionMapperContext {
    return {
      storeSlug: ctx.slug,
      customDomain: ctx.customDomain,
      primaryLocale: ctx.primaryLocale,
      storefrontBase: bases.storefrontBase,
      apiBase: bases.apiBase,
      sessionId: session.id,
      token: session.token,
      callbackToken: session.callback_token,
      taxRateBp: ctx.taxRateBp,
    };
  }

  /** Email, phone and default address of a logged-in customer, for prefill. */
  private async customerPrefill(
    customerId: string | null,
  ): Promise<CustomerPrefill | null> {
    if (!customerId) return null;
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        phone: true,
        user: { select: { email: true } },
        addresses: {
          orderBy: [{ is_default: 'desc' }, { created_at: 'desc' }],
          take: 1,
        },
      },
    });
    if (!customer) return null;
    const a = customer.addresses[0];
    return {
      email: customer.user.email ?? null,
      phone: customer.phone ?? null,
      address: a
        ? {
            full_name: a.full_name,
            line1: a.line1,
            line2: a.line2,
            city: a.city,
            state: a.state,
            postal_code: a.postal_code,
            country_code: a.country_code,
            phone: a.phone,
          }
        : null,
    };
  }

  /**
   * What the storefront gets back. Only the storefront token is exposed; the
   * callback token never leaves the server.
   */
  private sessionResponse(session: Session, checkout: KustomCheckoutOrder) {
    return {
      session_id: session.id,
      token: session.token,
      kustom_order_id: session.kustom_order_id ?? checkout.order_id,
      html_snippet: checkout.html_snippet ?? '',
      status: (checkout.status ?? '').toLowerCase(),
    };
  }

  // ── Storefront: create / update ─────────────────────────────────────────

  /**
   * Start a session and create the Kustom checkout for it. The snapshot is
   * the guest's cart lines, or the logged-in customer's server cart when no
   * lines are sent. Nothing is reserved or claimed here.
   */
  async createSession(
    userId: string | null,
    dto: CreateKustomCheckoutSessionDto,
  ) {
    const ctx = await this.kustom.loadStoreContextBySlug(dto.store_slug);
    if (!ctx || !ctx.is_active) {
      throw new NotFoundException({
        code: 'STOREFRONT_STORE_NOT_FOUND',
        message: 'Store not found',
      });
    }
    const client = await this.clientFor(ctx);
    const bases = this.kustom.requirePublicUrls();
    this.purgeStaleSessions();

    const customer = userId
      ? await this.prisma.customer.findUnique({
          where: { user_id: userId },
          select: { id: true },
        })
      : null;

    let raw: CartLineLike[] = dto.items ?? [];
    if (!raw.length && customer) {
      const cart = await this.prisma.cart.findUnique({
        where: { customer_id: customer.id },
        select: { items: true },
      });
      raw = cart?.items ?? [];
    }
    const lines = raw.map((l) => normalizeCartLine(l));
    if (!lines.length) {
      throw new BadRequestException({
        code: 'ORDER_CART_EMPTY',
        message: 'Cart is empty',
      });
    }

    const prefill = await this.customerPrefill(customer?.id ?? null);
    let country =
      prefill?.address?.country_code.toUpperCase() ?? this.defaultCountry(ctx);

    const session = await this.prisma.kustomCheckoutSession.create({
      data: {
        id: randomUUID(),
        store_id: ctx.id,
        customer_id: customer?.id ?? null,
        token: randomBytes(32).toString('hex'),
        callback_token: randomBytes(32).toString('hex'),
        status: 'open',
        locale: dto.locale?.trim() || null,
        currency: ctx.currency,
        items: lines as unknown as Prisma.InputJsonValue,
        coupon_code: dto.coupon_code?.trim() || null,
        notes: dto.notes?.trim() || null,
        country_code: country,
        expires_at: new Date(Date.now() + SESSION_TTL_MS),
      },
    });

    try {
      let priced = await this.priceSession(session, ctx, {
        countryCode: country,
        couponCode: session.coupon_code,
        selectedShippingId: null,
        prefill,
      });
      if (!priced.ok) {
        // The assumed destination cannot be shipped to: offer no option yet
        // and let the address Kustom collects decide.
        country = null;
        priced = await this.priceSession(session, ctx, {
          countryCode: null,
          couponCode: session.coupon_code,
          selectedShippingId: null,
          prefill,
        });
      }
      if (!priced.ok) {
        throw new BadRequestException(priced.shippingUnavailable);
      }
      const payload = buildKustomSessionPayload(
        priced.priced.input,
        this.mapperContext(ctx, session, bases),
      );
      let created: KustomCheckoutOrder;
      try {
        created = await client.createCheckout(payload);
      } catch (err) {
        throw this.kustom.toHttpException(err, 'create the checkout session');
      }
      const stored = await this.prisma.kustomCheckoutSession.update({
        where: { id: session.id },
        data: {
          kustom_order_id: created.order_id,
          country_code: country,
          // Kustom refuses a different purchase_country on update, so the
          // one the checkout was created with is pinned to the session.
          purchase_country: payload.purchase_country,
          shipping_method_id: priced.priced.selectedShippingId,
          shipping_cost: priced.priced.quote.shipping_cost,
        },
      });
      return this.sessionResponse(stored, created);
    } catch (err) {
      // No checkout exists for this row (or it was never stored); drop it so
      // the storefront starts clean on retry.
      await this.prisma.kustomCheckoutSession
        .delete({ where: { id: session.id } })
        .catch(() => undefined);
      throw err;
    }
  }

  /**
   * Opportunistic housekeeping on the create path: rows whose expiry is more
   * than a week old are useless (no push can still arrive, the confirmation
   * page has long been shown). Fire-and-forget, so it never delays or fails
   * the request; the index-free scan is cheap because the table only ever
   * holds a few days of sessions.
   */
  private purgeStaleSessions(): void {
    void this.prisma.kustomCheckoutSession
      .deleteMany({
        where: {
          expires_at: { lt: new Date(Date.now() - PURGE_AFTER_EXPIRY_MS) },
        },
      })
      .catch((err: unknown) =>
        this.logger.warn(`Kustom session purge failed: ${this.describe(err)}`),
      );
  }

  /**
   * Resync a session after the shopper changed quantities, coupon or notes:
   * re-price and push the new amounts to the Kustom checkout. A session
   * whose order is still awaiting payment (validation passed, the money was
   * never authorized) is edited like an open one: the stale order is failed
   * and unlinked when the snapshot or total changed, and the next validation
   * creates a fresh one.
   */
  async updateSession(sessionId: string, dto: UpdateKustomCheckoutSessionDto) {
    const session = await this.loadSession(sessionId, dto.token, 'storefront');
    await this.assertNotExpired(session);
    const pending = await this.pendingOrderOf(session);
    if (session.status !== 'open' && !pending) throw this.orderedConflict();
    const ctx = await this.storeForSession(session);
    const client = await this.clientFor(ctx);
    const bases = this.kustom.requirePublicUrls();

    const data: Prisma.KustomCheckoutSessionUpdateInput = {};
    if (dto.items !== undefined) {
      data.items = dto.items.map((l) =>
        normalizeCartLine(l),
      ) as unknown as Prisma.InputJsonValue;
    }
    if (dto.coupon_code !== undefined) {
      data.coupon_code = dto.coupon_code?.trim() || null;
    }
    if (dto.notes !== undefined) data.notes = dto.notes?.trim() || null;

    const next: Session = {
      ...session,
      items: (data.items ?? session.items) as Prisma.JsonValue,
      coupon_code:
        data.coupon_code !== undefined
          ? (data.coupon_code as string | null)
          : session.coupon_code,
      notes:
        data.notes !== undefined
          ? (data.notes as string | null)
          : session.notes,
    };
    if (!this.itemsOf(next).length) {
      throw new BadRequestException({
        code: 'ORDER_CART_EMPTY',
        message: 'Cart is empty',
      });
    }

    // The iframe already holds whatever address the shopper typed, so no
    // prefill is sent on updates — Kustom would ignore or override it anyway.
    const pricingOpts = {
      couponCode: next.coupon_code,
      purchaseCountry: session.purchase_country,
    };
    let priced = await this.priceSession(next, ctx, {
      ...pricingOpts,
      countryCode: session.country_code,
      selectedShippingId: session.shipping_method_id,
    });
    let country = session.country_code;
    if (!priced.ok) {
      country = null;
      priced = await this.priceSession(next, ctx, {
        ...pricingOpts,
        countryCode: null,
        selectedShippingId: null,
      });
    }
    if (!priced.ok) throw new BadRequestException(priced.shippingUnavailable);

    if (!session.kustom_order_id) {
      throw new ConflictException({
        code: 'KUSTOM_SESSION_MISSING',
        message: 'This checkout session has no Kustom checkout.',
      });
    }
    const payload = buildKustomSessionPayload(
      priced.priced.input,
      this.mapperContext(ctx, session, bases),
    );

    // Push the new snapshot to Kustom FIRST. Kustom refuses to update a
    // completed checkout, so a pending order that Kustom already authorized
    // (validation passed, push not yet processed) is never touched: the
    // update fails here and the order keeps its link.
    let updated: KustomCheckoutOrder;
    try {
      updated = await client.updateCheckout(session.kustom_order_id, payload);
    } catch (err) {
      throw this.kustom.toHttpException(err, 'update the checkout session');
    }

    // A pending order that no longer matches what the shopper is buying is
    // replaced; one that still matches (an identical resync) is kept, and
    // nothing needs to be written for it.
    if (pending) {
      const changed =
        expectedKustomAmount(pending) !== payload.order_amount ||
        this.snapshotChanged(session, next);
      if (!changed) return this.sessionResponse(session, updated);
      if (!(await this.detachPendingOrder(session, pending.id))) {
        throw this.orderedConflict();
      }
    }

    // Only an open session takes the new snapshot: a validation that claimed
    // it meanwhile must keep pricing what Kustom is authorizing.
    const stored = await this.prisma.kustomCheckoutSession.updateMany({
      where: { id: session.id, status: 'open' },
      data: {
        ...data,
        country_code: country,
        shipping_method_id: priced.priced.selectedShippingId,
        shipping_cost: priced.priced.quote.shipping_cost,
      },
    });
    if (stored.count === 0) throw this.orderedConflict();
    const fresh = await this.prisma.kustomCheckoutSession.findUnique({
      where: { id: session.id },
    });
    return this.sessionResponse(fresh ?? session, updated);
  }

  /** True when items, coupon or notes differ between two session states. */
  private snapshotChanged(
    before: Pick<Session, 'items' | 'coupon_code' | 'notes'>,
    after: Pick<Session, 'items' | 'coupon_code' | 'notes'>,
  ): boolean {
    return (
      JSON.stringify(this.itemsOf(before)) !==
        JSON.stringify(this.itemsOf(after)) ||
      (before.coupon_code ?? null) !== (after.coupon_code ?? null) ||
      (before.notes ?? null) !== (after.notes ?? null)
    );
  }

  // ── Ordered-but-unpaid sessions ─────────────────────────────────────────

  /**
   * The order linked to an `ordered` session while it is still
   * `awaiting_payment` — validation approved it but Kustom never pushed the
   * money (declined, abandoned, retried). Null for any other state, so a
   * paid order can never be touched by the edit paths.
   */
  private async pendingOrderOf(session: Session): Promise<PendingOrder | null> {
    if (session.status !== 'ordered' || !session.order_id) return null;
    const order = await this.prisma.order.findUnique({
      where: { id: session.order_id },
      select: {
        id: true,
        total: true,
        currency: true,
        payment_status: true,
        shipping_method_id: true,
        address: {
          select: {
            line1: true,
            city: true,
            postal_code: true,
            country_code: true,
          },
        },
      },
    });
    return order?.payment_status === 'awaiting_payment' ? order : null;
  }

  /**
   * Reopen a session whose pending order is stale: the session goes back to
   * `open` with no order (atomically, so concurrent callers do it once), then
   * the order is failed, its stock and coupon handed back and its Kustom link
   * cleared so the fresh order can take it (Order.kustom_order_id is unique).
   * Returns false when the session was no longer in that state.
   */
  private async detachPendingOrder(
    session: Pick<Session, 'id'>,
    orderId: string,
    reason = REPLACED_ORDER_REASON,
  ): Promise<boolean> {
    const reopened = await this.prisma.kustomCheckoutSession.updateMany({
      where: { id: session.id, status: 'ordered', order_id: orderId },
      data: { status: 'open', order_id: null },
    });
    if (reopened.count === 0) return false;
    // The order may have been paid between the caller's read and now (push
    // or confirmation racing this edit). markOrderFailed refuses a paid order;
    // in that case the session must go back to `ordered` and the order must
    // keep its Kustom link and coupon.
    const failed = await this.abandonOrder(orderId, reason);
    if (!failed) {
      await this.prisma.kustomCheckoutSession.updateMany({
        where: { id: session.id, status: 'open', order_id: null },
        data: { status: 'ordered', order_id: orderId },
      });
      this.logger.warn(
        `Kustom session ${session.id}: order ${orderId} was paid meanwhile — kept`,
      );
      return false;
    }
    await this.prisma.order
      .updateMany({
        // Only a failed order gives up its Kustom link.
        where: { id: orderId, payment_status: 'failed' },
        data: { kustom_order_id: null, kustom_push_token: null },
      })
      .catch((err: unknown) =>
        this.logger.warn(
          `Kustom session ${session.id}: could not unlink order ${orderId}: ${this.describe(err)}`,
        ),
      );
    this.logger.log(
      `Kustom session ${session.id}: order ${orderId} replaced (${reason})`,
    );
    return true;
  }

  /**
   * Fail an order the session flow will never pay and free its coupon.
   * Returns true when the order was actually moved to `failed` now (or was
   * already failed); false when it could not be failed — typically because
   * it was paid meanwhile — in which case the coupon is left alone.
   */
  private async abandonOrder(
    orderId: string,
    reason: string,
  ): Promise<boolean> {
    let failed = false;
    try {
      const result = await this.orders.markOrderFailed(orderId, reason);
      failed = Boolean(
        result && (result.changed || result.order.payment_status === 'failed'),
      );
    } catch (err) {
      this.logger.error(
        `Kustom: could not fail abandoned order ${orderId}: ${this.describe(err)}`,
      );
    }
    if (failed) await this.orders.releaseOrderCoupon(orderId);
    return failed;
  }

  /** Whether the address Kustom reports differs from the one an order holds. */
  private addressChanged(
    stored: PendingOrder['address'],
    reported: KustomAddress | undefined,
  ): boolean {
    if (!reported) return false;
    if (!stored) return true;
    const norm = (v: string | null | undefined) =>
      (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    return (
      norm(stored.line1) !== norm(reported.street_address) ||
      norm(stored.city) !== norm(reported.city) ||
      norm(stored.postal_code).replace(/ /g, '') !==
        norm(reported.postal_code).replace(/ /g, '') ||
      norm(stored.country_code) !== norm(reported.country).slice(0, 2)
    );
  }

  // ── Kustom callbacks: address / shipping option ─────────────────────────

  /**
   * address_update and shipping_option_update share one handler: re-price
   * the snapshot for the reported destination and answer with the new
   * amounts and options. Database only — well inside Kustom's 10 s budget.
   * A session whose order is still awaiting payment is re-priced too; when
   * the total, the address or the shipping method moved, that order is
   * failed and unlinked so the next validation creates a fresh one.
   */
  private async handleCheckoutUpdate(
    sessionId: string,
    token: string,
    body: unknown,
  ): Promise<KustomCallbackResult> {
    const session = await this.loadSession(sessionId, token, 'callback');
    const ctx = await this.storeForSession(session);
    const reject = (error: string, reason?: string): KustomCallbackResult => ({
      ok: false,
      redirectUrl: this.redirectUrl(ctx, error, reason),
    });
    if (this.isExpired(session)) {
      return reject('kustom_validation', 'session_expired');
    }
    const pending = await this.pendingOrderOf(session);
    if (session.status !== 'open' && !pending) {
      return reject('kustom_validation', 'session_ordered');
    }

    const b = this.callbackBody(body);
    const country = this.countryOf(b) ?? session.country_code;
    const selectedId =
      typeof b.selected_shipping_option?.id === 'string'
        ? b.selected_shipping_option.id
        : session.shipping_method_id;

    let priced: PriceResult;
    try {
      priced = await this.priceSession(session, ctx, {
        countryCode: country,
        couponCode: session.coupon_code,
        selectedShippingId: selectedId,
      });
    } catch (err) {
      this.logger.warn(
        `Kustom session ${session.id}: re-pricing failed: ${this.describe(err)}`,
      );
      return reject('kustom_validation', this.reasonFor(err));
    }
    if (!priced.ok) return reject('shipping_unavailable');

    const amounts = buildKustomSessionAmounts(
      priced.priced.input,
      this.mapperContext(ctx, session, this.kustom.urls()),
    );

    if (pending) {
      const changed =
        expectedKustomAmount(pending) !== amounts.order_amount ||
        (pending.shipping_method_id ?? null) !==
          (priced.priced.selectedShippingId ?? null) ||
        this.addressChanged(
          pending.address,
          b.shipping_address ?? b.billing_address,
        );
      if (changed && !(await this.detachPendingOrder(session, pending.id))) {
        return reject('kustom_validation', 'session_ordered');
      }
    }

    await this.prisma.kustomCheckoutSession.updateMany({
      where: { id: session.id, status: 'open' },
      data: {
        country_code: country,
        shipping_method_id: priced.priced.selectedShippingId,
        shipping_cost: priced.priced.quote.shipping_cost,
      },
    });
    return { ok: true, body: amounts satisfies KustomCheckoutUpdateResponse };
  }

  handleAddressUpdate(sessionId: string, token: string, body: unknown) {
    return this.handleCheckoutUpdate(sessionId, token, body);
  }

  handleShippingOptionUpdate(sessionId: string, token: string, body: unknown) {
    return this.handleCheckoutUpdate(sessionId, token, body);
  }

  // ── Kustom callback: validation (creates the order) ─────────────────────

  /**
   * Kustom's last call before authorizing the money. Inside its 3 s budget:
   * re-price, resolve/create the customer, upsert the address and create the
   * order; everything else (emails) is deferred. Idempotent: an already
   * ordered session is approved again once its pending order still matches
   * the amount Kustom holds. Concurrent calls for one session are serialised
   * by an atomic status claim; a loser waits briefly for the winner.
   */
  async handleValidation(
    sessionId: string,
    token: string,
    body: unknown,
  ): Promise<KustomCallbackResult> {
    const session = await this.loadSession(sessionId, token, 'callback');
    const ctx = await this.storeForSession(session);
    const reject = (reason: string): KustomCallbackResult => ({
      ok: false,
      redirectUrl: this.redirectUrl(ctx, 'kustom_validation', reason),
    });

    if (session.status === 'ordered') {
      return this.revalidateOrdered(session, this.callbackBody(body), reject);
    }
    if (this.isExpired(session)) return reject('session_expired');
    if (!ctx.is_active) return reject('unavailable');

    const claim = await this.prisma.kustomCheckoutSession.updateMany({
      where: {
        id: session.id,
        OR: [
          { status: 'open' },
          {
            status: 'ordering',
            updated_at: { lt: new Date(Date.now() - ORDERING_STALE_MS) },
          },
        ],
      },
      data: { status: 'ordering' },
    });
    if (claim.count === 0) {
      const status = await this.awaitConcurrentValidation(session.id);
      if (status === 'ordered') return { ok: true, body: { ok: true } };
      return reject('unavailable');
    }

    let ordered = false;
    try {
      // 1. Recompute from the snapshot and compare with what Kustom holds.
      const b = this.callbackBody(body);
      const country = this.countryOf(b) ?? session.country_code;
      if (!country) return reject('unavailable');
      const selectedId =
        typeof b.selected_shipping_option?.id === 'string'
          ? b.selected_shipping_option.id
          : session.shipping_method_id;
      const priced = await this.priceSession(session, ctx, {
        countryCode: country,
        couponCode: session.coupon_code,
        selectedShippingId: selectedId,
      });
      if (!priced.ok) return reject('shipping_unavailable');
      const amounts = buildKustomSessionAmounts(
        priced.priced.input,
        this.mapperContext(ctx, session, this.kustom.urls()),
      );
      if (
        typeof b.order_amount !== 'number' ||
        b.order_amount !== amounts.order_amount ||
        (typeof b.purchase_currency === 'string' &&
          b.purchase_currency.toUpperCase() !== amounts.purchase_currency)
      ) {
        this.logger.warn(
          `Kustom session ${session.id}: amount ${String(b.order_amount)} ${String(b.purchase_currency)} != ${amounts.order_amount} ${amounts.purchase_currency}`,
        );
        return reject('amount_changed');
      }
      if (
        session.kustom_order_id &&
        typeof b.order_id === 'string' &&
        b.order_id !== session.kustom_order_id
      ) {
        return reject('unavailable');
      }

      // 2. The customer: the logged-in one, an existing account by email,
      //    or a new account for a guest.
      const resolved = await this.resolveCustomer(session, b);

      // 3. The shipping address, reusing an identical row.
      const address = await this.upsertAddress(
        resolved.customerId,
        b.shipping_address ?? b.billing_address,
        b.billing_address,
        resolved.created,
      );

      // 4. The order, from the snapshot — same pricing as the quote above,
      // with the shipping method the shopper picked in the iframe.
      // create() returns the shaped order (typed loosely); only the id and
      // the stored total are needed here.
      const created: unknown = await this.orders.create(
        resolved.userId,
        {
          address_id: address.id,
          store_id: session.store_id,
          payment_method: PaymentMethod.KUSTOM,
          coupon_code: session.coupon_code ?? undefined,
          notes: session.notes ?? undefined,
          shipping_method_id: priced.priced.selectedShippingId ?? undefined,
        },
        { lines: this.itemsOf(session) },
      );
      const order = created as { id: string; total: unknown; currency: string };

      // 5. From here on an order exists: whatever goes wrong must fail it
      //    (stock and coupon back) before the session is reopened, or the
      //    row stays awaiting_payment with nothing ever paying it.
      try {
        // The stored total is what push/confirmation will compare against;
        // it was priced by the same code, so a difference is a bug, not a
        // customer problem — never let Kustom authorize a mismatching amount.
        const storedMinor = expectedKustomAmount(order);
        if (storedMinor !== amounts.order_amount) {
          this.logger.error(
            `Kustom session ${session.id}: order ${order.id} total ${storedMinor} != session total ${amounts.order_amount}`,
          );
          await this.abandonOrder(order.id, STALE_ORDER_REASON);
          return reject('amount_changed');
        }

        await this.prisma.$transaction([
          this.prisma.order.update({
            where: { id: order.id },
            data: {
              kustom_order_id: session.kustom_order_id,
              kustom_push_token: session.callback_token,
            },
          }),
          this.prisma.kustomCheckoutSession.update({
            where: { id: session.id },
            data: {
              order_id: order.id,
              status: 'ordered',
              account_created: resolved.created,
              country_code: country,
              shipping_method_id: priced.priced.selectedShippingId,
              shipping_cost: priced.priced.quote.shipping_cost,
            },
          }),
        ]);
      } catch (err) {
        // A unique violation on kustom_order_id means a stale `ordering`
        // reclaim raced an earlier validation that already linked this
        // checkout to its own order: that order stands, this duplicate
        // must not.
        this.logger.error(
          `Kustom session ${session.id}: linking order ${order.id} failed${
            this.isUniqueViolation(err) ? ' (duplicate kustom_order_id)' : ''
          }: ${this.describe(err)}`,
        );
        await this.abandonOrder(order.id, STALE_ORDER_REASON);
        return reject('unavailable');
      }
      ordered = true;

      // 6. Welcome email for a freshly created account — off the callback.
      if (resolved.created) {
        const loginUrl = `${resolveStoreBase(
          this.kustom.urls().storefrontBase,
          ctx.slug,
          ctx.customDomain,
        )}/auth/login`;
        setImmediate(() => {
          void this.mail
            .sendWelcome(
              resolved.email,
              { name: resolved.firstName || undefined, loginUrl },
              session.locale ?? ctx.primaryLocale ?? undefined,
            )
            .catch((err: unknown) =>
              this.logger.warn(
                `Welcome email for ${resolved.email} failed: ${this.describe(err)}`,
              ),
            );
        });
      }
      return { ok: true, body: { ok: true } };
    } catch (err) {
      // Stock, coupon or any other failure before an order existed: reject
      // with a reason the storefront can explain.
      this.logger.warn(
        `Kustom session ${session.id}: validation rejected: ${this.describe(err)}`,
      );
      return reject(this.reasonFor(err));
    } finally {
      if (!ordered) {
        await this.prisma.kustomCheckoutSession.updateMany({
          where: { id: session.id, status: 'ordering' },
          data: { status: 'open' },
        });
      }
    }
  }

  /**
   * Validation for a session that already has an order. A settled order
   * (paid, or anything but awaiting payment) is approved again as before.
   * A pending one is approved only while the amount Kustom holds still
   * equals its stored total; otherwise it is failed and unlinked, the
   * session reopened, and Kustom told to reload — the next validation
   * creates a fresh order.
   */
  private async revalidateOrdered(
    session: Session,
    b: KustomCheckoutCallbackBody,
    reject: (reason: string) => KustomCallbackResult,
  ): Promise<KustomCallbackResult> {
    const pending = await this.pendingOrderOf(session);
    if (!pending) return { ok: true, body: { ok: true } };
    const storedMinor = expectedKustomAmount(pending);
    const currencyMatches =
      typeof b.purchase_currency !== 'string' ||
      b.purchase_currency.toUpperCase() === pending.currency.toUpperCase();
    if (
      typeof b.order_amount === 'number' &&
      b.order_amount === storedMinor &&
      currencyMatches
    ) {
      return { ok: true, body: { ok: true } };
    }
    this.logger.warn(
      `Kustom session ${session.id}: pending order ${pending.id} total ${storedMinor} != ${String(b.order_amount)} ${String(b.purchase_currency)}`,
    );
    // A paid order can only exist with a verified amount, so a failed detach
    // here means the order settled meanwhile: approve instead of rejecting.
    const detached = await this.detachPendingOrder(
      session,
      pending.id,
      REPLACED_ORDER_REASON,
    );
    if (!detached) return { ok: true, body: { ok: true } };
    return reject('amount_changed');
  }

  /**
   * Another validation holds the session: wait for it to finish rather than
   * failing the purchase outright. Returns the status seen last — `ordered`
   * when the other call succeeded, `open` when it gave up, `ordering` when it
   * is still running after the wait.
   */
  private async awaitConcurrentValidation(sessionId: string): Promise<string> {
    const deadline = Date.now() + CONCURRENT_VALIDATION_WAIT_MS;
    let status = 'ordering';
    for (;;) {
      const fresh = await this.prisma.kustomCheckoutSession.findUnique({
        where: { id: sessionId },
        select: { status: true },
      });
      status = fresh?.status ?? 'expired';
      if (status !== 'ordering' || Date.now() >= deadline) return status;
      await new Promise((resolve) =>
        setTimeout(resolve, CONCURRENT_VALIDATION_POLL_MS),
      );
    }
  }

  private callbackBody(body: unknown): KustomCheckoutCallbackBody {
    return (
      body && typeof body === 'object' ? body : {}
    ) as KustomCheckoutCallbackBody;
  }

  private countryOf(b: KustomCheckoutCallbackBody): string | null {
    const raw = b.shipping_address?.country ?? b.billing_address?.country;
    if (typeof raw !== 'string') return null;
    const country = raw.trim().toUpperCase().slice(0, 2);
    return /^[A-Z]{2}$/.test(country) ? country : null;
  }

  /** Storefront error reason for a failure inside validation. */
  private reasonFor(err: unknown): string {
    const code = this.codeOf(err);
    if (code === 'ORDER_INSUFFICIENT_STOCK') return 'out_of_stock';
    if (code?.startsWith('PROMOTION_COUPON_')) return 'coupon_invalid';
    if (code === 'ORDER_DISCOUNT_BELOW_PROVIDER_COST') return 'coupon_invalid';
    return 'unavailable';
  }

  private codeOf(err: unknown): string | null {
    if (!(err instanceof HttpException)) return null;
    const res = err.getResponse();
    const code = (res as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : null;
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    );
  }

  private describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  // ── Customer / address resolution ───────────────────────────────────────

  /**
   * The account the order belongs to. Guests get one created from the email
   * Kustom collected: role CUSTOMER, ACTIVE, with a random password hashed
   * with bcrypt (see GUEST_PASSWORD_BCRYPT_COST). No tokens are issued; the
   * shopper sets a password via "forgot password". An existing account is
   * attached only when it is a customer account — a creator, provider or
   * admin must not acquire orders through a guest checkout.
   */
  private async resolveCustomer(
    session: Session,
    b: KustomCheckoutCallbackBody,
  ): Promise<{
    userId: string;
    customerId: string;
    email: string;
    firstName: string;
    created: boolean;
  }> {
    const address = b.billing_address ?? b.shipping_address;
    const firstName = (address?.given_name ?? '').trim();
    const lastName = (address?.family_name ?? '').trim();
    const phone = (address?.phone ?? '').trim() || null;

    if (session.customer_id) {
      const customer = await this.prisma.customer.findUnique({
        where: { id: session.customer_id },
        select: { id: true, user: { select: { id: true, email: true } } },
      });
      if (customer) {
        return {
          userId: customer.user.id,
          customerId: customer.id,
          email: customer.user.email,
          firstName,
          created: false,
        };
      }
    }

    const email = normalizeEmail(
      b.billing_address?.email ?? b.shipping_address?.email ?? '',
    );
    if (!email) {
      throw new BadRequestException({
        code: 'KUSTOM_EMAIL_MISSING',
        message: 'Kustom did not report a customer email.',
      });
    }

    // Accounts are stored normalised, so the unique index answers first; the
    // case-insensitive fallback covers rows created before normalisation
    // (lower-cased by a separate one-off data migration).
    const userSelect = {
      id: true,
      email: true,
      role: true,
      customer: { select: { id: true } },
    } as const;
    const existing =
      (await this.prisma.user.findUnique({
        where: { email },
        select: userSelect,
      })) ??
      (await this.prisma.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } },
        select: userSelect,
      }));
    if (existing) {
      if (existing.role !== UserRole.CUSTOMER) {
        this.logger.warn(
          `Kustom session ${session.id}: ${existing.role} account ${existing.id} cannot check out as a guest`,
        );
        throw new BadRequestException({
          code: 'KUSTOM_ACCOUNT_UNAVAILABLE',
          message: 'This email belongs to an account that cannot place orders.',
        });
      }
      // A customer account without a profile (registered before profiles
      // existed) still gets one so it can order.
      const customer =
        existing.customer ??
        (await this.prisma.customer.create({
          data: {
            user_id: existing.id,
            first_name: firstName,
            last_name: lastName,
            ...(phone ? { phone } : {}),
          },
          select: { id: true },
        }));
      return {
        userId: existing.id,
        customerId: customer.id,
        email: existing.email,
        firstName,
        created: false,
      };
    }

    const password = randomBytes(24).toString('base64url').slice(0, 32);
    const password_hash = await bcrypt.hash(
      password,
      GUEST_PASSWORD_BCRYPT_COST,
    );
    const user = await this.prisma.user.create({
      data: {
        email,
        password_hash,
        role: UserRole.CUSTOMER,
        status: 'ACTIVE',
        customer: {
          create: {
            first_name: firstName,
            last_name: lastName,
            ...(phone ? { phone } : {}),
          },
        },
      },
      select: { id: true, email: true, customer: { select: { id: true } } },
    });
    return {
      userId: user.id,
      customerId: user.customer!.id,
      email: user.email,
      firstName,
      created: true,
    };
  }

  /**
   * Address row for the order; an identical existing row is reused. Only a
   * freshly created account gets the row as its default address — an
   * existing account keeps whatever default it chose.
   */
  private async upsertAddress(
    customerId: string,
    shipping: KustomAddress | undefined,
    billing: KustomAddress | undefined,
    freshAccount: boolean,
  ): Promise<{ id: string }> {
    const a = shipping ?? billing;
    if (!a?.street_address || !a.city || !a.postal_code || !a.country) {
      throw new BadRequestException({
        code: 'KUSTOM_ADDRESS_INCOMPLETE',
        message: 'Kustom did not report a complete shipping address.',
      });
    }
    const fullName =
      [a.given_name, a.family_name].filter(Boolean).join(' ').trim() ||
      [billing?.given_name, billing?.family_name]
        .filter(Boolean)
        .join(' ')
        .trim() ||
      'Customer';
    const data = {
      customer_id: customerId,
      label: 'Kustom',
      full_name: fullName,
      line1: a.street_address,
      line2: a.street_address2 || null,
      city: a.city,
      state: a.region || null,
      postal_code: a.postal_code,
      country_code: a.country.toUpperCase().slice(0, 2),
      phone: a.phone || billing?.phone || null,
    };
    const existing = await this.prisma.address.findFirst({
      where: {
        customer_id: data.customer_id,
        full_name: data.full_name,
        line1: data.line1,
        line2: data.line2,
        city: data.city,
        postal_code: data.postal_code,
        country_code: data.country_code,
      },
      select: { id: true },
    });
    if (existing) return existing;
    return this.prisma.address.create({
      data: { ...data, is_default: freshAccount },
      select: { id: true },
    });
  }

  // ── Push / confirmation ─────────────────────────────────────────────────

  /**
   * Push for a session: resolve the order and hand over to the existing
   * verified path (the order's push token is the session's callback token).
   * Before validation has created the order there is nothing to mark paid —
   * answer 503 so Kustom retries later.
   */
  async handlePush(sessionId: string, token: string, kustomOrderId: string) {
    const session = await this.loadSession(sessionId, token, 'callback');
    if (!session.order_id) {
      throw new ServiceUnavailableException('Order not created yet');
    }
    return this.kustom.handlePush(session.order_id, token, kustomOrderId);
  }

  /** Confirmation page (guest-safe: the storefront token is the credential). */
  async getConfirmation(sessionId: string, token: string) {
    const session = await this.loadSession(sessionId, token, 'storefront');
    if (!session.order_id) {
      throw new ConflictException({
        code: 'KUSTOM_SESSION_NOT_ORDERED',
        message: 'The purchase has not been confirmed yet.',
      });
    }
    const result = await this.kustom.confirmOrder(session.order_id);
    const order = await this.prisma.order.findUnique({
      where: { id: session.order_id },
      select: { customer: { select: { user: { select: { email: true } } } } },
    });
    return {
      ...result,
      account_created: session.account_created,
      customer_email: order?.customer.user.email ?? null,
    };
  }
}
