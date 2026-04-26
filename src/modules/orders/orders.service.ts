import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PricingType, UserRole } from '@prisma/client';
import { CreateOrderDto, UpdateOrderStatusDto, UpdateFulfillmentDto } from './dto/order.dto';
import { PromotionsService } from '../promotions/promotions.service';
import { ShippingService } from '../shipping/shipping.service';

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private promotionsService: PromotionsService,
    private shippingService: ShippingService,
  ) {}

  // Reusable include for order items with full product details
  private readonly itemsWithProduct = {
    include: {
      product: {
        include: {
          translations: true,
          images: { take: 1, orderBy: { sort_order: 'asc' as const } },
        },
      },
      variant: true,
      custom_product: {
        include: {
          translations: true,
          mockup_images: { take: 1, orderBy: { sort_order: 'asc' as const } },
          product: {
            include: {
              images: { take: 1, orderBy: { sort_order: 'asc' as const } },
            },
          },
        },
      },
      custom_field_values: {
        include: { custom_field: { include: { translations: true } } },
      },
    },
  };

  private generateOrderNumber(): string {
    const prefix = 'ORD';
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
  }

  async create(userId: string, dto: CreateOrderDto) {
    const customer = await this.prisma.customer.findUnique({
      where: { user_id: userId },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    // جلب السلة
    const cart = await this.prisma.cart.findUnique({
      where: { customer_id: customer.id },
      include: { items: true },
    });

    if (!cart || cart.items.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    // حساب الأسعار
    let subtotal = 0;
    let providerBaseTotal = 0; // what providers are owed (their base prices)
    let creatorMarginTotal = 0; // what creators are owed (their markup or creator-only revenue)
    const orderItems: any[] = [];

    for (const item of cart.items) {
      let unitPrice = 0;
      let providerBasePrice = 0; // per-unit base owed to provider (0 for creator-only products)
      let fulfillerId = '';
      let fulfillerType: 'PROVIDER' | 'CREATOR' = 'PROVIDER';

      if (item.custom_product_id) {
        // Custom product (with or without a selected variant)
        const cp = await this.prisma.customProduct.findUnique({
          where: { id: item.custom_product_id },
          include: {
            product: true,
            selected_variants: item.variant_id
              ? { where: { variant_id: item.variant_id } }
              : true,
          },
        });
        if (!cp) throw new NotFoundException(`Custom product ${item.custom_product_id} not found`);

        let variant: { price_adjustment: any } | null = null;
        if (item.variant_id) {
          variant = await this.prisma.productVariant.findUnique({
            where: { id: item.variant_id },
          });
          if (!variant) throw new NotFoundException(`Variant ${item.variant_id} not found`);
        }
        const variantAdjustment = variant ? Number(variant.price_adjustment || 0) : 0;

        // Compute price based on pricing strategy
        switch (cp.pricing_type) {
          case PricingType.SINGLE:
            // Creator's final_price is THE customer price, regardless of variant
            unitPrice = Number(cp.final_price);
            break;
          case PricingType.PER_VARIANT: {
            if (variant) {
              const selected = cp.selected_variants.find((sv) => sv.variant_id === item.variant_id);
              unitPrice = selected?.custom_price
                ? Number(selected.custom_price)
                : Number(cp.product.base_price) + variantAdjustment;
            } else {
              // No variant chosen on a per-variant product — fall back to final_price
              unitPrice = Number(cp.final_price) || Number(cp.product.base_price);
            }
            break;
          }
          case PricingType.MARGIN:
            unitPrice = Number(cp.product.base_price) + variantAdjustment + Number(cp.margin_amount || 0);
            break;
        }

        // Provider base = their product's base price + variant adjustment (if provider exists)
        if (cp.product.provider_id) {
          providerBasePrice = Number(cp.product.base_price) + variantAdjustment;
        }

        // Provider fulfills the product, creator is the seller
        fulfillerId = cp.product.provider_id || cp.creator_id || '';
        fulfillerType = cp.product.provider_id ? 'PROVIDER' : 'CREATOR';
      } else if (item.variant_id) {
        const variant = await this.prisma.productVariant.findUnique({
          where: { id: item.variant_id },
          include: { product: true },
        });
        if (!variant) throw new NotFoundException(`Variant ${item.variant_id} not found`);

        unitPrice = Number(variant.product.base_price) + Number(variant.price_adjustment);
        if (variant.product.provider_id) providerBasePrice = unitPrice;
        fulfillerId = variant.product.provider_id || variant.product.creator_id || '';
        fulfillerType = variant.product.provider_id ? 'PROVIDER' : 'CREATOR';
      } else if (item.product_id) {
        const product = await this.prisma.product.findUnique({
          where: { id: item.product_id },
        });
        if (!product) throw new NotFoundException(`Product ${item.product_id} not found`);

        unitPrice = Number(product.base_price);
        if (product.provider_id) providerBasePrice = unitPrice;
        fulfillerId = product.provider_id || product.creator_id || '';
        fulfillerType = product.provider_id ? 'PROVIDER' : 'CREATOR';
      }

      const totalPrice = unitPrice * item.quantity;
      // Cap provider base at unitPrice so creator margin is never negative
      const cappedProviderBase = Math.min(providerBasePrice, unitPrice);
      const providerBaseForItem = cappedProviderBase * item.quantity;
      providerBaseTotal += providerBaseForItem;
      creatorMarginTotal += totalPrice - providerBaseForItem;
      subtotal += totalPrice;

      // Build custom field values from cart item's custom_fields JSON
      // Format: { "field-uuid": "value" } or { "field-uuid": "https://...url" }
      const dtoCustomization = dto.item_customizations?.[item.id];
      const cartFields = item.custom_fields as Record<string, any> | null;
      let fieldValues: { custom_field_id: string; value?: string; file_url?: string }[] = [];

      if (dtoCustomization?.custom_field_values?.length) {
        fieldValues = dtoCustomization.custom_field_values;
      } else if (cartFields && typeof cartFields === 'object') {
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

      // Validate required custom fields (skip fields already filled by creator)
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

        // Get creator-provided field values (for custom products)
        let creatorFilledIds: string[] = [];
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
          // Skip if creator already filled this field
          if (creatorFilledIds.includes(rf.id)) continue;

          const isFilled = filledIds.includes(rf.id) && fieldValues.some(
            (fv) => fv.custom_field_id === rf.id && (fv.value || fv.file_url),
          );
          if (!isFilled) {
            const label = rf.translations?.[0]?.label || rf.name || rf.id;
            throw new BadRequestException(`Required field "${label}" is missing`);
          }
        }
      }

      orderItems.push({
        product_id: item.product_id,
        variant_id: item.variant_id,
        custom_product_id: item.custom_product_id,
        quantity: item.quantity,
        unit_price: unitPrice,
        total_price: totalPrice,
        fulfiller_type: fulfillerType,
        fulfiller_id: fulfillerId,
        customer_design_url: dtoCustomization?.customer_design_url,
        design_notes: dtoCustomization?.design_notes,
        _custom_field_values: fieldValues.length > 0 ? fieldValues : undefined,
      });
    }

    // Calculate shipping cost based on product profiles and destination
    const shippingAddress = await this.prisma.address.findUnique({
      where: { id: dto.address_id },
    });
    if (!shippingAddress) throw new NotFoundException('Shipping address not found');

    const productIds = cart.items.map(
      (item) => item.product_id || item.custom_product_id,
    ).filter(Boolean) as string[];

    const totalItemCount = cart.items.reduce((sum, i) => sum + i.quantity, 0);

    const shippingResult = await this.shippingService.calculateForItems({
      product_ids: productIds,
      country_code: shippingAddress.country_code,
      item_count: totalItemCount,
      subtotal,
    });

    if (!(shippingResult as any).available) {
      throw new BadRequestException(
        (shippingResult as any).message || 'Shipping not available to your country',
      );
    }

    let shippingCost = (shippingResult as any).cost ?? 0;

    // Apply coupon discount
    let discountAmount = 0;
    let couponValidation: {
      promotion_id: string;
      type: string;
      value: number;
      discount_amount: number;
      free_shipping: boolean;
    } | null = null;

    if (dto.coupon_code) {
      const itemCount = cart.items.reduce((sum, i) => sum + i.quantity, 0);
      const cartProductIds = cart.items
        .map((i) => i.product_id || i.custom_product_id)
        .filter(Boolean) as string[];
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

      // Cap discount so total never goes negative
      if (discountAmount > subtotal) {
        discountAmount = subtotal;
      }
    }

    const total = subtotal + shippingCost - discountAmount;

    // Extract custom field values before creating order (Prisma doesn't know _custom_field_values)
    const itemFieldValues = orderItems.map((item) => {
      const vals = item._custom_field_values;
      delete item._custom_field_values;
      return vals;
    });

    // Determine payment status based on method
    const paymentMethod = dto.payment_method || 'COD';
    const paymentStatus = paymentMethod === 'COD' ? 'pending' : 'awaiting_payment';

    // Platform currency
    const platformConfig = await this.prisma.platformConfig.findFirst();
    const currency = platformConfig?.default_currency || 'EUR';

    // Create order
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
    } catch (err) {
      console.error('[OrderCreate] Failed to create order:', err);
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Failed to create order',
      );
    }

    // Save custom field values for each order item
    for (let i = 0; i < order.items.length; i++) {
      const fieldValues = itemFieldValues[i];
      if (fieldValues?.length) {
        await this.prisma.orderCustomFieldValue.createMany({
          data: fieldValues.map((fv: any) => ({
            order_item_id: order.items[i]!.id,
            custom_field_id: fv.custom_field_id,
            value: fv.value,
            file_url: fv.file_url,
          })),
        });
      }
    }

    // Record coupon usage
    if (couponValidation && dto.coupon_code) {
      try {
        await this.promotionsService.recordUsage(
          couponValidation.promotion_id,
          order.id,
          userId,
          discountAmount,
        );
      } catch (err) {
        console.error('[OrderCreate] Failed to record promotion usage:', err);
      }
    }

    // Commission split: platform takes %, rest split between provider (base) and creator (margin)
    const commissionPercent = platformConfig
      ? Number(platformConfig.commission_value)
      : 15;

    const commissionBase = subtotal - discountAmount;
    const platformAmount = Math.round(commissionBase * (commissionPercent / 100) * 100) / 100;

    // Scale provider/creator by discount factor to reflect discounted revenue
    const discountFactor = subtotal > 0 ? commissionBase / subtotal : 1;
    const payoutPool = commissionBase - platformAmount;

    // Distribute payoutPool proportionally between provider base and creator margin
    const scaledProviderBase = providerBaseTotal * discountFactor;
    const scaledCreatorMargin = creatorMarginTotal * discountFactor;
    const totalScaled = scaledProviderBase + scaledCreatorMargin;

    let providerAmount = 0;
    let creatorAmount = 0;
    if (totalScaled > 0 && payoutPool > 0) {
      providerAmount = Math.round((payoutPool * scaledProviderBase / totalScaled) * 100) / 100;
      // Ensure providerAmount never exceeds payoutPool due to rounding
      if (providerAmount > payoutPool) providerAmount = payoutPool;
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
    } catch (err) {
      console.error('[OrderCreate] Failed to create commission:', err);
      // Don't fail the order for commission errors
    }

    // تفريغ السلة
    await this.prisma.cartItem.deleteMany({
      where: { cart_id: cart.id },
    });

    return order;
  }

  async findByCustomer(userId: string, page = 1, limit = 20) {
    const customer = await this.prisma.customer.findUnique({
      where: { user_id: userId },
    });
    if (!customer) throw new NotFoundException('Customer not found');

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

  async findByRole(userId: string, role: UserRole, page = 1, limit = 20) {
    if (role === UserRole.PROVIDER) {
      return this.findByProvider(userId, page, limit);
    }
    if (role === UserRole.CREATOR) {
      return this.findByCreator(userId, page, limit);
    }
    return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
  }

  // Provider sees orders where their products are being fulfilled
  private async findByProvider(userId: string, page = 1, limit = 20) {
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
        include: { items: this.itemsWithProduct, address: true, customer: true },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.order.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // Creator sees orders placed through their store
  private async findByCreator(userId: string, page = 1, limit = 20) {
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
        include: { items: this.itemsWithProduct, address: true, customer: true },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.order.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // Generic fulfiller lookup (used by /orders/fulfiller/:id endpoint)
  async findByFulfiller(fulfillerId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = { items: { some: { fulfiller_id: fulfillerId } } };

    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        skip,
        take: limit,
        include: { items: this.itemsWithProduct, address: true, customer: true },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.order.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findById(id: string) {
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

    if (!order) throw new NotFoundException('Order not found');
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

  async updateStatus(id: string, dto: UpdateOrderStatusDto, actorId: string) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Order not found');

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

    return this.findById(id);
  }

  async updateFulfillment(
    orderId: string,
    itemId: string,
    dto: UpdateFulfillmentDto,
  ) {
    return this.prisma.orderItem.update({
      where: { id: itemId, order_id: orderId },
      data: {
        fulfillment_status: dto.fulfillment_status,
        tracking_number: dto.tracking_number,
        tracking_url: dto.tracking_url,
      },
    });
  }
}
