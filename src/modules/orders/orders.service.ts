import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Optional,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CommissionStatus,
  FulfillerType,
  Prisma,
  FulfillmentStatus,
  OrderStatus,
  PaymentMethod,
  PricingType,
  ProductStatus,
  ShippingMethodType,
  StoreType,
  TaxPricingMode,
  UserRole,
} from '@prisma/client';
import {
  CreateOrderDto,
  UpdateOrderStatusDto,
  UpdateFulfillmentDto,
} from './dto/order.dto';
import { PromotionsService } from '../promotions/promotions.service';
import {
  ShippingService,
  type QuotedShippingMethod,
} from '../shipping/shipping.service';
import { MailService } from '../mail/mail.service';
import { InvoiceTriggersService } from '../invoices/invoice-triggers.service';
import { computeBundlePricing } from '../bundles/bundle-pricing.util';
import {
  currencyDecimals,
  resolveOrderCurrency,
  roundMoney,
} from '../../common/money/currency.util';
import { allocateLargestRemainder } from '../../common/money/tax.util';
import { MarketsContextService } from '../markets/markets-context.service';
import {
  MarketPricingService,
  type MarketPriceMap,
} from '../markets/market-pricing.service';
import type { MarketContext } from '../markets/market-context';
import type { QuoteMarketInfo } from '../markets/market.types';
import { normalizeHostname } from '../../common/domains/reserved-hosts';
import {
  TaxService,
  exemptNetPrices,
  netOfRate,
  taxStoreSelect,
  type ExemptNetPricesResult,
  type TaxComputeResult,
  type TaxDestination,
  type TaxLine,
  type TaxLineInput,
  type TaxStoreFields,
} from '../taxes/tax.service';
import { resolveVariantImage } from '../../common/catalog/variant-image.util';
import {
  isKustomEnabledForStore,
  kustomCreatorSelect,
  type KustomCreatorFields,
} from '../payments/kustom/kustom.eligibility';
import {
  type CartLineLike,
  type NormalizedCartLine,
  normalizeCartLine,
} from '../cart/cart-line';
import { B2B_COMPANY_NOT_ALLOWED, B2bService } from '../b2b/b2b.service';
import type {
  B2bTotals,
  BuyerType,
  CompanySnapshot,
  QuoteTaxExemption,
  TaxExemptReason,
} from '../b2b/b2b.types';
import { B2bTaxExemptionService } from '../b2b/b2b-tax-exemption.service';
import {
  PersonalizationCoreService,
  type LineContext,
  type OrderValueRow,
  type UploadRef,
} from '../../common/personalization/personalization-core.service';
import type { NormalizedValues } from '@multi-stores/core/personalization/rules';
import { CustomerUploadsService } from '../customer-uploads/customer-uploads.service';
import {
  assertAmountFits,
  assertPriceEvaluated,
  PersonalizationService,
  type ActiveVariantsCache,
} from '../personalization/personalization.service';
import { personalizationInvalid } from '../personalization/personalization-runtime';
import type {
  PFieldDef,
  PLine,
  PResult,
} from '@multi-stores/core/personalization/types';
import { ProductionTriggersService } from '../production/production-triggers.service';
import {
  isProductionFilter,
  productionWhere,
} from '../production/production-where';
import {
  DesignerCartService,
  type DesignerLine,
  type DesignerLineMode,
} from '../designer/designer-cart.service';
import {
  convertAddonLines,
  type PricedAddon,
} from '../designer/designer-addons';
import {
  DESIGNER_TRIGGERS_PORT,
  type DesignerTriggersPort,
} from '../../common/ports/designer-triggers.port';
import {
  customerVatEvidence,
  decideTaxExemption,
  type ExemptionInputs,
  type TaxExemptionDecision,
} from '../b2b/reverse-charge';

// Callback run after an order's status becomes SHIPPED. Registered by payment
// providers that capture on shipment (Kustom); see registerShippedHook.
type ShippedHook = (orderId: string) => Promise<void>;

/**
 * The relations resolveOrderItemImage() reads from an order line. Every
 * read path includes a superset of these (all fields optional so partial
 * includes still type-check).
 */
interface OrderItemImageSource {
  custom_product?: {
    mockup_images?: { url: string }[] | null;
    product?: {
      variant_option_config?: unknown;
      images?: { url: string }[] | null;
    } | null;
  } | null;
  variant?: {
    product?: {
      variant_option_config?: unknown;
      images?: { url: string }[] | null;
    } | null;
    options?: unknown;
    images?: { url: string }[] | null;
  } | null;
  product?: {
    variant_option_config?: unknown;
    images?: { url: string }[] | null;
  } | null;
}

/**
 * An order line as create() accumulates it before order.create(). Its
 * custom field values are created nested (`custom_field_values.create`,
 * M4.0 K8), inside the same insert as the order.
 */
type PendingOrderItem = Prisma.OrderItemUncheckedCreateWithoutOrderInput;

/** A variant `options` value worth snapshotting (`{name: value}`). */
function isOptionMap(v: Prisma.JsonValue | null): v is Prisma.JsonObject {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The store columns order pricing depends on. */
interface OrderStoreContext extends TaxStoreFields {
  id: string;
  slug: string;
  creator_id: string;
  store_type: StoreType;
  currency: string | null;
  cod_enabled: boolean;
  is_active: boolean;
  /** Store content locale; shipping method names are snapshotted in it. */
  primary_locale: string | null;
  creator: KustomCreatorFields;
  /** Markets app: the market the order is priced in; null when the app is off. */
  market: MarketContext | null;
  /** b2b app: whether it is in effect (the `b2b` response block is emitted). */
  b2bEnabled: boolean;
  /** b2b app: the buyer type this request runs as (PERSON when the app is off). */
  buyerType: BuyerType;
  /** Personalization app (M4.1 D2): in effect for the store (false when off). */
  personalizationEnabled: boolean;
}

/** A stock reservation to apply atomically right before the order row. */
type StockOp = { kind: 'product' | 'variant'; id: string; qty: number };

/** What priceLine() decides for one line. */
interface PricedLine {
  unitPrice: number;
  originalUnitPrice: number | null;
  providerBasePrice: number;
  fulfillerId: string;
  fulfillerType: 'PROVIDER' | 'CREATOR';
  stockOp: StockOp | null;
  /** Tax class / exemption of the product behind the line. */
  taxClassId: string | null;
  taxExempt: boolean;
  /**
   * Personalization app (M4.1): the evaluator result of an app line (its
   * canonical values and snapshot lines); null on the M4.0 path.
   */
  personalization: PResult | null;
  /** Per-unit personalization delta in the order currency (0 = none). */
  personalizationAmount: number;
  /**
   * Designer app (M5.5): the line's add-ons in the order currency (per
   * unit) and their sum, already inside `unitPrice`. Empty / 0 without.
   */
  designerAddons: PricedAddon[];
  designerAddonsAmount: number;
  /**
   * Production app (M4.3): the variant's option map as sold, stored on the
   * line as `variant_options_snapshot` so the checklist never follows a
   * later edit of the ProductVariant row. Null for lines without a variant.
   */
  variantOptions: Prisma.JsonValue | null;
}

/** What priceLine() needs to evaluate a line's personalization (M4.1). */
interface LinePersonalizationInput {
  ctx: LineContext;
  /** Raw values of the line (cart JSON or the request's customization). */
  raw: unknown;
  locale?: string | null;
  ref: { line_id?: string; line_index?: number };
  /** Active variants per product, shared by every line of the quote / order. */
  activeCache?: ActiveVariantsCache;
}

type CouponValidation = {
  promotion_id: string;
  type: string;
  value: number;
  discount_amount: number;
  free_shipping: boolean;
};

export type ShippingQuote =
  | {
      available: true;
      /** Cost and days of the chosen method (0 / null when there is none). */
      cost: number;
      estimated_days: { min: number; max: number } | null;
      /** The method the order would use; null when nothing needs shipping. */
      method: QuotedShippingMethod | null;
      /** Every method offered for this destination. */
      methods: QuotedShippingMethod[];
    }
  | { available: false; message: string };

export interface OrderQuoteItem {
  product_id: string | null;
  variant_id: string | null;
  custom_product_id: string | null;
  bundle_offer_id: string | null;
  quantity: number;
  unit_price: number;
  original_unit_price: number | null;
  total_price: number;
  /** Effective tax rate (basis points), tax after the discount share, class. */
  tax_rate_bp: number;
  tax_amount: number;
  tax_class_key: string | null;
  /**
   * Designer app (M5.5): the add-ons priced into `unit_price` (order
   * currency, per unit). Absent on lines without add-ons.
   */
  designer_addons?: PricedAddon[];
}

/** Everything an order from these lines would carry, without creating it. */
export interface OrderQuote {
  items: OrderQuoteItem[];
  subtotal: number;
  shipping_cost: number;
  discount_amount: number;
  /** INCLUSIVE: subtotal + shipping - discount; EXCLUSIVE: plus tax_total. */
  total: number;
  currency: string;
  /** Headline rate (highest on the order) and the tax total — compat. */
  tax_rate_bp: number;
  tax_amount: number;
  tax_lines: TaxLine[];
  tax_total: number;
  tax_pricing_mode: TaxPricingMode;
  tax_basis_country: string | null;
  shipping_tax_amount: number;
  shipping_tax_rate_bp: number;
  /** Null when no destination country was given (shipping not computed). */
  shipping: ShippingQuote | null;
  /** The chosen shipping method (what the order would snapshot). */
  shipping_method_id: string | null;
  shipping_method_name: string | null;
  shipping_method_type: ShippingMethodType | null;
  coupon: CouponValidation | null;
  /** Markets app: present only when a market context applied. */
  market?: QuoteMarketInfo;
  /** b2b app: present only when the app is enabled for the store. */
  b2b?: B2bTotals;
  /**
   * b2b app M2.5: present only while the app and reverse charge are on.
   * Non-null when the quote carries no VAT; item prices / subtotal are then
   * what the exempt buyer pays (net on INCLUSIVE stores with 'net' pricing).
   */
  tax_exempt_reason?: TaxExemptReason | null;
  tax_exemption?: QuoteTaxExemption;
}

/** What computeTotals decided about a tax exemption (b2b app, M2.5). */
interface TotalsExemption {
  decision: TaxExemptionDecision;
  /** Netted line prices; null when the amounts are unchanged. */
  net: ExemptNetPricesResult | null;
}

/** 409 of create() when the buyer expected reverse charge but none applies. */
export const B2B_REVERSE_CHARGE_NOT_CONFIRMED =
  'B2B_REVERSE_CHARGE_NOT_CONFIRMED';

export interface CreateOrderOptions {
  /**
   * Price these lines instead of the customer's cart, and leave the cart
   * untouched. Used by checkouts whose lines never lived in the server cart.
   */
  lines?: CartLineLike[];
  /**
   * b2b app: a company snapshot the caller already normalised (the Kustom
   * validation callback, leniently - Kustom validated the data itself and
   * the 3 s budget must not end in a B2B_* 400). Replaces the strict
   * validation of `dto.company`; only read when the buyer is COMPANY.
   */
  companySnapshot?: CompanySnapshot;
  /**
   * b2b app M2.5: reverse-charge inputs prepared by the caller (Kustom:
   * from the session's stored VIES evidence, never a live VIES call inside
   * the validation callback). Undefined = prepare live here; null = the app
   * or reverse charge is off.
   */
  exemptionInputs?: ExemptionInputs | null;
  /**
   * Designer app: design ids whose ownership the stored checkout session
   * verified (Kustom snapshot, `verifiedDesignIds(session.items)`). With
   * `lines`, only these designs are trusted; absent = none.
   */
  verifiedDesignIds?: readonly string[];
}

function deriveCommissionStatus(orderStatus: OrderStatus): CommissionStatus {
  if (orderStatus === OrderStatus.DELIVERED) return CommissionStatus.COMPLETED;
  if (
    orderStatus === OrderStatus.CANCELLED ||
    orderStatus === OrderStatus.REFUNDED ||
    orderStatus === OrderStatus.RETURNED
  ) {
    return CommissionStatus.FAILED;
  }
  return CommissionStatus.PENDING;
}

// Map the overall order lifecycle onto the smaller per-item FulfillmentStatus enum
// so item badges don't get stuck on PENDING after the order advances.
// Terminal failure states (CANCELLED/REFUNDED/RETURNED) return null — we leave items
// alone there so the UI keeps the historical fulfillment context.
/**
 * Production app ship prompt (M5.4): the tracking a SHIPPED update carries
 * is written to the items it moves (the shipped email reads the first
 * item tracking number). Empty for every other update.
 */
function shipTracking(dto: UpdateOrderStatusDto): {
  tracking_number?: string;
  tracking_url?: string;
} {
  const number = dto.tracking_number?.trim();
  if (dto.status !== OrderStatus.SHIPPED || !number) return {};
  const url = dto.tracking_url?.trim();
  return { tracking_number: number, ...(url ? { tracking_url: url } : {}) };
}

/** Timeline note of a SHIPPED update that carries carrier / tracking. */
function shipNote(dto: UpdateOrderStatusDto): string | undefined {
  if (dto.status !== OrderStatus.SHIPPED) return undefined;
  const carrier = dto.carrier?.trim();
  const number = dto.tracking_number?.trim();
  if (!carrier && !number) return undefined;
  return `Shipped${carrier ? ` via ${carrier}` : ''}${number ? ` (${number})` : ''}`;
}

function deriveFulfillmentStatus(
  orderStatus: OrderStatus,
): FulfillmentStatus | null {
  switch (orderStatus) {
    case OrderStatus.PENDING:
      return FulfillmentStatus.PENDING;
    case OrderStatus.CONFIRMED:
      return FulfillmentStatus.PROCESSING;
    case OrderStatus.PROCESSING:
      return FulfillmentStatus.PROCESSING;
    case OrderStatus.MANUFACTURING:
      return FulfillmentStatus.MANUFACTURING;
    case OrderStatus.QUALITY_CHECK:
      return FulfillmentStatus.QUALITY_CHECK;
    case OrderStatus.SHIPPED:
      return FulfillmentStatus.SHIPPED;
    case OrderStatus.DELIVERED:
      return FulfillmentStatus.DELIVERED;
    default:
      return null;
  }
}

// Progress ranks used to derive an order's overall status from its items: the
// order reflects the *slowest* item (it's only SHIPPED once every item ships).
const FULFILLMENT_RANK: Record<FulfillmentStatus, number> = {
  [FulfillmentStatus.PENDING]: 0,
  [FulfillmentStatus.PROCESSING]: 1,
  [FulfillmentStatus.MANUFACTURING]: 2,
  // M4.3: QUALITY_CHECK is its own stage between MANUFACTURING and SHIPPED.
  // Legacy items left on MANUFACTURING (no data migration) still rank 2, and
  // the recompute is advance-only, so a QC order header is never pulled back.
  [FulfillmentStatus.QUALITY_CHECK]: 3,
  [FulfillmentStatus.SHIPPED]: 4,
  [FulfillmentStatus.DELIVERED]: 5,
};

// How long a card order may hold its stock reservation while unpaid. Stripe
// PaymentIntents are long-lived, so this is generous — it only has to be long
// enough that a genuine checkout (including 3-D Secure) can never hit it.
const ABANDONED_PAYMENT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
// Kustom sessions stay open for 48 hours and the customer completes them in
// an iframe we do not control, so give them a longer window before their
// stock reservation is released. Validation rejects a released order, so a
// late completion can never oversell.
const ABANDONED_KUSTOM_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const ORDER_STATUS_RANK: Record<string, number> = {
  PENDING: 0,
  CONFIRMED: 1,
  PROCESSING: 2,
  MANUFACTURING: 3,
  QUALITY_CHECK: 4,
  SHIPPED: 5,
  DELIVERED: 6,
};

// Map the slowest item's fulfillment stage to a candidate order status.
function fulfillmentStageToOrderStatus(rank: number): OrderStatus | null {
  switch (rank) {
    case 1:
      return OrderStatus.PROCESSING;
    case 2:
      return OrderStatus.MANUFACTURING;
    case 3:
      return OrderStatus.QUALITY_CHECK;
    case 4:
      return OrderStatus.SHIPPED;
    case 5:
      return OrderStatus.DELIVERED;
    default:
      return null; // 0 (PENDING): leave the pre-fulfillment status alone
  }
}

/**
 * Markets app: the UI locale recorded on a market order. Only a locale the
 * market serves is kept (emails, invoices and order pages read it); any
 * other value, or none, falls back to the market's default locale.
 */
export function marketOrderLocale(
  market: Pick<MarketContext, 'defaultLocale' | 'locales'>,
  requested: string | null | undefined,
): string {
  const served = [market.defaultLocale, ...market.locales].map((l) =>
    l.toLowerCase(),
  );
  const want = requested?.trim().toLowerCase().slice(0, 10);
  return want && served.includes(want)
    ? want
    : market.defaultLocale.toLowerCase();
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  // PaymentsModule imports OrdersModule, so a payment provider cannot be
  // injected here without a circular dependency. Providers that need to react
  // to shipment (Kustom captures the authorization then) register a callback
  // instead; it is invoked best-effort and can never block the transition.
  private readonly shippedHooks: ShippedHook[] = [];

  constructor(
    private prisma: PrismaService,
    private promotionsService: PromotionsService,
    private shippingService: ShippingService,
    private mail: MailService,
    private readonly taxService: TaxService,
    private readonly markets: MarketsContextService,
    private readonly marketPricing: MarketPricingService,
    private readonly config: ConfigService,
    private readonly b2b: B2bService,
    // M4.0 (C28): the personalization core and the customer uploads,
    // required (M5 A16: no fallback built on the fly; specs pass
    // `buildPersonalizationCore(prisma)`). Before the optional apps so the
    // positional spec constructors stay valid.
    private readonly core: PersonalizationCoreService,
    private readonly uploads: CustomerUploadsService,
    // Invoices app (M3 D5): optional and trailing, so positional test
    // constructors stay valid. Every trigger is a no-op without the app.
    @Optional() private readonly invoices?: InvoiceTriggersService,
    // b2b app M2.5 (reverse charge): optional and trailing for the same
    // reason. Absent = no exemption is ever applied.
    @Optional() private readonly b2bTax?: B2bTaxExemptionService,
    // M4.1 personalization app (C28): optional, before production. Absent
    // or app off = every line takes the M4.0 path.
    @Optional() private readonly personalization?: PersonalizationService,
    // M4.3 production app (C28): optional and trailing. Absent or app off =
    // no checklist work (one cached isEnabled per hook).
    @Optional() private readonly production?: ProductionTriggersService,
    // M4.2 designer app (C28): optional and trailing. Absent = no line is
    // ever a designer line and no designer trigger runs.
    @Optional() private readonly designerCart?: DesignerCartService,
    @Optional()
    @Inject(DESIGNER_TRIGGERS_PORT)
    private readonly designerTriggers?: DesignerTriggersPort,
  ) {}

  /**
   * Designer app (C29 step 2): per line, the validated designer line or
   * null. One cached isEnabled for a store without the app; without the
   * service injected every entry is null.
   */
  private async planDesignerLines(
    orderStore: OrderStoreContext,
    lines: NormalizedCartLine[],
    contexts: LineContext[],
    opts: {
      mode: DesignerLineMode;
      customerId?: string | null;
      tokens?: (string | null | undefined)[];
      refs: { line_id?: string; line_index?: number }[];
      verifiedDesignIds?: readonly string[] | null;
    },
  ): Promise<(DesignerLine | null)[]> {
    if (!this.designerCart) return lines.map(() => null);
    return this.designerCart.planLines(
      orderStore.id,
      lines.map((l, i) => ({
        product_id: l.custom_product_id
          ? null
          : (l.product_id ?? contexts[i]?.productId ?? null),
        custom_product_id: l.custom_product_id,
        variant_id: l.variant_id,
        design_id: l.design_id ?? null,
        design_token: opts.tokens?.[i] ?? null,
      })),
      {
        mode: opts.mode,
        customerId: opts.customerId,
        refs: opts.refs,
        verifiedDesignIds: opts.verifiedDesignIds,
      },
    );
  }

  /** Runs a designer trigger; a failure never breaks the order flow. */
  private async fireDesigner(
    fn: (t: DesignerTriggersPort) => Promise<void>,
  ): Promise<void> {
    if (!this.designerTriggers) return;
    try {
      await fn(this.designerTriggers);
    } catch (err) {
      this.logger.warn(
        `Designer trigger failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Register a callback to run once an order's status becomes SHIPPED. */
  registerShippedHook(hook: ShippedHook): void {
    this.shippedHooks.push(hook);
  }

  private async runShippedHooks(orderId: string): Promise<void> {
    for (const hook of this.shippedHooks) {
      try {
        await hook(orderId);
      } catch (err) {
        this.logger.warn(
          `Shipped hook failed for order ${orderId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // Reusable include for order items with full product details
  private readonly itemsWithProduct = {
    include: {
      product: {
        include: {
          translations: true,
          images: { take: 1, orderBy: { sort_order: 'asc' as const } },
        },
      },
      variant: {
        include: {
          // Images attached to this specific variant, used when resolving the
          // line's display image (see resolveOrderItemImage).
          images: true,
          product: {
            include: {
              translations: true,
              images: { take: 1, orderBy: { sort_order: 'asc' as const } },
            },
          },
        },
      },
      custom_product: {
        include: {
          translations: true,
          mockup_images: { take: 1, orderBy: { sort_order: 'asc' as const } },
          product: {
            include: {
              translations: true,
              images: { take: 1, orderBy: { sort_order: 'asc' as const } },
            },
          },
        },
      },
      custom_field_values: {
        // Field order first, then insert order (MULTI_IMAGE files keep theirs).
        orderBy: [{ sort_order: 'asc' as const }, { id: 'asc' as const }],
        include: {
          custom_field: { include: { translations: true } },
          // M4.0 WP-B: the private original behind a customer file value.
          upload: {
            select: {
              id: true,
              preview_url: true,
              original_name: true,
              mime: true,
              width: true,
              height: true,
              purged_at: true,
            },
          },
        },
      },
      bundle_offer: {
        include: {
          translations: true,
          bundle: { include: { translations: true } },
        },
      },
      // M4.2 designer: the frozen design of the line (proof image). The key
      // is removed again for lines without one (withItemImages).
      design: {
        select: {
          id: true,
          store_id: true,
          proof_key: true,
          files_purged_at: true,
        },
      },
    },
  };

  /**
   * The image that represents an order line, resolved once here so the
   * storefront, the dashboard and the emails can't drift apart:
   * the creator's mockup (their design of this product) wins, then the image
   * for the option value the buyer chose (their colour), then the product's
   * own photo.
   *
   * Resolved live from the current catalogue, matching how every other order
   * image already behaves — changing a colour photo later also changes it on
   * past orders.
   */
  private resolveOrderItemImage(item: OrderItemImageSource): string | null {
    const mockup = item?.custom_product?.mockup_images?.[0]?.url;
    if (mockup) return mockup;

    const variantImage = resolveVariantImage({
      optionConfig:
        item?.variant?.product?.variant_option_config ??
        item?.product?.variant_option_config ??
        item?.custom_product?.product?.variant_option_config,
      variantOptions: item?.variant?.options,
      variantImages: item?.variant?.images,
    });
    if (variantImage) return variantImage;

    return (
      item?.product?.images?.[0]?.url ||
      item?.variant?.product?.images?.[0]?.url ||
      item?.custom_product?.product?.images?.[0]?.url ||
      null
    );
  }

  /**
   * Stamp every line of an order with its resolved display image. Also the
   * single choke point every order response passes through, so the Kustom
   * push token — a callback secret, useful to nobody outside the API — is
   * dropped here for every role.
   */
  private withItemImages<T extends { items?: unknown } | null>(order: T): T {
    const items = (order as { items?: unknown[] } | null)?.items;
    if (!order || !Array.isArray(items)) return order;
    const { kustom_push_token: _kt, ...rest } = order as {
      kustom_push_token?: string | null;
    };
    void _kt;
    return {
      ...rest,
      items: items.map((it) => {
        // M4.2 designer: a designed line shows its signed proof; lines
        // without a design lose the (null) relation key, so their shape is
        // exactly what it was before the app.
        const { design, ...line } = it as {
          design?: {
            id: string;
            store_id: string;
            proof_key: string | null;
            files_purged_at: Date | null;
          } | null;
        };
        const proofUrl =
          design && this.designerCart
            ? this.designerCart.orderItemProofUrl(design)
            : null;
        return {
          ...line,
          image_url:
            proofUrl ?? this.resolveOrderItemImage(it as OrderItemImageSource),
          ...(design ? { design: { id: design.id, proof_url: proofUrl } } : {}),
        };
      }),
    } as T;
  }

  /**
   * b2b app M2.5: what a customer-facing response may show of the
   * reverse-charge evidence (no internal ids, requester, VIES address or
   * merchant notes). Orders without evidence are returned untouched.
   */
  private forCustomer<T>(order: T): T {
    if (!order || typeof order !== 'object') return order;
    const o = order as { vat_validation?: unknown };
    if (!o.vat_validation) return order;
    return {
      ...order,
      vat_validation: customerVatEvidence(o.vat_validation),
    } as T;
  }

  private generateOrderNumber(): string {
    const prefix = 'ORD';
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}-${timestamp}-${random}`;
  }

  /**
   * The store an order is placed through. It drives the commission model, the
   * COD gate and — for independent stores — which account the customer is
   * charged on, so it must be resolved (and every line verified against it)
   * before any pricing happens; otherwise a client could attribute an order
   * to a store that sells none of these items.
   */
  private async loadOrderStore(
    storeId: string,
    marketKey?: string | null,
    buyerType?: string | null,
    /**
     * Market-preview host, quotes only: a DRAFT market prices the quote.
     * `create()` never passes it, so an order in a non-LIVE market is still
     * refused with MARKET_NOT_LIVE.
     */
    preview?: boolean,
  ): Promise<OrderStoreContext> {
    const orderStore = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: {
        ...taxStoreSelect,
        slug: true,
        creator_id: true,
        currency: true,
        cod_enabled: true,
        is_active: true,
        language_config: { select: { primary_locale: true } },
        creator: { select: kustomCreatorSelect },
      },
    });
    if (!orderStore) {
      throw new NotFoundException({
        code: 'ORDER_STORE_NOT_FOUND',
        message: 'Store not found',
      });
    }
    if (!orderStore.is_active) {
      throw new BadRequestException({
        code: 'ORDER_STORE_INACTIVE',
        message: 'This store is not accepting orders right now.',
      });
    }
    const { language_config, ...store } = orderStore;
    // Markets app: null when off (every pricing step below then runs the
    // pre-markets code); 404 for an unknown or draft key (draft allowed for
    // a preview quote).
    const market =
      preview && marketKey
        ? await this.markets.resolve(orderStore.id, marketKey, {
            preview: true,
          })
        : await this.markets.resolve(orderStore.id, marketKey);
    // b2b app: PERSON unless the request asked for COMPANY and the store
    // accepts it (D1); the flag decides whether the `b2b` block is emitted.
    const b2bEnabled = await this.b2b.isEnabled(orderStore.id);
    const resolvedBuyerType = b2bEnabled
      ? await this.b2b.resolveBuyerType(orderStore.id, buyerType)
      : 'PERSON';
    // Personalization app (M4.1): one cached flag; false without the app.
    const personalizationEnabled = this.personalization
      ? await this.personalization.isEnabled(orderStore.id)
      : false;
    return {
      ...store,
      primary_locale: language_config?.primary_locale ?? null,
      market,
      b2bEnabled,
      buyerType: resolvedBuyerType,
      personalizationEnabled,
    };
  }

  /** The `b2b` response block (D3): display mode and net figures of a result. */
  private b2bTotals(tax: TaxComputeResult): B2bTotals {
    return {
      display_mode: tax.display_mode,
      net_items: tax.net_items,
      net_shipping: tax.net_shipping,
      net_total: tax.net_total,
    };
  }

  /**
   * The storefront host an order was placed on (markets app, D1). Never
   * trusted as sent: it is kept only when it is one of the market's own
   * ACTIVE hostnames or the store's platform subdomain; otherwise the
   * market's primary hostname (null = platform subdomain) is stored.
   * Public so the Kustom session-first flow stores the same value.
   */
  validatedHostname(
    market: MarketContext,
    storeSlug: string,
    hostname?: string | null,
  ): string | null {
    const host = hostname ? normalizeHostname(hostname) : '';
    if (host) {
      if (market.hostnames.includes(host)) return host;
      const base =
        this.config.get<string>('STOREFRONT_URL') || 'http://localhost:3003';
      try {
        if (host === `${storeSlug}.${new URL(base).hostname}`) return host;
      } catch {
        // Malformed base URL: fall through to the primary hostname.
      }
    }
    return market.primaryHostname;
  }

  // Thrown for every line that isn't part of this store's catalogue. The
  // message is deliberately generic — item ids are not echoed back, and a
  // foreign product is indistinguishable from an unpublished one.
  private rejectForeignItem(): never {
    throw new BadRequestException({
      code: 'ORDER_ITEM_NOT_SOLD_BY_STORE',
      message:
        'One of the items in your cart is not available in this store. Please refresh your cart and try again.',
    });
  }

  /**
   * Price one line exactly as the order will record it: the unit price the
   * customer pays, what the provider is owed, who fulfils it and whether stock
   * must be reserved. Shared by create() and quoteLines(), so a quote (a
   * Kustom checkout session) can never total differently from the order it
   * turns into.
   */
  private async priceLine(
    item: NormalizedCartLine,
    orderStore: OrderStoreContext,
    /** Market override rows of the whole order (loadPricesForLines). */
    marketRows: MarketPriceMap | null = null,
    /** M4.1: the line's personalization (evaluated for app lines only). */
    pz: LinePersonalizationInput | null = null,
    /** M5.5: the validated designer line (its add-ons are priced here). */
    designer: DesignerLine | null = null,
  ): Promise<PricedLine> {
    const isIndependentStore = orderStore.store_type === StoreType.INDEPENDENT;
    let unitPrice = 0;
    let providerBasePrice = 0; // per-unit base owed to provider (0 for creator-only products)
    let fulfillerId = '';
    let fulfillerType: 'PROVIDER' | 'CREATOR' = 'PROVIDER';
    let stockOp: StockOp | null = null;
    let taxClassId: string | null = null;
    let taxExempt = false;
    // Own-product lines only (custom products never exist on independent
    // stores, the only ones with markets): what the market conversion needs.
    let marketInput: {
      product_id: string;
      variant_id: string | null;
      basePrice: number;
      adjustment: number;
    } | null = null;
    // Personalization app (D2): set only for this store creator's own
    // products (the branches below have checked ownership).
    let appProduct: {
      id: string;
      variant_option_config: unknown;
    } | null = null;
    let appVariantOptions: unknown = {};
    let variantOptions: Prisma.JsonValue | null = null;

    if (item.custom_product_id) {
      // Custom product (with or without a selected variant)
      const cp = await this.prisma.customProduct.findUnique({
        where: { id: item.custom_product_id },
        include: {
          product: true,
          selected_variants: item.variant_id
            ? { where: { variant_id: item.variant_id } }
            : true,
        },
      });
      if (!cp)
        throw new NotFoundException(
          `Custom product ${item.custom_product_id} not found`,
        );

      // The storefront lists a custom product only when it belongs to this
      // store's creator and is published — enforce the same rule here.
      if (
        cp.creator_id !== orderStore.creator_id ||
        cp.status !== ProductStatus.PUBLISHED
      ) {
        this.rejectForeignItem();
      }

      let variant: { price_adjustment: any } | null = null;
      if (item.variant_id) {
        const variantRow = await this.prisma.productVariant.findUnique({
          where: { id: item.variant_id },
          select: { price_adjustment: true, product_id: true, options: true },
        });
        if (!variantRow)
          throw new NotFoundException(`Variant ${item.variant_id} not found`);
        // The variant must belong to the custom product's base product,
        // otherwise its price adjustment would be borrowed from elsewhere.
        if (variantRow.product_id !== cp.product_id) this.rejectForeignItem();
        variant = variantRow;
        variantOptions = variantRow.options;
      }
      const variantAdjustment = variant
        ? Number(variant.price_adjustment || 0)
        : 0;

      // Compute price based on pricing strategy
      switch (cp.pricing_type) {
        case PricingType.SINGLE:
          // Creator's final_price is THE customer price, regardless of variant
          unitPrice = Number(cp.final_price);
          break;
        case PricingType.PER_VARIANT: {
          if (variant) {
            const selected = cp.selected_variants.find(
              (sv) => sv.variant_id === item.variant_id,
            );
            unitPrice = selected?.custom_price
              ? Number(selected.custom_price)
              : Number(cp.product.base_price) + variantAdjustment;
          } else {
            // No variant chosen on a per-variant product — fall back to final_price
            unitPrice = Number(cp.final_price) || Number(cp.product.base_price);
          }
          break;
        }
        case PricingType.MARGIN:
          unitPrice =
            Number(cp.product.base_price) +
            variantAdjustment +
            Number(cp.margin_amount || 0);
          break;
      }

      // Provider base = their product's base price + variant adjustment (if provider exists)
      if (cp.product.provider_id) {
        providerBasePrice = Number(cp.product.base_price) + variantAdjustment;
      }

      // Provider fulfills the product, creator is the seller
      fulfillerId = cp.product.provider_id || cp.creator_id || '';
      fulfillerType = cp.product.provider_id ? 'PROVIDER' : 'CREATOR';
      taxClassId = cp.product.tax_class_id;
      taxExempt = cp.product.tax_exempt;
    } else if (item.variant_id) {
      const variant = await this.prisma.productVariant.findUnique({
        where: { id: item.variant_id },
        include: { product: true },
      });
      if (!variant)
        throw new NotFoundException(`Variant ${item.variant_id} not found`);

      // A bare variant line sells the creator's own product: it must belong
      // to this store's creator and be published. This is what stops another
      // creator's product being checked out here — and, on an independent
      // store, charged to this store owner's Stripe account.
      if (
        variant.product.creator_id !== orderStore.creator_id ||
        variant.product.status !== ProductStatus.PUBLISHED ||
        !variant.is_active
      ) {
        this.rejectForeignItem();
      }
      // Guard against a variant borrowed from a different product.
      if (item.product_id && variant.product_id !== item.product_id) {
        this.rejectForeignItem();
      }

      unitPrice =
        Number(variant.product.base_price) + Number(variant.price_adjustment);
      appProduct = variant.product;
      appVariantOptions = variant.options;
      variantOptions = variant.options;
      marketInput = {
        product_id: variant.product_id,
        variant_id: variant.id,
        basePrice: Number(variant.product.base_price),
        adjustment: Number(variant.price_adjustment),
      };
      if (variant.product.provider_id) providerBasePrice = unitPrice;
      fulfillerId =
        variant.product.provider_id || variant.product.creator_id || '';
      fulfillerType = variant.product.provider_id ? 'PROVIDER' : 'CREATOR';
      taxClassId = variant.product.tax_class_id;
      taxExempt = variant.product.tax_exempt;
      // Variants track stock when stock_quantity is non-null.
      if (variant.stock_quantity != null) {
        stockOp = { kind: 'variant', id: variant.id, qty: item.quantity };
      }
    } else if (item.product_id) {
      const product = await this.prisma.product.findUnique({
        where: { id: item.product_id },
      });
      if (!product)
        throw new NotFoundException(`Product ${item.product_id} not found`);

      // Same rule as the variant branch: only this store creator's own
      // published products are sellable here. Provider catalogue products
      // (creator_id null) are never sold directly — they reach a storefront
      // as a CustomProduct.
      if (
        product.creator_id !== orderStore.creator_id ||
        product.status !== ProductStatus.PUBLISHED
      ) {
        this.rejectForeignItem();
      }

      unitPrice = Number(product.base_price);
      appProduct = product;
      marketInput = {
        product_id: product.id,
        variant_id: null,
        basePrice: unitPrice,
        adjustment: 0,
      };
      if (product.provider_id) providerBasePrice = unitPrice;
      fulfillerId = product.provider_id || product.creator_id || '';
      fulfillerType = product.provider_id ? 'PROVIDER' : 'CREATOR';
      taxClassId = product.tax_class_id;
      taxExempt = product.tax_exempt;
      // Only enforce when the seller actually tracks inventory for this product.
      if (product.track_inventory && product.stock_quantity != null) {
        stockOp = { kind: 'product', id: product.id, qty: item.quantity };
      }
    } else {
      // No product, variant or custom product on the line — nothing to price
      // or attribute. Never let it through as a free item with no fulfiller.
      this.rejectForeignItem();
    }

    // Independent stores never sell custom products (provider resells) — not
    // even creator-only ones (base product without a provider), which would
    // otherwise slip past the PROVIDER check below.
    if (isIndependentStore && item.custom_product_id) {
      throw new BadRequestException({
        code: 'ORDER_INDEPENDENT_STORE_CUSTOM_ITEM',
        message:
          'This store can only sell its own products. Please remove unavailable items from your cart.',
      });
    }

    // Independent stores are creator-only: reject any line fulfilled by a
    // provider (provider products, or custom products backed by a provider).
    if (isIndependentStore && fulfillerType === 'PROVIDER') {
      throw new BadRequestException({
        code: 'ORDER_INDEPENDENT_STORE_PROVIDER_ITEM',
        message:
          'This store can only sell its own products. Please remove supplier items from your cart.',
      });
    }

    // Markets app: the unit price in the market currency (override or
    // converted). A product hidden in this market is not sold here.
    if (orderStore.market && marketInput) {
      const marketPrice = await this.marketPricing.priceLine(
        orderStore.market,
        marketInput,
        marketRows,
      );
      if (marketPrice == null) this.rejectForeignItem();
      unitPrice = marketPrice;
    }

    // Personalization app (M4.1 D4, C29): app lines are evaluated here so
    // the cart, the quote (Kustom) and the order price them identically.
    // The per-unit delta (base currency) is converted like every base
    // amount and added after the market price, before the bundle discount.
    let personalization: PResult | null = null;
    let personalizationAmount = 0;
    const appDefs = pz
      ? ((pz.ctx.allFields ?? pz.ctx.fields) as unknown as PFieldDef[])
      : [];
    if (
      pz &&
      appProduct &&
      this.personalization &&
      this.personalization.needsEvaluator(appDefs)
    ) {
      // The fields were loaded for the line's product (a variant-only line
      // resolves it from the variant): never evaluate another product's.
      if (pz.ctx.productId && pz.ctx.productId !== appProduct.id) {
        this.rejectForeignItem();
      }
      // Fail closed: with M4.1 config, an app state that could not be read
      // is a 503, never the app-off price (cached flag first).
      const appOn =
        orderStore.personalizationEnabled ||
        (await this.personalization.isEnabledStrict(orderStore.id));
      if (appOn) {
        await this.personalization.assertVariantChosen(
          appProduct.id,
          item.variant_id,
          pz.activeCache,
        );
        personalization = await this.personalization.evaluateLine({
          product: appProduct,
          variantOptions: appVariantOptions,
          defs: appDefs,
          raw: pz.raw,
          locale: pz.locale,
          primaryLocale: orderStore.primary_locale,
          activeCache: pz.activeCache,
        });
        assertPriceEvaluated(personalization);
        if (!personalization.ok) {
          throw personalizationInvalid(personalization.errors, pz.ref);
        }
        if (personalization.priceDeltaMinor > 0) {
          const delta = Number(personalization.priceDelta);
          personalizationAmount = orderStore.market
            ? this.marketPricing.convertMoney(orderStore.market, delta)
            : roundMoney(delta);
          unitPrice = roundMoney(unitPrice + personalizationAmount);
          // Every amount must fit its Decimal(10,2) column.
          assertAmountFits(
            personalizationAmount,
            unitPrice,
            this.lineTotal(unitPrice, item.quantity),
          );
        }
      }
    }

    // Designer app (M5.5): the design's add-ons (base currency, per unit,
    // priced by the server from the product's current config) are
    // converted like every base amount - each unit price, so "× 2" stays
    // exact - and added after the market price, before the bundle. They
    // share the line, hence the product's tax class.
    let designerAddons: PricedAddon[] = [];
    let designerAddonsAmount = 0;
    if (designer?.addons?.length) {
      const market = orderStore.market;
      const conv = convertAddonLines(
        designer.addons,
        market ? (a) => this.marketPricing.convertMoney(market, a) : null,
      );
      designerAddons = conv.lines;
      designerAddonsAmount = conv.total;
      unitPrice = roundMoney(unitPrice + designerAddonsAmount);
      assertAmountFits(
        designerAddonsAmount,
        unitPrice,
        this.lineTotal(unitPrice, item.quantity),
      );
    }

    // Apply bundle pricing if this cart line carries a bundle offer
    let originalUnitPrice: number | null = null;
    if (item.bundle_offer_id) {
      const offer = await this.prisma.bundleOffer.findUnique({
        where: { id: item.bundle_offer_id },
        include: { bundle: true },
      });
      if (!offer || offer.bundle.status !== 'ACTIVE') {
        throw new BadRequestException({
          code: 'ORDER_BUNDLE_OFFER_UNAVAILABLE',
          message: 'Bundle offer is no longer available',
        });
      }
      // A bundle offer only ever lowers the price, so an offer belonging to
      // another creator would be a straight discount on this store's goods.
      if (offer.bundle.creator_id !== orderStore.creator_id)
        this.rejectForeignItem();
      // A FIXED bundle discount is an amount in the base currency; in a
      // market it is converted like shipping and coupons (PERCENTAGE and
      // ITEM are currency-free).
      const discountValue =
        orderStore.market && offer.discount_type === 'FIXED'
          ? this.marketPricing.convertMoney(
              orderStore.market,
              Number(offer.discount_value),
            )
          : offer.discount_value;
      const pricing = computeBundlePricing(unitPrice, {
        quantity: offer.quantity,
        discount_type: offer.discount_type,
        discount_value: discountValue,
      });
      // Quantity must be a positive multiple of the bundle's cart quantity
      if (
        pricing.cartQuantity <= 0 ||
        item.quantity % pricing.cartQuantity !== 0
      ) {
        throw new BadRequestException(
          `Bundle requires quantity in multiples of ${pricing.cartQuantity}`,
        );
      }
      originalUnitPrice = unitPrice;
      unitPrice = pricing.effectiveUnitPrice;

      // Reject the order outright if the bundle discount would force a
      // sale below provider cost. The previous behaviour silently capped
      // the provider's payout — that was unfair to providers. With the
      // economic guard at attach/cart time this case should only trigger
      // when provider pricing changed after the line entered the cart.
      if (providerBasePrice > 0 && unitPrice < providerBasePrice) {
        throw new BadRequestException({
          code: 'ORDER_BUNDLE_BELOW_PROVIDER_COST',
          message:
            'Bundle pricing would sell this item below provider cost. Remove the bundle or adjust pricing.',
        });
      }
    }

    // Money is rounded at the source: every column is Decimal(10,2), so a
    // unit price such as 9.99 (or a bundle's effective price 33.33...) is
    // stored to two decimals here, and the line total below is rounded again
    // from the stored unit price. That keeps unit x quantity, the subtotal
    // and the order total exact in minor units - what the Kustom mapper
    // sends and later verifies (expectedKustomAmount) is the stored figure,
    // never a float that differs from it by a cent.
    return {
      unitPrice: roundMoney(unitPrice),
      originalUnitPrice:
        originalUnitPrice == null ? null : roundMoney(originalUnitPrice),
      providerBasePrice: roundMoney(providerBasePrice),
      fulfillerId,
      fulfillerType,
      stockOp,
      taxClassId,
      taxExempt,
      personalization,
      personalizationAmount,
      designerAddons,
      designerAddonsAmount,
      variantOptions,
    };
  }

  /**
   * Personalization app (M4.1 C1): evaluator lines with their per-unit
   * `price_delta` in the order currency. In a market the converted line
   * total (`personalization_amount`) is split over the priced lines by
   * largest remainder, so the rows always sum exactly to it.
   */
  private orderCurrencyLines(
    lines: readonly PLine[],
    market: MarketContext | null,
    personalizationAmount: number,
  ): PLine[] {
    if (!market) return [...lines];
    const factor = 10 ** Math.min(2, currencyDecimals(market.currency));
    const shares = allocateLargestRemainder(
      Math.round(personalizationAmount * factor),
      lines.map((l) => l.price_delta_minor),
    );
    return lines.map((l, i) =>
      l.price_delta_minor > 0
        ? { ...l, price_delta: (shares[i] / factor).toFixed(2) }
        : l,
    );
  }

  /** The line total as the order stores it (rounded, never a float sum). */
  private lineTotal(unitPrice: number, quantity: number): number {
    return roundMoney(unitPrice * quantity);
  }

  /**
   * Shipping, coupon discount and the resulting total for already-priced
   * lines, applied in the order create() has always applied them: shipping
   * first (an unreachable destination stops everything), then the coupon
   * (validated only — the redemption is claimed by create() itself). With no
   * destination yet (a Kustom session before any address) shipping is
   * skipped and costs nothing.
   *
   * Shipping is quoted as the list of methods for the destination; the one
   * `shippingMethodId` names is used, else the cheapest offered (ties go to
   * the first by sort order). A stale id is rejected
   * (`ORDER_SHIPPING_METHOD_INVALID`) when `strictMethod` is set — what
   * create() wants — and silently replaced by the default otherwise, so a
   * Kustom session keeps a valid selection after the country changes.
   * Method names are resolved in `locale`, defaulting to the store's
   * primary locale (what the order snapshots).
   */
  private async computeTotals(input: {
    orderStore: OrderStoreContext;
    lines: NormalizedCartLine[];
    /** One entry per line: the priced total and the product's tax fields. */
    taxLines: TaxLineInput[];
    subtotal: number;
    providerBaseTotal: number;
    countryCode: string | null;
    /** State / postcode of the destination, for regional rates. */
    region?: string | null;
    postcode?: string | null;
    couponCode?: string | null;
    shippingMethodId?: string | null;
    strictMethod?: boolean;
    locale?: string | null;
    /**
     * b2b app M2.5: reverse-charge inputs (null / absent = off) and, per
     * line, the unit price and quantity behind `taxLines` (for netting).
     */
    exemptionInputs?: ExemptionInputs | null;
    unitLines?: { unit_price: number; quantity: number }[];
  }): Promise<{
    shipping: ShippingQuote | null;
    shippingCost: number;
    shippingMethod: QuotedShippingMethod | null;
    discountAmount: number;
    total: number;
    couponValidation: CouponValidation | null;
    tax: TaxComputeResult;
    /** b2b app M2.5: null while the app or reverse charge is off. */
    exemption: TotalsExemption | null;
  }> {
    const { orderStore, lines, subtotal, providerBaseTotal } = input;
    // Markets app: shipping costs, free-shipping thresholds and fixed coupon
    // amounts are stored in the base currency and converted with the
    // market's rate (L1). `toBase` feeds base-currency comparisons; `convert`
    // brings their results back. Both are identity without a market.
    const market = orderStore.market;
    const toBase = (amount: number) =>
      market ? this.marketPricing.toBaseMoney(market, amount) : amount;
    const convert = (amount: number) =>
      market ? this.marketPricing.convertMoney(market, amount) : amount;
    // Where the goods go: what the tax basis reads (shipping = billing here,
    // the checkout collects one address). Null country = not known yet, the
    // engine then estimates with the registration country.
    const destination: TaxDestination = {
      country: input.countryCode,
      region: input.region ?? null,
      postcode: input.postcode ?? null,
    };
    // Tax context, rates and currency are loaded once (lazily: a path that
    // never taxes never loads them).
    let taxSetup: Promise<{
      ctx: Awaited<ReturnType<TaxService['contextFor']>>;
      data: Awaited<ReturnType<TaxService['loadTaxData']>>;
      currency: string;
    }> | null = null;
    const loadTaxSetup = () =>
      (taxSetup ??= (async () => {
        const ctx = await this.taxService.contextFor(orderStore);
        const data = await this.taxService.loadTaxData(ctx);
        const currency = resolveOrderCurrency(
          orderStore,
          (
            await this.prisma.platformConfig.findFirst({
              select: { default_currency: true },
            })
          )?.default_currency,
          market,
        );
        return { ctx, data, currency };
      })());

    // b2b app M2.5: reverse charge / customer exemption. Decided once, for
    // the destination, before the shipping quote so method costs can be
    // netted. Nothing below changes while the inputs are null.
    let exemption: TotalsExemption | null = null;
    let netting = false;
    const netItemLines = (input.unitLines ?? []).map((u, i) => ({
      unit_price: u.unit_price,
      quantity: u.quantity,
      tax_class_id: input.taxLines[i]?.tax_class_id ?? null,
      tax_exempt: input.taxLines[i]?.tax_exempt ?? false,
    }));
    if (input.exemptionInputs) {
      const { ctx, data, currency } = await loadTaxSetup();
      const decision = decideTaxExemption({
        ctx,
        destinationCountry: input.countryCode,
        buyerType: orderStore.buyerType,
        inputs: input.exemptionInputs,
      });
      let net: ExemptNetPricesResult | null = null;
      if (
        decision.reason &&
        input.unitLines &&
        ctx.pricingMode === TaxPricingMode.INCLUSIVE &&
        input.exemptionInputs.settings.reverse_charge_pricing === 'net'
      ) {
        net = exemptNetPrices({
          ctx,
          data,
          currency,
          lines: netItemLines,
          shippingCosts: [],
          discount_amount: 0,
          subtotal_gross: subtotal,
          pricing: 'net',
        });
        netting = true;
      }
      exemption = { decision, net };
    }

    const taxFor = async (shippingCost: number, discountAmount: number) => {
      const { ctx: baseCtx, data, currency } = await loadTaxSetup();
      // b2b app: the buyer type only sets the result's display_mode; an
      // exemption (M2.5) zeroes every rate.
      const ctx = {
        ...baseCtx,
        ...(orderStore.buyerType === 'COMPANY'
          ? { buyerType: orderStore.buyerType }
          : {}),
        ...(exemption?.decision.reason
          ? { exemption: { reason: exemption.decision.reason } }
          : {}),
      };
      const netLines = exemption?.net;
      return this.taxService.computeTaxes({
        ctx,
        data,
        currency,
        locale: input.locale ?? orderStore.primary_locale,
        lines: netLines
          ? input.taxLines.map((l, i) => ({
              ...l,
              amount: netLines.line_totals[i] ?? l.amount,
            }))
          : input.taxLines,
        shipping_cost: shippingCost,
        discount_amount: discountAmount,
        shipping: destination,
        billing: destination,
      });
    };
    const isIndependentStore = orderStore.store_type === StoreType.INDEPENDENT;
    const productIds = lines
      .map((item) => item.product_id || item.custom_product_id)
      .filter(Boolean) as string[];
    const totalItemCount = lines.reduce((sum, i) => sum + i.quantity, 0);

    // Quote every shipping method for the destination and pick one
    let shipping: ShippingQuote | null = null;
    let shippingCost = 0;
    let shippingMethod: QuotedShippingMethod | null = null;
    if (input.countryCode) {
      const quote = await this.shippingService.quoteForItems({
        product_ids: productIds,
        country_code: input.countryCode,
        item_count: totalItemCount,
        subtotal: toBase(subtotal),
        locale: input.locale ?? orderStore.primary_locale ?? undefined,
      });
      if (market) {
        // Method costs are quoted in the base currency; present them in the
        // market's so the customer picks between converted prices.
        for (const m of quote.methods) m.cost = convert(m.cost);
      }
      if (netting && exemption?.net?.shipping_rate_bp) {
        // b2b app M2.5 (D5): an exempt company pays the method costs without
        // the registration-country VAT (after the market conversion).
        const { currency } = await loadTaxSetup();
        const rate = exemption.net.shipping_rate_bp;
        for (const m of quote.methods) {
          m.cost = netOfRate(m.cost, rate, currency);
        }
      }
      if (!quote.available) {
        const tax = await taxFor(0, 0);
        return {
          shipping: {
            available: false,
            message: quote.message || 'Shipping not available to your country',
          },
          shippingCost: 0,
          shippingMethod: null,
          discountAmount: 0,
          total: tax.total,
          couponValidation: null,
          tax,
          exemption,
        };
      }
      const requested = input.shippingMethodId
        ? quote.methods.find((m) => m.id === input.shippingMethodId)
        : undefined;
      if (input.shippingMethodId && !requested && input.strictMethod) {
        throw new BadRequestException({
          code: 'ORDER_SHIPPING_METHOD_INVALID',
          message:
            'The selected shipping method is not available for your address. Please choose another one.',
        });
      }
      shippingMethod = requested ?? this.cheapestMethod(quote.methods);
      shippingCost = roundMoney(shippingMethod?.cost ?? 0);
      shipping = {
        available: true,
        cost: shippingCost,
        estimated_days: shippingMethod?.estimated_days ?? null,
        method: shippingMethod,
        methods: quote.methods,
      };
    }

    // Apply coupon discount
    let discountAmount = 0;
    let couponValidation: CouponValidation | null = null;

    if (input.couponCode) {
      couponValidation = await this.promotionsService.validateCoupon({
        coupon_code: input.couponCode,
        store_id: orderStore.id,
        subtotal: toBase(subtotal),
        item_count: totalItemCount,
        product_ids: productIds,
      });

      discountAmount = roundMoney(convert(couponValidation.discount_amount));

      if (couponValidation.free_shipping) {
        shippingCost = 0;
      }

      // Cap discount so total never goes negative
      if (discountAmount > subtotal) {
        discountAmount = subtotal;
      }

      // Reject rather than sell below provider cost — the same economic guard
      // the bundle path applies. Without it a percentage coupon silently
      // scales the provider's payout below the base price they are owed.
      if (
        !isIndependentStore &&
        subtotal - discountAmount < providerBaseTotal
      ) {
        throw new BadRequestException({
          code: 'ORDER_DISCOUNT_BELOW_PROVIDER_COST',
          message:
            'This coupon cannot be applied to the items in your cart. Please remove it and try again.',
        });
      }
    }

    // b2b app M2.5 (D5): the coupon was evaluated on the gross subtotal (the
    // same cart qualifies either way); the netted order gets the discount
    // scaled by subtotal_net / subtotal_gross.
    if (netting && exemption?.net && discountAmount > 0) {
      const { ctx, data, currency } = await loadTaxSetup();
      discountAmount = exemptNetPrices({
        ctx,
        data,
        currency,
        lines: netItemLines,
        shippingCosts: [],
        discount_amount: discountAmount,
        subtotal_gross: subtotal,
        pricing: 'net',
      }).discount_amount;
      // The quote's coupon block shows the same (net) amount the buyer gets.
      if (couponValidation) {
        couponValidation = {
          ...couponValidation,
          discount_amount: discountAmount,
        };
      }
    }

    // Taxes: the discount is allocated across the lines first, every line
    // and the shipping are taxed and rounded in minor units, and the total
    // comes back as the sum of those parts — in INCLUSIVE mode that is
    // exactly subtotal + shipping - discount, in EXCLUSIVE mode the tax is
    // added on top (what Stripe / COD / Kustom charge).
    const tax = await taxFor(shippingCost, discountAmount);
    const total = roundMoney(tax.total);
    return {
      shipping,
      shippingCost,
      shippingMethod,
      discountAmount,
      total,
      couponValidation,
      tax,
      exemption,
    };
  }

  /**
   * b2b app M2.5: the quote / response block of a reverse-charge decision.
   * Emitted only while the app and reverse charge are on (inputs non-null).
   */
  private quoteExemption(
    inputs: ExemptionInputs,
    exemption: TotalsExemption | null,
  ): {
    tax_exempt_reason: TaxExemptReason | null;
    tax_exemption: QuoteTaxExemption;
  } {
    const decision = exemption?.decision ?? null;
    const evidence =
      decision && decision.reason ? decision.evidence : inputs.vat;
    return {
      tax_exempt_reason: decision?.reason ?? null,
      tax_exemption: {
        reason: decision?.reason ?? null,
        vat_number: evidence?.vat_number || null,
        name: evidence?.valid ? evidence.name : null,
        checked_at: evidence?.checked_at ?? null,
        why: decision && !decision.reason ? decision.why : null,
      },
    };
  }

  /**
   * Default shipping method when the customer picked none: the cheapest
   * offered; among equally priced ones the first, i.e. the lowest sort order
   * (the shipping module quotes methods in that order).
   */
  private cheapestMethod(
    methods: QuotedShippingMethod[],
  ): QuotedShippingMethod | null {
    let best: QuotedShippingMethod | null = null;
    for (const m of methods) if (!best || m.cost < best.cost) best = m;
    return best;
  }

  /**
   * Price a set of lines for a store without creating anything: the same
   * per-line pricing, shipping and coupon logic as create(), so the numbers
   * are the ones an order from these lines would carry. Used by the
   * Kustom-first checkout, which must show — and later validate — the exact
   * total before an order exists. Throws the same errors as create() for
   * foreign / unavailable items and invalid coupons; an unreachable shipping
   * destination is reported, not thrown. `shippingMethodId` is honoured when
   * still offered and otherwise replaced by the first method (never thrown);
   * `locale` only changes the language of the method names.
   */
  async quoteLines(
    storeId: string,
    lines: CartLineLike[],
    opts: {
      countryCode: string | null;
      region?: string | null;
      postcode?: string | null;
      couponCode?: string | null;
      shippingMethodId?: string | null;
      locale?: string | null;
      /** Markets app: the market to price in (default market when omitted). */
      marketKey?: string | null;
      /** Market-preview host: price a DRAFT market (quotes only). */
      preview?: boolean;
      /** b2b app: 'COMPANY' for the company view (ignored while the app is off). */
      buyerType?: string | null;
      /** b2b app M2.5: the company's VAT number (COMPANY only). */
      vatNumber?: string | null;
      /** b2b app M2.5: logged-in shopper (customer exemptions). */
      userId?: string | null;
      /**
       * b2b app M2.5: inputs prepared by the caller (Kustom, from stored
       * evidence). Undefined = prepared here from the caches only.
       */
      exemptionInputs?: ExemptionInputs | null;
      /** Cart row ids, index-aligned with `lines` (logged-in cart quote). */
      lineIds?: (string | undefined)[];
      /**
       * Designer app: an order-bound quote (Kustom session pricing). Only
       * the designs the session verified, or owned by `customerId`, are
       * priced; anything else is 403 DESIGNER_DESIGN_FORBIDDEN.
       */
      designOwnership?: {
        customerId: string | null;
        verifiedDesignIds: readonly string[];
      } | null;
    },
  ): Promise<OrderQuote> {
    const orderStore = await this.loadOrderStore(
      storeId,
      opts.marketKey,
      opts.buyerType,
      opts.preview,
    );
    const exemptionInputs =
      opts.exemptionInputs !== undefined
        ? opts.exemptionInputs
        : ((await this.b2bTax?.prepare(orderStore.id, {
            buyerType: orderStore.buyerType,
            vatNumber: opts.vatNumber ?? null,
            userId: opts.userId ?? null,
            mode: 'cached',
            source: 'quote',
          })) ?? null);
    const items = lines.map(normalizeCartLine);
    if (items.length === 0) {
      throw new BadRequestException({
        code: 'ORDER_CART_EMPTY',
        message: 'Cart is empty',
      });
    }

    let subtotal = 0;
    let providerBaseTotal = 0;
    const quotedItems: Omit<
      OrderQuoteItem,
      'tax_rate_bp' | 'tax_amount' | 'tax_class_key'
    >[] = [];
    const taxLines: TaxLineInput[] = [];
    const unitLines: { unit_price: number; quantity: number }[] = [];
    const marketRows = orderStore.market
      ? await this.marketPricing.loadPricesForLines(orderStore.market, items)
      : null;
    // M4.0 (K2): field rules of every line, batched (Kustom budget, W14).
    const fieldContexts = await this.core.loadContexts(items);
    // M4.2 designer (C29 step 2): price-only check of designer lines (the
    // token, when a guest line sends one, must match).
    const designerLines = await this.planDesignerLines(
      orderStore,
      items,
      fieldContexts,
      {
        mode: 'quote',
        ...(opts.designOwnership
          ? {
              customerId: opts.designOwnership.customerId,
              verifiedDesignIds: opts.designOwnership.verifiedDesignIds,
            }
          : {}),
        tokens: lines.map((l) => l.design_token),
        refs: items.map((_, index) => {
          const lineId = opts.lineIds?.[index];
          return lineId
            ? { line_id: lineId, line_index: index }
            : { line_index: index };
        }),
      },
    );
    // M4.1: active variants per product, one query per product per quote.
    const activeCache: ActiveVariantsCache = new Map();
    const quotedValues: {
      ctx: LineContext;
      values: NormalizedValues;
      ref: { line_id?: string; line_index: number };
    }[] = [];
    for (const [index, item] of items.entries()) {
      const lineId = opts.lineIds?.[index];
      const ref = lineId
        ? { line_id: lineId, line_index: index }
        : { line_index: index };
      // A designer line carries no field values (C29): no personalization
      // input, no field rules; its add-ons are priced in priceLine (M5.5).
      const designer = designerLines[index];
      const priced = await this.priceLine(
        item,
        orderStore,
        marketRows,
        designer
          ? null
          : {
              ctx: fieldContexts[index],
              raw: item.custom_fields,
              locale: opts.locale,
              ref,
              activeCache,
            },
        designer,
      );
      quotedValues.push({
        ctx: fieldContexts[index],
        // M4.1: an app line's values come from the evaluator (priceLine).
        values: designer
          ? {}
          : priced.personalization
            ? (priced.personalization.values as NormalizedValues)
            : this.core.assertLine(
                item.custom_fields,
                fieldContexts[index],
                opts.locale,
                ref,
              ),
        ref,
      });
      const totalPrice = this.lineTotal(priced.unitPrice, item.quantity);
      unitLines.push({ unit_price: priced.unitPrice, quantity: item.quantity });
      const providerBaseForItem = this.lineTotal(
        Math.min(priced.providerBasePrice, priced.unitPrice),
        item.quantity,
      );
      providerBaseTotal += providerBaseForItem;
      subtotal += totalPrice;
      quotedItems.push({
        product_id: item.product_id,
        variant_id: item.variant_id,
        custom_product_id: item.custom_product_id,
        bundle_offer_id: item.bundle_offer_id,
        quantity: item.quantity,
        unit_price: priced.unitPrice,
        original_unit_price: priced.originalUnitPrice,
        total_price: totalPrice,
        // M5.5: key only on lines with add-ons (G0 quote shape).
        ...(priced.designerAddons.length
          ? { designer_addons: priced.designerAddons }
          : {}),
      });
      taxLines.push({
        amount: totalPrice,
        tax_class_id: priced.taxClassId,
        tax_exempt: priced.taxExempt,
      });
    }
    // Customer files behind preview URLs must still be linkable to an order
    // of this store (same check as create); no query without preview URLs.
    await this.core.assertUploadsAvailable(
      quotedValues,
      orderStore.id,
      opts.locale,
    );
    subtotal = roundMoney(subtotal);
    providerBaseTotal = roundMoney(providerBaseTotal);

    const totals = await this.computeTotals({
      orderStore,
      lines: items,
      taxLines,
      subtotal,
      providerBaseTotal,
      countryCode: opts.countryCode,
      region: opts.region,
      postcode: opts.postcode,
      couponCode: opts.couponCode,
      shippingMethodId: opts.shippingMethodId,
      strictMethod: false,
      locale: opts.locale,
      exemptionInputs,
      unitLines,
    });

    const platformConfig = await this.prisma.platformConfig.findFirst({
      select: { default_currency: true },
    });
    const currency = resolveOrderCurrency(
      orderStore,
      platformConfig?.default_currency,
      orderStore.market,
    );
    const { tax } = totals;
    // b2b app M2.5: an exempt company on a 'net' INCLUSIVE store is quoted
    // the netted line prices (what the order and Kustom will carry).
    const net = totals.exemption?.net;
    if (net) {
      quotedItems.forEach((item, i) => {
        item.unit_price = net.unit_prices[i];
        item.total_price = net.line_totals[i];
        if (item.original_unit_price != null) {
          item.original_unit_price = netOfRate(
            item.original_unit_price,
            net.line_rate_bp[i],
            currency,
          );
        }
      });
      subtotal = net.subtotal;
    }
    return {
      items: quotedItems.map((item, i) => ({
        ...item,
        tax_rate_bp: tax.items[i]?.tax_rate_bp ?? 0,
        tax_amount: tax.items[i]?.tax_amount ?? 0,
        tax_class_key: tax.items[i]?.tax_class_key ?? null,
      })),
      subtotal,
      shipping_cost: totals.shippingCost,
      discount_amount: totals.discountAmount,
      total: totals.total,
      currency,
      tax_rate_bp: tax.headline_rate_bp,
      tax_amount: tax.tax_total,
      tax_lines: tax.tax_lines,
      tax_total: tax.tax_total,
      tax_pricing_mode: tax.tax_pricing_mode,
      tax_basis_country: tax.tax_basis_country,
      shipping_tax_amount: tax.shipping_tax_amount,
      shipping_tax_rate_bp: tax.shipping_tax_rate_bp,
      shipping: totals.shipping,
      shipping_method_id: totals.shippingMethod?.id ?? null,
      shipping_method_name: totals.shippingMethod?.name ?? null,
      shipping_method_type: totals.shippingMethod?.type ?? null,
      coupon: totals.couponValidation,
      ...(orderStore.market
        ? {
            market: {
              key: orderStore.market.key,
              currency: orderStore.market.currency,
              rate: orderStore.market.rate,
            },
          }
        : {}),
      ...(orderStore.b2bEnabled ? { b2b: this.b2bTotals(tax) } : {}),
      ...(exemptionInputs
        ? this.quoteExemption(exemptionInputs, totals.exemption)
        : {}),
    };
  }

  /**
   * `POST /orders/quote`: the full OrderQuote for explicit lines, or — with
   * no lines and a logged-in customer — for the server cart. Guests must
   * send lines. Nothing is reserved or claimed; the classic checkout calls
   * this once the address country is known to show the taxed total.
   */
  async quote(
    userId: string | null,
    dto: {
      store_id: string;
      lines?: CartLineLike[] | null;
      country_code?: string | null;
      region?: string | null;
      postcode?: string | null;
      shipping_method_id?: string | null;
      coupon_code?: string | null;
      locale?: string | null;
      market_key?: string | null;
      preview?: boolean;
      buyer_type?: string | null;
      vat_number?: string | null;
    },
  ): Promise<OrderQuote> {
    let lines: CartLineLike[] = dto.lines ?? [];
    let lineIds: (string | undefined)[] | undefined;
    if (!lines.length && userId) {
      const customer = await this.prisma.customer.findUnique({
        where: { user_id: userId },
        select: { cart: { select: { items: true } } },
      });
      lines = customer?.cart?.items ?? [];
      // Cart rows: personalization errors also name the row (line_id), so
      // the storefront can point at the product whatever the row order.
      lineIds = lines.map((l) => (l as { id?: string }).id);
    }
    if (!lines.length) {
      throw new BadRequestException({
        code: 'ORDER_CART_EMPTY',
        message: 'Cart is empty',
      });
    }
    return this.quoteLines(dto.store_id, lines, {
      lineIds,
      countryCode: dto.country_code?.trim().toUpperCase() || null,
      region: dto.region ?? null,
      postcode: dto.postcode ?? null,
      couponCode: dto.coupon_code ?? null,
      shippingMethodId: dto.shipping_method_id ?? null,
      locale: dto.locale ?? null,
      marketKey: dto.market_key ?? null,
      preview: dto.preview === true,
      buyerType: dto.buyer_type ?? null,
      vatNumber: dto.vat_number ?? null,
      userId,
    });
  }

  /**
   * Place an order for the customer's cart — or, when `opts.lines` is given,
   * for that snapshot instead (a Kustom-first checkout, whose lines never
   * lived in the server cart). With a snapshot the cart is neither required
   * nor emptied; everything else (pricing, stock, coupon, commission) is the
   * same path.
   */
  async create(
    userId: string,
    dto: CreateOrderDto,
    opts: CreateOrderOptions = {},
  ) {
    // Card orders reserve stock while they wait for payment. Nothing releases
    // that reservation when the buyer simply walks away — Stripe only reports
    // explicit failures — so sweep expired ones here. Doing it on the order
    // path keeps cleanup proportional to traffic without adding a scheduler.
    // A snapshot order (opts.lines) is created inside Kustom's 3 s validation
    // callback, where every extra query counts; the sweep runs on the next
    // cart checkout instead.
    if (!opts.lines) await this.releaseExpiredAwaitingPaymentOrders();

    const customer = await this.prisma.customer.findUnique({
      where: { user_id: userId },
    });
    if (!customer)
      throw new NotFoundException({
        code: 'ORDER_CUSTOMER_NOT_FOUND',
        message: 'Customer not found',
      });

    // Source of the lines: the caller's snapshot, else the customer's cart.
    let cart: { id: string } | null = null;
    let lines: NormalizedCartLine[];
    if (opts.lines) {
      lines = opts.lines.map(normalizeCartLine);
      if (lines.length === 0) {
        throw new BadRequestException({
          code: 'ORDER_CART_EMPTY',
          message: 'Cart is empty',
        });
      }
    } else {
      const loaded = await this.prisma.cart.findUnique({
        where: { customer_id: customer.id },
        include: { items: true },
      });
      if (!loaded || loaded.items.length === 0) {
        throw new BadRequestException({
          code: 'ORDER_CART_EMPTY',
          message: 'Cart is empty',
        });
      }
      cart = { id: loaded.id };
      lines = loaded.items;
    }

    // Calculate prices
    let subtotal = 0;
    let providerBaseTotal = 0; // what providers are owed (their base prices)
    let creatorMarginTotal = 0; // what creators are owed (their markup or creator-only revenue)
    const orderItems: PendingOrderItem[] = [];

    // Collected during the loop and decremented atomically before order.create.
    // Only items whose product/variant tracks inventory go in here — others are
    // treated as unlimited (consistent with track_inventory=false / null stock).
    const stockOps: StockOp[] = [];
    // One entry per order item, in order: what the tax engine needs per line.
    const taxLines: TaxLineInput[] = [];
    // b2b app M2.5: unit price and quantity per line (reverse-charge netting).
    const unitLines: { unit_price: number; quantity: number }[] = [];

    const orderStore = await this.loadOrderStore(
      dto.store_id,
      dto.market_key,
      dto.buyer_type,
    );
    const isIndependentStore = orderStore.store_type === StoreType.INDEPENDENT;
    // b2b app: a COMPANY request the store does not accept is refused rather
    // than silently placed as a person (the storefront showed net prices).
    if (dto.buyer_type === 'COMPANY' && orderStore.buyerType !== 'COMPANY') {
      throw new BadRequestException(B2B_COMPANY_NOT_ALLOWED);
    }

    const requestedPaymentMethod: PaymentMethod =
      dto.payment_method || PaymentMethod.COD;

    // Cash on delivery is opt-in per store (off by default) — reject COD
    // orders for stores that haven't enabled it.
    if (
      requestedPaymentMethod === PaymentMethod.COD &&
      !orderStore.cod_enabled
    ) {
      throw new BadRequestException({
        code: 'ORDER_COD_DISABLED',
        message:
          'Cash on delivery is not available for this store. Please pay by card.',
      });
    }

    // Kustom settles on the creator's own merchant account, so it is only
    // offered by independent stores whose creator finished the Kustom setup.
    if (
      requestedPaymentMethod === PaymentMethod.KUSTOM &&
      !isKustomEnabledForStore({
        ...orderStore,
        currency: resolveOrderCurrency(
          orderStore,
          (
            await this.prisma.platformConfig.findFirst({
              select: { default_currency: true },
            })
          )?.default_currency,
          orderStore.market,
        ),
      })
    ) {
      throw new BadRequestException({
        code: 'ORDER_KUSTOM_UNAVAILABLE',
        message:
          'Kustom Checkout is not available for this store. Please choose another payment method.',
      });
    }

    const marketRows = orderStore.market
      ? await this.marketPricing.loadPricesForLines(orderStore.market, lines)
      : null;
    // M4.0: field definitions + creator values of every line, batched; the
    // validated values per line feed the snapshot writer after the loop.
    const fieldContexts = await this.core.loadContexts(lines);
    // M4.2 designer (C29 step 2): designer lines are validated here (owner
    // and completeness). A stored checkout snapshot trusts only the designs
    // its session verified when it stored the lines.
    const designerLines = await this.planDesignerLines(
      orderStore,
      lines,
      fieldContexts,
      {
        mode: opts.lines ? 'snapshot' : 'order',
        customerId: customer.id,
        verifiedDesignIds: opts.lines ? (opts.verifiedDesignIds ?? []) : null,
        refs: lines.map((l, index) =>
          l.id ? { line_id: l.id } : { line_index: index },
        ),
      },
    );
    // M4.1: active variants per product, one query per product per order.
    const activeCache: ActiveVariantsCache = new Map();
    const designerAddonsAt = new Map<
      number,
      { lines: PricedAddon[]; total: number }
    >();
    const lineValues: {
      ctx: LineContext;
      values: NormalizedValues;
      /** M4.1: snapshot lines of an app line (order currency). */
      lines?: PLine[];
    }[] = [];
    for (const [index, item] of lines.entries()) {
      // M4.0 (§4): the line's personalization source: the per-item
      // customization of the request when present, else the cart row /
      // snapshot line's custom_fields. M4.1: evaluated inside priceLine
      // for app lines (never trusted, priced server-side).
      const dtoCustomization = item.id
        ? dto.item_customizations?.[item.id]
        : undefined;
      const rawValues = dtoCustomization?.custom_field_values?.length
        ? this.core.valuesFromLegacyDto(dtoCustomization.custom_field_values)
        : item.custom_fields;
      const lineRef = item.id ? { line_id: item.id } : { line_index: index };
      // M4.2: a designer line carries no field values (C29); its price is
      // the product's plus its add-ons (M5.5, priced in priceLine).
      const designer = designerLines[index];
      const priced = await this.priceLine(
        item,
        orderStore,
        marketRows,
        designer
          ? null
          : {
              ctx: fieldContexts[index],
              raw: rawValues,
              locale: dto.locale,
              ref: lineRef,
              activeCache,
            },
        designer,
      );
      const {
        unitPrice,
        originalUnitPrice,
        providerBasePrice,
        fulfillerId,
        fulfillerType,
      } = priced;
      if (priced.stockOp) stockOps.push(priced.stockOp);
      // M5.5: the add-ons priced into the line (order currency), frozen
      // with its design below.
      if (priced.designerAddons.length) {
        designerAddonsAt.set(index, {
          lines: priced.designerAddons,
          total: priced.designerAddonsAmount,
        });
      }

      const totalPrice = this.lineTotal(unitPrice, item.quantity);
      // Defensive clamp kept for any non-bundle edge case; the bundle path is
      // already guaranteed safe above.
      const cappedProviderBase = Math.min(providerBasePrice, unitPrice);
      const providerBaseForItem = this.lineTotal(
        cappedProviderBase,
        item.quantity,
      );
      providerBaseTotal += providerBaseForItem;
      creatorMarginTotal += totalPrice - providerBaseForItem;
      subtotal += totalPrice;
      taxLines.push({
        amount: totalPrice,
        tax_class_id: priced.taxClassId,
        tax_exempt: priced.taxExempt,
      });
      unitLines.push({ unit_price: unitPrice, quantity: item.quantity });

      // M4.0: validated against the product's fields (unknown keys
      // dropped, creator values injected); M4.1 app lines: the evaluator's
      // canonical values and lines.
      lineValues.push(
        designer
          ? { ctx: fieldContexts[index], values: {} }
          : priced.personalization
            ? {
                ctx: fieldContexts[index],
                values: priced.personalization.values as NormalizedValues,
                lines: this.orderCurrencyLines(
                  priced.personalization.lines,
                  orderStore.market,
                  priced.personalizationAmount,
                ),
              }
            : {
                ctx: fieldContexts[index],
                values: this.core.assertLine(
                  rawValues,
                  fieldContexts[index],
                  dto.locale,
                  lineRef,
                ),
              },
      );

      orderItems.push({
        product_id: item.product_id,
        variant_id: item.variant_id,
        custom_product_id: item.custom_product_id,
        bundle_offer_id: item.bundle_offer_id || null,
        quantity: item.quantity,
        unit_price: unitPrice,
        original_unit_price: originalUnitPrice,
        total_price: totalPrice,
        provider_base_amount: providerBaseForItem,
        fulfiller_type: fulfillerType,
        fulfiller_id: fulfillerId,
        customer_design_url: dtoCustomization?.customer_design_url,
        design_notes: dtoCustomization?.design_notes,
        // M4.1 (C3): per-unit delta; the key is absent (null) without one.
        ...(priced.personalizationAmount > 0
          ? { personalization_amount: priced.personalizationAmount }
          : {}),
        // M4.3: the option map as sold (production `opt:` checks read it,
        // never the live variant). Absent (null) for lines without one.
        ...(isOptionMap(priced.variantOptions)
          ? { variant_options_snapshot: priced.variantOptions }
          : {}),
      });
    }

    // M4.0 (K8, C19): snapshot rows built from the validated values and
    // created nested inside order.create below, so they can never be
    // matched to the wrong line nor written outside the insert. Lines
    // without values get no key at all (G0).
    const uploadsByUrl = await this.core.resolveUploads(
      lineValues,
      orderStore.id,
    );
    // M4.2 designer (D11, C19): each designed line freezes its design
    // (`items.create[].design.create`, same insert as the order, so the
    // order id is chosen here) and gets one `source:'DESIGN'` value row per
    // text. Orders without designer lines keep a database-generated id.
    const designIds: string[] = [];
    // Frozen at the state_version validated + snapshotted here (markOrdered).
    const designFreeze: { id: string; state_version: number }[] = [];
    let orderId: string | undefined;
    const designSnapshots = new Map<
      number,
      Awaited<ReturnType<DesignerCartService['snapshot']>>
    >();
    // M5.5: the order currency, resolved only when a line has add-ons
    // (their detail rows show amounts).
    const addonsCurrency = designerAddonsAt.size
      ? resolveOrderCurrency(
          orderStore,
          (
            await this.prisma.platformConfig.findFirst({
              select: { default_currency: true },
            })
          )?.default_currency,
          orderStore.market,
        )
      : null;
    for (const [index, designer] of designerLines.entries()) {
      if (!designer || !this.designerCart) continue;
      orderId ??= randomUUID();
      designIds.push(designer.design.id);
      designFreeze.push({
        id: designer.design.id,
        state_version: designer.design.state_version,
      });
      designSnapshots.set(
        index,
        await this.designerCart.snapshot(designer, {
          orderId,
          storeId: orderStore.id,
          locale: dto.locale,
          primaryLocale: orderStore.primary_locale,
          ...(designerAddonsAt.has(index)
            ? {
                addons: designerAddonsAt.get(index)!.lines,
                addonsTotal: designerAddonsAt.get(index)!.total,
                currency: addonsCurrency,
              }
            : {}),
        }),
      );
    }
    const attachUploadIds: string[] = [];
    // M5 A3: upload id → field + line, for the markAttached error body.
    const uploadRefs = new Map<string, UploadRef>();
    lineValues.forEach(({ ctx, values, lines: appLines }, index) => {
      const ref = lines[index].id
        ? { line_id: lines[index].id }
        : { line_index: index };
      const design = designSnapshots.get(index);
      if (design) orderItems[index].design = { create: design.create };
      const rows: OrderValueRow[] = this.core.buildOrderValues(
        ref,
        ctx,
        values,
        {
          uploads: uploadsByUrl,
          locale: dto.locale,
          // M4.1: app lines become grouped snapshot rows (C1/C19).
          ...(appLines ? { lines: appLines } : {}),
          ...(design ? { designTexts: design.designTexts } : {}),
        },
      );
      if (rows.length === 0) return;
      orderItems[index].custom_field_values = { create: rows };
      attachUploadIds.push(...this.core.uploadIdsOf(rows));
      this.core.uploadRefsOf(rows, ctx, ref, uploadRefs);
    });

    subtotal = roundMoney(subtotal);
    providerBaseTotal = roundMoney(providerBaseTotal);
    creatorMarginTotal = roundMoney(creatorMarginTotal);

    // Calculate shipping cost based on product profiles and destination
    const shippingAddress = await this.prisma.address.findUnique({
      where: { id: dto.address_id },
    });
    if (!shippingAddress)
      throw new NotFoundException({
        code: 'ORDER_SHIPPING_ADDRESS_NOT_FOUND',
        message: 'Shipping address not found',
      });

    // b2b app (D4/D8): the body's `company` object is the source of truth
    // for the order snapshot, validated for the destination country (format
    // only, D7) and written next to the market columns below. Empty for a
    // person, so the insert is identical to today's.
    const b2bColumns: Partial<CompanySnapshot> =
      orderStore.buyerType === 'COMPANY'
        ? (opts.companySnapshot ??
          this.b2b.validateCompany(
            dto.company,
            shippingAddress.country_code,
            await this.b2b.getSettings(orderStore.id),
          ))
        : {};

    // b2b app M2.5 (D8): reverse charge is decided by the server from the
    // VIES result it fetched itself (cache within 24 h, else live, 4 s) -
    // or, for a Kustom checkout, from the inputs the session already holds.
    // Null while the app or reverse charge is off. A snapshot checkout
    // (opts.lines, the Kustom validation callback) that passed no inputs
    // gets none: never a VIES call inside its time budget, and the same
    // (non-exempt) decision its session quote was priced with.
    const exemptionInputs =
      opts.exemptionInputs !== undefined
        ? opts.exemptionInputs
        : ((await this.b2bTax?.prepare(
            orderStore.id,
            opts.lines
              ? {
                  buyerType: orderStore.buyerType,
                  vatNumber: null,
                  customerId: null,
                  mode: 'stored',
                  stored: null,
                }
              : {
                  buyerType: orderStore.buyerType,
                  vatNumber: b2bColumns.vat_number ?? null,
                  customerId: customer.id,
                  mode: 'live',
                  source: 'order',
                },
          )) ?? null);

    const totals = await this.computeTotals({
      orderStore,
      lines,
      taxLines,
      subtotal,
      providerBaseTotal,
      countryCode: shippingAddress.country_code,
      region: shippingAddress.state,
      postcode: shippingAddress.postal_code,
      couponCode: dto.coupon_code,
      shippingMethodId: dto.shipping_method_id ?? null,
      strictMethod: true,
      exemptionInputs,
      unitLines,
    });

    if (totals.shipping && !totals.shipping.available) {
      throw new BadRequestException(
        totals.shipping.message || 'Shipping not available to your country',
      );
    }

    // b2b app M2.5 (D8): the buyer saw a VAT-free quote; never silently
    // charge VAT instead. Thrown before any stock or coupon is claimed.
    const exemptDecision = totals.exemption?.decision ?? null;
    if (
      dto.expect_reverse_charge &&
      exemptDecision?.reason !== 'REVERSE_CHARGE'
    ) {
      throw new ConflictException({
        code: B2B_REVERSE_CHARGE_NOT_CONFIRMED,
        message:
          'The VAT number could not be confirmed for reverse charge. Please review the updated total.',
        why: !exemptDecision
          ? 'APP_OFF'
          : exemptDecision.reason
            ? // VAT-free, but as a customer exemption, not reverse charge.
              'CUSTOMER_EXEMPT'
            : exemptDecision.why,
      });
    }
    // Netted prices of an exempt company ('net' pricing, INCLUSIVE store):
    // the order lines and subtotal carry what the buyer actually pays.
    const netPrices = totals.exemption?.net ?? null;
    if (netPrices) {
      const netCurrency = resolveOrderCurrency(
        orderStore,
        (
          await this.prisma.platformConfig.findFirst({
            select: { default_currency: true },
          })
        )?.default_currency,
        orderStore.market,
      );
      orderItems.forEach((item, i) => {
        item.unit_price = netPrices.unit_prices[i];
        item.total_price = netPrices.line_totals[i];
        if (item.original_unit_price != null) {
          item.original_unit_price = netOfRate(
            Number(item.original_unit_price),
            netPrices.line_rate_bp[i],
            netCurrency,
          );
        }
      });
      subtotal = netPrices.subtotal;
    }
    const exemptColumns =
      exemptDecision && exemptDecision.reason
        ? {
            tax_exempt_reason: exemptDecision.reason,
            vat_validation:
              exemptDecision.evidence as unknown as Prisma.InputJsonValue,
          }
        : {};
    // The snapshot number is the validated one (VIES evidence wins).
    if (
      exemptDecision?.reason &&
      exemptDecision.evidence.source === 'VIES' &&
      b2bColumns.vat_number
    ) {
      b2bColumns.vat_number = exemptDecision.evidence.vat_number;
    }

    const shippingCost = totals.shippingCost;
    // Snapshot of the chosen method (name in the store's primary locale).
    const shippingMethod = totals.shippingMethod;
    const discountAmount = totals.discountAmount;
    const couponValidation = totals.couponValidation;
    // Set once a redemption slot has been reserved, so every failure path
    // below can hand it back instead of burning it on an order that never
    // came into existence.
    let redemptionClaimed: string | null = null;

    if (couponValidation) {
      // Claim the redemption now, atomically. validateCoupon only reads the
      // counter, so without this two concurrent checkouts both pass its limit
      // check and both redeem the last slot.
      const claim = await this.promotionsService.claimRedemption(
        couponValidation.promotion_id,
      );
      if (claim === 'exhausted') {
        throw new BadRequestException({
          code: 'PROMOTION_COUPON_USAGE_LIMIT_REACHED',
          message: 'Coupon usage limit reached',
        });
      }
      // Only a real reservation is releasable — unlimited coupons were never
      // incremented, so handing one back would corrupt the counter.
      if (claim === 'reserved')
        redemptionClaimed = couponValidation.promotion_id;
    }

    const total = totals.total;

    // Determine payment status based on method. Both online methods start
    // in awaiting_payment; Kustom additionally gets the random secret that is
    // embedded in its push/validation callback URLs.
    const paymentMethod = requestedPaymentMethod;
    const paymentStatus =
      paymentMethod === PaymentMethod.COD ? 'pending' : 'awaiting_payment';
    const kustomPushToken =
      paymentMethod === PaymentMethod.KUSTOM
        ? randomBytes(32).toString('hex')
        : undefined;

    // Order currency: an independent store may price in its own currency
    // (it charges on its own connected account); everything else uses the
    // platform default. Snapshotted onto the order so a later change to the
    // store never rewrites settled history.
    const platformConfig = await this.prisma.platformConfig.findFirst();
    const currency = resolveOrderCurrency(
      orderStore,
      platformConfig?.default_currency,
      orderStore.market,
    );
    // Markets app: which market, which storefront host (validated against the
    // market's own hostnames), which UI locale and which base->market rate
    // the prices were converted with. All null without the app.
    const market = orderStore.market;
    const marketColumns = market
      ? {
          market_id: market.id,
          hostname: this.validatedHostname(
            market,
            orderStore.slug,
            dto.hostname,
          ),
          locale: marketOrderLocale(market, dto.locale),
          fx_rate_snapshot: market.rate,
        }
      : {};
    // Tax snapshot: per line (class key, effective rate, amount after the
    // discount share), shipping, the itemized breakdown and the headline
    // rate / total for compatibility. Computed by the same engine as the
    // quote and the Kustom session, so Order.tax_amount always equals the
    // order_tax_amount Kustom is sent.
    const { tax } = totals;
    orderItems.forEach((item, i) => {
      item.tax_class_key = tax.items[i]?.tax_class_key ?? null;
      item.tax_rate_bp = tax.items[i]?.tax_rate_bp ?? 0;
      item.tax_amount = tax.items[i]?.tax_amount ?? 0;
    });

    // ── Stock: atomically decrement before creating the order. The conditional
    // updateMany (where stock_quantity >= qty) is race-safe — if two buyers
    // race for the last unit only one of their updates returns count===1, the
    // other gets count===0 and is rejected. Any already-decremented op gets
    // restored on failure so the order either fully succeeds or no stock moves.
    const decrementedStock: typeof stockOps = [];
    try {
      for (const op of stockOps) {
        const res =
          op.kind === 'variant'
            ? await this.prisma.productVariant.updateMany({
                where: { id: op.id, stock_quantity: { gte: op.qty } },
                data: { stock_quantity: { decrement: op.qty } },
              })
            : await this.prisma.product.updateMany({
                where: {
                  id: op.id,
                  track_inventory: true,
                  stock_quantity: { gte: op.qty },
                },
                data: { stock_quantity: { decrement: op.qty } },
              });
        if (res.count === 0) {
          throw new BadRequestException({
            code: 'ORDER_INSUFFICIENT_STOCK',
            message:
              'Sorry — one of the items in your cart just sold out. Please refresh and try again.',
          });
        }
        decrementedStock.push(op);
      }
    } catch (err) {
      await this.restoreStock(decrementedStock);
      if (redemptionClaimed)
        await this.promotionsService.releaseRedemption(redemptionClaimed);
      throw err;
    }

    // Create order
    let order: Prisma.OrderGetPayload<{
      include: { items: true; timeline: true; address: true };
    }>;
    try {
      // M4.0: the order, its lines and their custom field values are one
      // insert. Uploads behind the values are marked attached in the same
      // transaction; an order without uploads keeps the single insert.
      const createOrder = (client: Prisma.TransactionClient) =>
        client.order.create({
          data: {
            ...(orderId ? { id: orderId } : {}),
            order_number: this.generateOrderNumber(),
            customer_id: customer.id,
            address_id: dto.address_id,
            store_id: dto.store_id || undefined,
            subtotal,
            shipping_cost: shippingCost,
            discount_amount: discountAmount,
            total,
            currency,
            tax_rate_bp: tax.headline_rate_bp,
            tax_amount: tax.tax_total,
            tax_pricing_mode: tax.tax_pricing_mode,
            tax_basis_country: tax.tax_basis_country,
            tax_lines: tax.tax_lines as unknown as Prisma.InputJsonValue,
            shipping_tax_rate_bp: tax.shipping_tax_rate_bp,
            shipping_tax_amount: tax.shipping_tax_amount,
            shipping_method_id: shippingMethod?.id ?? null,
            shipping_method_name: shippingMethod?.name ?? null,
            shipping_method_type: shippingMethod?.type ?? null,
            payment_method: paymentMethod,
            payment_status: paymentStatus,
            stripe_payment_id: dto.stripe_payment_intent_id,
            kustom_push_token: kustomPushToken,
            notes: dto.notes,
            ...marketColumns,
            ...b2bColumns,
            ...exemptColumns,
            items: { create: orderItems },
            timeline: {
              create: {
                status: 'PENDING',
                note: 'Order created',
                actor: 'system',
              },
            },
          },
          include: {
            // M4.2: designed lines answer with their proof and `design`
            // block like every read path (withItemImages); orders without
            // designs keep the plain items.
            items:
              designIds.length > 0
                ? {
                    include: {
                      design: {
                        select: {
                          id: true,
                          store_id: true,
                          proof_key: true,
                          files_purged_at: true,
                        },
                      },
                    },
                  }
                : true,
            timeline: true,
            address: true,
          },
        });
      // M4.2: ordered designs are frozen in the same transaction (their
      // photos now follow the order's retention clock).
      order =
        attachUploadIds.length === 0 && designIds.length === 0
          ? await createOrder(this.prisma)
          : await this.prisma.$transaction(async (tx) => {
              const created = await createOrder(tx);
              if (attachUploadIds.length > 0) {
                // An upload purged (or claimed by another store) since the
                // quote rolls the order back, naming its field and line.
                const { unattachable } = await this.uploads.tryMarkAttached(
                  attachUploadIds,
                  orderStore.id,
                  tx,
                );
                if (unattachable.length > 0) {
                  throw this.core.uploadExpired(
                    uploadRefs.get(unattachable[0]),
                    dto.locale,
                  );
                }
              }
              if (designIds.length > 0) {
                await this.designerCart?.markOrdered(tx, designFreeze);
              }
              return created;
            });
    } catch (err) {
      console.error('[OrderCreate] Failed to create order:', err);
      // Order creation failed AFTER stock was decremented — restore so the
      // sold-out signal doesn't stick to a non-existent order.
      await this.restoreStock(decrementedStock);
      if (redemptionClaimed)
        await this.promotionsService.releaseRedemption(redemptionClaimed);
      // Coded errors raised inside the transaction (markAttached:
      // CUSTOMER_UPLOAD_EXPIRED) keep their body.
      if (err instanceof HttpException) throw err;
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Failed to create order',
      );
    }

    // Production app (M4.3, X32): generate the checklist from the rows the
    // insert above just wrote. Best-effort, outside the transaction; a
    // no-op (one cached isEnabled) for stores without the app.
    await this.production?.onOrderCreated(order.id, order.store_id);

    // Record coupon usage
    if (couponValidation && dto.coupon_code) {
      try {
        await this.promotionsService.recordUsage(
          couponValidation.promotion_id,
          order.id,
          userId,
          discountAmount,
          redemptionClaimed === couponValidation.promotion_id,
        );
      } catch (err) {
        console.error('[OrderCreate] Failed to record promotion usage:', err);
      }
    }

    // Commission split. Independent stores take no platform commission and
    // have no provider share — the creator keeps the full order total
    // (subtotal - discount + shipping). Marketplace stores: platform takes %,
    // rest split between provider (base) and creator (margin).
    let platformAmount = 0;
    let providerAmount = 0;
    let creatorAmount = 0;
    if (isIndependentStore) {
      creatorAmount = total;
    } else {
      const commissionPercent = platformConfig
        ? Number(platformConfig.commission_value)
        : 15;
      const split = this.computeMarketplaceCommission({
        subtotal,
        discountAmount,
        providerBaseTotal,
        creatorMarginTotal,
        commissionPercent,
      });
      platformAmount = split.platformAmount;
      providerAmount = split.providerAmount;
      creatorAmount = split.creatorAmount;
    }

    try {
      await this.prisma.orderCommission.create({
        data: {
          order_id: order.id,
          platform_amount: platformAmount,
          provider_amount: providerAmount,
          creator_amount: creatorAmount,
          currency,
        },
      });
    } catch (err) {
      console.error('[OrderCreate] Failed to create commission:', err);
      // Don't fail the order for commission errors
    }

    // Empty the cart. A snapshot order (opts.lines) never touched it, so the
    // customer keeps whatever is in their real cart.
    if (cart) {
      await this.prisma.cartItem.deleteMany({
        where: { cart_id: cart.id },
      });
    }

    // Order-related emails — best-effort, never blocks the order flow.
    // COD orders are real at creation, so we notify the customer and the
    // store owner now. Card orders wait for payment success (PaymentsService
    // dispatches both events once the Stripe payment is confirmed) so we
    // don't spam the owner about orders that may end up failing.
    if (paymentMethod === PaymentMethod.COD) {
      // Invoices app (cod_issue_on='created'): issue before the confirmation
      // so the email can attach the invoice.
      await this.invoices?.onCodOrderCreated({
        id: order.id,
        store_id: order.store_id,
        payment_method: paymentMethod,
      });
      // Designer app (WP5 port): a COD order is payable now, so its print
      // files are requested. Only orders with designs reach the trigger.
      if (designIds.length > 0) {
        await this.fireDesigner((t) =>
          t.onCodOrderCreated({
            id: order.id,
            store_id: order.store_id,
            payment_method: paymentMethod,
          }),
        );
      }
      await this.mail.dispatchOrderEmail(order.id, 'order_confirmation');
      await this.mail.dispatchOrderEmail(order.id, 'new_order_owner');
    }

    // Same shaping as every read path: resolves item images and drops the
    // Kustom push token, which must never reach the customer's browser.
    // b2b app: the `b2b` block travels with the created order only when the
    // app is enabled (same rule as the quote).
    const shaped = this.forCustomer(this.withItemImages(order));
    return orderStore.b2bEnabled
      ? { ...shaped, b2b: this.b2bTotals(tax) }
      : shaped;
  }

  /**
   * Marketplace commission split: the platform takes a percentage of
   * (subtotal - discount); the remaining payout pool is distributed pro-rata
   * between the aggregate provider base and the creator margin, both scaled by
   * the discount factor. Shared by create() and recomputeCommissionForOrder()
   * so the two can never drift apart.
   */
  private computeMarketplaceCommission(input: {
    subtotal: number;
    discountAmount: number;
    providerBaseTotal: number;
    creatorMarginTotal: number;
    commissionPercent: number;
  }): {
    platformAmount: number;
    providerAmount: number;
    creatorAmount: number;
  } {
    const {
      subtotal,
      discountAmount,
      providerBaseTotal,
      creatorMarginTotal,
      commissionPercent,
    } = input;

    const commissionBase = subtotal - discountAmount;
    let platformAmount =
      Math.round(commissionBase * (commissionPercent / 100) * 100) / 100;

    // A coupon is offered by the creator (or the platform) — the provider never
    // agreed to it, so it must not come out of their share. The floor is what
    // the provider would have received on an undiscounted order, which is their
    // base minus the platform's percentage: with no discount it equals the
    // pro-rata result exactly, so the split below is unchanged for those orders.
    // Anything the discount takes is absorbed by the creator's margin first,
    // then by the platform's commission.
    const providerFloor =
      Math.round(providerBaseTotal * (1 - commissionPercent / 100) * 100) / 100;
    if (platformAmount > commissionBase - providerFloor) {
      platformAmount = Math.max(
        0,
        Math.round((commissionBase - providerFloor) * 100) / 100,
      );
    }

    // Scale provider/creator by discount factor to reflect discounted revenue
    const discountFactor = subtotal > 0 ? commissionBase / subtotal : 1;
    const payoutPool = commissionBase - platformAmount;

    // Distribute payoutPool proportionally between provider base and creator margin
    const scaledProviderBase = providerBaseTotal * discountFactor;
    const scaledCreatorMargin = creatorMarginTotal * discountFactor;
    const totalScaled = scaledProviderBase + scaledCreatorMargin;

    let providerAmount = 0;
    let creatorAmount = 0;
    if (totalScaled > 0 && payoutPool > 0) {
      providerAmount =
        Math.round(((payoutPool * scaledProviderBase) / totalScaled) * 100) /
        100;
      // Never below the provider's base cost, never above what was collected.
      if (providerAmount < providerFloor) providerAmount = providerFloor;
      if (providerAmount > payoutPool) providerAmount = payoutPool;
      creatorAmount = Math.max(
        0,
        Math.round((payoutPool - providerAmount) * 100) / 100,
      );
    }

    return { platformAmount, providerAmount, creatorAmount };
  }

  /**
   * Re-derive an unpaid order's commission split from the store's CURRENT
   * store_type. An admin can flip a store between MARKETPLACE and INDEPENDENT
   * while unpaid orders exist; without this, the commission row created at
   * order time would drive the wrong payout behaviour at payment time.
   * Paid orders are never touched — their ledger is settled history.
   */
  async recomputeCommissionForOrder(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          select: { provider_base_amount: true, fulfiller_type: true },
        },
        commission: true,
      },
    });
    if (!order) return;
    if (order.payment_status === 'paid') return;

    const store = order.store_id
      ? await this.prisma.store.findUnique({
          where: { id: order.store_id },
          select: { store_type: true },
        })
      : null;
    const isIndependentStore = store?.store_type === StoreType.INDEPENDENT;

    let platformAmount = 0;
    let providerAmount = 0;
    let creatorAmount = 0;
    if (isIndependentStore) {
      // Independent stores: no platform cut, no provider share — the creator
      // keeps the full order total (charged directly on their own account).
      creatorAmount = Number(order.total);
    } else {
      const platformConfig = await this.prisma.platformConfig.findFirst();
      const commissionPercent = platformConfig
        ? Number(platformConfig.commission_value)
        : 15;
      const subtotal = Number(order.subtotal);
      const providerBaseTotal = order.items.reduce(
        (sum, i) => sum + Number(i.provider_base_amount),
        0,
      );
      const split = this.computeMarketplaceCommission({
        subtotal,
        discountAmount: Number(order.discount_amount),
        providerBaseTotal,
        creatorMarginTotal: subtotal - providerBaseTotal,
        commissionPercent,
      });
      platformAmount = split.platformAmount;
      providerAmount = split.providerAmount;
      creatorAmount = split.creatorAmount;
    }

    // Upsert: the row can legitimately be missing because commission creation
    // at order time is best-effort (failures are swallowed).
    await this.prisma.orderCommission.upsert({
      where: { order_id: order.id },
      create: {
        order_id: order.id,
        platform_amount: platformAmount,
        provider_amount: providerAmount,
        creator_amount: creatorAmount,
        currency: order.currency,
      },
      update: {
        platform_amount: platformAmount,
        provider_amount: providerAmount,
        creator_amount: creatorAmount,
      },
    });
  }

  async findByCustomer(userId: string, page = 1, limit = 20) {
    const customer = await this.prisma.customer.findUnique({
      where: { user_id: userId },
    });
    if (!customer)
      throw new NotFoundException({
        code: 'ORDER_CUSTOMER_NOT_FOUND',
        message: 'Customer not found',
      });

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where: { customer_id: customer.id },
        skip,
        take: limit,
        include: { items: this.itemsWithProduct },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.order.count({ where: { customer_id: customer.id } }),
    ]);

    return {
      data: data.map((o) => this.forCustomer(this.withItemImages(o))),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findByRole(
    userId: string,
    role: UserRole,
    page = 1,
    limit = 20,
    status?: OrderStatus,
    marketKey?: string,
    buyer?: string,
    production?: string,
  ) {
    if (role === UserRole.PROVIDER) {
      return this.findByProvider(userId, page, limit, status);
    }
    if (role === UserRole.CREATOR) {
      return this.findByCreator(
        userId,
        page,
        limit,
        status,
        marketKey,
        buyer,
        production,
      );
    }
    return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
  }

  // Provider sees orders where their products are being fulfilled
  private async findByProvider(
    userId: string,
    page = 1,
    limit = 20,
    status?: OrderStatus,
  ) {
    const provider = await this.prisma.provider.findUnique({
      where: { user_id: userId },
    });
    if (!provider) {
      return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
    }

    const skip = (page - 1) * limit;
    const where = {
      items: { some: { fulfiller_id: provider.id } },
      ...(status ? { status } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        skip,
        take: limit,
        include: {
          items: this.itemsWithProduct,
          address: true,
          customer: true,
          commission: true,
        },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      data: data.map((o) => this.withItemImages(o)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // Creator sees orders placed through their store
  /**
   * b2b app: the `?buyer=` list filter. 'company' = orders placed as a
   * company; 'person' = everything else (pre-app rows have a null
   * customer_type). Any other value is ignored.
   */
  private buyerWhere(buyer?: string): Prisma.OrderWhereInput {
    if (buyer === 'company') return { customer_type: 'COMPANY' };
    if (buyer === 'person') {
      return {
        OR: [{ customer_type: null }, { customer_type: { not: 'COMPANY' } }],
      };
    }
    return {};
  }

  private async findByCreator(
    userId: string,
    page = 1,
    limit = 20,
    status?: OrderStatus,
    marketKey?: string,
    buyer?: string,
    production?: string,
  ) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      include: { store: true },
    });
    if (!creator?.store) {
      return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
    }

    const skip = (page - 1) * limit;
    const where: Prisma.OrderWhereInput = {
      store_id: creator.store.id,
      ...(status ? { status } : {}),
      // Markets app: orders placed in one market (`?market=`).
      ...(marketKey ? { market: { key: marketKey } } : {}),
      ...this.buyerWhere(buyer),
    };
    // Production app (M4.3 §3.8): `?production=in_production|ready|
    // not_started`. Read only when the value is valid and the app is on, so
    // stores without the app keep ignoring the parameter.
    if (
      isProductionFilter(production) &&
      this.production &&
      (await this.production.isEnabled(creator.store.id))
    ) {
      // Merge: never overwrite an AND another filter may have set.
      const and = where.AND;
      where.AND = [
        ...(Array.isArray(and) ? and : and ? [and] : []),
        productionWhere(production),
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        skip,
        take: limit,
        include: {
          items: this.itemsWithProduct,
          address: true,
          customer: true,
          commission: true,
          market: this.marketRef,
        },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      data: data.map((o) => this.withItemImages(o)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // Generic fulfiller lookup (used by /orders/fulfiller/:id endpoint).
  // The id comes from the URL, so a provider/creator may only ask for their
  // own — otherwise this returns a competitor's orders with full customer PII
  // and commission amounts. Admins may query any fulfiller.
  async findByFulfiller(
    fulfillerId: string,
    userId: string,
    role: UserRole,
    page = 1,
    limit = 20,
  ) {
    if (role !== UserRole.ADMIN) {
      const ownId = await this.resolveFulfillerId(userId, role);
      if (!ownId || ownId !== fulfillerId) {
        throw new ForbiddenException({
          code: 'ORDER_FULFILLER_FORBIDDEN',
          message: 'You can only view your own incoming orders',
        });
      }
    }

    const skip = (page - 1) * limit;
    const where = { items: { some: { fulfiller_id: fulfillerId } } };

    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        skip,
        take: limit,
        include: {
          items: this.itemsWithProduct,
          address: true,
          customer: true,
          commission: true,
        },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      data: data.map((o) => this.withItemImages(o)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // The market an order was placed in (markets app); null without the app.
  private readonly marketRef = {
    select: { key: true, name: true, currency: true },
  };

  async findById(id: string, userId?: string, role?: UserRole) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        items: this.itemsWithProduct,
        commission: true,
        timeline: { orderBy: { created_at: 'asc' } },
        address: true,
        customer: true,
        payouts: { orderBy: { created_at: 'asc' } },
        market: this.marketRef,
      },
    });

    if (!order)
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Order not found',
      });

    // Admin sees everything (full payment details + all payouts).
    if (role === UserRole.ADMIN) return this.withItemImages(order);

    // Everyone else must be part of the order: the owning customer, a
    // provider fulfilling one of its items, or the creator of its store.
    // Foreign orders get a 404 (not 403) so order ids are not enumerable.
    const canRead = await this.userCanReadOrder(order, userId, role);
    if (!canRead) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Order not found',
      });
    }

    // Everyone else: hide the customer's card/charge/receipt details and the
    // creator's connected-account id, and scope payouts to the requesting
    // fulfiller (a provider/creator sees only theirs).
    const {
      stripe_charge_id: _c,
      stripe_payment_id: _p,
      stripe_account_id: _a,
      card_brand: _b,
      card_last4: _l,
      receipt_url: _r,
      payouts,
      ...safe
    } = order;
    void _c;
    void _p;
    void _a;
    void _b;
    void _l;
    void _r;

    let scopedPayouts: typeof payouts = [];
    if ((role === UserRole.PROVIDER || role === UserRole.CREATOR) && userId) {
      const fulfillerId = await this.resolveFulfillerId(userId, role);
      scopedPayouts = payouts.filter((p) => p.recipient_id === fulfillerId);
    }

    // Kustom references are merchant-side bookkeeping: the owning creator
    // (whose Kustom account holds the money) keeps them; customers and
    // providers don't need them. The push token is removed for everyone
    // inside withItemImages.
    if (role !== UserRole.CREATOR) {
      const {
        kustom_order_id: _ko,
        kustom_capture_id: _kc,
        kustom_captured_at: _kd,
        ...customerSafe
      } = safe;
      void _ko;
      void _kc;
      void _kd;
      // Customers / providers: reverse-charge evidence without internals.
      return this.forCustomer(
        this.withItemImages({ ...customerSafe, payouts: scopedPayouts }),
      );
    }
    return this.withItemImages({ ...safe, payouts: scopedPayouts });
  }

  async findAll(
    page = 1,
    limit = 20,
    status?: OrderStatus,
    marketKey?: string,
    buyer?: string,
  ) {
    const skip = (page - 1) * limit;
    const where: Prisma.OrderWhereInput = {
      ...(status ? { status } : {}),
      ...(marketKey ? { market: { key: marketKey } } : {}),
      ...this.buyerWhere(buyer),
    };
    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        skip,
        take: limit,
        where,
        include: {
          items: this.itemsWithProduct,
          customer: true,
          market: this.marketRef,
        },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      data: data.map((o) => this.withItemImages(o)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Ownership check for reading a single order:
   * - CUSTOMER: only their own orders.
   * - PROVIDER: only orders containing items they fulfill.
   * - CREATOR: orders of their own store, or orders where they fulfill an item.
   * Admin is handled by the caller; any other case is denied.
   */
  private async userCanReadOrder(
    order: {
      customer: { user_id: string } | null;
      items: { fulfiller_id: string | null }[];
      store_id: string | null;
    },
    userId?: string,
    role?: UserRole,
  ): Promise<boolean> {
    if (!userId || !role) return false;

    if (role === UserRole.CUSTOMER) {
      return order.customer?.user_id === userId;
    }

    if (role === UserRole.PROVIDER) {
      const providerId = await this.resolveFulfillerId(userId, role);
      return (
        !!providerId && order.items.some((i) => i.fulfiller_id === providerId)
      );
    }

    if (role === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
        include: { store: true },
      });
      if (!creator) return false;
      if (creator.store && order.store_id === creator.store.id) return true;
      // Fallback: a creator fulfilling an item keeps access even when the
      // order was not placed through their store.
      return order.items.some((i) => i.fulfiller_id === creator.id);
    }

    return false;
  }

  /**
   * Resolve the fulfiller (provider/creator) profile id for a given user.
   * Returns null when the role doesn't have a fulfiller profile.
   */
  private async resolveFulfillerId(
    userId: string,
    userRole: UserRole,
  ): Promise<string | null> {
    if (userRole === UserRole.PROVIDER) {
      const provider = await this.prisma.provider.findUnique({
        where: { user_id: userId },
      });
      return provider?.id ?? null;
    }
    if (userRole === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
      });
      return creator?.id ?? null;
    }
    return null;
  }

  /**
   * Recompute an order's overall status from its items: it reflects the slowest
   * item (only SHIPPED once every item ships, DELIVERED once all are delivered).
   * Advance-only — never rolls a status backward — and leaves terminal states
   * (CANCELLED/REFUNDED/RETURNED) untouched.
   *
   * The one exception is an explicit quality-check reject (`qcReject`: a
   * fulfiller sent their QC lines back to MANUFACTURING): a QUALITY_CHECK
   * header then returns to MANUFACTURING, but only when no line remains at
   * QUALITY_CHECK or later.
   */
  private async recomputeOrderStatusFromItems(
    orderId: string,
    opts: { qcReject?: boolean } = {},
  ): Promise<{ from: OrderStatus; to: OrderStatus } | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, store_id: true, payment_method: true },
    });
    if (!order) return null;
    const terminal: OrderStatus[] = [
      OrderStatus.CANCELLED,
      OrderStatus.REFUNDED,
      OrderStatus.RETURNED,
    ];
    if (terminal.includes(order.status)) return null;

    const items = await this.prisma.orderItem.findMany({
      where: { order_id: orderId },
      select: { fulfillment_status: true },
    });
    if (items.length === 0) return null;

    const ranks = items.map((i) => FULFILLMENT_RANK[i.fulfillment_status] ?? 0);
    const qcRank = FULFILLMENT_RANK[FulfillmentStatus.QUALITY_CHECK];
    const rejected =
      opts.qcReject === true &&
      order.status === OrderStatus.QUALITY_CHECK &&
      ranks.every((r) => r < qcRank);
    let candidate: OrderStatus | null;
    if (rejected) {
      // The single permitted step back (explicit QC reject).
      candidate = OrderStatus.MANUFACTURING;
    } else {
      candidate = fulfillmentStageToOrderStatus(Math.min(...ranks));
      if (!candidate) return null;
      // Advance only.
      if (
        (ORDER_STATUS_RANK[candidate] ?? 0) <=
        (ORDER_STATUS_RANK[order.status] ?? 0)
      ) {
        return null;
      }
    }

    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: candidate },
    });
    await this.prisma.orderTimeline.create({
      data: {
        order_id: orderId,
        status: candidate,
        note: rejected
          ? 'Quality check rejected: back to manufacturing'
          : 'Auto-updated from item fulfillment',
        actor: 'system',
      },
    });
    await this.prisma.orderCommission.updateMany({
      where: { order_id: orderId },
      data: { status: deriveCommissionStatus(candidate) },
    });
    if (candidate === OrderStatus.SHIPPED) await this.runShippedHooks(orderId);
    // Invoices app: before the callers dispatch the status email, so a
    // DELIVERED email can attach a COD invoice issued here.
    await this.invoices?.onStatusChanged(
      {
        id: orderId,
        store_id: order.store_id,
        payment_method: order.payment_method,
      },
      order.status,
      candidate,
    );
    // Designer app (WP5 port): shipped / delivered dates for retention.
    await this.fireDesigner((t) =>
      t.onStatusChanged(
        {
          id: orderId,
          store_id: order.store_id,
          payment_method: order.payment_method,
        },
        order.status,
        candidate,
      ),
    );
    return { from: order.status, to: candidate };
  }

  /**
   * Map a status transition to the matching customer email. Best-effort and
   * triggered ONLY when the status actually changes; no-ops for intermediate
   * states like PROCESSING/CONFIRMED where we don't want to spam the inbox.
   */
  private async dispatchStatusEmail(
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    note?: string,
  ): Promise<void> {
    if (from === to) return;
    switch (to) {
      case OrderStatus.SHIPPED: {
        // Use the first non-empty tracking number found on any item.
        const item = await this.prisma.orderItem.findFirst({
          where: { order_id: orderId, tracking_number: { not: null } },
          select: { tracking_number: true, tracking_url: true },
        });
        await this.mail.dispatchOrderEmail(orderId, 'order_shipped', {
          trackingNumber: item?.tracking_number ?? undefined,
          trackingUrl: item?.tracking_url ?? undefined,
        });
        return;
      }
      case OrderStatus.DELIVERED:
        await this.mail.dispatchOrderEmail(orderId, 'order_delivered');
        return;
      case OrderStatus.CANCELLED:
        await this.mail.dispatchOrderEmail(orderId, 'order_cancelled', {
          reason: note,
        });
        return;
      case OrderStatus.REFUNDED: {
        const o = await this.prisma.order.findUnique({
          where: { id: orderId },
          select: { total: true },
        });
        await this.mail.dispatchOrderEmail(orderId, 'order_refunded', {
          refundAmount: o ? Number(o.total) : undefined,
        });
        return;
      }
      default:
        return;
    }
  }

  /**
   * Update an order's status.
   * - ADMIN: sets the order status directly and cascades it onto all items.
   * - PROVIDER/CREATOR: advances ONLY their own items' fulfillment to the mapped
   *   stage; the overall order status is then re-derived from all items. This is
   *   what makes mixed-fulfiller orders work — each side advances its own items
   *   and the order header follows the slowest item automatically.
   */
  async updateStatus(
    id: string,
    dto: UpdateOrderStatusDto,
    actorId: string,
    actorRole: UserRole,
  ) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order)
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Order not found',
      });

    if (actorRole === UserRole.ADMIN) {
      await this.prisma.order.update({
        where: { id },
        data: { status: dto.status },
      });
      await this.prisma.orderTimeline.create({
        data: {
          order_id: id,
          status: dto.status,
          note: dto.note ?? shipNote(dto),
          actor: actorId,
        },
      });
      await this.prisma.orderCommission.updateMany({
        where: { order_id: id },
        data: { status: deriveCommissionStatus(dto.status) },
      });
      const nextFulfillment = deriveFulfillmentStatus(dto.status);
      if (nextFulfillment) {
        await this.prisma.orderItem.updateMany({
          where: { order_id: id },
          data: { fulfillment_status: nextFulfillment, ...shipTracking(dto) },
        });
      }
      if (
        dto.status === OrderStatus.SHIPPED &&
        order.status !== OrderStatus.SHIPPED
      ) {
        await this.runShippedHooks(id);
      }
      // Invoices app: issue (COD delivered) or credit (cancelled / refunded)
      // before the status email, so the document can be attached.
      await this.invoices?.onStatusChanged(order, order.status, dto.status);
      // Designer app (WP5 port): terminal / shipped bookkeeping of designs.
      await this.fireDesigner((t) =>
        t.onStatusChanged(order, order.status, dto.status),
      );
      await this.dispatchStatusEmail(id, order.status, dto.status, dto.note);
      return this.findById(id, actorId, actorRole);
    }

    // Provider/Creator — advance only their own items.
    const expectedType =
      actorRole === UserRole.PROVIDER
        ? FulfillerType.PROVIDER
        : FulfillerType.CREATOR;
    const fulfillerId = await this.resolveFulfillerId(actorId, actorRole);
    if (!fulfillerId) {
      throw new ForbiddenException({
        code: 'ORDER_FULFILLER_PROFILE_NOT_FOUND',
        message: 'Fulfiller profile not found for this user',
      });
    }

    const targetFulfillment = deriveFulfillmentStatus(dto.status);
    if (!targetFulfillment) {
      throw new BadRequestException('This status cannot be set by a fulfiller');
    }

    const res = await this.prisma.orderItem.updateMany({
      where: {
        order_id: id,
        fulfiller_id: fulfillerId,
        fulfiller_type: expectedType,
      },
      data: { fulfillment_status: targetFulfillment, ...shipTracking(dto) },
    });
    if (res.count === 0) {
      throw new ForbiddenException({
        code: 'ORDER_NO_OWNED_ITEMS',
        message: 'You have no items to fulfill in this order',
      });
    }

    await this.prisma.orderTimeline.create({
      data: {
        order_id: id,
        status: dto.status,
        note:
          dto.note ??
          shipNote(dto) ??
          `${expectedType} items → ${targetFulfillment}`,
        actor: actorId,
      },
    });

    // An explicit "reject → back to MANUFACTURING" on a QC order may move
    // the header back (the only backwards step the recompute allows).
    const transition = await this.recomputeOrderStatusFromItems(id, {
      qcReject:
        order.status === OrderStatus.QUALITY_CHECK &&
        dto.status === OrderStatus.MANUFACTURING,
    });
    if (transition) {
      await this.dispatchStatusEmail(
        id,
        transition.from,
        transition.to,
        dto.note,
      );
    }
    return this.findById(id, actorId, actorRole);
  }

  async updateFulfillment(
    orderId: string,
    itemId: string,
    dto: UpdateFulfillmentDto,
    actorId: string,
    actorRole: UserRole,
  ) {
    // Per-item check: the actor must be the item's own fulfiller. Mixed orders
    // are fine here — each side updates only the items they actually fulfill.
    const item = await this.prisma.orderItem.findFirst({
      where: { id: itemId, order_id: orderId },
      select: { id: true, fulfiller_id: true, fulfiller_type: true },
    });
    if (!item)
      throw new NotFoundException({
        code: 'ORDER_ITEM_NOT_FOUND',
        message: 'Order item not found',
      });

    if (actorRole !== UserRole.ADMIN) {
      const expectedType =
        actorRole === UserRole.PROVIDER
          ? FulfillerType.PROVIDER
          : FulfillerType.CREATOR;
      const fulfillerId = await this.resolveFulfillerId(actorId, actorRole);
      if (
        !fulfillerId ||
        item.fulfiller_type !== expectedType ||
        item.fulfiller_id !== fulfillerId
      ) {
        throw new ForbiddenException({
          code: 'ORDER_FULFILLMENT_NOT_OWNED',
          message: 'You can only update fulfillment for items you fulfill',
        });
      }
    }

    const updated = await this.prisma.orderItem.update({
      where: { id: itemId, order_id: orderId },
      data: {
        fulfillment_status: dto.fulfillment_status,
        tracking_number: dto.tracking_number,
        tracking_url: dto.tracking_url,
      },
    });

    // Re-derive the overall order status from all items (slowest item wins).
    const transition = await this.recomputeOrderStatusFromItems(orderId);
    if (transition) {
      await this.dispatchStatusEmail(orderId, transition.from, transition.to);
    }
    return updated;
  }

  // ── Payment status transitions (called from the payment providers) ───────────
  // All methods are idempotent: replaying the same webhook/push event leaves
  // the order untouched on the second pass. They return the order plus a
  // `changed` flag so the caller can decide whether to fire a notification.
  // `provider` only labels the timeline note ('Stripe' by default, 'Kustom'
  // for Kustom Checkout).

  async markOrderPaid(
    orderId: string,
    stripePaymentId?: string,
    provider = 'Stripe',
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: { select: { user_id: true } } },
    });
    if (!order) return null;
    if (order.payment_status === 'paid') return { order, changed: false };

    // Guard on payment_status so concurrent webhook deliveries can't both flip
    // the order (and double-insert a timeline row): only the first wins.
    const flip = await this.prisma.order.updateMany({
      where: { id: orderId, payment_status: { not: 'paid' } },
      data: {
        payment_status: 'paid',
        paid_at: new Date(),
        // Move a freshly-placed order forward; never roll back a later status.
        status:
          order.status === OrderStatus.PENDING
            ? OrderStatus.CONFIRMED
            : order.status,
        ...(stripePaymentId ? { stripe_payment_id: stripePaymentId } : {}),
      },
    });
    if (flip.count === 0) return { order, changed: false };

    // A previously-failed order had its stock restored (by the abandonment
    // sweep or a failure webhook). Payment landing afterwards means those units
    // really did sell, so take them back out — unguarded, so the count can go
    // negative and honestly block further sales instead of hiding an oversell.
    if (order.payment_status === 'failed') {
      await this.decrementOrderItemsStock(orderId);
    }

    await this.prisma.orderTimeline.create({
      data: {
        order_id: orderId,
        status: 'PAID',
        note: `Payment confirmed via ${provider}`,
        actor: 'system',
      },
    });
    return { order, changed: true };
  }

  /**
   * Hand back the coupon redemption an order consumed. create() records one
   * PromotionUsage row per order and counts the redemption (claimRedemption
   * for limited coupons, recordUsage for unlimited ones); when the order is
   * abandoned right after creation — a Kustom validation that failed after
   * create() succeeded — the slot must be freed or the coupon's usage limit
   * is burnt on an order that will never be paid. Idempotent: the usage row
   * is deleted with the release, so a second call finds nothing.
   */
  async releaseOrderCoupon(orderId: string): Promise<void> {
    try {
      const usages = await this.prisma.promotionUsage.findMany({
        where: { order_id: orderId },
        select: { id: true, promotion_id: true },
      });
      for (const usage of usages) {
        const removed = await this.prisma.promotionUsage.deleteMany({
          where: { id: usage.id },
        });
        if (removed.count === 1) {
          await this.promotionsService.releaseRedemption(usage.promotion_id);
        }
      }
    } catch (err) {
      console.error('[OrderCoupon] Failed to release coupon for', orderId, err);
    }
  }

  /**
   * A paid-by-authorization order (Kustom) whose authorization was cancelled
   * or expired before anything was captured: no money ever moved, so the
   * order is cancelled, its stock returned and its commission written off.
   * Idempotent; refuses anything that was captured or is already terminal.
   */
  async markAuthorizationReleased(orderId: string, note: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, payment_status: true, store_id: true },
    });
    if (!order) return null;
    if (
      order.payment_status !== 'paid' ||
      order.status === OrderStatus.CANCELLED ||
      order.status === OrderStatus.REFUNDED ||
      order.status === OrderStatus.RETURNED ||
      order.status === OrderStatus.DELIVERED
    ) {
      return { changed: false };
    }
    const flip = await this.prisma.order.updateMany({
      where: { id: orderId, payment_status: 'paid' },
      data: { payment_status: 'failed', status: OrderStatus.CANCELLED },
    });
    if (flip.count === 0) return { changed: false };
    await this.prisma.orderTimeline.create({
      data: {
        order_id: orderId,
        status: 'PAYMENT_CANCELLED',
        note,
        actor: 'system',
      },
    });
    await this.prisma.orderCommission.updateMany({
      where: { order_id: orderId },
      data: { status: deriveCommissionStatus(OrderStatus.CANCELLED) },
    });
    await this.restoreOrderItemsStock(orderId);
    // Invoices app (L2): a released authorization always credits the
    // invoice in full (credit_on_cancel does not apply: nothing was captured).
    await this.invoices?.onAuthorizationReleased(order);
    // Designer app: the order is CANCELLED — its designs become terminal
    // (pending renders withdrawn, retention counts from now).
    await this.fireDesigner((t) =>
      t.onStatusChanged(order, order.status, OrderStatus.CANCELLED),
    );
    return { changed: true };
  }

  async markOrderFailed(
    orderId: string,
    reason = 'Stripe reported the payment failed',
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: { select: { user_id: true } } },
    });
    if (!order) return null;
    // Never override an already-paid order, and don't duplicate a failure.
    if (order.payment_status === 'paid' || order.payment_status === 'failed') {
      return { order, changed: false };
    }

    const flip = await this.prisma.order.updateMany({
      where: { id: orderId, payment_status: { notIn: ['paid', 'failed'] } },
      data: { payment_status: 'failed' },
    });
    if (flip.count === 0) return { order, changed: false };

    await this.prisma.orderTimeline.create({
      data: {
        order_id: orderId,
        status: 'PAYMENT_FAILED',
        note: reason,
        actor: 'system',
      },
    });
    // Failed payment → restock the order's items so the inventory isn't
    // permanently locked by an order that won't ship. Idempotent because
    // markOrderFailed only runs the flip once per order (guarded payment_status).
    await this.restoreOrderItemsStock(orderId);
    // Designer app: nothing was bought — the order's designs become terminal
    // and the frozen designs editable / orderable again (a Kustom retry of
    // the same session re-orders them).
    await this.fireDesigner(async (t) => {
      await t.onPaymentFailed?.(order);
    });
    return { order, changed: true };
  }

  /**
   * The payment was fully refunded in Stripe — on the platform account, or on
   * an independent store's own account where the creator refunds directly and
   * we only ever learn about it through the connect webhook.
   *
   * Brings the order to the same place an admin-driven REFUNDED transition
   * would: terminal order status, commission written off, stock returned, the
   * customer emailed. Idempotent, and returns `changed` so the caller can skip
   * duplicate notifications on a replayed event.
   */
  async markOrderRefunded(orderId: string, provider = 'Stripe') {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: { select: { user_id: true } } },
    });
    if (!order) return null;
    if (order.payment_status === 'refunded') return { order, changed: false };

    const flip = await this.prisma.order.updateMany({
      where: { id: orderId, payment_status: { not: 'refunded' } },
      data: {
        payment_status: 'refunded',
        // REFUNDED is terminal; recomputeOrderStatusFromItems and the
        // fulfilment paths both leave terminal states alone.
        status: OrderStatus.REFUNDED,
      },
    });
    if (flip.count === 0) return { order, changed: false };

    await this.prisma.orderTimeline.create({
      data: {
        order_id: orderId,
        status: 'REFUNDED',
        note: `Payment fully refunded via ${provider}`,
        actor: 'system',
      },
    });

    // Write off the commission so refunded money stops counting as earnings.
    await this.prisma.orderCommission.updateMany({
      where: { order_id: orderId },
      data: { status: deriveCommissionStatus(OrderStatus.REFUNDED) },
    });

    // The goods are coming back (or never shipped) — return them to stock.
    // Guarded by the flip above, so a replayed webhook cannot double-restock.
    await this.restoreOrderItemsStock(orderId);

    // Invoices app: full credit note before the email, so it can be attached.
    await this.invoices?.onFullRefund(order);
    // Designer app (WP5 port): a refunded order is terminal for its designs.
    await this.fireDesigner((t) =>
      t.onStatusChanged(order, order.status, OrderStatus.REFUNDED),
    );

    // The customer paid us; they should hear about the refund from us, not
    // only from their bank statement. Skipped when the order was already
    // marked REFUNDED by an admin, since that transition emailed them
    // already — otherwise refunding in Stripe afterwards sends a duplicate.
    if (order.status !== OrderStatus.REFUNDED) {
      await this.mail.dispatchOrderEmail(orderId, 'order_refunded', {
        refundAmount: Number(order.total),
      });
    }

    return { order, changed: true };
  }

  /**
   * A partial refund: money went back but the order stands. Recorded on the
   * timeline so the creator and admin can see it, without touching payment
   * status, stock or commissions — those still reflect a live order.
   * Deduplicated on the note so a replayed event doesn't stack rows.
   *
   * `opts.cumulativeRefunded` (the provider's running refunded total, major
   * units) lets the invoices app issue the matching credit note; it runs even
   * when the timeline row is a duplicate, since the trigger is idempotent.
   * Callers pass `opts.storeId` from data they already loaded.
   */
  async recordPartialRefund(
    orderId: string,
    amountRefunded: number,
    currency: string,
    provider = 'Stripe',
    opts: { cumulativeRefunded?: number; storeId?: string | null } = {},
  ) {
    if (this.invoices && opts.cumulativeRefunded !== undefined) {
      const storeId =
        opts.storeId !== undefined
          ? opts.storeId
          : ((
              await this.prisma.order.findUnique({
                where: { id: orderId },
                select: { store_id: true },
              })
            )?.store_id ?? null);
      await this.invoices.onPartialRefund(
        { id: orderId, store_id: storeId, currency },
        opts.cumulativeRefunded,
      );
    }

    const note = `Partially refunded via ${provider}: ${amountRefunded} ${currency.toUpperCase()}`;
    const existing = await this.prisma.orderTimeline.findFirst({
      where: { order_id: orderId, status: 'PARTIALLY_REFUNDED', note },
      select: { id: true },
    });
    if (existing) return { changed: false };

    await this.prisma.orderTimeline.create({
      data: {
        order_id: orderId,
        status: 'PARTIALLY_REFUNDED',
        note,
        actor: 'system',
      },
    });
    return { changed: true };
  }

  /**
   * Cancel card orders that reserved stock and were never paid for, restoring
   * their inventory. A Stripe PaymentIntent cannot be confirmed anywhere near
   * this far after creation, so an order still `awaiting_payment` past the
   * window was abandoned — the buyer closed the tab, or the client failed
   * between creating the order and confirming the card. Kustom sessions live
   * longer (48h), but the same window applies: a Kustom push arriving after
   * the sweep still lands, because markOrderPaid accepts a `failed` order and
   * re-takes its stock.
   *
   * Deliberately bounded and best-effort: it runs inside a checkout request, so
   * it must never slow that request down or fail it. `markOrderFailed` does the
   * actual work and is idempotent, so a concurrent webhook cannot double-restock.
   */
  private async releaseExpiredAwaitingPaymentOrders(): Promise<void> {
    try {
      const now = Date.now();
      const stale = await this.prisma.order.findMany({
        where: {
          payment_status: 'awaiting_payment',
          OR: [
            {
              payment_method: { not: PaymentMethod.KUSTOM },
              created_at: { lt: new Date(now - ABANDONED_PAYMENT_TTL_MS) },
            },
            {
              payment_method: PaymentMethod.KUSTOM,
              created_at: { lt: new Date(now - ABANDONED_KUSTOM_TTL_MS) },
            },
          ],
        },
        select: { id: true },
        orderBy: { created_at: 'asc' },
        take: 20,
      });
      for (const order of stale) {
        await this.markOrderFailed(
          order.id,
          'Payment was not completed in time; the order was released',
        );
      }
    } catch (err) {
      console.error('[OrderSweep] Failed to release abandoned orders', err);
    }
  }

  /**
   * Restore stock for a list of operations recorded during order creation.
   * Best-effort: a failure in one restore is logged and does not stop the rest,
   * since this runs on the error path of order creation.
   */
  private async restoreStock(
    ops: { kind: 'product' | 'variant'; id: string; qty: number }[],
  ) {
    for (const op of ops) {
      try {
        if (op.kind === 'variant') {
          await this.prisma.productVariant.update({
            where: { id: op.id },
            data: { stock_quantity: { increment: op.qty } },
          });
        } else {
          await this.prisma.product.update({
            where: { id: op.id },
            data: { stock_quantity: { increment: op.qty } },
          });
        }
      } catch (err) {
        console.error('[StockRestore] failed for', op, err);
      }
    }
  }

  /**
   * Restore stock for every line of an already-created order — used when a
   * payment fails (or, in the future, when an order is cancelled). The
   * updateMany guards ensure untracked items are never written, so this is a
   * no-op for products/variants that don't track inventory.
   */
  private async restoreOrderItemsStock(orderId: string) {
    const items = await this.prisma.orderItem.findMany({
      where: { order_id: orderId },
      select: { product_id: true, variant_id: true, quantity: true },
    });
    for (const it of items) {
      try {
        if (it.variant_id) {
          await this.prisma.productVariant.updateMany({
            where: { id: it.variant_id, stock_quantity: { not: null } },
            data: { stock_quantity: { increment: it.quantity } },
          });
        } else if (it.product_id) {
          await this.prisma.product.updateMany({
            where: {
              id: it.product_id,
              track_inventory: true,
              stock_quantity: { not: null },
            },
            data: { stock_quantity: { increment: it.quantity } },
          });
        }
      } catch (err) {
        console.error('[StockRestore] order item restore failed', it, err);
      }
    }
  }

  /**
   * Inverse of restoreOrderItemsStock, for an order whose payment landed after
   * it had already been written off. There is no `gte` guard here on purpose:
   * the goods are sold either way, and letting the count go negative surfaces
   * the shortfall and stops further sales rather than silently overselling.
   */
  private async decrementOrderItemsStock(orderId: string) {
    const items = await this.prisma.orderItem.findMany({
      where: { order_id: orderId },
      select: { product_id: true, variant_id: true, quantity: true },
    });
    for (const it of items) {
      try {
        if (it.variant_id) {
          await this.prisma.productVariant.updateMany({
            where: { id: it.variant_id, stock_quantity: { not: null } },
            data: { stock_quantity: { decrement: it.quantity } },
          });
        } else if (it.product_id) {
          await this.prisma.product.updateMany({
            where: {
              id: it.product_id,
              track_inventory: true,
              stock_quantity: { not: null },
            },
            data: { stock_quantity: { decrement: it.quantity } },
          });
        }
      } catch (err) {
        console.error('[StockRestore] order item re-decrement failed', it, err);
      }
    }
  }
}
