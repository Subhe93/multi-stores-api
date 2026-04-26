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
exports.ProductsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const client_1 = require("@prisma/client");
let ProductsService = class ProductsService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    productIncludes = {
        translations: true,
        images: { orderBy: { sort_order: 'asc' } },
        attributes: {
            include: { template: { include: { translations: true } } },
        },
        variants: true,
        tags: true,
        custom_fields: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
        faqs: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
        category: { include: { translations: true } },
        shipping_profile: { include: { zones: true } },
    };
    async create(userId, userRole, dto) {
        const { translations, attributes, tags, ...data } = dto;
        const productData = {
            ...data,
            translations: { create: translations },
        };
        if (userRole === client_1.UserRole.PROVIDER) {
            const provider = await this.prisma.provider.findUnique({
                where: { user_id: userId },
            });
            if (!provider)
                throw new common_1.NotFoundException('Provider profile not found');
            productData.provider_id = provider.id;
        }
        else if (userRole === client_1.UserRole.CREATOR) {
            const creator = await this.prisma.creator.findUnique({
                where: { user_id: userId },
            });
            if (!creator)
                throw new common_1.NotFoundException('Creator profile not found');
            productData.creator_id = creator.id;
        }
        const product = await this.prisma.product.create({
            data: productData,
            include: this.productIncludes,
        });
        if (attributes?.length) {
            await this.prisma.productAttribute.createMany({
                data: attributes.map((attr) => ({
                    product_id: product.id,
                    template_id: attr.template_id,
                    value: attr.value,
                })),
            });
        }
        if (tags?.length) {
            await this.prisma.productTag.createMany({
                data: tags.map((tag) => ({
                    product_id: product.id,
                    tag,
                })),
            });
        }
        return this.findById(product.id);
    }
    async findAll(filters) {
        const { page = 1, limit = 20, ...rest } = filters;
        const skip = (page - 1) * limit;
        const where = {};
        if (rest.category_id)
            where.category_id = rest.category_id;
        if (rest.product_type)
            where.product_type = rest.product_type;
        if (rest.status)
            where.status = rest.status;
        if (rest.provider_id)
            where.provider_id = rest.provider_id;
        if (rest.creator_id)
            where.creator_id = rest.creator_id;
        if (rest.is_featured !== undefined)
            where.is_featured = rest.is_featured;
        if (rest.search) {
            where.translations = {
                some: {
                    title: { contains: rest.search, mode: 'insensitive' },
                },
            };
        }
        const [data, total] = await Promise.all([
            this.prisma.product.findMany({
                skip,
                take: limit,
                where,
                include: {
                    translations: true,
                    images: { take: 1, orderBy: { sort_order: 'asc' } },
                    category: { include: { translations: true } },
                    variants: true,
                    provider: { select: { id: true, company_name: true } },
                },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.product.count({ where }),
        ]);
        return {
            data,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        };
    }
    async findById(id) {
        const product = await this.prisma.product.findUnique({
            where: { id },
            include: this.productIncludes,
        });
        if (!product)
            throw new common_1.NotFoundException('Product not found');
        return product;
    }
    async update(id, userId, userRole, dto) {
        const product = await this.prisma.product.findUnique({ where: { id } });
        if (!product)
            throw new common_1.NotFoundException('Product not found');
        await this.checkOwnership(product, userId, userRole);
        const { translations, attributes, tags, ...data } = dto;
        await this.prisma.product.update({
            where: { id },
            data,
        });
        if (translations) {
            await this.prisma.productTranslation.deleteMany({
                where: { product_id: id },
            });
            await this.prisma.productTranslation.createMany({
                data: translations.map((t) => ({ ...t, product_id: id })),
            });
        }
        if (attributes) {
            await this.prisma.productAttribute.deleteMany({
                where: { product_id: id },
            });
            await this.prisma.productAttribute.createMany({
                data: attributes.map((attr) => ({
                    product_id: id,
                    template_id: attr.template_id,
                    value: attr.value,
                })),
            });
        }
        if (tags) {
            await this.prisma.productTag.deleteMany({
                where: { product_id: id },
            });
            await this.prisma.productTag.createMany({
                data: tags.map((tag) => ({ product_id: id, tag })),
            });
        }
        return this.findById(id);
    }
    async delete(id, userId, userRole) {
        const product = await this.prisma.product.findUnique({ where: { id } });
        if (!product)
            throw new common_1.NotFoundException('Product not found');
        await this.checkOwnership(product, userId, userRole);
        return this.prisma.product.delete({ where: { id } });
    }
    async updateStatus(id, status, userId, userRole) {
        const product = await this.prisma.product.findUnique({ where: { id } });
        if (!product)
            throw new common_1.NotFoundException('Product not found');
        await this.checkOwnership(product, userId, userRole);
        return this.prisma.product.update({
            where: { id },
            data: { status },
        });
    }
    async addImage(productId, url, altText, sortOrder, isFeatured, variantId) {
        if (isFeatured) {
            await this.prisma.productImage.updateMany({
                where: { product_id: productId },
                data: { is_featured: false },
            });
        }
        return this.prisma.productImage.create({
            data: { product_id: productId, url, alt_text: altText, sort_order: sortOrder ?? 0, is_featured: isFeatured ?? false, variant_id: variantId },
        });
    }
    async getImages(productId) {
        return this.prisma.productImage.findMany({
            where: { product_id: productId },
            orderBy: { sort_order: 'asc' },
        });
    }
    async deleteImage(imageId) {
        return this.prisma.productImage.delete({ where: { id: imageId } });
    }
    async reorderImages(productId, imageIds) {
        const updates = imageIds.map((id, i) => this.prisma.productImage.update({ where: { id }, data: { sort_order: i } }));
        await Promise.all(updates);
        return this.getImages(productId);
    }
    async getImportDetails(id) {
        const product = await this.prisma.product.findUnique({
            where: { id },
            include: {
                translations: true,
                images: { orderBy: { sort_order: 'asc' } },
                attributes: {
                    include: { template: { include: { translations: true } } },
                },
                variants: { where: { is_active: true }, include: { images: true } },
                tags: true,
                custom_fields: {
                    include: { translations: true },
                    orderBy: { sort_order: 'asc' },
                },
                faqs: {
                    include: { translations: true },
                    orderBy: { sort_order: 'asc' },
                },
                category: { include: { translations: true } },
                provider: { select: { id: true, company_name: true } },
                shipping_profile: { include: { zones: true } },
            },
        });
        if (!product)
            throw new common_1.NotFoundException('Product not found');
        if (!product.shipping_profile && product.provider_id) {
            const defaultProfile = await this.prisma.shippingProfile.findFirst({
                where: { provider_id: product.provider_id, is_default: true },
                include: { zones: true },
            });
            if (defaultProfile) {
                return { ...product, shipping_profile: defaultProfile };
            }
        }
        return product;
    }
    async checkOwnership(product, userId, userRole) {
        if (userRole === client_1.UserRole.ADMIN)
            return;
        if (userRole === client_1.UserRole.PROVIDER) {
            const provider = await this.prisma.provider.findUnique({
                where: { user_id: userId },
            });
            if (product.provider_id !== provider?.id) {
                throw new common_1.ForbiddenException('Not your product');
            }
        }
        if (userRole === client_1.UserRole.CREATOR) {
            const creator = await this.prisma.creator.findUnique({
                where: { user_id: userId },
            });
            if (product.creator_id !== creator?.id) {
                throw new common_1.ForbiddenException('Not your product');
            }
        }
    }
};
exports.ProductsService = ProductsService;
exports.ProductsService = ProductsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], ProductsService);
//# sourceMappingURL=products.service.js.map