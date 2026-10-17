import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { BundleOffer, CartItem, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AddCartItemDto, UpdateCartItemDto } from './dto/cart.dto';
import { computeBundlePricing } from '../bundles/bundle-pricing.util';
import { resolveVariantImage } from '../../common/catalog/variant-image.util';
import {
  resolveStoreCurrency,
  roundMoney,
} from '../../common/money/currency.util';
import {
  TaxService,
  taxStoreSelect,
  type TaxLineInput,
} from '../taxes/tax.service';
import { validateBundleEconomics } from '../bundles/bundle-economics.util';
import { MarketsContextService } from '../markets/markets-context.service';
import {
  MarketPricingService,
  pricingContext,
  type MarketPriceMap,
} from '../markets/market-pricing.service';
import type { MarketContext } from '../markets/market-context';
import { resolveVariantMarketPrice } from '../markets/pricing.util';
import { B2bService } from '../b2b/b2b.service';
import type { B2bTotals } from '../b2b/b2b.types';
import { pickTranslation } from '../../common/personalization/pick-translation';
import {
  PersonalizationCoreService,
  PRODUCT_VARIANT_MISMATCH,
  type LineContext,
} from '../../common/personalization/personalization-core.service';
import {
  cartRowLineKey,
  storedCustomFields,
} from '../../common/personalization/cart-line-key';
import {
  lineKey,
  type NormalizedValues,
} from '../../common/personalization/rules';
import {
  assertAmountFits,
  assertPriceEvaluated,
  PersonalizationService,
  type ActiveVariantsCache,
  type PersonalizationStore,
} from '../personalization/personalization.service';
import { PERSONALIZATION_PRICE_TOO_HIGH } from '../personalization/personalization.errors';
import {
  linesToDisplay,
  personalizationInvalid,
} from '../personalization/personalization-runtime';
import type { PFieldDef, PResult } from '../../common/personalization/types';
import {
  DesignerCartService,
  type CartDesignView,
} from '../designer/designer-cart.service';

// Shape of a product custom field as loaded with its translations.
/** One cart line as GET /cart returns it (enrichCartItems output). */
export interface EnrichedCartItem {
  id: string;
  productId: string | null;
  variantId: string | null;
  customProductId: string | null;
  quantity: number;
  customFields: unknown;
  customFieldDisplay: CustomFieldDisplay[];
  title: string | null;
  price: number;
  imageUrl: string | null;
  variant: string | null;
  currency: string;
  bundleOfferId: string | null;
  bundleOriginalUnitPrice: number | null;
  bundleTitle: string | null;
  bundleLabel: string | null;
  bundleStickerText: string | null;
  bundleCartQuantity: number | null;
  /**
   * Markets app only: the product is hidden in the request's market (switched
   * off there, or no override and no exchange rate). The key is absent
   * otherwise, so a response without a market is unchanged.
   */
  unavailable_in_market?: true;
  /**
   * Personalization app only (M4.1): the stored values no longer pass the
   * product's rules (config changed since the add). Absent otherwise.
   */
  personalization_invalid?: true;
  /**
   * Designer app only (M4.2): the line's design (text values, signed proof).
   * Absent on every other line.
   */
  design?: CartDesignView;
}

/** 400 code of an add/update of a product hidden in the request's market. */
export const CART_ITEM_NOT_AVAILABLE_IN_MARKET =
  'CART_ITEM_NOT_AVAILABLE_IN_MARKET';

interface CustomFieldDef {
  id: string;
  name: string;
  translations: {
    locale: string;
    label: string;
    option_labels?: unknown;
  }[];
}

// One displayable "label: value" line for a cart item's custom fields.
export interface CustomFieldDisplay {
  id: string;
  label: string;
  value: unknown;
  /** Translated option label when the value is one of the field's options. */
  display: string | null;
  // Personalization app only (M4.1, contract §5): present on app lines.
  group_key?: string;
  group_index?: number;
  group_label?: string;
  hex?: string;
  source?: 'FIELD' | 'OPTION';
}

@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name);
  constructor(
    private prisma: PrismaService,
    private readonly taxService: TaxService,
    private readonly markets: MarketsContextService,
    private readonly marketPricing: MarketPricingService,
    private readonly b2b: B2bService,
    // M4.0: the personalization core, required (M5 A16: no fallback built
    // on the fly; specs pass `buildPersonalizationCore(prisma)`).
    private readonly core: PersonalizationCoreService,
    // M4.1 personalization app: optional and trailing. Absent = every line
    // takes the M4.0 path.
    @Optional() private readonly personalization?: PersonalizationService,
    // M4.2 designer app (C28/C29): optional and trailing. Absent = no line
    // is ever a designer line (a sent design_id is not stored).
    @Optional() private readonly designerCart?: DesignerCartService,
  ) {}

  /**
   * Personalization app (M4.1 C29 step 3): evaluates a cart line in app
   * mode when the app is on for its product (D2) and the product uses an
   * M4.1 feature; null otherwise, and the caller keeps the M4.0 rules. No
   * query for a product without M4.1 fields.
   */
  private async evaluateAppLine(
    line: {
      product_id?: string | null;
      variant_id?: string | null;
      custom_product_id?: string | null;
    },
    ctx: LineContext,
    raw: unknown,
    locale?: string,
  ): Promise<PResult | null> {
    // M4.1: a variant-only line has its product resolved by loadContexts.
    const productId = line.product_id || ctx.productId;
    if (!this.personalization || line.custom_product_id || !productId) {
      return null;
    }
    const defs = (ctx.allFields ?? ctx.fields) as unknown as PFieldDef[];
    if (!this.personalization.needsEvaluator(defs)) return null;
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, creator_id: true, variant_option_config: true },
    });
    if (!product) return null;
    // Fails closed (503) when the app state cannot be read.
    const store = await this.personalization.appStoreForCreator(
      product.creator_id,
    );
    if (!store) return null;
    await this.personalization.assertVariantChosen(product.id, line.variant_id);
    const variant = line.variant_id
      ? await this.prisma.productVariant.findUnique({
          where: { id: line.variant_id },
          select: { options: true },
        })
      : null;
    return this.personalization.evaluateLine({
      product,
      variantOptions: variant?.options ?? {},
      defs,
      raw,
      locale,
      primaryLocale: store.primary_locale,
    });
  }

  /**
   * Validated, normalized values of a cart write: the app evaluator (400
   * `PERSONALIZATION_INVALID {errors}`) or the M4.0 rules (400
   * `CUSTOM_FIELD_*`).
   */
  private async assertCartLine(
    line: {
      product_id?: string | null;
      variant_id?: string | null;
      custom_product_id?: string | null;
    },
    ctx: LineContext,
    raw: unknown,
    locale?: string,
  ): Promise<Record<string, unknown>> {
    const app = await this.evaluateAppLine(line, ctx, raw, locale);
    if (!app) return this.core.assertLine(raw, ctx, locale);
    assertPriceEvaluated(app);
    if (!app.ok) throw personalizationInvalid(app.errors);
    return app.values;
  }

  /**
   * The row of this cart a line merges into (M4.0 §1.2): same product,
   * variant, custom product and bundle, and the same personalization line
   * key. A product without fields keeps the exact pre-M4.0 lookup.
   */
  private async findMergeTarget(
    cartId: string,
    line: {
      product_id?: string | null;
      variant_id?: string | null;
      custom_product_id?: string | null;
      bundle_offer_id?: string | null;
    },
    ctx: LineContext,
    normalized: Record<string, unknown>,
    excludeId?: string,
    designId: string | null = null,
  ): Promise<CartItem | null> {
    const where: Prisma.CartItemWhereInput = {
      cart_id: cartId,
      product_id: line.product_id || null,
      variant_id: line.variant_id || null,
      custom_product_id: line.custom_product_id || null,
      bundle_offer_id: line.bundle_offer_id || null,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    };
    // M4.2 (C11): a designer line carries no field values, so the same
    // design is the same line. Lines without a design keep the exact
    // pre-M4.2 query (G0) and never merge into a designed row.
    if (designId) {
      return this.prisma.cartItem.findFirst({
        where: { ...where, design_id: designId },
      });
    }
    const all = ctx.allFields ?? ctx.fields;
    if (all.length === 0) {
      const hit = await this.prisma.cartItem.findFirst({ where });
      // Only possible once the designer was switched off for a product
      // that still has designed rows in this cart.
      if (hit?.design_id) {
        return this.prisma.cartItem.findFirst({
          where: { ...where, design_id: null },
        });
      }
      return hit;
    }
    // Every field row (M4.1 repeaters too): app values key on them.
    const fieldIds = new Set(all.map((f) => f.id));
    const key = lineKey(normalized);
    const rows = await this.prisma.cartItem.findMany({ where });
    return (
      rows.find(
        (r) =>
          !r.design_id && cartRowLineKey(r.custom_fields, fieldIds) === key,
      ) ?? null
    );
  }

  /**
   * Market context of a cart read (?market=, markets app). The store is the
   * one the first own/custom product line belongs to (one cart per store);
   * null when the cart is empty or the app is off.
   */
  private async resolveCartMarket(
    items: { product_id: string | null; custom_product_id: string | null }[],
    marketKey?: string,
  ): Promise<MarketContext | null> {
    const first = items.find((i) => i.product_id || i.custom_product_id);
    if (!first) return null;
    let creatorId: string | null = null;
    if (first.custom_product_id) {
      const cp = await this.prisma.customProduct.findUnique({
        where: { id: first.custom_product_id },
        select: { creator_id: true },
      });
      creatorId = cp?.creator_id ?? null;
    } else if (first.product_id) {
      const p = await this.prisma.product.findUnique({
        where: { id: first.product_id },
        select: { creator_id: true },
      });
      creatorId = p?.creator_id ?? null;
    }
    if (!creatorId) return null;
    const store = await this.prisma.store.findUnique({
      where: { creator_id: creatorId },
      select: { id: true },
    });
    if (!store) return null;
    return this.markets.resolve(store.id, marketKey);
  }

  private async getOrCreateCart(userId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { user_id: userId },
    });
    if (!customer)
      throw new NotFoundException({
        code: 'CART_CUSTOMER_NOT_FOUND',
        message: 'Customer not found',
      });

    let cart = await this.prisma.cart.findUnique({
      where: { customer_id: customer.id },
    });

    if (!cart) {
      cart = await this.prisma.cart.create({
        data: { customer_id: customer.id },
      });
    }

    return cart;
  }

  /**
   * Pick the translation row for the requested locale, falling back to English
   * and then the first available row. Without this the caller would have to
   * rely on row order, which is alphabetical by locale ('ar' before 'en') and
   * therefore returns the wrong language for the storefront's active locale.
   */
  /**
   * Resolve the values a customer typed into a product's custom fields into
   * something displayable: the field's label in the requested locale and, for
   * option fields, the translated option label. Keys the customer's cart no
   * longer has a definition for are still returned (label = the raw key) so
   * nothing silently disappears.
   */
  private buildCustomFieldDisplay(
    defs: CustomFieldDef[],
    values: unknown,
    locale?: string,
  ): CustomFieldDisplay[] {
    if (!values || typeof values !== 'object' || Array.isArray(values))
      return [];
    return Object.entries(values as Record<string, unknown>)
      .filter(([, v]) => v !== '' && v != null)
      .map(([fieldId, value]) => {
        const def = defs.find((d) => d.id === fieldId);
        const tr = def
          ? this.pickTranslation(def.translations, locale)
          : undefined;
        const display =
          typeof value === 'string' && tr?.option_labels
            ? ((tr.option_labels as Record<string, string>)[value] ?? null)
            : null;
        return {
          id: fieldId,
          label: tr?.label || def?.name || fieldId,
          value,
          display,
        };
      });
  }

  private pickTranslation<T extends { locale: string }>(
    translations: T[] | undefined,
    locale?: string,
  ): T | undefined {
    return pickTranslation(translations, locale);
  }

  /**
   * Enrich raw cart items with product data (title, price, image, variant info).
   * `locale` selects which translation to surface for the item title.
   */
  private async enrichCartItems(
    items: CartItem[],
    locale?: string,
    market: MarketContext | null = null,
  ) {
    const enriched: EnrichedCartItem[] = [];
    // M4.1: app store per creator, resolved once per read (only for
    // products with M4.1 fields).
    const appStores = new Map<string, Promise<PersonalizationStore | null>>();
    const appStoreOf = (creatorId: string) => {
      if (!appStores.has(creatorId)) {
        appStores.set(
          creatorId,
          this.personalization
            ? this.personalization.appStoreForCreator(creatorId)
            : Promise.resolve(null),
        );
      }
      return appStores.get(creatorId)!;
    };
    // M4.1: active variants per product, one query per product per read.
    const activeCache: ActiveVariantsCache = new Map();
    // M4.1: rows stored with a variant only (no product_id) resolve their
    // product through the variant, in one query.
    const variantOnly = items
      .filter((i) => !i.product_id && !i.custom_product_id && i.variant_id)
      .map((i) => i.variant_id as string);
    const productOfVariant = new Map<string, string>(
      variantOnly.length
        ? (
            await this.prisma.productVariant.findMany({
              where: { id: { in: [...new Set(variantOnly)] } },
              select: { id: true, product_id: true },
            })
          ).map((v) => [v.id, v.product_id])
        : [],
    );
    const ownProductIdOf = (item: CartItem): string | null =>
      item.custom_product_id
        ? null
        : (item.product_id ??
          (item.variant_id ? productOfVariant.get(item.variant_id) : null) ??
          null);
    const config = await this.prisma.platformConfig.findFirst();
    const platformCurrency = config?.default_currency || 'EUR';
    // Designer app (M4.2): the design block of designer lines, one query.
    const designIds = items
      .map((i) => i.design_id)
      .filter((id): id is string => !!id);
    const designViews =
      this.designerCart && designIds.length
        ? await this.designerCart.cartDesigns(designIds, locale)
        : null;
    // Markets app: override rows of every own product in the cart, one query.
    const marketRows: MarketPriceMap | null = market
      ? await this.marketPricing.loadPrices(
          market.id,
          items.map(ownProductIdOf).filter(Boolean) as string[],
        )
      : null;

    for (const item of items) {
      const itemProductId = ownProductIdOf(item);
      let title: string | null = null;
      let price = 0;
      let imageUrl: string | null = null;
      let variantLabel: string | null = null;
      const currency = market ? market.currency : platformCurrency;
      // Base price and variant adjustment of an own-product line, for the
      // market conversion below.
      let ownBasePrice = 0;
      let ownAdjustment = 0;
      // Per-value image map for the product behind this line, read once and
      // used when the chosen variant is resolved further down.
      let productOptionConfig: unknown = null;
      // Custom field definitions (with translations) of the product behind
      // this line, so the cart can show "Label: value" instead of field ids.
      let customFieldDefs: CustomFieldDef[] = [];
      // Markets app: set when the product is hidden in the market.
      let hiddenInMarket = false;
      // Personalization app (M4.1): the own product behind the line and the
      // chosen variant's options, for the evaluator below.
      let ownProduct: {
        id: string;
        creator_id: string | null;
        variant_option_config: unknown;
      } | null = null;
      let variantOptions: unknown = null;

      if (item.custom_product_id) {
        // Custom product: fetch from CustomProduct with mockup images and base product
        const cp = await this.prisma.customProduct.findUnique({
          where: { id: item.custom_product_id },
          include: {
            translations: true,
            mockup_images: { take: 1, orderBy: { sort_order: 'asc' as const } },
            selected_variants: item.variant_id
              ? { where: { variant_id: item.variant_id } }
              : true,
            product: {
              include: {
                translations: true,
                images: { take: 1, orderBy: { sort_order: 'asc' as const } },
                custom_fields: {
                  include: { translations: true },
                  orderBy: [
                    { sort_order: 'asc' as const },
                    { id: 'asc' as const },
                  ],
                },
              },
            },
          },
        });
        // Selected in the same round-trip; used only when the creator has not
        // uploaded a mockup (see the image resolution below).
        const cpOptionConfig = cp?.product?.variant_option_config ?? null;
        customFieldDefs = cp?.product?.custom_fields ?? [];

        if (cp) {
          title =
            this.pickTranslation(cp.translations, locale)?.title ||
            this.pickTranslation(cp.product.translations, locale)?.title ||
            null;
          // The creator's own mockup is their design of this product and wins
          // over a per-colour photo of the blank; the colour image only stands
          // in when there is no mockup.
          imageUrl = cp.mockup_images[0]?.url || null;

          // Resolve the chosen variant's adjustment (if any) up front so the
          // pricing math below can use it for PER_VARIANT/MARGIN. This mirrors
          // the calculation in orders.service so cart prices match checkout.
          let variantAdjustment = 0;
          if (item.variant_id) {
            const v = await this.prisma.productVariant.findUnique({
              where: { id: item.variant_id },
              select: { price_adjustment: true, options: true, images: true },
            });
            variantAdjustment = Number(v?.price_adjustment || 0);
            if (!imageUrl && v) {
              imageUrl = resolveVariantImage({
                optionConfig: cpOptionConfig,
                variantOptions: v.options,
                variantImages: v.images,
              });
            }
          }
          imageUrl = imageUrl || cp.product.images[0]?.url || null;

          switch (cp.pricing_type) {
            case 'SINGLE':
              price = Number(cp.final_price);
              break;
            case 'PER_VARIANT': {
              if (item.variant_id) {
                const sv = cp.selected_variants.find(
                  (s) => s.variant_id === item.variant_id,
                );
                price = sv?.custom_price
                  ? Number(sv.custom_price)
                  : Number(cp.product.base_price) + variantAdjustment;
              } else {
                price = Number(cp.final_price) || Number(cp.product.base_price);
              }
              break;
            }
            case 'MARGIN':
              price =
                Number(cp.product.base_price) +
                variantAdjustment +
                Number(cp.margin_amount || 0);
              break;
            default:
              price = Number(cp.final_price) || Number(cp.product.base_price);
          }
        }
      } else if (itemProductId) {
        const product = await this.prisma.product.findUnique({
          where: { id: itemProductId },
          include: {
            translations: true,
            images: { where: { is_featured: true }, take: 1 },
            custom_fields: {
              include: { translations: true },
              orderBy: [{ sort_order: 'asc' as const }, { id: 'asc' as const }],
            },
          },
        });

        if (product) {
          ownProduct = product;
          customFieldDefs = product.custom_fields;
          title =
            this.pickTranslation(product.translations, locale)?.title || null;
          price = Number(product.base_price);
          ownBasePrice = price;
          productOptionConfig = product.variant_option_config;
          imageUrl = product.images[0]?.url || null;

          // If no featured image, get the first image
          if (!imageUrl) {
            const firstImage = await this.prisma.productImage.findFirst({
              where: { product_id: product.id },
              orderBy: { sort_order: 'asc' },
            });
            imageUrl = firstImage?.url || null;
          }
        }
      }

      if (item.variant_id) {
        const variant = await this.prisma.productVariant.findUnique({
          where: { id: item.variant_id },
          include: { images: true },
        });

        if (variant) {
          if (!item.custom_product_id) {
            price = price + Number(variant.price_adjustment);
            ownAdjustment = Number(variant.price_adjustment);

            // Show what the buyer picked, not the generic product shot: the
            // per-value image the creator set for this colour, else an image
            // attached to this variant. Falls through to the product image.
            const variantImage = resolveVariantImage({
              optionConfig: productOptionConfig,
              variantOptions: variant.options,
              variantImages: variant.images,
            });
            if (variantImage) imageUrl = variantImage;
          }
          variantOptions = variant.options;
          if (variant.options && typeof variant.options === 'object') {
            const opts = variant.options as Record<string, string>;
            variantLabel = Object.entries(opts)
              .map(([k, v]) => `${k}: ${v}`)
              .join(' / ');
          }
        }
      }

      // Markets app: an own-product line is re-priced in the market currency
      // (override or converted). A product hidden in the market (same rule
      // as MarketPricingService.priceLine, which checkout applies) is flagged
      // `unavailable_in_market` and getCart leaves it out of the totals.
      if (market && marketRows && itemProductId && !item.custom_product_id) {
        const rows = marketRows.get(itemProductId);
        if (rows?.product && !rows.product.available) hiddenInMarket = true;
        const converted = resolveVariantMarketPrice({
          basePrice: ownBasePrice,
          adjustment: ownAdjustment,
          productOverride: rows?.product?.price,
          variantOverride: item.variant_id
            ? rows?.variants.get(item.variant_id)?.price
            : null,
          ctx: pricingContext(market),
        });
        if (converted != null) price = converted;
        else hiddenInMarket = true;
      }

      // Personalization app (M4.1 D4): soft evaluation of the stored values
      // (never throws on a read). The per-unit delta is added after the
      // market price and before the bundle, converted like every base
      // amount; display lines carry the groups. Lines of products without
      // M4.1 fields skip this entirely.
      let appDisplay: CustomFieldDisplay[] | null = null;
      let personalizationInvalidLine = false;
      if (
        this.personalization &&
        ownProduct?.creator_id &&
        this.personalization.needsEvaluator(
          customFieldDefs as unknown as PFieldDef[],
        )
      ) {
        // A read never throws: an app state that cannot be read (checkout
        // answers 503), a missing variant or a price that does not fit
        // marks the line `personalization_invalid` instead.
        let store: PersonalizationStore | null = null;
        try {
          store = await appStoreOf(ownProduct.creator_id);
        } catch (e) {
          this.logger.warn(
            `Cart item ${item.id} (product ${ownProduct.id}): app state unreadable, line flagged invalid: ${String(e)}`,
          );
          personalizationInvalidLine = true;
        }
        if (store) {
          const res = await this.personalization.evaluateLine({
            product: ownProduct,
            variantOptions: variantOptions ?? {},
            defs: customFieldDefs as unknown as PFieldDef[],
            raw: item.custom_fields,
            locale,
            primaryLocale: store.primary_locale,
            activeCache,
          });
          appDisplay = linesToDisplay(res.lines);
          personalizationInvalidLine = !res.ok;
          if (
            !item.variant_id &&
            (
              await this.personalization.activeVariants(
                ownProduct.id,
                activeCache,
              )
            ).count > 0
          ) {
            personalizationInvalidLine = true;
          }
          if (res.priceDeltaMinor > 0 && !hiddenInMarket) {
            try {
              price = roundMoney(
                price +
                  this.personalization.convertDelta(
                    market,
                    Number(res.priceDelta),
                  ),
              );
            } catch (e) {
              // No rate to convert base amounts: checkout refuses the line.
              this.logger.warn(
                `Cart item ${item.id} (product ${ownProduct.id}, market ${market?.key ?? 'none'}): personalization delta not convertible, line hidden: ${String(e)}`,
              );
              hiddenInMarket = true;
            }
          }
          if (
            res.errors.some((e) => e.code === PERSONALIZATION_PRICE_TOO_HIGH)
          ) {
            personalizationInvalidLine = true;
          }
          try {
            assertAmountFits(price, roundMoney(price * item.quantity));
          } catch (e) {
            this.logger.warn(
              `Cart item ${item.id} (product ${ownProduct.id}): price does not fit, line flagged invalid: ${String(e)}`,
            );
            personalizationInvalidLine = true;
          }
        }
      }

      // Apply bundle pricing if a bundle offer is attached
      let bundleOfferId: string | null = null;
      let bundleOriginalUnitPrice: number | null = null;
      let bundleTitle: string | null = null;
      let bundleLabel: string | null = null;
      let bundleStickerText: string | null = null;
      let bundleCartQuantity: number | null = null;

      if (item.bundle_offer_id) {
        const offer = await this.prisma.bundleOffer.findUnique({
          where: { id: item.bundle_offer_id },
          include: {
            translations: true,
            bundle: { include: { translations: true } },
          },
        });

        if (offer && offer.bundle.status === 'ACTIVE') {
          // A FIXED discount is a base-currency amount: converted in a
          // market, like orders do (PERCENTAGE / ITEM are currency-free).
          const discountValue =
            market && offer.discount_type === 'FIXED'
              ? this.marketPricing.convertMoney(
                  market,
                  Number(offer.discount_value),
                )
              : offer.discount_value;
          const pricing = computeBundlePricing(price, {
            quantity: offer.quantity,
            discount_type: offer.discount_type,
            discount_value: discountValue,
          });
          bundleOfferId = offer.id;
          bundleOriginalUnitPrice = price;
          price = pricing.effectiveUnitPrice;
          bundleCartQuantity = pricing.cartQuantity;
          const tr = this.pickTranslation(offer.translations, locale);
          bundleTitle = tr?.title || null;
          bundleLabel = tr?.label || null;
          bundleStickerText = tr?.sticker_text || null;
        } else {
          // Offer was deleted or its bundle is disabled — clear the stale
          // reference so checkout doesn't reject the cart later.
          await this.prisma.cartItem.update({
            where: { id: item.id },
            data: { bundle_offer_id: null },
          });
        }
      }

      // Designer line: the signed proof replaces the product image when it
      // exists (otherwise the storefront draws a live thumbnail).
      const designView = item.design_id
        ? designViews?.get(item.design_id)
        : undefined;
      if (designView?.proof_url) imageUrl = designView.proof_url;

      enriched.push({
        id: item.id,
        productId: item.product_id,
        variantId: item.variant_id,
        customProductId: item.custom_product_id,
        quantity: item.quantity,
        customFields: item.custom_fields,
        customFieldDisplay:
          appDisplay ??
          this.buildCustomFieldDisplay(
            customFieldDefs,
            item.custom_fields,
            locale,
          ),
        title,
        price,
        imageUrl,
        variant: variantLabel,
        currency,
        bundleOfferId,
        bundleOriginalUnitPrice,
        bundleTitle,
        bundleLabel,
        bundleStickerText,
        bundleCartQuantity,
        ...(hiddenInMarket ? { unavailable_in_market: true as const } : {}),
        ...(personalizationInvalidLine
          ? { personalization_invalid: true as const }
          : {}),
        ...(designView ? { design: designView } : {}),
      });
    }

    return enriched;
  }

  /**
   * Validate that a bundle offer exists, is on an ACTIVE bundle, and is linked
   * to the requested product/custom_product. Returns the offer.
   */
  private async validateBundleOffer(
    bundleOfferId: string,
    productId?: string | null,
    customProductId?: string | null,
    variantId?: string | null,
  ) {
    const offer = await this.prisma.bundleOffer.findUnique({
      where: { id: bundleOfferId },
      include: {
        bundle: {
          include: {
            products: true,
            custom_products: true,
          },
        },
      },
    });
    if (!offer) {
      throw new BadRequestException({
        code: 'CART_BUNDLE_OFFER_NOT_FOUND',
        message: 'Bundle offer not found',
      });
    }
    if (offer.bundle.status !== 'ACTIVE') {
      throw new BadRequestException({
        code: 'CART_BUNDLE_NOT_ACTIVE',
        message: 'Bundle is not active',
      });
    }
    if (productId) {
      const linked = offer.bundle.products.some(
        (p) => p.product_id === productId,
      );
      if (!linked) {
        throw new BadRequestException({
          code: 'CART_BUNDLE_NOT_AVAILABLE_FOR_PRODUCT',
          message: 'Bundle is not available for this product',
        });
      }
    } else if (customProductId) {
      const linked = offer.bundle.custom_products.some(
        (p) => p.custom_product_id === customProductId,
      );
      if (!linked) {
        throw new BadRequestException({
          code: 'CART_BUNDLE_NOT_AVAILABLE_FOR_PRODUCT',
          message: 'Bundle is not available for this product',
        });
      }
    }

    // Runtime economics guard: provider prices can change after the bundle was
    // attached. Re-check that this specific offer doesn't push the product below
    // provider cost before letting the customer add it to their cart.
    let unitPrice = 0;
    let providerBase = 0;
    if (productId) {
      const product = await this.prisma.product.findUnique({
        where: { id: productId },
        select: { base_price: true, provider_id: true },
      });
      if (product) {
        unitPrice = Number(product.base_price);
        providerBase = product.provider_id ? unitPrice : 0;
      }
    } else if (customProductId) {
      const cp = await this.prisma.customProduct.findUnique({
        where: { id: customProductId },
        select: {
          final_price: true,
          pricing_type: true,
          margin_amount: true,
          selected_variants: variantId
            ? { where: { variant_id: variantId } }
            : true,
          product: { select: { base_price: true, provider_id: true } },
        },
      });
      if (cp) {
        // Resolve the exact variant adjustment for this cart line so the
        // economic check operates on the real customer-facing price, not a
        // fallback. Mirrors orders.service pricing logic.
        let variantAdjustment = 0;
        if (variantId) {
          const v = await this.prisma.productVariant.findUnique({
            where: { id: variantId },
            select: { price_adjustment: true },
          });
          variantAdjustment = Number(v?.price_adjustment || 0);
        }

        switch (cp.pricing_type) {
          case 'SINGLE':
            unitPrice = Number(cp.final_price) || Number(cp.product.base_price);
            break;
          case 'PER_VARIANT': {
            if (variantId) {
              const sv = cp.selected_variants.find(
                (s) => s.variant_id === variantId,
              );
              unitPrice = sv?.custom_price
                ? Number(sv.custom_price)
                : Number(cp.product.base_price) + variantAdjustment;
            } else {
              // No variant chosen yet — use the cheapest declared so the
              // check stays conservative (most likely to surface a loss).
              const customPrices = cp.selected_variants
                .map((sv) => Number(sv.custom_price ?? 0))
                .filter((n) => n > 0);
              unitPrice = customPrices.length
                ? Math.min(...customPrices)
                : Number(cp.product.base_price);
            }
            break;
          }
          case 'MARGIN':
            unitPrice =
              Number(cp.product.base_price) +
              variantAdjustment +
              Number(cp.margin_amount || 0);
            break;
        }
        providerBase = cp.product.provider_id
          ? Number(cp.product.base_price) + variantAdjustment
          : 0;
      }
    }
    if (providerBase > 0 && unitPrice > 0) {
      const check = validateBundleEconomics(
        [
          {
            quantity: offer.quantity,
            discount_type: offer.discount_type,
            discount_value: offer.discount_value as unknown as number,
          },
        ],
        [{ id: 'cart-line', unitPrice, providerBasePrice: providerBase }],
      );
      if (!check.valid) {
        throw new BadRequestException({
          code: 'CART_BUNDLE_NOT_PROFITABLE',
          message:
            'This bundle offer is no longer profitable for this product and cannot be applied',
        });
      }
    }

    return offer;
  }

  /**
   * Bundle offers require quantity in multiples of the offer's cartQuantity
   * (e.g. ITEM "buy 2 get 1" → multiples of 3). Reject early so the user
   * doesn't get a surprise at checkout.
   */
  private assertBundleQuantityValid(
    offer: Pick<BundleOffer, 'quantity' | 'discount_type' | 'discount_value'>,
    quantity: number,
  ) {
    const pricing = computeBundlePricing(1, {
      quantity: offer.quantity,
      discount_type: offer.discount_type,
      discount_value: offer.discount_value,
    });
    if (pricing.cartQuantity <= 0 || quantity % pricing.cartQuantity !== 0) {
      throw new BadRequestException(
        `Bundle requires quantity in multiples of ${pricing.cartQuantity}`,
      );
    }
  }

  /**
   * `?buyer=company` (b2b app): the company view. Only changes the response
   * for a store with the app enabled, which then also carries each line's
   * estimated `tax_rate_bp` and the `b2b` net block; otherwise the response
   * is exactly the pre-app one.
   */
  async getCart(
    userId: string,
    locale?: string,
    marketKey?: string,
    buyer?: string,
  ) {
    const cart = await this.getOrCreateCart(userId);

    const cartWithItems = await this.prisma.cart.findUnique({
      where: { id: cart.id },
      include: {
        items: true,
      },
    });

    // Markets app: null when off, so everything below prices as before.
    const market = await this.resolveCartMarket(
      cartWithItems?.items || [],
      marketKey,
    );

    const enrichedItems = await this.enrichCartItems(
      cartWithItems?.items || [],
      locale,
      market,
    );

    // Tax estimate shown in the cart: the coupon-free, shipping-free lines
    // (effective unit price × quantity) taxed for the registration country,
    // since no destination is known yet. POST /orders/quote gives the exact
    // figure once the address is; the order snapshots it at creation.
    // A line hidden in the market (markets app) stays in `items`, flagged,
    // so the buyer sees why it cannot be bought and can remove it, but it is
    // not part of the totals: it counts as a zero line here (keeps the
    // per-line index alignment) and checkout would reject it anyway.
    const taxableItems = enrichedItems.map((item) =>
      item.unavailable_in_market ? { price: 0, quantity: 0 } : item,
    );
    const tax = await this.resolveCartTax(
      cartWithItems?.items || [],
      taxableItems as { price?: number; quantity?: number }[],
      locale,
      market,
      buyer,
    );

    // b2b app: per-line estimated rate (the web derives net prices from it)
    // only when the store has the app; items are untouched otherwise.
    const lineRates = tax.items_tax_rate_bp;
    const items = lineRates
      ? enrichedItems.map((item, i) => ({
          ...item,
          tax_rate_bp: lineRates[i] ?? 0,
        }))
      : enrichedItems;

    return {
      id: cartWithItems?.id,
      items,
      // Headline rate + tax total (compat) and the itemized estimate.
      tax_rate_bp: tax.tax_rate_bp,
      tax_amount: tax.tax_total,
      tax_lines: tax.tax_lines,
      tax_total: tax.tax_total,
      tax_pricing_mode: tax.tax_pricing_mode,
      tax_estimated: true,
      // EXCLUSIVE: subtotal + tax; INCLUSIVE: the subtotal itself.
      total_with_tax: tax.total_with_tax,
      ...(tax.b2b ? { b2b: tax.b2b } : {}),
    };
  }

  /**
   * The store a cart belongs to is not stored on the row, so it is derived
   * from the first line that resolves to a creator (the storefront keeps one
   * cart per store). Each line's tax class / exemption comes from the
   * product behind it; the engine then estimates with the registration
   * country (no destination yet).
   */
  private async resolveCartTax(
    items: {
      product_id: string | null;
      custom_product_id: string | null;
      variant_id: string | null;
    }[],
    enrichedItems: { price?: number; quantity?: number }[],
    locale?: string,
    market: MarketContext | null = null,
    buyer?: string,
  ): Promise<{
    tax_rate_bp: number;
    tax_total: number;
    tax_lines: {
      label: string;
      rate_bp: number;
      taxable_amount: number;
      tax_amount: number;
    }[];
    tax_pricing_mode: 'INCLUSIVE' | 'EXCLUSIVE';
    total_with_tax: number;
    /** b2b app only: one estimated rate per line, in item order. */
    items_tax_rate_bp?: number[];
    /** b2b app only: display mode and net figures. */
    b2b?: B2bTotals;
  }> {
    const platformConfig = await this.prisma.platformConfig.findFirst({
      select: { default_currency: true },
    });
    const productSelect = {
      creator_id: true,
      tax_class_id: true,
      tax_exempt: true,
    } as const;

    type TaxProduct = {
      creator_id: string | null;
      tax_class_id: string | null;
      tax_exempt: boolean;
    };
    // One query per id kind instead of one per line.
    const idsOf = (pick: (i: (typeof items)[number]) => string | null) =>
      Array.from(new Set(items.map(pick).filter(Boolean) as string[]));
    const customProductIds = idsOf((i) =>
      i.custom_product_id ? i.custom_product_id : null,
    );
    const variantIds = idsOf((i) =>
      !i.custom_product_id && i.variant_id ? i.variant_id : null,
    );
    const productIds = idsOf((i) =>
      !i.custom_product_id && !i.variant_id && i.product_id
        ? i.product_id
        : null,
    );
    type CustomRow = { id: string; creator_id: string; product: TaxProduct };
    type VariantRow = { id: string; product: TaxProduct };
    type ProductRow = TaxProduct & { id: string };
    const customProductsQuery: Promise<CustomRow[]> = customProductIds.length
      ? this.prisma.customProduct.findMany({
          where: { id: { in: customProductIds } },
          select: {
            id: true,
            creator_id: true,
            product: { select: productSelect },
          },
        })
      : Promise.resolve([]);
    const variantsQuery: Promise<VariantRow[]> = variantIds.length
      ? this.prisma.productVariant.findMany({
          where: { id: { in: variantIds } },
          select: { id: true, product: { select: productSelect } },
        })
      : Promise.resolve([]);
    const productsQuery: Promise<ProductRow[]> = productIds.length
      ? this.prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, ...productSelect },
        })
      : Promise.resolve([]);
    const [customProducts, variants, products] = await Promise.all([
      customProductsQuery,
      variantsQuery,
      productsQuery,
    ]);
    const customById = new Map<string, CustomRow>(
      customProducts.map((cp) => [cp.id, cp]),
    );
    const variantById = new Map<string, VariantRow>(
      variants.map((v) => [v.id, v]),
    );
    const productById = new Map<string, ProductRow>(
      products.map((p) => [p.id, p]),
    );

    let creatorId: string | null = null;
    const taxLines: TaxLineInput[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let product: TaxProduct | null = null;
      let lineCreatorId: string | null = null;
      if (item.custom_product_id) {
        const cp = customById.get(item.custom_product_id);
        product = cp?.product ?? null;
        lineCreatorId = cp?.creator_id ?? null;
      } else if (item.variant_id) {
        product = variantById.get(item.variant_id)?.product ?? null;
        lineCreatorId = product?.creator_id ?? null;
      } else if (item.product_id) {
        product = productById.get(item.product_id) ?? null;
        lineCreatorId = product?.creator_id ?? null;
      }
      creatorId = creatorId ?? lineCreatorId;
      const enriched = enrichedItems[i];
      taxLines.push({
        amount: Number(enriched?.price || 0) * Number(enriched?.quantity || 0),
        tax_class_id: product?.tax_class_id ?? null,
        tax_exempt: product?.tax_exempt ?? false,
      });
    }

    const store = creatorId
      ? await this.prisma.store.findUnique({
          where: { creator_id: creatorId },
          select: { ...taxStoreSelect, currency: true },
        })
      : null;
    const currency = market
      ? market.currency
      : resolveStoreCurrency(store, platformConfig?.default_currency);
    const subtotal = taxLines.reduce((sum, l) => sum + l.amount, 0);
    if (!store) {
      return {
        tax_rate_bp: 0,
        tax_total: 0,
        tax_lines: [],
        tax_pricing_mode: 'INCLUSIVE',
        total_with_tax: roundMoney(subtotal, currency),
      };
    }
    // b2b app: cached flag; the buyer type only sets the display mode.
    const b2bEnabled = await this.b2b.isEnabled(store.id);
    const buyerType = b2bEnabled
      ? await this.b2b.resolveBuyerType(
          store.id,
          buyer === 'company' ? 'COMPANY' : null,
        )
      : 'PERSON';
    const ctx = {
      ...(await this.taxService.contextFor(store)),
      ...(buyerType === 'COMPANY' ? { buyerType } : {}),
    };
    const data = await this.taxService.loadTaxData(ctx);
    const result = this.taxService.computeTaxes({
      ctx,
      data,
      currency,
      locale,
      lines: taxLines,
      shipping_cost: 0,
      discount_amount: 0,
      shipping: null,
    });
    return {
      tax_rate_bp: result.headline_rate_bp,
      tax_total: result.tax_total,
      tax_lines: result.tax_lines,
      tax_pricing_mode: result.tax_pricing_mode,
      total_with_tax: result.total,
      ...(b2bEnabled
        ? {
            items_tax_rate_bp: result.items.map((i) => i.tax_rate_bp),
            b2b: {
              display_mode: result.display_mode,
              net_items: result.net_items,
              net_shipping: result.net_shipping,
              net_total: result.net_total,
            },
          }
        : {}),
    };
  }

  /**
   * Markets app: refuse an own-product line hidden in the request's market,
   * by the rule checkout applies (MarketPricingService.priceLine). No-op for
   * custom products and when the app is off (no market context).
   */
  private async assertAvailableInMarket(
    line: {
      product_id?: string | null;
      variant_id?: string | null;
      custom_product_id?: string | null;
    },
    locale?: string,
    marketKey?: string,
  ): Promise<void> {
    if (!line.product_id || line.custom_product_id) return;
    const market = await this.resolveCartMarket(
      [{ product_id: line.product_id, custom_product_id: null }],
      marketKey,
    );
    if (!market) return;
    const product = await this.prisma.product.findUnique({
      where: { id: line.product_id },
      select: { base_price: true, translations: true },
    });
    if (!product) return;
    const variant = line.variant_id
      ? await this.prisma.productVariant.findUnique({
          where: { id: line.variant_id },
          select: { price_adjustment: true },
        })
      : null;
    const price = await this.marketPricing.priceLine(market, {
      product_id: line.product_id,
      variant_id: line.variant_id ?? null,
      basePrice: Number(product.base_price),
      adjustment: Number(variant?.price_adjustment || 0),
    });
    if (price != null) return;
    const title =
      this.pickTranslation(product.translations, locale)?.title || 'This item';
    throw new BadRequestException({
      code: CART_ITEM_NOT_AVAILABLE_IN_MARKET,
      message: `${title} is not available in this market.`,
    });
  }

  async addItem(
    userId: string,
    dto: AddCartItemDto,
    locale?: string,
    marketKey?: string,
    buyer?: string,
  ) {
    const cart = await this.getOrCreateCart(userId);

    // M4.0 (K2): the product's field rules apply on every add, and lines
    // with different personalization never merge. M4.1: a variant-only
    // line gets its product from the variant (a mismatch is refused), so
    // the stored row, the market check and the evaluator see the product.
    const [ctx] = await this.core.loadContexts([dto]);
    if (!dto.product_id && !dto.custom_product_id && ctx.productId) {
      dto.product_id = ctx.productId;
    } else if (dto.product_id && dto.variant_id && !dto.custom_product_id) {
      // A variant borrowed from another product is refused here (one
      // query on the add path; loadContexts no longer looks it up, M5 A11).
      await this.assertVariantOfProduct(dto.product_id, dto.variant_id);
    }
    await this.assertAvailableInMarket(dto, locale, marketKey);
    // M4.2 designer (C29 step 2): a line with a design, or of a product the
    // designer is active for, is validated (and the design claimed for this
    // customer) here; it carries no field values, so the field rules are
    // skipped and whatever was sent is dropped.
    const designer = this.designerCart
      ? await this.designerCart.resolveCartLine(
          dto,
          dto.custom_product_id ? null : (dto.product_id ?? ctx.productId),
          cart.customer_id,
        )
      : null;
    const designId = designer?.design.id ?? null;
    // M4.1: canonical app values when the personalization app applies, so
    // the line key below merges identical and splits different values.
    const normalized = designer
      ? {}
      : await this.assertCartLine(dto, ctx, dto.custom_fields, locale);

    // The row this line merges into; looked up once and also used for the
    // bundle multiple check (only the same personalization counts, bug 1).
    const existing = await this.findMergeTarget(
      cart.id,
      dto,
      ctx,
      normalized,
      undefined,
      designId,
    );

    if (dto.bundle_offer_id) {
      const offer = await this.validateBundleOffer(
        dto.bundle_offer_id,
        dto.product_id,
        dto.custom_product_id,
        dto.variant_id,
      );
      const finalQuantity = (existing?.quantity ?? 0) + dto.quantity;
      this.assertBundleQuantityValid(offer, finalQuantity);
    }

    if (existing) {
      await this.prisma.cartItem.update({
        where: { id: existing.id },
        data: { quantity: existing.quantity + dto.quantity },
      });
    } else {
      // The design token is a credential: never stored on the row.
      const { design_token: _token, design_id: _designId, ...line } = dto;
      void _token;
      void _designId;
      const data = {
        cart_id: cart.id,
        ...line,
      } as Prisma.CartItemUncheckedCreateInput;
      if (designId) {
        data.design_id = designId;
        delete data.custom_fields;
      } else {
        // A product without fields stores exactly what was sent (G0).
        const stored = storedCustomFields(
          dto.custom_fields,
          normalized as NormalizedValues,
          (ctx.allFields ?? ctx.fields).length > 0,
        );
        if (stored !== dto.custom_fields) data.custom_fields = stored;
      }
      await this.prisma.cartItem.create({ data });
    }
    // M4.2 §5.4: the design's proof is rendered in the background; the add
    // never waits for it nor fails because of it.
    if (designId) this.designerCart?.ensureProof(designId);

    // Return enriched cart
    return this.getCart(userId, locale, marketKey, buyer);
  }

  /** 400 PRODUCT_VARIANT_MISMATCH unless the variant exists on the product. */
  private async assertVariantOfProduct(
    productId: string,
    variantId: string,
  ): Promise<void> {
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      select: { product_id: true },
    });
    if (variant && variant.product_id !== productId) {
      throw new BadRequestException({
        code: PRODUCT_VARIANT_MISMATCH,
        message: 'The selected variant does not belong to this product',
      });
    }
  }

  async updateItem(
    userId: string,
    itemId: string,
    dto: UpdateCartItemDto,
    locale?: string,
    marketKey?: string,
    buyer?: string,
  ) {
    const cart = await this.getOrCreateCart(userId);

    const item = await this.prisma.cartItem.findFirst({
      where: { id: itemId, cart_id: cart.id },
    });
    if (!item)
      throw new NotFoundException({
        code: 'CART_ITEM_NOT_FOUND',
        message: 'Cart item not found',
      });
    await this.assertAvailableInMarket(item, locale, marketKey);

    const data: {
      quantity?: number;
      bundle_offer_id?: string | null;
      custom_fields?: Prisma.InputJsonValue | typeof Prisma.DbNull;
    } = {};
    if (typeof dto.quantity === 'number') {
      data.quantity = dto.quantity;
    }
    let nextBundleOfferId: string | null = item.bundle_offer_id;
    if (dto.bundle_offer_id !== undefined) {
      if (dto.bundle_offer_id === null) {
        data.bundle_offer_id = null;
        nextBundleOfferId = null;
      } else {
        await this.validateBundleOffer(
          dto.bundle_offer_id,
          item.product_id,
          item.custom_product_id,
          item.variant_id,
        );
        data.bundle_offer_id = dto.bundle_offer_id;
        nextBundleOfferId = dto.bundle_offer_id;
      }
    }

    // M4.0: new personalization for this line (API seam for "edit
    // personalization"). Validated like an add; when the new values equal
    // another line's, that line takes the quantity and this one is removed.
    // M4.2: a designer line carries no field values; edits go through the
    // design itself, so custom_fields sent for it are ignored.
    if (dto.custom_fields !== undefined && !item.design_id) {
      const [ctx] = await this.core.loadContexts([item]);
      const normalized = await this.assertCartLine(
        item,
        ctx,
        dto.custom_fields,
        locale,
      );
      const target = await this.findMergeTarget(
        cart.id,
        { ...item, bundle_offer_id: nextBundleOfferId },
        ctx,
        normalized,
        item.id,
      );
      if (target) {
        const mergedQty = target.quantity + (data.quantity ?? item.quantity);
        if (nextBundleOfferId) {
          const offer = await this.prisma.bundleOffer.findUnique({
            where: { id: nextBundleOfferId },
          });
          if (offer) this.assertBundleQuantityValid(offer, mergedQty);
        }
        await this.prisma.$transaction([
          this.prisma.cartItem.update({
            where: { id: target.id },
            data: { quantity: mergedQty },
          }),
          this.prisma.cartItem.delete({ where: { id: item.id } }),
        ]);
        return this.getCart(userId, locale, marketKey, buyer);
      }
      const stored = storedCustomFields(
        dto.custom_fields,
        normalized as NormalizedValues,
        (ctx.allFields ?? ctx.fields).length > 0,
      );
      data.custom_fields = stored === undefined ? Prisma.DbNull : stored;
    }

    // Enforce quantity multiples if the resulting line carries a bundle offer.
    if (nextBundleOfferId) {
      const nextQty = data.quantity ?? item.quantity;
      const offer = await this.prisma.bundleOffer.findUnique({
        where: { id: nextBundleOfferId },
      });
      if (offer) this.assertBundleQuantityValid(offer, nextQty);
    }

    if (Object.keys(data).length > 0) {
      await this.prisma.cartItem.update({
        where: { id: itemId },
        data,
      });
    }

    return this.getCart(userId, locale, marketKey, buyer);
  }

  async removeItem(
    userId: string,
    itemId: string,
    locale?: string,
    marketKey?: string,
    buyer?: string,
  ) {
    const cart = await this.getOrCreateCart(userId);

    await this.prisma.cartItem.delete({
      where: { id: itemId, cart_id: cart.id },
    });

    return this.getCart(userId, locale, marketKey, buyer);
  }

  async clearCart(userId: string) {
    const cart = await this.getOrCreateCart(userId);

    await this.prisma.cartItem.deleteMany({
      where: { cart_id: cart.id },
    });

    return { message: 'Cart cleared' };
  }

  async applyCoupon(userId: string, couponCode: string) {
    const cart = await this.getOrCreateCart(userId);

    return {
      cart_id: cart.id,
      coupon_code: couponCode,
      message: 'Coupon applied. Discount will be calculated at checkout.',
    };
  }

  removeCoupon(_userId: string) {
    return Promise.resolve({ message: 'Coupon removed' });
  }
}
