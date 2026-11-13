import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreatePromotionDto,
  UpdatePromotionDto,
  ValidateCouponDto,
  CouponPreviewDto,
} from './dto/promotion.dto';
import { Prisma, UserRole } from '@prisma/client';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { roundMoney } from '../../common/money/currency.util';

/** POST /promotions/coupon-preview response. Amounts in market currency. */
export interface CouponPreview {
  /** The code as stored (canonical spelling). */
  code: string;
  /** null only for a FREE_SHIPPING promotion (no line discount). */
  discount_kind: CouponDiscountKind | null;
  percent: number | null;
  amount: number | null;
  free_shipping: boolean;
  /** false when the coupon targets other products than product_id. */
  applies: boolean;
  min_amount: number | null;
  min_quantity: number | null;
  /** null when a minimum exists but the figure to check it was not sent. */
  min_met: boolean | null;
  discount_amount: number | null;
}

/** A threshold from the conditions JSON: a positive number, else none. */
function positiveNumber(v: unknown): number | null {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The coupon conditions JSON as validateCoupon reads it. */
interface PromotionConditions {
  min_amount?: number;
  min_quantity?: number;
  product_ids?: string[];
  /**
   * COUPON only: how `value` is read. Absent = 'percentage' (every coupon
   * created before the switch existed). A 'fixed' value is an amount in the
   * store's base currency, converted per market like fixed promotions.
   */
  discount_kind?: CouponDiscountKind;
}

export type CouponDiscountKind = 'percentage' | 'fixed';

/** How a promotion's `value` is applied: a percentage or a money amount. */
export function discountKindOf(
  type: string,
  conditions: unknown,
): CouponDiscountKind | null {
  if (type === 'PERCENTAGE') return 'percentage';
  if (type === 'FIXED_AMOUNT') return 'fixed';
  if (type === 'COUPON') {
    const kind =
      conditions && typeof conditions === 'object'
        ? (conditions as PromotionConditions).discount_kind
        : undefined;
    return kind === 'fixed' ? 'fixed' : 'percentage';
  }
  return null;
}

/**
 * Rejects a percentage above 100 (a 150% coupon would pay the buyer) and
 * normalises `conditions.discount_kind` to the two accepted values.
 */
function assertDiscountValue(
  type: string,
  value: number | undefined,
  conditions: unknown,
): void {
  if (
    conditions &&
    typeof conditions === 'object' &&
    'discount_kind' in conditions
  ) {
    const kind = (conditions as PromotionConditions).discount_kind;
    if (kind !== 'percentage' && kind !== 'fixed') {
      throw new BadRequestException({
        code: 'PROMOTION_DISCOUNT_KIND_INVALID',
        message: 'discount_kind must be percentage or fixed',
      });
    }
  }
  if (
    value != null &&
    Number(value) > 100 &&
    discountKindOf(type, conditions) === 'percentage'
  ) {
    throw new BadRequestException({
      code: 'PROMOTION_PERCENT_OVER_100',
      message: 'A percentage discount cannot exceed 100',
    });
  }
}

/**
 * The amount a coupon applies to: the whole subtotal, or for a coupon that
 * targets products, only the cart lines of those products (when the caller
 * sends per-line totals; checkout always does). null = unknown (a preview
 * call without a subtotal).
 */
export function discountBase(
  dto: Pick<ValidateCouponDto, 'subtotal' | 'line_totals'>,
  targetIds: readonly string[] | undefined,
): number | null {
  if (targetIds?.length && dto.line_totals?.length) {
    return dto.line_totals
      .filter((l) => targetIds.includes(l.product_id))
      .reduce((sum, l) => sum + l.amount, 0);
  }
  return dto.subtotal ?? null;
}

@Injectable()
export class PromotionsService {
  constructor(
    private prisma: PrismaService,
    private marketsContext: MarketsContextService,
    private marketPricing: MarketPricingService,
  ) {}

  async create(userId: string, userRole: UserRole, dto: CreatePromotionDto) {
    assertDiscountValue(dto.type, dto.value, dto.conditions);
    const { translations, ...data } = dto;

    const promotionData: Prisma.PromotionUncheckedCreateInput = {
      ...data,
      starts_at: new Date(data.starts_at),
      expires_at: data.expires_at ? new Date(data.expires_at) : null,
      ...(translations && { translations: { create: translations } }),
    };

    // Link to provider or creator
    if (userRole === UserRole.PROVIDER) {
      const provider = await this.prisma.provider.findUnique({
        where: { user_id: userId },
      });
      if (!provider)
        throw new NotFoundException({
          code: 'PROMOTION_PROVIDER_NOT_FOUND',
          message: 'Provider not found',
        });
      promotionData.provider_id = provider.id;
    } else if (userRole === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
      });
      if (!creator)
        throw new NotFoundException({
          code: 'PROMOTION_CREATOR_NOT_FOUND',
          message: 'Creator not found',
        });
      promotionData.creator_id = creator.id;
    }

    return this.prisma.promotion.create({
      data: promotionData,
      include: { translations: true },
    });
  }

  async findByOwner(userId: string, userRole: UserRole, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where: Prisma.PromotionWhereInput = {};

    if (userRole === UserRole.PROVIDER) {
      const provider = await this.prisma.provider.findUnique({
        where: { user_id: userId },
      });
      if (!provider)
        throw new NotFoundException({
          code: 'PROMOTION_PROVIDER_NOT_FOUND',
          message: 'Provider not found',
        });
      where.provider_id = provider.id;
    } else if (userRole === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
      });
      if (!creator)
        throw new NotFoundException({
          code: 'PROMOTION_CREATOR_NOT_FOUND',
          message: 'Creator not found',
        });
      where.creator_id = creator.id;
    }

    const [data, total] = await Promise.all([
      this.prisma.promotion.findMany({
        where,
        skip,
        take: limit,
        include: { translations: true },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.promotion.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findById(id: string, userId?: string, role?: UserRole) {
    const promo = await this.prisma.promotion.findUnique({
      where: { id },
      include: { translations: true, usages: { take: 20 } },
    });
    if (!promo)
      throw new NotFoundException({
        code: 'PROMOTION_NOT_FOUND',
        message: 'Promotion not found',
      });

    // Same ownership rule the update/delete paths already enforce — the read
    // exposes the promotion's terms and its redemption history.
    if (role !== UserRole.ADMIN) {
      const owner =
        role === UserRole.CREATOR
          ? (
              await this.prisma.creator.findUnique({
                where: { user_id: userId! },
              })
            )?.id
          : role === UserRole.PROVIDER
            ? (
                await this.prisma.provider.findUnique({
                  where: { user_id: userId! },
                })
              )?.id
            : undefined;
      const owns =
        !!owner &&
        (role === UserRole.CREATOR
          ? promo.creator_id === owner
          : promo.provider_id === owner);
      if (!owns) {
        throw new NotFoundException({
          code: 'PROMOTION_NOT_FOUND',
          message: 'Promotion not found',
        });
      }
    }
    return promo;
  }

  async update(
    id: string,
    dto: UpdatePromotionDto,
    userId?: string,
    role?: UserRole,
  ) {
    const promo = await this.prisma.promotion.findUnique({ where: { id } });
    if (!promo)
      throw new NotFoundException({
        code: 'PROMOTION_NOT_FOUND',
        message: 'Promotion not found',
      });

    // Ownership check
    if (userId && role) {
      if (role === UserRole.CREATOR) {
        const creator = await this.prisma.creator.findUnique({
          where: { user_id: userId },
        });
        if (!creator || promo.creator_id !== creator.id) {
          throw new BadRequestException({
            code: 'PROMOTION_EDIT_NOT_OWNED',
            message: 'You can only edit your own promotions',
          });
        }
      } else if (role === UserRole.PROVIDER) {
        const provider = await this.prisma.provider.findUnique({
          where: { user_id: userId },
        });
        if (!provider || promo.provider_id !== provider.id) {
          throw new BadRequestException({
            code: 'PROMOTION_EDIT_NOT_OWNED',
            message: 'You can only edit your own promotions',
          });
        }
      }
    }

    assertDiscountValue(
      promo.type,
      dto.value ?? Number(promo.value),
      dto.conditions !== undefined ? dto.conditions : promo.conditions,
    );

    const { translations, ...data } = dto;

    if (translations) {
      await this.prisma.promotionTranslation.deleteMany({
        where: { promotion_id: id },
      });
    }

    return this.prisma.promotion.update({
      where: { id },
      data: {
        ...data,
        ...(data.expires_at && { expires_at: new Date(data.expires_at) }),
        ...(translations && { translations: { create: translations } }),
      },
      include: { translations: true },
    });
  }

  async delete(id: string, userId?: string, role?: UserRole) {
    const promo = await this.prisma.promotion.findUnique({ where: { id } });
    if (!promo)
      throw new NotFoundException({
        code: 'PROMOTION_NOT_FOUND',
        message: 'Promotion not found',
      });

    if (userId && role) {
      if (role === UserRole.CREATOR) {
        const creator = await this.prisma.creator.findUnique({
          where: { user_id: userId },
        });
        if (!creator || promo.creator_id !== creator.id) {
          throw new BadRequestException({
            code: 'PROMOTION_DELETE_NOT_OWNED',
            message: 'You can only delete your own promotions',
          });
        }
      } else if (role === UserRole.PROVIDER) {
        const provider = await this.prisma.provider.findUnique({
          where: { user_id: userId },
        });
        if (!provider || promo.provider_id !== provider.id) {
          throw new BadRequestException({
            code: 'PROMOTION_DELETE_NOT_OWNED',
            message: 'You can only delete your own promotions',
          });
        }
      }
    }

    return this.prisma.promotion.delete({ where: { id } });
  }

  /**
   * The rules that decide whether a code is usable at all on this store:
   * lookup, provider rejection, store ownership, status, dates and usage
   * limit. Shared by validateCoupon and previewCoupon so they cannot drift.
   * Cart-dependent checks (minimums, product targeting) stay with callers.
   */
  private async loadUsableCoupon(
    dto: Pick<ValidateCouponDto, 'coupon_code' | 'store_id' | 'product_ids'>,
  ) {
    const promo = await this.prisma.promotion.findUnique({
      where: { coupon_code: dto.coupon_code },
    });

    if (!promo) {
      throw new BadRequestException({
        code: 'PROMOTION_COUPON_INVALID',
        message: 'Invalid coupon code',
      });
    }

    // Provider-owned coupons are disabled: the commission split charges any
    // discount to the store owner, who never issued it. Treated as unknown.
    if (promo.provider_id) {
      throw new BadRequestException({
        code: 'PROMOTION_COUPON_INVALID',
        message: 'Invalid coupon code',
      });
    }

    // Scope the coupon to its owner. `coupon_code` is globally unique, so
    // without this any store's code would discount every other store's orders —
    // and on an independent store the creator would eat a discount they never
    // issued. A promotion with no owner is a platform-wide campaign and stays
    // valid everywhere.
    await this.assertCouponAppliesToStore(promo, dto);

    // Check if active
    if (promo.status !== 'ACTIVE') {
      throw new BadRequestException({
        code: 'PROMOTION_COUPON_NOT_ACTIVE',
        message: 'Coupon is not active',
      });
    }

    // Check dates
    const now = new Date();
    if (promo.starts_at > now) {
      throw new BadRequestException({
        code: 'PROMOTION_COUPON_NOT_YET_VALID',
        message: 'Coupon not yet valid',
      });
    }
    if (promo.expires_at && promo.expires_at < now) {
      throw new BadRequestException({
        code: 'PROMOTION_COUPON_EXPIRED',
        message: 'Coupon has expired',
      });
    }

    // Check usage limit
    if (promo.usage_limit && promo.usage_count >= promo.usage_limit) {
      throw new BadRequestException({
        code: 'PROMOTION_COUPON_USAGE_LIMIT_REACHED',
        message: 'Coupon usage limit reached',
      });
    }

    return promo;
  }

  async validateCoupon(dto: ValidateCouponDto) {
    const promo = await this.loadUsableCoupon(dto);

    // Check conditions. The truthiness guards are kept as they were so the
    // set of coupons that pass does not change; only the errors are coded,
    // so the storefront can keep a link coupon pending until the cart
    // qualifies. Thresholds are in the store's base currency.
    const conditions = promo.conditions as PromotionConditions | null;
    if (
      conditions?.min_amount &&
      dto.subtotal &&
      dto.subtotal < conditions.min_amount
    ) {
      throw new BadRequestException({
        code: 'PROMOTION_COUPON_MIN_AMOUNT',
        message: `Minimum order amount is ${conditions.min_amount}`,
      });
    }
    if (
      conditions?.min_quantity &&
      dto.item_count &&
      dto.item_count < conditions.min_quantity
    ) {
      throw new BadRequestException({
        code: 'PROMOTION_COUPON_MIN_QUANTITY',
        message: `Minimum ${conditions.min_quantity} items required`,
      });
    }

    // Check product targeting
    if ((conditions?.product_ids?.length ?? 0) > 0 && dto.product_ids?.length) {
      const hasMatch = dto.product_ids.some((pid: string) =>
        conditions!.product_ids!.includes(pid),
      );
      if (!hasMatch) {
        throw new BadRequestException({
          code: 'PROMOTION_COUPON_NOT_APPLICABLE',
          message: 'This coupon does not apply to the products in your cart',
        });
      }
    }

    // Calculate discount. A product-targeted coupon discounts only the
    // targeted lines, never the rest of the cart. A fixed amount never
    // exceeds what it applies to.
    const base = discountBase(dto, conditions?.product_ids);
    const targetIds = Array.isArray(conditions?.product_ids)
      ? conditions.product_ids.filter(
          (id): id is string => typeof id === 'string' && id !== '',
        )
      : [];
    const kind = discountKindOf(promo.type, conditions);
    let discount = 0;
    if (kind === 'percentage') {
      discount = (base ?? 0) * (Number(promo.value) / 100);
    } else if (kind === 'fixed') {
      const value = Number(promo.value);
      discount = base == null ? value : Math.min(value, base);
    }
    // FREE_SHIPPING: no line discount, handled in the shipping calculation.

    return {
      valid: true,
      promotion_id: promo.id,
      type: promo.type,
      value: Number(promo.value),
      discount_kind: kind,
      discount_amount: Math.round(discount * 100) / 100,
      free_shipping: promo.type === 'FREE_SHIPPING',
      // Product targeting, so the cart can estimate the discount on the
      // targeted lines only when lines change (before it re-validates).
      targeted: targetIds.length > 0,
      product_ids: targetIds,
    };
  }

  /**
   * Public cart preview. A market store's cart is priced in the market
   * currency while coupon amounts and thresholds are stored in the base
   * currency: bring the cart figures to base, evaluate exactly like the
   * order does, and convert the discount back — so the preview shows the
   * same discount the order will charge. Stores without a foreign-currency
   * market go through unchanged.
   */
  async validateCouponForCart(dto: ValidateCouponDto) {
    const { market: marketKey, preview, ...rest } = dto;
    const market = marketKey
      ? await this.marketsContext.resolve(rest.store_id, marketKey, {
          preview: preview === true,
        })
      : null;
    if (!market || market.currency === market.storeCurrency) {
      return this.validateCoupon(rest);
    }
    const toBase = (amount: number) =>
      this.marketPricing.toBaseMoney(market, amount);
    const result = await this.validateCoupon({
      ...rest,
      ...(rest.subtotal != null ? { subtotal: toBase(rest.subtotal) } : {}),
      ...(rest.line_totals
        ? {
            line_totals: rest.line_totals.map((l) => ({
              ...l,
              amount: toBase(l.amount),
            })),
          }
        : {}),
    });
    return {
      ...result,
      // A fixed coupon's face value in the market currency, so the cart can
      // label it ("-100 kr" on namez.se, "-9 €" on namez.shop).
      ...(result.discount_kind === 'fixed'
        ? { value: this.marketPricing.convertMoney(market, result.value) }
        : {}),
      discount_amount: this.marketPricing.convertMoney(
        market,
        result.discount_amount,
      ),
    };
  }

  /**
   * Product-page coupon preview for a link banner. Every reason a code is
   * unusable (unknown, inactive, not started, expired, exhausted, provider
   * owned, another store's) answers one uniform 400 PROMOTION_COUPON_INVALID
   * so the banner cannot be used to probe codes. Cart-dependent facts
   * (targeting, minimums) are reported as fields, not errors. Amounts in and
   * out are in the market currency; thresholds are compared in the base
   * currency exactly like validateCouponForCart, and discount_amount is
   * computed and rounded like the order path does.
   */
  async previewCoupon(dto: CouponPreviewDto): Promise<CouponPreview> {
    const market = dto.market
      ? await this.marketsContext.resolve(dto.store_id, dto.market, {
          preview: dto.preview === true,
        })
      : null;
    const foreign = !!market && market.currency !== market.storeCurrency;
    const toBase = (amount: number) =>
      foreign ? this.marketPricing.toBaseMoney(market, amount) : amount;
    const convert = (amount: number) =>
      foreign ? this.marketPricing.convertMoney(market, amount) : amount;

    let promo: Awaited<ReturnType<PromotionsService['loadUsableCoupon']>>;
    try {
      promo = await this.loadUsableCoupon({
        coupon_code: dto.coupon_code,
        store_id: dto.store_id,
        product_ids: [dto.product_id],
      });
    } catch (err) {
      if (err instanceof BadRequestException) {
        throw new BadRequestException({
          code: 'PROMOTION_COUPON_INVALID',
          message: 'Invalid coupon code',
        });
      }
      throw err;
    }

    const conditions = (promo.conditions ?? null) as PromotionConditions | null;
    const kind = discountKindOf(promo.type, conditions);
    const value = Number(promo.value);
    const targets = Array.isArray(conditions?.product_ids)
      ? conditions.product_ids
      : [];
    const applies = targets.length === 0 || targets.includes(dto.product_id);

    // Thresholds: a positive number (numeric strings included, as the
    // order path's comparisons coerce them) or no threshold at all.
    const minAmountBase = positiveNumber(conditions?.min_amount);
    const minQuantity = positiveNumber(conditions?.min_quantity);
    const isNum = (v: unknown): v is number =>
      typeof v === 'number' && Number.isFinite(v);

    // true/false per threshold, undefined = not checkable (figure not sent).
    const amountMet =
      minAmountBase == null
        ? true
        : isNum(dto.cart_subtotal)
          ? toBase(dto.cart_subtotal) >= minAmountBase
          : undefined;
    const quantityMet =
      minQuantity == null
        ? true
        : isNum(dto.item_count)
          ? dto.item_count >= minQuantity
          : undefined;
    const minMet: boolean | null =
      amountMet === false || quantityMet === false
        ? false
        : amountMet === undefined || quantityMet === undefined
          ? null
          : true;

    let discountAmount: number | null = null;
    if (applies && minMet === true && isNum(dto.line_amount) && kind) {
      const base = toBase(dto.line_amount);
      const raw =
        kind === 'percentage' ? base * (value / 100) : Math.min(value, base);
      // Same steps as validateCoupon + OrdersService: round in base, convert
      // to the market, round, never more than the line itself.
      const inBase = Math.round(raw * 100) / 100;
      discountAmount = Math.min(roundMoney(convert(inBase)), dto.line_amount);
    }

    return {
      code: promo.coupon_code ?? dto.coupon_code,
      discount_kind: kind,
      percent: kind === 'percentage' ? value : null,
      amount: kind === 'fixed' ? convert(value) : null,
      free_shipping: promo.type === 'FREE_SHIPPING',
      applies,
      min_amount: minAmountBase == null ? null : convert(minAmountBase),
      min_quantity: minQuantity,
      min_met: minMet,
      discount_amount: discountAmount,
    };
  }

  /**
   * A creator's coupon is valid only on that creator's own store. A provider's
   * coupon is valid only when the cart actually contains an item that provider
   * fulfils (providers have no storefront of their own). Ownerless promotions
   * are platform campaigns and apply everywhere.
   */
  private async assertCouponAppliesToStore(
    promo: { creator_id: string | null; provider_id: string | null },
    dto: Pick<ValidateCouponDto, 'store_id' | 'product_ids'>,
  ): Promise<void> {
    // Another owner's code answers exactly like an unknown one: it can never
    // apply here (the storefront discards it instead of retrying it), and
    // validate-coupon is not an oracle for other stores' codes.
    // PROMOTION_COUPON_NOT_APPLICABLE is kept for product targeting only.
    const notApplicable = () => {
      throw new BadRequestException({
        code: 'PROMOTION_COUPON_INVALID',
        message: 'Invalid coupon code',
      });
    };

    if (promo.creator_id) {
      const store = await this.prisma.store.findUnique({
        where: { id: dto.store_id },
        select: { creator_id: true },
      });
      if (!store || store.creator_id !== promo.creator_id) notApplicable();
      return;
    }

    if (promo.provider_id) {
      // Cart ids are a mix of Product and CustomProduct ids — check both.
      const ids = dto.product_ids ?? [];
      if (!ids.length) notApplicable();
      const [ownCount, customCount] = await Promise.all([
        this.prisma.product.count({
          where: { id: { in: ids }, provider_id: promo.provider_id },
        }),
        this.prisma.customProduct.count({
          where: {
            id: { in: ids },
            product: { provider_id: promo.provider_id },
          },
        }),
      ]);
      if (ownCount === 0 && customCount === 0) notApplicable();
    }
  }

  /**
   * Claim one redemption before the order is created. `validateCoupon` only
   * reads `usage_count`, so concurrent checkouts could all pass that check and
   * blow past a limited-redemption coupon — the increment used to happen after
   * the order existed, and its failure was swallowed. The conditional
   * updateMany makes the claim atomic: exactly one caller wins the last slot.
   * Returns false when the coupon is exhausted; release it with
   * `releaseRedemption` if the order then fails to be created.
   */
  async claimRedemption(
    promotionId: string,
  ): Promise<'reserved' | 'unlimited' | 'exhausted'> {
    const promo = await this.prisma.promotion.findUnique({
      where: { id: promotionId },
      select: { usage_limit: true },
    });
    if (!promo) return 'exhausted';
    // Unlimited coupons have nothing to reserve — recordUsage does the counting.
    if (promo.usage_limit == null) return 'unlimited';

    const claimed = await this.prisma.promotion.updateMany({
      where: { id: promotionId, usage_count: { lt: promo.usage_limit } },
      data: { usage_count: { increment: 1 } },
    });
    return claimed.count === 1 ? 'reserved' : 'exhausted';
  }

  async releaseRedemption(promotionId: string): Promise<void> {
    try {
      await this.prisma.promotion.updateMany({
        where: { id: promotionId, usage_count: { gt: 0 } },
        data: { usage_count: { decrement: 1 } },
      });
    } catch (err) {
      console.error(
        '[Promotion] Failed to release redemption',
        promotionId,
        err,
      );
    }
  }

  /**
   * Record who redeemed the coupon. The count itself was already claimed by
   * `claimRedemption`, so this only writes the audit row — and increments the
   * count for unlimited coupons, which skip the reservation.
   */
  async recordUsage(
    promotionId: string,
    orderId: string,
    userId: string,
    discountAmount: number,
    countAlreadyClaimed = false,
  ) {
    await this.prisma.promotionUsage.create({
      data: {
        promotion_id: promotionId,
        order_id: orderId,
        user_id: userId,
        discount_amount: discountAmount,
      },
    });

    if (!countAlreadyClaimed) {
      await this.prisma.promotion.update({
        where: { id: promotionId },
        data: { usage_count: { increment: 1 } },
      });
    }
  }
}
