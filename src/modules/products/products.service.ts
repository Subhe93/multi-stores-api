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
  ProductVideoInputDto,
  ProductStoryInputDto,
} from './dto/product.dto';
import { parseExternalVideoUrl } from './product-video-url';
import {
  VIDEO_CONTENT_TYPE,
  VIDEO_POSTER_FOLDER,
  videoUploadConfig,
} from '../uploads/video-upload.config';
import {
  PRODUCT_VIDEOS_INCLUDE,
  toProductVideosOut,
} from './product-video.mapper';
import {
  PRODUCT_STORIES_INCLUDE,
  toProductStoriesOut,
} from './product-story.mapper';
import {
  PRODUCT_VIDEO_FILE_URL,
  PRODUCT_VIDEO_POSTER_URL,
  normalizeStoryInputs,
  storyError,
  storyUnchanged,
  type PreparedProductStory,
} from './product-stories';
import {
  UserRole,
  ProductStatus,
  ProductType,
  Prisma,
  CreatorCategoryVisibility,
} from '@prisma/client';
import { BundlesService } from '../bundles/bundles.service';
import {
  NO_COLLECTION,
  noCollectionWhere,
  single,
  clampLimit,
  collectionWhere,
  orderByFor,
  parseSort,
  parseStock,
  searchWhere,
  sortByTitle,
  stockWhere,
} from './owner-list';
import {
  validateBundleEconomics,
  formatViolationsMessage,
  type ProductForBundleCheck,
} from '../bundles/bundle-economics.util';
import { BundleOfferLike } from '../bundles/bundle-pricing.util';
import { TaxManagementService } from '../taxes/tax-management.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { RedirectsService } from '../redirects/redirects.service';
import { encodeSlugForUrl } from '@multi-stores/core/slug';
import { productSlugOwner } from '../../common/slug/wp-slug';
import {
  productRedirectMoves,
  productSlugContext,
  releaseLiveProductPaths,
  resolveProductTranslationSlugs,
} from '../../common/slug/product-slugs';
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
import {
  CreatorCategoryLinks,
  resolvePrimaryCreatorCategory,
} from '../creator-categories/primary-collection';
import { nextCollectionSortOrders } from '../creator-categories/product-order';

/** Business limit of videos per product (files and links together, D2). */
export const PRODUCT_VIDEO_MAX_PER_PRODUCT = 3;

/** A validated, normalised video of a product save (see prepareVideos). */
export interface PreparedProductVideo {
  id?: string;
  kind: 'FILE' | 'YOUTUBE' | 'VIMEO';
  url: string;
  poster_url: string | null;
  alt_text: string | null;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  position: number;
  sort_order: number;
}

function videoError(code: string, message: string, extra = {}): never {
  throw new BadRequestException({ code, message, ...extra });
}

/**
 * Stateless checks of a `videos` save payload (contract 3.2 steps 1, 3, 4):
 * the per-product limit, the YouTube/Vimeo whitelist (stored as the
 * canonical watch URL) and the poster shape. File URLs are shape-checked
 * here; their ownership needs the database (prepareVideos).
 */
export function normalizeVideoInputs(
  videos: ProductVideoInputDto[],
): PreparedProductVideo[] {
  if (videos.length > PRODUCT_VIDEO_MAX_PER_PRODUCT) {
    videoError(
      'VIDEO_LIMIT_EXCEEDED',
      `A product can have at most ${PRODUCT_VIDEO_MAX_PER_PRODUCT} videos.`,
      { max: PRODUCT_VIDEO_MAX_PER_PRODUCT },
    );
  }
  return videos.map((v, i) => {
    let kind: PreparedProductVideo['kind'];
    let url = String(v.url ?? '').trim();
    if (v.kind === 'file') {
      kind = 'FILE';
      if (!PRODUCT_VIDEO_FILE_URL.test(url)) {
        videoError(
          'VIDEO_FILE_INVALID',
          'The video file is not a valid upload.',
        );
      }
    } else {
      const parsed = parseExternalVideoUrl(url);
      if (!parsed || parsed.kind !== v.kind) {
        videoError(
          'VIDEO_URL_NOT_ALLOWED',
          'Only YouTube and Vimeo video links are allowed.',
        );
      }
      kind = parsed.kind === 'youtube' ? 'YOUTUBE' : 'VIMEO';
      url = parsed.canonicalUrl;
    }
    const poster = typeof v.poster_url === 'string' ? v.poster_url.trim() : '';
    if (
      poster &&
      (!PRODUCT_VIDEO_POSTER_URL.test(poster) || poster.includes('..'))
    ) {
      videoError(
        'VIDEO_POSTER_INVALID',
        'The video poster is not a valid image.',
      );
    }
    const alt = typeof v.alt === 'string' ? v.alt.trim() : '';
    // An uploaded file was probed at upload time (<= max seconds); the
    // client-sent duration reaches the duration chip and JSON-LD, so it is
    // capped at the limit (+1 s for rounding).
    const duration =
      v.duration_s == null
        ? null
        : kind === 'FILE'
          ? Math.min(v.duration_s, videoUploadConfig().maxSeconds + 1)
          : v.duration_s;
    return {
      ...(v.id ? { id: v.id } : {}),
      kind,
      url,
      poster_url: poster || null,
      alt_text: alt || null,
      duration_s: duration,
      width: v.width ?? null,
      height: v.height ?? null,
      position: v.position,
      sort_order: i,
    };
  });
}

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
  images: {
    take: 1,
    orderBy: [{ is_featured: 'desc' as const }, { sort_order: 'asc' as const }],
  },
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
        match_tag_ids?: unknown;
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
        // Tags rename: owner-API alias of match_tags, never public.
        match_tag_ids: _tagIds,
        ...pub
      } = cc;
      void _cref;
      void _owner;
      void _rule;
      void _tags;
      void _tagIds;
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

/** Stored story fields syncStories compares with the payload (storyUnchanged). */
const STORED_STORY_SELECT = {
  id: true,
  kind: true,
  url: true,
  poster_url: true,
  duration_s: true,
  width: true,
  height: true,
  name: true,
  rating: true,
  verified: true,
  sort_order: true,
  translations: { select: { locale: true, quote: true, subtitle: true } },
} as const satisfies Prisma.ProductStorySelect;

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
    // Old-slug 301s (WP `_wp_old_slug`); optional for positional tests.
    @Optional() private readonly redirects?: RedirectsService,
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

  // Refresh the creator's storefront cache after a product mutation.
  private async revalidateForCreator(creatorId?: string | null): Promise<void> {
    if (creatorId) {
      await this.revalidation.revalidateStoreByCreatorId(creatorId);
    }
  }

  /**
   * Refresh the stores that show a product: the creator's own store, or, for
   * a provider product, every store reselling it (CustomProduct base), so a
   * provider's video / image change (decision D5) reaches them at once.
   */
  private async revalidateForProduct(product: {
    id: string;
    creator_id: string | null;
    provider_id: string | null;
  }): Promise<void> {
    if (product.creator_id) {
      await this.revalidateForCreator(product.creator_id);
    } else if (product.provider_id) {
      await this.revalidation.revalidateStoresByBaseProductId(product.id);
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
    videos: PRODUCT_VIDEOS_INCLUDE,
    stories: PRODUCT_STORIES_INCLUDE,
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
   * Replace a creator product's collection links with `categoryIds`.
   * Silently skips any collection id that doesn't belong to this creator
   * (defense-in-depth — DTO can't enforce ownership). Links that stay keep
   * their row (and so their `sort_order` = position in the collection, M6);
   * only the removed ones are deleted and the new ones created.
   * Returns the linked ids in the order they were sent, with the INTERNAL
   * ones listed separately (M6.3: labels are linkable, never the primary).
   */
  private async syncCreatorCategories(
    productId: string,
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
    await this.prisma.productCreatorCategory.deleteMany({
      where: { product_id: productId, creator_category_id: { notIn: linked } },
    });
    if (linked.length) {
      // A new link goes to the end of its collection's manual order; links
      // that already exist are skipped and keep their sort_order.
      const next = await nextCollectionSortOrders(this.prisma, linked);
      await this.prisma.productCreatorCategory.createMany({
        data: linked.map((creator_category_id) => ({
          product_id: productId,
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
   * M6: store the primary collection of a creator product. `links` is the
   * current link list (request order when it was just replaced, stored
   * order otherwise); the rules live in resolvePrimaryCreatorCategory.
   */
  private async applyPrimaryCreatorCategory(
    productId: string,
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
      await this.prisma.product.update({
        where: { id: productId },
        data: { primary_creator_category_id: primary },
      });
    }
  }

  /** Stored links of a product, by position in the collection then id. */
  private async linkedCreatorCategoryIds(
    productId: string,
  ): Promise<CreatorCategoryLinks> {
    const rows = await this.prisma.productCreatorCategory.findMany({
      where: { product_id: productId },
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
   *
   * Videos (already validated by prepareVideos) are synced next in the same
   * transaction, and only when the payload carried `videos`; stories
   * (prepareStories) follow, only when the payload carried `stories`.
   */
  private async syncVariantsAndImages(
    productId: string,
    variants?: ProductVariantSyncDto[],
    images?: ProductImageSyncDto[],
    videos?: PreparedProductVideo[],
    stories?: PreparedProductStory[],
  ) {
    if (
      variants === undefined &&
      images === undefined &&
      videos === undefined &&
      stories === undefined
    )
      return;

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

      if (videos !== undefined) {
        await this.syncVideos(tx, productId, videos);
      } else if (images !== undefined && images.length === 0) {
        // An images-only save (older dashboard tab, importer) that removes
        // every product-level image must not strand stored videos (D6).
        await this.assertVideosKeepAnImage(tx, productId, 0);
      }

      if (stories !== undefined) {
        await this.syncStories(tx, productId, stories);
      }
    });
  }

  /**
   * Throws VIDEO_REQUIRES_IMAGE when the product has videos and would be
   * left with no product-level image: `imagesAfter` when known, otherwise
   * the stored count minus `removing`.
   */
  private async assertVideosKeepAnImage(
    db: Prisma.TransactionClient | PrismaService,
    productId: string,
    removing: number,
    imagesAfter?: number,
  ): Promise<void> {
    const videoCount = await db.productVideo.count({
      where: { product_id: productId },
    });
    if (videoCount === 0) return;
    const remaining =
      imagesAfter ??
      (await db.productImage.count({
        where: { product_id: productId, variant_id: null },
      })) - removing;
    if (remaining <= 0) {
      videoError(
        'VIDEO_REQUIRES_IMAGE',
        'A product with videos needs at least one product image. Remove the videos first.',
      );
    }
  }

  /**
   * Validates a `videos` save payload before anything is written (contract
   * 3.2). `undefined` = untouched. Throws the coded 400s:
   * VIDEO_LIMIT_EXCEEDED, VIDEO_FILE_INVALID (a file that is neither on this
   * product, nor uploaded by the actor / the product's store, unless ADMIN),
   * VIDEO_UPLOAD_EXPIRED (the upload row is gone: swept after 24 h unsaved),
   * VIDEO_URL_NOT_ALLOWED, VIDEO_POSTER_INVALID (bad shape, or an image that
   * is not the actor's / the store's, unless ADMIN) and VIDEO_REQUIRES_IMAGE
   * (videos on a product that will have no product-level image).
   * `productImageCount` = the product-level image count after this save.
   */
  private async prepareVideos(
    product: { id: string | null; creator_id: string | null },
    videos: ProductVideoInputDto[] | undefined,
    actor: { userId: string; role: UserRole },
    productImageCount: () => Promise<number> | number,
  ): Promise<PreparedProductVideo[] | undefined> {
    if (videos === undefined) return undefined;
    const prepared = normalizeVideoInputs(videos);
    if (!prepared.length) return prepared;

    const files = prepared.filter((v) => v.kind === 'FILE').map((v) => v.url);
    const posters = [
      ...new Set(
        prepared.map((v) => v.poster_url).filter((u): u is string => !!u),
      ),
    ];
    const onProduct = product.id
      ? await this.prisma.productVideo.findMany({
          where: { product_id: product.id },
          select: { url: true, poster_url: true },
        })
      : [];
    const knownFiles = new Set(onProduct.map((r) => r.url));
    const knownPosters = new Set(
      onProduct.map((r) => r.poster_url).filter((u): u is string => !!u),
    );
    const newFiles = files.filter((u) => !knownFiles.has(u));
    const newPosters = posters.filter((u) => !knownPosters.has(u));
    const isAdmin = actor.role === UserRole.ADMIN;

    if (newFiles.length || (newPosters.length && !isAdmin)) {
      const storeId = product.creator_id
        ? (
            await this.prisma.store.findUnique({
              where: { creator_id: product.creator_id },
              select: { id: true },
            })
          )?.id
        : undefined;
      const rows = await this.prisma.uploadedFile.findMany({
        where: { key: { in: [...newFiles, ...newPosters] } },
        select: {
          key: true,
          user_id: true,
          store_id: true,
          content_type: true,
        },
      });
      const byKey = new Map(rows.map((r) => [r.key, r]));
      const ownedBy = (r: {
        user_id: string | null;
        store_id: string | null;
      }) =>
        isAdmin ||
        r.user_id === actor.userId ||
        (!!storeId && r.store_id === storeId);

      for (const url of newFiles) {
        const row = byKey.get(url);
        if (!row) {
          // The upload row is gone: the orphan sweep removed a file that
          // stayed unsaved in an open editor for more than 24 h.
          videoError(
            'VIDEO_UPLOAD_EXPIRED',
            'This video upload has expired. Remove it and upload it again.',
          );
        }
        if (row.content_type !== VIDEO_CONTENT_TYPE || !ownedBy(row)) {
          videoError(
            'VIDEO_FILE_INVALID',
            'The video file was not uploaded by you.',
          );
        }
      }

      // A poster is one of the actor's / the product store's own uploads
      // (or already on this product, or one of its images); another
      // store's image would become undeletable for its owner.
      if (newPosters.length && !isAdmin) {
        const productImages = product.id
          ? await this.prisma.productImage.findMany({
              where: { product_id: product.id, url: { in: newPosters } },
              select: { url: true },
            })
          : [];
        const ownImages = new Set(productImages.map((r) => r.url));
        for (const url of newPosters) {
          if (ownImages.has(url)) continue;
          const row = byKey.get(url);
          if (!row && url.startsWith(`/uploads/${VIDEO_POSTER_FOLDER}/`)) {
            videoError(
              'VIDEO_UPLOAD_EXPIRED',
              'This video cover image has expired. Choose a new cover image.',
            );
          }
          if (!row || !ownedBy(row)) {
            videoError(
              'VIDEO_POSTER_INVALID',
              'The video poster is not one of your images.',
            );
          }
        }
      }
    }

    if ((await productImageCount()) === 0) {
      videoError(
        'VIDEO_REQUIRES_IMAGE',
        'Add at least one product image before adding a video.',
      );
    }
    return prepared;
  }

  /**
   * Writes the prepared videos of a product inside the save transaction:
   * rows not in the payload are deleted, rows whose id belongs to this
   * product are updated (id and created_at survive), the rest are created.
   * Files are never deleted here; the upload sweep removes orphans.
   */
  private async syncVideos(
    tx: Prisma.TransactionClient,
    productId: string,
    videos: PreparedProductVideo[],
  ) {
    if (videos.length) {
      // Re-checked after the image sync of the same transaction (D6).
      const images = await tx.productImage.count({
        where: { product_id: productId, variant_id: null },
      });
      if (images === 0) {
        videoError(
          'VIDEO_REQUIRES_IMAGE',
          'Add at least one product image before adding a video.',
        );
      }
    }
    const existing = await tx.productVideo.findMany({
      where: { product_id: productId },
      select: { id: true, url: true, poster_url: true },
    });
    const existingIds = new Set(existing.map((r) => r.id));

    // Lock the upload rows of every referenced file and poster until the
    // commit: the orphan sweep claims rows FOR UPDATE SKIP LOCKED, so it
    // skips them now, and a row it already deleted shows up as missing here.
    const keys = [
      ...new Set(
        videos
          .flatMap((v) => [v.kind === 'FILE' ? v.url : null, v.poster_url])
          .filter((k): k is string => !!k),
      ),
    ];
    if (keys.length) {
      const locked = await tx.$queryRaw<{ key: string }[]>`
        SELECT uf."key" AS key FROM "UploadedFile" uf
        WHERE uf."key" IN (${Prisma.join(keys)})
        FOR SHARE`;
      const present = new Set(locked.map((r) => r.key));
      const known = new Set(
        existing
          .flatMap((r) => [r.url, r.poster_url])
          .filter((k): k is string => !!k),
      );
      const gone = keys.filter(
        (k) =>
          !present.has(k) &&
          !known.has(k) &&
          (videos.some((v) => v.kind === 'FILE' && v.url === k) ||
            k.startsWith(`/uploads/${VIDEO_POSTER_FOLDER}/`)),
      );
      if (gone.length) {
        videoError(
          'VIDEO_UPLOAD_EXPIRED',
          'This video upload has expired. Remove it and upload it again.',
        );
      }
    }
    const keep = new Set(
      videos
        .map((v) => v.id)
        .filter((id): id is string => !!id && existingIds.has(id)),
    );
    await tx.productVideo.deleteMany({
      where: { product_id: productId, id: { notIn: [...keep] } },
    });
    const updated = new Set<string>();
    for (const v of videos) {
      const { id, ...data } = v;
      if (id && keep.has(id) && !updated.has(id)) {
        updated.add(id);
        await tx.productVideo.update({ where: { id }, data });
      } else {
        await tx.productVideo.create({
          data: { ...data, product_id: productId },
        });
      }
    }
  }

  /**
   * Validates a `stories` save payload before anything is written
   * (customer-stories contract 3.2). `undefined` = untouched. Throws the
   * coded 400s of normalizeStoryInputs plus STORY_UPLOAD_EXPIRED,
   * STORY_FILE_INVALID and STORY_IMAGE_INVALID for uploads that are gone or
   * not the actor's / the product store's (ADMIN skips ownership, but a
   * video file must still be an MP4 upload).
   */
  private async prepareStories(
    product: { id: string | null; creator_id: string | null },
    stories: ProductStoryInputDto[] | undefined,
    actor: { userId: string; role: UserRole },
  ): Promise<PreparedProductStory[] | undefined> {
    if (stories === undefined) return undefined;
    const prepared = normalizeStoryInputs(stories);
    if (!prepared.length) return prepared;

    // Media already on this product (its stories or its images) was checked
    // when it was first saved.
    const [onStories, onImages] = product.id
      ? await Promise.all([
          this.prisma.productStory.findMany({
            where: { product_id: product.id },
            select: { url: true, poster_url: true },
          }),
          this.prisma.productImage.findMany({
            where: { product_id: product.id },
            select: { url: true },
          }),
        ])
      : [[], []];
    const known = new Set<string>([
      ...onStories.flatMap((r) =>
        r.poster_url ? [r.url, r.poster_url] : [r.url],
      ),
      ...onImages.map((r) => r.url),
    ]);

    // Every new upload key with the index of the first story that uses it.
    type Use = { index: number; role: 'file' | 'image' };
    const uses = new Map<string, Use>();
    prepared.forEach((st, index) => {
      const add = (key: string | null, role: Use['role']) => {
        if (!key || known.has(key) || uses.has(key)) return;
        uses.set(key, { index, role });
      };
      if (st.kind === 'FILE') add(st.url, 'file');
      if (st.kind === 'IMAGE') add(st.url, 'image');
      add(st.poster_url, 'image');
    });
    const isAdmin = actor.role === UserRole.ADMIN;
    const toCheck = [...uses.entries()].filter(
      ([, u]) => u.role === 'file' || !isAdmin,
    );
    if (!toCheck.length) return prepared;

    const storeId = product.creator_id
      ? (
          await this.prisma.store.findUnique({
            where: { creator_id: product.creator_id },
            select: { id: true },
          })
        )?.id
      : undefined;
    const rows = await this.prisma.uploadedFile.findMany({
      where: { key: { in: toCheck.map(([k]) => k) } },
      select: { key: true, user_id: true, store_id: true, content_type: true },
    });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const ownedBy = (r: { user_id: string | null; store_id: string | null }) =>
      isAdmin ||
      r.user_id === actor.userId ||
      (!!storeId && r.store_id === storeId);

    for (const [key, { index, role }] of toCheck) {
      const row = byKey.get(key);
      if (role === 'file') {
        if (!row) {
          // The orphan sweep removed a file that stayed unsaved for > 24 h.
          storyError(
            'STORY_UPLOAD_EXPIRED',
            'This story video has expired. Remove it and upload it again.',
            { index },
          );
        }
        if (row.content_type !== VIDEO_CONTENT_TYPE || !ownedBy(row)) {
          storyError(
            'STORY_FILE_INVALID',
            'The story video was not uploaded by you.',
            { index },
          );
        }
        continue;
      }
      if (!row && key.startsWith(`/uploads/${VIDEO_POSTER_FOLDER}/`)) {
        storyError(
          'STORY_UPLOAD_EXPIRED',
          'This story cover image has expired. Choose a new cover image.',
          { index },
        );
      }
      // Another store's image would become undeletable for its owner.
      if (!row || !ownedBy(row)) {
        storyError(
          'STORY_IMAGE_INVALID',
          'The story image is not one of your images.',
          { index },
        );
      }
    }
    return prepared;
  }

  /**
   * Writes the prepared stories of a product inside the save transaction:
   * rows not in the payload are deleted (translations cascade), rows whose
   * id belongs to this product are updated with their translations replaced,
   * the rest are created. Files are never deleted here; the upload sweep
   * removes unreferenced videos and posters.
   */
  private async syncStories(
    tx: Prisma.TransactionClient,
    productId: string,
    stories: PreparedProductStory[],
  ) {
    const existing = await tx.productStory.findMany({
      where: { product_id: productId },
      select: STORED_STORY_SELECT,
    });
    const existingIds = new Set(existing.map((r) => r.id));
    const existingById = new Map(existing.map((r) => [r.id, r]));

    // Lock the upload rows of every referenced video file and poster until
    // the commit: the orphan sweep claims rows FOR UPDATE SKIP LOCKED, so it
    // skips them now, and a row it already deleted shows up as missing here.
    const keysOf = (st: PreparedProductStory) =>
      [st.kind === 'FILE' ? st.url : null, st.poster_url].filter(
        (k): k is string => !!k,
      );
    const keys = [...new Set(stories.flatMap(keysOf))];
    if (keys.length) {
      const locked = await tx.$queryRaw<{ key: string }[]>`
        SELECT uf."key" AS key FROM "UploadedFile" uf
        WHERE uf."key" IN (${Prisma.join(keys)})
        FOR SHARE`;
      const present = new Set(locked.map((r) => r.key));
      const known = new Set(
        existing
          .flatMap((r) => [r.url, r.poster_url])
          .filter((k): k is string => !!k),
      );
      // Only video files and video posters are swept; other images (e.g. a
      // product image used as poster) may have no upload row at all.
      const index = stories.findIndex((st) =>
        keysOf(st).some(
          (k) =>
            !present.has(k) &&
            !known.has(k) &&
            ((st.kind === 'FILE' && st.url === k) ||
              k.startsWith(`/uploads/${VIDEO_POSTER_FOLDER}/`)),
        ),
      );
      if (index >= 0) {
        storyError(
          'STORY_UPLOAD_EXPIRED',
          'This story video has expired. Remove it and upload it again.',
          { index },
        );
      }
    }

    const keep = new Set(
      stories
        .map((st) => st.id)
        .filter((id): id is string => !!id && existingIds.has(id)),
    );
    await tx.productStory.deleteMany({
      where: { product_id: productId, id: { notIn: [...keep] } },
    });
    const updated = new Set<string>();
    for (const st of stories) {
      const { id, translations, ...data } = st;
      if (id && keep.has(id) && !updated.has(id)) {
        updated.add(id);
        // Unchanged row and texts: no writes (keeps updated_at, and a resave
        // of 30 stories costs no extra queries in the save transaction).
        const stored = existingById.get(id);
        if (stored && storyUnchanged(stored, st)) continue;
        await tx.productStory.update({ where: { id }, data });
        await tx.productStoryTranslation.deleteMany({
          where: { story_id: id },
        });
        if (translations.length) {
          await tx.productStoryTranslation.createMany({
            data: translations.map((t) => ({ ...t, story_id: id })),
          });
        }
      } else {
        await tx.productStory.create({
          data: {
            ...data,
            product_id: productId,
            translations: { create: translations },
          },
        });
      }
    }
  }

  async create(userId: string, userRole: UserRole, dto: CreateProductDto) {
    const {
      translations,
      attributes,
      // Deprecated legacy ProductTag input: accepted, ignored (tags rename).
      tags: _legacyTags,
      bundle_ids,
      creator_category_ids,
      primary_creator_category_id,
      variants,
      images,
      videos,
      stories,
      ...data
    } = dto;
    void _legacyTags;

    const productData: Prisma.ProductUncheckedCreateInput = {
      ...data,
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

    // WP slugs: sanitized with the store's content locale, unique in the
    // creator's /products/<slug> domain.
    const slugCtx = await productSlugContext(
      this.prisma,
      productData.creator_id,
    );
    const slugged = await resolveProductTranslationSlugs(
      this.prisma,
      translations,
      { owner: productSlugOwner(productData), locale: slugCtx.locale },
    );
    productData.translations = {
      create: slugged.map(sanitizeTranslationHtml),
    };

    // M6: a requested primary that is not among the sent links fails before
    // anything is written (the ownership-filtered check runs again after the
    // links are created, so this only avoids an orphan product row).
    if (userRole === UserRole.CREATOR) {
      resolvePrimaryCreatorCategory({
        requested: primary_creator_category_id,
        linked: creator_category_ids ?? [],
        // M6.3: only read when a primary is requested (the check needs it).
        internal:
          primary_creator_category_id && productData.creator_id
            ? await this.internalCreatorCategoryIds(
                creator_category_ids ?? [],
                productData.creator_id,
              )
            : [],
        current: null,
      });
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

    // Videos are validated before the product row exists, so a rejected
    // video never leaves a half-created product behind.
    const preparedVideos = await this.prepareVideos(
      { id: null, creator_id: productData.creator_id ?? null },
      videos,
      { userId, role: userRole },
      () => (images ?? []).length,
    );
    const preparedStories = await this.prepareStories(
      { id: null, creator_id: productData.creator_id ?? null },
      stories,
      { userId, role: userRole },
    );

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

    // Attach creator collections (creator-only — collections are creator-scoped)
    if (userRole === UserRole.CREATOR && productData.creator_id) {
      const links = creator_category_ids?.length
        ? await this.syncCreatorCategories(
            product.id,
            productData.creator_id,
            creator_category_ids,
          )
        : { linked: [], internal: [] };
      await this.applyPrimaryCreatorCategory(
        product.id,
        links,
        primary_creator_category_id,
        null,
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

    await this.syncVariantsAndImages(
      product.id,
      variants,
      images,
      preparedVideos,
      preparedStories,
    );

    await releaseLiveProductPaths(this.prisma, this.redirects, {
      productId: product.id,
    });
    await this.revalidateForCreator(productData.creator_id);

    return this.findById(product.id);
  }

  /** PlatformConfig.require_provider_approval (true when no row exists). */
  private async providerApprovalRequired(): Promise<boolean> {
    const cfg = await this.prisma.platformConfig.findFirst({
      select: { require_provider_approval: true },
    });
    return cfg?.require_provider_approval ?? true;
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
    // SPEC §4: while the platform requires provider approval, products of
    // unverified providers stay out of the creator catalog.
    if (await this.providerApprovalRequired()) {
      where.provider = { verified: true };
    }
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
          images: {
            take: 1,
            orderBy: [{ is_featured: 'desc' }, { sort_order: 'asc' }],
          },
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

  // Dashboard listing — only the authenticated provider's/creator's own
  // products, with search (title / SKU / slug), collection and stock
  // filters, sort orders and page sizes up to OWNER_LIST_MAX_LIMIT.
  async findMine(
    userId: string,
    userRole: UserRole,
    filters: {
      page?: number;
      limit?: number;
      category_id?: string;
      product_type?: string;
      status?: string;
      search?: string;
      is_featured?: boolean;
      collection?: string;
      stock?: string;
      sort?: string;
    },
  ) {
    let owner: Prisma.ProductWhereInput;
    let creatorId: string | null = null;
    if (userRole === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
      });
      if (!creator)
        throw new NotFoundException({
          code: 'PRODUCT_CREATOR_PROFILE_NOT_FOUND',
          message: 'Creator profile not found',
        });
      creatorId = creator.id;
      owner = { creator_id: creator.id };
    } else {
      const provider = await this.prisma.provider.findUnique({
        where: { user_id: userId },
      });
      if (!provider)
        throw new NotFoundException({
          code: 'PRODUCT_PROVIDER_PROFILE_NOT_FOUND',
          message: 'Provider profile not found',
        });
      owner = { provider_id: provider.id };
    }

    const page =
      filters.page && Number.isFinite(filters.page) && filters.page >= 1
        ? Math.floor(filters.page)
        : 1;
    const limit = clampLimit(filters.limit);
    const sort = parseSort(single(filters.sort));
    const empty = () =>
      this.withSlug({
        data: [] as Awaited<ReturnType<typeof this.ownerPage>>,
        meta: { total: 0, page, limit, totalPages: 0 },
      });

    // Repeated query params arrive as arrays; they are ignored.
    const rawStatus = single(filters.status);
    const status = (Object.values(ProductStatus) as string[]).includes(
      rawStatus ?? '',
    )
      ? (rawStatus as ProductStatus)
      : undefined;
    const and: Prisma.ProductWhereInput[] = [
      owner,
      this.listWhere({
        category_id: single(filters.category_id),
        product_type: single(filters.product_type),
        status,
        is_featured: filters.is_featured,
      }),
    ];
    const rawSearch = single(filters.search);
    const search = rawSearch ? searchWhere(rawSearch) : undefined;
    if (search) and.push(search);
    const stock = stockWhere(parseStock(single(filters.stock)));
    if (stock) and.push(stock);
    // Collections belong to creators; a provider's list ignores the filter.
    const collectionId = single(filters.collection);
    if (collectionId && creatorId) {
      if (collectionId === NO_COLLECTION) {
        // Tags rename: `match_tags` holds INTERNAL row ids (tags).
        const tagRules = await this.prisma.creatorCategory.findMany({
          where: { creator_id: creatorId, match_rule: 'TAGS' },
          select: { match_tags: true },
        });
        and.push(
          noCollectionWhere([
            ...new Set(tagRules.flatMap((c) => c.match_tags)),
          ]),
        );
      } else {
        const collection = await this.prisma.creatorCategory.findFirst({
          where: { id: collectionId, creator_id: creatorId },
          select: { id: true, match_rule: true, match_tags: true },
        });
        if (!collection) return empty();
        and.push(collectionWhere(collection));
      }
    }
    const where: Prisma.ProductWhereInput = { AND: and };

    const total = await this.prisma.product.count({ where });
    const skip = (page - 1) * limit;
    let data: Awaited<ReturnType<typeof this.ownerPage>>;
    if (sort === 'title_asc' || sort === 'title_desc') {
      const rows = await this.prisma.product.findMany({
        where,
        select: {
          id: true,
          translations: { select: { locale: true, title: true } },
        },
      });
      const ids = sortByTitle(
        rows,
        sort === 'title_asc' ? 'asc' : 'desc',
      ).slice(skip, skip + limit);
      const byId = new Map(
        (await this.ownerPage({ id: { in: ids } })).map((p) => [p.id, p]),
      );
      data = ids.flatMap((id) => byId.get(id) ?? []);
    } else {
      data = await this.ownerPage(where, orderByFor(sort), skip, limit);
    }

    return this.withSlug({
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  }

  /** One page of full owner rows (same shape as findAll). */
  private ownerPage(
    where: Prisma.ProductWhereInput,
    orderBy?: Prisma.ProductOrderByWithRelationInput[],
    skip?: number,
    take?: number,
  ) {
    return this.prisma.product.findMany({
      where,
      orderBy,
      skip,
      take,
      include: {
        translations: true,
        images: {
          take: 1,
          orderBy: [{ is_featured: 'desc' }, { sort_order: 'asc' }],
        },
        category: { include: { translations: true } },
        variants: true,
        provider: { select: { id: true, company_name: true } },
      },
    });
  }

  /**
   * M6: `/products/mine` rows carry a top-level `slug` (the menu editor's
   * product picker links to it): the first translation that has one.
   */
  private withSlug<
    T extends { data: Array<{ translations: Array<{ slug: string }> }> },
  >(page: T): T & { data: Array<T['data'][number] & { slug: string | null }> } {
    return {
      ...page,
      data: page.data.map((p) => ({
        ...p,
        slug: p.translations.find((t) => !!t.slug)?.slug ?? null,
      })),
    };
  }

  async findById(id: string, userId?: string, userRole?: UserRole) {
    const row = await this.prisma.product.findUnique({
      where: { id },
      include: this.productIncludes,
    });

    if (!row)
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });
    // The editor GET always carries `videos` (possibly []), so the dashboard
    // can tell a video-aware API from an older one.
    // `stories` likewise (customer-stories contract 2).
    const product = {
      ...row,
      videos: toProductVideosOut(row.videos),
      stories: toProductStoriesOut(row.stories),
    };

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
      // Deprecated legacy ProductTag input: accepted, ignored (tags rename).
      tags: _legacyTags,
      bundle_ids,
      creator_category_ids,
      primary_creator_category_id,
      variants,
      images,
      videos,
      stories,
      ...data
    } = dto;
    void _legacyTags;

    // Videos are validated before any write (coded 400s, nothing half-saved).
    const preparedVideos = await this.prepareVideos(
      product,
      videos,
      { userId, role: userRole },
      () =>
        images !== undefined
          ? images.length
          : this.prisma.productImage.count({
              where: { product_id: id, variant_id: null },
            }),
    );
    const preparedStories = await this.prepareStories(product, stories, {
      userId,
      role: userRole,
    });
    // An images-only save that clears the gallery must not strand stored
    // videos; checked before any write (re-checked in the transaction).
    if (videos === undefined && images !== undefined && images.length === 0) {
      await this.assertVideosKeepAnImage(this.prisma, id, 0, 0);
    }

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

    await this.syncVariantsAndImages(
      id,
      variants,
      images,
      preparedVideos,
      preparedStories,
    );

    // Replace creator-collection attachments (creator-owned products only);
    // kept links keep their sort_order. The primary is re-resolved whenever
    // the links or the requested primary change (M6).
    if (
      (creator_category_ids !== undefined ||
        primary_creator_category_id !== undefined) &&
      userRole === UserRole.CREATOR &&
      product.creator_id
    ) {
      const links =
        creator_category_ids !== undefined
          ? await this.syncCreatorCategories(
              id,
              product.creator_id,
              creator_category_ids,
            )
          : await this.linkedCreatorCategoryIds(id);
      await this.applyPrimaryCreatorCategory(
        id,
        links,
        primary_creator_category_id,
        product.primary_creator_category_id,
      );
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
      // WP slugs: an unchanged slug is kept as stored; the rest are
      // sanitized and made unique (the product itself excluded).
      // One read serves the slug rule and the X19 carry-over below.
      const storedSlugs = await this.prisma.productTranslation.findMany({
        where: { product_id: id },
        select: { locale: true, slug: true, short_description: true },
      });
      const slugCtx = await productSlugContext(this.prisma, product.creator_id);
      const slugged = await resolveProductTranslationSlugs(
        this.prisma,
        translations,
        {
          owner: productSlugOwner(product),
          locale: slugCtx.locale,
          stored: storedSlugs,
          exclude: { productId: id },
          id,
        },
      );
      // Translations are deleted and recreated, so fields the client did not
      // send must be carried over or they are wiped (M4.4 X19):
      // short_description `undefined` = keep the stored value of that locale.
      const rows = await this.withTranslationCarryOver(
        id,
        slugged,
        storedSlugs,
      );
      await this.prisma.productTranslation.deleteMany({
        where: { product_id: id },
      });
      await this.prisma.productTranslation.createMany({
        data: rows.map((t) => ({
          ...sanitizeTranslationHtml(t),
          product_id: id,
        })),
      });
      // Old-slug 301s for a published creator product.
      if (
        product.status === ProductStatus.PUBLISHED &&
        product.creator_id &&
        slugCtx.storeId &&
        this.redirects
      ) {
        const moves = await productRedirectMoves(this.prisma, {
          creatorId: product.creator_id,
          primaryLocale: slugCtx.locale,
          before: storedSlugs,
          after: slugged,
          exclude: { productId: id },
        });
        await this.redirects.applySlugChangeRedirects(slugCtx.storeId, moves);
      }
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

    await releaseLiveProductPaths(this.prisma, this.redirects, {
      productId: id,
    });
    await this.revalidateForProduct({ ...product, id });

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

    // Reselling stores of a provider product, read while their rows exist.
    const resellerSlugs =
      !product.creator_id && product.provider_id
        ? await this.revalidation.storeSlugsByBaseProductId(id)
        : [];

    const deleted = await this.prisma.product.delete({ where: { id } });

    await this.revalidateForCreator(product.creator_id);
    await this.revalidation.revalidateStoreSlugs(resellerSlugs);

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
    preRead?: { locale: string; short_description: string | null }[],
  ): Promise<ProductTranslationDto[]> {
    if (!translations.some((t) => t.short_description === undefined)) {
      return translations.map((t) => ({
        ...t,
        short_description: t.short_description || null,
      }));
    }
    const stored =
      preRead ??
      (await this.prisma.productTranslation.findMany({
        where: { product_id: productId },
        select: { locale: true, short_description: true },
      }));
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
   * as DRAFT, never featured, titles are suffixed with "(Copy)" and slugs get
   * the WP uniqueness suffix (`-2`, `-3`, ...) to stay distinct from the source. Unique fields like SKU are cleared or
   * suffixed to avoid conflicts. Variant→image links are remapped so a
   * cloned image points at its cloned variant.
   */
  async duplicate(id: string, userId: string, userRole: UserRole) {
    const source = await this.prisma.product.findUnique({
      where: { id },
      include: {
        translations: true,
        images: true,
        videos: true,
        attributes: true,
        variants: true,
        creator_categories: {
          select: { creator_category_id: true, sort_order: true },
        },
        custom_fields: {
          include: { translations: true },
          orderBy: [{ sort_order: 'asc' as const }, { id: 'asc' as const }],
        },
        faqs: { include: { translations: true } },
        stories: PRODUCT_STORIES_INCLUDE,
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

    const slugCtx = await productSlugContext(this.prisma, source.creator_id);
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
          // Tags rename: the primary collection is copied with the links.
          primary_creator_category_id: source.primary_creator_category_id,
          // Force safe defaults for the clone.
          status: ProductStatus.DRAFT,
          is_featured: false,
        },
      });

      // Translations — suffix the title; the slug gets the WP uniqueness
      // suffix (`<slug>-2`, `-3`, ...) in the creator's product domain.
      if (source.translations.length > 0) {
        const slugged = await resolveProductTranslationSlugs(
          tx,
          source.translations.map((t) => ({
            locale: t.locale,
            // The stored slug in WP's stable (encoded) form, so a decoded
            // `kläder` stays `kläder` before the suffix.
            slug: encodeSlugForUrl(t.slug),
            title: t.title,
          })),
          {
            owner: productSlugOwner(source),
            locale: slugCtx.locale,
            exclude: { productId: created.id },
            id: created.id,
          },
        );
        await tx.productTranslation.createMany({
          data: source.translations.map((t, i) => ({
            product_id: created.id,
            locale: t.locale,
            title: `${t.title} (Copy)`,
            description: t.description,
            slug: slugged[i].slug,
            meta_title: t.meta_title,
            meta_desc: t.meta_desc,
            // M4.4 X20: copied; external refs are never copied (the clone
            // is not the imported product).
            short_description: t.short_description,
          })),
        });
      }

      // Collections and tags (ProductCreatorCategory, every visibility) —
      // flat copy with the same sort_order. Legacy ProductTag rows are
      // retired and no longer copied.
      const links = source.creator_categories ?? [];
      if (links.length > 0) {
        await tx.productCreatorCategory.createMany({
          data: links.map((l) => ({
            product_id: created.id,
            creator_category_id: l.creator_category_id,
            sort_order: l.sort_order,
          })),
          skipDuplicates: true,
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

      // Videos: new rows pointing at the same files (the upload sweep
      // counts references, so a shared file is never removed).
      if (source.videos?.length) {
        await tx.productVideo.createMany({
          data: source.videos.map((v) => ({
            product_id: created.id,
            kind: v.kind,
            url: v.url,
            poster_url: v.poster_url,
            alt_text: v.alt_text,
            duration_s: v.duration_s,
            width: v.width,
            height: v.height,
            position: v.position,
            sort_order: v.sort_order,
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

      // Customer stories with their translations: new rows pointing at the
      // same media (the upload sweep counts references).
      for (const st of source.stories ?? []) {
        await tx.productStory.create({
          data: {
            product_id: created.id,
            kind: st.kind,
            url: st.url,
            poster_url: st.poster_url,
            duration_s: st.duration_s,
            width: st.width,
            height: st.height,
            name: st.name,
            rating: st.rating,
            verified: st.verified,
            sort_order: st.sort_order,
            translations: {
              create: st.translations.map((t) => ({
                locale: t.locale,
                quote: t.quote,
                subtitle: t.subtitle,
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

    const updated = await this.prisma.product.update({
      where: { id },
      data: { status },
    });
    await releaseLiveProductPaths(this.prisma, this.redirects, {
      productId: id,
    });
    return updated;
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
      select: { product_id: true, variant_id: true },
    });
    if (!image)
      throw new NotFoundException({
        code: 'PRODUCT_IMAGE_NOT_FOUND',
        message: 'Image not found',
      });
    await this.assertOwnsProductById(image.product_id, userId, userRole);
    // Decision D6: a product with videos keeps at least one product-level
    // image (the storefront drops videos with no image to sit after).
    if (image.variant_id === null) {
      await this.assertVideosKeepAnImage(this.prisma, image.product_id, 1);
    }
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
        // Decision D5: reselling stores show these; the creator sees them.
        videos: PRODUCT_VIDEOS_INCLUDE,
        // Customer stories are inherited the same way (S7).
        stories: PRODUCT_STORIES_INCLUDE,
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
          videos: toProductVideosOut(product.videos),
          stories: toProductStoriesOut(product.stories),
          shipping_profile: defaultProfile,
        });
      }
    }

    // The importing creator is not the owner: no cost price or importer refs.
    return redactProductForNonOwner({
      ...product,
      videos: toProductVideosOut(product.videos),
      stories: toProductStoriesOut(product.stories),
    });
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
