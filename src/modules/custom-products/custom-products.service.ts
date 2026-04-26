import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ImportMode, PricingType, ProductStatus } from '@prisma/client';
import {
  CreateCustomProductDto,
  UpdateCustomProductDto,
} from './dto/custom-product.dto';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class CustomProductsService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
  ) {}

  // ── Ownership helpers ────────────────────────────────────
  private async assertCreatorOwns(customProductId: string, userId: string) {
    const cp = await this.prisma.customProduct.findUnique({
      where: { id: customProductId },
      include: { creator: { select: { user_id: true } } },
    });
    if (!cp) throw new NotFoundException('Custom product not found');
    if (cp.creator.user_id !== userId) {
      throw new ForbiddenException('You do not own this custom product');
    }
    return cp;
  }

  private async assertProviderOwnsBase(customProductId: string, userId: string) {
    const cp = await this.prisma.customProduct.findUnique({
      where: { id: customProductId },
      include: {
        product: { include: { provider: { select: { user_id: true } } } },
        creator: { select: { user_id: true } },
        translations: true,
      },
    });
    if (!cp) throw new NotFoundException('Custom product not found');
    if (!cp.product.provider || cp.product.provider.user_id !== userId) {
      throw new ForbiddenException('You do not own this base product');
    }
    return cp;
  }

  private readonly includes = {
    product: {
      include: {
        translations: true,
        images: { orderBy: { sort_order: 'asc' as const } },
        variants: { where: { is_active: true } },
        custom_fields: { include: { translations: true }, orderBy: { sort_order: 'asc' as const } },
      },
    },
    mockup_images: true,
    translations: true,
    creator: { select: { display_name: true } },
    selected_variants: { include: { variant: true } },
    field_values: { include: { custom_field: true } },
    faqs: { include: { translations: true }, orderBy: { sort_order: 'asc' as const } },
  };

  async create(userId: string, dto: CreateCustomProductDto) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
    });
    if (!creator) throw new NotFoundException('Creator not found');

    // Validate pricing consistency
    this.validatePricing(dto.pricing_type, dto);

    const { translations, selected_variants, field_values, mockup_image_urls, ...data } = dto;

    // Build variant rows based on import mode
    let variantRows: { variant_id: string; custom_price?: number }[] = [];

    if (dto.import_mode === ImportMode.AS_IS) {
      // Auto-load all active variants from the provider product
      const product = await this.prisma.product.findUnique({
        where: { id: dto.product_id },
        include: { variants: { where: { is_active: true } } },
      });
      if (!product) throw new NotFoundException('Product not found');

      variantRows = product.variants.map((v) => ({
        variant_id: v.id,
        custom_price:
          dto.pricing_type === PricingType.PER_VARIANT
            ? selected_variants?.find((sv) => sv.variant_id === v.id)
                ?.custom_price
            : undefined,
      }));
    } else {
      // CUSTOMIZE mode: use selected_variants if provided
      const product = await this.prisma.product.findUnique({
        where: { id: dto.product_id },
        include: { variants: { where: { is_active: true } } },
      });
      if (!product) throw new NotFoundException('Product not found');

      if (product.variants.length > 0) {
        // Product has variants — require at least one selected
        if (!selected_variants || selected_variants.length === 0) {
          throw new BadRequestException(
            'At least one variant must be selected in CUSTOMIZE mode',
          );
        }

        const validVariantIds = new Set(product.variants.map((v) => v.id));
        for (const sv of selected_variants) {
          if (!validVariantIds.has(sv.variant_id)) {
            throw new BadRequestException(
              `Variant ${sv.variant_id} does not belong to product ${dto.product_id}`,
            );
          }
        }

        variantRows = selected_variants.map((sv) => ({
          variant_id: sv.variant_id,
          custom_price: sv.custom_price,
        }));
      }
      // Product has no variants — variantRows stays empty, which is valid
    }

    return this.prisma.customProduct.create({
      data: {
        product_id: data.product_id,
        creator_id: creator.id,
        import_mode: data.import_mode,
        pricing_type: data.pricing_type,
        final_price: data.final_price ?? 0,
        margin_amount: data.margin_amount,
        translations: { create: translations },
        selected_variants: {
          create: variantRows,
        },
        ...(mockup_image_urls &&
          mockup_image_urls.length > 0 && {
            mockup_images: {
              create: mockup_image_urls.map((url, i) => ({
                url,
                sort_order: i,
              })),
            },
          }),
        ...(field_values &&
          field_values.length > 0 && {
            field_values: {
              create: field_values.map((fv) => ({
                custom_field_id: fv.custom_field_id,
                value: fv.value,
                file_url: fv.file_url,
              })),
            },
          }),
      },
      include: this.includes,
    });
  }

  async findByCreator(userId: string, page = 1, limit = 20) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
    });
    if (!creator) throw new NotFoundException('Creator not found');

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.customProduct.findMany({
        where: { creator_id: creator.id },
        skip,
        take: limit,
        include: this.includes,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.customProduct.count({
        where: { creator_id: creator.id },
      }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findById(id: string) {
    const cp = await this.prisma.customProduct.findUnique({
      where: { id },
      include: this.includes,
    });
    if (!cp) throw new NotFoundException('Custom product not found');
    return cp;
  }

  async update(id: string, dto: UpdateCustomProductDto, userId?: string) {
    const existing = await this.prisma.customProduct.findUnique({
      where: { id },
      include: { creator: { select: { user_id: true } }, product: { select: { provider_id: true } } },
    });
    if (!existing) throw new NotFoundException('Custom product not found');

    // Ownership check
    if (userId && existing.creator.user_id !== userId) {
      throw new ForbiddenException('You do not own this custom product');
    }

    // Auto-revert to PENDING_REVIEW if a content edit happens on a PUBLISHED product with a provider.
    // We FORCE this regardless of what dto.status says — the creator cannot bypass review by
    // re-submitting status: PUBLISHED in the payload.
    const isContentEdit =
      dto.translations !== undefined ||
      dto.mockup_image_urls !== undefined ||
      dto.field_values !== undefined ||
      dto.selected_variants !== undefined ||
      dto.pricing_type !== undefined ||
      dto.final_price !== undefined ||
      dto.margin_amount !== undefined;

    let autoRevertedToReview = false;
    if (
      isContentEdit &&
      existing.status === ProductStatus.PUBLISHED &&
      existing.product.provider_id
    ) {
      dto.status = ProductStatus.PENDING_REVIEW;
      autoRevertedToReview = true;
    }

    // Also: if the product is currently in PENDING_REVIEW, the creator cannot "approve" themselves
    // by sending status: PUBLISHED — block any status change that would publish without provider approval.
    if (
      existing.status === ProductStatus.PENDING_REVIEW &&
      dto.status === ProductStatus.PUBLISHED &&
      existing.product.provider_id
    ) {
      throw new ForbiddenException('Cannot publish a product that is awaiting provider review');
    }

    // If product is REJECTED, content edits should go to DRAFT (not stay rejected) so the
    // creator can submit again. We let them save without auto-submitting — they must click
    // "Resubmit for Review" explicitly.
    if (
      isContentEdit &&
      existing.status === ProductStatus.REJECTED &&
      existing.product.provider_id &&
      dto.status === ProductStatus.PUBLISHED
    ) {
      throw new ForbiddenException('Cannot publish a rejected product without resubmitting for review');
    }

    const pricingType = dto.pricing_type ?? existing.pricing_type;

    // Validate pricing if pricing-related fields changed
    if (dto.pricing_type || dto.final_price !== undefined || dto.margin_amount !== undefined) {
      this.validatePricing(pricingType, {
        final_price: dto.final_price ?? Number(existing.final_price),
        margin_amount: dto.margin_amount ?? (existing.margin_amount ? Number(existing.margin_amount) : undefined),
        selected_variants: dto.selected_variants,
        pricing_type: pricingType,
      });
    }

    const { translations, selected_variants, field_values, mockup_image_urls, ...data } = dto;

    // Replace selected_variants if provided
    if (selected_variants) {
      await this.prisma.customProductVariant.deleteMany({
        where: { custom_product_id: id },
      });
    }

    // Replace field_values if provided
    if (field_values) {
      await this.prisma.customProductFieldValue.deleteMany({
        where: { custom_product_id: id },
      });
    }

    // Replace mockup_images if provided
    if (mockup_image_urls) {
      await this.prisma.customProductImage.deleteMany({
        where: { custom_product_id: id },
      });
    }

    // Replace translations if provided
    if (translations && translations.length > 0) {
      await this.prisma.customProductTranslation.deleteMany({
        where: { custom_product_id: id },
      });
    }

    const updated = await this.prisma.customProduct.update({
      where: { id },
      data: {
        ...data,
        ...(translations &&
          translations.length > 0 && {
            translations: { create: translations },
          }),
        ...(selected_variants && {
          selected_variants: {
            create: selected_variants.map((sv) => ({
              variant_id: sv.variant_id,
              custom_price: sv.custom_price,
            })),
          },
        }),
        ...(field_values && {
          field_values: {
            create: field_values.map((fv) => ({
              custom_field_id: fv.custom_field_id,
              value: fv.value,
              file_url: fv.file_url,
            })),
          },
        }),
        ...(mockup_image_urls && {
          mockup_images: {
            create: mockup_image_urls.map((url, i) => ({
              url,
              sort_order: i,
            })),
          },
        }),
      },
      include: this.includes,
    });

    // Notify provider if product was auto-reverted to PENDING_REVIEW after edit
    if (autoRevertedToReview && existing.product.provider_id) {
      await this.notifyProviderOfSubmission(updated.id, 'CUSTOM_PRODUCT_RESUBMITTED');
    }

    return updated;
  }

  async delete(id: string, userId?: string) {
    if (userId) await this.assertCreatorOwns(id, userId);
    return this.prisma.customProduct.delete({ where: { id } });
  }

  // ── Approval workflow ────────────────────────────────────

  /** Creator submits a custom product for provider review (or auto-publishes if no provider). */
  async submitForReview(id: string, userId: string) {
    const cp = await this.assertCreatorOwns(id, userId);

    if (cp.status !== ProductStatus.DRAFT && cp.status !== ProductStatus.REJECTED) {
      throw new BadRequestException(
        `Cannot submit a custom product with status ${cp.status}`,
      );
    }

    const product = await this.prisma.product.findUnique({
      where: { id: cp.product_id },
      select: { provider_id: true },
    });

    // No provider → auto-publish
    if (!product?.provider_id) {
      return this.prisma.customProduct.update({
        where: { id },
        data: {
          status: ProductStatus.PUBLISHED,
          rejection_reason: null,
          submitted_at: new Date(),
        },
        include: this.includes,
      });
    }

    // Has provider → set to PENDING_REVIEW and notify
    const updated = await this.prisma.customProduct.update({
      where: { id },
      data: {
        status: ProductStatus.PENDING_REVIEW,
        rejection_reason: null,
        submitted_at: new Date(),
      },
      include: this.includes,
    });

    await this.notifyProviderOfSubmission(id, 'CUSTOM_PRODUCT_SUBMITTED');
    return updated;
  }

  /** Provider approves a custom product → PUBLISHED. */
  async approve(id: string, userId: string) {
    const cp = await this.assertProviderOwnsBase(id, userId);

    if (cp.status !== ProductStatus.PENDING_REVIEW) {
      throw new BadRequestException(
        `Cannot approve a custom product with status ${cp.status}`,
      );
    }

    const updated = await this.prisma.customProduct.update({
      where: { id },
      data: {
        status: ProductStatus.PUBLISHED,
        rejection_reason: null,
        reviewed_at: new Date(),
        reviewed_by: userId,
      },
      include: this.includes,
    });

    // Notify creator
    const title = cp.translations?.[0]?.title || 'Your custom product';
    await this.notificationsService.create(
      cp.creator.user_id,
      'CUSTOM_PRODUCT_APPROVED',
      'Custom product approved',
      `${title} has been approved and is now live`,
      { custom_product_id: id },
    );

    return updated;
  }

  /** Provider rejects a custom product with a reason → REJECTED. */
  async reject(id: string, userId: string, reason: string) {
    if (!reason || !reason.trim()) {
      throw new BadRequestException('Rejection reason is required');
    }

    const cp = await this.assertProviderOwnsBase(id, userId);

    if (cp.status !== ProductStatus.PENDING_REVIEW) {
      throw new BadRequestException(
        `Cannot reject a custom product with status ${cp.status}`,
      );
    }

    const updated = await this.prisma.customProduct.update({
      where: { id },
      data: {
        status: ProductStatus.REJECTED,
        rejection_reason: reason.trim(),
        reviewed_at: new Date(),
        reviewed_by: userId,
      },
      include: this.includes,
    });

    // Notify creator
    const title = cp.translations?.[0]?.title || 'Your custom product';
    await this.notificationsService.create(
      cp.creator.user_id,
      'CUSTOM_PRODUCT_REJECTED',
      'Custom product needs changes',
      `${title} was rejected: ${reason.trim()}`,
      { custom_product_id: id, reason: reason.trim() },
    );

    return updated;
  }

  /** Provider's pending reviews — custom products of their products awaiting review. */
  async findPendingReviewsForProvider(userId: string, page = 1, limit = 20) {
    const provider = await this.prisma.provider.findUnique({
      where: { user_id: userId },
    });
    if (!provider) throw new NotFoundException('Provider not found');

    const skip = (page - 1) * limit;
    const where = {
      status: ProductStatus.PENDING_REVIEW,
      product: { provider_id: provider.id },
    };

    const [data, total] = await Promise.all([
      this.prisma.customProduct.findMany({
        where,
        skip,
        take: limit,
        include: this.includes,
        orderBy: { submitted_at: 'asc' },
      }),
      this.prisma.customProduct.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Helper: notify provider that a custom product was submitted/resubmitted. */
  private async notifyProviderOfSubmission(
    customProductId: string,
    type: 'CUSTOM_PRODUCT_SUBMITTED' | 'CUSTOM_PRODUCT_RESUBMITTED',
  ) {
    const cp = await this.prisma.customProduct.findUnique({
      where: { id: customProductId },
      include: {
        product: { include: { provider: { select: { user_id: true } } } },
        translations: true,
        creator: { select: { display_name: true } },
      },
    });
    if (!cp?.product.provider) return;

    const title = cp.translations?.[0]?.title || 'A custom product';
    const creatorName = cp.creator.display_name || 'A creator';
    const isResubmit = type === 'CUSTOM_PRODUCT_RESUBMITTED';

    await this.notificationsService.create(
      cp.product.provider.user_id,
      type,
      isResubmit ? 'Custom product re-submitted' : 'New custom product to review',
      `${creatorName} ${isResubmit ? 'updated' : 'submitted'} "${title}" for your review`,
      { custom_product_id: customProductId },
    );
  }

  // ── FAQ management ────────────────────────────────────────

  async createFaq(customProductId: string, dto: { sort_order?: number; translations: { locale: string; question: string; answer: string }[] }) {
    return this.prisma.customProductFaq.create({
      data: {
        custom_product_id: customProductId,
        sort_order: dto.sort_order ?? 0,
        translations: { create: dto.translations },
      },
      include: { translations: true },
    });
  }

  async findFaqs(customProductId: string) {
    return this.prisma.customProductFaq.findMany({
      where: { custom_product_id: customProductId },
      include: { translations: true },
      orderBy: { sort_order: 'asc' },
    });
  }

  async updateFaq(faqId: string, dto: { sort_order?: number; translations?: { locale: string; question: string; answer: string }[] }) {
    const faq = await this.prisma.customProductFaq.findUnique({ where: { id: faqId } });
    if (!faq) throw new NotFoundException('FAQ not found');

    if (dto.translations && dto.translations.length > 0) {
      await this.prisma.customProductFaqTranslation.deleteMany({ where: { faq_id: faqId } });
    }

    return this.prisma.customProductFaq.update({
      where: { id: faqId },
      data: {
        ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }),
        ...(dto.translations && dto.translations.length > 0 && {
          translations: { create: dto.translations },
        }),
      },
      include: { translations: true },
    });
  }

  async deleteFaq(faqId: string) {
    return this.prisma.customProductFaq.delete({ where: { id: faqId } });
  }

  private validatePricing(
    pricingType: PricingType,
    data: {
      final_price?: number;
      margin_amount?: number;
      selected_variants?: { variant_id: string; custom_price?: number }[];
      pricing_type: PricingType;
    },
  ) {
    switch (pricingType) {
      case PricingType.SINGLE:
        if (data.final_price === undefined || data.final_price === null) {
          throw new BadRequestException(
            'final_price is required when pricing_type is SINGLE',
          );
        }
        break;
      case PricingType.MARGIN:
        if (data.margin_amount === undefined || data.margin_amount === null) {
          throw new BadRequestException(
            'margin_amount is required when pricing_type is MARGIN',
          );
        }
        break;
      case PricingType.PER_VARIANT:
        if (data.selected_variants) {
          const missing = data.selected_variants.filter(
            (sv) => sv.custom_price === undefined || sv.custom_price === null,
          );
          if (missing.length > 0) {
            throw new BadRequestException(
              'custom_price is required for each variant when pricing_type is PER_VARIANT',
            );
          }
        }
        break;
    }
  }
}
