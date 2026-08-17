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
} from './dto/promotion.dto';
import { UserRole } from '@prisma/client';

@Injectable()
export class PromotionsService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, userRole: UserRole, dto: CreatePromotionDto) {
    const { translations, ...data } = dto;

    const promotionData: any = {
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
      if (!provider) throw new NotFoundException({ code: 'PROMOTION_PROVIDER_NOT_FOUND', message: 'Provider not found' });
      promotionData.provider_id = provider.id;
    } else if (userRole === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
      });
      if (!creator) throw new NotFoundException({ code: 'PROMOTION_CREATOR_NOT_FOUND', message: 'Creator not found' });
      promotionData.creator_id = creator.id;
    }

    return this.prisma.promotion.create({
      data: promotionData,
      include: { translations: true },
    });
  }

  async findByOwner(userId: string, userRole: UserRole, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    let where: any = {};

    if (userRole === UserRole.PROVIDER) {
      const provider = await this.prisma.provider.findUnique({
        where: { user_id: userId },
      });
      if (!provider) throw new NotFoundException({ code: 'PROMOTION_PROVIDER_NOT_FOUND', message: 'Provider not found' });
      where.provider_id = provider.id;
    } else if (userRole === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
      });
      if (!creator) throw new NotFoundException({ code: 'PROMOTION_CREATOR_NOT_FOUND', message: 'Creator not found' });
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

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findById(id: string, userId?: string, role?: UserRole) {
    const promo = await this.prisma.promotion.findUnique({
      where: { id },
      include: { translations: true, usages: { take: 20 } },
    });
    if (!promo) throw new NotFoundException({ code: 'PROMOTION_NOT_FOUND', message: 'Promotion not found' });

    // Same ownership rule the update/delete paths already enforce — the read
    // exposes the promotion's terms and its redemption history.
    if (role !== UserRole.ADMIN) {
      const owner =
        role === UserRole.CREATOR
          ? (await this.prisma.creator.findUnique({ where: { user_id: userId! } }))?.id
          : role === UserRole.PROVIDER
            ? (await this.prisma.provider.findUnique({ where: { user_id: userId! } }))?.id
            : undefined;
      const owns =
        !!owner &&
        (role === UserRole.CREATOR
          ? promo.creator_id === owner
          : promo.provider_id === owner);
      if (!owns) {
        throw new NotFoundException({ code: 'PROMOTION_NOT_FOUND', message: 'Promotion not found' });
      }
    }
    return promo;
  }

  async update(id: string, dto: UpdatePromotionDto, userId?: string, role?: UserRole) {
    const promo = await this.prisma.promotion.findUnique({ where: { id } });
    if (!promo) throw new NotFoundException({ code: 'PROMOTION_NOT_FOUND', message: 'Promotion not found' });

    // Ownership check
    if (userId && role) {
      if (role === UserRole.CREATOR) {
        const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
        if (!creator || promo.creator_id !== creator.id) {
          throw new BadRequestException({ code: 'PROMOTION_EDIT_NOT_OWNED', message: 'You can only edit your own promotions' });
        }
      } else if (role === UserRole.PROVIDER) {
        const provider = await this.prisma.provider.findUnique({ where: { user_id: userId } });
        if (!provider || promo.provider_id !== provider.id) {
          throw new BadRequestException({ code: 'PROMOTION_EDIT_NOT_OWNED', message: 'You can only edit your own promotions' });
        }
      }
    }

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
    if (!promo) throw new NotFoundException({ code: 'PROMOTION_NOT_FOUND', message: 'Promotion not found' });

    if (userId && role) {
      if (role === UserRole.CREATOR) {
        const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
        if (!creator || promo.creator_id !== creator.id) {
          throw new BadRequestException({ code: 'PROMOTION_DELETE_NOT_OWNED', message: 'You can only delete your own promotions' });
        }
      } else if (role === UserRole.PROVIDER) {
        const provider = await this.prisma.provider.findUnique({ where: { user_id: userId } });
        if (!provider || promo.provider_id !== provider.id) {
          throw new BadRequestException({ code: 'PROMOTION_DELETE_NOT_OWNED', message: 'You can only delete your own promotions' });
        }
      }
    }

    return this.prisma.promotion.delete({ where: { id } });
  }

  async validateCoupon(dto: ValidateCouponDto) {
    const promo = await this.prisma.promotion.findUnique({
      where: { coupon_code: dto.coupon_code },
    });

    if (!promo) {
      throw new BadRequestException({ code: 'PROMOTION_COUPON_INVALID', message: 'Invalid coupon code' });
    }

    // Scope the coupon to its owner. `coupon_code` is globally unique, so
    // without this any store's code would discount every other store's orders —
    // and on an independent store the creator would eat a discount they never
    // issued. A promotion with no owner is a platform-wide campaign and stays
    // valid everywhere.
    await this.assertCouponAppliesToStore(promo, dto);

    // Check if active
    if (promo.status !== 'ACTIVE') {
      throw new BadRequestException({ code: 'PROMOTION_COUPON_NOT_ACTIVE', message: 'Coupon is not active' });
    }

    // Check dates
    const now = new Date();
    if (promo.starts_at > now) {
      throw new BadRequestException({ code: 'PROMOTION_COUPON_NOT_YET_VALID', message: 'Coupon not yet valid' });
    }
    if (promo.expires_at && promo.expires_at < now) {
      throw new BadRequestException({ code: 'PROMOTION_COUPON_EXPIRED', message: 'Coupon has expired' });
    }

    // Check usage limit
    if (promo.usage_limit && promo.usage_count >= promo.usage_limit) {
      throw new BadRequestException({ code: 'PROMOTION_COUPON_USAGE_LIMIT_REACHED', message: 'Coupon usage limit reached' });
    }

    // Check conditions
    const conditions = promo.conditions as any;
    if (conditions?.min_amount && dto.subtotal && dto.subtotal < conditions.min_amount) {
      throw new BadRequestException(
        `Minimum order amount is ${conditions.min_amount}`,
      );
    }
    if (conditions?.min_quantity && dto.item_count && dto.item_count < conditions.min_quantity) {
      throw new BadRequestException(
        `Minimum ${conditions.min_quantity} items required`,
      );
    }

    // Check product targeting
    if (conditions?.product_ids?.length > 0 && dto.product_ids?.length) {
      const hasMatch = dto.product_ids.some((pid: string) =>
        conditions.product_ids.includes(pid),
      );
      if (!hasMatch) {
        throw new BadRequestException(
          { code: 'PROMOTION_COUPON_NOT_APPLICABLE', message: 'This coupon does not apply to the products in your cart' },
        );
      }
    }

    // Calculate discount
    let discount = 0;
    if (promo.type === 'PERCENTAGE' || promo.type === 'COUPON') {
      discount = (dto.subtotal || 0) * (Number(promo.value) / 100);
    } else if (promo.type === 'FIXED_AMOUNT') {
      discount = Number(promo.value);
    } else if (promo.type === 'FREE_SHIPPING') {
      discount = 0; // Handled separately in shipping calculation
    }

    return {
      valid: true,
      promotion_id: promo.id,
      type: promo.type,
      value: Number(promo.value),
      discount_amount: Math.round(discount * 100) / 100,
      free_shipping: promo.type === 'FREE_SHIPPING',
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
    dto: ValidateCouponDto,
  ): Promise<void> {
    const notApplicable = () => {
      throw new BadRequestException({
        code: 'PROMOTION_COUPON_NOT_APPLICABLE',
        message: 'This coupon does not apply to the products in your cart',
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
          where: { id: { in: ids }, product: { provider_id: promo.provider_id } },
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
      console.error('[Promotion] Failed to release redemption', promotionId, err);
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
