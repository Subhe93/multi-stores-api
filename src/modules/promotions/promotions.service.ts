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
      if (!provider) throw new NotFoundException('Provider not found');
      promotionData.provider_id = provider.id;
    } else if (userRole === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
      });
      if (!creator) throw new NotFoundException('Creator not found');
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
      if (!provider) throw new NotFoundException('Provider not found');
      where.provider_id = provider.id;
    } else if (userRole === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
      });
      if (!creator) throw new NotFoundException('Creator not found');
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

  async findById(id: string) {
    const promo = await this.prisma.promotion.findUnique({
      where: { id },
      include: { translations: true, usages: { take: 20 } },
    });
    if (!promo) throw new NotFoundException('Promotion not found');
    return promo;
  }

  async update(id: string, dto: UpdatePromotionDto, userId?: string, role?: UserRole) {
    const promo = await this.prisma.promotion.findUnique({ where: { id } });
    if (!promo) throw new NotFoundException('Promotion not found');

    // Ownership check
    if (userId && role) {
      if (role === UserRole.CREATOR) {
        const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
        if (!creator || promo.creator_id !== creator.id) {
          throw new BadRequestException('You can only edit your own promotions');
        }
      } else if (role === UserRole.PROVIDER) {
        const provider = await this.prisma.provider.findUnique({ where: { user_id: userId } });
        if (!provider || promo.provider_id !== provider.id) {
          throw new BadRequestException('You can only edit your own promotions');
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
    if (!promo) throw new NotFoundException('Promotion not found');

    if (userId && role) {
      if (role === UserRole.CREATOR) {
        const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
        if (!creator || promo.creator_id !== creator.id) {
          throw new BadRequestException('You can only delete your own promotions');
        }
      } else if (role === UserRole.PROVIDER) {
        const provider = await this.prisma.provider.findUnique({ where: { user_id: userId } });
        if (!provider || promo.provider_id !== provider.id) {
          throw new BadRequestException('You can only delete your own promotions');
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
      throw new BadRequestException('Invalid coupon code');
    }

    // Check if active
    if (promo.status !== 'ACTIVE') {
      throw new BadRequestException('Coupon is not active');
    }

    // Check dates
    const now = new Date();
    if (promo.starts_at > now) {
      throw new BadRequestException('Coupon not yet valid');
    }
    if (promo.expires_at && promo.expires_at < now) {
      throw new BadRequestException('Coupon has expired');
    }

    // Check usage limit
    if (promo.usage_limit && promo.usage_count >= promo.usage_limit) {
      throw new BadRequestException('Coupon usage limit reached');
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
          'This coupon does not apply to the products in your cart',
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

  async recordUsage(
    promotionId: string,
    orderId: string,
    userId: string,
    discountAmount: number,
  ) {
    await this.prisma.promotionUsage.create({
      data: {
        promotion_id: promotionId,
        order_id: orderId,
        user_id: userId,
        discount_amount: discountAmount,
      },
    });

    // Increment usage count
    await this.prisma.promotion.update({
      where: { id: promotionId },
      data: { usage_count: { increment: 1 } },
    });
  }
}
