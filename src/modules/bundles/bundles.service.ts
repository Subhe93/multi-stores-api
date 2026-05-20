import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBundleDto, UpdateBundleDto } from './dto/bundle.dto';
import { Prisma } from '@prisma/client';
import {
  validateBundleEconomics,
  formatViolationsMessage,
  type ProductForBundleCheck,
} from './bundle-economics.util';
import { BundleOfferLike } from './bundle-pricing.util';

interface OfferLike {
  quantity: number;
  discount_type: string;
  discount_value: number;
}

function assertOffersValid(offers: OfferLike[] | undefined) {
  if (!offers) return;
  for (let i = 0; i < offers.length; i++) {
    const o = offers[i];
    if (o.discount_type === 'PERCENTAGE' && o.discount_value > 100) {
      throw new BadRequestException(
        `Offer ${i + 1}: PERCENTAGE discount cannot exceed 100`,
      );
    }
  }
}

const bundleInclude = {
  translations: true,
  offers: {
    include: { translations: true },
    orderBy: { sort_order: 'asc' as const },
  },
  products: { select: { product_id: true } },
  custom_products: { select: { custom_product_id: true } },
} satisfies Prisma.BundleInclude;

@Injectable()
export class BundlesService {
  constructor(private prisma: PrismaService) {}

  private async resolveCreatorId(userId: string): Promise<string> {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
    });
    if (!creator) throw new NotFoundException('Creator profile not found');
    return creator.id;
  }

  /**
   * Load the pricing data needed to check whether a set of products can safely
   * carry the given bundle offers. Public so the products/custom-products
   * services can share the same logic when bundles are attached from their side.
   *
   * Custom products with PER_VARIANT or MARGIN pricing are intentionally
   * skipped — their effective price varies per variant, so a single static
   * check against provider cost would be misleading. The bundle is still
   * allowed; we just don't enforce the economic floor on those.
   */
  async loadProductsForBundleCheck(
    productIds: string[],
    customProductIds: string[],
  ): Promise<ProductForBundleCheck[]> {
    const result: ProductForBundleCheck[] = [];

    if (productIds.length > 0) {
      const products = await this.prisma.product.findMany({
        where: { id: { in: productIds } },
        select: {
          id: true,
          base_price: true,
          provider_id: true,
          translations: { take: 1, select: { title: true } },
        },
      });
      for (const p of products) {
        const base = Number(p.base_price);
        result.push({
          id: p.id,
          unitPrice: base,
          providerBasePrice: p.provider_id ? base : 0,
          title: p.translations[0]?.title,
        });
      }
    }

    if (customProductIds.length > 0) {
      const customs = await this.prisma.customProduct.findMany({
        where: { id: { in: customProductIds } },
        select: {
          id: true,
          final_price: true,
          pricing_type: true,
          translations: { take: 1, select: { title: true } },
          product: { select: { base_price: true, provider_id: true } },
        },
      });
      for (const cp of customs) {
        // Only SINGLE pricing has a well-defined unit price for this static
        // check. PER_VARIANT/MARGIN are skipped — their pricing depends on
        // the variant chosen at checkout.
        if (cp.pricing_type !== 'SINGLE') continue;
        const unit = Number(cp.final_price) || Number(cp.product.base_price);
        result.push({
          id: cp.id,
          unitPrice: unit,
          providerBasePrice: cp.product.provider_id
            ? Number(cp.product.base_price)
            : 0,
          title: cp.translations[0]?.title,
        });
      }
    }

    return result;
  }

  /**
   * Throw BadRequestException if any (product, offer) combination would sell
   * below the provider's base cost. Skips silently when nothing is attached.
   */
  async assertBundleEconomicallyValid(
    offers: BundleOfferLike[],
    productIds: string[],
    customProductIds: string[],
  ) {
    if (offers.length === 0) return;
    if (productIds.length === 0 && customProductIds.length === 0) return;

    const products = await this.loadProductsForBundleCheck(
      productIds,
      customProductIds,
    );
    const result = validateBundleEconomics(offers, products);
    if (!result.valid) {
      throw new BadRequestException(formatViolationsMessage(result.violations));
    }
  }

  async create(userId: string, dto: CreateBundleDto) {
    assertOffersValid(dto.offers);
    const creatorId = await this.resolveCreatorId(userId);
    const productIds = dto.product_ids ?? [];
    const customProductIds = dto.custom_product_ids ?? [];

    await this.assertBundleEconomicallyValid(
      dto.offers,
      productIds,
      customProductIds,
    );

    return this.prisma.bundle.create({
      data: {
        creator_id: creatorId,
        status: dto.status ?? 'ACTIVE',
        translations: { create: dto.translations },
        offers: {
          create: dto.offers.map((o) => ({
            quantity: o.quantity,
            discount_type: o.discount_type,
            discount_value: o.discount_value,
            external_ref: o.external_ref,
            sort_order: o.sort_order,
            translations: { create: o.translations },
          })),
        },
        ...(productIds.length > 0 && {
          products: {
            create: productIds.map((product_id) => ({ product_id })),
          },
        }),
        ...(customProductIds.length > 0 && {
          custom_products: {
            create: customProductIds.map((custom_product_id) => ({
              custom_product_id,
            })),
          },
        }),
      },
      include: bundleInclude,
    });
  }

  async findByOwner(
    userId: string,
    page = 1,
    limit = 20,
    q?: string,
  ) {
    const creatorId = await this.resolveCreatorId(userId);
    const skip = (page - 1) * limit;

    const where: Prisma.BundleWhereInput = {
      creator_id: creatorId,
      ...(q && q.trim()
        ? {
            translations: {
              some: { name: { contains: q.trim(), mode: 'insensitive' } },
            },
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.bundle.findMany({
        where,
        skip,
        take: limit,
        include: bundleInclude,
        orderBy: { updated_at: 'desc' },
      }),
      this.prisma.bundle.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findById(id: string, userId: string) {
    const creatorId = await this.resolveCreatorId(userId);
    const bundle = await this.prisma.bundle.findUnique({
      where: { id },
      include: bundleInclude,
    });
    if (!bundle) throw new NotFoundException('Bundle not found');
    if (bundle.creator_id !== creatorId) {
      throw new ForbiddenException('You can only access your own bundles');
    }
    return bundle;
  }

  async update(id: string, userId: string, dto: UpdateBundleDto) {
    assertOffersValid(dto.offers);
    const creatorId = await this.resolveCreatorId(userId);
    const existing = await this.prisma.bundle.findUnique({
      where: { id },
      select: {
        creator_id: true,
        offers: { select: { quantity: true, discount_type: true, discount_value: true } },
        products: { select: { product_id: true } },
        custom_products: { select: { custom_product_id: true } },
      },
    });
    if (!existing) throw new NotFoundException('Bundle not found');
    if (existing.creator_id !== creatorId) {
      throw new ForbiddenException('You can only edit your own bundles');
    }

    // Economic check uses incoming changes where provided, otherwise falls back
    // to what's already on the bundle. This catches both (a) replacing offers
    // with steeper discounts and (b) attaching a new product that can't sustain
    // the existing offers.
    const effectiveOffers: BundleOfferLike[] = dto.offers
      ? dto.offers.map((o) => ({
          quantity: o.quantity,
          discount_type: o.discount_type,
          discount_value: o.discount_value,
        }))
      : existing.offers.map((o) => ({
          quantity: o.quantity,
          discount_type: o.discount_type,
          discount_value: o.discount_value as unknown as number,
        }));
    const effectiveProductIds = dto.product_ids ?? existing.products.map((p) => p.product_id);
    const effectiveCustomIds =
      dto.custom_product_ids ?? existing.custom_products.map((cp) => cp.custom_product_id);

    await this.assertBundleEconomicallyValid(
      effectiveOffers,
      effectiveProductIds,
      effectiveCustomIds,
    );

    const ops: Prisma.PrismaPromise<unknown>[] = [];

    if (dto.translations) {
      ops.push(
        this.prisma.bundleTranslation.deleteMany({ where: { bundle_id: id } }),
        this.prisma.bundleTranslation.createMany({
          data: dto.translations.map((t) => ({ ...t, bundle_id: id })),
        }),
      );
    }

    if (dto.offers) {
      // Cascade deletes child offer translations.
      ops.push(this.prisma.bundleOffer.deleteMany({ where: { bundle_id: id } }));
      for (const o of dto.offers) {
        ops.push(
          this.prisma.bundleOffer.create({
            data: {
              bundle_id: id,
              quantity: o.quantity,
              discount_type: o.discount_type,
              discount_value: o.discount_value,
              external_ref: o.external_ref,
              sort_order: o.sort_order,
              translations: { create: o.translations },
            },
          }),
        );
      }
    }

    if (dto.product_ids) {
      ops.push(
        this.prisma.bundleProduct.deleteMany({ where: { bundle_id: id } }),
      );
      if (dto.product_ids.length > 0) {
        ops.push(
          this.prisma.bundleProduct.createMany({
            data: dto.product_ids.map((product_id) => ({
              bundle_id: id,
              product_id,
            })),
          }),
        );
      }
    }

    if (dto.custom_product_ids) {
      ops.push(
        this.prisma.bundleCustomProduct.deleteMany({
          where: { bundle_id: id },
        }),
      );
      if (dto.custom_product_ids.length > 0) {
        ops.push(
          this.prisma.bundleCustomProduct.createMany({
            data: dto.custom_product_ids.map((custom_product_id) => ({
              bundle_id: id,
              custom_product_id,
            })),
          }),
        );
      }
    }

    if (dto.status !== undefined) {
      ops.push(
        this.prisma.bundle.update({
          where: { id },
          data: { status: dto.status },
        }),
      );
    } else {
      // Bump updated_at even when only children changed.
      ops.push(
        this.prisma.bundle.update({
          where: { id },
          data: { updated_at: new Date() },
        }),
      );
    }

    await this.prisma.$transaction(ops);

    return this.prisma.bundle.findUnique({
      where: { id },
      include: bundleInclude,
    });
  }

  async delete(id: string, userId: string) {
    const creatorId = await this.resolveCreatorId(userId);
    const existing = await this.prisma.bundle.findUnique({
      where: { id },
      select: { creator_id: true },
    });
    if (!existing) throw new NotFoundException('Bundle not found');
    if (existing.creator_id !== creatorId) {
      throw new ForbiddenException('You can only delete your own bundles');
    }

    // Preserve historical attribution: if any order item references one of this
    // bundle's offers, refuse the delete and surface the option to disable instead.
    const orderRefs = await this.prisma.orderItem.count({
      where: { bundle_offer: { bundle_id: id } },
    });
    if (orderRefs > 0) {
      throw new BadRequestException(
        'This bundle is referenced by existing orders. Disable it instead of deleting to keep historical records.',
      );
    }

    await this.prisma.bundle.delete({ where: { id } });
    return { id };
  }

  getTemplates() {
    return [
      {
        id: 'percentage',
        label: 'Percentage discount offers',
        description: 'Buy more, save a higher percentage.',
        offers: [
          {
            quantity: 2,
            discount_type: 'PERCENTAGE',
            discount_value: 10,
            label: '-10%',
          },
          {
            quantity: 4,
            discount_type: 'PERCENTAGE',
            discount_value: 20,
            label: '-20%',
          },
        ],
      },
      {
        id: 'fixed',
        label: 'Fixed price discount offers',
        description: 'Knock a flat amount off the total.',
        offers: [
          {
            quantity: 2,
            discount_type: 'FIXED',
            discount_value: 5,
            label: 'Save $5',
          },
          {
            quantity: 4,
            discount_type: 'FIXED',
            discount_value: 15,
            label: 'Save $15',
          },
        ],
      },
      {
        id: 'bxgy',
        label: 'Buy X get Y offers',
        description: 'Free items the more they buy.',
        offers: [
          {
            quantity: 2,
            discount_type: 'ITEM',
            discount_value: 1,
            label: 'free',
          },
          {
            quantity: 4,
            discount_type: 'ITEM',
            discount_value: 2,
            label: 'free',
          },
        ],
      },
      {
        id: 'custom',
        label: 'Custom',
        description: 'Start blank and build your own offers.',
        offers: [],
      },
    ];
  }
}
