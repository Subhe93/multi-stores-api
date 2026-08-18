import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AddCartItemDto, UpdateCartItemDto } from './dto/cart.dto';
import { computeBundlePricing } from '../bundles/bundle-pricing.util';
import { resolveVariantImage } from '../../common/catalog/variant-image.util';
import { validateBundleEconomics } from '../bundles/bundle-economics.util';

@Injectable()
export class CartService {
  constructor(private prisma: PrismaService) {}

  private async getOrCreateCart(userId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { user_id: userId },
    });
    if (!customer) throw new NotFoundException({ code: 'CART_CUSTOMER_NOT_FOUND', message: 'Customer not found' });

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
   * Pick the translation row for the requested locale, falling back to English
   * and then the first available row. Without this the caller would have to
   * rely on row order, which is alphabetical by locale ('ar' before 'en') and
   * therefore returns the wrong language for the storefront's active locale.
   */
  private pickTranslation<T extends { locale: string }>(
    translations: T[] | undefined,
    locale?: string,
  ): T | undefined {
    if (!translations?.length) return undefined;
    return (
      (locale && translations.find((t) => t.locale === locale)) ||
      translations.find((t) => t.locale === 'en') ||
      translations[0]
    );
  }

  /**
   * Enrich raw cart items with product data (title, price, image, variant info).
   * `locale` selects which translation to surface for the item title.
   */
  private async enrichCartItems(items: any[], locale?: string): Promise<any[]> {
    const enriched: any[] = [];
    const config = await this.prisma.platformConfig.findFirst();
    const platformCurrency = config?.default_currency || 'EUR';

    for (const item of items) {
      let title: string | null = null;
      let price = 0;
      let imageUrl: string | null = null;
      let variantLabel: string | null = null;
      let currency = platformCurrency;
      // Per-value image map for the product behind this line, read once and
      // used when the chosen variant is resolved further down.
      let productOptionConfig: unknown = null;

      if (item.custom_product_id) {
        // Custom product: fetch from CustomProduct with mockup images and base product
        const cp = await this.prisma.customProduct.findUnique({
          where: { id: item.custom_product_id },
          include: {
            translations: true,
            mockup_images: { take: 1, orderBy: { sort_order: 'asc' as const } },
            selected_variants: item.variant_id
              ? { where: { variant_id: item.variant_id } }
              : true,
            product: {
              include: {
                translations: true,
                images: { take: 1, orderBy: { sort_order: 'asc' as const } },
              },
            },
          },
        });
        // Selected in the same round-trip; used only when the creator has not
        // uploaded a mockup (see the image resolution below).
        const cpOptionConfig = cp?.product?.variant_option_config ?? null;

        if (cp) {
          title =
            this.pickTranslation(cp.translations, locale)?.title ||
            this.pickTranslation(cp.product.translations, locale)?.title ||
            null;
          // The creator's own mockup is their design of this product and wins
          // over a per-colour photo of the blank; the colour image only stands
          // in when there is no mockup.
          imageUrl = cp.mockup_images[0]?.url || null;

          // Resolve the chosen variant's adjustment (if any) up front so the
          // pricing math below can use it for PER_VARIANT/MARGIN. This mirrors
          // the calculation in orders.service so cart prices match checkout.
          let variantAdjustment = 0;
          if (item.variant_id) {
            const v = await this.prisma.productVariant.findUnique({
              where: { id: item.variant_id },
              select: { price_adjustment: true, options: true, images: true },
            });
            variantAdjustment = Number(v?.price_adjustment || 0);
            if (!imageUrl && v) {
              imageUrl = resolveVariantImage({
                optionConfig: cpOptionConfig,
                variantOptions: v.options,
                variantImages: v.images,
              });
            }
          }
          imageUrl = imageUrl || cp.product.images[0]?.url || null;

          switch (cp.pricing_type) {
            case 'SINGLE':
              price = Number(cp.final_price);
              break;
            case 'PER_VARIANT': {
              if (item.variant_id) {
                const sv = cp.selected_variants.find(
                  (s: any) => s.variant_id === item.variant_id,
                );
                price = sv?.custom_price
                  ? Number(sv.custom_price)
                  : Number(cp.product.base_price) + variantAdjustment;
              } else {
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
      } else if (item.product_id) {
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
          productOptionConfig = product.variant_option_config;
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
          include: { images: true },
        });

        if (variant) {
          if (!item.custom_product_id) {
            price = price + Number(variant.price_adjustment);

            // Show what the buyer picked, not the generic product shot: the
            // per-value image the creator set for this colour, else an image
            // attached to this variant. Falls through to the product image.
            const variantImage = resolveVariantImage({
              optionConfig: productOptionConfig,
              variantOptions: variant.options,
              variantImages: variant.images,
            });
            if (variantImage) imageUrl = variantImage;
          }
          if (variant.options && typeof variant.options === 'object') {
            const opts = variant.options as Record<string, string>;
            variantLabel = Object.entries(opts)
              .map(([k, v]) => `${k}: ${v}`)
              .join(' / ');
          }
        }
      }

      // Apply bundle pricing if a bundle offer is attached
      let bundleOfferId: string | null = null;
      let bundleOriginalUnitPrice: number | null = null;
      let bundleTitle: string | null = null;
      let bundleLabel: string | null = null;
      let bundleStickerText: string | null = null;
      let bundleCartQuantity: number | null = null;

      if (item.bundle_offer_id) {
        const offer = await this.prisma.bundleOffer.findUnique({
          where: { id: item.bundle_offer_id },
          include: {
            translations: true,
            bundle: { include: { translations: true } },
          },
        });

        if (offer && offer.bundle.status === 'ACTIVE') {
          const pricing = computeBundlePricing(price, {
            quantity: offer.quantity,
            discount_type: offer.discount_type,
            discount_value: offer.discount_value as any,
          });
          bundleOfferId = offer.id;
          bundleOriginalUnitPrice = price;
          price = pricing.effectiveUnitPrice;
          bundleCartQuantity = pricing.cartQuantity;
          const tr = this.pickTranslation(offer.translations, locale);
          bundleTitle = tr?.title || null;
          bundleLabel = tr?.label || null;
          bundleStickerText = tr?.sticker_text || null;
        } else {
          // Offer was deleted or its bundle is disabled — clear the stale
          // reference so checkout doesn't reject the cart later.
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

  /**
   * Validate that a bundle offer exists, is on an ACTIVE bundle, and is linked
   * to the requested product/custom_product. Returns the offer.
   */
  private async validateBundleOffer(
    bundleOfferId: string,
    productId?: string | null,
    customProductId?: string | null,
    variantId?: string | null,
  ) {
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
      throw new BadRequestException({ code: 'CART_BUNDLE_OFFER_NOT_FOUND', message: 'Bundle offer not found' });
    }
    if (offer.bundle.status !== 'ACTIVE') {
      throw new BadRequestException({ code: 'CART_BUNDLE_NOT_ACTIVE', message: 'Bundle is not active' });
    }
    if (productId) {
      const linked = offer.bundle.products.some(
        (p) => p.product_id === productId,
      );
      if (!linked) {
        throw new BadRequestException({ code: 'CART_BUNDLE_NOT_AVAILABLE_FOR_PRODUCT', message: 'Bundle is not available for this product' });
      }
    } else if (customProductId) {
      const linked = offer.bundle.custom_products.some(
        (p) => p.custom_product_id === customProductId,
      );
      if (!linked) {
        throw new BadRequestException({ code: 'CART_BUNDLE_NOT_AVAILABLE_FOR_PRODUCT', message: 'Bundle is not available for this product' });
      }
    }

    // Runtime economics guard: provider prices can change after the bundle was
    // attached. Re-check that this specific offer doesn't push the product below
    // provider cost before letting the customer add it to their cart.
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
    } else if (customProductId) {
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
        // Resolve the exact variant adjustment for this cart line so the
        // economic check operates on the real customer-facing price, not a
        // fallback. Mirrors orders.service pricing logic.
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
              const sv = cp.selected_variants.find(
                (s: any) => s.variant_id === variantId,
              );
              unitPrice = sv?.custom_price
                ? Number(sv.custom_price)
                : Number(cp.product.base_price) + variantAdjustment;
            } else {
              // No variant chosen yet — use the cheapest declared so the
              // check stays conservative (most likely to surface a loss).
              const customPrices = cp.selected_variants
                .map((sv: any) => Number(sv.custom_price ?? 0))
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
      const check = validateBundleEconomics(
        [
          {
            quantity: offer.quantity,
            discount_type: offer.discount_type,
            discount_value: offer.discount_value as unknown as number,
          },
        ],
        [{ id: 'cart-line', unitPrice, providerBasePrice: providerBase }],
      );
      if (!check.valid) {
        throw new BadRequestException({
          code: 'CART_BUNDLE_NOT_PROFITABLE',
          message:
            'This bundle offer is no longer profitable for this product and cannot be applied',
        });
      }
    }

    return offer;
  }

  /**
   * Bundle offers require quantity in multiples of the offer's cartQuantity
   * (e.g. ITEM "buy 2 get 1" → multiples of 3). Reject early so the user
   * doesn't get a surprise at checkout.
   */
  private assertBundleQuantityValid(
    offer: { quantity: number; discount_type: any; discount_value: any },
    quantity: number,
  ) {
    const pricing = computeBundlePricing(1, {
      quantity: offer.quantity,
      discount_type: offer.discount_type,
      discount_value: offer.discount_value,
    });
    if (pricing.cartQuantity <= 0 || quantity % pricing.cartQuantity !== 0) {
      throw new BadRequestException(
        `Bundle requires quantity in multiples of ${pricing.cartQuantity}`,
      );
    }
  }

  async getCart(userId: string, locale?: string) {
    const cart = await this.getOrCreateCart(userId);

    const cartWithItems = await this.prisma.cart.findUnique({
      where: { id: cart.id },
      include: {
        items: true,
      },
    });

    const enrichedItems = await this.enrichCartItems(
      cartWithItems?.items || [],
      locale,
    );

    return {
      id: cartWithItems?.id,
      items: enrichedItems,
    };
  }

  async addItem(userId: string, dto: AddCartItemDto, locale?: string) {
    const cart = await this.getOrCreateCart(userId);

    if (dto.bundle_offer_id) {
      const offer = await this.validateBundleOffer(
        dto.bundle_offer_id,
        dto.product_id,
        dto.custom_product_id,
        dto.variant_id,
      );

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
    } else {
      await this.prisma.cartItem.create({
        data: {
          cart_id: cart.id,
          ...dto,
        },
      });
    }

    // Return enriched cart
    return this.getCart(userId, locale);
  }

  async updateItem(
    userId: string,
    itemId: string,
    dto: UpdateCartItemDto,
    locale?: string,
  ) {
    const cart = await this.getOrCreateCart(userId);

    const item = await this.prisma.cartItem.findFirst({
      where: { id: itemId, cart_id: cart.id },
    });
    if (!item) throw new NotFoundException({ code: 'CART_ITEM_NOT_FOUND', message: 'Cart item not found' });

    const data: { quantity?: number; bundle_offer_id?: string | null } = {};
    if (typeof dto.quantity === 'number') {
      data.quantity = dto.quantity;
    }
    let nextBundleOfferId: string | null = item.bundle_offer_id;
    if (dto.bundle_offer_id !== undefined) {
      if (dto.bundle_offer_id === null) {
        data.bundle_offer_id = null;
        nextBundleOfferId = null;
      } else {
        await this.validateBundleOffer(
          dto.bundle_offer_id,
          item.product_id,
          item.custom_product_id,
          item.variant_id,
        );
        data.bundle_offer_id = dto.bundle_offer_id;
        nextBundleOfferId = dto.bundle_offer_id;
      }
    }

    // Enforce quantity multiples if the resulting line carries a bundle offer.
    if (nextBundleOfferId) {
      const nextQty = data.quantity ?? item.quantity;
      const offer = await this.prisma.bundleOffer.findUnique({
        where: { id: nextBundleOfferId },
      });
      if (offer) this.assertBundleQuantityValid(offer, nextQty);
    }

    if (Object.keys(data).length > 0) {
      await this.prisma.cartItem.update({
        where: { id: itemId },
        data,
      });
    }

    return this.getCart(userId, locale);
  }

  async removeItem(userId: string, itemId: string, locale?: string) {
    const cart = await this.getOrCreateCart(userId);

    await this.prisma.cartItem.delete({
      where: { id: itemId, cart_id: cart.id },
    });

    return this.getCart(userId, locale);
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
