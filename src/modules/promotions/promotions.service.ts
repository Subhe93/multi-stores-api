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
import { PricingType, Prisma, StoreType, UserRole } from '@prisma/client';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import {
  resolveOrderCurrency,
  roundMoney,
} from '../../common/money/currency.util';
import {
  TaxService,
  taxStoreSelect,
  type TaxLineInput,
} from '../taxes/tax.service';
import {
  couponBelowProviderCost,
  couponBelowProviderCostError,
} from './coupon-provider-floor';

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
  /**
   * MARKETPLACE stores: true when the discount would take this line's net
   * revenue below the provider cost, so the order would refuse it with
   * ORDER_DISCOUNT_BELOW_PROVIDER_COST. Then `applies` is false and
   * `discount_amount` is null (no price to show). Always false elsewhere.
   */
  below_cost: boolean;
}

/** One cart line as the provider-cost floor reads it (amounts in base). */
interface FloorLineInput {
  product_id: string;
  /** Line total; absent = the catalogue unit price x quantity. */
  amount?: number;
  quantity?: number;
  variant_id?: string;
}

/**
 * How loadFloorCart treats lines it cannot price exactly.
 * - 'cart' (validate-coupon): a line without an explicit quantity, or a
 *   product with variants sent without its variant, makes the whole cart
 *   unjudgeable (null): the line amount may carry add-ons or a variant
 *   price, so any estimate could reject a coupon the order accepts. The
 *   order path stays the guard.
 * - 'preview' (product banner): quantity defaults to 1 and a missing variant
 *   prices the product base, the lenient reading (never a stricter base
 *   than the order's).
 */
type FloorMode = 'cart' | 'preview';

/** A store's cart, priced and taxed like the order path for the floor. */
interface FloorCart {
  store: Prisma.StoreGetPayload<{ select: typeof floorStoreSelect }>;
  taxLines: TaxLineInput[];
  providerBaseTotal: number;
}

const floorStoreSelect = {
  ...taxStoreSelect,
  currency: true,
  primary_locale: true,
} as const;

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
    private taxService: TaxService,
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
    // issued. A promotion with no owner is a platform-wide campaign, valid on
    // MARKETPLACE stores only (never on an INDEPENDENT store).
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
      const result = await this.validateCoupon(rest);
      // Marketplace provider-cost floor, the same rule the order applies
      // (markets exist only on INDEPENDENT stores, where it never applies).
      // Judged only when the cart sends its lines: without them the floor
      // cannot be computed and the order path stays the guard.
      if (rest.line_totals?.length && result.discount_amount > 0) {
        const cart = await this.loadFloorCart(
          rest.store_id,
          rest.line_totals,
          'cart',
        );
        if (
          cart &&
          (await this.breaksFloor(
            cart,
            result.discount_amount,
            rest.country_code,
          ))
        ) {
          throw couponBelowProviderCostError();
        }
      }
      return result;
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
   * owned, another store's, a platform coupon on an INDEPENDENT store)
   * answers one uniform 400 PROMOTION_COUPON_INVALID
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

    // Marketplace provider-cost floor on this line alone (the order path's
    // rule). Without line_amount the line is the catalogue price x quantity;
    // without quantity it is one unit (never estimated from line_amount,
    // which may include add-ons or a variant price).
    // Markets exist only on INDEPENDENT stores, where the floor never applies.
    let belowCost = false;
    if (!foreign && applies && minMet !== false && kind) {
      const cart = await this.loadFloorCart(
        dto.store_id,
        [
          {
            product_id: dto.product_id,
            amount: isNum(dto.line_amount) ? dto.line_amount : undefined,
            quantity: dto.quantity,
            variant_id: dto.variant_id,
          },
        ],
        'preview',
      );
      if (cart) {
        const lineAmount = cart.taxLines[0]?.amount ?? 0;
        const raw =
          kind === 'percentage'
            ? lineAmount * (value / 100)
            : Math.min(value, lineAmount);
        const discount = Math.min(Math.round(raw * 100) / 100, lineAmount);
        belowCost = await this.breaksFloor(cart, discount, dto.country_code);
      }
    }

    return {
      code: promo.coupon_code ?? dto.coupon_code,
      discount_kind: kind,
      percent: kind === 'percentage' ? value : null,
      amount: kind === 'fixed' ? convert(value) : null,
      free_shipping: promo.type === 'FREE_SHIPPING',
      applies: applies && !belowCost,
      min_amount: minAmountBase == null ? null : convert(minAmountBase),
      min_quantity: minQuantity,
      min_met: minMet,
      discount_amount: belowCost ? null : discountAmount,
      below_cost: belowCost,
    };
  }

  /**
   * The cart as the marketplace provider-cost floor needs it, priced like
   * OrdersService.priceLine: per line its tax fields and its provider base
   * (min(base, unit) x quantity, i.e. min(base x qty, line amount)). null
   * when the floor cannot apply: unknown or INDEPENDENT store, or no line
   * fulfilled by a provider. Amounts are in the store's base currency.
   */
  private async loadFloorCart(
    storeId: string,
    lines: readonly FloorLineInput[],
    mode: FloorMode,
  ): Promise<FloorCart | null> {
    // A cart line without its quantity cannot be priced like the order.
    if (mode === 'cart' && lines.some((l) => !(Number(l.quantity) >= 1))) {
      return null;
    }
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: floorStoreSelect,
    });
    if (!store || store.store_type === StoreType.INDEPENDENT) return null;

    const ids = [...new Set(lines.map((l) => l.product_id).filter(Boolean))];
    const variantIds = [
      ...new Set(
        lines.map((l) => l.variant_id).filter((v): v is string => !!v),
      ),
    ];
    if (!ids.length) return null;
    const [customs, products, variants] = await Promise.all([
      this.prisma.customProduct.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          pricing_type: true,
          final_price: true,
          margin_amount: true,
          product: {
            select: {
              base_price: true,
              provider_id: true,
              tax_class_id: true,
              tax_exempt: true,
              // Whether a variant must be named (see FloorMode 'cart').
              variants: { select: { id: true }, take: 1 },
            },
          },
          selected_variants: {
            select: { variant_id: true, custom_price: true },
          },
        },
      }),
      this.prisma.product.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          base_price: true,
          provider_id: true,
          tax_class_id: true,
          tax_exempt: true,
          variants: { select: { id: true }, take: 1 },
        },
      }),
      variantIds.length
        ? this.prisma.productVariant.findMany({
            where: { id: { in: variantIds } },
            select: { id: true, price_adjustment: true },
          })
        : Promise.resolve(
            [] as { id: string; price_adjustment: Prisma.Decimal }[],
          ),
    ]);
    const customById = new Map(customs.map((c) => [c.id, c]));
    const productById = new Map(products.map((p) => [p.id, p]));
    const variantById = new Map(variants.map((v) => [v.id, v]));

    let hasProvider = false;
    let unjudgeable = false;
    let providerBaseTotal = 0;
    const taxLines: TaxLineInput[] = lines.map((line) => {
      const cp = customById.get(line.product_id);
      const own = cp ? undefined : productById.get(line.product_id);
      const variant = line.variant_id
        ? variantById.get(line.variant_id)
        : undefined;
      if (mode === 'cart') {
        const hasVariants = (cp?.product ?? own)?.variants?.length ?? 0;
        // The variant's price adjustment moves the provider base: without
        // it (or with an unknown one) the base would be underestimated.
        if (
          (hasVariants > 0 && !line.variant_id) ||
          (line.variant_id && !variant)
        ) {
          unjudgeable = true;
        }
      }
      const adjustment = Number(variant?.price_adjustment ?? 0) || 0;

      // Catalogue unit price and per-unit provider base (priceLine rules).
      let unit = 0;
      let baseUnit = 0;
      if (cp) {
        const productBase = Number(cp.product.base_price);
        switch (cp.pricing_type) {
          case PricingType.SINGLE:
            unit = Number(cp.final_price);
            break;
          case PricingType.PER_VARIANT: {
            const selected = variant
              ? cp.selected_variants.find((s) => s.variant_id === variant.id)
              : undefined;
            unit = variant
              ? selected?.custom_price
                ? Number(selected.custom_price)
                : productBase + adjustment
              : Number(cp.final_price) || productBase;
            break;
          }
          case PricingType.MARGIN:
            unit = productBase + adjustment + Number(cp.margin_amount || 0);
            break;
        }
        if (cp.product.provider_id) baseUnit = productBase + adjustment;
      } else if (own) {
        unit = Number(own.base_price) + adjustment;
        if (own.provider_id) baseUnit = unit;
      }

      // 'cart' lines always carry their quantity (checked above); a preview
      // without one is a single unit.
      const quantity = line.quantity ?? 1;
      const amount = roundMoney(line.amount ?? unit * quantity);
      if (baseUnit > 0) {
        hasProvider = true;
        providerBaseTotal += Math.min(baseUnit * quantity, amount);
      }
      const product = cp?.product ?? own;
      return {
        amount,
        tax_class_id: product?.tax_class_id ?? null,
        tax_exempt: product?.tax_exempt ?? false,
      };
    });
    if (!hasProvider || unjudgeable) return null;
    return {
      store,
      taxLines,
      providerBaseTotal: roundMoney(providerBaseTotal),
    };
  }

  /**
   * The shared floor rule (coupon-provider-floor.ts) on a FloorCart: net
   * merchandise revenue with and without the discount, taxed for the
   * destination the cart quote uses when the storefront sends it, else like
   * the order before its address is known (registration country); shipping
   * excluded (it never enters net_items).
   */
  private async breaksFloor(
    cart: FloorCart,
    discountAmount: number,
    countryCode?: string | null,
  ): Promise<boolean> {
    if (!(discountAmount > 0)) return false;
    const ctx = await this.taxService.contextFor(cart.store);
    const data = await this.taxService.loadTaxData(ctx);
    const platform = await this.prisma.platformConfig.findFirst({
      select: { default_currency: true },
    });
    const currency = resolveOrderCurrency(
      cart.store,
      platform?.default_currency,
    );
    const country =
      typeof countryCode === 'string' && /^[A-Za-z]{2}$/.test(countryCode)
        ? countryCode.toUpperCase()
        : null;
    const destination = { country, region: null, postcode: null };
    const netItems = (discount: number) =>
      this.taxService.computeTaxes({
        ctx,
        data,
        currency,
        locale: cart.store.primary_locale,
        lines: cart.taxLines,
        shipping_cost: 0,
        discount_amount: discount,
        shipping: destination,
        billing: destination,
      }).net_items;
    return couponBelowProviderCost({
      independent: false,
      discountAmount,
      providerBaseTotal: cart.providerBaseTotal,
      netItemsAfter: netItems(discountAmount),
      netItemsBefore: () => netItems(0),
    });
  }

  /**
   * A creator's coupon is valid only on that creator's own store. A provider's
   * coupon is valid only when the cart actually contains an item that provider
   * fulfils (providers have no storefront of their own). Ownerless promotions
   * are platform campaigns and apply on MARKETPLACE stores only.
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
      return;
    }

    // Platform campaign (no creator, no provider owner): MARKETPLACE stores
    // only. On an INDEPENDENT store the discount would come out of the
    // seller's own revenue for a campaign they never issued, so it answers
    // like an unknown code. validate-coupon, the coupon preview and the order
    // path (which calls validateCoupon) all pass through here and agree.
    const store = await this.prisma.store.findUnique({
      where: { id: dto.store_id },
      select: { store_type: true },
    });
    if (store?.store_type === StoreType.INDEPENDENT) notApplicable();
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
