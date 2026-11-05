import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { encodeSlugForUrl, sanitizeTitle } from '@multi-stores/core/slug';
import { PrismaService } from '../../prisma/prisma.service';
import { RedirectsService } from '../redirects/redirects.service';
import { uniqueProductSlug } from '../../common/slug/wp-slug';
import {
  productRedirectMoves,
  productSlugContext,
  releaseLiveProductPaths,
  resolveProductTranslationSlugs,
} from '../../common/slug/product-slugs';
import type { LocaleSlug } from '../../common/slug/slug-moves';
import { sanitizeCreatorHtml } from '../../common/html/creator-html';
import {
  CreatorCategoryLinks,
  resolvePrimaryCreatorCategory,
} from '../creator-categories/primary-collection';
import { nextCollectionSortOrders } from '../creator-categories/product-order';
import {
  CreatorCategoryVisibility,
  Prisma,
  ImportMode,
  PricingType,
  ProductStatus,
  StoreType,
  UserRole,
} from '@prisma/client';
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
import { TaxService } from '../taxes/tax.service';
import {
  findPriceFloorViolation,
  loadPriceFloorSetup,
  minimumCustomerPrice,
  priceFloorInfo,
  type PriceFloorSetup,
  type PriceFloorVariant,
} from './price-floor';

type Money = Prisma.Decimal | number;

/** Base product fields the minimum price check reads. */
interface FloorProduct {
  base_price: Money;
  provider_id: string | null;
  tax_class_id: string | null;
  tax_exempt: boolean;
  variants: { id: string; price_adjustment: Money }[];
}

/** Custom product fields the below-minimum flag reads. */
interface FloorCustomProduct {
  pricing_type: PricingType;
  final_price: Money;
  margin_amount: Money | null;
  selected_variants?: { variant_id: string; custom_price: Money | null }[];
  product: FloorProduct;
}

/** Base product select of the minimum price check. */
const floorProductSelect = {
  base_price: true,
  provider_id: true,
  tax_class_id: true,
  tax_exempt: true,
  variants: {
    where: { is_active: true },
    select: { id: true, price_adjustment: true },
  },
} as const;

/**
 * The description and FAQ answers are rendered as HTML (storefront product
 * page, provider review page), so they go through the creator sanitizer on
 * every write, like regular products.
 */
function sanitizeDescription<T extends { description?: string | null }>(
  t: T,
): T {
  return t.description == null
    ? t
    : { ...t, description: sanitizeCreatorHtml(t.description) };
}

function sanitizeAnswer<T extends { answer: string }>(t: T): T {
  return { ...t, answer: sanitizeCreatorHtml(t.answer) ?? '' };
}

@Injectable()
export class CustomProductsService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
    // Old-slug 301s (WP `_wp_old_slug`); optional for positional tests.
    @Optional() private readonly redirects?: RedirectsService,
    // Minimum price check (checkout tax engine); optional for positional
    // tests, which then skip the check.
    @Optional() private readonly taxService?: TaxService,
  ) {}

  private loadFloorSetup(creatorId: string): Promise<PriceFloorSetup> | null {
    return this.taxService
      ? loadPriceFloorSetup(this.prisma, this.taxService, creatorId)
      : null;
  }

  /**
   * The variants a custom product sells, as the floor check sees them: the
   * selected rows still active on the base product, else every active
   * variant (AS_IS rows mirror them), else none.
   */
  private floorVariants(
    product: FloorProduct,
    selected: { variant_id: string; custom_price?: Money | null }[] | undefined,
  ): PriceFloorVariant[] {
    const active = new Map(
      product.variants.map((v) => [v.id, Number(v.price_adjustment) || 0]),
    );
    const rows = (selected ?? []).filter((sv) => active.has(sv.variant_id));
    if (rows.length > 0) {
      return rows.map((sv) => ({
        variant_id: sv.variant_id,
        price_adjustment: active.get(sv.variant_id) ?? 0,
        custom_price: sv.custom_price == null ? null : Number(sv.custom_price),
      }));
    }
    return product.variants.map((v) => ({
      variant_id: v.id,
      price_adjustment: Number(v.price_adjustment) || 0,
    }));
  }

  /**
   * Marketplace: the customer price must cover the provider base + VAT (the
   * split runs on net revenue and provider bases are net). 400
   * CUSTOM_PRODUCT_PRICE_BELOW_MINIMUM with { minimum, currency, variant_id? }
   * (plus minimum_margin for MARGIN pricing).
   */
  private async assertPriceFloor(
    creatorId: string,
    product: FloorProduct,
    pricing: {
      pricing_type: PricingType;
      final_price?: Money | null;
      margin_amount?: Money | null;
      selected_variants?: { variant_id: string; custom_price?: Money | null }[];
    },
  ) {
    if (!product.provider_id) return;
    const setupPromise = this.loadFloorSetup(creatorId);
    if (!setupPromise) return;
    const setup = await setupPromise;
    const violation = findPriceFloorViolation(
      {
        pricingType: pricing.pricing_type,
        finalPrice: Number(pricing.final_price) || 0,
        marginAmount: Number(pricing.margin_amount) || 0,
        basePrice: Number(product.base_price),
        variants: this.floorVariants(product, pricing.selected_variants),
      },
      setup.rateBpFor(product),
      setup.pricesIncludeVat,
    );
    if (!violation) return;
    throw new BadRequestException({
      code: 'CUSTOM_PRODUCT_PRICE_BELOW_MINIMUM',
      message: `The price must be at least ${violation.minimum.toFixed(2)} ${setup.currency} (the provider's base price plus VAT).`,
      minimum: violation.minimum,
      currency: setup.currency,
      ...(violation.variant_id ? { variant_id: violation.variant_id } : {}),
      ...(violation.minimum_margin !== undefined
        ? { minimum_margin: violation.minimum_margin }
        : {}),
    });
  }

  /**
   * Floor a bundle's effective unit price must keep for a SINGLE-priced
   * custom product: the highest variant minimum (base + VAT). Without the
   * tax engine (positional tests) it is the net base, as before.
   */
  private async bundleFloorFor(
    creatorId: string,
    product: FloorProduct,
    selected?: { variant_id: string }[],
  ): Promise<number> {
    if (!product.provider_id) return 0;
    const base = Number(product.base_price);
    const setupPromise = this.loadFloorSetup(creatorId);
    if (!setupPromise) return base;
    const setup = await setupPromise;
    const rate = setup.rateBpFor(product);
    const variants = this.floorVariants(product, selected);
    const costs = variants.length
      ? variants.map((v) => base + v.price_adjustment)
      : [base];
    return Math.max(
      ...costs.map((c) =>
        minimumCustomerPrice(c, rate, setup.pricesIncludeVat),
      ),
    );
  }

  /** Adds the creator-facing minimum price fields to custom product payloads. */
  private withPriceFloor<T extends FloorCustomProduct>(
    cp: T,
    setup: PriceFloorSetup | null,
  ): T & {
    price_floor: ReturnType<typeof priceFloorInfo> | null;
    below_minimum: boolean;
  } {
    if (!setup || !cp.product?.provider_id) {
      return { ...cp, price_floor: null, below_minimum: false };
    }
    const info = priceFloorInfo(setup, cp.product);
    const violation = findPriceFloorViolation(
      {
        pricingType: cp.pricing_type,
        finalPrice: Number(cp.final_price) || 0,
        marginAmount: Number(cp.margin_amount) || 0,
        basePrice: Number(cp.product.base_price),
        variants: this.floorVariants(cp.product, cp.selected_variants),
      },
      info.vat_rate_bp,
      info.prices_include_vat,
    );
    return { ...cp, price_floor: info, below_minimum: !!violation };
  }

  /**
   * GET /custom-products/price-floor?product_id=: what the creator's pricing
   * step needs to show and check the minimum before the product exists.
   * Null when the minimum is not enforced (no tax engine).
   */
  async getPriceFloor(userId: string, productId: string) {
    if (!productId || typeof productId !== 'string')
      throw new BadRequestException({
        code: 'CUSTOM_PRODUCT_BASE_PRODUCT_NOT_FOUND',
        message: 'product_id is required',
      });
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    if (!creator)
      throw new NotFoundException({
        code: 'CUSTOM_PRODUCT_CREATOR_NOT_FOUND',
        message: 'Creator not found',
      });
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: {
        provider_id: true,
        tax_class_id: true,
        tax_exempt: true,
        status: true,
      },
    });
    if (
      !product ||
      !product.provider_id ||
      product.status !== ProductStatus.PUBLISHED
    )
      throw new NotFoundException({
        code: 'CUSTOM_PRODUCT_BASE_PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });
    const setupPromise = this.loadFloorSetup(creator.id);
    if (!setupPromise) return null;
    return priceFloorInfo(await setupPromise, product);
  }

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
        message:
          'Independent stores sell their own products only, so custom products are not available.',
      });
    }
  }

  // ── Ownership helpers ────────────────────────────────────
  private async assertCreatorOwns(customProductId: string, userId: string) {
    const cp = await this.prisma.customProduct.findUnique({
      where: { id: customProductId },
      include: { creator: { select: { user_id: true } } },
    });
    if (!cp)
      throw new NotFoundException({
        code: 'CUSTOM_PRODUCT_NOT_FOUND',
        message: 'Custom product not found',
      });
    if (cp.creator.user_id !== userId) {
      throw new ForbiddenException({
        code: 'CUSTOM_PRODUCT_NOT_OWNED',
        message: 'You do not own this custom product',
      });
    }
    return cp;
  }

  private async assertProviderOwnsBase(
    customProductId: string,
    userId: string,
  ) {
    const cp = await this.prisma.customProduct.findUnique({
      where: { id: customProductId },
      include: {
        product: { include: { provider: { select: { user_id: true } } } },
        creator: { select: { user_id: true } },
        translations: true,
      },
    });
    if (!cp)
      throw new NotFoundException({
        code: 'CUSTOM_PRODUCT_NOT_FOUND',
        message: 'Custom product not found',
      });
    if (!cp.product.provider || cp.product.provider.user_id !== userId) {
      throw new ForbiddenException({
        code: 'CUSTOM_PRODUCT_BASE_NOT_OWNED',
        message: 'You do not own this base product',
      });
    }
    return cp;
  }

  private readonly includes = {
    product: {
      include: {
        translations: true,
        images: { orderBy: { sort_order: 'asc' as const } },
        variants: { where: { is_active: true } },
        custom_fields: {
          include: { translations: true },
          orderBy: [{ sort_order: 'asc' as const }, { id: 'asc' as const }],
        },
      },
    },
    mockup_images: true,
    translations: true,
    creator: { select: { display_name: true } },
    selected_variants: { include: { variant: true } },
    field_values: { include: { custom_field: true } },
    faqs: {
      include: { translations: true },
      orderBy: { sort_order: 'asc' as const },
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
    creator_categories: {
      include: { creator_category: { include: { translations: true } } },
    },
  };

  /**
   * Replace a custom product's collection links with `categoryIds`.
   * Silently skips any collection id that doesn't belong to this creator
   * (defense-in-depth — DTO can't enforce ownership). Links that stay keep
   * their row (and so their `sort_order`, M6); only the removed ones are
   * deleted and the new ones created, each at the end of its collection.
   * Returns the linked ids in the order they were sent, with the INTERNAL
   * ones listed separately (M6.3: labels are linkable, never the primary).
   */
  private async syncCreatorCategories(
    customProductId: string,
    creatorId: string,
    categoryIds: string[],
  ): Promise<CreatorCategoryLinks> {
    const owned = categoryIds.length
      ? await this.prisma.creatorCategory.findMany({
          where: { id: { in: categoryIds }, creator_id: creatorId },
          select: { id: true, visibility: true },
        })
      : [];
    const ownedIds = new Set(owned.map((c) => c.id));
    const linked = Array.from(
      new Set(categoryIds.filter((id) => ownedIds.has(id))),
    );
    const kept = await this.prisma.customProductCreatorCategory.findMany({
      where: {
        custom_product_id: customProductId,
        creator_category_id: { in: linked },
      },
      select: { creator_category_id: true, sort_order: true },
    });
    await this.prisma.customProductCreatorCategory.deleteMany({
      where: {
        custom_product_id: customProductId,
        creator_category_id: { notIn: linked },
      },
    });
    const keptIds = new Set(kept.map((k) => k.creator_category_id));
    const toAttach = linked.filter((id) => !keptIds.has(id));
    if (toAttach.length) {
      // A new link goes to the end of its collection's manual order (max
      // across own + custom links, + 1); kept links keep their sort_order.
      const next = await nextCollectionSortOrders(this.prisma, toAttach);
      await this.prisma.customProductCreatorCategory.createMany({
        data: toAttach.map((creator_category_id) => ({
          custom_product_id: customProductId,
          creator_category_id,
          sort_order: next.get(creator_category_id) ?? 0,
        })),
        skipDuplicates: true,
      });
    }
    return {
      linked,
      internal: owned
        .filter((c) => c.visibility === CreatorCategoryVisibility.INTERNAL)
        .map((c) => c.id),
    };
  }

  /** M6.3: the INTERNAL ids among `categoryIds` owned by `creatorId`. */
  private async internalCreatorCategoryIds(
    categoryIds: string[],
    creatorId: string,
  ): Promise<string[]> {
    if (!categoryIds.length) return [];
    const rows = await this.prisma.creatorCategory.findMany({
      where: { id: { in: categoryIds }, creator_id: creatorId },
      select: { id: true, visibility: true },
    });
    return rows
      .filter((c) => c.visibility === CreatorCategoryVisibility.INTERNAL)
      .map((c) => c.id);
  }

  /**
   * M6: store the primary collection of a custom product. `links` is the
   * current link list (request order when it was just replaced, stored
   * order otherwise); the rules live in resolvePrimaryCreatorCategory.
   */
  private async applyPrimaryCreatorCategory(
    customProductId: string,
    links: CreatorCategoryLinks,
    requested: string | null | undefined,
    current: string | null,
  ) {
    const primary = resolvePrimaryCreatorCategory({
      requested,
      linked: links.linked,
      internal: links.internal,
      current,
    });
    if (primary !== current) {
      await this.prisma.customProduct.update({
        where: { id: customProductId },
        data: { primary_creator_category_id: primary },
      });
    }
  }

  /** Stored links of a custom product, by position then id. */
  private async linkedCreatorCategoryIds(
    customProductId: string,
  ): Promise<CreatorCategoryLinks> {
    const rows = await this.prisma.customProductCreatorCategory.findMany({
      where: { custom_product_id: customProductId },
      select: {
        creator_category_id: true,
        creator_category: { select: { visibility: true } },
      },
      orderBy: [{ sort_order: 'asc' }, { creator_category_id: 'asc' }],
    });
    return {
      linked: rows.map((r) => r.creator_category_id),
      internal: rows
        .filter(
          (r) =>
            r.creator_category.visibility ===
            CreatorCategoryVisibility.INTERNAL,
        )
        .map((r) => r.creator_category_id),
    };
  }

  /**
   * WP slugs of a custom product's translations: sanitized with the store's
   * content locale, a slug sent back unchanged kept as stored, the rest made
   * unique (`-2`, `-3`, ...) across the creator's own products and custom
   * products, which share `/products/<slug>` on the storefront. Replaces the
   * former 400 "Slug already in use".
   */
  private async slugTranslations<
    T extends { locale: string; slug?: string | null; title?: string | null },
  >(
    creatorId: string,
    translations: readonly T[],
    opts: { stored?: readonly LocaleSlug[]; customProductId?: string } = {},
  ): Promise<{
    rows: (T & { slug: string })[];
    storeId: string | null;
    locale: string;
  }> {
    const ctx = await productSlugContext(this.prisma, creatorId);
    const rows = await resolveProductTranslationSlugs(
      this.prisma,
      translations,
      {
        owner: { creatorId },
        locale: ctx.locale,
        stored: opts.stored,
        exclude: { customProductId: opts.customProductId },
        id: opts.customProductId,
      },
    );
    return { rows, storeId: ctx.storeId, locale: ctx.locale };
  }

  /**
   * Check a slug for the dashboard: `slug` is what the server would store
   * (WP sanitize_title with the store's content locale), `available` whether
   * it is free among this creator's products and custom products, and
   * `suggestion` the slug a save would get (`<slug>-2`, ...).
   */
  async checkSlug(userId: string, slug: string, excludeId?: string) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    if (!creator)
      throw new NotFoundException({
        code: 'CUSTOM_PRODUCT_CREATOR_NOT_FOUND',
        message: 'Creator not found',
      });
    const { locale } = await productSlugContext(this.prisma, creator.id);
    const sanitized = sanitizeTitle(slug || '', { locale });
    if (!sanitized) return { available: false, reason: 'empty' as const };

    const [customConflict, productConflict] = await Promise.all([
      this.prisma.customProduct.findFirst({
        where: {
          creator_id: creator.id,
          ...(excludeId ? { id: { not: excludeId } } : {}),
          translations: { some: { slug: sanitized } },
        },
        select: { id: true },
      }),
      this.prisma.product.findFirst({
        where: {
          creator_id: creator.id,
          translations: { some: { slug: sanitized } },
        },
        select: { id: true },
      }),
    ]);
    const available = !customConflict && !productConflict;
    return {
      available,
      slug: sanitized,
      suggestion: available
        ? sanitized
        : await uniqueProductSlug(
            this.prisma,
            { creatorId: creator.id },
            sanitized,
            { customProductId: excludeId },
          ),
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
      throw new BadRequestException({
        code: 'CUSTOM_PRODUCT_BUNDLE_NOT_EXIST',
        message: 'One or more bundles do not exist',
      });
    }
    for (const b of found) {
      if (b.creator_id !== creatorId) {
        throw new ForbiddenException({
          code: 'CUSTOM_PRODUCT_BUNDLE_NOT_OWNED',
          message: 'You can only attach your own bundles',
        });
      }
    }
  }

  async create(userId: string, dto: CreateCustomProductDto) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
    });
    if (!creator)
      throw new NotFoundException({
        code: 'CUSTOM_PRODUCT_CREATOR_NOT_FOUND',
        message: 'Creator not found',
      });

    // Independent stores cannot create custom products (own products only).
    await this.assertStoreAllowsCustomProducts(creator.id);

    // The base product must be a published provider product — drafts, archived
    // items, and other creators' own products cannot be imported.
    const baseProduct = await this.prisma.product.findUnique({
      where: { id: dto.product_id },
      select: { status: true, provider_id: true },
    });
    if (!baseProduct)
      throw new NotFoundException({
        code: 'CUSTOM_PRODUCT_BASE_PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });
    if (
      !baseProduct.provider_id ||
      baseProduct.status !== ProductStatus.PUBLISHED
    ) {
      throw new BadRequestException({
        code: 'CUSTOM_PRODUCT_BASE_NOT_IMPORTABLE',
        message:
          'This product cannot be imported — only published provider products are available for import.',
      });
    }

    // Validate pricing consistency
    this.validatePricing(dto.pricing_type, dto);

    // WP slugs: a slug taken by this creator's own products or custom
    // products (they share the storefront URL space) gets `-2`, `-3`, ...
    const { rows: translations } = await this.slugTranslations(
      creator.id,
      dto.translations,
    );

    const {
      translations: _sentTranslations,
      selected_variants,
      field_values,
      mockup_image_urls,
      bundle_ids,
      creator_category_ids,
      primary_creator_category_id,
      ...data
    } = dto;
    void _sentTranslations; // replaced by the slugged rows above

    // M6: a requested primary that is not among the sent links fails before
    // anything is written (the ownership-filtered check runs again after the
    // links are created, so this only avoids an orphan custom product row).
    resolvePrimaryCreatorCategory({
      requested: primary_creator_category_id,
      linked: creator_category_ids ?? [],
      // M6.3: only read when a primary is requested (the check needs it).
      internal: primary_creator_category_id
        ? await this.internalCreatorCategoryIds(
            creator_category_ids ?? [],
            creator.id,
          )
        : [],
      current: null,
    });

    if (bundle_ids && bundle_ids.length > 0) {
      await this.assertBundlesOwnedByCreator(bundle_ids, creator.id);

      // Economic check only meaningful for SINGLE pricing (one fixed price).
      // PER_VARIANT/MARGIN: the customer price depends on the chosen variant,
      // so a static pre-check would be misleading — skip it.
      if (data.pricing_type === PricingType.SINGLE) {
        const baseProduct = await this.prisma.product.findUnique({
          where: { id: data.product_id },
          select: floorProductSelect,
        });
        if (baseProduct) {
          const unitPrice =
            Number(data.final_price) || Number(baseProduct.base_price);
          // Marketplace: the floor is the provider base plus VAT.
          const providerBase = await this.bundleFloorFor(
            creator.id,
            baseProduct,
            selected_variants,
          );
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
      if (!product)
        throw new NotFoundException({
          code: 'CUSTOM_PRODUCT_BASE_PRODUCT_NOT_FOUND',
          message: 'Product not found',
        });

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
      if (!product)
        throw new NotFoundException({
          code: 'CUSTOM_PRODUCT_BASE_PRODUCT_NOT_FOUND',
          message: 'Product not found',
        });

      if (product.variants.length > 0) {
        // Product has variants — require at least one selected
        if (!selected_variants || selected_variants.length === 0) {
          throw new BadRequestException({
            code: 'CUSTOM_PRODUCT_VARIANT_REQUIRED',
            message: 'At least one variant must be selected in CUSTOMIZE mode',
          });
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

    // Minimum price: provider base + VAT for every variant sold.
    const floorProduct = await this.prisma.product.findUnique({
      where: { id: dto.product_id },
      select: floorProductSelect,
    });
    if (floorProduct) {
      await this.assertPriceFloor(creator.id, floorProduct, {
        pricing_type: dto.pricing_type,
        final_price: data.final_price,
        margin_amount: data.margin_amount,
        selected_variants: variantRows,
      });
    }

    const created = await this.prisma.customProduct.create({
      data: {
        product_id: data.product_id,
        creator_id: creator.id,
        import_mode: data.import_mode,
        pricing_type: data.pricing_type,
        final_price: data.final_price ?? 0,
        margin_amount: data.margin_amount,
        translations: { create: translations.map(sanitizeDescription) },
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
      const links = await this.syncCreatorCategories(
        created.id,
        creator.id,
        creator_category_ids,
      );
      await this.applyPrimaryCreatorCategory(
        created.id,
        links,
        primary_creator_category_id,
        null,
      );
      return this.loadById(created.id);
    }
    // No links: a requested primary cannot be honoured (throws).
    await this.applyPrimaryCreatorCategory(
      created.id,
      { linked: [], internal: [] },
      primary_creator_category_id,
      null,
    );

    return created;
  }

  async findByCreator(userId: string, page = 1, limit = 20, q?: unknown) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
    });
    if (!creator)
      throw new NotFoundException({
        code: 'CUSTOM_PRODUCT_CREATOR_NOT_FOUND',
        message: 'Creator not found',
      });

    const where: Prisma.CustomProductWhereInput = { creator_id: creator.id };
    // Repeated query params arrive as arrays; they are ignored.
    const term = typeof q === 'string' ? q.trim() : '';
    if (term) {
      const contains = { contains: term, mode: 'insensitive' as const };
      where.OR = [
        { translations: { some: { title: contains } } },
        { translations: { some: { slug: contains } } },
        { product: { sku: contains } },
      ];
    }

    const skip = (page - 1) * limit;
    const [rows, total] = await Promise.all([
      this.prisma.customProduct.findMany({
        where,
        skip,
        take: limit,
        include: this.includes,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.customProduct.count({ where }),
    ]);
    // below_minimum flags existing products priced under base + VAT.
    const setup = rows.length ? await this.loadFloorSetup(creator.id) : null;
    const data = rows.map((cp) => this.withPriceFloor(cp, setup));

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Readable by the owning creator, or by the provider whose base product it
   * builds on (they review submissions). Anyone else gets a 404 — the record
   * carries the creator's margin and their unpublished drafts.
   */
  async findById(id: string, userId: string, role: UserRole) {
    const cp = await this.loadById(id);

    if (role !== UserRole.ADMIN) {
      let allowed = false;
      if (role === UserRole.CREATOR) {
        const creator = await this.prisma.creator.findUnique({
          where: { user_id: userId },
          select: { id: true },
        });
        allowed = !!creator && cp.creator_id === creator.id;
      } else if (role === UserRole.PROVIDER) {
        const provider = await this.prisma.provider.findUnique({
          where: { user_id: userId },
          select: { id: true },
        });
        allowed = !!provider && cp.product?.provider_id === provider.id;
      }
      if (!allowed) {
        throw new NotFoundException({
          code: 'CUSTOM_PRODUCT_NOT_FOUND',
          message: 'Custom product not found',
        });
      }
    }
    // The selling store's content languages, so a reviewing provider (who
    // cannot read the creator's store) shows its texts in the right locale.
    const languageConfig = await this.prisma.storeLanguageConfig.findFirst({
      where: { store: { creator_id: cp.creator_id } },
      select: { primary_locale: true, secondary_locales: true },
    });
    const setup = await this.loadFloorSetup(cp.creator_id);
    return {
      ...this.withPriceFloor(cp, setup),
      store_language: {
        primary_locale: languageConfig?.primary_locale ?? 'en',
        secondary_locales: languageConfig?.secondary_locales ?? [],
      },
    };
  }

  /**
   * Reload without an ownership check — for internal use right after a mutation
   * whose own guard already established the caller owns the record.
   */
  private async loadById(id: string) {
    const cp = await this.prisma.customProduct.findUnique({
      where: { id },
      include: this.includes,
    });
    if (!cp)
      throw new NotFoundException({
        code: 'CUSTOM_PRODUCT_NOT_FOUND',
        message: 'Custom product not found',
      });
    return cp;
  }

  async update(id: string, dto: UpdateCustomProductDto, userId?: string) {
    const existing = await this.prisma.customProduct.findUnique({
      where: { id },
      include: {
        creator: { select: { user_id: true } },
        product: { select: floorProductSelect },
        selected_variants: {
          select: { variant_id: true, custom_price: true },
        },
      },
    });
    if (!existing)
      throw new NotFoundException({
        code: 'CUSTOM_PRODUCT_NOT_FOUND',
        message: 'Custom product not found',
      });

    // Ownership check
    if (userId && existing.creator.user_id !== userId) {
      throw new ForbiddenException({
        code: 'CUSTOM_PRODUCT_NOT_OWNED',
        message: 'You do not own this custom product',
      });
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
      throw new ForbiddenException({
        code: 'CUSTOM_PRODUCT_PUBLISH_AWAITING_REVIEW',
        message: 'Cannot publish a product that is awaiting provider review',
      });
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
      throw new ForbiddenException({
        code: 'CUSTOM_PRODUCT_PUBLISH_REJECTED',
        message:
          'Cannot publish a rejected product without resubmitting for review',
      });
    }

    const pricingType = dto.pricing_type ?? existing.pricing_type;

    // Validate pricing if pricing-related fields changed
    if (
      dto.pricing_type ||
      dto.final_price !== undefined ||
      dto.margin_amount !== undefined
    ) {
      this.validatePricing(pricingType, {
        final_price: dto.final_price ?? Number(existing.final_price),
        margin_amount:
          dto.margin_amount ??
          (existing.margin_amount ? Number(existing.margin_amount) : undefined),
        selected_variants: dto.selected_variants,
        pricing_type: pricingType,
      });
    }

    // Minimum price (provider base + VAT), checked only when the pricing
    // actually changes: an existing product below the minimum can still have
    // its texts or images edited (the list flags it as below_minimum).
    type PricingState = {
      pricing_type: PricingType;
      final_price: number;
      margin_amount: number | null;
      selected_variants: { variant_id: string; custom_price?: Money | null }[];
    };
    const nextPricing: PricingState = {
      pricing_type: pricingType,
      final_price:
        dto.final_price !== undefined
          ? dto.final_price
          : Number(existing.final_price),
      margin_amount:
        dto.margin_amount !== undefined
          ? dto.margin_amount
          : existing.margin_amount == null
            ? null
            : Number(existing.margin_amount),
      selected_variants: dto.selected_variants ?? existing.selected_variants,
    };
    const pricingSignature = (p: PricingState) =>
      JSON.stringify([
        p.pricing_type,
        p.pricing_type === PricingType.SINGLE
          ? Number(p.final_price) || 0
          : null,
        p.pricing_type === PricingType.MARGIN
          ? Number(p.margin_amount) || 0
          : null,
        (p.selected_variants ?? [])
          .map((sv) => [
            sv.variant_id,
            p.pricing_type === PricingType.PER_VARIANT
              ? Number(sv.custom_price) || 0
              : null,
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ]);
    const storedPricing: PricingState = {
      pricing_type: existing.pricing_type,
      final_price: Number(existing.final_price),
      margin_amount:
        existing.margin_amount == null ? null : Number(existing.margin_amount),
      selected_variants: existing.selected_variants,
    };
    const pricingChanged =
      pricingSignature(nextPricing) !== pricingSignature(storedPricing);
    if (pricingChanged) {
      await this.assertPriceFloor(
        existing.creator_id,
        existing.product,
        nextPricing,
      );
    }

    // WP slugs (excluding this custom product): unchanged slugs kept,
    // others sanitized and suffixed when taken.
    let storedSlugs: LocaleSlug[] = [];
    let slugCtx: { storeId: string | null; locale: string } | null = null;
    let translations: UpdateCustomProductDto['translations'];
    if (dto.translations && dto.translations.length > 0) {
      storedSlugs = await this.prisma.customProductTranslation.findMany({
        where: { custom_product_id: id },
        select: { locale: true, slug: true },
      });
      const res = await this.slugTranslations(
        existing.creator_id,
        dto.translations,
        { stored: storedSlugs, customProductId: id },
      );
      translations = res.rows;
      slugCtx = res;
    } else {
      translations = dto.translations;
    }

    const {
      translations: _sentTranslations,
      selected_variants,
      field_values,
      mockup_image_urls,
      bundle_ids,
      creator_category_ids,
      primary_creator_category_id,
      ...data
    } = dto;
    void _sentTranslations; // replaced by the slugged rows above

    // Cross-check: if the price is changing and the product has SINGLE
    // pricing, re-validate every already-attached bundle even when bundle_ids
    // is not in the payload. Catches the case where a creator lowers
    // final_price below what an existing bundle's discount can sustain.
    if (
      pricingType === PricingType.SINGLE &&
      data.final_price !== undefined &&
      bundle_ids === undefined &&
      pricingChanged
    ) {
      const currentAttachments = await this.prisma.bundleCustomProduct.findMany(
        {
          where: { custom_product_id: id },
          select: { bundle_id: true },
        },
      );
      const currentBundleIds = currentAttachments.map((a) => a.bundle_id);
      if (currentBundleIds.length > 0) {
        const nextFinal = Number(data.final_price);
        const unitPrice = nextFinal || Number(existing.product.base_price);
        const providerBase = await this.bundleFloorFor(
          existing.creator_id,
          existing.product,
          nextPricing.selected_variants,
        );
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
      await this.assertBundlesOwnedByCreator(bundle_ids, existing.creator_id);
      // Economic check is only meaningful for SINGLE pricing. For
      // PER_VARIANT/MARGIN the price depends on the chosen variant, so we
      // accept the attachment and let runtime order validation handle each
      // line individually.
      // The edit page always resends bundle_ids + final_price, so the
      // (gross) floor runs only on a real change: every bundle when the
      // pricing changed, else just the newly attached ones. Unchanged
      // attachments of an unchanged price stay saveable (text edits).
      let bundlesToCheck = bundle_ids;
      if (!pricingChanged && bundle_ids.length > 0) {
        const stored = await this.prisma.bundleCustomProduct.findMany({
          where: { custom_product_id: id },
          select: { bundle_id: true },
        });
        const storedIds = new Set(stored.map((a) => a.bundle_id));
        bundlesToCheck = bundle_ids.filter((b) => !storedIds.has(b));
      }
      if (bundlesToCheck.length > 0 && pricingType === PricingType.SINGLE) {
        const nextFinal = Number(data.final_price ?? existing.final_price);
        const unitPrice = nextFinal || Number(existing.product.base_price);
        const providerBase = await this.bundleFloorFor(
          existing.creator_id,
          existing.product,
          nextPricing.selected_variants,
        );
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
          bundlesToCheck,
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
            translations: { create: translations.map(sanitizeDescription) },
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

    // Replace creator collection links if provided. Empty array → detach all;
    // kept links keep their sort_order. The primary is re-resolved whenever
    // the links or the requested primary change (M6).
    const linksTouched =
      creator_category_ids !== undefined ||
      primary_creator_category_id !== undefined;
    if (linksTouched) {
      const links =
        creator_category_ids !== undefined
          ? await this.syncCreatorCategories(
              id,
              existing.creator_id,
              creator_category_ids,
            )
          : await this.linkedCreatorCategoryIds(id);
      await this.applyPrimaryCreatorCategory(
        id,
        links,
        primary_creator_category_id,
        existing.primary_creator_category_id,
      );
    }

    // Old-slug 301s when a published custom product's slugs changed.
    if (
      slugCtx?.storeId &&
      translations &&
      existing.status === ProductStatus.PUBLISHED &&
      this.redirects
    ) {
      const moves = await productRedirectMoves(this.prisma, {
        creatorId: existing.creator_id,
        primaryLocale: slugCtx.locale,
        before: storedSlugs,
        after: translations as LocaleSlug[],
        exclude: { customProductId: id },
      });
      await this.redirects.applySlugChangeRedirects(slugCtx.storeId, moves);
    }
    await releaseLiveProductPaths(this.prisma, this.redirects, {
      customProductId: id,
    });

    // Notify provider if product was auto-reverted to PENDING_REVIEW after edit
    if (autoRevertedToReview && existing.product.provider_id) {
      await this.notifyProviderOfSubmission(
        updated.id,
        'CUSTOM_PRODUCT_RESUBMITTED',
      );
    }

    return linksTouched ? this.loadById(id) : updated;
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
    if (!source)
      throw new NotFoundException({
        code: 'CUSTOM_PRODUCT_NOT_FOUND',
        message: 'Custom product not found',
      });

    const { locale: slugLocale } = await productSlugContext(
      this.prisma,
      source.creator_id,
    );
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
        // WP uniqueness suffix (`<slug>-2`, ...) instead of `-copy-<id>`;
        // the stored slug goes in its stable encoded form.
        const slugged = await resolveProductTranslationSlugs(
          tx,
          source.translations.map((t) => ({
            locale: t.locale,
            slug: encodeSlugForUrl(t.slug),
            title: t.title,
          })),
          {
            owner: { creatorId: source.creator_id },
            locale: slugLocale,
            exclude: { customProductId: newCp.id },
            id: newCp.id,
          },
        );
        await tx.customProductTranslation.createMany({
          data: source.translations.map((t, i) => ({
            custom_product_id: newCp.id,
            locale: t.locale,
            title: `${t.title} (Copy)`,
            description: sanitizeCreatorHtml(t.description),
            slug: slugged[i].slug,
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
                answer: sanitizeCreatorHtml(t.answer) ?? '',
              })),
            },
          },
        });
      }

      return newCp;
    });

    return this.loadById(created.id);
  }

  // ── Approval workflow ────────────────────────────────────

  /** Creator submits a custom product for provider review (or auto-publishes if no provider). */
  async submitForReview(id: string, userId: string) {
    const cp = await this.assertCreatorOwns(id, userId);

    // Independent stores cannot publish custom products (own products only).
    await this.assertStoreAllowsCustomProducts(cp.creator_id);

    if (
      cp.status !== ProductStatus.DRAFT &&
      cp.status !== ProductStatus.REJECTED
    ) {
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
      const published = await this.prisma.customProduct.update({
        where: { id },
        data: {
          status: ProductStatus.PUBLISHED,
          rejection_reason: null,
          submitted_at: new Date(),
        },
        include: this.includes,
      });
      await releaseLiveProductPaths(this.prisma, this.redirects, {
        customProductId: id,
      });
      return published;
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
    await releaseLiveProductPaths(this.prisma, this.redirects, {
      customProductId: id,
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
      throw new BadRequestException({
        code: 'CUSTOM_PRODUCT_REJECTION_REASON_REQUIRED',
        message: 'Rejection reason is required',
      });
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
    if (!provider)
      throw new NotFoundException({
        code: 'CUSTOM_PRODUCT_PROVIDER_NOT_FOUND',
        message: 'Provider not found',
      });

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
      isResubmit
        ? 'Custom product re-submitted'
        : 'New custom product to review',
      `${creatorName} ${isResubmit ? 'updated' : 'submitted'} "${title}" for your review`,
      { custom_product_id: customProductId },
    );
  }

  // ── FAQ management ────────────────────────────────────────

  // FAQ answers render on the storefront via dangerouslySetInnerHTML, so an
  // unchecked id let any creator inject content onto another creator's product.
  async createFaq(
    customProductId: string,
    userId: string,
    dto: {
      sort_order?: number;
      translations: { locale: string; question: string; answer: string }[];
    },
  ) {
    await this.assertCreatorOwns(customProductId, userId);
    return this.prisma.customProductFaq.create({
      data: {
        custom_product_id: customProductId,
        sort_order: dto.sort_order ?? 0,
        translations: { create: dto.translations.map(sanitizeAnswer) },
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

  async updateFaq(
    faqId: string,
    userId: string,
    dto: {
      sort_order?: number;
      translations?: { locale: string; question: string; answer: string }[];
    },
  ) {
    const faq = await this.prisma.customProductFaq.findUnique({
      where: { id: faqId },
    });
    if (!faq)
      throw new NotFoundException({
        code: 'CUSTOM_PRODUCT_FAQ_NOT_FOUND',
        message: 'FAQ not found',
      });
    await this.assertCreatorOwns(faq.custom_product_id, userId);

    if (dto.translations && dto.translations.length > 0) {
      await this.prisma.customProductFaqTranslation.deleteMany({
        where: { faq_id: faqId },
      });
    }

    return this.prisma.customProductFaq.update({
      where: { id: faqId },
      data: {
        ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }),
        ...(dto.translations &&
          dto.translations.length > 0 && {
            translations: { create: dto.translations.map(sanitizeAnswer) },
          }),
      },
      include: { translations: true },
    });
  }

  async deleteFaq(faqId: string, userId: string) {
    const faq = await this.prisma.customProductFaq.findUnique({
      where: { id: faqId },
    });
    if (!faq)
      throw new NotFoundException({
        code: 'CUSTOM_PRODUCT_FAQ_NOT_FOUND',
        message: 'FAQ not found',
      });
    await this.assertCreatorOwns(faq.custom_product_id, userId);
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
          throw new BadRequestException({
            code: 'CUSTOM_PRODUCT_FINAL_PRICE_REQUIRED',
            message: 'final_price is required when pricing_type is SINGLE',
          });
        }
        break;
      case PricingType.MARGIN:
        if (data.margin_amount === undefined || data.margin_amount === null) {
          throw new BadRequestException({
            code: 'CUSTOM_PRODUCT_MARGIN_AMOUNT_REQUIRED',
            message: 'margin_amount is required when pricing_type is MARGIN',
          });
        }
        break;
      case PricingType.PER_VARIANT:
        if (data.selected_variants) {
          const missing = data.selected_variants.filter(
            (sv) => sv.custom_price === undefined || sv.custom_price === null,
          );
          if (missing.length > 0) {
            throw new BadRequestException({
              code: 'CUSTOM_PRODUCT_VARIANT_PRICE_REQUIRED',
              message:
                'custom_price is required for each variant when pricing_type is PER_VARIANT',
            });
          }
        }
        break;
    }
  }
}
