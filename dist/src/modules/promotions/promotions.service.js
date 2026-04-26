"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromotionsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const client_1 = require("@prisma/client");
let PromotionsService = class PromotionsService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async create(userId, userRole, dto) {
        const { translations, ...data } = dto;
        const promotionData = {
            ...data,
            starts_at: new Date(data.starts_at),
            expires_at: data.expires_at ? new Date(data.expires_at) : null,
            ...(translations && { translations: { create: translations } }),
        };
        if (userRole === client_1.UserRole.PROVIDER) {
            const provider = await this.prisma.provider.findUnique({
                where: { user_id: userId },
            });
            if (!provider)
                throw new common_1.NotFoundException('Provider not found');
            promotionData.provider_id = provider.id;
        }
        else if (userRole === client_1.UserRole.CREATOR) {
            const creator = await this.prisma.creator.findUnique({
                where: { user_id: userId },
            });
            if (!creator)
                throw new common_1.NotFoundException('Creator not found');
            promotionData.creator_id = creator.id;
        }
        return this.prisma.promotion.create({
            data: promotionData,
            include: { translations: true },
        });
    }
    async findByOwner(userId, userRole, page = 1, limit = 20) {
        const skip = (page - 1) * limit;
        let where = {};
        if (userRole === client_1.UserRole.PROVIDER) {
            const provider = await this.prisma.provider.findUnique({
                where: { user_id: userId },
            });
            if (!provider)
                throw new common_1.NotFoundException('Provider not found');
            where.provider_id = provider.id;
        }
        else if (userRole === client_1.UserRole.CREATOR) {
            const creator = await this.prisma.creator.findUnique({
                where: { user_id: userId },
            });
            if (!creator)
                throw new common_1.NotFoundException('Creator not found');
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
    async findById(id) {
        const promo = await this.prisma.promotion.findUnique({
            where: { id },
            include: { translations: true, usages: { take: 20 } },
        });
        if (!promo)
            throw new common_1.NotFoundException('Promotion not found');
        return promo;
    }
    async update(id, dto, userId, role) {
        const promo = await this.prisma.promotion.findUnique({ where: { id } });
        if (!promo)
            throw new common_1.NotFoundException('Promotion not found');
        if (userId && role) {
            if (role === client_1.UserRole.CREATOR) {
                const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
                if (!creator || promo.creator_id !== creator.id) {
                    throw new common_1.BadRequestException('You can only edit your own promotions');
                }
            }
            else if (role === client_1.UserRole.PROVIDER) {
                const provider = await this.prisma.provider.findUnique({ where: { user_id: userId } });
                if (!provider || promo.provider_id !== provider.id) {
                    throw new common_1.BadRequestException('You can only edit your own promotions');
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
    async delete(id, userId, role) {
        const promo = await this.prisma.promotion.findUnique({ where: { id } });
        if (!promo)
            throw new common_1.NotFoundException('Promotion not found');
        if (userId && role) {
            if (role === client_1.UserRole.CREATOR) {
                const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
                if (!creator || promo.creator_id !== creator.id) {
                    throw new common_1.BadRequestException('You can only delete your own promotions');
                }
            }
            else if (role === client_1.UserRole.PROVIDER) {
                const provider = await this.prisma.provider.findUnique({ where: { user_id: userId } });
                if (!provider || promo.provider_id !== provider.id) {
                    throw new common_1.BadRequestException('You can only delete your own promotions');
                }
            }
        }
        return this.prisma.promotion.delete({ where: { id } });
    }
    async validateCoupon(dto) {
        const promo = await this.prisma.promotion.findUnique({
            where: { coupon_code: dto.coupon_code },
        });
        if (!promo) {
            throw new common_1.BadRequestException('Invalid coupon code');
        }
        if (promo.status !== 'ACTIVE') {
            throw new common_1.BadRequestException('Coupon is not active');
        }
        const now = new Date();
        if (promo.starts_at > now) {
            throw new common_1.BadRequestException('Coupon not yet valid');
        }
        if (promo.expires_at && promo.expires_at < now) {
            throw new common_1.BadRequestException('Coupon has expired');
        }
        if (promo.usage_limit && promo.usage_count >= promo.usage_limit) {
            throw new common_1.BadRequestException('Coupon usage limit reached');
        }
        const conditions = promo.conditions;
        if (conditions?.min_amount && dto.subtotal && dto.subtotal < conditions.min_amount) {
            throw new common_1.BadRequestException(`Minimum order amount is ${conditions.min_amount}`);
        }
        if (conditions?.min_quantity && dto.item_count && dto.item_count < conditions.min_quantity) {
            throw new common_1.BadRequestException(`Minimum ${conditions.min_quantity} items required`);
        }
        if (conditions?.product_ids?.length > 0 && dto.product_ids?.length) {
            const hasMatch = dto.product_ids.some((pid) => conditions.product_ids.includes(pid));
            if (!hasMatch) {
                throw new common_1.BadRequestException('This coupon does not apply to the products in your cart');
            }
        }
        let discount = 0;
        if (promo.type === 'PERCENTAGE' || promo.type === 'COUPON') {
            discount = (dto.subtotal || 0) * (Number(promo.value) / 100);
        }
        else if (promo.type === 'FIXED_AMOUNT') {
            discount = Number(promo.value);
        }
        else if (promo.type === 'FREE_SHIPPING') {
            discount = 0;
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
    async recordUsage(promotionId, orderId, userId, discountAmount) {
        await this.prisma.promotionUsage.create({
            data: {
                promotion_id: promotionId,
                order_id: orderId,
                user_id: userId,
                discount_amount: discountAmount,
            },
        });
        await this.prisma.promotion.update({
            where: { id: promotionId },
            data: { usage_count: { increment: 1 } },
        });
    }
};
exports.PromotionsService = PromotionsService;
exports.PromotionsService = PromotionsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], PromotionsService);
//# sourceMappingURL=promotions.service.js.map