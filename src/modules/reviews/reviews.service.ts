import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  ProductReviewStatus,
  StoreType,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { TurnstileService } from '../../common/security/turnstile.service';
import { storeCaptchaHosts } from '../../common/security/store-captcha-hosts';
import {
  assertCustomerStore,
  customerStoreMismatch,
} from '../../common/customers/customer-store';
import type { RequestUser } from '../../common/decorators';
import { resolveProductTargetBySlug } from '../storefront/storefront.service';
import {
  REVIEW_LINK_INVALID,
  ReviewLinkTokenService,
  type VerifiedReviewLink,
} from './review-link-token.service';
import {
  eligibleLineQuery,
  isReviewEligibleOrder,
  orderBlocksApproval,
  reviewTargetColumns,
  reviewTargetWhere,
  type ReviewTarget,
} from './review-eligibility';
import {
  REVIEWS_MAX_PAGE,
  REVIEWS_PAGE_SIZE,
  displayNameSuggestion,
  normalizeReviewInput,
  normalizeReviewReply,
  type NormalizedReview,
} from './review-text';
import { normalizeReviewsSettings } from './reviews-settings';
import {
  ownReviewSelect,
  ownerReviewSelect,
  pickTranslation,
  productImageUrl,
  publicReviewSelect,
  reviewCustomProductSelect,
  reviewProductSelect,
  summarize,
  toOwnReview,
  toOwnerReview,
  toPublicReview,
  type OrderReviewItems,
  type OwnerReview,
  type OwnerReviewsPage,
  type PublicReviewsPage,
  type ReviewEligibility,
  type ReviewLinkContext,
  type ReviewLinkRow,
  type SubmitReviewResult,
} from './reviews.types';
import type { LinkReviewDto, SubmitReviewDto } from './dto/submit-review.dto';
import type { OwnerReviewsQueryDto } from './dto/owner-review.dto';

/**
 * Product reviews (M171, store app `reviews`).
 *
 * Only verified buyers write: a customer of the store with a paid, real
 * order holding the product (review-eligibility.ts). Two entry paths: the
 * signed-in customer, and a signed review link bound to one order line. The
 * store owner moderates (approve / reject / reply / delete) but can never
 * create a review or edit its rating or text.
 *
 * Every read / write is scoped: storefront routes by the store of the slug
 * (RequireAppGuard), customer routes by the customer of the token inside
 * that store, owner routes by the store of the creator's JWT, and every
 * lookup by review id carries `store_id` in the same `where`.
 */

export const REVIEWS_APP_KEY = 'reviews' as const;

/** How a review reached us. */
export type ReviewSource = 'ACCOUNT' | 'LINK';

/** Owner list defaults. */
const OWNER_PAGE_LIMIT = 25;
const OWNER_PAGE_LIMIT_MAX = 100;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const errors = {
  storeNotFound: () =>
    new NotFoundException({
      code: 'STORE_NOT_FOUND',
      message: 'Store not found',
    }),
  storefrontProductNotFound: () =>
    new NotFoundException({
      code: 'STOREFRONT_PRODUCT_NOT_FOUND',
      message: 'Product not found',
    }),
  productNotFound: () =>
    new NotFoundException({
      code: 'REVIEW_PRODUCT_NOT_FOUND',
      message: 'This product cannot be reviewed in this store.',
    }),
  notPurchased: () =>
    new ForbiddenException({
      code: 'REVIEW_NOT_PURCHASED',
      message: 'Only customers who bought this product can review it.',
    }),
  orderNotEligible: () =>
    new ConflictException({
      code: 'REVIEW_ORDER_NOT_ELIGIBLE',
      message:
        'This order cannot be reviewed (unpaid, cancelled, refunded or a test order).',
    }),
  orderNotFound: () =>
    new NotFoundException({
      code: 'ORDER_NOT_FOUND',
      message: 'Order not found',
    }),
  reviewNotFound: () =>
    new NotFoundException({
      code: 'REVIEW_NOT_FOUND',
      message: 'Review not found',
    }),
  notEnabled: () =>
    new ConflictException({
      code: 'REVIEWS_NOT_ENABLED',
      message: 'The reviews app is not enabled for this store.',
    }),
  changed: () =>
    new ConflictException({
      code: 'REVIEW_CHANGED',
      message: 'This review changed since it was opened. Read it again.',
    }),
  linkInvalid: () => new UnauthorizedException(REVIEW_LINK_INVALID),
};

/**
 * The `updated_at` the moderator's screen showed, as sent with a moderation
 * call. Anything that is not a date reads as "changed" (409 REVIEW_CHANGED),
 * so a decision is never applied to a text the owner did not see.
 */
function expectedVersion(raw: unknown): Date {
  const date = typeof raw === 'string' && raw ? new Date(raw) : null;
  if (!date || Number.isNaN(date.getTime())) throw errors.changed();
  return date;
}

/** The store facts every path needs. */
const storeScopeSelect = {
  id: true,
  slug: true,
  creator_id: true,
  store_type: true,
  custom_domain: true,
  language_config: { select: { primary_locale: true } },
} satisfies Prisma.StoreSelect;

type StoreScope = Prisma.StoreGetPayload<{ select: typeof storeScopeSelect }>;

/** The order columns the eligibility rule reads. */
const orderFactsSelect = {
  id: true,
  store_id: true,
  status: true,
  payment_status: true,
  payment_method: true,
  is_test: true,
  deleted_at: true,
} satisfies Prisma.OrderSelect;

/** An order line with the owner of what it sold. */
const orderLineSelect = {
  id: true,
  product_id: true,
  custom_product_id: true,
  product: { select: { creator_id: true } },
  custom_product: { select: { creator_id: true } },
} satisfies Prisma.OrderItemSelect;

type OrderLine = Prisma.OrderItemGetPayload<{ select: typeof orderLineSelect }>;

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

/** A filled honeypot gets a normal-looking answer and stores nothing. */
function honeypotTripped(website: string | undefined): boolean {
  return typeof website === 'string' && website.trim() !== '';
}

const HONEYPOT_ANSWER: SubmitReviewResult = {
  id: null,
  status: ProductReviewStatus.PENDING,
};

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storeApps: StoreAppsService,
    private readonly revalidation: RevalidationService,
    private readonly tokens: ReviewLinkTokenService,
    private readonly config: ConfigService,
    @Optional() private readonly turnstile?: TurnstileService,
  ) {}

  // -- Scopes ----------------------------------------------------------------

  private async storeById(storeId: string): Promise<StoreScope> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: storeScopeSelect,
    });
    if (!store) throw errors.storeNotFound();
    return store;
  }

  /** The store of the signed-in creator (never a store id from the request). */
  private async storeOfOwner(userId: string): Promise<StoreScope> {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { store: { select: storeScopeSelect } },
    });
    if (!creator?.store) throw errors.storeNotFound();
    return creator.store;
  }

  /**
   * The customer record of the signed-in user inside `storeId`: an ACTIVE
   * CUSTOMER account of that very store. 403 CUSTOMER_STORE_MISMATCH for an
   * account of another store.
   */
  private async customerOf(user: RequestUser, storeId: string) {
    assertCustomerStore(user, storeId);
    const customer = await this.prisma.customer.findFirst({
      where: {
        user_id: user.id,
        user: {
          role: UserRole.CUSTOMER,
          store_id: storeId,
          status: UserStatus.ACTIVE,
        },
      },
      select: { id: true, first_name: true, last_name: true },
    });
    if (!customer) throw customerStoreMismatch();
    return customer;
  }

  /**
   * A storefront product id as a review target of this store: the creator's
   * own product, or (non-INDEPENDENT stores) one of the creator's custom
   * products. 404 REVIEW_PRODUCT_NOT_FOUND otherwise.
   */
  private async targetById(
    store: StoreScope,
    productId: string,
  ): Promise<ReviewTarget> {
    const own = await this.prisma.product.findFirst({
      where: { id: productId, creator_id: store.creator_id },
      select: { id: true },
    });
    if (own) return { kind: 'product', id: own.id };
    if (store.store_type !== StoreType.INDEPENDENT) {
      const custom = await this.prisma.customProduct.findFirst({
        where: { id: productId, creator_id: store.creator_id },
        select: { id: true },
      });
      if (custom) return { kind: 'custom_product', id: custom.id };
    }
    throw errors.productNotFound();
  }

  /** The target an order line sold, when it still belongs to the store. */
  private targetOfLine(
    store: StoreScope,
    line: OrderLine,
  ): ReviewTarget | null {
    if (line.custom_product_id) {
      return store.store_type !== StoreType.INDEPENDENT &&
        line.custom_product?.creator_id === store.creator_id
        ? { kind: 'custom_product', id: line.custom_product_id }
        : null;
    }
    if (line.product_id) {
      return line.product?.creator_id === store.creator_id
        ? { kind: 'product', id: line.product_id }
        : null;
    }
    return null;
  }

  /** One line per distinct product of an order (the first line of each). */
  private distinctLines(
    store: StoreScope,
    lines: readonly OrderLine[],
  ): { order_item_id: string; target: ReviewTarget }[] {
    const seen = new Set<string>();
    const out: { order_item_id: string; target: ReviewTarget }[] = [];
    for (const line of lines) {
      const target = this.targetOfLine(store, line);
      if (!target) continue;
      const key = `${target.kind}:${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ order_item_id: line.id, target });
    }
    return out;
  }

  /** Review status per target for one customer (one query). */
  private async statusByTarget(
    storeId: string,
    customerId: string,
    targets: readonly ReviewTarget[],
  ): Promise<Map<string, ProductReviewStatus>> {
    const map = new Map<string, ProductReviewStatus>();
    if (targets.length === 0) return map;
    const ids = (kind: ReviewTarget['kind']) =>
      targets.filter((t) => t.kind === kind).map((t) => t.id);
    const rows = await this.prisma.productReview.findMany({
      where: {
        store_id: storeId,
        customer_id: customerId,
        OR: [
          { product_id: { in: ids('product') } },
          { custom_product_id: { in: ids('custom_product') } },
        ],
      },
      select: { product_id: true, custom_product_id: true, status: true },
    });
    for (const row of rows) {
      const key = row.custom_product_id
        ? `custom_product:${row.custom_product_id}`
        : `product:${row.product_id}`;
      map.set(key, row.status);
    }
    return map;
  }

  /** Asks the storefront to refresh the store (never throws). */
  private async revalidate(storeId: string, onlyIfAppOn: boolean) {
    try {
      if (
        onlyIfAppOn &&
        !(await this.storeApps.isEnabled(storeId, REVIEWS_APP_KEY))
      ) {
        // App off: the storefront shows no reviews, and switching the app on
        // revalidates by itself.
        return;
      }
      await this.revalidation.revalidateStoreById(storeId);
    } catch (err) {
      this.logger.warn(
        `Review revalidation failed for store ${storeId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // -- Public read -----------------------------------------------------------

  /**
   * GET /storefront/:slug/products/:productSlug/reviews. APPROVED reviews of
   * the product the product page resolves for this slug, newest first, with
   * the rating summary. A page past the end answers an empty `items`.
   */
  async publicList(
    storeId: string,
    productSlug: string,
    page: number,
  ): Promise<PublicReviewsPage> {
    const store = await this.storeById(storeId);
    const target = await resolveProductTargetBySlug(
      this.prisma,
      store,
      productSlug,
    );
    if (!target) throw errors.storefrontProductNotFound();

    const where = {
      store_id: store.id,
      ...reviewTargetWhere(target),
      status: ProductReviewStatus.APPROVED,
    } satisfies Prisma.ProductReviewWhereInput;
    const [groups, rows] = await Promise.all([
      this.prisma.productReview.groupBy({
        by: ['rating'],
        where,
        _count: { _all: true },
      }),
      this.prisma.productReview.findMany({
        where,
        orderBy: [{ published_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * REVIEWS_PAGE_SIZE,
        take: REVIEWS_PAGE_SIZE,
        select: publicReviewSelect,
      }),
    ]);
    const summary = summarize(
      groups.map((g) => ({ rating: g.rating, count: g._count._all })),
    );
    return {
      summary,
      items: rows.map(toPublicReview),
      page,
      total: summary.count,
      // Capped at the highest page the read accepts (parseReviewsPage), so
      // the pagination never links to a page that would answer page 1.
      total_pages: Math.min(
        Math.ceil(summary.count / REVIEWS_PAGE_SIZE),
        REVIEWS_MAX_PAGE,
      ),
    };
  }

  // -- Signed-in customer ----------------------------------------------------

  /** GET reviews/mine/eligibility: may I review this product, and my review. */
  async eligibility(
    user: RequestUser,
    storeId: string,
    productId: string,
  ): Promise<ReviewEligibility> {
    const customer = await this.customerOf(user, storeId);
    const store = await this.storeById(storeId);
    if (!UUID_RE.test(productId ?? '')) throw errors.productNotFound();
    const target = await this.targetById(store, productId);
    const [order, review] = await Promise.all([
      this.prisma.order.findFirst(
        eligibleLineQuery(store.id, customer.id, target),
      ),
      this.prisma.productReview.findFirst({
        where: {
          store_id: store.id,
          customer_id: customer.id,
          ...reviewTargetWhere(target),
        },
        select: ownReviewSelect,
      }),
    ]);
    const eligible = !!order?.items[0];
    return {
      eligible,
      reason: eligible ? null : 'NOT_PURCHASED',
      display_name_suggestion: displayNameSuggestion(
        customer.first_name,
        customer.last_name,
      ),
      review: review ? toOwnReview(review) : null,
    };
  }

  /**
   * GET reviews/mine/orders/:orderId: the lines of my order I can review,
   * one entry per distinct product. 404 ORDER_NOT_FOUND for an order of
   * someone else, of another store, or an unknown id (one answer).
   */
  async myOrderItems(
    user: RequestUser,
    storeId: string,
    orderId: string,
  ): Promise<OrderReviewItems> {
    const customer = await this.customerOf(user, storeId);
    const store = await this.storeById(storeId);
    if (!UUID_RE.test(orderId ?? '')) throw errors.orderNotFound();
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customer_id: customer.id, store_id: store.id },
      select: {
        ...orderFactsSelect,
        items: { orderBy: { id: 'asc' }, select: orderLineSelect },
      },
    });
    if (!order) throw errors.orderNotFound();
    const lines = this.distinctLines(store, order.items);
    const statuses = await this.statusByTarget(
      store.id,
      customer.id,
      lines.map((l) => l.target),
    );
    return {
      eligible: isReviewEligibleOrder(order, store.id),
      items: lines.map((l) => ({
        order_item_id: l.order_item_id,
        product_id: l.target.id,
        review_status: statuses.get(`${l.target.kind}:${l.target.id}`) ?? null,
      })),
    };
  }

  /** PUT reviews/mine: create or replace my review of a product I bought. */
  async submitMine(
    user: RequestUser,
    storeId: string,
    dto: SubmitReviewDto,
  ): Promise<SubmitReviewResult> {
    const customer = await this.customerOf(user, storeId);
    if (honeypotTripped(dto.website)) return HONEYPOT_ANSWER;
    const input = normalizeReviewInput(dto);
    const store = await this.storeById(storeId);
    const target = await this.targetById(store, dto.product_id);
    const order = await this.prisma.order.findFirst(
      eligibleLineQuery(store.id, customer.id, target),
    );
    const line = order?.items[0];
    if (!order || !line) throw errors.notPurchased();
    return this.save({
      storeId: store.id,
      customerId: customer.id,
      target,
      orderId: order.id,
      orderItemId: line.id,
      source: 'ACCOUNT',
      input,
    });
  }

  /** DELETE reviews/mine/:id: remove my own review. */
  async deleteMine(
    user: RequestUser,
    storeId: string,
    reviewId: string,
  ): Promise<{ deleted: true }> {
    const customer = await this.customerOf(user, storeId);
    const where = {
      id: reviewId,
      store_id: storeId,
      customer_id: customer.id,
    } satisfies Prisma.ProductReviewWhereInput;
    const review = UUID_RE.test(reviewId ?? '')
      ? await this.prisma.productReview.findFirst({
          where,
          select: {
            id: true,
            status: true,
            product_id: true,
            custom_product_id: true,
          },
        })
      : null;
    if (!review) throw errors.reviewNotFound();
    // A review that was waiting for (or refused by) the moderator leaves a
    // hold behind: deleting and writing it again is not a way around
    // moderation in a store that publishes automatically.
    if (
      review.status === ProductReviewStatus.REJECTED ||
      (review.status === ProductReviewStatus.PENDING &&
        (await this.autoPublish(storeId)))
    ) {
      await this.placeHold(storeId, customer.id, review);
    }
    await this.prisma.productReview.deleteMany({ where });
    if (review.status === ProductReviewStatus.APPROVED) {
      await this.revalidate(storeId, false);
    }
    return { deleted: true };
  }

  // -- Review link -----------------------------------------------------------

  /**
   * Everything a review link stands for, re-read from the database on every
   * use. Any mismatch between the token and the database is the same 401
   * REVIEW_LINK_INVALID (ids cannot be probed); 409 REVIEW_ORDER_NOT_ELIGIBLE
   * and 404 REVIEW_PRODUCT_NOT_FOUND are reachable only with a valid
   * signature.
   */
  private async resolveLink(storeId: string, token: string) {
    const claims: VerifiedReviewLink = await this.tokens.verify(token);
    if (claims.storeId !== storeId) throw errors.linkInvalid();
    const line = await this.prisma.orderItem.findFirst({
      where: {
        id: claims.orderItemId,
        order_id: claims.orderId,
        order: {
          store_id: storeId,
          customer: {
            user_id: claims.userId,
            user: {
              role: UserRole.CUSTOMER,
              store_id: storeId,
              status: UserStatus.ACTIVE,
            },
          },
        },
      },
      select: {
        ...orderLineSelect,
        order: {
          select: {
            ...orderFactsSelect,
            customer: {
              select: { id: true, first_name: true, last_name: true },
            },
          },
        },
      },
    });
    if (!line) throw errors.linkInvalid();
    if (!isReviewEligibleOrder(line.order, storeId)) {
      throw errors.orderNotEligible();
    }
    const store = await this.storeById(storeId);
    const target = this.targetOfLine(store, line);
    if (!target) throw errors.productNotFound();
    return { claims, store, target, line, customer: line.order.customer };
  }

  /** POST reviews/link/context: what the form of a review link shows. */
  async linkContext(
    storeId: string,
    token: string,
  ): Promise<ReviewLinkContext> {
    const link = await this.resolveLink(storeId, token);
    const [product, review] = await Promise.all([
      link.target.kind === 'product'
        ? this.prisma.product.findFirst({
            where: { id: link.target.id, creator_id: link.store.creator_id },
            select: reviewProductSelect,
          })
        : this.prisma.customProduct.findFirst({
            where: { id: link.target.id, creator_id: link.store.creator_id },
            select: reviewCustomProductSelect,
          }),
      this.prisma.productReview.findFirst({
        where: {
          store_id: link.store.id,
          customer_id: link.customer.id,
          ...reviewTargetWhere(link.target),
        },
        select: ownReviewSelect,
      }),
    ]);
    if (!product) throw errors.productNotFound();
    return {
      product: {
        id: product.id,
        translations: product.translations.map((t) => ({
          locale: t.locale,
          title: t.title,
          slug: t.slug,
        })),
        image_url: productImageUrl(product),
      },
      display_name_suggestion: displayNameSuggestion(
        link.customer.first_name,
        link.customer.last_name,
      ),
      review: review
        ? {
            rating: review.rating,
            title: review.title,
            body: review.body,
            display_name: review.display_name,
            status: review.status,
          }
        : null,
      expires_at: link.claims.expiresAt,
    };
  }

  /** PUT reviews/link: create or replace the review of the link's order line. */
  async submitLink(
    storeId: string,
    dto: LinkReviewDto,
    meta: { ip: string | null },
  ): Promise<SubmitReviewResult> {
    if (honeypotTripped(dto.website)) return HONEYPOT_ANSWER;
    const link = await this.resolveLink(storeId, dto.token);
    // Text rules before the captcha: a rejected text must not burn the
    // (single-use) captcha answer of a real person.
    const input = normalizeReviewInput(dto);
    if (this.turnstile?.customersEnabled) {
      await this.turnstile.verifyCustomer(
        dto.turnstile_token,
        meta.ip,
        await storeCaptchaHosts(this.prisma, storeId),
      );
    }
    return this.save({
      storeId,
      customerId: link.customer.id,
      target: link.target,
      orderId: link.line.order.id,
      orderItemId: link.line.id,
      source: 'LINK',
      input,
    });
  }

  // -- Write (shared by both paths) -----------------------------------------

  private findOwn(customerId: string, target: ReviewTarget) {
    return this.prisma.productReview.findFirst({
      where: { customer_id: customerId, ...reviewTargetWhere(target) },
      select: {
        id: true,
        status: true,
        rating: true,
        title: true,
        body: true,
        display_name: true,
        published_at: true,
        order_item_id: true,
        moderated_by: true,
      },
    });
  }

  // -- Moderation hold -------------------------------------------------------

  /**
   * Marks customer + product as "moderation required" (ProductReviewHold):
   * the next review of that pair is created PENDING whatever `auto_publish`
   * says. Idempotent (one hold per pair).
   */
  private async placeHold(
    storeId: string,
    customerId: string,
    row: { product_id: string | null; custom_product_id: string | null },
  ): Promise<void> {
    try {
      await this.prisma.productReviewHold.create({
        data: {
          store_id: storeId,
          customer_id: customerId,
          product_id: row.product_id,
          custom_product_id: row.custom_product_id,
        },
        select: { id: true },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }

  private async hasHold(
    customerId: string,
    target: ReviewTarget,
  ): Promise<boolean> {
    const hold = await this.prisma.productReviewHold.findFirst({
      where: { customer_id: customerId, ...reviewTargetWhere(target) },
      select: { id: true },
    });
    return !!hold;
  }

  /**
   * One review per customer and product. A first submission creates it; a
   * later one replaces rating / text / name / locale / order line / source
   * and clears the moderation marks and the owner reply (it answered the
   * previous text). A resubmission with the same rating, title, text and
   * name is a no-op, so a published review cannot be pulled or re-dated by
   * sending it again. `published_at` is the first approval and never moves
   * afterwards.
   *
   * `auto_publish` never overrides the moderator: it publishes a first
   * review (unless a hold says the pair needs moderation) and keeps an
   * APPROVED review public when it is edited. A REJECTED or PENDING review
   * that is edited always waits as PENDING for the owner.
   */
  private async save(args: {
    storeId: string;
    customerId: string;
    target: ReviewTarget;
    orderId: string;
    orderItemId: string;
    source: ReviewSource;
    input: NormalizedReview;
  }): Promise<SubmitReviewResult> {
    const existing = await this.findOwn(args.customerId, args.target);
    if (existing) return this.replace(existing, args);

    const autoPublish =
      (await this.autoPublish(args.storeId)) &&
      !(await this.hasHold(args.customerId, args.target));
    const status = autoPublish
      ? ProductReviewStatus.APPROVED
      : ProductReviewStatus.PENDING;
    try {
      const created = await this.prisma.productReview.create({
        data: {
          store_id: args.storeId,
          customer_id: args.customerId,
          ...reviewTargetColumns(args.target),
          order_id: args.orderId,
          order_item_id: args.orderItemId,
          verified_purchase: true,
          ...args.input,
          status,
          source: args.source,
          published_at: autoPublish ? new Date() : null,
        },
        select: { id: true, status: true },
      });
      if (created.status === ProductReviewStatus.APPROVED) {
        await this.revalidate(args.storeId, false);
      }
      return { id: created.id, status: created.status };
    } catch (err) {
      // Two first submissions at once: the loser of the unique index edits
      // the winner's row instead.
      if (!isUniqueViolation(err)) throw err;
      const raced = await this.findOwn(args.customerId, args.target);
      if (!raced) throw err;
      return this.replace(raced, args);
    }
  }

  private async replace(
    existing: NonNullable<Awaited<ReturnType<ReviewsService['findOwn']>>>,
    args: Parameters<ReviewsService['save']>[0],
  ): Promise<SubmitReviewResult> {
    const { input } = args;
    const unchanged =
      existing.rating === input.rating &&
      (existing.title ?? null) === input.title &&
      existing.body === input.body &&
      existing.display_name === input.display_name;
    if (unchanged) return this.refreshOrderLink(existing, args);

    // Only a review that is public right now may stay public by itself.
    const autoPublish =
      existing.status === ProductReviewStatus.APPROVED &&
      (await this.autoPublish(args.storeId));
    const status = autoPublish
      ? ProductReviewStatus.APPROVED
      : ProductReviewStatus.PENDING;
    await this.prisma.productReview.updateMany({
      where: { id: existing.id, customer_id: args.customerId },
      data: {
        order_id: args.orderId,
        order_item_id: args.orderItemId,
        verified_purchase: true,
        ...input,
        status,
        source: args.source,
        moderated_at: null,
        moderated_by: null,
        reply_body: null,
        replied_at: null,
        ...(autoPublish && !existing.published_at
          ? { published_at: new Date() }
          : {}),
      },
    });
    if (
      existing.status === ProductReviewStatus.APPROVED ||
      status === ProductReviewStatus.APPROVED
    ) {
      await this.revalidate(args.storeId, false);
    }
    return { id: existing.id, status };
  }

  /**
   * A resubmission with the same content. Nothing changes while the review
   * still points at the order line of this submission. When the eligible
   * purchase is another line (the linked order was trashed or flagged as a
   * test, and the customer bought the product again), the link moves to it,
   * and a review that was hidden for its order (REJECTED without a
   * moderator) goes back to PENDING so the owner can approve it. A
   * moderator's REJECTED stays REJECTED.
   */
  private async refreshOrderLink(
    existing: NonNullable<Awaited<ReturnType<ReviewsService['findOwn']>>>,
    args: Parameters<ReviewsService['save']>[0],
  ): Promise<SubmitReviewResult> {
    if (existing.order_item_id === args.orderItemId) {
      return { id: existing.id, status: existing.status };
    }
    const reopen =
      existing.status === ProductReviewStatus.REJECTED &&
      existing.moderated_by === null;
    const status = reopen ? ProductReviewStatus.PENDING : existing.status;
    await this.prisma.productReview.updateMany({
      where: { id: existing.id, customer_id: args.customerId },
      data: {
        order_id: args.orderId,
        order_item_id: args.orderItemId,
        verified_purchase: true,
        ...(reopen ? { status, moderated_at: null } : {}),
      },
    });
    return { id: existing.id, status };
  }

  /** The store's `auto_publish` setting, read at submit time only. */
  private async autoPublish(storeId: string): Promise<boolean> {
    const settings = await this.storeApps.getSettings(storeId, REVIEWS_APP_KEY);
    return normalizeReviewsSettings(settings).auto_publish;
  }

  // -- Owner -----------------------------------------------------------------

  private primaryLocale(store: StoreScope): string | null {
    return store.language_config?.primary_locale ?? null;
  }

  /** GET /stores/my/reviews: the store's reviews with filters and counts. */
  async ownerList(
    userId: string,
    query: OwnerReviewsQueryDto,
  ): Promise<OwnerReviewsPage> {
    const store = await this.storeOfOwner(userId);
    const status = (Object.values(ProductReviewStatus) as string[]).includes(
      query.status ?? '',
    )
      ? (query.status as ProductReviewStatus)
      : undefined;
    const rating = /^[1-5]$/.test(query.rating ?? '')
      ? Number(query.rating)
      : undefined;
    const productId = UUID_RE.test(query.product_id ?? '')
      ? query.product_id
      : undefined;
    const intOf = (raw: string | undefined, def: number, max: number) => {
      if (!raw || !/^\d{1,6}$/.test(raw)) return def;
      const n = Number(raw);
      return n >= 1 ? Math.min(n, max) : def;
    };
    const page = intOf(query.page, 1, 100000);
    const limit = intOf(query.limit, OWNER_PAGE_LIMIT, OWNER_PAGE_LIMIT_MAX);

    // The status tabs count within the rating / product filters.
    const scope = {
      store_id: store.id,
      ...(rating ? { rating } : {}),
      ...(productId
        ? {
            OR: [{ product_id: productId }, { custom_product_id: productId }],
          }
        : {}),
    } satisfies Prisma.ProductReviewWhereInput;
    const where = {
      ...scope,
      ...(status ? { status } : {}),
    } satisfies Prisma.ProductReviewWhereInput;

    const [rows, total, groups] = await Promise.all([
      this.prisma.productReview.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: ownerReviewSelect,
      }),
      this.prisma.productReview.count({ where }),
      this.prisma.productReview.groupBy({
        by: ['status'],
        where: scope,
        _count: { _all: true },
      }),
    ]);
    const counts: Record<ProductReviewStatus, number> = {
      PENDING: 0,
      APPROVED: 0,
      REJECTED: 0,
    };
    for (const g of groups) counts[g.status] = g._count._all;
    const locale = this.primaryLocale(store);
    return {
      items: rows.map((row) => toOwnerReview(row, locale)),
      total,
      page,
      limit,
      counts,
    };
  }

  /** GET /stores/my/reviews/pending-count (nav badge). */
  async pendingCount(userId: string): Promise<{ count: number }> {
    const store = await this.storeOfOwner(userId);
    const count = await this.prisma.productReview.count({
      where: { store_id: store.id, status: ProductReviewStatus.PENDING },
    });
    return { count };
  }

  /** A review of MY store by id (404 REVIEW_NOT_FOUND for any other). */
  private async ownerRow(store: StoreScope, reviewId: string) {
    const row = UUID_RE.test(reviewId ?? '')
      ? await this.prisma.productReview.findFirst({
          where: { id: reviewId, store_id: store.id },
          select: {
            id: true,
            status: true,
            published_at: true,
            reply_body: true,
            updated_at: true,
            customer_id: true,
            product_id: true,
            custom_product_id: true,
            order: { select: { is_test: true, deleted_at: true } },
          },
        })
      : null;
    if (!row) throw errors.reviewNotFound();
    return row;
  }

  private async ownerView(
    store: StoreScope,
    reviewId: string,
  ): Promise<OwnerReview> {
    const row = await this.prisma.productReview.findFirst({
      where: { id: reviewId, store_id: store.id },
      select: ownerReviewSelect,
    });
    if (!row) throw errors.reviewNotFound();
    return toOwnerReview(row, this.primaryLocale(store));
  }

  /**
   * PATCH /stores/my/reviews/:id/status. Approving needs a linked order that
   * is still a real purchase (not test, not trashed): 409
   * REVIEW_ORDER_NOT_ELIGIBLE otherwise.
   *
   * `expectedUpdatedAt` is the `updated_at` of the row the owner read: when
   * the review changed since (the customer edited it), nothing is written
   * and the answer is 409 REVIEW_CHANGED. The version is part of the UPDATE
   * itself, so an edit landing between the read and the write also loses.
   */
  async setStatus(
    userId: string,
    reviewId: string,
    status: 'APPROVED' | 'REJECTED',
    expectedUpdatedAt: unknown,
  ): Promise<OwnerReview> {
    const store = await this.storeOfOwner(userId);
    const row = await this.ownerRow(store, reviewId);
    const expected = expectedVersion(expectedUpdatedAt);
    if (row.updated_at.getTime() !== expected.getTime()) throw errors.changed();
    if (row.status === status) return this.ownerView(store, row.id);
    if (
      status === ProductReviewStatus.APPROVED &&
      orderBlocksApproval(row.order)
    ) {
      throw errors.orderNotEligible();
    }
    const now = new Date();
    const written = await this.prisma.productReview.updateMany({
      where: { id: row.id, store_id: store.id, updated_at: expected },
      data: {
        status,
        moderated_at: now,
        moderated_by: userId,
        ...(status === ProductReviewStatus.APPROVED && !row.published_at
          ? { published_at: now }
          : {}),
      },
    });
    if (written.count === 0) throw errors.changed();
    if (status === ProductReviewStatus.APPROVED) {
      // The owner trusts this customer's review of the product again.
      await this.prisma.productReviewHold.deleteMany({
        where: {
          store_id: store.id,
          customer_id: row.customer_id,
          product_id: row.product_id,
          custom_product_id: row.custom_product_id,
        },
      });
    }
    if (
      row.status === ProductReviewStatus.APPROVED ||
      status === ProductReviewStatus.APPROVED
    ) {
      await this.revalidate(store.id, true);
    }
    return this.ownerView(store, row.id);
  }

  /**
   * PUT /stores/my/reviews/:id/reply: set the owner reply (plain text).
   * Same `expectedUpdatedAt` rule as setStatus: a reply is never attached to
   * a text it did not answer (409 REVIEW_CHANGED).
   */
  async setReply(
    userId: string,
    reviewId: string,
    body: unknown,
    expectedUpdatedAt: unknown,
  ): Promise<OwnerReview> {
    const store = await this.storeOfOwner(userId);
    const row = await this.ownerRow(store, reviewId);
    const expected = expectedVersion(expectedUpdatedAt);
    if (row.updated_at.getTime() !== expected.getTime()) throw errors.changed();
    const reply = normalizeReviewReply(body);
    if (row.reply_body !== reply) {
      const written = await this.prisma.productReview.updateMany({
        where: { id: row.id, store_id: store.id, updated_at: expected },
        data: { reply_body: reply, replied_at: new Date() },
      });
      if (written.count === 0) throw errors.changed();
      if (row.status === ProductReviewStatus.APPROVED) {
        await this.revalidate(store.id, true);
      }
    }
    return this.ownerView(store, row.id);
  }

  /** DELETE /stores/my/reviews/:id/reply. */
  async removeReply(userId: string, reviewId: string): Promise<OwnerReview> {
    const store = await this.storeOfOwner(userId);
    const row = await this.ownerRow(store, reviewId);
    if (row.reply_body !== null) {
      await this.prisma.productReview.updateMany({
        where: { id: row.id, store_id: store.id },
        data: { reply_body: null, replied_at: null },
      });
      if (row.status === ProductReviewStatus.APPROVED) {
        await this.revalidate(store.id, true);
      }
    }
    return this.ownerView(store, row.id);
  }

  /**
   * DELETE /stores/my/reviews/:id. Leaves a moderation hold: the customer
   * (or the review link) can write a new review, but it waits for the owner
   * even while the store publishes automatically.
   */
  async ownerDelete(
    userId: string,
    reviewId: string,
  ): Promise<{ deleted: true }> {
    const store = await this.storeOfOwner(userId);
    const row = await this.ownerRow(store, reviewId);
    await this.placeHold(store.id, row.customer_id, row);
    await this.prisma.productReview.deleteMany({
      where: { id: row.id, store_id: store.id },
    });
    if (row.status === ProductReviewStatus.APPROVED) {
      await this.revalidate(store.id, true);
    }
    return { deleted: true };
  }

  /**
   * POST /stores/my/reviews/links: one review link per distinct product of
   * an order of my store, for the owner to hand to the buyer. The owner
   * holds a working write credential here (accepted limit of v1), so every
   * call leaves one log line (store, order, acting user; never a token).
   */
  async createLinks(
    userId: string,
    orderId: string,
  ): Promise<{ links: ReviewLinkRow[] }> {
    const store = await this.storeOfOwner(userId);
    if (!(await this.storeApps.isEnabled(store.id, REVIEWS_APP_KEY))) {
      throw errors.notEnabled();
    }
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, store_id: store.id },
      select: {
        ...orderFactsSelect,
        customer_id: true,
        hostname: true,
        customer: {
          select: {
            user_id: true,
            user: { select: { role: true, status: true, store_id: true } },
          },
        },
        items: {
          orderBy: { id: 'asc' },
          select: {
            ...orderLineSelect,
            product: {
              select: {
                creator_id: true,
                translations: { select: { locale: true, title: true } },
              },
            },
            custom_product: {
              select: {
                creator_id: true,
                translations: { select: { locale: true, title: true } },
              },
            },
          },
        },
      },
    });
    if (!order) throw errors.orderNotFound();
    const buyer = order.customer.user;
    // A link of a blocked (or foreign) account would never open.
    const buyerOk =
      buyer.role === UserRole.CUSTOMER &&
      buyer.status === UserStatus.ACTIVE &&
      buyer.store_id === store.id;
    if (!buyerOk || !isReviewEligibleOrder(order, store.id)) {
      throw errors.orderNotEligible();
    }

    const lines = this.distinctLines(store, order.items);
    const statuses = await this.statusByTarget(
      store.id,
      order.customer_id,
      lines.map((l) => l.target),
    );
    const origin = await this.linkOrigin(store, order.hostname);
    const locale = this.primaryLocale(store);
    const links: ReviewLinkRow[] = [];
    for (const line of lines) {
      const item = order.items.find((i) => i.id === line.order_item_id);
      const translations =
        (line.target.kind === 'product'
          ? item?.product?.translations
          : item?.custom_product?.translations) ?? [];
      const signed = await this.tokens.sign({
        userId: order.customer.user_id,
        storeId: store.id,
        orderId: order.id,
        orderItemId: line.order_item_id,
      });
      links.push({
        order_item_id: line.order_item_id,
        product_title: pickTranslation(translations, locale)?.title ?? '',
        url: `${origin}/reviews/write#token=${signed.token}`,
        expires_at: signed.expires_at,
        review_status:
          statuses.get(`${line.target.kind}:${line.target.id}`) ?? null,
      });
    }
    this.logger.log(
      `review links created: store=${store.id} order=${order.id} by=${userId} count=${links.length}`,
    );
    return { links };
  }

  /**
   * Origin of a review link: the host the order was placed on while it is an
   * ACTIVE domain of the store, else the store's platform URL (same rule as
   * buildStoreUrl of the order mails).
   */
  private async linkOrigin(
    store: StoreScope,
    hostname: string | null,
  ): Promise<string> {
    const host = hostname?.trim().toLowerCase();
    if (host) {
      const domain = await this.prisma.storeDomain.findFirst({
        where: { store_id: store.id, hostname: host, status: 'ACTIVE' },
        select: { hostname: true },
      });
      if (domain) return `https://${domain.hostname}`;
    }
    if (store.custom_domain) {
      return `https://${store.custom_domain.replace(/\/$/, '')}`;
    }
    const base = (
      this.config.get<string>('STOREFRONT_URL') || 'http://localhost:3003'
    ).replace(/\/$/, '');
    return `${base}/store/${store.slug}`;
  }

  // -- Hooks -----------------------------------------------------------------

  /**
   * Orders that stopped being real purchases (trashed, flagged test): their
   * PENDING / APPROVED reviews become REJECTED (no moderator) and the stores
   * that showed one are revalidated. Restoring / unflagging the order does
   * not re-approve. Called best effort by OrdersService.
   */
  async hideForOrders(
    orderIds: readonly string[],
  ): Promise<{ hidden: number }> {
    const ids = [...new Set(orderIds.filter(Boolean))];
    if (ids.length === 0) return { hidden: 0 };
    const where = {
      order_id: { in: ids },
      status: {
        in: [ProductReviewStatus.PENDING, ProductReviewStatus.APPROVED],
      },
    } satisfies Prisma.ProductReviewWhereInput;
    const rows = await this.prisma.productReview.findMany({
      where,
      select: { id: true, store_id: true, status: true },
    });
    if (rows.length === 0) return { hidden: 0 };
    const result = await this.prisma.productReview.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, status: where.status },
      data: {
        status: ProductReviewStatus.REJECTED,
        moderated_at: new Date(),
        moderated_by: null,
      },
    });
    await this.revalidateStoresOf(rows);
    return { hidden: result.count };
  }

  /**
   * Erasure: deletes every review of a customer (no anonymise-in-place: a
   * review without its author is removed) and revalidates the stores that
   * showed one. For any account-deletion / anonymise code path.
   */
  async removeForCustomer(customerId: string): Promise<{ deleted: number }> {
    if (!customerId) return { deleted: 0 };
    // The moderation markers go with the reviews (nothing of the customer
    // stays in the reviews tables).
    await this.prisma.productReviewHold.deleteMany({
      where: { customer_id: customerId },
    });
    const rows = await this.prisma.productReview.findMany({
      where: { customer_id: customerId },
      select: { id: true, store_id: true, status: true },
    });
    if (rows.length === 0) return { deleted: 0 };
    const result = await this.prisma.productReview.deleteMany({
      where: { customer_id: customerId },
    });
    await this.revalidateStoresOf(rows);
    return { deleted: result.count };
  }

  /** Revalidates each store that had an APPROVED review among `rows`. */
  private async revalidateStoresOf(
    rows: readonly { store_id: string; status: ProductReviewStatus }[],
  ): Promise<void> {
    const stores = new Set(
      rows
        .filter((r) => r.status === ProductReviewStatus.APPROVED)
        .map((r) => r.store_id),
    );
    for (const storeId of stores) await this.revalidate(storeId, true);
  }
}
