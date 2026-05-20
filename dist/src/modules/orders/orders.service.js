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
exports.OrdersService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const client_1 = require("@prisma/client");
const promotions_service_1 = require("../promotions/promotions.service");
const shipping_service_1 = require("../shipping/shipping.service");
const bundle_pricing_util_1 = require("../bundles/bundle-pricing.util");
function deriveCommissionStatus(orderStatus) {
    if (orderStatus === client_1.OrderStatus.DELIVERED)
        return client_1.CommissionStatus.COMPLETED;
    if (orderStatus === client_1.OrderStatus.CANCELLED ||
        orderStatus === client_1.OrderStatus.REFUNDED ||
        orderStatus === client_1.OrderStatus.RETURNED) {
        return client_1.CommissionStatus.FAILED;
    }
    return client_1.CommissionStatus.PENDING;
}
function deriveFulfillmentStatus(orderStatus) {
    switch (orderStatus) {
        case client_1.OrderStatus.PENDING: return client_1.FulfillmentStatus.PENDING;
        case client_1.OrderStatus.CONFIRMED: return client_1.FulfillmentStatus.PROCESSING;
        case client_1.OrderStatus.PROCESSING: return client_1.FulfillmentStatus.PROCESSING;
        case client_1.OrderStatus.MANUFACTURING: return client_1.FulfillmentStatus.MANUFACTURING;
        case client_1.OrderStatus.QUALITY_CHECK: return client_1.FulfillmentStatus.MANUFACTURING;
        case client_1.OrderStatus.SHIPPED: return client_1.FulfillmentStatus.SHIPPED;
        case client_1.OrderStatus.DELIVERED: return client_1.FulfillmentStatus.DELIVERED;
        default: return null;
    }
}
let OrdersService = class OrdersService {
    prisma;
    promotionsService;
    shippingService;
    constructor(prisma, promotionsService, shippingService) {
        this.prisma = prisma;
        this.promotionsService = promotionsService;
        this.shippingService = shippingService;
    }
    itemsWithProduct = {
        include: {
            product: {
                include: {
                    translations: true,
                    images: { take: 1, orderBy: { sort_order: 'asc' } },
                },
            },
            variant: {
                include: {
                    product: {
                        include: {
                            translations: true,
                            images: { take: 1, orderBy: { sort_order: 'asc' } },
                        },
                    },
                },
            },
            custom_product: {
                include: {
                    translations: true,
                    mockup_images: { take: 1, orderBy: { sort_order: 'asc' } },
                    product: {
                        include: {
                            translations: true,
                            images: { take: 1, orderBy: { sort_order: 'asc' } },
                        },
                    },
                },
            },
            custom_field_values: {
                include: { custom_field: { include: { translations: true } } },
            },
            bundle_offer: {
                include: {
                    translations: true,
                    bundle: { include: { translations: true } },
                },
            },
        },
    };
    generateOrderNumber() {
        const prefix = 'ORD';
        const timestamp = Date.now().toString(36).toUpperCase();
        const random = Math.random().toString(36).substring(2, 6).toUpperCase();
        return `${prefix}-${timestamp}-${random}`;
    }
    async create(userId, dto) {
        const customer = await this.prisma.customer.findUnique({
            where: { user_id: userId },
        });
        if (!customer)
            throw new common_1.NotFoundException('Customer not found');
        const cart = await this.prisma.cart.findUnique({
            where: { customer_id: customer.id },
            include: { items: true },
        });
        if (!cart || cart.items.length === 0) {
            throw new common_1.BadRequestException('Cart is empty');
        }
        let subtotal = 0;
        let providerBaseTotal = 0;
        let creatorMarginTotal = 0;
        const orderItems = [];
        for (const item of cart.items) {
            let unitPrice = 0;
            let providerBasePrice = 0;
            let fulfillerId = '';
            let fulfillerType = 'PROVIDER';
            if (item.custom_product_id) {
                const cp = await this.prisma.customProduct.findUnique({
                    where: { id: item.custom_product_id },
                    include: {
                        product: true,
                        selected_variants: item.variant_id
                            ? { where: { variant_id: item.variant_id } }
                            : true,
                    },
                });
                if (!cp)
                    throw new common_1.NotFoundException(`Custom product ${item.custom_product_id} not found`);
                let variant = null;
                if (item.variant_id) {
                    variant = await this.prisma.productVariant.findUnique({
                        where: { id: item.variant_id },
                    });
                    if (!variant)
                        throw new common_1.NotFoundException(`Variant ${item.variant_id} not found`);
                }
                const variantAdjustment = variant ? Number(variant.price_adjustment || 0) : 0;
                switch (cp.pricing_type) {
                    case client_1.PricingType.SINGLE:
                        unitPrice = Number(cp.final_price);
                        break;
                    case client_1.PricingType.PER_VARIANT: {
                        if (variant) {
                            const selected = cp.selected_variants.find((sv) => sv.variant_id === item.variant_id);
                            unitPrice = selected?.custom_price
                                ? Number(selected.custom_price)
                                : Number(cp.product.base_price) + variantAdjustment;
                        }
                        else {
                            unitPrice = Number(cp.final_price) || Number(cp.product.base_price);
                        }
                        break;
                    }
                    case client_1.PricingType.MARGIN:
                        unitPrice = Number(cp.product.base_price) + variantAdjustment + Number(cp.margin_amount || 0);
                        break;
                }
                if (cp.product.provider_id) {
                    providerBasePrice = Number(cp.product.base_price) + variantAdjustment;
                }
                fulfillerId = cp.product.provider_id || cp.creator_id || '';
                fulfillerType = cp.product.provider_id ? 'PROVIDER' : 'CREATOR';
            }
            else if (item.variant_id) {
                const variant = await this.prisma.productVariant.findUnique({
                    where: { id: item.variant_id },
                    include: { product: true },
                });
                if (!variant)
                    throw new common_1.NotFoundException(`Variant ${item.variant_id} not found`);
                unitPrice = Number(variant.product.base_price) + Number(variant.price_adjustment);
                if (variant.product.provider_id)
                    providerBasePrice = unitPrice;
                fulfillerId = variant.product.provider_id || variant.product.creator_id || '';
                fulfillerType = variant.product.provider_id ? 'PROVIDER' : 'CREATOR';
            }
            else if (item.product_id) {
                const product = await this.prisma.product.findUnique({
                    where: { id: item.product_id },
                });
                if (!product)
                    throw new common_1.NotFoundException(`Product ${item.product_id} not found`);
                unitPrice = Number(product.base_price);
                if (product.provider_id)
                    providerBasePrice = unitPrice;
                fulfillerId = product.provider_id || product.creator_id || '';
                fulfillerType = product.provider_id ? 'PROVIDER' : 'CREATOR';
            }
            let originalUnitPrice = null;
            if (item.bundle_offer_id) {
                const offer = await this.prisma.bundleOffer.findUnique({
                    where: { id: item.bundle_offer_id },
                    include: { bundle: true },
                });
                if (!offer || offer.bundle.status !== 'ACTIVE') {
                    throw new common_1.BadRequestException('Bundle offer is no longer available');
                }
                const pricing = (0, bundle_pricing_util_1.computeBundlePricing)(unitPrice, {
                    quantity: offer.quantity,
                    discount_type: offer.discount_type,
                    discount_value: offer.discount_value,
                });
                if (pricing.cartQuantity <= 0 ||
                    item.quantity % pricing.cartQuantity !== 0) {
                    throw new common_1.BadRequestException(`Bundle requires quantity in multiples of ${pricing.cartQuantity}`);
                }
                originalUnitPrice = unitPrice;
                unitPrice = pricing.effectiveUnitPrice;
                if (providerBasePrice > 0 && unitPrice < providerBasePrice) {
                    throw new common_1.BadRequestException('Bundle pricing would sell this item below provider cost. Remove the bundle or adjust pricing.');
                }
            }
            const totalPrice = unitPrice * item.quantity;
            const cappedProviderBase = Math.min(providerBasePrice, unitPrice);
            const providerBaseForItem = cappedProviderBase * item.quantity;
            providerBaseTotal += providerBaseForItem;
            creatorMarginTotal += totalPrice - providerBaseForItem;
            subtotal += totalPrice;
            const dtoCustomization = dto.item_customizations?.[item.id];
            const cartFields = item.custom_fields;
            let fieldValues = [];
            if (dtoCustomization?.custom_field_values?.length) {
                fieldValues = dtoCustomization.custom_field_values;
            }
            else if (cartFields && typeof cartFields === 'object') {
                fieldValues = Object.entries(cartFields)
                    .filter(([, v]) => v !== '' && v != null)
                    .map(([fieldId, val]) => {
                    const strVal = Array.isArray(val) ? val.join(', ') : String(val);
                    const isUrl = strVal.startsWith('http') || strVal.startsWith('/uploads');
                    return {
                        custom_field_id: fieldId,
                        value: isUrl ? undefined : strVal,
                        file_url: isUrl ? strVal : undefined,
                    };
                });
            }
            const productIdForFields = item.product_id || (item.custom_product_id
                ? (await this.prisma.customProduct.findUnique({
                    where: { id: item.custom_product_id },
                    select: { product_id: true },
                }))?.product_id
                : null);
            if (productIdForFields) {
                const requiredFields = await this.prisma.productCustomField.findMany({
                    where: { product_id: productIdForFields, is_required: true },
                    include: { translations: true },
                });
                let creatorFilledIds = [];
                if (item.custom_product_id) {
                    const creatorValues = await this.prisma.customProductFieldValue.findMany({
                        where: { custom_product_id: item.custom_product_id },
                        select: { custom_field_id: true, value: true, file_url: true },
                    });
                    creatorFilledIds = creatorValues
                        .filter((cv) => cv.value || cv.file_url)
                        .map((cv) => cv.custom_field_id);
                }
                const filledIds = fieldValues.map((fv) => fv.custom_field_id);
                for (const rf of requiredFields) {
                    if (creatorFilledIds.includes(rf.id))
                        continue;
                    const isFilled = filledIds.includes(rf.id) && fieldValues.some((fv) => fv.custom_field_id === rf.id && (fv.value || fv.file_url));
                    if (!isFilled) {
                        const label = rf.translations?.[0]?.label || rf.name || rf.id;
                        throw new common_1.BadRequestException(`Required field "${label}" is missing`);
                    }
                }
            }
            orderItems.push({
                product_id: item.product_id,
                variant_id: item.variant_id,
                custom_product_id: item.custom_product_id,
                bundle_offer_id: item.bundle_offer_id || null,
                quantity: item.quantity,
                unit_price: unitPrice,
                original_unit_price: originalUnitPrice,
                total_price: totalPrice,
                fulfiller_type: fulfillerType,
                fulfiller_id: fulfillerId,
                customer_design_url: dtoCustomization?.customer_design_url,
                design_notes: dtoCustomization?.design_notes,
                _custom_field_values: fieldValues.length > 0 ? fieldValues : undefined,
            });
        }
        const shippingAddress = await this.prisma.address.findUnique({
            where: { id: dto.address_id },
        });
        if (!shippingAddress)
            throw new common_1.NotFoundException('Shipping address not found');
        const productIds = cart.items.map((item) => item.product_id || item.custom_product_id).filter(Boolean);
        const totalItemCount = cart.items.reduce((sum, i) => sum + i.quantity, 0);
        const shippingResult = await this.shippingService.calculateForItems({
            product_ids: productIds,
            country_code: shippingAddress.country_code,
            item_count: totalItemCount,
            subtotal,
        });
        if (!shippingResult.available) {
            throw new common_1.BadRequestException(shippingResult.message || 'Shipping not available to your country');
        }
        let shippingCost = shippingResult.cost ?? 0;
        let discountAmount = 0;
        let couponValidation = null;
        if (dto.coupon_code) {
            const itemCount = cart.items.reduce((sum, i) => sum + i.quantity, 0);
            const cartProductIds = cart.items
                .map((i) => i.product_id || i.custom_product_id)
                .filter(Boolean);
            couponValidation = await this.promotionsService.validateCoupon({
                coupon_code: dto.coupon_code,
                subtotal,
                item_count: itemCount,
                product_ids: cartProductIds,
            });
            discountAmount = couponValidation.discount_amount;
            if (couponValidation.free_shipping) {
                shippingCost = 0;
            }
            if (discountAmount > subtotal) {
                discountAmount = subtotal;
            }
        }
        const total = subtotal + shippingCost - discountAmount;
        const itemFieldValues = orderItems.map((item) => {
            const vals = item._custom_field_values;
            delete item._custom_field_values;
            return vals;
        });
        const paymentMethod = dto.payment_method || 'COD';
        const paymentStatus = paymentMethod === 'COD' ? 'pending' : 'awaiting_payment';
        const platformConfig = await this.prisma.platformConfig.findFirst();
        const currency = platformConfig?.default_currency || 'EUR';
        let order;
        try {
            order = await this.prisma.order.create({
                data: {
                    order_number: this.generateOrderNumber(),
                    customer_id: customer.id,
                    address_id: dto.address_id,
                    store_id: dto.store_id || undefined,
                    subtotal,
                    shipping_cost: shippingCost,
                    discount_amount: discountAmount,
                    total,
                    currency,
                    payment_method: paymentMethod,
                    payment_status: paymentStatus,
                    stripe_payment_id: dto.stripe_payment_intent_id,
                    notes: dto.notes,
                    items: { create: orderItems },
                    timeline: {
                        create: {
                            status: 'PENDING',
                            note: 'Order created',
                            actor: 'system',
                        },
                    },
                },
                include: {
                    items: true,
                    timeline: true,
                    address: true,
                },
            });
        }
        catch (err) {
            console.error('[OrderCreate] Failed to create order:', err);
            throw new common_1.BadRequestException(err instanceof Error ? err.message : 'Failed to create order');
        }
        for (let i = 0; i < order.items.length; i++) {
            const fieldValues = itemFieldValues[i];
            if (fieldValues?.length) {
                await this.prisma.orderCustomFieldValue.createMany({
                    data: fieldValues.map((fv) => ({
                        order_item_id: order.items[i].id,
                        custom_field_id: fv.custom_field_id,
                        value: fv.value,
                        file_url: fv.file_url,
                    })),
                });
            }
        }
        if (couponValidation && dto.coupon_code) {
            try {
                await this.promotionsService.recordUsage(couponValidation.promotion_id, order.id, userId, discountAmount);
            }
            catch (err) {
                console.error('[OrderCreate] Failed to record promotion usage:', err);
            }
        }
        const commissionPercent = platformConfig
            ? Number(platformConfig.commission_value)
            : 15;
        const commissionBase = subtotal - discountAmount;
        const platformAmount = Math.round(commissionBase * (commissionPercent / 100) * 100) / 100;
        const discountFactor = subtotal > 0 ? commissionBase / subtotal : 1;
        const payoutPool = commissionBase - platformAmount;
        const scaledProviderBase = providerBaseTotal * discountFactor;
        const scaledCreatorMargin = creatorMarginTotal * discountFactor;
        const totalScaled = scaledProviderBase + scaledCreatorMargin;
        let providerAmount = 0;
        let creatorAmount = 0;
        if (totalScaled > 0 && payoutPool > 0) {
            providerAmount = Math.round((payoutPool * scaledProviderBase / totalScaled) * 100) / 100;
            if (providerAmount > payoutPool)
                providerAmount = payoutPool;
            creatorAmount = Math.max(0, Math.round((payoutPool - providerAmount) * 100) / 100);
        }
        try {
            await this.prisma.orderCommission.create({
                data: {
                    order_id: order.id,
                    platform_amount: platformAmount,
                    provider_amount: providerAmount,
                    creator_amount: creatorAmount,
                    currency,
                },
            });
        }
        catch (err) {
            console.error('[OrderCreate] Failed to create commission:', err);
        }
        await this.prisma.cartItem.deleteMany({
            where: { cart_id: cart.id },
        });
        return order;
    }
    async findByCustomer(userId, page = 1, limit = 20) {
        const customer = await this.prisma.customer.findUnique({
            where: { user_id: userId },
        });
        if (!customer)
            throw new common_1.NotFoundException('Customer not found');
        const skip = (page - 1) * limit;
        const [data, total] = await Promise.all([
            this.prisma.order.findMany({
                where: { customer_id: customer.id },
                skip,
                take: limit,
                include: { items: this.itemsWithProduct },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.order.count({ where: { customer_id: customer.id } }),
        ]);
        return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
    }
    async findByRole(userId, role, page = 1, limit = 20) {
        if (role === client_1.UserRole.PROVIDER) {
            return this.findByProvider(userId, page, limit);
        }
        if (role === client_1.UserRole.CREATOR) {
            return this.findByCreator(userId, page, limit);
        }
        return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
    }
    async findByProvider(userId, page = 1, limit = 20) {
        const provider = await this.prisma.provider.findUnique({ where: { user_id: userId } });
        if (!provider) {
            return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
        }
        const skip = (page - 1) * limit;
        const where = { items: { some: { fulfiller_id: provider.id } } };
        const [data, total] = await Promise.all([
            this.prisma.order.findMany({
                where,
                skip,
                take: limit,
                include: {
                    items: this.itemsWithProduct,
                    address: true,
                    customer: true,
                    commission: true,
                },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.order.count({ where }),
        ]);
        return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
    }
    async findByCreator(userId, page = 1, limit = 20) {
        const creator = await this.prisma.creator.findUnique({
            where: { user_id: userId },
            include: { store: true },
        });
        if (!creator?.store) {
            return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
        }
        const skip = (page - 1) * limit;
        const where = { store_id: creator.store.id };
        const [data, total] = await Promise.all([
            this.prisma.order.findMany({
                where,
                skip,
                take: limit,
                include: {
                    items: this.itemsWithProduct,
                    address: true,
                    customer: true,
                    commission: true,
                },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.order.count({ where }),
        ]);
        return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
    }
    async findByFulfiller(fulfillerId, page = 1, limit = 20) {
        const skip = (page - 1) * limit;
        const where = { items: { some: { fulfiller_id: fulfillerId } } };
        const [data, total] = await Promise.all([
            this.prisma.order.findMany({
                where,
                skip,
                take: limit,
                include: {
                    items: this.itemsWithProduct,
                    address: true,
                    customer: true,
                    commission: true,
                },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.order.count({ where }),
        ]);
        return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
    }
    async findById(id) {
        const order = await this.prisma.order.findUnique({
            where: { id },
            include: {
                items: this.itemsWithProduct,
                commission: true,
                timeline: { orderBy: { created_at: 'asc' } },
                address: true,
                customer: true,
            },
        });
        if (!order)
            throw new common_1.NotFoundException('Order not found');
        return order;
    }
    async findAll(page = 1, limit = 20) {
        const skip = (page - 1) * limit;
        const [data, total] = await Promise.all([
            this.prisma.order.findMany({
                skip,
                take: limit,
                include: { items: this.itemsWithProduct, customer: true },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.order.count(),
        ]);
        return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
    }
    async resolveFulfillerId(userId, userRole) {
        if (userRole === client_1.UserRole.PROVIDER) {
            const provider = await this.prisma.provider.findUnique({ where: { user_id: userId } });
            return provider?.id ?? null;
        }
        if (userRole === client_1.UserRole.CREATOR) {
            const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
            return creator?.id ?? null;
        }
        return null;
    }
    async assertOwnsEntireOrder(orderId, userId, userRole) {
        if (userRole === client_1.UserRole.ADMIN)
            return;
        const expectedType = userRole === client_1.UserRole.PROVIDER ? client_1.FulfillerType.PROVIDER : client_1.FulfillerType.CREATOR;
        const fulfillerId = await this.resolveFulfillerId(userId, userRole);
        if (!fulfillerId) {
            throw new common_1.ForbiddenException('Fulfiller profile not found for this user');
        }
        const items = await this.prisma.orderItem.findMany({
            where: { order_id: orderId },
            select: { fulfiller_id: true, fulfiller_type: true },
        });
        if (items.length === 0) {
            throw new common_1.NotFoundException('Order has no items');
        }
        const allOwned = items.every((it) => it.fulfiller_type === expectedType && it.fulfiller_id === fulfillerId);
        if (!allOwned) {
            throw new common_1.ForbiddenException(userRole === client_1.UserRole.CREATOR
                ? 'You can only change the status of orders made entirely of your own products. Provider-fulfilled items are managed by the provider.'
                : 'You can only change the status of orders made entirely of your own products.');
        }
    }
    async updateStatus(id, dto, actorId, actorRole) {
        const order = await this.prisma.order.findUnique({ where: { id } });
        if (!order)
            throw new common_1.NotFoundException('Order not found');
        await this.assertOwnsEntireOrder(id, actorId, actorRole);
        await this.prisma.order.update({
            where: { id },
            data: { status: dto.status },
        });
        await this.prisma.orderTimeline.create({
            data: {
                order_id: id,
                status: dto.status,
                note: dto.note,
                actor: actorId,
            },
        });
        const nextCommissionStatus = deriveCommissionStatus(dto.status);
        await this.prisma.orderCommission.updateMany({
            where: { order_id: id },
            data: { status: nextCommissionStatus },
        });
        const nextFulfillment = deriveFulfillmentStatus(dto.status);
        if (nextFulfillment) {
            await this.prisma.orderItem.updateMany({
                where: { order_id: id },
                data: { fulfillment_status: nextFulfillment },
            });
        }
        return this.findById(id);
    }
    async updateFulfillment(orderId, itemId, dto, actorId, actorRole) {
        const item = await this.prisma.orderItem.findFirst({
            where: { id: itemId, order_id: orderId },
            select: { id: true, fulfiller_id: true, fulfiller_type: true },
        });
        if (!item)
            throw new common_1.NotFoundException('Order item not found');
        if (actorRole !== client_1.UserRole.ADMIN) {
            const expectedType = actorRole === client_1.UserRole.PROVIDER ? client_1.FulfillerType.PROVIDER : client_1.FulfillerType.CREATOR;
            const fulfillerId = await this.resolveFulfillerId(actorId, actorRole);
            if (!fulfillerId ||
                item.fulfiller_type !== expectedType ||
                item.fulfiller_id !== fulfillerId) {
                throw new common_1.ForbiddenException('You can only update fulfillment for items you fulfill');
            }
        }
        return this.prisma.orderItem.update({
            where: { id: itemId, order_id: orderId },
            data: {
                fulfillment_status: dto.fulfillment_status,
                tracking_number: dto.tracking_number,
                tracking_url: dto.tracking_url,
            },
        });
    }
};
exports.OrdersService = OrdersService;
exports.OrdersService = OrdersService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        promotions_service_1.PromotionsService,
        shipping_service_1.ShippingService])
], OrdersService);
//# sourceMappingURL=orders.service.js.map