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
    async getBundlesForProduct(creatorId, opts) {
        const where = {
            creator_id: creatorId,
            status: 'ACTIVE',
            OR: [],
        };
        if (opts.productId) {
            where.OR.push({ products: { some: { product_id: opts.productId } } });
        }
        if (opts.customProductId) {
            where.OR.push({
                custom_products: { some: { custom_product_id: opts.customProductId } },
            });
        }
        if (where.OR.length === 0)
            return [];
        return this.prisma.bundle.findMany({
            where,
            include: {
                translations: true,
                offers: {
                    include: { translations: true },
                    orderBy: { sort_order: 'asc' },
                },
            },
            orderBy: { updated_at: 'desc' },
        });
    }
    async getCacheConfig(slug) {
        const store = await this.prisma.store.findUnique({
            where: { slug },
            select: { cache_enabled: true },
        });
        return { enabled: store?.cache_enabled ?? true };
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
            theme_key: store.theme_key || 'minimal',
            theme_customizations: store.theme_customizations || {},
            theme: {
                primaryColor: themeConfig.primaryColor || null,
                secondaryColor: themeConfig.secondaryColor || null,
                fontFamily: themeConfig.fontFamily || undefined,
                typography: themeConfig.typography || {},
                header: themeConfig.header || {},
                templateId: themeConfig.templateId || 'default',
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
        let creatorCategory = null;
        if (filters.creator_category) {
            const cc = await this.prisma.creatorCategory.findUnique({
                where: {
                    creator_id_slug: {
                        creator_id: store.creator.id,
                        slug: filters.creator_category,
                    },
                },
                select: { id: true, match_rule: true, match_tags: true, is_active: true },
            });
            if (cc && cc.is_active) {
                creatorCategory = {
                    id: cc.id,
                    match_rule: cc.match_rule,
                    match_tags: cc.match_tags,
                };
            }
            else {
                return [];
            }
        }
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
        if (creatorCategory) {
            if (creatorCategory.match_rule === 'TAGS') {
                if (!creatorCategory.match_tags.length)
                    return [];
                ownWhere.tags = {
                    some: { tag: { in: creatorCategory.match_tags } },
                };
            }
            else {
                ownWhere.creator_categories = {
                    some: { creator_category_id: creatorCategory.id },
                };
            }
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
        if (creatorCategory) {
            if (creatorCategory.match_rule === 'TAGS') {
                customWhere.product = {
                    ...(customWhere.product || {}),
                    tags: { some: { tag: { in: creatorCategory.match_tags } } },
                };
            }
            else {
                customWhere.creator_categories = {
                    some: { creator_category_id: creatorCategory.id },
                };
            }
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
            orderBy: { updated_at: 'desc' },
            include: {
                translations: true,
                images: { orderBy: { sort_order: 'asc' } },
                attributes: {
                    include: { template: { include: { translations: true } } },
                },
                variants: { where: { is_active: true }, include: { images: true } },
                tags: true,
                category: { include: { translations: true } },
                creator_categories: {
                    include: { creator_category: { include: { translations: true } } },
                    orderBy: { sort_order: 'asc' },
                },
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
            const bundles = await this.getBundlesForProduct(store.creator.id, {
                productId: product.id,
            });
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
                creator_categories: (product.creator_categories || [])
                    .map((pcc) => pcc.creator_category)
                    .filter((cc) => cc && cc.is_active !== false),
                promotions,
                bundles,
            };
        }
        const customProduct = await this.prisma.customProduct.findFirst({
            where: {
                creator_id: store.creator.id,
                status: 'PUBLISHED',
                translations: { some: { slug: productSlug } },
            },
            orderBy: { updated_at: 'desc' },
            include: {
                translations: true,
                mockup_images: { orderBy: { sort_order: 'asc' } },
                selected_variants: { include: { variant: { include: { images: true } } } },
                field_values: { include: { custom_field: { include: { translations: true } } } },
                faqs: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
                creator_categories: {
                    include: { creator_category: { include: { translations: true } } },
                    orderBy: { sort_order: 'asc' },
                },
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
        const bundles = await this.getBundlesForProduct(store.creator.id, {
            customProductId: customProduct.id,
        });
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
            creator_categories: (customProduct.creator_categories || [])
                .map((cpcc) => cpcc.creator_category)
                .filter((cc) => cc && cc.is_active !== false),
            custom_fields: customerFields,
            faqs: [...(customProduct.faqs || []), ...baseProduct.faqs],
            field_values: customProduct.field_values,
            pricing_type: customProduct.pricing_type,
            shipping_profile: shippingProfile,
            promotions,
            bundles,
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
    async getCreatorCategories(slug) {
        const store = await this.prisma.store.findUnique({
            where: { slug },
            include: { creator: true },
        });
        if (!store)
            throw new common_1.NotFoundException('Store not found');
        const rows = await this.prisma.creatorCategory.findMany({
            where: { creator_id: store.creator.id, is_active: true },
            include: { translations: true },
            orderBy: [{ parent_id: 'asc' }, { sort_order: 'asc' }],
        });
        const map = new Map();
        rows.forEach((r) => map.set(r.id, { ...r, children: [] }));
        const roots = [];
        for (const node of map.values()) {
            if (node.parent_id && map.has(node.parent_id)) {
                map.get(node.parent_id).children.push(node);
            }
            else {
                roots.push(node);
            }
        }
        return roots;
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
    async getSitemapData(storeSlug) {
        const store = await this.prisma.store.findUnique({
            where: { slug: storeSlug },
            include: {
                creator: { select: { id: true } },
                language_config: true,
            },
        });
        if (!store)
            throw new common_1.NotFoundException('Store not found');
        const primaryLocale = store.language_config?.primary_locale || 'en';
        const secondaryLocales = store.language_config?.secondary_locales || [];
        const locales = Array.from(new Set([primaryLocale, ...secondaryLocales]));
        const v2Pages = await this.prisma.page.findMany({
            where: { store_id: store.id, published_version_id: { not: null } },
            select: {
                type: true,
                slug: true,
                updated_at: true,
            },
        });
        const legacyPages = await this.prisma.staticPage.findMany({
            where: { store_id: store.id, status: 'PUBLISHED' },
            select: { slug: true, updated_at: true },
        });
        const [ownProducts, customProducts] = await Promise.all([
            this.prisma.product.findMany({
                where: { creator_id: store.creator.id, status: 'PUBLISHED' },
                select: {
                    updated_at: true,
                    translations: { select: { locale: true, slug: true } },
                },
            }),
            this.prisma.customProduct.findMany({
                where: { creator_id: store.creator.id, status: 'PUBLISHED' },
                select: {
                    updated_at: true,
                    translations: { select: { locale: true, slug: true } },
                },
            }),
        ]);
        return {
            locales,
            primaryLocale,
            home: v2Pages.find((p) => p.type === 'HOME')
                ? { lastmod: v2Pages.find((p) => p.type === 'HOME').updated_at }
                : null,
            static_pages: [
                ...v2Pages
                    .filter((p) => p.type === 'STATIC' && p.slug)
                    .map((p) => ({ slug: p.slug, lastmod: p.updated_at })),
                ...legacyPages.map((p) => ({ slug: p.slug, lastmod: p.updated_at })),
            ],
            landing_pages: v2Pages
                .filter((p) => p.type === 'LANDING' && p.slug)
                .map((p) => ({ slug: p.slug, lastmod: p.updated_at })),
            products: [...ownProducts, ...customProducts]
                .map((p) => {
                const t = p.translations.find((tr) => !!tr.slug);
                return t ? { slug: t.slug, lastmod: p.updated_at } : null;
            })
                .filter((p) => !!p),
        };
    }
    async getSampleProduct(storeSlug) {
        const store = await this.prisma.store.findUnique({
            where: { slug: storeSlug },
            include: { creator: true },
        });
        if (!store)
            throw new common_1.NotFoundException('Store not found');
        const own = await this.prisma.product.findFirst({
            where: { creator_id: store.creator.id, status: 'PUBLISHED' },
            include: {
                translations: { select: { locale: true, title: true, description: true, slug: true } },
                images: { orderBy: { sort_order: 'asc' } },
                variants: { where: { is_active: true } },
                faqs: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
            },
            orderBy: { updated_at: 'desc' },
        });
        if (own) {
            const slug = own.translations.find((t) => !!t.slug)?.slug || own.id;
            return {
                id: own.id,
                slug,
                base_price: Number(own.base_price),
                compare_at_price: own.compare_at_price ? Number(own.compare_at_price) : undefined,
                translations: own.translations,
                images: own.images.map((img) => ({
                    url: img.url,
                    alt_text: img.alt_text,
                    sort_order: img.sort_order,
                })),
                variants: own.variants.map((v) => ({
                    id: v.id,
                    price: Number(own.base_price) + Number(v.price_adjustment || 0),
                    stock: v.stock_quantity ?? undefined,
                    sku: v.sku ?? undefined,
                })),
                faqs: own.faqs,
            };
        }
        return null;
    }
    async getMenus(storeSlug) {
        const store = await this.prisma.store.findUnique({
            where: { slug: storeSlug },
            select: { id: true },
        });
        if (!store)
            throw new common_1.NotFoundException('Store not found');
        const menus = await this.prisma.menu.findMany({
            where: { store_id: store.id },
            include: {
                items: {
                    orderBy: { sort_order: 'asc' },
                    select: { id: true, parent_id: true, label: true, label_i18n: true, url: true, open_in_new_tab: true, sort_order: true },
                },
            },
            orderBy: { created_at: 'asc' },
        });
        return menus.map((m) => ({ id: m.id, key: m.key, name: m.name, items: m.items }));
    }
    async getPublishedPage(storeSlug, opts) {
        const store = await this.prisma.store.findUnique({ where: { slug: storeSlug } });
        if (!store)
            throw new common_1.NotFoundException('Store not found');
        const whereType = { store_id: store.id, type: opts.type };
        if (opts.type === 'STATIC' || opts.type === 'LANDING')
            whereType.slug = opts.slug;
        const page = await this.prisma.page.findFirst({
            where: whereType,
            include: { published_version: true },
        });
        if (!page || !page.published_version)
            return null;
        return {
            id: page.id,
            type: page.type,
            slug: page.slug,
            seo: page.seo,
            snapshot: page.published_version.snapshot,
            published_at: page.published_version.published_at,
        };
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