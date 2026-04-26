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
exports.CustomProductsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const client_1 = require("@prisma/client");
const notifications_service_1 = require("../notifications/notifications.service");
let CustomProductsService = class CustomProductsService {
    prisma;
    notificationsService;
    constructor(prisma, notificationsService) {
        this.prisma = prisma;
        this.notificationsService = notificationsService;
    }
    async assertCreatorOwns(customProductId, userId) {
        const cp = await this.prisma.customProduct.findUnique({
            where: { id: customProductId },
            include: { creator: { select: { user_id: true } } },
        });
        if (!cp)
            throw new common_1.NotFoundException('Custom product not found');
        if (cp.creator.user_id !== userId) {
            throw new common_1.ForbiddenException('You do not own this custom product');
        }
        return cp;
    }
    async assertProviderOwnsBase(customProductId, userId) {
        const cp = await this.prisma.customProduct.findUnique({
            where: { id: customProductId },
            include: {
                product: { include: { provider: { select: { user_id: true } } } },
                creator: { select: { user_id: true } },
                translations: true,
            },
        });
        if (!cp)
            throw new common_1.NotFoundException('Custom product not found');
        if (!cp.product.provider || cp.product.provider.user_id !== userId) {
            throw new common_1.ForbiddenException('You do not own this base product');
        }
        return cp;
    }
    includes = {
        product: {
            include: {
                translations: true,
                images: { orderBy: { sort_order: 'asc' } },
                variants: { where: { is_active: true } },
                custom_fields: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
            },
        },
        mockup_images: true,
        translations: true,
        creator: { select: { display_name: true } },
        selected_variants: { include: { variant: true } },
        field_values: { include: { custom_field: true } },
        faqs: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
    };
    async create(userId, dto) {
        const creator = await this.prisma.creator.findUnique({
            where: { user_id: userId },
        });
        if (!creator)
            throw new common_1.NotFoundException('Creator not found');
        this.validatePricing(dto.pricing_type, dto);
        const { translations, selected_variants, field_values, mockup_image_urls, ...data } = dto;
        let variantRows = [];
        if (dto.import_mode === client_1.ImportMode.AS_IS) {
            const product = await this.prisma.product.findUnique({
                where: { id: dto.product_id },
                include: { variants: { where: { is_active: true } } },
            });
            if (!product)
                throw new common_1.NotFoundException('Product not found');
            variantRows = product.variants.map((v) => ({
                variant_id: v.id,
                custom_price: dto.pricing_type === client_1.PricingType.PER_VARIANT
                    ? selected_variants?.find((sv) => sv.variant_id === v.id)
                        ?.custom_price
                    : undefined,
            }));
        }
        else {
            const product = await this.prisma.product.findUnique({
                where: { id: dto.product_id },
                include: { variants: { where: { is_active: true } } },
            });
            if (!product)
                throw new common_1.NotFoundException('Product not found');
            if (product.variants.length > 0) {
                if (!selected_variants || selected_variants.length === 0) {
                    throw new common_1.BadRequestException('At least one variant must be selected in CUSTOMIZE mode');
                }
                const validVariantIds = new Set(product.variants.map((v) => v.id));
                for (const sv of selected_variants) {
                    if (!validVariantIds.has(sv.variant_id)) {
                        throw new common_1.BadRequestException(`Variant ${sv.variant_id} does not belong to product ${dto.product_id}`);
                    }
                }
                variantRows = selected_variants.map((sv) => ({
                    variant_id: sv.variant_id,
                    custom_price: sv.custom_price,
                }));
            }
        }
        return this.prisma.customProduct.create({
            data: {
                product_id: data.product_id,
                creator_id: creator.id,
                import_mode: data.import_mode,
                pricing_type: data.pricing_type,
                final_price: data.final_price ?? 0,
                margin_amount: data.margin_amount,
                translations: { create: translations },
                selected_variants: {
                    create: variantRows,
                },
                ...(mockup_image_urls &&
                    mockup_image_urls.length > 0 && {
                    mockup_images: {
                        create: mockup_image_urls.map((url, i) => ({
                            url,
                            sort_order: i,
                        })),
                    },
                }),
                ...(field_values &&
                    field_values.length > 0 && {
                    field_values: {
                        create: field_values.map((fv) => ({
                            custom_field_id: fv.custom_field_id,
                            value: fv.value,
                            file_url: fv.file_url,
                        })),
                    },
                }),
            },
            include: this.includes,
        });
    }
    async findByCreator(userId, page = 1, limit = 20) {
        const creator = await this.prisma.creator.findUnique({
            where: { user_id: userId },
        });
        if (!creator)
            throw new common_1.NotFoundException('Creator not found');
        const skip = (page - 1) * limit;
        const [data, total] = await Promise.all([
            this.prisma.customProduct.findMany({
                where: { creator_id: creator.id },
                skip,
                take: limit,
                include: this.includes,
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.customProduct.count({
                where: { creator_id: creator.id },
            }),
        ]);
        return {
            data,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        };
    }
    async findById(id) {
        const cp = await this.prisma.customProduct.findUnique({
            where: { id },
            include: this.includes,
        });
        if (!cp)
            throw new common_1.NotFoundException('Custom product not found');
        return cp;
    }
    async update(id, dto, userId) {
        const existing = await this.prisma.customProduct.findUnique({
            where: { id },
            include: { creator: { select: { user_id: true } }, product: { select: { provider_id: true } } },
        });
        if (!existing)
            throw new common_1.NotFoundException('Custom product not found');
        if (userId && existing.creator.user_id !== userId) {
            throw new common_1.ForbiddenException('You do not own this custom product');
        }
        const isContentEdit = dto.translations !== undefined ||
            dto.mockup_image_urls !== undefined ||
            dto.field_values !== undefined ||
            dto.selected_variants !== undefined ||
            dto.pricing_type !== undefined ||
            dto.final_price !== undefined ||
            dto.margin_amount !== undefined;
        let autoRevertedToReview = false;
        if (isContentEdit &&
            existing.status === client_1.ProductStatus.PUBLISHED &&
            existing.product.provider_id) {
            dto.status = client_1.ProductStatus.PENDING_REVIEW;
            autoRevertedToReview = true;
        }
        if (existing.status === client_1.ProductStatus.PENDING_REVIEW &&
            dto.status === client_1.ProductStatus.PUBLISHED &&
            existing.product.provider_id) {
            throw new common_1.ForbiddenException('Cannot publish a product that is awaiting provider review');
        }
        if (isContentEdit &&
            existing.status === client_1.ProductStatus.REJECTED &&
            existing.product.provider_id &&
            dto.status === client_1.ProductStatus.PUBLISHED) {
            throw new common_1.ForbiddenException('Cannot publish a rejected product without resubmitting for review');
        }
        const pricingType = dto.pricing_type ?? existing.pricing_type;
        if (dto.pricing_type || dto.final_price !== undefined || dto.margin_amount !== undefined) {
            this.validatePricing(pricingType, {
                final_price: dto.final_price ?? Number(existing.final_price),
                margin_amount: dto.margin_amount ?? (existing.margin_amount ? Number(existing.margin_amount) : undefined),
                selected_variants: dto.selected_variants,
                pricing_type: pricingType,
            });
        }
        const { translations, selected_variants, field_values, mockup_image_urls, ...data } = dto;
        if (selected_variants) {
            await this.prisma.customProductVariant.deleteMany({
                where: { custom_product_id: id },
            });
        }
        if (field_values) {
            await this.prisma.customProductFieldValue.deleteMany({
                where: { custom_product_id: id },
            });
        }
        if (mockup_image_urls) {
            await this.prisma.customProductImage.deleteMany({
                where: { custom_product_id: id },
            });
        }
        if (translations && translations.length > 0) {
            await this.prisma.customProductTranslation.deleteMany({
                where: { custom_product_id: id },
            });
        }
        const updated = await this.prisma.customProduct.update({
            where: { id },
            data: {
                ...data,
                ...(translations &&
                    translations.length > 0 && {
                    translations: { create: translations },
                }),
                ...(selected_variants && {
                    selected_variants: {
                        create: selected_variants.map((sv) => ({
                            variant_id: sv.variant_id,
                            custom_price: sv.custom_price,
                        })),
                    },
                }),
                ...(field_values && {
                    field_values: {
                        create: field_values.map((fv) => ({
                            custom_field_id: fv.custom_field_id,
                            value: fv.value,
                            file_url: fv.file_url,
                        })),
                    },
                }),
                ...(mockup_image_urls && {
                    mockup_images: {
                        create: mockup_image_urls.map((url, i) => ({
                            url,
                            sort_order: i,
                        })),
                    },
                }),
            },
            include: this.includes,
        });
        if (autoRevertedToReview && existing.product.provider_id) {
            await this.notifyProviderOfSubmission(updated.id, 'CUSTOM_PRODUCT_RESUBMITTED');
        }
        return updated;
    }
    async delete(id, userId) {
        if (userId)
            await this.assertCreatorOwns(id, userId);
        return this.prisma.customProduct.delete({ where: { id } });
    }
    async submitForReview(id, userId) {
        const cp = await this.assertCreatorOwns(id, userId);
        if (cp.status !== client_1.ProductStatus.DRAFT && cp.status !== client_1.ProductStatus.REJECTED) {
            throw new common_1.BadRequestException(`Cannot submit a custom product with status ${cp.status}`);
        }
        const product = await this.prisma.product.findUnique({
            where: { id: cp.product_id },
            select: { provider_id: true },
        });
        if (!product?.provider_id) {
            return this.prisma.customProduct.update({
                where: { id },
                data: {
                    status: client_1.ProductStatus.PUBLISHED,
                    rejection_reason: null,
                    submitted_at: new Date(),
                },
                include: this.includes,
            });
        }
        const updated = await this.prisma.customProduct.update({
            where: { id },
            data: {
                status: client_1.ProductStatus.PENDING_REVIEW,
                rejection_reason: null,
                submitted_at: new Date(),
            },
            include: this.includes,
        });
        await this.notifyProviderOfSubmission(id, 'CUSTOM_PRODUCT_SUBMITTED');
        return updated;
    }
    async approve(id, userId) {
        const cp = await this.assertProviderOwnsBase(id, userId);
        if (cp.status !== client_1.ProductStatus.PENDING_REVIEW) {
            throw new common_1.BadRequestException(`Cannot approve a custom product with status ${cp.status}`);
        }
        const updated = await this.prisma.customProduct.update({
            where: { id },
            data: {
                status: client_1.ProductStatus.PUBLISHED,
                rejection_reason: null,
                reviewed_at: new Date(),
                reviewed_by: userId,
            },
            include: this.includes,
        });
        const title = cp.translations?.[0]?.title || 'Your custom product';
        await this.notificationsService.create(cp.creator.user_id, 'CUSTOM_PRODUCT_APPROVED', 'Custom product approved', `${title} has been approved and is now live`, { custom_product_id: id });
        return updated;
    }
    async reject(id, userId, reason) {
        if (!reason || !reason.trim()) {
            throw new common_1.BadRequestException('Rejection reason is required');
        }
        const cp = await this.assertProviderOwnsBase(id, userId);
        if (cp.status !== client_1.ProductStatus.PENDING_REVIEW) {
            throw new common_1.BadRequestException(`Cannot reject a custom product with status ${cp.status}`);
        }
        const updated = await this.prisma.customProduct.update({
            where: { id },
            data: {
                status: client_1.ProductStatus.REJECTED,
                rejection_reason: reason.trim(),
                reviewed_at: new Date(),
                reviewed_by: userId,
            },
            include: this.includes,
        });
        const title = cp.translations?.[0]?.title || 'Your custom product';
        await this.notificationsService.create(cp.creator.user_id, 'CUSTOM_PRODUCT_REJECTED', 'Custom product needs changes', `${title} was rejected: ${reason.trim()}`, { custom_product_id: id, reason: reason.trim() });
        return updated;
    }
    async findPendingReviewsForProvider(userId, page = 1, limit = 20) {
        const provider = await this.prisma.provider.findUnique({
            where: { user_id: userId },
        });
        if (!provider)
            throw new common_1.NotFoundException('Provider not found');
        const skip = (page - 1) * limit;
        const where = {
            status: client_1.ProductStatus.PENDING_REVIEW,
            product: { provider_id: provider.id },
        };
        const [data, total] = await Promise.all([
            this.prisma.customProduct.findMany({
                where,
                skip,
                take: limit,
                include: this.includes,
                orderBy: { submitted_at: 'asc' },
            }),
            this.prisma.customProduct.count({ where }),
        ]);
        return {
            data,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        };
    }
    async notifyProviderOfSubmission(customProductId, type) {
        const cp = await this.prisma.customProduct.findUnique({
            where: { id: customProductId },
            include: {
                product: { include: { provider: { select: { user_id: true } } } },
                translations: true,
                creator: { select: { display_name: true } },
            },
        });
        if (!cp?.product.provider)
            return;
        const title = cp.translations?.[0]?.title || 'A custom product';
        const creatorName = cp.creator.display_name || 'A creator';
        const isResubmit = type === 'CUSTOM_PRODUCT_RESUBMITTED';
        await this.notificationsService.create(cp.product.provider.user_id, type, isResubmit ? 'Custom product re-submitted' : 'New custom product to review', `${creatorName} ${isResubmit ? 'updated' : 'submitted'} "${title}" for your review`, { custom_product_id: customProductId });
    }
    async createFaq(customProductId, dto) {
        return this.prisma.customProductFaq.create({
            data: {
                custom_product_id: customProductId,
                sort_order: dto.sort_order ?? 0,
                translations: { create: dto.translations },
            },
            include: { translations: true },
        });
    }
    async findFaqs(customProductId) {
        return this.prisma.customProductFaq.findMany({
            where: { custom_product_id: customProductId },
            include: { translations: true },
            orderBy: { sort_order: 'asc' },
        });
    }
    async updateFaq(faqId, dto) {
        const faq = await this.prisma.customProductFaq.findUnique({ where: { id: faqId } });
        if (!faq)
            throw new common_1.NotFoundException('FAQ not found');
        if (dto.translations && dto.translations.length > 0) {
            await this.prisma.customProductFaqTranslation.deleteMany({ where: { faq_id: faqId } });
        }
        return this.prisma.customProductFaq.update({
            where: { id: faqId },
            data: {
                ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }),
                ...(dto.translations && dto.translations.length > 0 && {
                    translations: { create: dto.translations },
                }),
            },
            include: { translations: true },
        });
    }
    async deleteFaq(faqId) {
        return this.prisma.customProductFaq.delete({ where: { id: faqId } });
    }
    validatePricing(pricingType, data) {
        switch (pricingType) {
            case client_1.PricingType.SINGLE:
                if (data.final_price === undefined || data.final_price === null) {
                    throw new common_1.BadRequestException('final_price is required when pricing_type is SINGLE');
                }
                break;
            case client_1.PricingType.MARGIN:
                if (data.margin_amount === undefined || data.margin_amount === null) {
                    throw new common_1.BadRequestException('margin_amount is required when pricing_type is MARGIN');
                }
                break;
            case client_1.PricingType.PER_VARIANT:
                if (data.selected_variants) {
                    const missing = data.selected_variants.filter((sv) => sv.custom_price === undefined || sv.custom_price === null);
                    if (missing.length > 0) {
                        throw new common_1.BadRequestException('custom_price is required for each variant when pricing_type is PER_VARIANT');
                    }
                }
                break;
        }
    }
};
exports.CustomProductsService = CustomProductsService;
exports.CustomProductsService = CustomProductsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        notifications_service_1.NotificationsService])
], CustomProductsService);
//# sourceMappingURL=custom-products.service.js.map