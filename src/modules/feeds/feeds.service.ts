import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, TaxPricingMode } from '@prisma/client';
import { createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import type { MarketContext } from '../markets/market-context';
import {
  TaxService,
  effectiveRateBp,
  resolveRatesForLine,
  taxStoreSelect,
  type TaxContext,
  type TaxData,
} from '../taxes/tax.service';
import {
  resolveStoreCurrency,
  roundMoney,
} from '../../common/money/currency.util';
import {
  FACEBOOK_HEADER,
  GOOGLE_TAIL,
  facebookRow,
  googleHead,
  googleItem,
  type FeedCondition,
  type FeedItem,
} from './feed-builder';
import {
  FeedsSettings,
  generateFeedToken,
  normalizeFeedsSettings,
} from './feeds-settings';

/**
 * Feeds app (M5.6): Google Merchant RSS and Meta catalog CSV built from the
 * creator's published own products, one feed per market. The public routes
 * carry a secret token in the path; a wrong token, a store without the app
 * or an unknown slug all answer the same 404 so the URL space cannot be
 * probed. Bodies are cached 10 minutes per store + market + format.
 */

export type FeedFormat = 'google' | 'facebook';

/** How long a built feed is served from memory. */
export const FEED_CACHE_TTL_MS = 10 * 60 * 1000;
/** Bound on cached bodies (one per store x market x format x variants). */
const CACHE_MAX_ENTRIES = 500;

const FEED_NOT_FOUND = { code: 'FEED_NOT_FOUND', message: 'Feed not found' };

export interface BuiltFeed {
  body: string;
  etag: string;
  contentType: string;
  /** True when served from the cache (X-Feed-Cache header). */
  cached: boolean;
  items: number;
}

export interface FeedUrls {
  market_key: string | null;
  market_name: string | null;
  currency: string;
  google: string;
  facebook: string;
}

export interface MyFeedsView {
  store_slug: string;
  settings: FeedsSettings;
  urls: FeedUrls[];
}

export interface FeedValidationReport {
  market_key: string | null;
  currency: string;
  /** Published own products considered (after exclusions). */
  products: number;
  /** Feed items emitted (variants or products). */
  items: number;
  skipped: { excluded: number; hidden_in_market: number };
  missing_gtin: { id: string; title: string }[];
  missing_brand: { id: string; title: string }[];
  /** Products with neither gtin nor mpn (sent as identifier_exists=no). */
  missing_identifier: number;
  excluded: { id: string; title: string }[];
}

/** Rows a feed is built from (one query). */
const feedProductSelect = {
  id: true,
  product_type: true,
  base_price: true,
  compare_at_price: true,
  track_inventory: true,
  stock_quantity: true,
  tax_class_id: true,
  tax_exempt: true,
  gtin: true,
  mpn: true,
  brand: true,
  google_product_category: true,
  condition: true,
  translations: {
    select: { locale: true, title: true, description: true, slug: true },
  },
  images: {
    select: {
      url: true,
      variant_id: true,
      is_featured: true,
      sort_order: true,
    },
    orderBy: [{ sort_order: 'asc' as const }, { id: 'asc' as const }],
  },
  variants: {
    where: { is_active: true },
    select: {
      id: true,
      price_adjustment: true,
      compare_at_price: true,
      stock_quantity: true,
      options: true,
      images: {
        select: { url: true },
        orderBy: { sort_order: 'asc' as const },
      },
    },
    orderBy: { id: 'asc' as const },
  },
  creator_categories: {
    select: { creator_category_id: true },
  },
} satisfies Prisma.ProductSelect;

type FeedProductRow = Prisma.ProductGetPayload<{
  select: typeof feedProductSelect;
}>;

const feedStoreSelect = {
  ...taxStoreSelect,
  slug: true,
  name: true,
  custom_domain: true,
  currency: true,
  is_active: true,
  creator_id: true,
  language_config: { select: { primary_locale: true } },
} as const;

type FeedStore = Prisma.StoreGetPayload<{ select: typeof feedStoreSelect }>;

interface CacheEntry {
  feed: BuiltFeed;
  expiresAt: number;
}

export interface CollectionNode {
  id: string;
  parent_id: string | null;
  names: Map<string, string>;
}

interface TaxSetup {
  ctx: TaxContext;
  data: TaxData;
  country: string | null;
}

/** Option names read as colour / size (case-insensitive, a few languages). */
const COLOR_OPTION_NAMES = [
  'color',
  'colour',
  'farbe',
  'färg',
  'couleur',
  'renk',
  'اللون',
  'لون',
];
const SIZE_OPTION_NAMES = [
  'size',
  'größe',
  'groesse',
  'storlek',
  'taille',
  'beden',
  'المقاس',
  'مقاس',
];

@Injectable()
export class FeedsService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly storeApps: StoreAppsService,
    private readonly markets: MarketsContextService,
    private readonly marketPricing: MarketPricingService,
    private readonly taxService: TaxService,
  ) {}

  // ── Public feeds ──────────────────────────────────────────────────────────

  /**
   * The feed body for a public URL. 404 (one code) when the slug is
   * unknown, the store is inactive, the app is off, the format is switched
   * off in the settings, the market is unknown or the token does not match.
   */
  async publicFeed(
    storeSlug: string,
    token: string,
    format: FeedFormat,
    marketKey?: string,
  ): Promise<BuiltFeed> {
    const store = await this.prisma.store.findUnique({
      where: { slug: storeSlug },
      select: feedStoreSelect,
    });
    if (!store || !store.is_active) {
      throw new NotFoundException(FEED_NOT_FOUND);
    }
    const raw = await this.storeApps.getSettings(store.id, 'feeds');
    if (!raw) throw new NotFoundException(FEED_NOT_FOUND);
    const settings = normalizeFeedsSettings(raw);
    if (!settings.token || !tokenMatches(settings.token, token)) {
      throw new NotFoundException(FEED_NOT_FOUND);
    }
    if (format === 'google' ? !settings.google : !settings.facebook) {
      throw new NotFoundException(FEED_NOT_FOUND);
    }
    let market: MarketContext | null;
    try {
      market = await this.markets.resolve(store.id, marketKey);
    } catch (err) {
      // Unknown / draft market: the same opaque 404 as a wrong token.
      if (err instanceof NotFoundException) {
        throw new NotFoundException(FEED_NOT_FOUND);
      }
      throw err;
    }
    const cacheKey = [
      store.id,
      market?.key ?? '-',
      format,
      settings.include_variants ? 'v' : 'p',
    ].join(':');
    const now = Date.now();
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt > now) return { ...hit.feed, cached: true };

    const { items } = await this.collect(store, settings, market);
    const body =
      format === 'google'
        ? googleHead({
            title: store.name,
            link: this.storeLink(store, market),
            description: `${store.name} product feed`,
          }) +
          items.map((i) => googleItem(i) + '\n').join('') +
          GOOGLE_TAIL
        : FACEBOOK_HEADER + items.map(facebookRow).join('');
    const feed: BuiltFeed = {
      body,
      etag: `"${createHash('sha1').update(body).digest('hex')}"`,
      contentType:
        format === 'google'
          ? 'application/rss+xml; charset=utf-8'
          : 'text/csv; charset=utf-8',
      cached: false,
      items: items.length,
    };
    this.remember(cacheKey, feed, now);
    return feed;
  }

  /** Drops every cached body of a store (token rotation). */
  invalidate(storeId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${storeId}:`)) this.cache.delete(key);
    }
  }

  private remember(key: string, feed: BuiltFeed, now: number): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      for (const [k, entry] of this.cache) {
        if (entry.expiresAt <= now) this.cache.delete(k);
      }
      if (this.cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = this.cache.keys().next().value;
        if (oldest) this.cache.delete(oldest);
      }
    }
    this.cache.set(key, { feed, expiresAt: now + FEED_CACHE_TTL_MS });
  }

  // ── Creator routes ────────────────────────────────────────────────────────

  /**
   * Settings + the public URLs of every live market (one entry with
   * market_key null when the markets app is off). A store that has no token
   * yet gets one generated and stored here, so the URLs always exist.
   */
  async mySettings(userId: string): Promise<MyFeedsView> {
    const store = await this.storeOf(userId);
    const settings = await this.ensureToken(store.id);
    return {
      store_slug: store.slug,
      settings,
      urls: await this.urlsOf(store, settings),
    };
  }

  /** Replaces the token; every old URL answers 404 from now on. */
  async rotateToken(userId: string): Promise<MyFeedsView> {
    const store = await this.storeOf(userId);
    const current = normalizeFeedsSettings(
      (await this.rawSettings(store.id)) ?? {},
    );
    const settings = { ...current, token: generateFeedToken() };
    await this.storeApps.updateSettings(store.id, 'feeds', settings);
    await this.storeApps.settingsChanged(store.id);
    this.invalidate(store.id);
    return {
      store_slug: store.slug,
      settings,
      urls: await this.urlsOf(store, settings),
    };
  }

  /**
   * Builds the feed items in-process (same code path as the public route)
   * and reports what an ads platform would complain about: products
   * without gtin / brand, items without any identifier, exclusions.
   */
  async validate(
    userId: string,
    marketKey?: string,
  ): Promise<FeedValidationReport> {
    const store = await this.storeOf(userId);
    const settings = await this.ensureToken(store.id);
    const market = await this.markets.resolve(store.id, marketKey);
    const { items, products, skipped } = await this.collect(
      store,
      settings,
      market,
    );
    const missingGtin: { id: string; title: string }[] = [];
    const missingBrand: { id: string; title: string }[] = [];
    let missingIdentifier = 0;
    const locale = this.localeOf(store, market);
    for (const p of products) {
      const title = pickTranslation(p.translations, locale)?.title ?? p.id;
      if (!p.gtin) missingGtin.push({ id: p.id, title });
      if (!p.brand && !settings.default_brand) {
        missingBrand.push({ id: p.id, title });
      }
      if (!p.gtin && !p.mpn) missingIdentifier++;
    }
    const excludedRows = await this.prisma.product.findMany({
      where: { creator_id: store.creator_id, feed_excluded: true },
      select: {
        id: true,
        translations: { select: { locale: true, title: true } },
      },
      take: 200,
      orderBy: { updated_at: 'desc' },
    });
    return {
      market_key: market?.key ?? null,
      currency: await this.currencyOf(store, market),
      products: products.length,
      items: items.length,
      skipped,
      missing_gtin: missingGtin.slice(0, 100),
      missing_brand: missingBrand.slice(0, 100),
      missing_identifier: missingIdentifier,
      excluded: excludedRows.map((p) => ({
        id: p.id,
        title: pickTranslation(p.translations, locale)?.title ?? p.id,
      })),
    };
  }

  private async storeOf(userId: string): Promise<FeedStore> {
    const { id } = await this.storeApps.storeOfCreator(userId);
    const store = await this.prisma.store.findUnique({
      where: { id },
      select: feedStoreSelect,
    });
    if (!store) {
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    }
    return store;
  }

  private async rawSettings(
    storeId: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await this.prisma.storeApp.findUnique({
      where: { store_id_app_key: { store_id: storeId, app_key: 'feeds' } },
      select: { settings: true },
    });
    return row?.settings && typeof row.settings === 'object'
      ? (row.settings as Record<string, unknown>)
      : null;
  }

  /** Normalised settings with a token, generating and storing one if missing. */
  private async ensureToken(storeId: string): Promise<FeedsSettings> {
    const settings = normalizeFeedsSettings(
      (await this.rawSettings(storeId)) ?? {},
    );
    if (settings.token) return settings;
    const next = { ...settings, token: generateFeedToken() };
    await this.storeApps.updateSettings(storeId, 'feeds', next);
    await this.storeApps.settingsChanged(storeId);
    return next;
  }

  private async urlsOf(
    store: FeedStore,
    settings: FeedsSettings,
  ): Promise<FeedUrls[]> {
    const apiBase = (
      this.config.get<string>('PUBLIC_API_URL') || 'http://localhost:3001'
    ).replace(/\/$/, '');
    const base = `${apiBase}/api/feeds/${encodeURIComponent(store.slug)}/${settings.token}`;
    const markets = await this.markets.listLive(store.id);
    if (!markets || markets.length === 0) {
      return [
        {
          market_key: null,
          market_name: null,
          currency: await this.currencyOf(store, null),
          google: `${base}/google.xml`,
          facebook: `${base}/facebook.csv`,
        },
      ];
    }
    return markets.map((m) => {
      const q = m.is_default ? '' : `?market=${encodeURIComponent(m.key)}`;
      return {
        market_key: m.key,
        market_name: m.name,
        currency: m.currency,
        google: `${base}/google.xml${q}`,
        facebook: `${base}/facebook.csv${q}`,
      };
    });
  }

  // ── Item building ─────────────────────────────────────────────────────────

  private async collect(
    store: FeedStore,
    settings: FeedsSettings,
    market: MarketContext | null,
  ): Promise<{
    items: FeedItem[];
    products: FeedProductRow[];
    skipped: { excluded: number; hidden_in_market: number };
  }> {
    const where: Prisma.ProductWhereInput = {
      creator_id: store.creator_id,
      status: 'PUBLISHED',
      feed_excluded: false,
    };
    if (market) {
      // Products the creator switched off in this market are not listed.
      where.NOT = {
        market_prices: {
          some: { market_id: market.id, variant_id: null, available: false },
        },
      };
    }
    const [rows, excluded, collections, currency] = await Promise.all([
      this.prisma.product.findMany({
        where,
        select: feedProductSelect,
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.product.count({
        where: {
          creator_id: store.creator_id,
          status: 'PUBLISHED',
          feed_excluded: true,
        },
      }),
      this.loadCollections(store.creator_id),
      this.currencyOf(store, market),
    ]);
    const priceRows = market
      ? await this.marketPricing.loadPrices(
          market.id,
          rows.map((p) => p.id),
        )
      : null;
    const tax = await this.taxSetup(store, market);
    const locale = this.localeOf(store, market);
    const baseUrl = this.storeLink(store, market);
    const shippingCountries = market?.countries.length
      ? market.countries
      : tax.ctx.taxCountry
        ? [tax.ctx.taxCountry]
        : [];
    const shipping = settings.shipping_label
      ? shippingCountries.map((country) => ({
          country,
          service: settings.shipping_label as string,
        }))
      : [];

    const items: FeedItem[] = [];
    const products: FeedProductRow[] = [];
    let hidden = 0;
    for (const p of rows) {
      const priced = this.priceOf(p, market, priceRows?.get(p.id));
      if (priced.hidden) {
        hidden++;
        continue;
      }
      products.push(p);
      const tr = pickTranslation(p.translations, locale);
      if (!tr) continue;
      const gross = (amount: number) => this.grossOf(tax, p, amount, currency);
      const productImages = p.images.filter((i) => !i.variant_id);
      const featured = productImages.find((i) => i.is_featured);
      const orderedImages = featured
        ? [featured, ...productImages.filter((i) => i !== featured)]
        : productImages;
      const path = collectionPath(p.creator_categories, collections, locale);
      const base = {
        title: tr.title,
        description: tr.description || '',
        link: `${baseUrl}/products/${encodeURIComponent(tr.slug)}`,
        currency,
        brand: p.brand || settings.default_brand,
        gtin: p.gtin,
        mpn: p.mpn,
        condition: conditionOf(p.condition),
        google_product_category: p.google_product_category,
        product_type: path.path,
        custom_label_0: path.leaf,
        shipping,
      };
      // Google semantics: `price` is the regular price, `sale_price` the
      // one the customer pays; a compare-at price is the regular one.
      const prices = (price: number, compareAt: number | undefined) => {
        const current = gross(price);
        const regular =
          compareAt && compareAt > price ? gross(compareAt) : null;
        return regular
          ? { price: regular, sale_price: current }
          : { price: current, sale_price: null };
      };
      if (settings.include_variants && p.variants.length > 0) {
        for (const v of p.variants) {
          const pv = priced.variants.find((x) => x.id === v.id);
          if (!pv) continue;
          const vImages = [
            ...v.images.map((i) => i.url),
            ...orderedImages.map((i) => i.url),
          ];
          const opts = optionsOf(v.options);
          items.push({
            ...base,
            id: v.id,
            item_group_id: p.id,
            ...prices(pv.price, pv.compare_at_price),
            availability: availabilityOf(
              p.track_inventory,
              v.stock_quantity ?? p.stock_quantity,
            ),
            image_link: vImages[0] ?? null,
            additional_image_links: vImages.slice(1),
            color: opts.color,
            size: opts.size,
          });
        }
      } else {
        items.push({
          ...base,
          id: p.id,
          item_group_id: null,
          ...prices(priced.base_price, priced.compare_at_price),
          availability: availabilityOf(p.track_inventory, p.stock_quantity),
          image_link: orderedImages[0]?.url ?? null,
          additional_image_links: orderedImages.slice(1).map((i) => i.url),
          color: null,
          size: null,
        });
      }
    }
    return {
      items,
      products,
      skipped: { excluded, hidden_in_market: hidden },
    };
  }

  /** Market prices through the pricing helper; base prices without a market. */
  private priceOf(
    p: FeedProductRow,
    market: MarketContext | null,
    rows: ReturnType<
      Awaited<ReturnType<MarketPricingService['loadPrices']>>['get']
    >,
  ) {
    const basePrice = Number(p.base_price);
    if (market) {
      return this.marketPricing.priceProduct(
        market,
        {
          id: p.id,
          base_price: basePrice,
          compare_at_price: p.compare_at_price
            ? Number(p.compare_at_price)
            : null,
          variants: p.variants.map((v) => ({
            id: v.id,
            price_adjustment: v.price_adjustment,
            compare_at_price: v.compare_at_price
              ? Number(v.compare_at_price)
              : null,
          })),
        },
        rows,
      );
    }
    return {
      hidden: false,
      base_price: basePrice,
      compare_at_price: p.compare_at_price
        ? Number(p.compare_at_price)
        : undefined,
      variants: p.variants.map((v) => ({
        id: v.id,
        price: basePrice + Number(v.price_adjustment || 0),
        compare_at_price: v.compare_at_price
          ? Number(v.compare_at_price)
          : undefined,
      })),
    };
  }

  /**
   * Customer-facing (gross) price: INCLUSIVE stores keep their prices; an
   * EXCLUSIVE store adds the rate of the product's class for the market's
   * first country (the registration country without a market).
   */
  private grossOf(
    tax: TaxSetup,
    product: { tax_class_id: string | null; tax_exempt: boolean },
    amount: number,
    currency: string,
  ): number {
    if (tax.ctx.pricingMode === TaxPricingMode.INCLUSIVE) {
      return roundMoney(amount, currency);
    }
    const rateBp = effectiveRateBp(
      resolveRatesForLine(tax.ctx, tax.data, product, {
        country: tax.country,
      }).rates,
    );
    return roundMoney(amount * (1 + rateBp / 10000), currency);
  }

  private async taxSetup(
    store: FeedStore,
    market: MarketContext | null,
  ): Promise<TaxSetup> {
    const ctx = await this.taxService.contextFor(store);
    const data =
      ctx.pricingMode === TaxPricingMode.INCLUSIVE
        ? { rates: [], classes: [] }
        : await this.taxService.loadTaxData(ctx);
    return { ctx, data, country: market?.countries[0] ?? ctx.taxCountry };
  }

  private async currencyOf(
    store: FeedStore,
    market: MarketContext | null,
  ): Promise<string> {
    if (market) return market.currency;
    const config = await this.prisma.platformConfig.findFirst({
      select: { default_currency: true },
    });
    return resolveStoreCurrency(store, config?.default_currency);
  }

  private localeOf(store: FeedStore, market: MarketContext | null): string {
    return (
      market?.defaultLocale || store.language_config?.primary_locale || 'en'
    );
  }

  /** Public base URL of the store in the market (no trailing slash). */
  private storeLink(store: FeedStore, market: MarketContext | null): string {
    if (market?.primaryHostname) return `https://${market.primaryHostname}`;
    if (store.custom_domain) {
      return `https://${store.custom_domain.replace(/\/$/, '')}`;
    }
    const base = (
      this.config.get<string>('STOREFRONT_URL') || 'http://localhost:3003'
    ).replace(/\/$/, '');
    return `${base}/store/${store.slug}`;
  }

  private async loadCollections(
    creatorId: string,
  ): Promise<Map<string, CollectionNode>> {
    const rows = await this.prisma.creatorCategory.findMany({
      where: { creator_id: creatorId },
      select: {
        id: true,
        parent_id: true,
        translations: { select: { locale: true, name: true } },
      },
    });
    const map = new Map<string, CollectionNode>();
    for (const r of rows) {
      map.set(r.id, {
        id: r.id,
        parent_id: r.parent_id,
        names: new Map(r.translations.map((t) => [t.locale, t.name])),
      });
    }
    return map;
  }
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Constant-time token comparison (both are short ASCII strings). */
export function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function pickTranslation<T extends { locale: string }>(
  rows: T[],
  locale: string,
): T | null {
  return (
    rows.find((t) => t.locale === locale) ??
    rows.find((t) => t.locale === 'en') ??
    rows[0] ??
    null
  );
}

export function conditionOf(value: string | null): FeedCondition {
  return value === 'refurbished' || value === 'used' ? value : 'new';
}

export function availabilityOf(
  trackInventory: boolean,
  stock: number | null | undefined,
): 'in_stock' | 'out_of_stock' {
  if (!trackInventory) return 'in_stock';
  return (stock ?? 0) > 0 ? 'in_stock' : 'out_of_stock';
}

/** Colour / size from a variant's `options` by option name. */
export function optionsOf(options: unknown): {
  color: string | null;
  size: string | null;
} {
  const out = { color: null as string | null, size: null as string | null };
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return out;
  }
  for (const [name, value] of Object.entries(
    options as Record<string, unknown>,
  )) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const key = name.trim().toLowerCase();
    if (out.color == null && COLOR_OPTION_NAMES.includes(key)) {
      out.color = value.trim();
    } else if (out.size == null && SIZE_OPTION_NAMES.includes(key)) {
      out.size = value.trim();
    }
  }
  return out;
}

/** "Parent > Child" of the product's first collection, plus the leaf name. */
export function collectionPath(
  links: { creator_category_id: string }[],
  collections: Map<string, CollectionNode>,
  locale: string,
): { path: string | null; leaf: string | null } {
  const first = links
    .map((l) => collections.get(l.creator_category_id))
    .find((n): n is CollectionNode => Boolean(n));
  if (!first) return { path: null, leaf: null };
  const nameOf = (n: CollectionNode) =>
    n.names.get(locale) ??
    n.names.get('en') ??
    n.names.values().next().value ??
    '';
  const chain: string[] = [];
  let node: CollectionNode | undefined = first;
  const seen = new Set<string>();
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    chain.unshift(nameOf(node));
    node = node.parent_id ? collections.get(node.parent_id) : undefined;
  }
  const names = chain.filter(Boolean);
  return {
    path: names.length ? names.join(' > ') : null,
    leaf: nameOf(first) || null,
  };
}
