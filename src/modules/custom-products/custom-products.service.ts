import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ImportMode, PricingType, ProductStatus, StoreType } from '@prisma/client';
import {
  CreateCustomProductDto,
  UpdateCustomProductDto,
} from './dto/custom-product.dto';
import { NotificationsService } from '../notifications/notifications.service';
import {
  validateBundleEconomics,
  formatViolationsMessage,
  type ProductForBundleCheck,
} from '../bundles/bundle-economics.util';
import { BundleOfferLike } from '../bundles/bundle-pricing.util';

@Injectable()
export class CustomProductsService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
  ) {}

  /**
   * Same protection as ProductsService: refuse to attach a bundle whose
   * deepest offer would push this custom product's effective price below the
   * provider's base cost.
   */
  private async assertCustomProductCompatibleWithBundles(
    productPricing: ProductForBundleCheck,
    bundleIds: string[],
  ) {
    if (bundleIds.length === 0) return;
    const bundles = await this.prisma.bundle.findMany({
      where: { id: { in: bundleIds } },
      select: {
        id: true,
        offers: {
          select: { quantity: true, discount_type: true, discount_value: true },
        },
      },
    });
    const allViolations = [] as ReturnType<typeof validateBundleEconomics>['violations'];
    for (const b of bundles) {
      const offers: BundleOfferLike[] = b.offers.map((o) => ({
        quantity: o.quantity,
        discount_type: o.discount_type,
        discount_value: o.discount_value as unknown as number,
      }));
      const result = validateBundleEconomics(offers, [productPricing]);
      if (!result.valid) allViolations.push(...result.violations);
    }
    if (allViolations.length > 0) {
      throw new BadRequestException(formatViolationsMessage(allViolations));
    }
  }

  /**
   * Custom products resell provider products, which independent stores are not
   * allowed to do — they sell the creator's own products only. A creator with
   * no store yet is allowed through (existing behavior).
   */
  private async assertStoreAllowsCustomProducts(creatorId: string) {
    const store = await this.prisma.store.findUnique({
      where: { creator_id: creatorId },
      select: { store_type: true },
    });
    if (store?.store_type === StoreType.INDEPENDENT) {
      throw new BadRequestException({
        code: 'CUSTOM_PRODUCT_INDEPENDENT_STORE',
        message: 'Independent stores sell their own products only, so custom products are not available.',
      });
    }
  }

  // ── Ownership helpers ────────────────────────────────────
  private async assertCreatorOwns(customProductId: string, userId: string) {
    const cp = await this.prisma.customProduct.findUnique({
      where: { id: customProductId },
      include: { creator: { select: { user_id: true } } },
    });
    if (!cp) throw new NotFoundException({ code: 'CUSTOM_PRODUCT_NOT_FOUND', message: 'Custom product not found' });
    if (cp.creator.user_id !== userId) {
      throw new ForbiddenException({ code: 'CUSTOM_PRODUCT_NOT_OWNED', message: 'You do not own this custom product' });
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
    if (!cp) throw new NotFoundException({ code: 'CUSTOM_PRODUCT_NOT_FOUND', message: 'Custom product not found' });
    if (!cp.product.provider || cp.product.provider.user_id !== userId) {
      throw new ForbiddenException({ code: 'CUSTOM_PRODUCT_BASE_NOT_OWNED', message: 'You do not own this base product' });
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
    bundles: {
      include: {
        bundle: {
          include: {
            translations: true,
            offers: {
              include: { translations: true },
              orderBy: { sort_order: 'asc' as const },
            },
          },
        },
      },
    },
    creator_categories: {
      include: { creator_category: { include: { translations: true } } },
    },
  };

  /**
   * Attach a custom product to one or more of the creator's own collections.
   * Silently skips any collection id that doesn't belong to this creator
   * (defense-in-depth — DTO can't enforce ownership).
   */
  private async attachCreatorCategories(
    customProductId: string,
    creatorId: string,
    categoryIds: string[],
  ) {
    if (!categoryIds.length) return;
    const owned = await this.prisma.creatorCategory.findMany({
      where: { id: { in: categoryIds }, creator_id: creatorId },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((c) => c.id));
    const toAttach = categoryIds.filter((id) => ownedIds.has(id));
    if (!toAttach.length) return;
    await this.prisma.customProductCreatorCategory.createMany({
      data: toAttach.map((creator_category_id, sort_order) => ({
        custom_product_id: customProductId,
        creator_category_id,
        sort_order,
      })),
      skipDuplicates: true,
    });
  }

  /**
   * Reject any translation whose slug is already in use by this creator's
   * other products or custom products. Empty slugs are skipped — the caller
   * should have already filled them in from the title.
   */
  private async assertSlugsAvailable(
    creatorId: string,
    translations: { slug?: string }[] | undefined,
    excludeCustomProductId?: string,
  ) {
    const slugs = (translations ?? [])
      .map((t) => (t.slug || '').trim())
      .filter((s) => s.length > 0);
    if (!slugs.length) return;

    const [customConflicts, productConflicts] = await Promise.all([
      this.prisma.customProductTranslation.findMany({
        where: {
          slug: { in: slugs },
          custom_product: {
            creator_id: creatorId,
            ...(excludeCustomProductId ? { id: { not: excludeCustomProductId } } : {}),
          },
        },
        select: { slug: true },
      }),
      this.prisma.productTranslation.findMany({
        where: {
          slug: { in: slugs },
          product: { creator_id: creatorId },
        },
        select: { slug: true },
      }),
    ]);

    const taken = new Set([
      ...customConflicts.map((c) => c.slug),
      ...productConflicts.map((c) => c.slug),
    ]);
    if (taken.size > 0) {
      throw new BadRequestException(
        `Slug already in use: ${Array.from(taken).join(', ')}`,
      );
    }
  }

  /**
   * Check whether a slug is already used by another product or custom product
   * owned by this creator. Primary-locale slugs share the same URL space, so
   * a collision in either table would shadow the new product on the storefront.
   */
  async checkSlug(userId: string, slug: string, excludeId?: string) {
    const trimmed = (slug || '').trim();
    if (!trimmed) return { available: false, reason: 'empty' as const };

    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    if (!creator) throw new NotFoundException({ code: 'CUSTOM_PRODUCT_CREATOR_NOT_FOUND', message: 'Creator not found' });

    const [customConflict, productConflict] = await Promise.all([
      this.prisma.customProduct.findFirst({
        where: {
          creator_id: creator.id,
          ...(excludeId ? { id: { not: excludeId } } : {}),
          translations: { some: { slug: trimmed } },
        },
        select: { id: true },
      }),
      this.prisma.product.findFirst({
        where: {
          creator_id: creator.id,
          translations: { some: { slug: trimmed } },
        },
        select: { id: true },
      }),
    ]);

    return {
      available: !customConflict && !productConflict,
      conflictsWith: customConflict
        ? ('custom_product' as const)
        : productConflict
          ? ('product' as const)
          : null,
    };
  }

  private async assertBundlesOwnedByCreator(
    bundleIds: string[],
    creatorId: string,
  ) {
    if (bundleIds.length === 0) return;
    const found = await this.prisma.bundle.findMany({
      where: { id: { in: bundleIds } },
      select: { id: true, creator_id: true },
    });
    if (found.length !== bundleIds.length) {
      throw new BadRequestException({ code: 'CUSTOM_PRODUCT_BUNDLE_NOT_EXIST', message: 'One or more bundles do not exist' });
    }
    for (const b of found) {
      if (b.creator_id !== creatorId) {
        throw new ForbiddenException(
          { code: 'CUSTOM_PRODUCT_BUNDLE_NOT_OWNED', message: 'You can only attach your own bundles' },
        );
      }
    }
  }

  async create(userId: string, dto: CreateCustomProductDto) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
    });
    if (!creator) throw new NotFoundException({ code: 'CUSTOM_PRODUCT_CREATOR_NOT_FOUND', message: 'Creator not found' });

    // Independent stores cannot create custom products (own products only).
    await this.assertStoreAllowsCustomProducts(creator.id);

    // The base product must be a published provider product — drafts, archived
    // items, and other creators' own products cannot be imported.
    const baseProduct = await this.prisma.product.findUnique({
      where: { id: dto.product_id },
      select: { status: true, provider_id: true },
    });
    if (!baseProduct) throw new NotFoundException({ code: 'CUSTOM_PRODUCT_BASE_PRODUCT_NOT_FOUND', message: 'Product not found' });
    if (!baseProduct.provider_id || baseProduct.status !== ProductStatus.PUBLISHED) {
      throw new BadRequestException({
        code: 'CUSTOM_PRODUCT_BASE_NOT_IMPORTABLE',
        message: 'This product cannot be imported — only published provider products are available for import.',
      });
    }

    // Validate pricing consistency
    this.validatePricing(dto.pricing_type, dto);

    // Reject creating with a slug already taken by this creator's own
    // products or custom products — slug collisions shadow each other on the
    // storefront URL space.
    await this.assertSlugsAvailable(creator.id, dto.translations);

    const { translations, selected_variants, field_values, mockup_image_urls, bundle_ids, creator_category_ids, ...data } = dto;

    if (bundle_ids && bundle_ids.length > 0) {
      await this.assertBundlesOwnedByCreator(bundle_ids, creator.id);

      // Economic check only meaningful for SINGLE pricing (one fixed price).
      // PER_VARIANT/MARGIN: the customer price depends on the chosen variant,
      // so a static pre-check would be misleading — skip it.
      if (data.pricing_type === PricingType.SINGLE) {
        const baseProduct = await this.prisma.product.findUnique({
          where: { id: data.product_id },
          select: { base_price: true, provider_id: true },
        });
        if (baseProduct) {
          const unitPrice =
            Number(data.final_price) || Number(baseProduct.base_price);
          const providerBase = baseProduct.provider_id
            ? Number(baseProduct.base_price)
            : 0;
          await this.assertCustomProductCompatibleWithBundles(
            {
              id: 'pending',
              unitPrice,
              providerBasePrice: providerBase,
              title: translations?.[0]?.title,
            },
            bundle_ids,
          );
        }
      }
    }

    // Build variant rows based on import mode
    let variantRows: { variant_id: string; custom_price?: number }[] = [];

    if (dto.import_mode === ImportMode.AS_IS) {
      // Auto-load all active variants from the provider product
      const product = await this.prisma.product.findUnique({
        where: { id: dto.product_id },
        include: { variants: { where: { is_active: true } } },
      });
      if (!product) throw new NotFoundException({ code: 'CUSTOM_PRODUCT_BASE_PRODUCT_NOT_FOUND', message: 'Product not found' });

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
      if (!product) throw new NotFoundException({ code: 'CUSTOM_PRODUCT_BASE_PRODUCT_NOT_FOUND', message: 'Product not found' });

      if (product.variants.length > 0) {
        // Product has variants — require at least one selected
        if (!selected_variants || selected_variants.length === 0) {
          throw new BadRequestException(
            { code: 'CUSTOM_PRODUCT_VARIANT_REQUIRED', message: 'At least one variant must be selected in CUSTOMIZE mode' },
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

    const created = await this.prisma.customProduct.create({
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
        ...(bundle_ids &&
          bundle_ids.length > 0 && {
            bundles: {
              create: bundle_ids.map((bundle_id) => ({ bundle_id })),
            },
          }),
      },
      include: this.includes,
    });

    if (creator_category_ids?.length) {
      await this.attachCreatorCategories(
        created.id,
        creator.id,
        creator_category_ids,
      );
      return this.findById(created.id);
    }

    return created;
  }

  async findByCreator(userId: string, page = 1, limit = 20) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
    });
    if (!creator) throw new NotFoundException({ code: 'CUSTOM_PRODUCT_CREATOR_NOT_FOUND', message: 'Creator not found' });

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
    if (!cp) throw new NotFoundException({ code: 'CUSTOM_PRODUCT_NOT_FOUND', message: 'Custom product not found' });
    return cp;
  }

  async update(id: string, dto: UpdateCustomProductDto, userId?: string) {
    const existing = await this.prisma.customProduct.findUnique({
      where: { id },
      include: {
        creator: { select: { user_id: true } },
        product: { select: { provider_id: true, base_price: true } },
      },
    });
    if (!existing) throw new NotFoundException({ code: 'CUSTOM_PRODUCT_NOT_FOUND', message: 'Custom product not found' });

    // Ownership check
    if (userId && existing.creator.user_id !== userId) {
      throw new ForbiddenException({ code: 'CUSTOM_PRODUCT_NOT_OWNED', message: 'You do not own this custom product' });
    }

    // Independent stores cannot edit custom products (own products only) —
    // legacy custom products stay frozen after a store converts.
    await this.assertStoreAllowsCustomProducts(existing.creator_id);

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
      throw new ForbiddenException({ code: 'CUSTOM_PRODUCT_PUBLISH_AWAITING_REVIEW', message: 'Cannot publish a product that is awaiting provider review' });
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
      throw new ForbiddenException({ code: 'CUSTOM_PRODUCT_PUBLISH_REJECTED', message: 'Cannot publish a rejected product without resubmitting for review' });
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

    // Reject any slug already in use by another product/custom-product of
     // this creator (excluding the current custom product being updated).
    if (dto.translations && dto.translations.length > 0) {
      await this.assertSlugsAvailable(existing.creator_id, dto.translations, id);
    }

    const { translations, selected_variants, field_values, mockup_image_urls, bundle_ids, creator_category_ids, ...data } = dto;

    // Cross-check: if the price is changing and the product has SINGLE
    // pricing, re-validate every already-attached bundle even when bundle_ids
    // is not in the payload. Catches the case where a creator lowers
    // final_price below what an existing bundle's discount can sustain.
    if (
      pricingType === PricingType.SINGLE &&
      data.final_price !== undefined &&
      bundle_ids === undefined
    ) {
      const currentAttachments = await this.prisma.bundleCustomProduct.findMany({
        where: { custom_product_id: id },
        select: { bundle_id: true },
      });
      const currentBundleIds = currentAttachments.map((a) => a.bundle_id);
      if (currentBundleIds.length > 0) {
        const nextFinal = Number(data.final_price);
        const unitPrice = nextFinal || Number(existing.product.base_price);
        const providerBase = existing.product.provider_id
          ? Number(existing.product.base_price)
          : 0;
        const titleRow = await this.prisma.customProductTranslation.findFirst({
          where: { custom_product_id: id },
          select: { title: true },
        });
        await this.assertCustomProductCompatibleWithBundles(
          {
            id,
            unitPrice,
            providerBasePrice: providerBase,
            title: titleRow?.title,
          },
          currentBundleIds,
        );
      }
    }

    if (bundle_ids) {
      await this.assertBundlesOwnedByCreator(
        bundle_ids,
        existing.creator_id,
      );
      // Economic check is only meaningful for SINGLE pricing. For
      // PER_VARIANT/MARGIN the price depends on the chosen variant, so we
      // accept the attachment and let runtime order validation handle each
      // line individually.
      if (bundle_ids.length > 0 && pricingType === PricingType.SINGLE) {
        const nextFinal = Number(data.final_price ?? existing.final_price);
        const unitPrice = nextFinal || Number(existing.product.base_price);
        const providerBase = existing.product.provider_id
          ? Number(existing.product.base_price)
          : 0;
        const titleRow = await this.prisma.customProductTranslation.findFirst({
          where: { custom_product_id: id },
          select: { title: true },
        });
        await this.assertCustomProductCompatibleWithBundles(
          {
            id,
            unitPrice,
            providerBasePrice: providerBase,
            title: titleRow?.title,
          },
          bundle_ids,
        );
      }
      await this.prisma.bundleCustomProduct.deleteMany({
        where: { custom_product_id: id },
      });
    }

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
        ...(bundle_ids &&
          bundle_ids.length > 0 && {
            bundles: {
              create: bundle_ids.map((bundle_id) => ({ bundle_id })),
            },
          }),
      },
      include: this.includes,
    });

    // Replace creator collection links if provided. Empty array → detach all.
    if (creator_category_ids !== undefined) {
      await this.prisma.customProductCreatorCategory.deleteMany({
        where: { custom_product_id: id },
      });
      if (creator_category_ids.length > 0) {
        await this.attachCreatorCategories(
          id,
          existing.creator_id,
          creator_category_ids,
        );
      }
    }

    // Notify provider if product was auto-reverted to PENDING_REVIEW after edit
    if (autoRevertedToReview && existing.product.provider_id) {
      await this.notifyProviderOfSubmission(updated.id, 'CUSTOM_PRODUCT_RESUBMITTED');
    }

    return creator_category_ids !== undefined ? this.findById(id) : updated;
  }

  async delete(id: string, userId?: string) {
    if (userId) await this.assertCreatorOwns(id, userId);
    return this.prisma.customProduct.delete({ where: { id } });
  }

  /**
   * Duplicate a creator's custom product with all its relations. The clone
   * starts as DRAFT (review state cleared) and titles/slugs are suffixed to
   * stay distinct. Provider's base product reference (product_id) is kept,
   * so the clone targets the same upstream product and variants.
   */
  async duplicate(id: string, userId: string) {
    const cp = await this.assertCreatorOwns(id, userId);

    // Independent stores cannot duplicate custom products (own products only).
    await this.assertStoreAllowsCustomProducts(cp.creator_id);

    const source = await this.prisma.customProduct.findUnique({
      where: { id },
      include: {
        translations: true,
        mockup_images: true,
        selected_variants: true,
        field_values: true,
        faqs: { include: { translations: true } },
      },
    });
    if (!source) throw new NotFoundException({ code: 'CUSTOM_PRODUCT_NOT_FOUND', message: 'Custom product not found' });

    const created = await this.prisma.$transaction(async (tx) => {
      const newCp = await tx.customProduct.create({
        data: {
          product_id: source.product_id,
          creator_id: source.creator_id,
          import_mode: source.import_mode,
          pricing_type: source.pricing_type,
          final_price: source.final_price,
          margin_amount: source.margin_amount,
          // Always reset review state for the duplicate.
          status: ProductStatus.DRAFT,
          rejection_reason: null,
          submitted_at: null,
          reviewed_at: null,
          reviewed_by: null,
        },
      });

      if (source.translations.length > 0) {
        await tx.customProductTranslation.createMany({
          data: source.translations.map((t) => ({
            custom_product_id: newCp.id,
            locale: t.locale,
            title: `${t.title} (Copy)`,
            description: t.description,
            slug: `${t.slug}-copy-${newCp.id.slice(0, 6)}`,
          })),
        });
      }

      if (source.mockup_images.length > 0) {
        await tx.customProductImage.createMany({
          data: source.mockup_images.map((img) => ({
            custom_product_id: newCp.id,
            url: img.url,
            sort_order: img.sort_order,
          })),
        });
      }

      // Selected variants reference the upstream ProductVariant, which the
      // clone keeps targeting — same product_id means same variant pool.
      if (source.selected_variants.length > 0) {
        await tx.customProductVariant.createMany({
          data: source.selected_variants.map((sv) => ({
            custom_product_id: newCp.id,
            variant_id: sv.variant_id,
            custom_price: sv.custom_price,
          })),
        });
      }

      // Custom field values — same custom_field_id (lives on the base product).
      if (source.field_values.length > 0) {
        await tx.customProductFieldValue.createMany({
          data: source.field_values.map((fv) => ({
            custom_product_id: newCp.id,
            custom_field_id: fv.custom_field_id,
            value: fv.value,
            file_url: fv.file_url,
          })),
        });
      }

      // FAQs with their translations.
      for (const f of source.faqs) {
        await tx.customProductFaq.create({
          data: {
            custom_product_id: newCp.id,
            sort_order: f.sort_order,
            translations: {
              create: f.translations.map((t) => ({
                locale: t.locale,
                question: t.question,
                answer: t.answer,
              })),
            },
          },
        });
      }

      return newCp;
    });

    return this.findById(created.id);
  }

  // ── Approval workflow ────────────────────────────────────

  /** Creator submits a custom product for provider review (or auto-publishes if no provider). */
  async submitForReview(id: string, userId: string) {
    const cp = await this.assertCreatorOwns(id, userId);

    // Independent stores cannot publish custom products (own products only).
    await this.assertStoreAllowsCustomProducts(cp.creator_id);

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
      throw new BadRequestException({ code: 'CUSTOM_PRODUCT_REJECTION_REASON_REQUIRED', message: 'Rejection reason is required' });
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
    if (!provider) throw new NotFoundException({ code: 'CUSTOM_PRODUCT_PROVIDER_NOT_FOUND', message: 'Provider not found' });

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
    if (!faq) throw new NotFoundException({ code: 'CUSTOM_PRODUCT_FAQ_NOT_FOUND', message: 'FAQ not found' });

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
            { code: 'CUSTOM_PRODUCT_FINAL_PRICE_REQUIRED', message: 'final_price is required when pricing_type is SINGLE' },
          );
        }
        break;
      case PricingType.MARGIN:
        if (data.margin_amount === undefined || data.margin_amount === null) {
          throw new BadRequestException(
            { code: 'CUSTOM_PRODUCT_MARGIN_AMOUNT_REQUIRED', message: 'margin_amount is required when pricing_type is MARGIN' },
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
              { code: 'CUSTOM_PRODUCT_VARIANT_PRICE_REQUIRED', message: 'custom_price is required for each variant when pricing_type is PER_VARIANT' },
            );
          }
        }
        break;
    }
  }
}
