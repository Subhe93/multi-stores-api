import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ProductStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { PersonalizationCoreService } from '../../common/personalization/personalization-core.service';
import { createServerPatternTester } from '../../common/personalization/pattern-tester';
import {
  evaluatePersonalization,
  readUi,
} from '../../common/personalization/evaluator';
import type {
  PContext,
  PFieldDef,
  PResult,
} from '../../common/personalization/types';
import {
  resolveStoreCurrency,
  roundMoney,
} from '../../common/money/currency.util';
import { ShippingService } from '../shipping/shipping.service';
import { MarketsContextService } from '../markets/markets-context.service';
import { MarketPricingService } from '../markets/market-pricing.service';
import type { MarketContext } from '../markets/market-context';
import {
  parsePersonalizationSettings,
  type PersonalizationSettings,
} from './personalization-settings';
import {
  activeOptionValuesOf,
  linesToDisplay,
  readOptionConfig,
  readVariantOptions,
  usesAdvancedFields,
  type PersonalizationDisplayLine,
} from './personalization-runtime';
import type { ValidatePersonalizationDto } from './dto/validate-personalization.dto';
import {
  MAX_MONEY_AMOUNT,
  PERSONALIZATION_PRICE_TOO_HIGH,
  personalizationUnavailable,
  priceTooHigh,
  variantRequired,
} from './personalization.errors';

/**
 * Per-request memo of the active variants of each product (one query per
 * product across a whole cart / order, M4.1 batching). Create one per
 * cart read, cart write, quote or order and pass it to every line.
 */
export type ActiveVariantsCache = Map<string, Promise<ActiveVariants>>;

export interface ActiveVariants {
  count: number;
  values: Record<string, string[]>;
}

/** Throws 400 PERSONALIZATION_PRICE_TOO_HIGH when the evaluator refused the price. */
export function assertPriceEvaluated(result: PResult): void {
  if (result.errors.some((e) => e.code === PERSONALIZATION_PRICE_TOO_HIGH)) {
    throw priceTooHigh();
  }
}

/** Throws 400 PERSONALIZATION_PRICE_TOO_HIGH when an amount does not fit Decimal(10,2). */
export function assertAmountFits(...amounts: number[]): void {
  if (amounts.some((a) => !Number.isFinite(a) || a > MAX_MONEY_AMOUNT)) {
    throw priceTooHigh();
  }
}

/** The store a line is sold from, as the runtime flows need it. */
export interface PersonalizationStore {
  id: string;
  creator_id: string;
  primary_locale: string | null;
}

/** The product columns a line evaluation reads. */
export interface PersonalizationProduct {
  id: string;
  variant_option_config?: unknown;
}

/** `POST /storefront/:slug/personalization/validate` → `data` (contract §3). */
export interface PersonalizationValidateResult {
  ok: boolean;
  errors: PResult['errors'];
  /** Canonical values (what the cart line stores and keys on). */
  custom_fields: Record<string, unknown>;
  /** Per unit, in `currency`. */
  price_delta: number;
  /** Per unit incl. `price_delta`, before any bundle; null when not sellable in the market. */
  unit_price: number | null;
  currency: string;
  display: PersonalizationDisplayLine[];
}

/**
 * Runtime entry of the personalization app (M4.1 §4.1). WP-B: the gate (D2)
 * and the definition loader. WP-C: line evaluation for the cart, the quote
 * and order create, the storefront shaping, the free-shipping threshold and
 * the public validate endpoint.
 *
 * The app path runs only when the app is on for the product (D2) AND the
 * product uses an M4.1 feature; every other line keeps the M4.0 code path
 * unchanged (D10, G0).
 */
@Injectable()
export class PersonalizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storeApps: StoreAppsService,
    // WP-C collaborators, required (M5 A16): specs build the service with
    // `__fixtures__/personalization-service.factory.ts`.
    private readonly core: PersonalizationCoreService,
    private readonly shipping: ShippingService,
    private readonly markets: MarketsContextService,
    // Markets app pricing: optional, a store without markets never needs it.
    @Optional() private readonly marketPricing?: MarketPricingService,
  ) {}

  /** Whether the app is in effect for the store (cached by StoreAppsService). */
  isEnabled(storeId: string): Promise<boolean> {
    return this.storeApps.isEnabled(storeId, 'personalization');
  }

  /**
   * Whether the app is in effect, failing closed: when the app rows cannot
   * be read (DB failure) this throws 503 PERSONALIZATION_UNAVAILABLE
   * instead of answering "off". Only asked for products with M4.1 config;
   * every other product keeps the lenient M4.0 behaviour.
   */
  async isEnabledStrict(storeId: string): Promise<boolean> {
    const state = await this.storeApps.enabledOrUnknown(
      storeId,
      'personalization',
    );
    if (state === null) throw personalizationUnavailable();
    return state;
  }

  /** Active variants of a product (count and option values), memoized per request. */
  activeVariants(
    productId: string,
    cache?: ActiveVariantsCache,
  ): Promise<ActiveVariants> {
    const cached = cache?.get(productId);
    if (cached) return cached;
    const load = this.prisma.productVariant
      .findMany({
        where: { product_id: productId, is_active: true },
        select: { options: true },
      })
      .then((rows) => ({
        count: rows.length,
        values: activeOptionValuesOf(rows),
      }));
    cache?.set(productId, load);
    return load;
  }

  /**
   * M4.1: a product with active variants needs the chosen variant to
   * evaluate its app config (conditions, repeat counts and palettes read
   * the variant's options): 400 PERSONALIZATION_VARIANT_REQUIRED otherwise.
   * Only called on the app path; M4.0 lines are unchanged.
   */
  async assertVariantChosen(
    productId: string,
    variantId: string | null | undefined,
    cache?: ActiveVariantsCache,
  ): Promise<void> {
    if (variantId) return;
    if ((await this.activeVariants(productId, cache)).count > 0) {
      throw variantRequired();
    }
  }

  /** The app's settings, leniently parsed (defaults when off or unset). */
  async settings(storeId: string): Promise<PersonalizationSettings> {
    return parsePersonalizationSettings(
      await this.storeApps.getSettings(storeId, 'personalization'),
    );
  }

  /** The product's fields (top level and children) with translations, in evaluation order. */
  loadDefs(productId: string) {
    return this.prisma.productCustomField.findMany({
      where: { product_id: productId },
      include: { translations: true },
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    });
  }

  /** True when the product's fields need the app path (pure, no query). */
  needsEvaluator(defs: readonly PFieldDef[] | null | undefined): boolean {
    return usesAdvancedFields(defs);
  }

  /**
   * The store of a creator's own product when the app is on there, else
   * null (the line then keeps the M4.0 path). One store query plus the
   * cached app flag; callers ask only for products with M4.1 fields.
   */
  async appStoreForCreator(
    creatorId: string | null | undefined,
  ): Promise<PersonalizationStore | null> {
    if (!creatorId) return null;
    const store = await this.prisma.store.findUnique({
      where: { creator_id: creatorId },
      select: {
        id: true,
        creator_id: true,
        language_config: { select: { primary_locale: true } },
      },
    });
    if (!store) return null;
    // Callers ask only for products with M4.1 fields: fail closed (503).
    if (!(await this.isEnabledStrict(store.id))) return null;
    return {
      id: store.id,
      creator_id: store.creator_id,
      primary_locale: store.language_config?.primary_locale ?? null,
    };
  }

  /**
   * The evaluator context of one line (§3.1): option picks from the
   * variant, the option config, and — only when a palette reads an option —
   * the option values present on active variants (one query).
   */
  async contextFor(input: {
    product: PersonalizationProduct;
    variantOptions: unknown;
    defs: readonly PFieldDef[];
    locale?: string | null;
    primaryLocale?: string | null;
    activeCache?: ActiveVariantsCache;
  }): Promise<PContext> {
    const needsActive = input.defs.some((d) => {
      const option = readUi(d.ui).palette_from_option;
      return typeof option === 'string' && option !== '';
    });
    const activeOptionValues = needsActive
      ? (await this.activeVariants(input.product.id, input.activeCache)).values
      : undefined;
    const primary = input.primaryLocale || input.locale || 'en';
    return {
      appEnabled: true,
      variantOptions: readVariantOptions(input.variantOptions),
      optionConfig: readOptionConfig(input.product.variant_option_config),
      ...(activeOptionValues ? { activeOptionValues } : {}),
      locale: input.locale || primary,
      primaryLocale: primary,
      isFileRef: this.core.isFileRef,
      patternTester: createServerPatternTester(),
    };
  }

  /**
   * Evaluates one line in app mode (§3.2). Price, values and lines come
   * from the definitions only; nothing but the raw values is read from the
   * client (D4). The caller decides what an error means (400 or soft).
   */
  async evaluateLine(input: {
    product: PersonalizationProduct;
    variantOptions: unknown;
    defs: readonly PFieldDef[];
    raw: unknown;
    locale?: string | null;
    primaryLocale?: string | null;
    activeCache?: ActiveVariantsCache;
  }): Promise<PResult> {
    const ctx = await this.contextFor(input);
    return evaluatePersonalization(input.defs, input.raw, ctx);
  }

  /**
   * Free-shipping threshold for the variation cards (§4.7) in the request
   * currency: the settings' country, else the market's first country, else
   * the store's tax country, else the platform's. Null when the badge is off,
   * no threshold exists, or the market cannot convert base amounts.
   */
  async freeShippingThreshold(
    productId: string,
    store: { tax_country?: string | null },
    market: MarketContext | null,
    settings: PersonalizationSettings,
    /** The product's own profile when already loaded (saves the resolution). */
    profile?: Parameters<ShippingService['freeThresholdFor']>[2],
  ): Promise<number | null> {
    if (!settings.free_shipping_badge) return null;
    let country =
      settings.free_shipping_country ??
      market?.countries?.[0] ??
      store.tax_country ??
      null;
    if (!country) {
      const config = await this.prisma.platformConfig.findFirst({
        select: { platform_tax_country: true },
      });
      country = config?.platform_tax_country ?? null;
    }
    if (!country) return null;
    const threshold = profile
      ? await this.shipping.freeThresholdFor(productId, country, profile)
      : await this.shipping.freeThresholdFor(productId, country);
    if (threshold == null) return null;
    if (!market) return threshold;
    if (market.rate == null || !this.marketPricing) return null;
    return this.marketPricing.convertMoney(market, threshold);
  }

  /** A base-currency per-unit delta in the request currency (D4). */
  convertDelta(market: MarketContext | null, delta: number): number {
    if (!(delta > 0)) return 0;
    if (!market) return roundMoney(delta);
    if (!this.marketPricing) return roundMoney(delta);
    return this.marketPricing.convertMoney(market, delta);
  }

  /**
   * `POST /storefront/:slug/personalization/validate` (D14): a guest's line
   * checked before it enters the local cart. Answers 200 with `ok:false`
   * and the errors when the values do not pass; the unit price is the
   * market price of the variant plus the converted delta, before bundles.
   */
  async validateForStorefront(
    storeId: string,
    body: ValidatePersonalizationDto,
  ): Promise<PersonalizationValidateResult> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        creator_id: true,
        store_type: true,
        currency: true,
        language_config: { select: { primary_locale: true } },
      },
    });
    const product = store
      ? await this.prisma.product.findFirst({
          where: {
            id: body.product_id,
            creator_id: store.creator_id,
            status: ProductStatus.PUBLISHED,
          },
          select: {
            id: true,
            base_price: true,
            variant_option_config: true,
          },
        })
      : null;
    if (!store || !product) throw productNotFound();
    const variant = body.variant_id
      ? await this.prisma.productVariant.findFirst({
          where: {
            id: body.variant_id,
            product_id: product.id,
            is_active: true,
          },
          select: { id: true, options: true, price_adjustment: true },
        })
      : null;
    if (body.variant_id && !variant) throw productNotFound();

    const market = await this.markets.resolve(
      store.id,
      body.market ?? undefined,
    );
    const defs = (await this.loadDefs(product.id)) as unknown as PFieldDef[];
    const activeCache: ActiveVariantsCache = new Map();
    const result = await this.evaluateLine({
      activeCache,
      product,
      variantOptions: variant?.options ?? {},
      defs,
      raw: body.custom_fields ?? {},
      locale: body.locale ?? null,
      primaryLocale: store.language_config?.primary_locale ?? null,
    });
    assertPriceEvaluated(result);

    const basePrice = Number(product.base_price);
    const adjustment = Number(variant?.price_adjustment ?? 0);
    let price: number | null = basePrice + adjustment;
    if (market && this.marketPricing) {
      price = await this.marketPricing.priceLine(market, {
        product_id: product.id,
        variant_id: variant?.id ?? null,
        basePrice,
        adjustment,
      });
    }
    let delta = 0;
    if (result.priceDeltaMinor > 0) {
      try {
        delta = this.convertDelta(market, Number(result.priceDelta));
      } catch {
        // A market that cannot convert base amounts cannot price the line.
        price = null;
      }
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
    const unitPrice = price == null ? null : roundMoney(price + delta);
    assertAmountFits(delta, unitPrice ?? 0);
    return {
      ok: result.ok,
      errors: result.errors,
      custom_fields: result.values,
      price_delta: delta,
      unit_price: unitPrice,
      currency,
      display: linesToDisplay(result.lines),
    };
  }
}

function productNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'STOREFRONT_PRODUCT_NOT_FOUND',
    message: 'Product not found',
  });
}
