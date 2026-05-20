import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PricingType } from '@prisma/client';

@Injectable()
export class StorefrontService {
  constructor(private prisma: PrismaService) {}

  /**
   * Fetch ACTIVE bundles attached to either an own Product or a CustomProduct,
   * scoped to the given creator. Returns a unified shape suitable for storefront
   * rendering — translations and offers are included.
   */
  private async getBundlesForProduct(
    creatorId: string,
    opts: { productId?: string; customProductId?: string },
  ) {
    const where: any = {
      creator_id: creatorId,
      status: 'ACTIVE',
      OR: [] as any[],
    };
    if (opts.productId) {
      where.OR.push({ products: { some: { product_id: opts.productId } } });
    }
    if (opts.customProductId) {
      where.OR.push({
        custom_products: { some: { custom_product_id: opts.customProductId } },
      });
    }
    if (where.OR.length === 0) return [];

    return this.prisma.bundle.findMany({
      where,
      include: {
        translations: true,
        offers: {
          include: { translations: true },
          orderBy: { sort_order: 'asc' },
        },
      },
      orderBy: { updated_at: 'desc' },
    });
  }

  // Lightweight read so the storefront can decide caching without pulling the
  // full store payload. Defaults to enabled when the store isn't found.
  async getCacheConfig(slug: string): Promise<{ enabled: boolean }> {
    const store = await this.prisma.store.findUnique({
      where: { slug },
      select: { cache_enabled: true },
    });
    return { enabled: store?.cache_enabled ?? true };
  }

  async getStore(slug: string) {
    const store = await this.prisma.store.findUnique({
      where: { slug, is_active: true },
      include: {
        language_config: true,
        static_pages: {
          where: { status: 'PUBLISHED' },
          include: { translations: { select: { locale: true, title: true } } },
          orderBy: { sort_order: 'asc' },
        },
        creator: {
          select: { display_name: true, avatar_url: true, bio: true, cover_url: true },
        },
      },
    });
    if (!store) throw new NotFoundException('Store not found');
    const themeConfig = (store.theme_config as any) || {};
    const platformConfig = await this.prisma.platformConfig.findFirst();
    return {
      ...store,
      currency: platformConfig?.default_currency || 'EUR',
      pages: store.static_pages,
      // New theme system: storefront resolves the registry by theme_key and
      // merges theme_customizations on top.
      theme_key: (store as any).theme_key || 'minimal',
      theme_customizations: (store as any).theme_customizations || {},
      // Legacy theme object — retained until the storefront fully migrates to
      // the registry-based system. Reads from theme_config (the old freeform JSON).
      theme: {
        // Null when the creator hasn't set an explicit brand colour, so the
        // storefront can fall back to the active theme's tokens (driven by
        // theme_key) instead of a hard-coded blue that masks theme switches.
        primaryColor: themeConfig.primaryColor || null,
        secondaryColor: themeConfig.secondaryColor || null,
        fontFamily: themeConfig.fontFamily || undefined,
        typography: themeConfig.typography || {},
        header: themeConfig.header || {},
        templateId: themeConfig.templateId || 'default',
        socials: themeConfig.socials || {},
        contact: themeConfig.contact || {},
        seo: themeConfig.seo || {},
        translations: themeConfig.translations || {},
      },
    };
  }

  async getProducts(slug: string, filters: {
    page?: number;
    limit?: number;
    category_id?: string;
    creator_category?: string;
    search?: string;
    locale?: string;
  }) {
    const store = await this.prisma.store.findUnique({
      where: { slug },
      include: { creator: true },
    });
    if (!store) throw new NotFoundException('Store not found');

    // If a creator-category slug is requested, resolve it to an id + match rule
    // up front so we can apply the same filter to both own and custom queries.
    let creatorCategory: {
      id: string;
      match_rule: 'MANUAL' | 'TAGS';
      match_tags: string[];
    } | null = null;
    if (filters.creator_category) {
      const cc = await this.prisma.creatorCategory.findUnique({
        where: {
          creator_id_slug: {
            creator_id: store.creator.id,
            slug: filters.creator_category,
          },
        },
        select: { id: true, match_rule: true, match_tags: true, is_active: true },
      });
      if (cc && cc.is_active) {
        creatorCategory = {
          id: cc.id,
          match_rule: cc.match_rule as 'MANUAL' | 'TAGS',
          match_tags: cc.match_tags,
        };
      } else {
        // Unknown or inactive collection — return nothing.
        return [];
      }
    }

    // Creator's own products (creator_id set on Product)
    const ownWhere: any = {
      creator_id: store.creator.id,
      status: 'PUBLISHED',
    };
    if (filters.category_id) ownWhere.category_id = filters.category_id;
    if (filters.search) {
      ownWhere.translations = {
        some: { title: { contains: filters.search, mode: 'insensitive' } },
      };
    }
    if (creatorCategory) {
      if (creatorCategory.match_rule === 'TAGS') {
        if (!creatorCategory.match_tags.length) return [];
        ownWhere.tags = {
          some: { tag: { in: creatorCategory.match_tags } },
        };
      } else {
        ownWhere.creator_categories = {
          some: { creator_category_id: creatorCategory.id },
        };
      }
    }

    // Custom products (creator took a provider product and added their design)
    const customWhere: any = {
      creator_id: store.creator.id,
      status: 'PUBLISHED',
    };
    if (filters.category_id) {
      customWhere.product = { category_id: filters.category_id };
    }
    if (filters.search) {
      customWhere.translations = {
        some: { title: { contains: filters.search, mode: 'insensitive' } },
      };
    }
    if (creatorCategory) {
      if (creatorCategory.match_rule === 'TAGS') {
        // Tag membership lives on the underlying provider Product.
        customWhere.product = {
          ...(customWhere.product || {}),
          tags: { some: { tag: { in: creatorCategory.match_tags } } },
        };
      } else {
        // Manual collections link the CustomProduct directly via
        // CustomProductCreatorCategory — not the underlying base Product.
        customWhere.creator_categories = {
          some: { creator_category_id: creatorCategory.id },
        };
      }
    }

    const [ownProducts, customProducts] = await Promise.all([
      this.prisma.product.findMany({
        where: ownWhere,
        include: {
          translations: true,
          images: { take: 1, orderBy: { sort_order: 'asc' } },
          variants: { where: { is_active: true } },
          category: { include: { translations: true } },
        },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.customProduct.findMany({
        where: customWhere,
        include: {
          translations: true,
          mockup_images: { take: 1, orderBy: { sort_order: 'asc' } },
          selected_variants: { include: { variant: true } },
          product: {
            include: {
              images: { take: 1, orderBy: { sort_order: 'asc' } },
              variants: { where: { is_active: true } },
              category: { include: { translations: true } },
            },
          },
        },
        orderBy: { created_at: 'desc' },
      }),
    ]);

    const mappedCustom = customProducts.map((cp) => {
      const variants = this.computeVariants(cp);
      const displayPrice = this.computeDisplayPrice(cp, variants);

      return {
        id: cp.id,
        base_price: displayPrice,
        status: cp.status,
        translations: cp.translations,
        images: cp.mockup_images.length > 0
          ? cp.mockup_images.map((img) => ({ url: img.url, alt_text: null, sort_order: img.sort_order }))
          : cp.product.images,
        variants,
        category: cp.product.category,
        pricing_type: cp.pricing_type,
        _type: 'custom_product' as const,
      };
    });

    // Normalize own products too (Decimal → Number)
    const mappedOwn = ownProducts.map((p: any) => ({
      ...p,
      base_price: Number(p.base_price),
      compare_at_price: p.compare_at_price ? Number(p.compare_at_price) : undefined,
      variants: (p.variants || []).map((v: any) => ({
        ...v,
        price: Number(p.base_price) + Number(v.price_adjustment || 0),
        compare_at_price: v.compare_at_price ? Number(v.compare_at_price) : undefined,
        stock: v.stock_quantity ?? 999,
      })),
    }));

    // Fetch all active creator promotions (non-coupon) for badge display
    const now = new Date();
    const allPromos = await this.prisma.promotion.findMany({
      where: {
        creator_id: store.creator.id,
        level: 'CREATOR_TO_CUSTOMER',
        status: 'ACTIVE',
        starts_at: { lte: now },
        type: { notIn: ['COUPON'] },
        OR: [{ expires_at: null }, { expires_at: { gte: now } }],
      },
      include: { translations: true },
    });

    // Attach matching promotions to each product
    const attachPromos = (productId: string) =>
      allPromos.filter((p) => {
        const conds = p.conditions as any;
        if (!conds?.product_ids?.length) return true;
        return conds.product_ids.includes(productId);
      }).map((p) => ({
        id: p.id,
        type: p.type,
        value: Number(p.value),
        translations: p.translations,
      }));

    const ownWithPromos = mappedOwn.map((p: any) => ({ ...p, promotions: attachPromos(p.id) }));
    const customWithPromos = mappedCustom.map((p) => ({ ...p, promotions: attachPromos(p.id) }));

    return [...ownWithPromos, ...customWithPromos];
  }

  /**
   * Fetch active CREATOR_TO_CUSTOMER promotions that target a specific product
   * or apply to all products (no product_ids in conditions).
   */
  private async getActivePromotionsForProduct(creatorId: string, productId: string) {
    const now = new Date();
    const promotions = await this.prisma.promotion.findMany({
      where: {
        creator_id: creatorId,
        level: 'CREATOR_TO_CUSTOMER',
        status: 'ACTIVE',
        starts_at: { lte: now },
        OR: [
          { expires_at: null },
          { expires_at: { gte: now } },
        ],
        // Exclude coupon-only promotions (require manual code entry)
        type: { notIn: ['COUPON'] },
      },
      include: { translations: true },
    });

    // Filter: only promotions with no product targeting OR targeting this product
    return promotions.filter((p) => {
      const conds = p.conditions as any;
      if (!conds?.product_ids?.length) return true; // applies to all
      return conds.product_ids.includes(productId);
    }).map((p) => ({
      id: p.id,
      type: p.type,
      value: Number(p.value),
      conditions: p.conditions,
      starts_at: p.starts_at,
      expires_at: p.expires_at,
      translations: p.translations,
    }));
  }

  async getProduct(slug: string, productSlug: string, locale?: string) {
    const store = await this.prisma.store.findUnique({
      where: { slug },
      include: { creator: true },
    });
    if (!store) throw new NotFoundException('Store not found');

    // Try creator's own product first. Order by updated_at so duplicate-slug
    // collisions resolve to the most recently edited product instead of an
    // implementation-defined row.
    const product = await this.prisma.product.findFirst({
      where: {
        creator_id: store.creator.id,
        status: 'PUBLISHED',
        translations: { some: { slug: productSlug } },
      },
      orderBy: { updated_at: 'desc' },
      include: {
        translations: true,
        images: { orderBy: { sort_order: 'asc' } },
        attributes: {
          include: { template: { include: { translations: true } } },
        },
        variants: { where: { is_active: true }, include: { images: true } },
        tags: true,
        category: { include: { translations: true } },
        creator_categories: {
          include: { creator_category: { include: { translations: true } } },
          orderBy: { sort_order: 'asc' },
        },
        custom_fields: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
        faqs: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
        shipping_profile: { include: { zones: true } },
      },
    });

    if (product) {
      const prodBasePrice = Number(product.base_price);

      // If no product-level shipping profile, fall back to provider's default
      let shippingProfile = (product as any).shipping_profile;
      if (!shippingProfile && product.provider_id) {
        const defaultProfile = await this.prisma.shippingProfile.findFirst({
          where: { provider_id: product.provider_id, is_default: true },
          include: { zones: true },
        });
        if (defaultProfile) shippingProfile = defaultProfile;
      }

      const promotions = await this.getActivePromotionsForProduct(store.creator.id, product.id);
      const bundles = await this.getBundlesForProduct(store.creator.id, {
        productId: product.id,
      });

      return {
        ...product,
        shipping_profile: shippingProfile,
        base_price: prodBasePrice,
        compare_at_price: product.compare_at_price ? Number(product.compare_at_price) : undefined,
        variants: (product.variants || []).map((v: any) => ({
          ...v,
          price: prodBasePrice + Number(v.price_adjustment || 0),
          compare_at_price: v.compare_at_price ? Number(v.compare_at_price) : undefined,
          stock: v.stock_quantity ?? 999,
        })),
        creator_categories: ((product as any).creator_categories || [])
          .map((pcc: any) => pcc.creator_category)
          .filter((cc: any) => cc && cc.is_active !== false),
        promotions,
        bundles,
      };
    }

    // Fall back to custom product. Same ordering rationale as above.
    const customProduct = await this.prisma.customProduct.findFirst({
      where: {
        creator_id: store.creator.id,
        status: 'PUBLISHED',
        translations: { some: { slug: productSlug } },
      },
      orderBy: { updated_at: 'desc' },
      include: {
        translations: true,
        mockup_images: { orderBy: { sort_order: 'asc' } },
        selected_variants: { include: { variant: { include: { images: true } } } },
        field_values: { include: { custom_field: { include: { translations: true } } } },
        faqs: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
        creator_categories: {
          include: { creator_category: { include: { translations: true } } },
          orderBy: { sort_order: 'asc' },
        },
        product: {
          include: {
            images: { orderBy: { sort_order: 'asc' } },
            attributes: { include: { template: { include: { translations: true } } } },
            variants: { where: { is_active: true }, include: { images: true } },
            tags: true,
            category: { include: { translations: true } },
            custom_fields: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
            faqs: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
            shipping_profile: { include: { zones: true } },
          },
        },
      },
    });

    if (!customProduct) throw new NotFoundException('Product not found');

    const variants = this.computeVariants(customProduct);
    const displayPrice = this.computeDisplayPrice(customProduct, variants);

    // Determine which custom fields the customer still needs to fill
    const prefilledFieldIds = new Set(
      customProduct.field_values.map((fv) => fv.custom_field_id),
    );
    const customerFields = customProduct.product.custom_fields.filter(
      (cf) => !prefilledFieldIds.has(cf.id),
    );

    const baseProduct = customProduct.product;

    // Resolve shipping profile (fallback to provider default)
    let shippingProfile = (baseProduct as any).shipping_profile;
    if (!shippingProfile && baseProduct.provider_id) {
      const defaultProfile = await this.prisma.shippingProfile.findFirst({
        where: { provider_id: baseProduct.provider_id, is_default: true },
        include: { zones: true },
      });
      if (defaultProfile) shippingProfile = defaultProfile;
    }

    const promotions = await this.getActivePromotionsForProduct(store.creator.id, customProduct.id);
    const bundles = await this.getBundlesForProduct(store.creator.id, {
      customProductId: customProduct.id,
    });

    return {
      id: customProduct.id,
      base_price: displayPrice,
      compare_at_price: baseProduct.compare_at_price ? Number(baseProduct.compare_at_price) : undefined,
      status: customProduct.status,
      product_type: baseProduct.product_type,
      customization_type: baseProduct.customization_type,
      variant_option_config: baseProduct.variant_option_config,
      translations: customProduct.translations,
      images: customProduct.mockup_images.length > 0
        ? customProduct.mockup_images.map((img) => ({ url: img.url, alt_text: null, sort_order: img.sort_order }))
        : baseProduct.images,
      attributes: baseProduct.attributes,
      variants,
      tags: baseProduct.tags,
      category: baseProduct.category,
      creator_categories: ((customProduct as any).creator_categories || [])
        .map((cpcc: any) => cpcc.creator_category)
        .filter((cc: any) => cc && cc.is_active !== false),
      custom_fields: customerFields,
      faqs: [...(customProduct.faqs || []), ...baseProduct.faqs],
      field_values: customProduct.field_values,
      pricing_type: customProduct.pricing_type,
      shipping_profile: shippingProfile,
      promotions,
      bundles,
      _type: 'custom_product' as const,
    };
  }

  async getCategories(slug: string) {
    const store = await this.prisma.store.findUnique({
      where: { slug },
      include: { creator: true },
    });
    if (!store) throw new NotFoundException('Store not found');

    // Categories that have published own products or published custom products for this creator
    const [ownCategories, customCategories] = await Promise.all([
      this.prisma.category.findMany({
        where: {
          products: {
            some: { creator_id: store.creator.id, status: 'PUBLISHED' },
          },
        },
        include: { translations: true },
        orderBy: { sort_order: 'asc' },
      }),
      this.prisma.category.findMany({
        where: {
          products: {
            some: {
              custom_products: {
                some: { creator_id: store.creator.id, status: 'PUBLISHED' },
              },
            },
          },
        },
        include: { translations: true },
        orderBy: { sort_order: 'asc' },
      }),
    ]);

    // Merge deduplicating by id
    const seen = new Set<string>();
    const categories = [...ownCategories, ...customCategories].filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });

    return categories;
  }

  /**
   * Public tree of the creator's active collections for this store.
   * Returns only root → child nodes (one level of nesting today).
   */
  async getCreatorCategories(slug: string) {
    const store = await this.prisma.store.findUnique({
      where: { slug },
      include: { creator: true },
    });
    if (!store) throw new NotFoundException('Store not found');

    const rows = await this.prisma.creatorCategory.findMany({
      where: { creator_id: store.creator.id, is_active: true },
      include: { translations: true },
      orderBy: [{ parent_id: 'asc' }, { sort_order: 'asc' }],
    });

    type Node = (typeof rows)[number] & { children: Node[] };
    const map = new Map<string, Node>();
    rows.forEach((r) => map.set(r.id, { ...r, children: [] }));
    const roots: Node[] = [];
    for (const node of map.values()) {
      if (node.parent_id && map.has(node.parent_id)) {
        map.get(node.parent_id)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  async getPage(slug: string, pageSlug: string) {
    const store = await this.prisma.store.findUnique({ where: { slug } });
    if (!store) throw new NotFoundException('Store not found');

    const page = await this.prisma.staticPage.findUnique({
      where: {
        store_id_slug: { store_id: store.id, slug: pageSlug },
      },
      include: { translations: true },
    });

    if (!page || page.status !== 'PUBLISHED') {
      throw new NotFoundException('Page not found');
    }

    return page;
  }

  /**
   * Return any published product the storefront can use as a sample to render
   * a PRODUCT_TEMPLATE in the dashboard's preview iframe. Falls back to a
   * minimal stub (used by the placeholder magic sections) if the store has no
   * published products yet.
   */
  /**
   * Compact site map of every URL the storefront sitemap.xml needs to emit:
   * - the homepage and every published v2 STATIC/LANDING page
   * - every published product's translated slug
   * - the store's locale set so the sitemap can render hreflang alternates
   * Server-side aggregation keeps the storefront route to a single fetch.
   */
  async getSitemapData(storeSlug: string) {
    const store = await this.prisma.store.findUnique({
      where: { slug: storeSlug },
      include: {
        creator: { select: { id: true } },
        language_config: true,
      },
    });
    if (!store) throw new NotFoundException('Store not found');

    const primaryLocale = store.language_config?.primary_locale || 'en';
    const secondaryLocales = store.language_config?.secondary_locales || [];
    const locales = Array.from(new Set([primaryLocale, ...secondaryLocales]));

    // v2 published pages — only those with a published_version_id.
    const v2Pages = await this.prisma.page.findMany({
      where: { store_id: store.id, published_version_id: { not: null } },
      select: {
        type: true,
        slug: true,
        updated_at: true,
      },
    });

    // Legacy static pages that are still PUBLISHED and not yet migrated to v2.
    // Kept so sitemap doesn't drop pages during the migration window.
    const legacyPages = await this.prisma.staticPage.findMany({
      where: { store_id: store.id, status: 'PUBLISHED' },
      select: { slug: true, updated_at: true },
    });

    // Published own products + custom products. For sitemap we only need slug
    // + lastmod, so we project a thin shape.
    const [ownProducts, customProducts] = await Promise.all([
      this.prisma.product.findMany({
        where: { creator_id: store.creator.id, status: 'PUBLISHED' },
        select: {
          updated_at: true,
          translations: { select: { locale: true, slug: true } },
        },
      }),
      this.prisma.customProduct.findMany({
        where: { creator_id: store.creator.id, status: 'PUBLISHED' },
        select: {
          updated_at: true,
          translations: { select: { locale: true, slug: true } },
        },
      }),
    ]);

    return {
      locales,
      primaryLocale,
      // Slugs go raw so the storefront can build canonical + alternate URLs
      // however it likes (cookie-based locale vs subpath, etc.).
      home: v2Pages.find((p) => p.type === 'HOME')
        ? { lastmod: v2Pages.find((p) => p.type === 'HOME')!.updated_at }
        : null,
      static_pages: [
        ...v2Pages
          .filter((p) => p.type === 'STATIC' && p.slug)
          .map((p) => ({ slug: p.slug!, lastmod: p.updated_at })),
        ...legacyPages.map((p) => ({ slug: p.slug, lastmod: p.updated_at })),
      ],
      landing_pages: v2Pages
        .filter((p) => p.type === 'LANDING' && p.slug)
        .map((p) => ({ slug: p.slug!, lastmod: p.updated_at })),
      products: [...ownProducts, ...customProducts]
        .map((p) => {
          // Pick the first translation that has a slug; sitemap doesn't care
          // which locale it came from since it'll emit alternates for all.
          const t = p.translations.find((tr) => !!tr.slug);
          return t ? { slug: t.slug!, lastmod: p.updated_at } : null;
        })
        .filter((p): p is { slug: string; lastmod: Date } => !!p),
    };
  }

  async getSampleProduct(storeSlug: string) {
    const store = await this.prisma.store.findUnique({
      where: { slug: storeSlug },
      include: { creator: true },
    });
    if (!store) throw new NotFoundException('Store not found');

    const own = await this.prisma.product.findFirst({
      where: { creator_id: store.creator.id, status: 'PUBLISHED' },
      include: {
        translations: { select: { locale: true, title: true, description: true, slug: true } },
        images: { orderBy: { sort_order: 'asc' } },
        variants: { where: { is_active: true } },
        faqs: { include: { translations: true }, orderBy: { sort_order: 'asc' } },
      },
      orderBy: { updated_at: 'desc' },
    });
    if (own) {
      const slug = own.translations.find((t) => !!t.slug)?.slug || own.id;
      return {
        id: own.id,
        slug,
        base_price: Number(own.base_price),
        compare_at_price: own.compare_at_price ? Number(own.compare_at_price) : undefined,
        translations: own.translations,
        images: own.images.map((img) => ({
          url: img.url,
          alt_text: img.alt_text,
          sort_order: img.sort_order,
        })),
        variants: own.variants.map((v) => ({
          id: v.id,
          price: Number(own.base_price) + Number(v.price_adjustment || 0),
          stock: v.stock_quantity ?? undefined,
          sku: v.sku ?? undefined,
        })),
        faqs: own.faqs,
      };
    }

    // No published product in the store yet — return a placeholder so the
    // builder still has something to render in the preview iframe.
    return null;
  }

  /**
   * Navigation menus for a store, with items ordered. Public read used by the
   * storefront chrome (header/footer) to resolve a menu key → items.
   */
  async getMenus(storeSlug: string) {
    const store = await this.prisma.store.findUnique({
      where: { slug: storeSlug },
      select: { id: true },
    });
    if (!store) throw new NotFoundException('Store not found');
    const menus = await this.prisma.menu.findMany({
      where: { store_id: store.id },
      include: {
        items: {
          orderBy: { sort_order: 'asc' },
          select: { id: true, parent_id: true, label: true, label_i18n: true, url: true, open_in_new_tab: true, sort_order: true },
        },
      },
      orderBy: { created_at: 'asc' },
    });
    return menus.map((m) => ({ id: m.id, key: m.key, name: m.name, items: m.items }));
  }

  /**
   * Read the live published version of a v2 Page. Returns the frozen snapshot
   * so storefront rendering doesn't see in-progress drafts. Returns null if
   * there is no published version yet — caller decides whether to fall back
   * to default content.
   *
   * - HOME and PRODUCT_TEMPLATE: there's one per store, no slug needed.
   * - STATIC and LANDING: identified by (store, slug).
   */
  async getPublishedPage(
    storeSlug: string,
    opts:
      | { type: 'HOME' | 'PRODUCT_TEMPLATE' | 'HEADER' | 'FOOTER' }
      | { type: 'STATIC' | 'LANDING'; slug: string },
  ) {
    const store = await this.prisma.store.findUnique({ where: { slug: storeSlug } });
    if (!store) throw new NotFoundException('Store not found');

    const whereType: any = { store_id: store.id, type: opts.type };
    if (opts.type === 'STATIC' || opts.type === 'LANDING') whereType.slug = opts.slug;

    const page = await this.prisma.page.findFirst({
      where: whereType,
      include: { published_version: true },
    });
    if (!page || !page.published_version) return null;
    return {
      id: page.id,
      type: page.type,
      slug: page.slug,
      seo: page.seo,
      snapshot: page.published_version.snapshot,
      published_at: page.published_version.published_at,
    };
  }

  // ── Price computation helpers ──────────────────────────

  private computeVariants(cp: any) {
    const hasSelectedVariants =
      cp.selected_variants && cp.selected_variants.length > 0;

    // Determine which variants to show
    const sourceVariants = hasSelectedVariants
      ? cp.selected_variants.map((sv: any) => ({
          ...sv.variant,
          _custom_price: sv.custom_price ? Number(sv.custom_price) : undefined,
        }))
      : cp.product.variants || [];

    return sourceVariants.map((v: any) => {
      const price = this.computeVariantPrice(cp, v);
      return {
        ...v,
        _custom_price: undefined,
        price,
        compare_at_price: v.compare_at_price
          ? Number(v.compare_at_price)
          : undefined,
        stock: v.stock_quantity ?? 999,
      };
    });
  }

  private computeVariantPrice(cp: any, variant: any): number {
    switch (cp.pricing_type) {
      case PricingType.SINGLE:
        return Number(cp.final_price) + Number(variant.price_adjustment || 0);

      case PricingType.PER_VARIANT:
        // custom_price from CustomProductVariant
        if (variant._custom_price !== undefined) {
          return variant._custom_price;
        }
        // Fallback: look up from selected_variants
        const sv = cp.selected_variants?.find(
          (s: any) => s.variant_id === variant.id,
        );
        return sv?.custom_price
          ? Number(sv.custom_price)
          : Number(cp.product.base_price) +
              Number(variant.price_adjustment || 0);

      case PricingType.MARGIN:
        return (
          Number(cp.product.base_price) +
          Number(variant.price_adjustment || 0) +
          Number(cp.margin_amount || 0)
        );

      default:
        return Number(cp.final_price) + Number(variant.price_adjustment || 0);
    }
  }

  private computeDisplayPrice(cp: any, variants: any[]): number {
    if (cp.pricing_type === PricingType.SINGLE) {
      return Number(cp.final_price);
    }
    if (variants.length > 0) {
      return Math.min(...variants.map((v: any) => v.price));
    }
    return Number(cp.final_price) || 0;
  }
}
