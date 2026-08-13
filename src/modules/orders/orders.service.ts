import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CommissionStatus,
  FulfillerType,
  FulfillmentStatus,
  OrderStatus,
  PricingType,
  StoreType,
  UserRole,
} from '@prisma/client';
import { CreateOrderDto, UpdateOrderStatusDto, UpdateFulfillmentDto } from './dto/order.dto';
import { PromotionsService } from '../promotions/promotions.service';
import { ShippingService } from '../shipping/shipping.service';
import { MailService } from '../mail/mail.service';
import { computeBundlePricing } from '../bundles/bundle-pricing.util';

function deriveCommissionStatus(orderStatus: OrderStatus): CommissionStatus {
  if (orderStatus === OrderStatus.DELIVERED) return CommissionStatus.COMPLETED;
  if (
    orderStatus === OrderStatus.CANCELLED ||
    orderStatus === OrderStatus.REFUNDED ||
    orderStatus === OrderStatus.RETURNED
  ) {
    return CommissionStatus.FAILED;
  }
  return CommissionStatus.PENDING;
}

// Map the overall order lifecycle onto the smaller per-item FulfillmentStatus enum
// so item badges don't get stuck on PENDING after the order advances.
// Terminal failure states (CANCELLED/REFUNDED/RETURNED) return null — we leave items
// alone there so the UI keeps the historical fulfillment context.
function deriveFulfillmentStatus(orderStatus: OrderStatus): FulfillmentStatus | null {
  switch (orderStatus) {
    case OrderStatus.PENDING:        return FulfillmentStatus.PENDING;
    case OrderStatus.CONFIRMED:      return FulfillmentStatus.PROCESSING;
    case OrderStatus.PROCESSING:     return FulfillmentStatus.PROCESSING;
    case OrderStatus.MANUFACTURING:  return FulfillmentStatus.MANUFACTURING;
    case OrderStatus.QUALITY_CHECK:  return FulfillmentStatus.MANUFACTURING;
    case OrderStatus.SHIPPED:        return FulfillmentStatus.SHIPPED;
    case OrderStatus.DELIVERED:      return FulfillmentStatus.DELIVERED;
    default:                         return null;
  }
}

// Progress ranks used to derive an order's overall status from its items: the
// order reflects the *slowest* item (it's only SHIPPED once every item ships).
const FULFILLMENT_RANK: Record<FulfillmentStatus, number> = {
  [FulfillmentStatus.PENDING]: 0,
  [FulfillmentStatus.PROCESSING]: 1,
  [FulfillmentStatus.MANUFACTURING]: 2,
  [FulfillmentStatus.SHIPPED]: 3,
  [FulfillmentStatus.DELIVERED]: 4,
};

const ORDER_STATUS_RANK: Record<string, number> = {
  PENDING: 0,
  CONFIRMED: 1,
  PROCESSING: 2,
  MANUFACTURING: 3,
  QUALITY_CHECK: 4,
  SHIPPED: 5,
  DELIVERED: 6,
};

// Map the slowest item's fulfillment stage to a candidate order status.
function fulfillmentStageToOrderStatus(rank: number): OrderStatus | null {
  switch (rank) {
    case 1: return OrderStatus.PROCESSING;
    case 2: return OrderStatus.MANUFACTURING;
    case 3: return OrderStatus.SHIPPED;
    case 4: return OrderStatus.DELIVERED;
    default: return null; // 0 (PENDING): leave the pre-fulfillment status alone
  }
}

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private promotionsService: PromotionsService,
    private shippingService: ShippingService,
    private mail: MailService,
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
      variant: {
        include: {
          product: {
            include: {
              translations: true,
              images: { take: 1, orderBy: { sort_order: 'asc' as const } },
            },
          },
        },
      },
      custom_product: {
        include: {
          translations: true,
          mockup_images: { take: 1, orderBy: { sort_order: 'asc' as const } },
          product: {
            include: {
              translations: true,
              images: { take: 1, orderBy: { sort_order: 'asc' as const } },
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
    if (!customer) throw new NotFoundException({ code: 'ORDER_CUSTOMER_NOT_FOUND', message: 'Customer not found' });

    // Load the cart
    const cart = await this.prisma.cart.findUnique({
      where: { customer_id: customer.id },
      include: { items: true },
    });

    if (!cart || cart.items.length === 0) {
      throw new BadRequestException({ code: 'ORDER_CART_EMPTY', message: 'Cart is empty' });
    }

    // Calculate prices
    let subtotal = 0;
    let providerBaseTotal = 0; // what providers are owed (their base prices)
    let creatorMarginTotal = 0; // what creators are owed (their markup or creator-only revenue)
    const orderItems: any[] = [];

    // Collected during the loop and decremented atomically before order.create.
    // Only items whose product/variant tracks inventory go in here — others are
    // treated as unlimited (consistent with track_inventory=false / null stock).
    const stockOps: { kind: 'product' | 'variant'; id: string; qty: number }[] = [];

    // Independent stores sell only the creator's own products — resolve the
    // store type up front so provider-fulfilled lines are rejected below.
    const orderStore = dto.store_id
      ? await this.prisma.store.findUnique({
          where: { id: dto.store_id },
          select: { store_type: true },
        })
      : null;
    const isIndependentStore = orderStore?.store_type === StoreType.INDEPENDENT;

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
        // Variants track stock when stock_quantity is non-null.
        if (variant.stock_quantity != null) {
          stockOps.push({ kind: 'variant', id: variant.id, qty: item.quantity });
        }
      } else if (item.product_id) {
        const product = await this.prisma.product.findUnique({
          where: { id: item.product_id },
        });
        if (!product) throw new NotFoundException(`Product ${item.product_id} not found`);

        unitPrice = Number(product.base_price);
        if (product.provider_id) providerBasePrice = unitPrice;
        fulfillerId = product.provider_id || product.creator_id || '';
        fulfillerType = product.provider_id ? 'PROVIDER' : 'CREATOR';
        // Only enforce when the seller actually tracks inventory for this product.
        if (product.track_inventory && product.stock_quantity != null) {
          stockOps.push({ kind: 'product', id: product.id, qty: item.quantity });
        }
      }

      // Independent stores never sell custom products (provider resells) — not
      // even creator-only ones (base product without a provider), which would
      // otherwise slip past the PROVIDER check below.
      if (isIndependentStore && item.custom_product_id) {
        throw new BadRequestException({
          code: 'ORDER_INDEPENDENT_STORE_CUSTOM_ITEM',
          message: 'This store can only sell its own products. Please remove unavailable items from your cart.',
        });
      }

      // Independent stores are creator-only: reject any line fulfilled by a
      // provider (provider products, or custom products backed by a provider).
      if (isIndependentStore && fulfillerType === 'PROVIDER') {
        throw new BadRequestException({
          code: 'ORDER_INDEPENDENT_STORE_PROVIDER_ITEM',
          message: 'This store can only sell its own products. Please remove supplier items from your cart.',
        });
      }

      // Apply bundle pricing if this cart line carries a bundle offer
      let originalUnitPrice: number | null = null;
      if (item.bundle_offer_id) {
        const offer = await this.prisma.bundleOffer.findUnique({
          where: { id: item.bundle_offer_id },
          include: { bundle: true },
        });
        if (!offer || offer.bundle.status !== 'ACTIVE') {
          throw new BadRequestException({ code: 'ORDER_BUNDLE_OFFER_UNAVAILABLE', message: 'Bundle offer is no longer available' });
        }
        const pricing = computeBundlePricing(unitPrice, {
          quantity: offer.quantity,
          discount_type: offer.discount_type,
          discount_value: offer.discount_value as any,
        });
        // Quantity must be a positive multiple of the bundle's cart quantity
        if (
          pricing.cartQuantity <= 0 ||
          item.quantity % pricing.cartQuantity !== 0
        ) {
          throw new BadRequestException(
            `Bundle requires quantity in multiples of ${pricing.cartQuantity}`,
          );
        }
        originalUnitPrice = unitPrice;
        unitPrice = pricing.effectiveUnitPrice;

        // Reject the order outright if the bundle discount would force a
        // sale below provider cost. The previous behaviour silently capped
        // the provider's payout — that was unfair to providers. With the
        // economic guard at attach/cart time this case should only trigger
        // when provider pricing changed after the line entered the cart.
        if (providerBasePrice > 0 && unitPrice < providerBasePrice) {
          throw new BadRequestException(
            { code: 'ORDER_BUNDLE_BELOW_PROVIDER_COST', message: 'Bundle pricing would sell this item below provider cost. Remove the bundle or adjust pricing.' },
          );
        }
      }

      const totalPrice = unitPrice * item.quantity;
      // Defensive clamp kept for any non-bundle edge case; the bundle path is
      // already guaranteed safe above.
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
        bundle_offer_id: item.bundle_offer_id || null,
        quantity: item.quantity,
        unit_price: unitPrice,
        original_unit_price: originalUnitPrice,
        total_price: totalPrice,
        provider_base_amount: providerBaseForItem,
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
    if (!shippingAddress) throw new NotFoundException({ code: 'ORDER_SHIPPING_ADDRESS_NOT_FOUND', message: 'Shipping address not found' });

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

    // ── Stock: atomically decrement before creating the order. The conditional
    // updateMany (where stock_quantity >= qty) is race-safe — if two buyers
    // race for the last unit only one of their updates returns count===1, the
    // other gets count===0 and is rejected. Any already-decremented op gets
    // restored on failure so the order either fully succeeds or no stock moves.
    const decrementedStock: typeof stockOps = [];
    try {
      for (const op of stockOps) {
        const res =
          op.kind === 'variant'
            ? await this.prisma.productVariant.updateMany({
                where: { id: op.id, stock_quantity: { gte: op.qty } },
                data: { stock_quantity: { decrement: op.qty } },
              })
            : await this.prisma.product.updateMany({
                where: {
                  id: op.id,
                  track_inventory: true,
                  stock_quantity: { gte: op.qty },
                },
                data: { stock_quantity: { decrement: op.qty } },
              });
        if (res.count === 0) {
          throw new BadRequestException({
            code: 'ORDER_INSUFFICIENT_STOCK',
            message:
              'Sorry — one of the items in your cart just sold out. Please refresh and try again.',
          });
        }
        decrementedStock.push(op);
      }
    } catch (err) {
      await this.restoreStock(decrementedStock);
      throw err;
    }

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
      // Order creation failed AFTER stock was decremented — restore so the
      // sold-out signal doesn't stick to a non-existent order.
      await this.restoreStock(decrementedStock);
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

    // Commission split. Independent stores take no platform commission and
    // have no provider share — the creator keeps the full order total
    // (subtotal - discount + shipping). Marketplace stores: platform takes %,
    // rest split between provider (base) and creator (margin).
    let platformAmount = 0;
    let providerAmount = 0;
    let creatorAmount = 0;
    if (isIndependentStore) {
      creatorAmount = total;
    } else {
      const commissionPercent = platformConfig
        ? Number(platformConfig.commission_value)
        : 15;
      const split = this.computeMarketplaceCommission({
        subtotal,
        discountAmount,
        providerBaseTotal,
        creatorMarginTotal,
        commissionPercent,
      });
      platformAmount = split.platformAmount;
      providerAmount = split.providerAmount;
      creatorAmount = split.creatorAmount;
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

    // Empty the cart.
    await this.prisma.cartItem.deleteMany({
      where: { cart_id: cart.id },
    });

    // Order-related emails — best-effort, never blocks the order flow.
    // COD orders are real at creation, so we notify the customer and the
    // store owner now. Card orders wait for payment success (PaymentsService
    // dispatches both events once the Stripe payment is confirmed) so we
    // don't spam the owner about orders that may end up failing.
    if (paymentMethod === 'COD') {
      await this.mail.dispatchOrderEmail(order.id, 'order_confirmation');
      await this.mail.dispatchOrderEmail(order.id, 'new_order_owner');
    }

    return order;
  }

  /**
   * Marketplace commission split: the platform takes a percentage of
   * (subtotal - discount); the remaining payout pool is distributed pro-rata
   * between the aggregate provider base and the creator margin, both scaled by
   * the discount factor. Shared by create() and recomputeCommissionForOrder()
   * so the two can never drift apart.
   */
  private computeMarketplaceCommission(input: {
    subtotal: number;
    discountAmount: number;
    providerBaseTotal: number;
    creatorMarginTotal: number;
    commissionPercent: number;
  }): { platformAmount: number; providerAmount: number; creatorAmount: number } {
    const {
      subtotal,
      discountAmount,
      providerBaseTotal,
      creatorMarginTotal,
      commissionPercent,
    } = input;

    const commissionBase = subtotal - discountAmount;
    const platformAmount =
      Math.round(commissionBase * (commissionPercent / 100) * 100) / 100;

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
      providerAmount =
        Math.round((payoutPool * scaledProviderBase / totalScaled) * 100) / 100;
      // Ensure providerAmount never exceeds payoutPool due to rounding
      if (providerAmount > payoutPool) providerAmount = payoutPool;
      creatorAmount = Math.max(
        0,
        Math.round((payoutPool - providerAmount) * 100) / 100,
      );
    }

    return { platformAmount, providerAmount, creatorAmount };
  }

  /**
   * Re-derive an unpaid order's commission split from the store's CURRENT
   * store_type. An admin can flip a store between MARKETPLACE and INDEPENDENT
   * while unpaid orders exist; without this, the commission row created at
   * order time would drive the wrong payout behaviour at payment time.
   * Paid orders are never touched — their ledger is settled history.
   */
  async recomputeCommissionForOrder(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          select: { provider_base_amount: true, fulfiller_type: true },
        },
        commission: true,
      },
    });
    if (!order) return;
    if (order.payment_status === 'paid') return;

    const store = order.store_id
      ? await this.prisma.store.findUnique({
          where: { id: order.store_id },
          select: { store_type: true },
        })
      : null;
    const isIndependentStore = store?.store_type === StoreType.INDEPENDENT;

    let platformAmount = 0;
    let providerAmount = 0;
    let creatorAmount = 0;
    if (isIndependentStore) {
      // Independent stores: no platform cut, no provider share — the creator
      // keeps the full order total (charged directly on their own account).
      creatorAmount = Number(order.total);
    } else {
      const platformConfig = await this.prisma.platformConfig.findFirst();
      const commissionPercent = platformConfig
        ? Number(platformConfig.commission_value)
        : 15;
      const subtotal = Number(order.subtotal);
      const providerBaseTotal = order.items.reduce(
        (sum, i) => sum + Number(i.provider_base_amount),
        0,
      );
      const split = this.computeMarketplaceCommission({
        subtotal,
        discountAmount: Number(order.discount_amount),
        providerBaseTotal,
        creatorMarginTotal: subtotal - providerBaseTotal,
        commissionPercent,
      });
      platformAmount = split.platformAmount;
      providerAmount = split.providerAmount;
      creatorAmount = split.creatorAmount;
    }

    // Upsert: the row can legitimately be missing because commission creation
    // at order time is best-effort (failures are swallowed).
    await this.prisma.orderCommission.upsert({
      where: { order_id: order.id },
      create: {
        order_id: order.id,
        platform_amount: platformAmount,
        provider_amount: providerAmount,
        creator_amount: creatorAmount,
        currency: order.currency,
      },
      update: {
        platform_amount: platformAmount,
        provider_amount: providerAmount,
        creator_amount: creatorAmount,
      },
    });
  }

  async findByCustomer(userId: string, page = 1, limit = 20) {
    const customer = await this.prisma.customer.findUnique({
      where: { user_id: userId },
    });
    if (!customer) throw new NotFoundException({ code: 'ORDER_CUSTOMER_NOT_FOUND', message: 'Customer not found' });

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

  // Generic fulfiller lookup (used by /orders/fulfiller/:id endpoint)
  async findByFulfiller(fulfillerId: string, page = 1, limit = 20) {
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

  async findById(id: string, userId?: string, role?: UserRole) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        items: this.itemsWithProduct,
        commission: true,
        timeline: { orderBy: { created_at: 'asc' } },
        address: true,
        customer: true,
        payouts: { orderBy: { created_at: 'asc' } },
      },
    });

    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });

    // Admin sees everything (full payment details + all payouts).
    if (role === UserRole.ADMIN) return order;

    // Everyone else: hide the customer's card/charge/receipt details, and scope
    // payouts to the requesting fulfiller (a provider/creator sees only theirs).
    const {
      stripe_charge_id: _c,
      stripe_payment_id: _p,
      card_brand: _b,
      card_last4: _l,
      receipt_url: _r,
      payouts,
      ...safe
    } = order;
    void _c;
    void _p;
    void _b;
    void _l;
    void _r;

    let scopedPayouts: typeof payouts = [];
    if (
      (role === UserRole.PROVIDER || role === UserRole.CREATOR) &&
      userId
    ) {
      const fulfillerId = await this.resolveFulfillerId(userId, role);
      scopedPayouts = payouts.filter((p) => p.recipient_id === fulfillerId);
    }
    return { ...safe, payouts: scopedPayouts };
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

  /**
   * Resolve the fulfiller (provider/creator) profile id for a given user.
   * Returns null when the role doesn't have a fulfiller profile.
   */
  private async resolveFulfillerId(userId: string, userRole: UserRole): Promise<string | null> {
    if (userRole === UserRole.PROVIDER) {
      const provider = await this.prisma.provider.findUnique({ where: { user_id: userId } });
      return provider?.id ?? null;
    }
    if (userRole === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
      return creator?.id ?? null;
    }
    return null;
  }

  /**
   * Recompute an order's overall status from its items: it reflects the slowest
   * item (only SHIPPED once every item ships, DELIVERED once all are delivered).
   * Advance-only — never rolls a status backward — and leaves terminal states
   * (CANCELLED/REFUNDED/RETURNED) untouched.
   */
  private async recomputeOrderStatusFromItems(
    orderId: string,
  ): Promise<{ from: OrderStatus; to: OrderStatus } | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    if (!order) return null;
    const terminal: OrderStatus[] = [
      OrderStatus.CANCELLED,
      OrderStatus.REFUNDED,
      OrderStatus.RETURNED,
    ];
    if (terminal.includes(order.status)) return null;

    const items = await this.prisma.orderItem.findMany({
      where: { order_id: orderId },
      select: { fulfillment_status: true },
    });
    if (items.length === 0) return null;

    const minRank = Math.min(
      ...items.map((i) => FULFILLMENT_RANK[i.fulfillment_status] ?? 0),
    );
    const candidate = fulfillmentStageToOrderStatus(minRank);
    if (!candidate) return null;
    // Advance only.
    if ((ORDER_STATUS_RANK[candidate] ?? 0) <= (ORDER_STATUS_RANK[order.status] ?? 0)) {
      return null;
    }

    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: candidate },
    });
    await this.prisma.orderTimeline.create({
      data: {
        order_id: orderId,
        status: candidate,
        note: 'Auto-updated from item fulfillment',
        actor: 'system',
      },
    });
    await this.prisma.orderCommission.updateMany({
      where: { order_id: orderId },
      data: { status: deriveCommissionStatus(candidate) },
    });
    return { from: order.status, to: candidate };
  }

  /**
   * Map a status transition to the matching customer email. Best-effort and
   * triggered ONLY when the status actually changes; no-ops for intermediate
   * states like PROCESSING/CONFIRMED where we don't want to spam the inbox.
   */
  private async dispatchStatusEmail(
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    note?: string,
  ): Promise<void> {
    if (from === to) return;
    switch (to) {
      case OrderStatus.SHIPPED: {
        // Use the first non-empty tracking number found on any item.
        const item = await this.prisma.orderItem.findFirst({
          where: { order_id: orderId, tracking_number: { not: null } },
          select: { tracking_number: true, tracking_url: true },
        });
        await this.mail.dispatchOrderEmail(orderId, 'order_shipped', {
          trackingNumber: item?.tracking_number ?? undefined,
          trackingUrl: item?.tracking_url ?? undefined,
        });
        return;
      }
      case OrderStatus.DELIVERED:
        await this.mail.dispatchOrderEmail(orderId, 'order_delivered');
        return;
      case OrderStatus.CANCELLED:
        await this.mail.dispatchOrderEmail(orderId, 'order_cancelled', { reason: note });
        return;
      case OrderStatus.REFUNDED: {
        const o = await this.prisma.order.findUnique({
          where: { id: orderId },
          select: { total: true },
        });
        await this.mail.dispatchOrderEmail(orderId, 'order_refunded', {
          refundAmount: o ? Number(o.total) : undefined,
        });
        return;
      }
      default:
        return;
    }
  }

  /**
   * Update an order's status.
   * - ADMIN: sets the order status directly and cascades it onto all items.
   * - PROVIDER/CREATOR: advances ONLY their own items' fulfillment to the mapped
   *   stage; the overall order status is then re-derived from all items. This is
   *   what makes mixed-fulfiller orders work — each side advances its own items
   *   and the order header follows the slowest item automatically.
   */
  async updateStatus(id: string, dto: UpdateOrderStatusDto, actorId: string, actorRole: UserRole) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });

    if (actorRole === UserRole.ADMIN) {
      await this.prisma.order.update({ where: { id }, data: { status: dto.status } });
      await this.prisma.orderTimeline.create({
        data: { order_id: id, status: dto.status, note: dto.note, actor: actorId },
      });
      await this.prisma.orderCommission.updateMany({
        where: { order_id: id },
        data: { status: deriveCommissionStatus(dto.status) },
      });
      const nextFulfillment = deriveFulfillmentStatus(dto.status);
      if (nextFulfillment) {
        await this.prisma.orderItem.updateMany({
          where: { order_id: id },
          data: { fulfillment_status: nextFulfillment },
        });
      }
      await this.dispatchStatusEmail(id, order.status, dto.status, dto.note);
      return this.findById(id, actorId, actorRole);
    }

    // Provider/Creator — advance only their own items.
    const expectedType =
      actorRole === UserRole.PROVIDER ? FulfillerType.PROVIDER : FulfillerType.CREATOR;
    const fulfillerId = await this.resolveFulfillerId(actorId, actorRole);
    if (!fulfillerId) {
      throw new ForbiddenException({ code: 'ORDER_FULFILLER_PROFILE_NOT_FOUND', message: 'Fulfiller profile not found for this user' });
    }

    const targetFulfillment = deriveFulfillmentStatus(dto.status);
    if (!targetFulfillment) {
      throw new BadRequestException('This status cannot be set by a fulfiller');
    }

    const res = await this.prisma.orderItem.updateMany({
      where: { order_id: id, fulfiller_id: fulfillerId, fulfiller_type: expectedType },
      data: { fulfillment_status: targetFulfillment },
    });
    if (res.count === 0) {
      throw new ForbiddenException({ code: 'ORDER_NO_OWNED_ITEMS', message: 'You have no items to fulfill in this order' });
    }

    await this.prisma.orderTimeline.create({
      data: {
        order_id: id,
        status: dto.status,
        note: dto.note ?? `${expectedType} items → ${targetFulfillment}`,
        actor: actorId,
      },
    });

    const transition = await this.recomputeOrderStatusFromItems(id);
    if (transition) {
      await this.dispatchStatusEmail(id, transition.from, transition.to, dto.note);
    }
    return this.findById(id, actorId, actorRole);
  }

  async updateFulfillment(
    orderId: string,
    itemId: string,
    dto: UpdateFulfillmentDto,
    actorId: string,
    actorRole: UserRole,
  ) {
    // Per-item check: the actor must be the item's own fulfiller. Mixed orders
    // are fine here — each side updates only the items they actually fulfill.
    const item = await this.prisma.orderItem.findFirst({
      where: { id: itemId, order_id: orderId },
      select: { id: true, fulfiller_id: true, fulfiller_type: true },
    });
    if (!item) throw new NotFoundException({ code: 'ORDER_ITEM_NOT_FOUND', message: 'Order item not found' });

    if (actorRole !== UserRole.ADMIN) {
      const expectedType =
        actorRole === UserRole.PROVIDER ? FulfillerType.PROVIDER : FulfillerType.CREATOR;
      const fulfillerId = await this.resolveFulfillerId(actorId, actorRole);
      if (
        !fulfillerId ||
        item.fulfiller_type !== expectedType ||
        item.fulfiller_id !== fulfillerId
      ) {
        throw new ForbiddenException({ code: 'ORDER_FULFILLMENT_NOT_OWNED', message: 'You can only update fulfillment for items you fulfill' });
      }
    }

    const updated = await this.prisma.orderItem.update({
      where: { id: itemId, order_id: orderId },
      data: {
        fulfillment_status: dto.fulfillment_status,
        tracking_number: dto.tracking_number,
        tracking_url: dto.tracking_url,
      },
    });

    // Re-derive the overall order status from all items (slowest item wins).
    const transition = await this.recomputeOrderStatusFromItems(orderId);
    if (transition) {
      await this.dispatchStatusEmail(orderId, transition.from, transition.to);
    }
    return updated;
  }

  // ── Payment status transitions (called from the Stripe webhook) ──────────────
  // Both methods are idempotent: replaying the same webhook event leaves the
  // order untouched on the second pass. They return the order plus a `changed`
  // flag so the caller can decide whether to fire a notification.

  async markOrderPaid(orderId: string, stripePaymentId?: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: { select: { user_id: true } } },
    });
    if (!order) return null;
    if (order.payment_status === 'paid') return { order, changed: false };

    // Guard on payment_status so concurrent webhook deliveries can't both flip
    // the order (and double-insert a timeline row): only the first wins.
    const flip = await this.prisma.order.updateMany({
      where: { id: orderId, payment_status: { not: 'paid' } },
      data: {
        payment_status: 'paid',
        paid_at: new Date(),
        // Move a freshly-placed order forward; never roll back a later status.
        status:
          order.status === OrderStatus.PENDING
            ? OrderStatus.CONFIRMED
            : order.status,
        ...(stripePaymentId ? { stripe_payment_id: stripePaymentId } : {}),
      },
    });
    if (flip.count === 0) return { order, changed: false };

    await this.prisma.orderTimeline.create({
      data: {
        order_id: orderId,
        status: 'PAID',
        note: 'Payment confirmed via Stripe',
        actor: 'system',
      },
    });
    return { order, changed: true };
  }

  async markOrderFailed(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: { select: { user_id: true } } },
    });
    if (!order) return null;
    // Never override an already-paid order, and don't duplicate a failure.
    if (order.payment_status === 'paid' || order.payment_status === 'failed') {
      return { order, changed: false };
    }

    const flip = await this.prisma.order.updateMany({
      where: { id: orderId, payment_status: { notIn: ['paid', 'failed'] } },
      data: { payment_status: 'failed' },
    });
    if (flip.count === 0) return { order, changed: false };

    await this.prisma.orderTimeline.create({
      data: {
        order_id: orderId,
        status: 'PAYMENT_FAILED',
        note: 'Stripe reported the payment failed',
        actor: 'system',
      },
    });
    // Failed payment → restock the order's items so the inventory isn't
    // permanently locked by an order that won't ship. Idempotent because
    // markOrderFailed only runs the flip once per order (guarded payment_status).
    await this.restoreOrderItemsStock(orderId);
    return { order, changed: true };
  }

  /**
   * Restore stock for a list of operations recorded during order creation.
   * Best-effort: a failure in one restore is logged and does not stop the rest,
   * since this runs on the error path of order creation.
   */
  private async restoreStock(
    ops: { kind: 'product' | 'variant'; id: string; qty: number }[],
  ) {
    for (const op of ops) {
      try {
        if (op.kind === 'variant') {
          await this.prisma.productVariant.update({
            where: { id: op.id },
            data: { stock_quantity: { increment: op.qty } },
          });
        } else {
          await this.prisma.product.update({
            where: { id: op.id },
            data: { stock_quantity: { increment: op.qty } },
          });
        }
      } catch (err) {
        console.error('[StockRestore] failed for', op, err);
      }
    }
  }

  /**
   * Restore stock for every line of an already-created order — used when a
   * payment fails (or, in the future, when an order is cancelled). The
   * updateMany guards ensure untracked items are never written, so this is a
   * no-op for products/variants that don't track inventory.
   */
  private async restoreOrderItemsStock(orderId: string) {
    const items = await this.prisma.orderItem.findMany({
      where: { order_id: orderId },
      select: { product_id: true, variant_id: true, quantity: true },
    });
    for (const it of items) {
      try {
        if (it.variant_id) {
          await this.prisma.productVariant.updateMany({
            where: { id: it.variant_id, stock_quantity: { not: null } },
            data: { stock_quantity: { increment: it.quantity } },
          });
        } else if (it.product_id) {
          await this.prisma.product.updateMany({
            where: {
              id: it.product_id,
              track_inventory: true,
              stock_quantity: { not: null },
            },
            data: { stock_quantity: { increment: it.quantity } },
          });
        }
      } catch (err) {
        console.error('[StockRestore] order item restore failed', it, err);
      }
    }
  }
}
