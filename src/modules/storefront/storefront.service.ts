import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CREATOR_CATEGORY_MAX_DEPTH } from '../creator-categories/primary-collection';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import { marketizeBundles, marketizePromotions } from './market-offers';
import { toMarketRoute, type MarketContext } from '../markets/market-context';
import { PricingType, Prisma, ProductVariant, StoreType } from '@prisma/client';
import { resolveStoreCurrency } from '../../common/money/currency.util';
import {
  TaxService,
  buildTaxContext,
  effectiveRateBp,
  resolveRatesForLine,
  type TaxStoreFields,
} from '../taxes/tax.service';
import {
  isKustomEnabledForStore,
  kustomCreatorSelect,
} from '../payments/kustom/kustom.eligibility';
import { PersonalizationService } from '../personalization/personalization.service';
import {
  legacyRow,
  shapeFieldsForStorefront,
  shapeOptionConfigForStorefront,
  usesAdvancedFields,
  usesAdvancedOptionConfig,
} from '../personalization/personalization-runtime';
import type { PFieldDef } from '@multi-stores/core/personalization/types';
import { DesignerTemplatesService } from '../designer/designer-templates.service';
import { countPublishedInCollections } from './collection-counts';
import { publicCheckoutSettings } from '../stores/checkout-settings';
import { sanitizeAuthPagesConfig } from '../stores/theme-config';
import { compareManualOrder } from '../creator-categories/product-order';

/** The legacy freeform Store.theme_config JSON as getStore() reads it. */
interface LegacyThemeConfig {
  primaryColor?: string | null;
  secondaryColor?: string | null;
  fontFamily?: string | null;
  typography?: Record<string, unknown>;
  header?: Record<string, unknown>;
  templateId?: string | null;
  socials?: Record<string, unknown>;
  contact?: Record<string, unknown>;
  seo?: Record<string, unknown>;
  translations?: Record<string, unknown>;
  hero?: Record<string, unknown>;
  auth?: unknown;
}

/** The part of Promotion.conditions the storefront badges read. */
interface PromotionConditions {
  product_ids?: string[];
}

/** A variant row plus the custom price its CustomProductVariant carries. */
type PricedVariant = ProductVariant & { _custom_price?: number };

/**
 * Feed data (M5.6) is merchant-only: gtin / mpn / google_product_category /
 * condition / feed_excluded never reach the storefront, and `brand` is
 * served only when set (products without it keep their pre-feeds payload).
 */
export function withoutFeedFields<
  T extends {
    gtin?: unknown;
    mpn?: unknown;
    brand?: unknown;
    google_product_category?: unknown;
    condition?: unknown;
    feed_excluded?: unknown;
  },
>(
  p: T,
): Omit<
  T,
  | 'gtin'
  | 'mpn'
  | 'brand'
  | 'google_product_category'
  | 'condition'
  | 'feed_excluded'
> & { brand?: string } {
  const {
    gtin: _gtin,
    mpn: _mpn,
    brand,
    google_product_category: _gpc,
    condition: _condition,
    feed_excluded: _excluded,
    ...rest
  } = p;
  void _gtin;
  void _mpn;
  void _gpc;
  void _condition;
  void _excluded;
  return typeof brand === 'string' && brand ? { ...rest, brand } : rest;
}

/**
 * How the product page finds a creator's product by any of its translated
 * slugs — the same query for own products (tried first) and, for
 * non-INDEPENDENT stores, custom products. Ordered by updated_at so a
 * duplicate-slug collision resolves to the most recently edited product
 * instead of an implementation-defined row. Shared with
 * `resolveProductRef` (owner edit button) so both always agree.
 */
export function productBySlugQuery(creatorId: string, productSlug: string) {
  return {
    where: {
      creator_id: creatorId,
      status: 'PUBLISHED' as const,
      translations: { some: { slug: productSlug } },
    },
    orderBy: { updated_at: 'desc' as const },
  };
}

/** Drops the importer identity (`external_ref`) from a variant before it is served. */
export function publicVariant<T extends { external_ref?: unknown }>(
  v: T,
): Omit<T, 'external_ref'> {
  const { external_ref: _ref, ...rest } = v;
  void _ref;
  return rest;
}

/**
 * Public shape of a store collection: no importer identity, owner id or
 * matching rules (the web reads none of them).
 */
export function publicCreatorCategory<
  T extends {
    external_ref?: unknown;
    creator_id?: unknown;
    match_rule?: unknown;
    match_tags?: unknown;
  },
>(c: T): Omit<T, 'external_ref' | 'creator_id' | 'match_rule' | 'match_tags'> {
  const {
    external_ref: _ref,
    creator_id: _owner,
    match_rule: _rule,
    match_tags: _tags,
    ...rest
  } = c;
  void _ref;
  void _owner;
  void _rule;
  void _tags;
  return rest;
}

/**
 * M6.3: remove the menu items matched by `drop` together with every item
 * under them (by parent_id), keeping the order of the rest.
 */
export function dropMenuItemsWithDescendants<
  T extends { id: string; parent_id: string | null },
>(items: T[], drop: (item: T) => boolean): T[] {
  const gone = new Set(items.filter(drop).map((it) => it.id));
  if (!gone.size) return items;
  let grew = true;
  while (grew) {
    grew = false;
    for (const it of items) {
      if (!gone.has(it.id) && it.parent_id && gone.has(it.parent_id)) {
        gone.add(it.id);
        grew = true;
      }
    }
  }
  return items.filter((it) => !gone.has(it.id));
}

/** What `buildCollectionPaths` reads of a creator's collection row (M6.7). */
export interface CollectionPathRow {
  id: string;
  slug: string;
  parent_id: string | null;
  is_active: boolean;
  visibility: string;
}

/** M6.7: the hierarchical URL of a collection and whether it is served. */
export interface CollectionPathInfo {
  /** Slugs root -> self; `path[path.length - 1]` is the row's own slug. */
  path: string[];
  /**
   * True when the row and every ancestor are active and PUBLIC, the chain is
   * complete (every parent is among `rows`) and within the depth cap.
   */
  reachable: boolean;
}

/**
 * M6.7: compute `/collections/<root>/<child>/<self>` paths for a creator's
 * collections from their `parent_id` chains. Pure: `rows` is the creator's
 * collection set (one findMany). A parent missing from `rows`, a cycle or a
 * chain longer than CREATOR_CATEGORY_MAX_DEPTH hops breaks the chain; such
 * a node (and an inactive / INTERNAL one, or one under such an ancestor) is
 * `reachable: false` and must not be served as a page.
 */
export function buildCollectionPaths(
  rows: readonly CollectionPathRow[],
): Map<string, CollectionPathInfo> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, CollectionPathInfo>();
  for (const row of rows) {
    const path = [row.slug];
    let reachable = row.is_active && row.visibility !== 'INTERNAL';
    const seen = new Set<string>([row.id]);
    let cursor = row.parent_id;
    for (let hop = 0; cursor; hop++) {
      if (hop >= CREATOR_CATEGORY_MAX_DEPTH || seen.has(cursor)) {
        reachable = false;
        break;
      }
      const parent = byId.get(cursor);
      if (!parent) {
        reachable = false;
        break;
      }
      seen.add(parent.id);
      path.unshift(parent.slug);
      if (!parent.is_active || parent.visibility === 'INTERNAL')
        reachable = false;
      cursor = parent.parent_id;
    }
    out.set(row.id, { path, reachable });
  }
  return out;
}

/**
 * M6.7: menu items as served. A `COLLECTION` item whose collection is not
 * reachable (unknown id included) goes with its descendants; the kept ones
 * get `url` = `/collections/<path…>` of the collection.
 */
export function rewriteCollectionMenuItems<
  T extends {
    id: string;
    parent_id: string | null;
    kind: string;
    resource_id: string | null;
    url: string | null;
  },
>(items: T[], paths: ReadonlyMap<string, CollectionPathInfo>): T[] {
  const isCollection = (it: T) => it.kind === 'COLLECTION' && !!it.resource_id;
  const kept = dropMenuItemsWithDescendants(
    items,
    (it) => isCollection(it) && !paths.get(it.resource_id!)?.reachable,
  );
  return kept.map((it) =>
    isCollection(it)
      ? {
          ...it,
          url: `/collections/${paths.get(it.resource_id!)!.path.join('/')}`,
        }
      : it,
  );
}

/** Shape check for `creator_category_id` (M6.4) before it reaches Prisma. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Product-list collection filter, shared by the slug and id resolvers. */
export interface CollectionFilter {
  id: string;
  match_rule: 'MANUAL' | 'TAGS';
  match_tags: string[];
}

/**
 * Turn a looked-up collection row into the product-list filter, or null when
 * the list must be empty: missing, inactive, or INTERNAL unless the caller
 * allows internal labels (the id filter of the builder section, M6.4).
 */
export function collectionFilterFrom(
  cc: {
    id: string;
    match_rule: string;
    match_tags: string[];
    is_active: boolean;
    visibility: string;
  } | null,
  opts: { allowInternal: boolean },
): CollectionFilter | null {
  if (!cc || !cc.is_active) return null;
  if (cc.visibility === 'INTERNAL' && !opts.allowInternal) return null;
  return {
    id: cc.id,
    match_rule: cc.match_rule as 'MANUAL' | 'TAGS',
    match_tags: cc.match_tags,
  };
}

/** A linked collection row as the product queries include it (M6). */
export type PublicCollectionRow = Prisma.CreatorCategoryGetPayload<{
  include: { translations: true };
}>;

/** One node of `primary_collection_path` (root -> leaf). */
export interface PublicCollectionPathNode {
  id: string;
  slug: string;
  /** M6.7: slugs root -> self (the node's `/collections/` URL). */
  path: string[];
  translations: PublicCollectionRow['translations'];
}

/** What the custom-product price helpers read; every query includes more. */
interface CustomProductPricingSource {
  pricing_type: PricingType;
  final_price: Prisma.Decimal | null;
  margin_amount?: Prisma.Decimal | null;
  selected_variants?:
    | {
        variant_id: string;
        custom_price: Prisma.Decimal | null;
        variant: ProductVariant;
      }[]
    | null;
  product: { base_price: Prisma.Decimal; variants?: ProductVariant[] | null };
}

@Injectable()
export class StorefrontService {
  private readonly logger = new Logger(StorefrontService.name);

  constructor(
    private prisma: PrismaService,
    private readonly storeApps: StoreAppsService,
    private readonly markets: MarketsContextService,
    private readonly marketPricing: MarketPricingService,
    private readonly taxService: TaxService,
    // M4.1 personalization app: optional and trailing (positional tests).
    // Absent = every product payload is the M4.0 one.
    @Optional() private readonly personalization?: PersonalizationService,
    // M4.2 designer app: optional and trailing (positional tests). Absent or
    // app off = no `designer` key in the product payload.
    @Optional() private readonly designerTemplates?: DesignerTemplatesService,
  ) {}

  /**
   * Personalization app (D2/D10): whether a creator's own product gets the
   * app payload. Only asked (one cached flag) for a product that uses an
   * M4.1 feature; every other product keeps the M4.0 payload.
   */
  private async personalizationOn(
    storeId: string,
    fields: readonly PFieldDef[],
    optionConfig: unknown,
  ): Promise<boolean> {
    if (!this.personalization) return false;
    if (!usesAdvancedFields(fields) && !usesAdvancedOptionConfig(optionConfig))
      return false;
    return this.personalization.isEnabled(storeId);
  }

  /**
   * Designer app (M5.5): add-on prices of the `designer` block are base
   * amounts; in a market they are converted like every base amount (the
   * cart and orders convert them the same way). Without a rate the add-ons
   * are left out (checkout could not price them). Unchanged without a
   * market or without add-ons.
   */
  private marketizeDesignerAddons<
    T extends { addons?: { price: number }[] } | null,
  >(designer: T, market: MarketContext | null): T {
    if (!designer || !market || !designer.addons?.length) return designer;
    try {
      return {
        ...designer,
        addons: designer.addons.map((a) => ({
          ...a,
          price: this.marketPricing.convertMoney(market, a.price),
        })),
      };
    } catch {
      const { addons: _dropped, ...rest } = designer;
      return rest as T;
    }
  }

  /**
   * The storefront `personalization` block (contract §1): the
   * free-shipping threshold already in the request currency.
   */
  private async personalizationBlock(
    store: {
      id: string;
      store_type: StoreType;
      currency: string | null;
      tax_country?: string | null;
    },
    productId: string,
    market: MarketContext | null,
    /** The product's own shipping profile when already loaded (no re-resolution). */
    profile?: Parameters<PersonalizationService['freeShippingThreshold']>[4],
  ): Promise<{
    enabled: true;
    free_shipping_threshold: number | null;
    currency: string;
  }> {
    const service = this.personalization!;
    const settings = await service.settings(store.id);
    let threshold: number | null = null;
    try {
      threshold = await service.freeShippingThreshold(
        productId,
        store,
        market,
        settings,
        profile,
      );
    } catch (e) {
      // A badge must never break the product page.
      this.logger.warn(
        `Free-shipping badge of product ${productId} (store ${store.id}) failed, shown without a threshold: ${String(e)}`,
      );
      threshold = null;
    }
    let currency: string;
    if (market) {
      currency = market.currency;
    } else {
      const config = await this.prisma.platformConfig.findFirst({
        select: { default_currency: true },
      });
      currency = resolveStoreCurrency(store, config?.default_currency);
    }
    return { enabled: true, free_shipping_threshold: threshold, currency };
  }

  /**
   * b2b app (D2): the estimated tax rate (basis points) of each product -
   * the registration-country estimate the cart uses, since no destination
   * is known on a catalog page - so the web can show net prices to a
   * company without a per-buyer cache split. Null when the app is off, so
   * the catalog payload stays byte-identical; one extra rate-table query
   * per request otherwise.
   */
  private async taxRatesFor(
    store: TaxStoreFields,
    products: { tax_class_id: string | null; tax_exempt: boolean }[],
  ): Promise<number[] | null> {
    if (!(await this.storeApps.isEnabled(store.id, 'b2b'))) return null;
    const ctx = await this.taxService.contextFor(store);
    const data = await this.taxService.loadTaxData(ctx);
    const destination = { country: ctx.taxCountry };
    return products.map((p) =>
      effectiveRateBp(resolveRatesForLine(ctx, data, p, destination).rates),
    );
  }

  /**
   * Market context of a storefront read (?market=): null when the app is
   * off (every caller then runs its pre-markets code), the default market
   * when the app is on and no key was given, 404 MARKET_NOT_FOUND /
   * MARKET_NOT_LIVE for an unknown or draft key. `preview` (market-preview
   * host, `?preview=1`) lets a DRAFT market render; reads only.
   */
  private resolveMarket(
    storeId: string,
    marketKey?: string,
    preview?: boolean,
  ): Promise<MarketContext | null> {
    return preview && marketKey
      ? this.markets.resolve(storeId, marketKey, { preview: true })
      : this.markets.resolve(storeId, marketKey);
  }

  /**
   * Apply a market's prices to own products already shaped for the
   * storefront (base_price / variants[].price as numbers). Products hidden
   * in the market are dropped. Override rows are loaded in one query.
   */
  private async applyMarketPrices<
    T extends {
      id: string;
      base_price: number;
      compare_at_price?: number;
      variants: {
        id: string;
        price: number;
        price_adjustment: unknown;
        compare_at_price?: number;
      }[];
    },
  >(ctx: MarketContext, products: T[]): Promise<T[]> {
    const rows = await this.marketPricing.loadPrices(
      ctx.id,
      products.map((p) => p.id),
    );
    const out: T[] = [];
    for (const p of products) {
      const priced = this.marketPricing.priceProduct(
        ctx,
        {
          id: p.id,
          base_price: p.base_price,
          compare_at_price: p.compare_at_price ?? null,
          variants: p.variants.map((v) => ({
            id: v.id,
            price_adjustment: v.price_adjustment,
            compare_at_price: v.compare_at_price ?? null,
          })),
        },
        rows.get(p.id),
      );
      if (priced.hidden) continue;
      const byId = new Map(priced.variants.map((v) => [v.id, v]));
      out.push({
        ...p,
        base_price: priced.base_price,
        compare_at_price: priced.compare_at_price,
        variants: p.variants.map((v) => ({
          ...v,
          price: byId.get(v.id)?.price ?? v.price,
          compare_at_price: byId.get(v.id)?.compare_at_price,
        })),
      });
    }
    return out;
  }

  /**
   * Fetch ACTIVE bundles attached to either an own Product or a CustomProduct,
   * scoped to the given creator. Returns a unified shape suitable for storefront
   * rendering — translations and offers are included.
   */
  private async getBundlesForProduct(
    creatorId: string,
    opts: { productId?: string; customProductId?: string },
  ) {
    const or: Prisma.BundleWhereInput[] = [];
    if (opts.productId) {
      or.push({ products: { some: { product_id: opts.productId } } });
    }
    if (opts.customProductId) {
      or.push({
        custom_products: { some: { custom_product_id: opts.customProductId } },
      });
    }
    if (or.length === 0) return [];
    const where: Prisma.BundleWhereInput = {
      creator_id: creatorId,
      status: 'ACTIVE',
      OR: or,
    };

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

  // Public platform metadata. platform_name (Admin → Settings → Platform Info)
  // is the single source of the platform name inherited across all apps.
  async getPlatformMeta(): Promise<{ platform_name: string }> {
    const cfg = await this.prisma.platformConfig.findFirst({
      select: { platform_name: true },
    });
    return { platform_name: cfg?.platform_name?.trim() || 'Multi Stores' };
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

  async getStore(slug: string, marketKey?: string, preview?: boolean) {
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
          select: {
            display_name: true,
            avatar_url: true,
            bio: true,
            cover_url: true,
            stripe_payouts_enabled: true,
            stripe_charges_enabled: true,
            stripe_account_type: true,
          },
        },
      },
    });
    if (!store)
      throw new NotFoundException({
        code: 'STOREFRONT_STORE_NOT_FOUND',
        message: 'Store not found',
      });
    const themeConfig = (store.theme_config as LegacyThemeConfig | null) || {};
    const platformConfig = await this.prisma.platformConfig.findFirst();
    const taxContext = buildTaxContext(store, platformConfig);

    // Kustom readiness is read separately: the creator select above is spread
    // into the response, and the shared secret must never travel with it.
    const kustomCreator = await this.prisma.creator.findUnique({
      where: { id: store.creator_id },
      select: kustomCreatorSelect,
    });

    // Store apps in effect for this store (`{}` for a store without apps).
    const apps = await this.storeApps.storefrontApps(store.id);

    // Markets app: null when off — the payload below is then byte-identical
    // to the pre-markets one (no market/markets keys, language_config and
    // currency untouched).
    const market = await this.resolveMarket(store.id, marketKey, preview);
    const markets = market
      ? ((await this.markets.listLive(store.id)) ?? [])
      : [];

    // Builder (v2) static pages that are live. A legacy page migrated into the
    // builder is deleted from static_pages, so without this merge it silently
    // vanishes from the storefront nav (header/footer links). "Live" for v2
    // means a published snapshot exists — the status column is not consulted
    // (see getPublishedPage). On slug collision the v2 page wins because the
    // storefront page route also prefers the v2 snapshot.
    const v2StaticPages = await this.prisma.page.findMany({
      where: {
        store_id: store.id,
        type: 'STATIC',
        slug: { not: null },
        published_version_id: { not: null },
      },
      select: {
        slug: true,
        sort_order: true,
        translations: { select: { locale: true, title: true } },
      },
      orderBy: { sort_order: 'asc' },
    });
    const v2Slugs = new Set(v2StaticPages.map((p) => p.slug));
    const mergedPages = [
      ...v2StaticPages.map((p) => ({
        slug: p.slug as string,
        sort_order: p.sort_order,
        translations: p.translations
          .filter((t) => !!t.title)
          .map((t) => ({ locale: t.locale, title: t.title as string })),
      })),
      ...store.static_pages.filter((p) => !v2Slugs.has(p.slug)),
    ];

    // Checkout behaviour (M5.1): the raw column never travels; the public
    // `checkout` key is added below only when the store overrides a default.
    const {
      checkout_settings: rawCheckoutSettings,
      ga4_measurement_id,
      meta_pixel_id,
      tiktok_pixel_id,
      consent_required,
      ...storeRow
    } = store;
    const checkout = publicCheckoutSettings(rawCheckoutSettings);

    return {
      ...storeRow,
      // Independent stores may price in their own currency; everyone else
      // shows the platform default.
      currency: resolveStoreCurrency(store, platformConfig?.default_currency),
      // Tax display settings: who taxes this store's orders, whether the
      // catalog prices include tax and the registration country the cart
      // estimates with. Rates themselves come from POST /orders/quote.
      tax: {
        pricing_mode: taxContext.pricingMode,
        display_prices_incl_tax: taxContext.displayPricesInclTax,
        country: taxContext.taxCountry,
        registrant: taxContext.registrant,
      },
      // Store type drives the storefront's product mix and checkout flow.
      store_type: store.store_type,
      // Card checkout availability. Marketplace stores need the creator able
      // to receive payout transfers (Express onboarding complete); independent
      // stores charge directly, so they need a Standard account that can take
      // charges. Note: checkout still re-checks the recipients at payment time.
      card_payments_enabled:
        store.store_type === StoreType.INDEPENDENT
          ? store.creator.stripe_account_type === 'standard' &&
            store.creator.stripe_charges_enabled
          : // Marketplace needs an account that can receive transfers — a
            // Standard account left over from an independent phase cannot,
            // so the card option must not be offered.
            store.creator.stripe_account_type !== 'standard' &&
            store.creator.stripe_payouts_enabled,
      // Kustom Checkout availability: independent stores only, creator setup
      // complete. Same rule as GET /payments/config's kustomEnabled.
      kustom_enabled: isKustomEnabledForStore({
        store_type: store.store_type,
        is_active: store.is_active,
        creator: kustomCreator,
        currency: resolveStoreCurrency(store, platformConfig?.default_currency),
      }),
      // Enabled store apps keyed by app key; always present (`{}` when none)
      // so the storefront payload has a stable shape.
      apps,
      // Checkout behaviour overrides — only present when non-default.
      ...(checkout ? { checkout } : {}),
      // Tracking + cookie consent (3.9): public vendor ids only. The
      // storefront renders the cookie banner when at least one id is set.
      tracking: {
        ga4_measurement_id: ga4_measurement_id ?? null,
        meta_pixel_id: meta_pixel_id ?? null,
        tiktok_pixel_id: tiktok_pixel_id ?? null,
        consent_required,
      },
      pages: mergedPages,
      // New theme system: storefront resolves the registry by theme_key and
      // merges theme_customizations on top.
      theme_key: store.theme_key || 'minimal',
      theme_customizations: store.theme_customizations || {},
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
        // Per-page hero/banner settings for the products listing and collection
        // pages. Freeform config — the storefront reads `products` / `collections`
        // sub-objects (enabled, image_url, height, overlay, show_count).
        hero: themeConfig.hero || {},
        // Account pages (login / register / password reset) background;
        // whitelisted here because theme_config is freeform.
        auth: sanitizeAuthPagesConfig(themeConfig.auth),
      },
      // With a market: the market's currency and locales override the
      // store-level ones so every page reading language_config.primary_locale
      // becomes market-aware (M1-DESIGN D3), plus the market routes.
      ...(market
        ? {
            currency: market.currency,
            language_config: {
              ...store.language_config,
              primary_locale: market.defaultLocale,
              secondary_locales: market.locales,
            },
            kustom_enabled: isKustomEnabledForStore({
              store_type: store.store_type,
              is_active: store.is_active,
              creator: kustomCreator,
              currency: market.currency,
            }),
            market: toMarketRoute(market),
            markets,
          }
        : {}),
    };
  }

  /**
   * Resolve the collection filter of the product list to `{ id, match_rule,
   * match_tags }`, or null when nothing should match. `creator_category_id`
   * (M6.4) looks the collection up by id within the store's creator and
   * accepts PUBLIC and INTERNAL rows; it wins over the slug. The slug form is
   * what storefront URLs use, so it refuses INTERNAL labels (M6.3).
   */
  private async resolveCollectionFilter(
    creatorId: string,
    filters: { creator_category?: string; creator_category_id?: string },
  ): Promise<CollectionFilter | null> {
    const select = {
      id: true,
      match_rule: true,
      match_tags: true,
      is_active: true,
      visibility: true,
    } as const;
    // Query values arrive unvalidated (a repeated key is an array): anything
    // that is not a plain string — or, for the id, not uuid-shaped — matches
    // nothing instead of reaching Prisma and failing the request.
    if (filters.creator_category_id) {
      const id = filters.creator_category_id;
      if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
      const cc = await this.prisma.creatorCategory.findFirst({
        where: { id, creator_id: creatorId },
        select,
      });
      return collectionFilterFrom(cc, { allowInternal: true });
    }
    if (filters.creator_category) {
      const slug = filters.creator_category;
      if (typeof slug !== 'string') return null;
      const cc = await this.prisma.creatorCategory.findUnique({
        where: { creator_id_slug: { creator_id: creatorId, slug } },
        select,
      });
      return collectionFilterFrom(cc, { allowInternal: false });
    }
    return null;
  }

  async getProducts(
    slug: string,
    filters: {
      page?: number;
      limit?: number;
      category_id?: string;
      creator_category?: string;
      // M6.4: collection id (uuid). Reached only from the builder
      // "collection products" section, so INTERNAL labels are allowed here.
      // When both are sent the id wins.
      creator_category_id?: string;
      search?: string;
      locale?: string;
    },
    marketKey?: string,
    preview?: boolean,
  ) {
    const store = await this.prisma.store.findUnique({
      where: { slug },
      include: { creator: true },
    });
    if (!store)
      throw new NotFoundException({
        code: 'STOREFRONT_STORE_NOT_FOUND',
        message: 'Store not found',
      });

    const market = await this.resolveMarket(store.id, marketKey, preview);

    // Resolve the requested collection (by id or slug) up front so the same
    // filter applies to both the own-products and custom-products queries.
    const requested = Boolean(
      filters.creator_category_id || filters.creator_category,
    );
    const creatorCategory = requested
      ? await this.resolveCollectionFilter(store.creator.id, filters)
      : null;
    // Unknown, inactive or (for the slug filter) INTERNAL collection —
    // return nothing, like an inactive one.
    if (requested && !creatorCategory) return [];

    // Creator's own products (creator_id set on Product)
    const ownWhere: Prisma.ProductWhereInput = {
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
    if (market) {
      // Products the creator switched off in this market are not listed.
      ownWhere.NOT = {
        market_prices: {
          some: { market_id: market.id, variant_id: null, available: false },
        },
      };
      // No rate (fixed rule): only products with a manual override can be
      // priced, so the others are excluded here already (exact counts);
      // applyMarketPrices below still drops anything unpriceable.
      if (market.rate == null) {
        ownWhere.market_prices = {
          some: {
            market_id: market.id,
            variant_id: null,
            price: { not: null },
          },
        };
      }
    }

    // Custom products (creator took a provider product and added their design)
    const customWhere: Prisma.CustomProductWhereInput = {
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
          ...(customWhere.product as Prisma.ProductWhereInput | undefined),
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

    // Independent stores sell the creator's own products only — never list
    // custom products (provider resells) on their storefront.
    const isIndependent = store.store_type === StoreType.INDEPENDENT;

    const customProductInclude = {
      translations: true,
      mockup_images: { take: 1, orderBy: { sort_order: 'asc' } },
      selected_variants: { include: { variant: true } },
      product: {
        include: {
          images: { take: 1, orderBy: { sort_order: 'asc' } },
          variants: { where: { is_active: true } },
          category: { include: { translations: true } },
          provider: {
            select: { id: true, company_name: true, logo_url: true },
          },
        },
      },
    } satisfies Prisma.CustomProductInclude;
    type ListedCustomProduct = Prisma.CustomProductGetPayload<{
      include: typeof customProductInclude;
    }>;

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
      isIndependent
        ? Promise.resolve<ListedCustomProduct[]>([])
        : this.prisma.customProduct.findMany({
            where: customWhere,
            include: customProductInclude,
            orderBy: { created_at: 'desc' },
          }),
    ]);

    // Vendor (provider) exposure is an opt-in marketplace-only setting.
    const showVendor = this.showVendor(store);

    const mappedCustom = customProducts.map((cp) => {
      const variants = this.computeVariants(cp);
      const displayPrice = this.computeDisplayPrice(cp, variants);

      return {
        id: cp.id,
        base_price: displayPrice,
        status: cp.status,
        translations: cp.translations,
        images:
          cp.mockup_images.length > 0
            ? cp.mockup_images.map((img) => ({
                url: img.url,
                alt_text: null,
                sort_order: img.sort_order,
              }))
            : cp.product.images,
        variants,
        category: cp.product.category,
        pricing_type: cp.pricing_type,
        vendor: showVendor ? (cp.product.provider ?? null) : null,
        _type: 'custom_product' as const,
      };
    });

    // Normalize own products too (Decimal → Number)
    // cost_price is a merchant-only margin input; never serve it publicly.
    const mappedOwn = ownProducts.map(
      ({ cost_price: _costPrice, external_ref: _externalRef, ...p }) => ({
        ...withoutFeedFields(p),
        base_price: Number(p.base_price),
        compare_at_price: p.compare_at_price
          ? Number(p.compare_at_price)
          : undefined,
        variants: (p.variants || []).map((v) => ({
          ...publicVariant(v),
          price: Number(p.base_price) + Number(v.price_adjustment || 0),
          compare_at_price: v.compare_at_price
            ? Number(v.compare_at_price)
            : undefined,
          stock: v.stock_quantity ?? 999,
        })),
      }),
    );

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
      allPromos
        .filter((p) => {
          const conds = p.conditions as PromotionConditions | null;
          if (!conds?.product_ids?.length) return true;
          return conds.product_ids.includes(productId);
        })
        .map((p) => ({
          id: p.id,
          type: p.type,
          value: Number(p.value),
          translations: p.translations,
        }));

    const ownPriced = market
      ? await this.applyMarketPrices(market, mappedOwn)
      : mappedOwn;
    // Personalization app (C36): with the app off, stored card config is
    // not exposed (`valueMeta` removed, `card` shown as `text`). Products
    // without it are returned as they are.
    const listingAppOn =
      !!this.personalization &&
      ownPriced.some((p) =>
        usesAdvancedOptionConfig(p.variant_option_config),
      ) &&
      (await this.personalization.isEnabled(store.id));
    const ownListed = listingAppOn
      ? ownPriced
      : ownPriced.map((p) =>
          usesAdvancedOptionConfig(p.variant_option_config)
            ? {
                ...p,
                variant_option_config: shapeOptionConfigForStorefront(
                  p.variant_option_config,
                  false,
                ) as typeof p.variant_option_config,
              }
            : p,
        );

    const ownWithPromos = ownListed.map((p) => ({
      ...p,
      promotions: attachPromos(p.id),
    }));
    const customWithPromos = mappedCustom.map((p) => ({
      ...p,
      promotions: attachPromos(p.id),
    }));

    // b2b app: `tax_rate_bp` per product (own, then custom), app on only.
    const rates = await this.taxRatesFor(store, [
      ...ownWithPromos.map((p) => ({
        tax_class_id: p.tax_class_id,
        tax_exempt: p.tax_exempt,
      })),
      ...customProducts.map((cp) => ({
        tax_class_id: cp.product.tax_class_id,
        tax_exempt: cp.product.tax_exempt,
      })),
    ]);
    const ownCount = ownWithPromos.length;
    const listed = rates
      ? [
          ...ownWithPromos.map((p, i) => ({ ...p, tax_rate_bp: rates[i] })),
          ...customWithPromos.map((p, i) => ({
            ...p,
            tax_rate_bp: rates[ownCount + i],
          })),
        ]
      : [...ownWithPromos, ...customWithPromos];

    // A MANUAL collection lists its products in the creator's drag order
    // (link sort_order, one index space for own + custom), newest first on
    // ties. TAGS collections and plain lists keep own-then-custom by date.
    // The storefront sorts client-side for its explicit sort options.
    if (creatorCategory?.match_rule === 'MANUAL' && listed.length > 1) {
      return this.sortByManualOrder(
        creatorCategory.id,
        listed,
        ownProducts,
        customProducts,
      );
    }
    return listed;
  }

  /**
   * Order a MANUAL collection's merged list by the collection's link
   * sort_order (see compareManualOrder). Items are told apart by
   * `_type === 'custom_product'`.
   */
  private async sortByManualOrder<
    T extends { id: string; _type?: 'custom_product' },
  >(
    creatorCategoryId: string,
    items: T[],
    ownRows: { id: string; created_at: Date }[],
    customRows: { id: string; created_at: Date }[],
  ): Promise<T[]> {
    const [ownLinks, customLinks] = await Promise.all([
      this.prisma.productCreatorCategory.findMany({
        where: { creator_category_id: creatorCategoryId },
        select: { product_id: true, sort_order: true },
      }),
      customRows.length
        ? this.prisma.customProductCreatorCategory.findMany({
            where: { creator_category_id: creatorCategoryId },
            select: { custom_product_id: true, sort_order: true },
          })
        : Promise.resolve([]),
    ]);
    const sortOf = new Map<string, number>();
    for (const l of ownLinks) sortOf.set(`p:${l.product_id}`, l.sort_order);
    for (const l of customLinks)
      sortOf.set(`cp:${l.custom_product_id}`, l.sort_order);
    const createdOf = new Map<string, Date>();
    for (const r of ownRows) createdOf.set(`p:${r.id}`, r.created_at);
    for (const r of customRows) createdOf.set(`cp:${r.id}`, r.created_at);
    const keyed = items.map((item) => {
      const kind: 'p' | 'cp' = item._type === 'custom_product' ? 'cp' : 'p';
      const token = `${kind}:${item.id}`;
      return {
        item,
        key: {
          kind,
          id: item.id,
          sort_order: sortOf.get(token) ?? Number.MAX_SAFE_INTEGER,
          created_at: createdOf.get(token) ?? null,
        },
      };
    });
    keyed.sort((a, b) => compareManualOrder(a.key, b.key));
    return keyed.map((k) => k.item);
  }

  /**
   * Fetch active CREATOR_TO_CUSTOMER promotions that target a specific product
   * or apply to all products (no product_ids in conditions).
   */
  private async getActivePromotionsForProduct(
    creatorId: string,
    productId: string,
  ) {
    const now = new Date();
    const promotions = await this.prisma.promotion.findMany({
      where: {
        creator_id: creatorId,
        level: 'CREATOR_TO_CUSTOMER',
        status: 'ACTIVE',
        starts_at: { lte: now },
        OR: [{ expires_at: null }, { expires_at: { gte: now } }],
        // Exclude coupon-only promotions (require manual code entry)
        type: { notIn: ['COUPON'] },
      },
      include: { translations: true },
    });

    // Filter: only promotions with no product targeting OR targeting this product
    return promotions
      .filter((p) => {
        const conds = p.conditions as PromotionConditions | null;
        if (!conds?.product_ids?.length) return true; // applies to all
        return conds.product_ids.includes(productId);
      })
      .map((p) => ({
        id: p.id,
        type: p.type,
        value: Number(p.value),
        conditions: p.conditions,
        starts_at: p.starts_at,
        expires_at: p.expires_at,
        translations: p.translations,
      }));
  }

  async getProduct(
    slug: string,
    productSlug: string,
    _locale?: string,
    marketKey?: string,
    preview?: boolean,
  ) {
    const store = await this.prisma.store.findUnique({
      where: { slug },
      include: { creator: true },
    });
    if (!store)
      throw new NotFoundException({
        code: 'STOREFRONT_STORE_NOT_FOUND',
        message: 'Store not found',
      });

    const market = await this.resolveMarket(store.id, marketKey, preview);

    // Try creator's own product first (see productBySlugQuery for the order).
    const product = await this.prisma.product.findFirst({
      ...productBySlugQuery(store.creator.id, productSlug),
      include: {
        translations: true,
        // Product-level gallery only — variant-linked rows would flood the
        // gallery with one duplicate per size/color combination.
        images: { where: { variant_id: null }, orderBy: { sort_order: 'asc' } },
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
        custom_fields: {
          include: { translations: true },
          orderBy: [{ sort_order: 'asc' as const }, { id: 'asc' as const }],
        },
        faqs: {
          include: { translations: true },
          orderBy: { sort_order: 'asc' },
        },
        shipping_profile: {
          include: {
            zones: {
              include: {
                methods: {
                  where: { is_active: true },
                  orderBy: { sort_order: 'asc' },
                },
              },
            },
          },
        },
      },
    });

    if (product) {
      const prodBasePrice = Number(product.base_price);

      // If no product-level shipping profile, fall back to provider's default
      let shippingProfile = product.shipping_profile;
      if (!shippingProfile && product.provider_id) {
        const defaultProfile = await this.prisma.shippingProfile.findFirst({
          where: { provider_id: product.provider_id, is_default: true },
          include: {
            zones: {
              include: {
                methods: {
                  where: { is_active: true },
                  orderBy: { sort_order: 'asc' },
                },
              },
            },
          },
        });
        if (defaultProfile) shippingProfile = defaultProfile;
      }

      let promotions = await this.getActivePromotionsForProduct(
        store.creator.id,
        product.id,
      );
      let bundles = await this.getBundlesForProduct(store.creator.id, {
        productId: product.id,
      });
      if (market) {
        // Markets app: FIXED amounts are stored in the base currency; show
        // them (and let the web bundle math use them) in the market's.
        const convert = (amount: number) =>
          market.rate == null
            ? null
            : this.marketPricing.convertMoney(market, amount);
        promotions = marketizePromotions(promotions, convert);
        bundles = marketizeBundles(bundles, convert);
      }

      // Personalization app (M4.1 C36): tree + valueMeta + block when on;
      // otherwise the M4.0 rows (new columns removed, app rows dropped).
      const fieldDefs = product.custom_fields as unknown as PFieldDef[];
      const appOn = await this.personalizationOn(
        store.id,
        fieldDefs,
        product.variant_option_config,
      );

      // cost_price is a merchant-only margin input; never serve it publicly.
      const {
        cost_price: _costPrice,
        external_ref: _externalRef,
        ...ownerProduct
      } = product;
      const publicProduct = withoutFeedFields(ownerProduct);
      // Designer app (M4.2 §4.1): the editor block, only when the app is on
      // and the product's link is enabled; the key is absent otherwise.
      const designer = this.marketizeDesignerAddons(
        this.designerTemplates
          ? await this.designerTemplates.storefrontBlock(store.id, product.id)
          : null,
        market,
      );
      const shaped = {
        ...publicProduct,
        custom_fields: shapeFieldsForStorefront(product.custom_fields, appOn),
        variant_option_config: shapeOptionConfigForStorefront(
          product.variant_option_config,
          appOn,
        ) as typeof product.variant_option_config,
        shipping_profile: shippingProfile,
        base_price: prodBasePrice,
        compare_at_price: product.compare_at_price
          ? Number(product.compare_at_price)
          : undefined,
        variants: (product.variants || []).map((v) => ({
          ...publicVariant(v),
          price: prodBasePrice + Number(v.price_adjustment || 0),
          compare_at_price: v.compare_at_price
            ? Number(v.compare_at_price)
            : undefined,
          stock: v.stock_quantity ?? 999,
        })),
        ...(await this.primaryCollectionFields(
          product.creator_id,
          product.primary_creator_category_id,
          (product.creator_categories || []).map((pcc) => pcc.creator_category),
        )),
        promotions,
        bundles,
        // b2b app: estimated rate (variants share the product's class).
        ...(await this.taxRateEntry(store, product)),
        ...(appOn
          ? {
              personalization: await this.personalizationBlock(
                store,
                product.id,
                market,
                // Own profile only: a missing one resolves to the creator's
                // default inside freeThresholdFor.
                product.shipping_profile ?? undefined,
              ),
            }
          : {}),
        ...(designer ? { designer } : {}),
      };
      if (market) {
        // Market prices; a product hidden in this market is a 404 here.
        const [priced] = await this.applyMarketPrices(market, [shaped]);
        if (!priced) {
          throw new NotFoundException({
            code: 'STOREFRONT_PRODUCT_NOT_FOUND',
            message: 'Product not found',
          });
        }
        return priced;
      }
      return shaped;
    }

    // Independent stores sell the creator's own products only — never serve
    // custom products (provider resells), so skip the fallback and 404 as if
    // the product doesn't exist.
    if (store.store_type === StoreType.INDEPENDENT) {
      throw new NotFoundException({
        code: 'STOREFRONT_PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });
    }

    // Fall back to custom product. Same ordering rationale as above.
    const customProduct = await this.prisma.customProduct.findFirst({
      ...productBySlugQuery(store.creator.id, productSlug),
      include: {
        translations: true,
        mockup_images: { orderBy: { sort_order: 'asc' } },
        selected_variants: {
          include: { variant: { include: { images: true } } },
        },
        field_values: {
          include: { custom_field: { include: { translations: true } } },
        },
        faqs: {
          include: { translations: true },
          orderBy: { sort_order: 'asc' },
        },
        creator_categories: {
          include: { creator_category: { include: { translations: true } } },
          orderBy: { sort_order: 'asc' },
        },
        product: {
          include: {
            // Product-level gallery only (see creator-product include above).
            images: {
              where: { variant_id: null },
              orderBy: { sort_order: 'asc' },
            },
            attributes: {
              include: { template: { include: { translations: true } } },
            },
            variants: { where: { is_active: true }, include: { images: true } },
            tags: true,
            category: { include: { translations: true } },
            provider: {
              select: { id: true, company_name: true, logo_url: true },
            },
            custom_fields: {
              include: { translations: true },
              orderBy: [{ sort_order: 'asc' as const }, { id: 'asc' as const }],
            },
            faqs: {
              include: { translations: true },
              orderBy: { sort_order: 'asc' },
            },
            shipping_profile: {
              include: {
                zones: {
                  include: {
                    methods: {
                      where: { is_active: true },
                      orderBy: { sort_order: 'asc' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!customProduct)
      throw new NotFoundException({
        code: 'STOREFRONT_PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });

    const variants = this.computeVariants(customProduct);
    const displayPrice = this.computeDisplayPrice(customProduct, variants);

    // Determine which custom fields the customer still needs to fill
    const prefilledFieldIds = new Set(
      customProduct.field_values.map((fv) => fv.custom_field_id),
    );
    // Custom products are always legacy (D2): the M4.0 rows.
    const customerFields = shapeFieldsForStorefront(
      customProduct.product.custom_fields.filter(
        (cf) => !prefilledFieldIds.has(cf.id),
      ),
      false,
    );

    const baseProduct = customProduct.product;

    // Resolve shipping profile (fallback to provider default)
    let shippingProfile = baseProduct.shipping_profile;
    if (!shippingProfile && baseProduct.provider_id) {
      const defaultProfile = await this.prisma.shippingProfile.findFirst({
        where: { provider_id: baseProduct.provider_id, is_default: true },
        include: {
          zones: {
            include: {
              methods: {
                where: { is_active: true },
                orderBy: { sort_order: 'asc' },
              },
            },
          },
        },
      });
      if (defaultProfile) shippingProfile = defaultProfile;
    }

    const promotions = await this.getActivePromotionsForProduct(
      store.creator.id,
      customProduct.id,
    );
    const bundles = await this.getBundlesForProduct(store.creator.id, {
      customProductId: customProduct.id,
    });

    return {
      id: customProduct.id,
      base_price: displayPrice,
      compare_at_price: baseProduct.compare_at_price
        ? Number(baseProduct.compare_at_price)
        : undefined,
      status: customProduct.status,
      product_type: baseProduct.product_type,
      customization_type: baseProduct.customization_type,
      variant_option_config: shapeOptionConfigForStorefront(
        baseProduct.variant_option_config,
        false,
      ),
      translations: customProduct.translations,
      images:
        customProduct.mockup_images.length > 0
          ? customProduct.mockup_images.map((img) => ({
              url: img.url,
              alt_text: null,
              sort_order: img.sort_order,
            }))
          : baseProduct.images,
      attributes: baseProduct.attributes,
      variants,
      tags: baseProduct.tags,
      category: baseProduct.category,
      ...(await this.primaryCollectionFields(
        customProduct.creator_id,
        customProduct.primary_creator_category_id,
        (customProduct.creator_categories || []).map(
          (cpcc) => cpcc.creator_category,
        ),
      )),
      custom_fields: customerFields,
      faqs: [...(customProduct.faqs || []), ...baseProduct.faqs],
      field_values: customProduct.field_values.map((fv) =>
        fv.custom_field
          ? {
              ...fv,
              custom_field: legacyRow(fv.custom_field),
            }
          : fv,
      ),
      pricing_type: customProduct.pricing_type,
      shipping_profile: shippingProfile,
      promotions,
      bundles,
      vendor: this.showVendor(store) ? (baseProduct.provider ?? null) : null,
      _type: 'custom_product' as const,
      // b2b app: estimated rate of the base product (app on only).
      ...(await this.taxRateEntry(store, baseProduct)),
    };
  }

  /**
   * Owner edit button: which product `/products/<productSlug>` shows, as the
   * same lookup getProduct runs (own product first; custom products only
   * for non-INDEPENDENT stores). Null when the page would 404.
   */
  async resolveProductRef(
    store: { creator_id: string; store_type: StoreType },
    productSlug: string,
  ): Promise<{ kind: 'own' | 'custom'; id: string } | null> {
    const query = productBySlugQuery(store.creator_id, productSlug);
    const own = await this.prisma.product.findFirst({
      ...query,
      select: { id: true },
    });
    if (own) return { kind: 'own', id: own.id };
    if (store.store_type === StoreType.INDEPENDENT) return null;
    const custom = await this.prisma.customProduct.findFirst({
      ...query,
      select: { id: true },
    });
    return custom ? { kind: 'custom', id: custom.id } : null;
  }

  /** `{ tax_rate_bp }` for one product when the b2b app is on, else `{}`. */
  private async taxRateEntry(
    store: TaxStoreFields,
    product: { tax_class_id: string | null; tax_exempt: boolean },
  ): Promise<{ tax_rate_bp?: number }> {
    const rates = await this.taxRatesFor(store, [product]);
    return rates ? { tax_rate_bp: rates[0] } : {};
  }

  /**
   * Whether the storefront may expose the base product's provider as the
   * vendor. Opt-in per store and marketplace-only: an independent store sells
   * its own products, so there is no third-party vendor to show.
   */
  private showVendor(store: {
    show_vendor_name: boolean;
    store_type: StoreType;
  }): boolean {
    return (
      store.show_vendor_name === true &&
      store.store_type === StoreType.MARKETPLACE
    );
  }

  async getCategories(slug: string) {
    const store = await this.prisma.store.findUnique({
      where: { slug },
      include: { creator: true },
    });
    if (!store)
      throw new NotFoundException({
        code: 'STOREFRONT_STORE_NOT_FOUND',
        message: 'Store not found',
      });

    // Independent stores never expose custom products, so their categories
    // come from the creator's own products only (mirrors getProducts).
    const isIndependent = store.store_type === StoreType.INDEPENDENT;

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
      isIndependent
        ? []
        : this.prisma.category.findMany({
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
   * M6.7: `{ path, reachable }` of every collection of the creator, from one
   * findMany (see `buildCollectionPaths`).
   */
  private async collectionPaths(
    creatorId: string,
  ): Promise<Map<string, CollectionPathInfo>> {
    const rows = await this.prisma.creatorCategory.findMany({
      where: { creator_id: creatorId },
      select: {
        id: true,
        slug: true,
        parent_id: true,
        is_active: true,
        visibility: true,
      },
    });
    return buildCollectionPaths(rows);
  }

  /**
   * M6: the collection fields of a product payload. `creator_categories`
   * is the linked collections that are served as pages, primary first
   * (M6.3: INTERNAL labels are never served; M6.7: nor is a collection
   * whose ancestor chain is inactive, INTERNAL or broken), each with its
   * `path`; `primary_creator_category_id` is null when the primary is
   * missing or unreachable; `primary_collection_path` is root -> leaf
   * (the ancestors, then the primary), `[]` when there is no primary.
   * Paths come from one query of the creator's collections.
   */
  private async primaryCollectionFields(
    creatorId: string | null,
    primaryId: string | null,
    linked: PublicCollectionRow[],
  ) {
    const present = linked.filter((cc) => !!cc);
    const ownerId = creatorId ?? present[0]?.creator_id ?? null;
    // One query, only when something is linked: the creator's collections
    // with their translations, so the paths and the ancestor nodes of the
    // primary come from the same rows.
    const rows =
      ownerId && present.length
        ? await this.prisma.creatorCategory.findMany({
            where: { creator_id: ownerId },
            select: {
              id: true,
              slug: true,
              parent_id: true,
              is_active: true,
              visibility: true,
              translations: true,
            },
          })
        : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const paths = buildCollectionPaths(rows);
    const pathOf = (id: string) => paths.get(id)?.path ?? [];
    const active = present.filter((cc) => paths.get(cc.id)?.reachable);
    const primary = primaryId
      ? active.find((cc) => cc.id === primaryId)
      : undefined;
    const ordered = primary
      ? [primary, ...active.filter((cc) => cc !== primary)]
      : active;
    const path: PublicCollectionPathNode[] = [];
    if (primary) {
      // The primary is reachable, so its chain is complete, active, PUBLIC
      // and within the depth cap: walk it up and emit root -> leaf.
      const ancestors: PublicCollectionPathNode[] = [];
      for (
        let cursor = byId.get(primary.parent_id ?? '');
        cursor && ancestors.length < CREATOR_CATEGORY_MAX_DEPTH;
        cursor = byId.get(cursor.parent_id ?? '')
      ) {
        ancestors.unshift({
          id: cursor.id,
          slug: cursor.slug,
          path: pathOf(cursor.id),
          translations: cursor.translations,
        });
      }
      path.push(...ancestors, {
        id: primary.id,
        slug: primary.slug,
        path: pathOf(primary.id),
        translations: primary.translations,
      });
    }
    return {
      creator_categories: ordered.map((cc) => ({
        ...publicCreatorCategory(cc),
        path: pathOf(cc.id),
      })),
      primary_creator_category_id: primary ? primary.id : null,
      primary_collection_path: path,
    };
  }

  /**
   * Public tree of the creator's active PUBLIC collections for this store
   * (root -> child -> grandchild, three levels at most since M6; INTERNAL
   * labels are left out, M6.3). M6.7: every node carries `path` (slugs
   * root -> self); a node whose ancestor chain is not served (inactive or
   * INTERNAL parent, or a chain deeper than the cap) is left out with its
   * subtree. Every translation row is served whole, so it carries the
   * short `description` (hero) and the M6.2 `long_description` (below the
   * products).
   */
  async getCreatorCategories(slug: string) {
    const store = await this.prisma.store.findUnique({
      where: { slug },
      include: { creator: true },
    });
    if (!store)
      throw new NotFoundException({
        code: 'STOREFRONT_STORE_NOT_FOUND',
        message: 'Store not found',
      });

    const rows = await this.prisma.creatorCategory.findMany({
      where: {
        creator_id: store.creator.id,
        is_active: true,
        visibility: 'PUBLIC',
      },
      include: { translations: true },
      orderBy: [{ parent_id: 'asc' }, { sort_order: 'asc' }],
    });

    // M4.4: `published_product_count` is added to every row, but only when
    // some row is flagged `noindex_when_empty` (other stores: no extra query,
    // unchanged shape). The web noindexes empty flagged collections.
    const flagged = rows.some((r) => r.noindex_when_empty);
    const counts = flagged
      ? await countPublishedInCollections(
          this.prisma,
          store.creator.id,
          store.store_type !== StoreType.INDEPENDENT,
          rows,
        )
      : null;

    type Node = ReturnType<
      typeof publicCreatorCategory<(typeof rows)[number]>
    > & {
      path: string[];
      children: Node[];
      published_product_count?: number;
    };
    // `rows` is already the active PUBLIC set, so a parent missing from it
    // is exactly an unreachable chain.
    const paths = buildCollectionPaths(rows);
    const map = new Map<string, Node>();
    for (const r of rows) {
      const info = paths.get(r.id);
      if (!info?.reachable) continue;
      map.set(r.id, {
        ...publicCreatorCategory(r),
        path: info.path,
        ...(counts ? { published_product_count: counts.get(r.id) ?? 0 } : {}),
        children: [],
      });
    }
    const roots: Node[] = [];
    for (const node of map.values()) {
      if (node.parent_id) {
        map.get(node.parent_id)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  async getPage(slug: string, pageSlug: string) {
    const store = await this.prisma.store.findUnique({ where: { slug } });
    if (!store)
      throw new NotFoundException({
        code: 'STOREFRONT_STORE_NOT_FOUND',
        message: 'Store not found',
      });

    const page = await this.prisma.staticPage.findUnique({
      where: {
        store_id_slug: { store_id: store.id, slug: pageSlug },
      },
      include: { translations: true },
    });

    if (!page || page.status !== 'PUBLISHED') {
      throw new NotFoundException({
        code: 'STOREFRONT_PAGE_NOT_FOUND',
        message: 'Page not found',
      });
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
  async getSitemapData(
    storeSlug: string,
    marketKey?: string,
    preview?: boolean,
  ) {
    const store = await this.prisma.store.findUnique({
      where: { slug: storeSlug },
      include: {
        creator: { select: { id: true } },
        language_config: true,
      },
    });
    if (!store)
      throw new NotFoundException({
        code: 'STOREFRONT_STORE_NOT_FOUND',
        message: 'Store not found',
      });

    // With a market, its locales drive the sitemap and hidden products are
    // left out; without one (app off) the output is unchanged.
    const market = await this.resolveMarket(store.id, marketKey, preview);
    const hiddenIds = new Set<string>();
    if (market) {
      const hidden = await this.prisma.productMarketPrice.findMany({
        where: { market_id: market.id, variant_id: null, available: false },
        select: { product_id: true },
      });
      hidden.forEach((h) => hiddenIds.add(h.product_id));
    }

    const primaryLocale = market
      ? market.defaultLocale
      : store.language_config?.primary_locale || 'en';
    const secondaryLocales = market
      ? market.locales
      : store.language_config?.secondary_locales || [];
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
    // + lastmod, so we project a thin shape. Independent stores never expose
    // custom products, so their sitemap lists own products only (mirrors
    // getProducts).
    const [ownProducts, customProducts, collections, legalPages] =
      await Promise.all([
        this.prisma.product.findMany({
          where: { creator_id: store.creator.id, status: 'PUBLISHED' },
          select: {
            id: true,
            updated_at: true,
            translations: { select: { locale: true, slug: true } },
          },
        }),
        store.store_type === StoreType.INDEPENDENT
          ? []
          : this.prisma.customProduct.findMany({
              where: { creator_id: store.creator.id, status: 'PUBLISHED' },
              select: {
                id: true,
                updated_at: true,
                translations: { select: { locale: true, slug: true } },
              },
            }),
        // Collections are linkable, indexable storefront pages but were missing
        // from the sitemap entirely. INTERNAL labels have no page (M6.3).
        this.prisma.creatorCategory.findMany({
          where: {
            creator_id: store.creator.id,
            is_active: true,
            visibility: 'PUBLIC',
          },
          select: {
            id: true,
            slug: true,
            parent_id: true,
            is_active: true,
            visibility: true,
            updated_at: true,
            noindex_when_empty: true,
            match_rule: true,
            match_tags: true,
          },
        }),
        // Legal pages are platform content rendered under each store's own
        // /legal/{slug}, so they belong in the store's sitemap too.
        this.prisma.legalPage.findMany({
          select: { slug: true, updated_at: true },
        }),
      ]);

    // M4.4: collections flagged `noindex_when_empty` are left out while they
    // list no published product (queries only when a flag is set).
    const flaggedCollections = collections.filter((c) => c.noindex_when_empty);
    const emptyCollectionIds = new Set<string>();
    if (flaggedCollections.length) {
      const counts = await countPublishedInCollections(
        this.prisma,
        store.creator.id,
        store.store_type !== StoreType.INDEPENDENT,
        flaggedCollections,
      );
      for (const c of flaggedCollections) {
        if (!counts.get(c.id)) emptyCollectionIds.add(c.id);
      }
    }
    const collectionPaths = buildCollectionPaths(collections);

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
        .filter((p) => !hiddenIds.has(p.id))
        .map((p) => {
          // The sitemap's canonical is the PRIMARY-locale URL, so the slug has
          // to be the primary locale's. Picking whichever translation happened
          // to have one first emitted a canonical in an arbitrary language.
          const t =
            p.translations.find(
              (tr) => tr.locale === primaryLocale && !!tr.slug,
            ) || p.translations.find((tr) => !!tr.slug);
          if (!t) return null;
          if (!market) return { slug: t.slug, lastmod: p.updated_at };
          // Per-locale slugs so the sitemap can emit one <url> per locale
          // with translated product paths (only with a market, D9/L12).
          const slugs: Record<string, string> = {};
          for (const tr of p.translations) {
            if (tr.slug && locales.includes(tr.locale)) {
              slugs[tr.locale] = tr.slug;
            }
          }
          return { slug: t.slug, slugs, lastmod: p.updated_at };
        })
        .filter((p): p is { slug: string; lastmod: Date } => !!p),
      // M6.7: `path` is the hierarchical URL; a collection under an
      // unserved ancestor (not in this active PUBLIC set) is left out.
      collections: collections
        .filter((c) => !emptyCollectionIds.has(c.id))
        .flatMap((c) => {
          const info = collectionPaths.get(c.id);
          return info?.reachable
            ? [{ slug: c.slug, path: info.path, lastmod: c.updated_at }]
            : [];
        }),
      legal_pages: legalPages.map((p) => ({
        slug: p.slug,
        lastmod: p.updated_at,
      })),
      ...(market
        ? {
            market: toMarketRoute(market),
            markets: (await this.markets.listLive(store.id)) ?? [],
          }
        : {}),
    };
  }

  async getSampleProduct(storeSlug: string) {
    const store = await this.prisma.store.findUnique({
      where: { slug: storeSlug },
      include: { creator: true },
    });
    if (!store)
      throw new NotFoundException({
        code: 'STOREFRONT_STORE_NOT_FOUND',
        message: 'Store not found',
      });

    const own = await this.prisma.product.findFirst({
      where: { creator_id: store.creator.id, status: 'PUBLISHED' },
      include: {
        translations: {
          select: { locale: true, title: true, description: true, slug: true },
        },
        images: { orderBy: { sort_order: 'asc' } },
        variants: { where: { is_active: true }, include: { images: true } },
        faqs: {
          include: { translations: true },
          orderBy: { sort_order: 'asc' },
        },
      },
      orderBy: { updated_at: 'desc' },
    });
    if (own) {
      const slug = own.translations.find((t) => !!t.slug)?.slug || own.id;
      const basePrice = Number(own.base_price);
      return {
        id: own.id,
        slug,
        base_price: basePrice,
        compare_at_price: own.compare_at_price
          ? Number(own.compare_at_price)
          : undefined,
        translations: own.translations,
        images: own.images.map((img) => ({
          url: img.url,
          alt_text: img.alt_text,
          sort_order: img.sort_order,
        })),
        // Mirror the live product payload: the preview renders the real
        // ProductDetailClient, which needs options/images per variant and the
        // option config (styles, color/image maps) to not fall over.
        variant_option_config: own.variant_option_config,
        variants: own.variants.map((v) => ({
          id: v.id,
          options: v.options ?? {},
          price: basePrice + Number(v.price_adjustment || 0),
          compare_at_price: v.compare_at_price
            ? Number(v.compare_at_price)
            : undefined,
          stock: v.stock_quantity ?? undefined,
          sku: v.sku ?? undefined,
          images: v.images || [],
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
   * storefront chrome (header/footer) to resolve a menu key → items. M6.3 /
   * M6.7: an item that links a collection that is not served (INTERNAL,
   * inactive, unknown, or under such an ancestor) is dropped together with
   * its descendants, and the `url` of the kept COLLECTION items is the
   * collection's hierarchical `/collections/<path…>` at serve time (one
   * extra query, only when some item is a COLLECTION; the stored url is
   * not touched).
   */
  async getMenus(storeSlug: string) {
    const store = await this.prisma.store.findUnique({
      where: { slug: storeSlug },
      select: { id: true, creator_id: true },
    });
    if (!store)
      throw new NotFoundException({
        code: 'STOREFRONT_STORE_NOT_FOUND',
        message: 'Store not found',
      });
    const menus = await this.prisma.menu.findMany({
      where: { store_id: store.id },
      include: {
        items: {
          orderBy: { sort_order: 'asc' },
          select: {
            id: true,
            parent_id: true,
            kind: true,
            resource_id: true,
            label: true,
            label_i18n: true,
            url: true,
            open_in_new_tab: true,
            sort_order: true,
          },
        },
      },
      orderBy: { created_at: 'asc' },
    });

    const linksCollection = menus.some((m) =>
      m.items.some((it) => it.kind === 'COLLECTION' && it.resource_id),
    );
    const paths = linksCollection
      ? await this.collectionPaths(store.creator_id)
      : null;

    return menus.map((m) => ({
      id: m.id,
      key: m.key,
      name: m.name,
      items: paths ? rewriteCollectionMenuItems(m.items, paths) : m.items,
    }));
  }

  /**
   * Read the live published version of a v2 Page. Returns the frozen snapshot
   * so storefront rendering doesn't see in-progress drafts. Returns null if
   * there is no published version yet — caller decides whether to fall back
   * to default content.
   *
   * - HOME, PRODUCT_TEMPLATE, HEADER, FOOTER, CATALOG_TEMPLATE and
   *   COLLECTION_TEMPLATE: there's one per store, no slug needed.
   * - STATIC and LANDING: identified by (store, slug).
   */
  async getPublishedPage(
    storeSlug: string,
    opts:
      | {
          type:
            | 'HOME'
            | 'PRODUCT_TEMPLATE'
            | 'HEADER'
            | 'FOOTER'
            | 'CATALOG_TEMPLATE'
            | 'COLLECTION_TEMPLATE';
        }
      | { type: 'STATIC' | 'LANDING'; slug: string }
      // Either slugged type (M6.6: landing pages are served at the root too).
      | { type: 'SLUG'; slug: string },
  ) {
    const store = await this.prisma.store.findUnique({
      where: { slug: storeSlug },
    });
    if (!store)
      throw new NotFoundException({
        code: 'STOREFRONT_STORE_NOT_FOUND',
        message: 'Store not found',
      });

    // Only rows with a published snapshot qualify. Singleton types are
    // looked up by (store, type) alone, so if a duplicate draft row ever
    // exists (e.g. two concurrent ensures) the published one still wins.
    const whereType: Prisma.PageWhereInput = {
      store_id: store.id,
      type: opts.type === 'SLUG' ? { in: ['STATIC', 'LANDING'] } : opts.type,
      published_version_id: { not: null },
    };
    if (
      opts.type === 'STATIC' ||
      opts.type === 'LANDING' ||
      opts.type === 'SLUG'
    )
      whereType.slug = opts.slug;

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

  private computeVariants(cp: CustomProductPricingSource) {
    const hasSelectedVariants =
      cp.selected_variants && cp.selected_variants.length > 0;

    // Determine which variants to show
    const sourceVariants: PricedVariant[] = hasSelectedVariants
      ? cp.selected_variants!.map((sv) => ({
          ...sv.variant,
          _custom_price: sv.custom_price ? Number(sv.custom_price) : undefined,
        }))
      : cp.product.variants || [];

    return sourceVariants.map((v) => {
      const price = this.computeVariantPrice(cp, v);
      return {
        ...publicVariant(v),
        _custom_price: undefined,
        price,
        compare_at_price: v.compare_at_price
          ? Number(v.compare_at_price)
          : undefined,
        stock: v.stock_quantity ?? 999,
      };
    });
  }

  private computeVariantPrice(
    cp: CustomProductPricingSource,
    variant: PricedVariant,
  ): number {
    switch (cp.pricing_type) {
      case PricingType.SINGLE:
        return Number(cp.final_price) + Number(variant.price_adjustment || 0);

      case PricingType.PER_VARIANT: {
        // custom_price from CustomProductVariant
        if (variant._custom_price !== undefined) {
          return variant._custom_price;
        }
        // Fallback: look up from selected_variants
        const sv = cp.selected_variants?.find(
          (s) => s.variant_id === variant.id,
        );
        return sv?.custom_price
          ? Number(sv.custom_price)
          : Number(cp.product.base_price) +
              Number(variant.price_adjustment || 0);
      }

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

  private computeDisplayPrice(
    cp: CustomProductPricingSource,
    variants: { price: number }[],
  ): number {
    if (cp.pricing_type === PricingType.SINGLE) {
      return Number(cp.final_price);
    }
    if (variants.length > 0) {
      return Math.min(...variants.map((v) => v.price));
    }
    return Number(cp.final_price) || 0;
  }
}
