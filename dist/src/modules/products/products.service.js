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
const revalidation_service_1 = require("../../common/revalidation/revalidation.service");
const client_1 = require("@prisma/client");
const bundles_service_1 = require("../bundles/bundles.service");
const bundle_economics_util_1 = require("../bundles/bundle-economics.util");
let ProductsService = class ProductsService {
    prisma;
    bundlesService;
    revalidation;
    constructor(prisma, bundlesService, revalidation) {
        this.prisma = prisma;
        this.bundlesService = bundlesService;
        this.revalidation = revalidation;
    }
    async revalidateForCreator(creatorId) {
        if (creatorId) {
            await this.revalidation.revalidateStoreByCreatorId(creatorId);
        }
    }
    async assertProductCompatibleWithBundles(productPricing, bundleIds) {
        if (bundleIds.length === 0)
            return;
        const bundles = await this.prisma.bundle.findMany({
            where: { id: { in: bundleIds } },
            select: {
                id: true,
                offers: {
                    select: { quantity: true, discount_type: true, discount_value: true },
                },
            },
        });
        const allViolations = [];
        for (const b of bundles) {
            const offers = b.offers.map((o) => ({
                quantity: o.quantity,
                discount_type: o.discount_type,
                discount_value: o.discount_value,
            }));
            const result = (0, bundle_economics_util_1.validateBundleEconomics)(offers, [productPricing]);
            if (!result.valid)
                allViolations.push(...result.violations);
        }
        if (allViolations.length > 0) {
            throw new common_1.BadRequestException((0, bundle_economics_util_1.formatViolationsMessage)(allViolations));
        }
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
        creator_categories: {
            include: {
                creator_category: { include: { translations: true } },
            },
        },
        bundles: {
            include: {
                bundle: {
                    include: {
                        translations: true,
                        offers: {
                            include: { translations: true },
                            orderBy: { sort_order: 'asc' },
                        },
                    },
                },
            },
        },
    };
    async attachCreatorCategories(productId, creatorId, categoryIds) {
        const owned = await this.prisma.creatorCategory.findMany({
            where: { id: { in: categoryIds }, creator_id: creatorId },
            select: { id: true },
        });
        const ownedIds = new Set(owned.map((c) => c.id));
        const toAttach = categoryIds.filter((id) => ownedIds.has(id));
        if (!toAttach.length)
            return;
        await this.prisma.productCreatorCategory.createMany({
            data: toAttach.map((creator_category_id) => ({
                product_id: productId,
                creator_category_id,
            })),
            skipDuplicates: true,
        });
    }
    async assertBundlesOwnedByCreator(bundleIds, creatorId) {
        if (bundleIds.length === 0)
            return;
        const found = await this.prisma.bundle.findMany({
            where: { id: { in: bundleIds } },
            select: { id: true, creator_id: true },
        });
        if (found.length !== bundleIds.length) {
            throw new common_1.NotFoundException('One or more bundles do not exist');
        }
        for (const b of found) {
            if (b.creator_id !== creatorId) {
                throw new common_1.ForbiddenException('You can only attach your own bundles');
            }
        }
    }
    async create(userId, userRole, dto) {
        const { translations, attributes, tags, bundle_ids, creator_category_ids, ...data } = dto;
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
        if (creator_category_ids?.length &&
            userRole === client_1.UserRole.CREATOR &&
            productData.creator_id) {
            await this.attachCreatorCategories(product.id, productData.creator_id, creator_category_ids);
        }
        if (bundle_ids?.length &&
            userRole === client_1.UserRole.CREATOR &&
            productData.creator_id) {
            await this.assertBundlesOwnedByCreator(bundle_ids, productData.creator_id);
            const base = Number(product.base_price);
            await this.assertProductCompatibleWithBundles({
                id: product.id,
                unitPrice: base,
                providerBasePrice: product.provider_id ? base : 0,
                title: product.translations?.[0]?.title,
            }, bundle_ids);
            await this.prisma.bundleProduct.createMany({
                data: bundle_ids.map((bundle_id) => ({
                    bundle_id,
                    product_id: product.id,
                })),
            });
        }
        await this.revalidateForCreator(productData.creator_id);
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
        if (rest.owner_type === 'provider')
            where.provider_id = { not: null };
        if (rest.owner_type === 'creator')
            where.creator_id = { not: null };
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
        const { translations, attributes, tags, bundle_ids, creator_category_ids, ...data } = dto;
        await this.prisma.product.update({
            where: { id },
            data,
        });
        if (creator_category_ids !== undefined &&
            userRole === client_1.UserRole.CREATOR &&
            product.creator_id) {
            await this.prisma.productCreatorCategory.deleteMany({
                where: { product_id: id },
            });
            if (creator_category_ids.length > 0) {
                await this.attachCreatorCategories(id, product.creator_id, creator_category_ids);
            }
        }
        if (bundle_ids && userRole === client_1.UserRole.CREATOR && product.creator_id) {
            await this.assertBundlesOwnedByCreator(bundle_ids, product.creator_id);
            if (bundle_ids.length > 0) {
                const nextBase = Number(data.base_price ?? product.base_price);
                const titleRow = await this.prisma.productTranslation.findFirst({
                    where: { product_id: id },
                    select: { title: true },
                });
                await this.assertProductCompatibleWithBundles({
                    id,
                    unitPrice: nextBase,
                    providerBasePrice: product.provider_id ? nextBase : 0,
                    title: titleRow?.title,
                }, bundle_ids);
            }
            await this.prisma.bundleProduct.deleteMany({
                where: { product_id: id },
            });
            if (bundle_ids.length > 0) {
                await this.prisma.bundleProduct.createMany({
                    data: bundle_ids.map((bundle_id) => ({
                        bundle_id,
                        product_id: id,
                    })),
                });
            }
        }
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
        await this.revalidateForCreator(product.creator_id);
        return this.findById(id);
    }
    async delete(id, userId, userRole) {
        const product = await this.prisma.product.findUnique({ where: { id } });
        if (!product)
            throw new common_1.NotFoundException('Product not found');
        await this.checkOwnership(product, userId, userRole);
        const deleted = await this.prisma.product.delete({ where: { id } });
        await this.revalidateForCreator(product.creator_id);
        return deleted;
    }
    async duplicate(id, userId, userRole) {
        const source = await this.prisma.product.findUnique({
            where: { id },
            include: {
                translations: true,
                images: true,
                attributes: true,
                variants: true,
                tags: true,
                custom_fields: { include: { translations: true } },
                faqs: { include: { translations: true } },
            },
        });
        if (!source)
            throw new common_1.NotFoundException('Product not found');
        await this.checkOwnership(source, userId, userRole);
        const newProduct = await this.prisma.$transaction(async (tx) => {
            const created = await tx.product.create({
                data: {
                    provider_id: source.provider_id,
                    creator_id: source.creator_id,
                    category_id: source.category_id,
                    product_type: source.product_type,
                    customization_type: source.customization_type,
                    base_price: source.base_price,
                    compare_at_price: source.compare_at_price,
                    cost_price: source.cost_price,
                    sku: null,
                    track_inventory: source.track_inventory,
                    stock_quantity: source.stock_quantity,
                    weight: source.weight,
                    weight_unit: source.weight_unit,
                    variant_option_config: source.variant_option_config ?? undefined,
                    shipping_profile_id: source.shipping_profile_id,
                    status: client_1.ProductStatus.DRAFT,
                    is_featured: false,
                },
            });
            if (source.translations.length > 0) {
                await tx.productTranslation.createMany({
                    data: source.translations.map((t) => ({
                        product_id: created.id,
                        locale: t.locale,
                        title: `${t.title} (Copy)`,
                        description: t.description,
                        slug: `${t.slug}-copy-${created.id.slice(0, 6)}`,
                        meta_title: t.meta_title,
                        meta_desc: t.meta_desc,
                    })),
                });
            }
            if (source.tags.length > 0) {
                await tx.productTag.createMany({
                    data: source.tags.map((t) => ({ product_id: created.id, tag: t.tag })),
                });
            }
            if (source.attributes.length > 0) {
                await tx.productAttribute.createMany({
                    data: source.attributes.map((a) => ({
                        product_id: created.id,
                        template_id: a.template_id,
                        value: a.value,
                    })),
                });
            }
            const variantIdMap = {};
            for (const v of source.variants) {
                const newVariant = await tx.productVariant.create({
                    data: {
                        product_id: created.id,
                        sku: null,
                        price_adjustment: v.price_adjustment,
                        compare_at_price: v.compare_at_price,
                        stock_quantity: v.stock_quantity,
                        is_active: v.is_active,
                        options: v.options,
                    },
                });
                variantIdMap[v.id] = newVariant.id;
            }
            if (source.images.length > 0) {
                await tx.productImage.createMany({
                    data: source.images.map((img) => ({
                        product_id: created.id,
                        variant_id: img.variant_id ? variantIdMap[img.variant_id] ?? null : null,
                        url: img.url,
                        alt_text: img.alt_text,
                        sort_order: img.sort_order,
                        is_featured: img.is_featured,
                    })),
                });
            }
            for (const cf of source.custom_fields) {
                await tx.productCustomField.create({
                    data: {
                        product_id: created.id,
                        name: cf.name,
                        type: cf.type,
                        is_required: cf.is_required,
                        placeholder: cf.placeholder,
                        options: cf.options,
                        validation_rules: cf.validation_rules,
                        linked_validation: cf.linked_validation,
                        sort_order: cf.sort_order,
                        translations: {
                            create: cf.translations.map((t) => ({
                                locale: t.locale,
                                label: t.label,
                                placeholder: t.placeholder,
                                option_labels: t.option_labels,
                            })),
                        },
                    },
                });
            }
            for (const f of source.faqs) {
                await tx.productFaq.create({
                    data: {
                        product_id: created.id,
                        sort_order: f.sort_order,
                        translations: {
                            create: f.translations.map((t) => ({
                                locale: t.locale,
                                question: t.question,
                                answer: t.answer,
                            })),
                        },
                    },
                });
            }
            return created;
        });
        return this.findById(newProduct.id);
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
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        bundles_service_1.BundlesService,
        revalidation_service_1.RevalidationService])
], ProductsService);
//# sourceMappingURL=products.service.js.map