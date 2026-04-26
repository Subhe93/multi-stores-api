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
exports.StorefrontService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const client_1 = require("@prisma/client");
let StorefrontService = class StorefrontService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getStore(slug) {
        const store = await this.prisma.store.findUnique({
            where: { slug, is_active: true },
            include: {
                language_config: true,
                static_pages: {
                    where: { status: 'PUBLISHED' },
                    include: { translations: { select: { locale: true, title: true } } },
                    orderBy: { sort_order: 'asc' },
                },
                creator: {
                    select: { display_name: true, avatar_url: true, bio: true, cover_url: true },
                },
            },
        });
        if (!store)
            throw new common_1.NotFoundException('Store not found');
        const themeConfig = store.theme_config || {};
        const platformConfig = await this.prisma.platformConfig.findFirst();
        return {
            ...store,
            currency: platformConfig?.default_currency || 'EUR',
            pages: store.static_pages,
            theme: {
                primaryColor: themeConfig.primaryColor || '#2563eb',
                secondaryColor: themeConfig.secondaryColor || '#1e40af',
                fontFamily: themeConfig.fontFamily || undefined,
                socials: themeConfig.socials || {},
                contact: themeConfig.contact || {},
                seo: themeConfig.seo || {},
                translations: themeConfig.translations || {},
            },
        };
    }
    async getProducts(slug, filters) {
        const store = await this.prisma.store.findUnique({
            where: { slug },
            include: { creator: true },
        });
        if (!store)
            throw new common_1.NotFoundException('Store not found');
        const ownWhere = {
            creator_id: store.creator.id,
            status: 'PUBLISHED',
        };
        if (filters.category_id)
            ownWhere.category_id = filters.category_id;
        if (filters.search) {
            ownWhere.translations = {
                some: { title: { contains: filters.search, mode: 'insensitive' } },
            };
        }
        const customWhere = {
            creator_id: store.creator.id,
            status: 'PUBLISHED',
        };
        if (filters.category_id) {
            customWhere.product = { category_id: filters.category_id };
        }
        if (filters.search) {
            customWhere.translations = {
                some: { title: { contains: filters.search, mode: 'insensitive' } },
            };
        }
        const [ownProducts, customProducts] = await Promise.all([
            this.prisma.product.findMany({
                where: ownWhere,
                include: {
                    translations: true,
                    images: { take: 1, orderBy: { sort_order: 'asc' } },
                    variants: { where: { is_active: true } },
                    category: { include: { translations: true } },
                },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.customProduct.findMany({
                where: customWhere,
                include: {
                    translations: true,
                    mockup_images: { take: 1, orderBy: { sort_order: 'asc' } },
                    selected_variants: { include: { variant: true } },
                    product: {
                        include: {
                            images: { take: 1, orderBy: { sort_order: 'asc' } },
                            variants: { where: { is_active: true } },
                            category: { include: { translations: true } },
                        },
                    },
                },
                orderBy: { created_at: 'desc' },
            }),
        ]);
        const mappedCustom = customProducts.map((cp) => {
            const variants = this.computeVariants(cp);
            const displayPrice = this.computeDisplayPrice(cp, variants);
            return {
                id: cp.id,
                base_price: displayPrice,
                status: cp.status,
                translations: cp.translations,
                images: cp.mockup_images.length > 0
                    ? cp.mockup_images.map((img) => ({ url: img.url, alt_text: null, sort_order: img.sort_order }))
                    : cp.product.images,
                variants,
                category: cp.product.category,
                pricing_type: cp.pricing_type,
                _type: 'custom_product',
            };
        });
        const mappedOwn = ownProducts.map((p) => ({
            ...p,
            base_price: Number(p.base_price),
            compare_at_price: p.compare_at_price ? Number(p.compare_at_price) : undefined,
            variants: (p.variants || []).map((v) => ({
                ...v,
                price: Number(p.base_price) + Number(v.price_adjustment || 0),
                compare_at_price: v.compare_at_price ? Number(v.compare_at_price) : undefined,
                stock: v.stock_quantity ?? 999,
            })),
        }));
        const now = new Date();
        const allPromos = await this.prisma.promotion.findMany({
            where: {
                creator_id: store.creator.id,
                level: 'CREATOR_TO_CUSTOMER',
                status: 'ACTIVE',
                starts_at: { lte: now },
                type: { notIn: ['COUPON'] },
                OR: [{ expires_at: null }, { expires_at: { gte: now } }],
            },
            include: { translations: true },
        });
        const attachPromos = (productId) => allPromos.filter((p) => {
            const conds = p.conditions;
            if (!conds?.product_ids?.length)
                return true;
            return conds.product_ids.includes(productId);
        }).map((p) => ({
            id: p.id,
            type: p.type,
            value: Number(p.value),
            translations: p.translations,
        }));
        const ownWithPromos = mappedOwn.map((p) => ({ ...p, promotions: attachPromos(p.id) }));
        const customWithPromos = mappedCustom.map((p) => ({ ...p, promotions: attachPromos(p.id) }));
        return [...ownWithPromos, ...customWithPromos];
    }
    async getActivePromotionsForProduct(creatorId, productId) {
        const now = new Date();
        const promotions = await this.prisma.promotion.findMany({
            where: {
                creator_id: creatorId,
                level: 'CREATOR_TO_CUSTOMER',
                status: 'ACTIVE',
                starts_at: { lte: now },
                OR: [
                    { expires_at: null },
                    { expires_at: { gte: now } },
                ],
                type: { notIn: ['COUPON'] },
            },
            include: { translations: true },
        });
        return promotions.filter((p) => {
            const conds = p.conditions;
            if (!conds?.product_ids?.length)
                return true;
            return conds.product_ids.includes(productId);
        }).map((p) => ({
            id: p.id,
            type: p.type,
            value: Number(p.value),
            conditions: p.conditions,
            starts_at: p.starts_at,
            expires_at: p.expires_at,
            translations: p.translations,
        }));
    }
    async getProduct(slug, productSlug, locale) {
        const store = await this.prisma.store.findUnique({
            where: { slug },
            include: { creator: true },
        });
        if (!store)
            throw new common_1.NotFoundException('Store not found');
        const product = await this.prisma.product.findFirst({
            where: {
                creator_id: store.creator.id,
                status: 'PUBLISHED',
                translations: { some: { slug: productSlug } },
            },
            include: {
                translations: true,
                images: { orderBy: { sort_order: 'asc' } },
                attributes: {
                    include: { template: { include: { translations: true } } },
                },
                variants: { where: { is_active: true }, include: { images: true } },
                tags: true,
                category: { include: { translations: true } },
                custom_fields: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
                faqs: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
                shipping_profile: { include: { zones: true } },
            },
        });
        if (product) {
            const prodBasePrice = Number(product.base_price);
            let shippingProfile = product.shipping_profile;
            if (!shippingProfile && product.provider_id) {
                const defaultProfile = await this.prisma.shippingProfile.findFirst({
                    where: { provider_id: product.provider_id, is_default: true },
                    include: { zones: true },
                });
                if (defaultProfile)
                    shippingProfile = defaultProfile;
            }
            const promotions = await this.getActivePromotionsForProduct(store.creator.id, product.id);
            return {
                ...product,
                shipping_profile: shippingProfile,
                base_price: prodBasePrice,
                compare_at_price: product.compare_at_price ? Number(product.compare_at_price) : undefined,
                variants: (product.variants || []).map((v) => ({
                    ...v,
                    price: prodBasePrice + Number(v.price_adjustment || 0),
                    compare_at_price: v.compare_at_price ? Number(v.compare_at_price) : undefined,
                    stock: v.stock_quantity ?? 999,
                })),
                promotions,
            };
        }
        const customProduct = await this.prisma.customProduct.findFirst({
            where: {
                creator_id: store.creator.id,
                status: 'PUBLISHED',
                translations: { some: { slug: productSlug } },
            },
            include: {
                translations: true,
                mockup_images: { orderBy: { sort_order: 'asc' } },
                selected_variants: { include: { variant: { include: { images: true } } } },
                field_values: { include: { custom_field: { include: { translations: true } } } },
                faqs: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
                product: {
                    include: {
                        images: { orderBy: { sort_order: 'asc' } },
                        attributes: { include: { template: { include: { translations: true } } } },
                        variants: { where: { is_active: true }, include: { images: true } },
                        tags: true,
                        category: { include: { translations: true } },
                        custom_fields: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
                        faqs: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
                        shipping_profile: { include: { zones: true } },
                    },
                },
            },
        });
        if (!customProduct)
            throw new common_1.NotFoundException('Product not found');
        const variants = this.computeVariants(customProduct);
        const displayPrice = this.computeDisplayPrice(customProduct, variants);
        const prefilledFieldIds = new Set(customProduct.field_values.map((fv) => fv.custom_field_id));
        const customerFields = customProduct.product.custom_fields.filter((cf) => !prefilledFieldIds.has(cf.id));
        const baseProduct = customProduct.product;
        let shippingProfile = baseProduct.shipping_profile;
        if (!shippingProfile && baseProduct.provider_id) {
            const defaultProfile = await this.prisma.shippingProfile.findFirst({
                where: { provider_id: baseProduct.provider_id, is_default: true },
                include: { zones: true },
            });
            if (defaultProfile)
                shippingProfile = defaultProfile;
        }
        const promotions = await this.getActivePromotionsForProduct(store.creator.id, customProduct.id);
        return {
            id: customProduct.id,
            base_price: displayPrice,
            compare_at_price: baseProduct.compare_at_price ? Number(baseProduct.compare_at_price) : undefined,
            status: customProduct.status,
            product_type: baseProduct.product_type,
            customization_type: baseProduct.customization_type,
            variant_option_config: baseProduct.variant_option_config,
            translations: customProduct.translations,
            images: customProduct.mockup_images.length > 0
                ? customProduct.mockup_images.map((img) => ({ url: img.url, alt_text: null, sort_order: img.sort_order }))
                : baseProduct.images,
            attributes: baseProduct.attributes,
            variants,
            tags: baseProduct.tags,
            category: baseProduct.category,
            custom_fields: customerFields,
            faqs: [...(customProduct.faqs || []), ...baseProduct.faqs],
            field_values: customProduct.field_values,
            pricing_type: customProduct.pricing_type,
            shipping_profile: shippingProfile,
            promotions,
            _type: 'custom_product',
        };
    }
    async getCategories(slug) {
        const store = await this.prisma.store.findUnique({
            where: { slug },
            include: { creator: true },
        });
        if (!store)
            throw new common_1.NotFoundException('Store not found');
        const [ownCategories, customCategories] = await Promise.all([
            this.prisma.category.findMany({
                where: {
                    products: {
                        some: { creator_id: store.creator.id, status: 'PUBLISHED' },
                    },
                },
                include: { translations: true },
                orderBy: { sort_order: 'asc' },
            }),
            this.prisma.category.findMany({
                where: {
                    products: {
                        some: {
                            custom_products: {
                                some: { creator_id: store.creator.id, status: 'PUBLISHED' },
                            },
                        },
                    },
                },
                include: { translations: true },
                orderBy: { sort_order: 'asc' },
            }),
        ]);
        const seen = new Set();
        const categories = [...ownCategories, ...customCategories].filter((c) => {
            if (seen.has(c.id))
                return false;
            seen.add(c.id);
            return true;
        });
        return categories;
    }
    async getPage(slug, pageSlug) {
        const store = await this.prisma.store.findUnique({ where: { slug } });
        if (!store)
            throw new common_1.NotFoundException('Store not found');
        const page = await this.prisma.staticPage.findUnique({
            where: {
                store_id_slug: { store_id: store.id, slug: pageSlug },
            },
            include: { translations: true },
        });
        if (!page || page.status !== 'PUBLISHED') {
            throw new common_1.NotFoundException('Page not found');
        }
        return page;
    }
    computeVariants(cp) {
        const hasSelectedVariants = cp.selected_variants && cp.selected_variants.length > 0;
        const sourceVariants = hasSelectedVariants
            ? cp.selected_variants.map((sv) => ({
                ...sv.variant,
                _custom_price: sv.custom_price ? Number(sv.custom_price) : undefined,
            }))
            : cp.product.variants || [];
        return sourceVariants.map((v) => {
            const price = this.computeVariantPrice(cp, v);
            return {
                ...v,
                _custom_price: undefined,
                price,
                compare_at_price: v.compare_at_price
                    ? Number(v.compare_at_price)
                    : undefined,
                stock: v.stock_quantity ?? 999,
            };
        });
    }
    computeVariantPrice(cp, variant) {
        switch (cp.pricing_type) {
            case client_1.PricingType.SINGLE:
                return Number(cp.final_price) + Number(variant.price_adjustment || 0);
            case client_1.PricingType.PER_VARIANT:
                if (variant._custom_price !== undefined) {
                    return variant._custom_price;
                }
                const sv = cp.selected_variants?.find((s) => s.variant_id === variant.id);
                return sv?.custom_price
                    ? Number(sv.custom_price)
                    : Number(cp.product.base_price) +
                        Number(variant.price_adjustment || 0);
            case client_1.PricingType.MARGIN:
                return (Number(cp.product.base_price) +
                    Number(variant.price_adjustment || 0) +
                    Number(cp.margin_amount || 0));
            default:
                return Number(cp.final_price) + Number(variant.price_adjustment || 0);
        }
    }
    computeDisplayPrice(cp, variants) {
        if (cp.pricing_type === client_1.PricingType.SINGLE) {
            return Number(cp.final_price);
        }
        if (variants.length > 0) {
            return Math.min(...variants.map((v) => v.price));
        }
        return Number(cp.final_price) || 0;
    }
};
exports.StorefrontService = StorefrontService;
exports.StorefrontService = StorefrontService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], StorefrontService);
//# sourceMappingURL=storefront.service.js.map