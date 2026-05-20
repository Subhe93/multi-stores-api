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
exports.CartService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const bundle_pricing_util_1 = require("../bundles/bundle-pricing.util");
const bundle_economics_util_1 = require("../bundles/bundle-economics.util");
let CartService = class CartService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getOrCreateCart(userId) {
        const customer = await this.prisma.customer.findUnique({
            where: { user_id: userId },
        });
        if (!customer)
            throw new common_1.NotFoundException('Customer not found');
        let cart = await this.prisma.cart.findUnique({
            where: { customer_id: customer.id },
        });
        if (!cart) {
            cart = await this.prisma.cart.create({
                data: { customer_id: customer.id },
            });
        }
        return cart;
    }
    pickTranslation(translations, locale) {
        if (!translations?.length)
            return undefined;
        return ((locale && translations.find((t) => t.locale === locale)) ||
            translations.find((t) => t.locale === 'en') ||
            translations[0]);
    }
    async enrichCartItems(items, locale) {
        const enriched = [];
        const config = await this.prisma.platformConfig.findFirst();
        const platformCurrency = config?.default_currency || 'EUR';
        for (const item of items) {
            let title = null;
            let price = 0;
            let imageUrl = null;
            let variantLabel = null;
            let currency = platformCurrency;
            if (item.custom_product_id) {
                const cp = await this.prisma.customProduct.findUnique({
                    where: { id: item.custom_product_id },
                    include: {
                        translations: true,
                        mockup_images: { take: 1, orderBy: { sort_order: 'asc' } },
                        selected_variants: item.variant_id
                            ? { where: { variant_id: item.variant_id } }
                            : true,
                        product: {
                            include: {
                                translations: true,
                                images: { take: 1, orderBy: { sort_order: 'asc' } },
                            },
                        },
                    },
                });
                if (cp) {
                    title =
                        this.pickTranslation(cp.translations, locale)?.title ||
                            this.pickTranslation(cp.product.translations, locale)?.title ||
                            null;
                    imageUrl = cp.mockup_images[0]?.url || cp.product.images[0]?.url || null;
                    let variantAdjustment = 0;
                    if (item.variant_id) {
                        const v = await this.prisma.productVariant.findUnique({
                            where: { id: item.variant_id },
                            select: { price_adjustment: true },
                        });
                        variantAdjustment = Number(v?.price_adjustment || 0);
                    }
                    switch (cp.pricing_type) {
                        case 'SINGLE':
                            price = Number(cp.final_price);
                            break;
                        case 'PER_VARIANT': {
                            if (item.variant_id) {
                                const sv = cp.selected_variants.find((s) => s.variant_id === item.variant_id);
                                price = sv?.custom_price
                                    ? Number(sv.custom_price)
                                    : Number(cp.product.base_price) + variantAdjustment;
                            }
                            else {
                                price = Number(cp.final_price) || Number(cp.product.base_price);
                            }
                            break;
                        }
                        case 'MARGIN':
                            price =
                                Number(cp.product.base_price) +
                                    variantAdjustment +
                                    Number(cp.margin_amount || 0);
                            break;
                        default:
                            price = Number(cp.final_price) || Number(cp.product.base_price);
                    }
                }
            }
            else if (item.product_id) {
                const product = await this.prisma.product.findUnique({
                    where: { id: item.product_id },
                    include: {
                        translations: true,
                        images: { where: { is_featured: true }, take: 1 },
                    },
                });
                if (product) {
                    title = this.pickTranslation(product.translations, locale)?.title || null;
                    price = Number(product.base_price);
                    imageUrl = product.images[0]?.url || null;
                    if (!imageUrl) {
                        const firstImage = await this.prisma.productImage.findFirst({
                            where: { product_id: product.id },
                            orderBy: { sort_order: 'asc' },
                        });
                        imageUrl = firstImage?.url || null;
                    }
                }
            }
            if (item.variant_id) {
                const variant = await this.prisma.productVariant.findUnique({
                    where: { id: item.variant_id },
                });
                if (variant) {
                    if (!item.custom_product_id) {
                        price = price + Number(variant.price_adjustment);
                    }
                    if (variant.options && typeof variant.options === 'object') {
                        const opts = variant.options;
                        variantLabel = Object.entries(opts)
                            .map(([k, v]) => `${k}: ${v}`)
                            .join(' / ');
                    }
                }
            }
            let bundleOfferId = null;
            let bundleOriginalUnitPrice = null;
            let bundleTitle = null;
            let bundleLabel = null;
            let bundleStickerText = null;
            let bundleCartQuantity = null;
            if (item.bundle_offer_id) {
                const offer = await this.prisma.bundleOffer.findUnique({
                    where: { id: item.bundle_offer_id },
                    include: {
                        translations: true,
                        bundle: { include: { translations: true } },
                    },
                });
                if (offer && offer.bundle.status === 'ACTIVE') {
                    const pricing = (0, bundle_pricing_util_1.computeBundlePricing)(price, {
                        quantity: offer.quantity,
                        discount_type: offer.discount_type,
                        discount_value: offer.discount_value,
                    });
                    bundleOfferId = offer.id;
                    bundleOriginalUnitPrice = price;
                    price = pricing.effectiveUnitPrice;
                    bundleCartQuantity = pricing.cartQuantity;
                    const tr = this.pickTranslation(offer.translations, locale);
                    bundleTitle = tr?.title || null;
                    bundleLabel = tr?.label || null;
                    bundleStickerText = tr?.sticker_text || null;
                }
                else {
                    await this.prisma.cartItem.update({
                        where: { id: item.id },
                        data: { bundle_offer_id: null },
                    });
                }
            }
            enriched.push({
                id: item.id,
                productId: item.product_id,
                variantId: item.variant_id,
                customProductId: item.custom_product_id,
                quantity: item.quantity,
                customFields: item.custom_fields,
                title,
                price,
                imageUrl,
                variant: variantLabel,
                currency,
                bundleOfferId,
                bundleOriginalUnitPrice,
                bundleTitle,
                bundleLabel,
                bundleStickerText,
                bundleCartQuantity,
            });
        }
        return enriched;
    }
    async validateBundleOffer(bundleOfferId, productId, customProductId, variantId) {
        const offer = await this.prisma.bundleOffer.findUnique({
            where: { id: bundleOfferId },
            include: {
                bundle: {
                    include: {
                        products: true,
                        custom_products: true,
                    },
                },
            },
        });
        if (!offer) {
            throw new common_1.BadRequestException('Bundle offer not found');
        }
        if (offer.bundle.status !== 'ACTIVE') {
            throw new common_1.BadRequestException('Bundle is not active');
        }
        if (productId) {
            const linked = offer.bundle.products.some((p) => p.product_id === productId);
            if (!linked) {
                throw new common_1.BadRequestException('Bundle is not available for this product');
            }
        }
        else if (customProductId) {
            const linked = offer.bundle.custom_products.some((p) => p.custom_product_id === customProductId);
            if (!linked) {
                throw new common_1.BadRequestException('Bundle is not available for this product');
            }
        }
        let unitPrice = 0;
        let providerBase = 0;
        if (productId) {
            const product = await this.prisma.product.findUnique({
                where: { id: productId },
                select: { base_price: true, provider_id: true },
            });
            if (product) {
                unitPrice = Number(product.base_price);
                providerBase = product.provider_id ? unitPrice : 0;
            }
        }
        else if (customProductId) {
            const cp = await this.prisma.customProduct.findUnique({
                where: { id: customProductId },
                select: {
                    final_price: true,
                    pricing_type: true,
                    margin_amount: true,
                    selected_variants: variantId
                        ? { where: { variant_id: variantId } }
                        : true,
                    product: { select: { base_price: true, provider_id: true } },
                },
            });
            if (cp) {
                let variantAdjustment = 0;
                if (variantId) {
                    const v = await this.prisma.productVariant.findUnique({
                        where: { id: variantId },
                        select: { price_adjustment: true },
                    });
                    variantAdjustment = Number(v?.price_adjustment || 0);
                }
                switch (cp.pricing_type) {
                    case 'SINGLE':
                        unitPrice = Number(cp.final_price) || Number(cp.product.base_price);
                        break;
                    case 'PER_VARIANT': {
                        if (variantId) {
                            const sv = cp.selected_variants.find((s) => s.variant_id === variantId);
                            unitPrice = sv?.custom_price
                                ? Number(sv.custom_price)
                                : Number(cp.product.base_price) + variantAdjustment;
                        }
                        else {
                            const customPrices = cp.selected_variants
                                .map((sv) => Number(sv.custom_price ?? 0))
                                .filter((n) => n > 0);
                            unitPrice = customPrices.length
                                ? Math.min(...customPrices)
                                : Number(cp.product.base_price);
                        }
                        break;
                    }
                    case 'MARGIN':
                        unitPrice =
                            Number(cp.product.base_price) +
                                variantAdjustment +
                                Number(cp.margin_amount || 0);
                        break;
                }
                providerBase = cp.product.provider_id
                    ? Number(cp.product.base_price) + variantAdjustment
                    : 0;
            }
        }
        if (providerBase > 0 && unitPrice > 0) {
            const check = (0, bundle_economics_util_1.validateBundleEconomics)([
                {
                    quantity: offer.quantity,
                    discount_type: offer.discount_type,
                    discount_value: offer.discount_value,
                },
            ], [{ id: 'cart-line', unitPrice, providerBasePrice: providerBase }]);
            if (!check.valid) {
                throw new common_1.BadRequestException('This bundle offer is no longer profitable for this product and cannot be applied');
            }
        }
        return offer;
    }
    assertBundleQuantityValid(offer, quantity) {
        const pricing = (0, bundle_pricing_util_1.computeBundlePricing)(1, {
            quantity: offer.quantity,
            discount_type: offer.discount_type,
            discount_value: offer.discount_value,
        });
        if (pricing.cartQuantity <= 0 || quantity % pricing.cartQuantity !== 0) {
            throw new common_1.BadRequestException(`Bundle requires quantity in multiples of ${pricing.cartQuantity}`);
        }
    }
    async getCart(userId, locale) {
        const cart = await this.getOrCreateCart(userId);
        const cartWithItems = await this.prisma.cart.findUnique({
            where: { id: cart.id },
            include: {
                items: true,
            },
        });
        const enrichedItems = await this.enrichCartItems(cartWithItems?.items || [], locale);
        return {
            id: cartWithItems?.id,
            items: enrichedItems,
        };
    }
    async addItem(userId, dto, locale) {
        const cart = await this.getOrCreateCart(userId);
        if (dto.bundle_offer_id) {
            const offer = await this.validateBundleOffer(dto.bundle_offer_id, dto.product_id, dto.custom_product_id, dto.variant_id);
            const existingSameLine = await this.prisma.cartItem.findFirst({
                where: {
                    cart_id: cart.id,
                    product_id: dto.product_id || null,
                    variant_id: dto.variant_id || null,
                    custom_product_id: dto.custom_product_id || null,
                    bundle_offer_id: dto.bundle_offer_id,
                },
            });
            const finalQuantity = (existingSameLine?.quantity ?? 0) + dto.quantity;
            this.assertBundleQuantityValid(offer, finalQuantity);
        }
        const existing = await this.prisma.cartItem.findFirst({
            where: {
                cart_id: cart.id,
                product_id: dto.product_id || null,
                variant_id: dto.variant_id || null,
                custom_product_id: dto.custom_product_id || null,
                bundle_offer_id: dto.bundle_offer_id || null,
            },
        });
        if (existing) {
            await this.prisma.cartItem.update({
                where: { id: existing.id },
                data: { quantity: existing.quantity + dto.quantity },
            });
        }
        else {
            await this.prisma.cartItem.create({
                data: {
                    cart_id: cart.id,
                    ...dto,
                },
            });
        }
        return this.getCart(userId, locale);
    }
    async updateItem(userId, itemId, dto, locale) {
        const cart = await this.getOrCreateCart(userId);
        const item = await this.prisma.cartItem.findFirst({
            where: { id: itemId, cart_id: cart.id },
        });
        if (!item)
            throw new common_1.NotFoundException('Cart item not found');
        const data = {};
        if (typeof dto.quantity === 'number') {
            data.quantity = dto.quantity;
        }
        let nextBundleOfferId = item.bundle_offer_id;
        if (dto.bundle_offer_id !== undefined) {
            if (dto.bundle_offer_id === null) {
                data.bundle_offer_id = null;
                nextBundleOfferId = null;
            }
            else {
                await this.validateBundleOffer(dto.bundle_offer_id, item.product_id, item.custom_product_id, item.variant_id);
                data.bundle_offer_id = dto.bundle_offer_id;
                nextBundleOfferId = dto.bundle_offer_id;
            }
        }
        if (nextBundleOfferId) {
            const nextQty = data.quantity ?? item.quantity;
            const offer = await this.prisma.bundleOffer.findUnique({
                where: { id: nextBundleOfferId },
            });
            if (offer)
                this.assertBundleQuantityValid(offer, nextQty);
        }
        if (Object.keys(data).length > 0) {
            await this.prisma.cartItem.update({
                where: { id: itemId },
                data,
            });
        }
        return this.getCart(userId, locale);
    }
    async removeItem(userId, itemId, locale) {
        const cart = await this.getOrCreateCart(userId);
        await this.prisma.cartItem.delete({
            where: { id: itemId, cart_id: cart.id },
        });
        return this.getCart(userId, locale);
    }
    async clearCart(userId) {
        const cart = await this.getOrCreateCart(userId);
        await this.prisma.cartItem.deleteMany({
            where: { cart_id: cart.id },
        });
        return { message: 'Cart cleared' };
    }
    async applyCoupon(userId, couponCode) {
        const cart = await this.getOrCreateCart(userId);
        return {
            cart_id: cart.id,
            coupon_code: couponCode,
            message: 'Coupon applied. Discount will be calculated at checkout.',
        };
    }
    async removeCoupon(userId) {
        return { message: 'Coupon removed' };
    }
};
exports.CartService = CartService;
exports.CartService = CartService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], CartService);
//# sourceMappingURL=cart.service.js.map