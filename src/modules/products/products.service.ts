import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import {
  CreateProductDto,
  UpdateProductDto,
  ProductVariantSyncDto,
  ProductImageSyncDto,
  ProductTranslationDto,
} from './dto/product.dto';
import { UserRole, ProductStatus, ProductType, Prisma } from '@prisma/client';
import { BundlesService } from '../bundles/bundles.service';
import {
  validateBundleEconomics,
  formatViolationsMessage,
  type ProductForBundleCheck,
} from '../bundles/bundle-economics.util';
import { BundleOfferLike } from '../bundles/bundle-pricing.util';
import { TaxManagementService } from '../taxes/tax-management.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { validateOptionConfig } from '../personalization/personalization-config.validator';
import {
  appRequired,
  configInvalid,
  creatorProductOnly,
  optionInUse,
} from '../personalization/personalization.errors';
import {
  brokenOptionReferences,
  introducesCardConfig,
} from '../personalization/personalization-option-refs';
import { isPlainObject } from '@multi-stores/core/personalization/rules';
import { isValidGtin } from '../feeds/gtin';
import { sanitizeCreatorHtml } from '../../common/html/creator-html';

/**
 * `description` / `short_description` are rendered on the storefront as
 * HTML, so they are sanitized on every write (the importer has its own
 * sanitizer). `description` is NOT NULL in the schema: empty becomes ''.
 */
function sanitizeTranslationHtml<
  T extends { description: string; short_description?: string | null },
>(t: T): T {
  return {
    ...t,
    description: sanitizeCreatorHtml(t.description) ?? '',
    ...(t.short_description !== undefined && {
      short_description: sanitizeCreatorHtml(t.short_description),
    }),
  };
}

/**
 * Public projection of `GET /products` (anonymous callers and non-owners):
 * no cost price, no importer identities, published provider catalogue only.
 */
export const PUBLIC_PRODUCT_LIST_SELECT = {
  id: true,
  provider_id: true,
  category_id: true,
  product_type: true,
  customization_type: true,
  base_price: true,
  compare_at_price: true,
  track_inventory: true,
  stock_quantity: true,
  status: true,
  is_featured: true,
  created_at: true,
  updated_at: true,
  translations: true,
  images: { take: 1, orderBy: { sort_order: 'asc' as const } },
  category: { include: { translations: true } },
  variants: {
    select: {
      id: true,
      product_id: true,
      sku: true,
      price_adjustment: true,
      compare_at_price: true,
      stock_quantity: true,
      is_active: true,
      options: true,
    },
  },
  provider: { select: { id: true, company_name: true } },
} satisfies Prisma.ProductSelect;

export interface ProductListViewer {
  userId?: string;
  role?: UserRole;
}

export type ProductListFilters = {
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
};

/**
 * Product as served to a non-owner: drops the cost price, the importer
 * identities (product + variants) and the internals of linked collections.
 */
export function redactProductForNonOwner<
  T extends {
    cost_price?: unknown;
    external_ref?: unknown;
    variants?: { external_ref?: unknown }[];
    creator_categories?: {
      creator_category?: {
        external_ref?: unknown;
        creator_id?: unknown;
        match_rule?: unknown;
        match_tags?: unknown;
      } | null;
    }[];
  },
>(product: T): Omit<T, 'cost_price' | 'external_ref'> {
  const { cost_price: _cost, external_ref: _ref, ...rest } = product;
  void _cost;
  void _ref;
  const out: Record<string, unknown> = { ...rest };
  if (Array.isArray(product.variants)) {
    out.variants = product.variants.map((v) => {
      const { external_ref: _vref, ...vr } = v;
      void _vref;
      return vr;
    });
  }
  if (Array.isArray(product.creator_categories)) {
    out.creator_categories = product.creator_categories.map((link) => {
      const cc = link.creator_category;
      if (!cc) return link;
      const {
        external_ref: _cref,
        creator_id: _owner,
        match_rule: _rule,
        match_tags: _tags,
        ...pub
      } = cc;
      void _cref;
      void _owner;
      void _rule;
      void _tags;
      return { ...link, creator_category: pub };
    });
  }
  return out as Omit<T, 'cost_price' | 'external_ref'>;
}

/** Feed data keys of the product DTOs (M5.6 feeds app). */
const FEED_TEXT_FIELDS = [
  'gtin',
  'mpn',
  'brand',
  'google_product_category',
  'condition',
] as const;

/**
 * Trims the feed text fields in place; '' becomes null (clears), an absent
 * key stays absent (update keeps the stored value). Throws
 * PRODUCT_GTIN_INVALID for a GTIN without a valid check digit, so a feed
 * never carries an identifier Google would reject.
 */
export function normalizeFeedFields(
  data: Partial<Record<(typeof FEED_TEXT_FIELDS)[number], string | null>>,
): void {
  for (const key of FEED_TEXT_FIELDS) {
    if (!(key in data)) continue;
    const raw = data[key];
    const value = typeof raw === 'string' ? raw.trim() : null;
    data[key] = value ? value : null;
  }
  if (data.gtin && !isValidGtin(data.gtin)) {
    throw new BadRequestException({
      code: 'PRODUCT_GTIN_INVALID',
      message:
        'GTIN must be 8, 12, 13 or 14 digits with a valid check digit (EAN/UPC/ISBN barcode number).',
    });
  }
  if (data.condition === 'new') data.condition = null;
}

@Injectable()
export class ProductsService {
  constructor(
    private prisma: PrismaService,
    private bundlesService: BundlesService,
    private readonly revalidation: RevalidationService,
    private readonly taxes: TaxManagementService,
    // Global module; optional so positional tests stay short (the
    // personalization app then counts as disabled).
    @Optional() private readonly storeApps?: StoreAppsService,
  ) {}

  /**
   * Personalization app checks of a `variant_option_config` write (M4.1):
   * - the app's keys are well formed (400 PERSONALIZATION_CONFIG_INVALID,
   *   paths `variant_option_config[i].valueMeta.<value>.<key>`);
   * - new or changed variation-card keys (`style:'card'`, `valueMeta`)
   *   need the app on a creator product; stored values that come back
   *   unchanged are accepted (same gate rule as custom fields);
   * - an option (or option value) still read by the product's
   *   personalization fields cannot be renamed or removed (409
   *   PERSONALIZATION_OPTION_IN_USE {fields, options}).
   */
  private async assertOptionConfigWrite(
    product: { id: string; creator_id: string | null } | null,
    creatorId: string | null | undefined,
    oldConfig: unknown,
    newConfig: unknown,
  ): Promise<void> {
    const issues = validateOptionConfig(newConfig);
    if (issues.length > 0) throw configInvalid(issues);
    if (introducesCardConfig(oldConfig, newConfig)) {
      if (!creatorId) throw creatorProductOnly();
      const store = await this.prisma.store.findUnique({
        where: { creator_id: creatorId },
        select: { id: true },
      });
      const on =
        !!store &&
        !!this.storeApps &&
        (await this.storeApps.isEnabled(store.id, 'personalization'));
      if (!on) throw appRequired();
    }
    if (!product || !Array.isArray(oldConfig)) return;
    const fields = await this.prisma.productCustomField.findMany({
      where: { product_id: product.id },
      select: {
        id: true,
        name: true,
        parent_id: true,
        type: true,
        conditions: true,
        pricing: true,
        repeat: true,
        ui: true,
      },
    });
    const broken = brokenOptionReferences(fields, oldConfig, newConfig);
    if (broken.fields.length > 0) {
      throw optionInUse(broken.fields, broken.options);
    }
  }

  /**
   * A product may only use a platform tax class or a class of the store
   * that owns it (creator products); provider products get platform classes.
   */
  private async assertTaxClassAllowed(
    taxClassId: string | null | undefined,
    creatorId: string | null | undefined,
  ): Promise<void> {
    if (!taxClassId) return;
    const store = creatorId
      ? await this.prisma.store.findUnique({
          where: { creator_id: creatorId },
          select: { id: true },
        })
      : null;
    await this.taxes.assertClassAssignable(taxClassId, store?.id ?? null);
  }

  /**
   * A product may only use a shipping profile of its own owner: the provider
   * for provider products, the creator for creator products. A product with
   * no owner (admin-created) only needs the profile to exist. null/undefined
   * is left alone (clears / keeps the current profile).
   */
  private async assertShippingProfileAllowed(
    profileId: string | null | undefined,
    owner: { provider_id?: string | null; creator_id?: string | null },
  ): Promise<void> {
    if (!profileId) return;
    const profile = await this.prisma.shippingProfile.findUnique({
      where: { id: profileId },
      select: { provider_id: true, creator_id: true },
    });
    const allowed =
      !!profile &&
      (owner.provider_id
        ? profile.provider_id === owner.provider_id
        : owner.creator_id
          ? profile.creator_id === owner.creator_id
          : true);
    if (!allowed)
      throw new BadRequestException({
        code: 'SHIPPING_PROFILE_INVALID',
        message: 'The selected shipping profile does not belong to you.',
      });
  }

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
    const allViolations = [] as ReturnType<
      typeof validateBundleEconomics
    >['violations'];
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
    custom_fields: {
      include: { translations: true },
      orderBy: [{ sort_order: 'asc' as const }, { id: 'asc' as const }],
    },
    faqs: {
      include: { translations: true },
      orderBy: { sort_order: 'asc' as const },
    },
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
      throw new NotFoundException({
        code: 'PRODUCT_BUNDLES_NOT_FOUND',
        message: 'One or more bundles do not exist',
      });
    }
    for (const b of found) {
      if (b.creator_id !== creatorId) {
        throw new ForbiddenException({
          code: 'PRODUCT_BUNDLES_NOT_OWNED',
          message: 'You can only attach your own bundles',
        });
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
            ? [
                {
                  product_id: productId,
                  variant_id: variantIds[i],
                  url: v.image_url,
                  sort_order: 1000 + i,
                  is_featured: false,
                },
              ]
            : [],
        );
        if (variantImageRows.length > 0) {
          await tx.productImage.createMany({ data: variantImageRows });
        }
      }
    });
  }

  async create(userId: string, userRole: UserRole, dto: CreateProductDto) {
    const {
      translations,
      attributes,
      tags,
      bundle_ids,
      creator_category_ids,
      variants,
      images,
      ...data
    } = dto;

    const productData: Prisma.ProductUncheckedCreateInput = {
      ...data,
      translations: { create: translations.map(sanitizeTranslationHtml) },
    };

    // ربط المنتج بالـ Provider أو Creator
    if (userRole === UserRole.PROVIDER) {
      const provider = await this.prisma.provider.findUnique({
        where: { user_id: userId },
      });
      if (!provider)
        throw new NotFoundException({
          code: 'PRODUCT_PROVIDER_PROFILE_NOT_FOUND',
          message: 'Provider profile not found',
        });
      productData.provider_id = provider.id;
    } else if (userRole === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
      });
      if (!creator)
        throw new NotFoundException({
          code: 'PRODUCT_CREATOR_PROFILE_NOT_FOUND',
          message: 'Creator profile not found',
        });
      productData.creator_id = creator.id;
    }

    normalizeFeedFields(data);
    await this.assertTaxClassAllowed(dto.tax_class_id, productData.creator_id);
    await this.assertShippingProfileAllowed(
      dto.shipping_profile_id,
      productData,
    );
    if (data.variant_option_config !== undefined) {
      await this.assertOptionConfigWrite(
        null,
        productData.creator_id,
        null,
        data.variant_option_config,
      );
    }

    // Create the product
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
      await this.assertBundlesOwnedByCreator(
        bundle_ids,
        productData.creator_id,
      );
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

  /**
   * `GET /products`. Admins and owners filtering their own catalogue
   * (`creator_id` / `provider_id` of the caller) get the full rows; everyone
   * else, anonymous callers included, only sees PUBLISHED provider products
   * through `PUBLIC_PRODUCT_LIST_SELECT`. Filtering by somebody else's
   * creator id is refused (creator catalogues are public per store only,
   * through the storefront API).
   */
  async listForViewer(
    filters: ProductListFilters,
    viewer: ProductListViewer = {},
  ) {
    if (viewer.role === UserRole.ADMIN) return this.findAll(filters);

    if (filters.creator_id) {
      const own =
        viewer.userId && viewer.role === UserRole.CREATOR
          ? await this.prisma.creator.findUnique({
              where: { user_id: viewer.userId },
              select: { id: true },
            })
          : null;
      if (!own || own.id !== filters.creator_id) {
        throw new ForbiddenException({
          code: 'PRODUCT_LIST_FORBIDDEN',
          message: 'You can only list your own products',
        });
      }
      return this.findAll(filters);
    }

    if (filters.provider_id && viewer.userId) {
      const own =
        viewer.role === UserRole.PROVIDER
          ? await this.prisma.provider.findUnique({
              where: { user_id: viewer.userId },
              select: { id: true },
            })
          : null;
      if (own && own.id === filters.provider_id) return this.findAll(filters);
    }

    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const empty = { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
    if (filters.status && filters.status !== ProductStatus.PUBLISHED) {
      return empty;
    }
    if (filters.owner_type === 'creator') return empty;
    const where = this.listWhere({
      ...filters,
      status: ProductStatus.PUBLISHED,
      creator_id: undefined,
    });
    where.provider_id = filters.provider_id ?? { not: null };
    const [data, total] = await Promise.all([
      this.prisma.product.findMany({
        skip: (page - 1) * limit,
        take: limit,
        where,
        select: PUBLIC_PRODUCT_LIST_SELECT,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.product.count({ where }),
    ]);
    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  private listWhere(rest: ProductListFilters): Prisma.ProductWhereInput {
    const where: Prisma.ProductWhereInput = {};
    if (rest.category_id) where.category_id = rest.category_id;
    if (rest.product_type)
      where.product_type = rest.product_type as ProductType;
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
    return where;
  }

  /** Full rows: admins, owners and internal callers only (never anonymous). */
  async findAll(filters: ProductListFilters) {
    const { page = 1, limit = 20, ...rest } = filters;
    const skip = (page - 1) * limit;
    const where = this.listWhere(rest);

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
      if (!creator)
        throw new NotFoundException({
          code: 'PRODUCT_CREATOR_PROFILE_NOT_FOUND',
          message: 'Creator profile not found',
        });

      return this.findAll({ ...filters, creator_id: creator.id });
    }

    const provider = await this.prisma.provider.findUnique({
      where: { user_id: userId },
    });
    if (!provider)
      throw new NotFoundException({
        code: 'PRODUCT_PROVIDER_PROFILE_NOT_FOUND',
        message: 'Provider profile not found',
      });

    return this.findAll({ ...filters, provider_id: provider.id });
  }

  async findById(id: string, userId?: string, userRole?: UserRole) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: this.productIncludes,
    });

    if (!product)
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });

    // cost_price is the provider's confidential margin input — a creator
    // browsing the catalogue to import must never see it.
    if (userRole !== UserRole.ADMIN) {
      const owns = userId
        ? await this.userOwnsProduct(product, userId, userRole)
        : false;
      if (!owns) return redactProductForNonOwner(product);
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
    if (!product)
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });

    // التحقق من الملكية
    await this.checkOwnership(product, userId, userRole);

    const {
      translations,
      attributes,
      tags,
      bundle_ids,
      creator_category_ids,
      variants,
      images,
      ...data
    } = dto;

    // Feed fields: absent keys are not in `data`, so the stored values are
    // kept (X19 carry-over); '' / null clears them.
    normalizeFeedFields(data);
    await this.assertTaxClassAllowed(dto.tax_class_id, product.creator_id);
    await this.assertShippingProfileAllowed(dto.shipping_profile_id, product);
    if (data.variant_option_config !== undefined) {
      await this.assertOptionConfigWrite(
        product,
        product.creator_id,
        product.variant_option_config,
        data.variant_option_config,
      );
    }

    // Update the product
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
      // Translations are deleted and recreated, so fields the client did not
      // send must be carried over or they are wiped (M4.4 X19):
      // short_description `undefined` = keep the stored value of that locale.
      const rows = await this.withTranslationCarryOver(id, translations);
      await this.prisma.productTranslation.deleteMany({
        where: { product_id: id },
      });
      await this.prisma.productTranslation.createMany({
        data: rows.map((t) => ({
          ...sanitizeTranslationHtml(t),
          product_id: id,
        })),
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
    if (!product)
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });

    await this.checkOwnership(product, userId, userRole);

    const deleted = await this.prisma.product.delete({ where: { id } });

    await this.revalidateForCreator(product.creator_id);

    return deleted;
  }

  /**
   * X19 carry-over for the translation delete-and-recreate in update():
   * a translation whose `short_description` is `undefined` keeps the value
   * stored for the same locale; `null`/'' clears it. One read, and only when
   * some row omits the field.
   */
  private async withTranslationCarryOver(
    productId: string,
    translations: ProductTranslationDto[],
  ): Promise<ProductTranslationDto[]> {
    if (!translations.some((t) => t.short_description === undefined)) {
      return translations.map((t) => ({
        ...t,
        short_description: t.short_description || null,
      }));
    }
    const stored = await this.prisma.productTranslation.findMany({
      where: { product_id: productId },
      select: { locale: true, short_description: true },
    });
    const byLocale = new Map(
      stored.map((r) => [r.locale, r.short_description]),
    );
    return translations.map((t) => ({
      ...t,
      short_description:
        t.short_description === undefined
          ? (byLocale.get(t.locale) ?? null)
          : t.short_description || null,
    }));
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
        custom_fields: {
          include: { translations: true },
          orderBy: [{ sort_order: 'asc' as const }, { id: 'asc' as const }],
        },
        faqs: { include: { translations: true } },
      },
    });
    if (!source)
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });

    await this.checkOwnership(source, userId, userRole);
    // The clone keeps the source's profile; refuse if that profile is not the
    // owner's any more (e.g. it was deleted or re-assigned).
    await this.assertShippingProfileAllowed(source.shipping_profile_id, source);

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
          tax_class_id: source.tax_class_id,
          tax_exempt: source.tax_exempt,
          // Feed data (M5.6) is copied as-is; the clone is a DRAFT so a
          // shared GTIN never reaches a feed until the creator reviews it.
          gtin: source.gtin,
          mpn: source.mpn,
          brand: source.brand,
          google_product_category: source.google_product_category,
          condition: source.condition,
          feed_excluded: source.feed_excluded,
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
            // M4.4 X20: copied; external refs are never copied (the clone
            // is not the imported product).
            short_description: t.short_description,
          })),
        });
      }

      // Tags — flat copy.
      if (source.tags.length > 0) {
        await tx.productTag.createMany({
          data: source.tags.map((t) => ({
            product_id: created.id,
            tag: t.tag,
          })),
        });
      }

      // Attributes — flat copy.
      if (source.attributes.length > 0) {
        await tx.productAttribute.createMany({
          data: source.attributes.map((a) => ({
            product_id: created.id,
            template_id: a.template_id,
            value: a.value as Prisma.InputJsonValue,
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
            options: v.options as Prisma.InputJsonValue,
          },
        });
        variantIdMap[v.id] = newVariant.id;
      }

      // Images — remap variant_id via the map (null stays null).
      if (source.images.length > 0) {
        await tx.productImage.createMany({
          data: source.images.map((img) => ({
            product_id: created.id,
            variant_id: img.variant_id
              ? (variantIdMap[img.variant_id] ?? null)
              : null,
            url: img.url,
            alt_text: img.alt_text,
            sort_order: img.sort_order,
            is_featured: img.is_featured,
          })),
        });
      }

      // Custom fields with their translations. M4.1 (X20): the
      // personalization columns are copied too, parents before children so
      // `parent_id` can be remapped to the cloned parent. JSON nulls are
      // left out (SQL NULL); fields without M4.1 data are copied as before.
      const fieldIdMap = new Map<string, string>();
      const json = (v: Prisma.JsonValue | null) =>
        v === null ? undefined : (v as Prisma.InputJsonValue);
      // A legacy link that targets a field by id points at the copy by
      // name (names are copied unchanged; links resolve by name, C16).
      const nameById = new Map(
        source.custom_fields.map((cf) => [cf.id, cf.name]),
      );
      const linkOf = (link: Prisma.JsonValue | null) => {
        if (!isPlainObject(link)) return link as Prisma.InputJsonValue;
        const target = typeof link.target === 'string' ? link.target : '';
        const legacy =
          typeof link.target_field_id === 'string' ? link.target_field_id : '';
        const name = nameById.get(target) ?? nameById.get(legacy);
        if (name === undefined) return link as Prisma.InputJsonValue;
        const { target_field_id: _legacy, ...rest } = link;
        return { ...rest, target: name } as Prisma.InputJsonValue;
      };
      const parentsFirst = [
        ...source.custom_fields.filter((cf) => !cf.parent_id),
        ...source.custom_fields.filter((cf) => !!cf.parent_id),
      ];
      for (const cf of parentsFirst) {
        // A child whose parent is not part of the product is skipped.
        const parentId = cf.parent_id ? fieldIdMap.get(cf.parent_id) : null;
        if (parentId === undefined) continue;
        const clone = await tx.productCustomField.create({
          data: {
            product_id: created.id,
            name: cf.name,
            type: cf.type,
            is_required: cf.is_required,
            placeholder: cf.placeholder,
            options: cf.options as Prisma.InputJsonValue,
            validation_rules: cf.validation_rules as Prisma.InputJsonValue,
            linked_validation: linkOf(cf.linked_validation),
            sort_order: cf.sort_order,
            ...(parentId ? { parent_id: parentId } : {}),
            ...(cf.conditions !== null && { conditions: json(cf.conditions) }),
            ...(cf.pricing !== null && { pricing: json(cf.pricing) }),
            ...(cf.repeat !== null && { repeat: json(cf.repeat) }),
            ...(cf.ui !== null && { ui: json(cf.ui) }),
            ...(cf.preset_key !== null && { preset_key: cf.preset_key }),
            // preset_ref is an external source ref (e.g. woo:<host>:product:<id>);
            // a copy is a new product, so it is never carried over (X20).
            translations: {
              create: cf.translations.map((t) => ({
                locale: t.locale,
                label: t.label,
                placeholder: t.placeholder,
                option_labels: t.option_labels as Prisma.InputJsonValue,
                ...(t.display_label !== null && {
                  display_label: t.display_label,
                }),
                ...(t.sublabel !== null && { sublabel: t.sublabel }),
                ...(t.note !== null && { note: t.note }),
                ...(t.help_text !== null && { help_text: t.help_text }),
                ...(t.help_image_url !== null && {
                  help_image_url: t.help_image_url,
                }),
                ...(t.messages !== null && { messages: json(t.messages) }),
              })),
            },
          },
          select: { id: true },
        });
        fieldIdMap.set(cf.id, clone.id);
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
    if (!product)
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });

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
      data: {
        product_id: productId,
        url,
        alt_text: altText,
        sort_order: sortOrder ?? 0,
        is_featured: isFeatured ?? false,
        variant_id: variantId,
      },
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
    if (!image)
      throw new NotFoundException({
        code: 'PRODUCT_IMAGE_NOT_FOUND',
        message: 'Image not found',
      });
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
          this.prisma.productImage.update({
            where: { id },
            data: { sort_order: i },
          }),
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
    if (!product)
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });
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
          orderBy: [{ sort_order: 'asc' as const }, { id: 'asc' as const }],
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

    if (!product)
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });

    // Only published provider products can be imported into a creator store —
    // drafts, archived items, and creator-own products are not importable.
    if (!product.provider_id || product.status !== ProductStatus.PUBLISHED) {
      throw new BadRequestException({
        code: 'PRODUCT_NOT_IMPORTABLE',
        message:
          'This product cannot be imported — only published provider products are available for import.',
      });
    }

    // Fallback to provider's default shipping profile if none assigned
    if (
      !(product as { shipping_profile?: unknown }).shipping_profile &&
      product.provider_id
    ) {
      const defaultProfile = await this.prisma.shippingProfile.findFirst({
        where: { provider_id: product.provider_id, is_default: true },
        include: { zones: true },
      });
      if (defaultProfile) {
        return redactProductForNonOwner({
          ...product,
          shipping_profile: defaultProfile,
        });
      }
    }

    // The importing creator is not the owner: no cost price or importer refs.
    return redactProductForNonOwner(product);
  }

  private async checkOwnership(
    product: { provider_id: string | null; creator_id: string | null },
    userId: string,
    userRole: UserRole,
  ) {
    if (userRole === UserRole.ADMIN) return;

    if (userRole === UserRole.PROVIDER) {
      const provider = await this.prisma.provider.findUnique({
        where: { user_id: userId },
      });
      if (product.provider_id !== provider?.id) {
        throw new ForbiddenException({
          code: 'PRODUCT_FORBIDDEN',
          message: 'Not your product',
        });
      }
    }

    if (userRole === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
      });
      if (product.creator_id !== creator?.id) {
        throw new ForbiddenException({
          code: 'PRODUCT_FORBIDDEN',
          message: 'Not your product',
        });
      }
    }
  }
}
