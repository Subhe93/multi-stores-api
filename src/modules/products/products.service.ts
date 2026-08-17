import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import {
  CreateProductDto,
  UpdateProductDto,
  ProductVariantSyncDto,
  ProductImageSyncDto,
} from './dto/product.dto';
import { UserRole, ProductStatus } from '@prisma/client';
import { BundlesService } from '../bundles/bundles.service';
import {
  validateBundleEconomics,
  formatViolationsMessage,
  type ProductForBundleCheck,
} from '../bundles/bundle-economics.util';
import { BundleOfferLike } from '../bundles/bundle-pricing.util';

@Injectable()
export class ProductsService {
  constructor(
    private prisma: PrismaService,
    private bundlesService: BundlesService,
    private readonly revalidation: RevalidationService,
  ) {}

  // Refresh the creator's storefront cache after a product mutation. Provider
  // products can appear across many stores, so those rely on the time-based
  // revalidate fallback instead.
  private async revalidateForCreator(creatorId?: string | null): Promise<void> {
    if (creatorId) {
      await this.revalidation.revalidateStoreByCreatorId(creatorId);
    }
  }

  /**
   * For each bundle the product is being attached to, verify the product's
   * pricing keeps every offer above provider cost. Throws BadRequestException
   * with a per-product breakdown if any combination would sell at a loss.
   */
  private async assertProductCompatibleWithBundles(
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

  private readonly productIncludes = {
    translations: true,
    images: { orderBy: { sort_order: 'asc' as const } },
    attributes: {
      include: { template: { include: { translations: true } } },
    },
    variants: true,
    tags: true,
    custom_fields: { include: { translations: true }, orderBy: { sort_order: 'asc' as const } },
    faqs: { include: { translations: true }, orderBy: { sort_order: 'asc' as const } },
    category: { include: { translations: true } },
    shipping_profile: { include: { zones: true } },
    creator_categories: {
      include: {
        creator_category: { include: { translations: true } },
      },
    },
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
  };

  /**
   * Attach a creator's product to one or more of their own collections.
   * Silently skips any collection id that doesn't belong to this creator
   * (defense-in-depth — DTO can't enforce ownership).
   */
  private async attachCreatorCategories(
    productId: string,
    creatorId: string,
    categoryIds: string[],
  ) {
    const owned = await this.prisma.creatorCategory.findMany({
      where: { id: { in: categoryIds }, creator_id: creatorId },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((c) => c.id));
    const toAttach = categoryIds.filter((id) => ownedIds.has(id));
    if (!toAttach.length) return;
    await this.prisma.productCreatorCategory.createMany({
      data: toAttach.map((creator_category_id) => ({
        product_id: productId,
        creator_category_id,
      })),
      skipDuplicates: true,
    });
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
      throw new NotFoundException({ code: 'PRODUCT_BUNDLES_NOT_FOUND', message: 'One or more bundles do not exist' });
    }
    for (const b of found) {
      if (b.creator_id !== creatorId) {
        throw new ForbiddenException({ code: 'PRODUCT_BUNDLES_NOT_OWNED', message: 'You can only attach your own bundles' });
      }
    }
  }

  /**
   * Sync variants and images from the product save payload in one transaction.
   *
   * Variants are diffed by id: existing ones are updated in place (keeping
   * their ids stable — order items, carts, and custom-product selections
   * reference them, and CustomProductVariant rows cascade-delete when a
   * variant is removed), new ones are created, and missing ones are deleted.
   *
   * Image rows are rebuilt: product-level rows from `images` (sort_order =
   * array index), variant rows from each variant's `image_url`.
   */
  private async syncVariantsAndImages(
    productId: string,
    variants?: ProductVariantSyncDto[],
    images?: ProductImageSyncDto[],
  ) {
    if (variants === undefined && images === undefined) return;

    await this.prisma.$transaction(async (tx) => {
      // Final DB id per variant payload entry — needed to link variant images.
      const variantIds: string[] = [];

      if (variants !== undefined) {
        // Drop variant-linked image rows first: deleting a variant would only
        // null out variant_id (SetNull), leaving orphan rows behind.
        await tx.productImage.deleteMany({
          where: { product_id: productId, variant_id: { not: null } },
        });

        const existing = await tx.productVariant.findMany({
          where: { product_id: productId },
          select: { id: true },
        });
        const existingIds = new Set(existing.map((v) => v.id));
        const keepIds = variants
          .map((v) => v.id)
          .filter((vid): vid is string => !!vid && existingIds.has(vid));

        await tx.productVariant.deleteMany({
          where: { product_id: productId, id: { notIn: keepIds } },
        });

        for (const v of variants) {
          const data = {
            sku: v.sku || null,
            price_adjustment: v.price_adjustment ?? 0,
            compare_at_price: v.compare_at_price ?? null,
            stock_quantity: v.stock_quantity ?? null,
            is_active: v.is_active ?? true,
            options: v.options,
          };
          if (v.id && existingIds.has(v.id)) {
            await tx.productVariant.update({ where: { id: v.id }, data });
            variantIds.push(v.id);
          } else {
            const created = await tx.productVariant.create({
              data: { ...data, product_id: productId },
            });
            variantIds.push(created.id);
          }
        }
      }

      if (images !== undefined) {
        await tx.productImage.deleteMany({
          where: { product_id: productId, variant_id: null },
        });
        if (images.length > 0) {
          await tx.productImage.createMany({
            data: images.map((img, i) => ({
              product_id: productId,
              url: img.url,
              alt_text: img.alt_text ?? null,
              sort_order: i,
              is_featured: img.is_featured ?? false,
            })),
          });
        }
      }

      if (variants !== undefined) {
        const variantImageRows = variants.flatMap((v, i) =>
          v.image_url
            ? [{
                product_id: productId,
                variant_id: variantIds[i]!,
                url: v.image_url,
                sort_order: 1000 + i,
                is_featured: false,
              }]
            : [],
        );
        if (variantImageRows.length > 0) {
          await tx.productImage.createMany({ data: variantImageRows });
        }
      }
    });
  }

  async create(userId: string, userRole: UserRole, dto: CreateProductDto) {
    const { translations, attributes, tags, bundle_ids, creator_category_ids, variants, images, ...data } = dto;

    const productData: any = {
      ...data,
      translations: { create: translations },
    };

    // ربط المنتج بالـ Provider أو Creator
    if (userRole === UserRole.PROVIDER) {
      const provider = await this.prisma.provider.findUnique({
        where: { user_id: userId },
      });
      if (!provider) throw new NotFoundException({ code: 'PRODUCT_PROVIDER_PROFILE_NOT_FOUND', message: 'Provider profile not found' });
      productData.provider_id = provider.id;
    } else if (userRole === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
      });
      if (!creator) throw new NotFoundException({ code: 'PRODUCT_CREATOR_PROFILE_NOT_FOUND', message: 'Creator profile not found' });
      productData.creator_id = creator.id;
    }

    // إنشاء المنتج
    const product = await this.prisma.product.create({
      data: productData,
      include: this.productIncludes,
    });

    // إضافة الـ attributes
    if (attributes?.length) {
      await this.prisma.productAttribute.createMany({
        data: attributes.map((attr) => ({
          product_id: product.id,
          template_id: attr.template_id,
          value: attr.value,
        })),
      });
    }

    // إضافة الـ tags
    if (tags?.length) {
      await this.prisma.productTag.createMany({
        data: tags.map((tag) => ({
          product_id: product.id,
          tag,
        })),
      });
    }

    // Attach creator collections (creator-only — collections are creator-scoped)
    if (
      creator_category_ids?.length &&
      userRole === UserRole.CREATOR &&
      productData.creator_id
    ) {
      await this.attachCreatorCategories(
        product.id,
        productData.creator_id,
        creator_category_ids,
      );
    }

    // Attach bundles (creator-only — bundles are creator-scoped)
    if (
      bundle_ids?.length &&
      userRole === UserRole.CREATOR &&
      productData.creator_id
    ) {
      await this.assertBundlesOwnedByCreator(bundle_ids, productData.creator_id);
      const base = Number(product.base_price);
      await this.assertProductCompatibleWithBundles(
        {
          id: product.id,
          unitPrice: base,
          providerBasePrice: product.provider_id ? base : 0,
          title: product.translations?.[0]?.title,
        },
        bundle_ids,
      );
      await this.prisma.bundleProduct.createMany({
        data: bundle_ids.map((bundle_id) => ({
          bundle_id,
          product_id: product.id,
        })),
      });
    }

    await this.syncVariantsAndImages(product.id, variants, images);

    await this.revalidateForCreator(productData.creator_id);

    return this.findById(product.id);
  }

  async findAll(filters: {
    page?: number;
    limit?: number;
    category_id?: string;
    product_type?: string;
    status?: ProductStatus;
    provider_id?: string;
    creator_id?: string;
    owner_type?: 'provider' | 'creator';
    search?: string;
    is_featured?: boolean;
  }) {
    const { page = 1, limit = 20, ...rest } = filters;
    const skip = (page - 1) * limit;
    const where: any = {};

    if (rest.category_id) where.category_id = rest.category_id;
    if (rest.product_type) where.product_type = rest.product_type;
    if (rest.status) where.status = rest.status;
    if (rest.provider_id) where.provider_id = rest.provider_id;
    if (rest.creator_id) where.creator_id = rest.creator_id;
    if (rest.owner_type === 'provider') where.provider_id = { not: null };
    if (rest.owner_type === 'creator') where.creator_id = { not: null };
    if (rest.is_featured !== undefined) where.is_featured = rest.is_featured;
    if (rest.search) {
      where.translations = {
        some: {
          title: { contains: rest.search, mode: 'insensitive' },
        },
      };
    }

    const [data, total] = await Promise.all([
      this.prisma.product.findMany({
        skip,
        take: limit,
        where,
        include: {
          translations: true,
          images: { take: 1, orderBy: { sort_order: 'asc' } },
          category: { include: { translations: true } },
          variants: true,
          provider: { select: { id: true, company_name: true } },
        },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // Dashboard listing — only the authenticated provider's/creator's own products.
  async findMine(
    userId: string,
    userRole: UserRole,
    filters: {
      page?: number;
      limit?: number;
      category_id?: string;
      product_type?: string;
      status?: ProductStatus;
      search?: string;
      is_featured?: boolean;
    },
  ) {
    if (userRole === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
      });
      if (!creator) throw new NotFoundException({ code: 'PRODUCT_CREATOR_PROFILE_NOT_FOUND', message: 'Creator profile not found' });

      return this.findAll({ ...filters, creator_id: creator.id });
    }

    const provider = await this.prisma.provider.findUnique({
      where: { user_id: userId },
    });
    if (!provider) throw new NotFoundException({ code: 'PRODUCT_PROVIDER_PROFILE_NOT_FOUND', message: 'Provider profile not found' });

    return this.findAll({ ...filters, provider_id: provider.id });
  }

  async findById(id: string, userId?: string, userRole?: UserRole) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: this.productIncludes,
    });

    if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });

    // cost_price is the provider's confidential margin input — a creator
    // browsing the catalogue to import must never see it.
    if (userRole !== UserRole.ADMIN) {
      const owns = userId
        ? await this.userOwnsProduct(product, userId, userRole)
        : false;
      if (!owns) {
        const { cost_price: _cost, ...rest } = product;
        void _cost;
        return rest;
      }
    }
    return product;
  }

  private async userOwnsProduct(
    product: { provider_id: string | null; creator_id: string | null },
    userId: string,
    userRole?: UserRole,
  ): Promise<boolean> {
    if (userRole === UserRole.PROVIDER) {
      const provider = await this.prisma.provider.findUnique({
        where: { user_id: userId },
        select: { id: true },
      });
      return !!provider && product.provider_id === provider.id;
    }
    if (userRole === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
        select: { id: true },
      });
      return !!creator && product.creator_id === creator.id;
    }
    return false;
  }

  async update(
    id: string,
    userId: string,
    userRole: UserRole,
    dto: UpdateProductDto,
  ) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });

    // التحقق من الملكية
    await this.checkOwnership(product, userId, userRole);

    const { translations, attributes, tags, bundle_ids, creator_category_ids, variants, images, ...data } = dto;

    // تحديث المنتج
    await this.prisma.product.update({
      where: { id },
      data,
    });

    await this.syncVariantsAndImages(id, variants, images);

    // Replace creator-collection attachments (creator-owned products only)
    if (
      creator_category_ids !== undefined &&
      userRole === UserRole.CREATOR &&
      product.creator_id
    ) {
      await this.prisma.productCreatorCategory.deleteMany({
        where: { product_id: id },
      });
      if (creator_category_ids.length > 0) {
        await this.attachCreatorCategories(
          id,
          product.creator_id,
          creator_category_ids,
        );
      }
    }

    // Replace bundle attachments — only for creator-owned products.
    if (bundle_ids && userRole === UserRole.CREATOR && product.creator_id) {
      await this.assertBundlesOwnedByCreator(bundle_ids, product.creator_id);
      if (bundle_ids.length > 0) {
        // base_price may have changed in `data` above; use the new value.
        const nextBase = Number(data.base_price ?? product.base_price);
        const titleRow = await this.prisma.productTranslation.findFirst({
          where: { product_id: id },
          select: { title: true },
        });
        await this.assertProductCompatibleWithBundles(
          {
            id,
            unitPrice: nextBase,
            providerBasePrice: product.provider_id ? nextBase : 0,
            title: titleRow?.title,
          },
          bundle_ids,
        );
      }
      await this.prisma.bundleProduct.deleteMany({
        where: { product_id: id },
      });
      if (bundle_ids.length > 0) {
        await this.prisma.bundleProduct.createMany({
          data: bundle_ids.map((bundle_id) => ({
            bundle_id,
            product_id: id,
          })),
        });
      }
    }

    // تحديث الترجمات
    if (translations) {
      await this.prisma.productTranslation.deleteMany({
        where: { product_id: id },
      });
      await this.prisma.productTranslation.createMany({
        data: translations.map((t) => ({ ...t, product_id: id })),
      });
    }

    // تحديث الـ attributes
    if (attributes) {
      await this.prisma.productAttribute.deleteMany({
        where: { product_id: id },
      });
      await this.prisma.productAttribute.createMany({
        data: attributes.map((attr) => ({
          product_id: id,
          template_id: attr.template_id,
          value: attr.value,
        })),
      });
    }

    // تحديث الـ tags
    if (tags) {
      await this.prisma.productTag.deleteMany({
        where: { product_id: id },
      });
      await this.prisma.productTag.createMany({
        data: tags.map((tag) => ({ product_id: id, tag })),
      });
    }

    await this.revalidateForCreator(product.creator_id);

    return this.findById(id);
  }

  async delete(id: string, userId: string, userRole: UserRole) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });

    await this.checkOwnership(product, userId, userRole);

    const deleted = await this.prisma.product.delete({ where: { id } });

    await this.revalidateForCreator(product.creator_id);

    return deleted;
  }

  /**
   * Duplicate a product with all its relations. The clone is always created
   * as DRAFT, never featured, and titles/slugs are suffixed with "(Copy)" to
   * stay distinct from the source. Unique fields like SKU are cleared or
   * suffixed to avoid conflicts. Variant→image links are remapped so a
   * cloned image points at its cloned variant.
   */
  async duplicate(id: string, userId: string, userRole: UserRole) {
    const source = await this.prisma.product.findUnique({
      where: { id },
      include: {
        translations: true,
        images: true,
        attributes: true,
        variants: true,
        tags: true,
        custom_fields: { include: { translations: true } },
        faqs: { include: { translations: true } },
      },
    });
    if (!source) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });

    await this.checkOwnership(source, userId, userRole);

    const newProduct = await this.prisma.$transaction(async (tx) => {
      // Create the bare product first so we have an id for child rows.
      const created = await tx.product.create({
        data: {
          provider_id: source.provider_id,
          creator_id: source.creator_id,
          category_id: source.category_id,
          product_type: source.product_type,
          customization_type: source.customization_type,
          base_price: source.base_price,
          compare_at_price: source.compare_at_price,
          cost_price: source.cost_price,
          // Clear unique SKU; provider can set a new one in the duplicate.
          sku: null,
          track_inventory: source.track_inventory,
          stock_quantity: source.stock_quantity,
          weight: source.weight,
          weight_unit: source.weight_unit,
          variant_option_config: source.variant_option_config ?? undefined,
          shipping_profile_id: source.shipping_profile_id,
          // Force safe defaults for the clone.
          status: ProductStatus.DRAFT,
          is_featured: false,
        },
      });

      // Translations — suffix title and slug to stay distinct.
      if (source.translations.length > 0) {
        await tx.productTranslation.createMany({
          data: source.translations.map((t) => ({
            product_id: created.id,
            locale: t.locale,
            title: `${t.title} (Copy)`,
            description: t.description,
            slug: `${t.slug}-copy-${created.id.slice(0, 6)}`,
            meta_title: t.meta_title,
            meta_desc: t.meta_desc,
          })),
        });
      }

      // Tags — flat copy.
      if (source.tags.length > 0) {
        await tx.productTag.createMany({
          data: source.tags.map((t) => ({ product_id: created.id, tag: t.tag })),
        });
      }

      // Attributes — flat copy.
      if (source.attributes.length > 0) {
        await tx.productAttribute.createMany({
          data: source.attributes.map((a) => ({
            product_id: created.id,
            template_id: a.template_id,
            value: a.value as any,
          })),
        });
      }

      // Variants — keep options/price; clear unique SKU. Map old→new id so
      // we can rewire variant-linked images below.
      const variantIdMap: Record<string, string> = {};
      for (const v of source.variants) {
        const newVariant = await tx.productVariant.create({
          data: {
            product_id: created.id,
            sku: null,
            price_adjustment: v.price_adjustment,
            compare_at_price: v.compare_at_price,
            stock_quantity: v.stock_quantity,
            is_active: v.is_active,
            options: v.options as any,
          },
        });
        variantIdMap[v.id] = newVariant.id;
      }

      // Images — remap variant_id via the map (null stays null).
      if (source.images.length > 0) {
        await tx.productImage.createMany({
          data: source.images.map((img) => ({
            product_id: created.id,
            variant_id: img.variant_id ? variantIdMap[img.variant_id] ?? null : null,
            url: img.url,
            alt_text: img.alt_text,
            sort_order: img.sort_order,
            is_featured: img.is_featured,
          })),
        });
      }

      // Custom fields with their translations.
      for (const cf of source.custom_fields) {
        await tx.productCustomField.create({
          data: {
            product_id: created.id,
            name: cf.name,
            type: cf.type,
            is_required: cf.is_required,
            placeholder: cf.placeholder,
            options: cf.options as any,
            validation_rules: cf.validation_rules as any,
            linked_validation: cf.linked_validation as any,
            sort_order: cf.sort_order,
            translations: {
              create: cf.translations.map((t) => ({
                locale: t.locale,
                label: t.label,
                placeholder: t.placeholder,
                option_labels: t.option_labels as any,
              })),
            },
          },
        });
      }

      // FAQs with their translations.
      for (const f of source.faqs) {
        await tx.productFaq.create({
          data: {
            product_id: created.id,
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

      return created;
    });

    return this.findById(newProduct.id);
  }

  async updateStatus(
    id: string,
    status: ProductStatus,
    userId: string,
    userRole: UserRole,
  ) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });

    await this.checkOwnership(product, userId, userRole);

    return this.prisma.product.update({
      where: { id },
      data: { status },
    });
  }

  // Image management
  async addImage(
    productId: string,
    userId: string,
    userRole: UserRole,
    url: string,
    altText?: string,
    sortOrder?: number,
    isFeatured?: boolean,
    variantId?: string,
  ) {
    await this.assertOwnsProductById(productId, userId, userRole);
    // If setting as featured, unset others
    if (isFeatured) {
      await this.prisma.productImage.updateMany({
        where: { product_id: productId },
        data: { is_featured: false },
      });
    }
    return this.prisma.productImage.create({
      data: { product_id: productId, url, alt_text: altText, sort_order: sortOrder ?? 0, is_featured: isFeatured ?? false, variant_id: variantId },
    });
  }

  async getImages(productId: string) {
    return this.prisma.productImage.findMany({
      where: { product_id: productId },
      orderBy: { sort_order: 'asc' },
    });
  }

  async deleteImage(imageId: string, userId: string, userRole: UserRole) {
    const image = await this.prisma.productImage.findUnique({
      where: { id: imageId },
      select: { product_id: true },
    });
    if (!image) throw new NotFoundException({ code: 'PRODUCT_IMAGE_NOT_FOUND', message: 'Image not found' });
    await this.assertOwnsProductById(image.product_id, userId, userRole);
    return this.prisma.productImage.delete({ where: { id: imageId } });
  }

  async reorderImages(
    productId: string,
    imageIds: string[],
    userId: string,
    userRole: UserRole,
  ) {
    await this.assertOwnsProductById(productId, userId, userRole);
    // Ignore ids that don't belong to this product, so a foreign image can't be
    // pulled into someone else's ordering.
    const owned = await this.prisma.productImage.findMany({
      where: { product_id: productId, id: { in: imageIds } },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((img) => img.id));

    await Promise.all(
      imageIds
        .filter((id) => ownedIds.has(id))
        .map((id, i) =>
          this.prisma.productImage.update({ where: { id }, data: { sort_order: i } }),
        ),
    );
    return this.getImages(productId);
  }

  /**
   * Load a product by id and run the same ownership check the update/delete
   * paths use. Image endpoints previously took a bare id and skipped it, so any
   * seller could add, replace or strip a competitor's product imagery.
   */
  private async assertOwnsProductById(
    productId: string,
    userId: string,
    userRole: UserRole,
  ) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { provider_id: true, creator_id: true },
    });
    if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
    await this.checkOwnership(product, userId, userRole);
  }

  async getImportDetails(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        translations: true,
        images: { orderBy: { sort_order: 'asc' } },
        attributes: {
          include: { template: { include: { translations: true } } },
        },
        variants: { where: { is_active: true }, include: { images: true } },
        tags: true,
        custom_fields: {
          include: { translations: true },
          orderBy: { sort_order: 'asc' },
        },
        faqs: {
          include: { translations: true },
          orderBy: { sort_order: 'asc' },
        },
        category: { include: { translations: true } },
        provider: { select: { id: true, company_name: true } },
        shipping_profile: { include: { zones: true } },
      },
    });

    if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });

    // Only published provider products can be imported into a creator store —
    // drafts, archived items, and creator-own products are not importable.
    if (!product.provider_id || product.status !== ProductStatus.PUBLISHED) {
      throw new BadRequestException({
        code: 'PRODUCT_NOT_IMPORTABLE',
        message: 'This product cannot be imported — only published provider products are available for import.',
      });
    }

    // Fallback to provider's default shipping profile if none assigned
    if (!(product as any).shipping_profile && product.provider_id) {
      const defaultProfile = await this.prisma.shippingProfile.findFirst({
        where: { provider_id: product.provider_id, is_default: true },
        include: { zones: true },
      });
      if (defaultProfile) {
        return { ...product, shipping_profile: defaultProfile };
      }
    }

    return product;
  }

  private async checkOwnership(
    product: any,
    userId: string,
    userRole: UserRole,
  ) {
    if (userRole === UserRole.ADMIN) return;

    if (userRole === UserRole.PROVIDER) {
      const provider = await this.prisma.provider.findUnique({
        where: { user_id: userId },
      });
      if (product.provider_id !== provider?.id) {
        throw new ForbiddenException({ code: 'PRODUCT_FORBIDDEN', message: 'Not your product' });
      }
    }

    if (userRole === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
      });
      if (product.creator_id !== creator?.id) {
        throw new ForbiddenException({ code: 'PRODUCT_FORBIDDEN', message: 'Not your product' });
      }
    }
  }
}
