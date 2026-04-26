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
    async enrichCartItems(items) {
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
                        translations: { take: 1, orderBy: { locale: 'asc' } },
                        mockup_images: { take: 1, orderBy: { sort_order: 'asc' } },
                        product: {
                            include: {
                                translations: { take: 1, orderBy: { locale: 'asc' } },
                                images: { take: 1, orderBy: { sort_order: 'asc' } },
                            },
                        },
                    },
                });
                if (cp) {
                    title = cp.translations[0]?.title || cp.product.translations[0]?.title || null;
                    price = Number(cp.final_price || cp.product.base_price);
                    imageUrl = cp.mockup_images[0]?.url || cp.product.images[0]?.url || null;
                }
            }
            else if (item.product_id) {
                const product = await this.prisma.product.findUnique({
                    where: { id: item.product_id },
                    include: {
                        translations: { take: 1, orderBy: { locale: 'asc' } },
                        images: { where: { is_featured: true }, take: 1 },
                    },
                });
                if (product) {
                    title = product.translations[0]?.title || null;
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
            });
        }
        return enriched;
    }
    async getCart(userId) {
        const cart = await this.getOrCreateCart(userId);
        const cartWithItems = await this.prisma.cart.findUnique({
            where: { id: cart.id },
            include: {
                items: true,
            },
        });
        const enrichedItems = await this.enrichCartItems(cartWithItems?.items || []);
        return {
            id: cartWithItems?.id,
            items: enrichedItems,
        };
    }
    async addItem(userId, dto) {
        const cart = await this.getOrCreateCart(userId);
        const existing = await this.prisma.cartItem.findFirst({
            where: {
                cart_id: cart.id,
                product_id: dto.product_id || null,
                variant_id: dto.variant_id || null,
                custom_product_id: dto.custom_product_id || null,
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
        return this.getCart(userId);
    }
    async updateItem(userId, itemId, dto) {
        const cart = await this.getOrCreateCart(userId);
        const item = await this.prisma.cartItem.findFirst({
            where: { id: itemId, cart_id: cart.id },
        });
        if (!item)
            throw new common_1.NotFoundException('Cart item not found');
        await this.prisma.cartItem.update({
            where: { id: itemId },
            data: { quantity: dto.quantity },
        });
        return this.getCart(userId);
    }
    async removeItem(userId, itemId) {
        const cart = await this.getOrCreateCart(userId);
        await this.prisma.cartItem.delete({
            where: { id: itemId, cart_id: cart.id },
        });
        return this.getCart(userId);
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