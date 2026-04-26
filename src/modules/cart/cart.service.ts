import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AddCartItemDto, UpdateCartItemDto } from './dto/cart.dto';

@Injectable()
export class CartService {
  constructor(private prisma: PrismaService) {}

  private async getOrCreateCart(userId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { user_id: userId },
    });
    if (!customer) throw new NotFoundException('Customer not found');

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

  /**
   * Enrich raw cart items with product data (title, price, image, variant info).
   */
  private async enrichCartItems(items: any[]): Promise<any[]> {
    const enriched: any[] = [];
    const config = await this.prisma.platformConfig.findFirst();
    const platformCurrency = config?.default_currency || 'EUR';

    for (const item of items) {
      let title: string | null = null;
      let price = 0;
      let imageUrl: string | null = null;
      let variantLabel: string | null = null;
      let currency = platformCurrency;

      if (item.custom_product_id) {
        // Custom product: fetch from CustomProduct with mockup images and base product
        const cp = await this.prisma.customProduct.findUnique({
          where: { id: item.custom_product_id },
          include: {
            translations: { take: 1, orderBy: { locale: 'asc' as const } },
            mockup_images: { take: 1, orderBy: { sort_order: 'asc' as const } },
            product: {
              include: {
                translations: { take: 1, orderBy: { locale: 'asc' as const } },
                images: { take: 1, orderBy: { sort_order: 'asc' as const } },
              },
            },
          },
        });

        if (cp) {
          title = cp.translations[0]?.title || cp.product.translations[0]?.title || null;
          price = Number(cp.final_price || cp.product.base_price);
          imageUrl = cp.mockup_images[0]?.url || cp.product.images[0]?.url || null;
        }
      } else if (item.product_id) {
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

          // If no featured image, get the first image
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
            const opts = variant.options as Record<string, string>;
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

  async getCart(userId: string) {
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

  async addItem(userId: string, dto: AddCartItemDto) {
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
    } else {
      await this.prisma.cartItem.create({
        data: {
          cart_id: cart.id,
          ...dto,
        },
      });
    }

    // Return enriched cart
    return this.getCart(userId);
  }

  async updateItem(userId: string, itemId: string, dto: UpdateCartItemDto) {
    const cart = await this.getOrCreateCart(userId);

    const item = await this.prisma.cartItem.findFirst({
      where: { id: itemId, cart_id: cart.id },
    });
    if (!item) throw new NotFoundException('Cart item not found');

    await this.prisma.cartItem.update({
      where: { id: itemId },
      data: { quantity: dto.quantity },
    });

    return this.getCart(userId);
  }

  async removeItem(userId: string, itemId: string) {
    const cart = await this.getOrCreateCart(userId);

    await this.prisma.cartItem.delete({
      where: { id: itemId, cart_id: cart.id },
    });

    return this.getCart(userId);
  }

  async clearCart(userId: string) {
    const cart = await this.getOrCreateCart(userId);

    await this.prisma.cartItem.deleteMany({
      where: { cart_id: cart.id },
    });

    return { message: 'Cart cleared' };
  }

  async applyCoupon(userId: string, couponCode: string) {
    const cart = await this.getOrCreateCart(userId);

    return {
      cart_id: cart.id,
      coupon_code: couponCode,
      message: 'Coupon applied. Discount will be calculated at checkout.',
    };
  }

  async removeCoupon(userId: string) {
    return { message: 'Coupon removed' };
  }
}
