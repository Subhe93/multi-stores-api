import {
  MarketStatus,
  PricingType,
  StoreType,
  TaxBasis,
  TaxPricingMode,
} from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  buildTaxContext,
  effectiveRateBp,
  resolveRatesForLine,
  taxStoreSelect,
  type TaxContext,
  type TaxData,
  type TaxDestination,
  type TaxService,
} from '../taxes/tax.service';
import { MAX_RATE_BP } from '../../common/money/tax.util';
import { resolveStoreCurrency } from '../../common/money/currency.util';

/**
 * Minimum customer price of a creator's custom product (marketplace).
 *
 * The platform is the seller of record, so the order's VAT is reserved for it
 * and the commission split runs on the NET revenue (see
 * orders/marketplace-commission.ts). Provider base prices are net supply
 * prices, so a custom product priced incl. VAT must cover base + VAT:
 *
 *   minimum = (base + variant adjustment) x (1 + VAT rate)   prices incl. VAT
 *   minimum =  base + variant adjustment                     prices excl. VAT
 *
 * rounded UP to the cent, so the net of the minimum is never below the base
 * (e.g. base 15.00 at 25 % -> 18.75; 9.99 at 25 % -> 12.49).
 */

/** Price floor inputs of a store: one rate per product tax class. */
export interface PriceFloorSetup {
  pricesIncludeVat: boolean;
  currency: string;
  /** Highest combined VAT rate (basis points) of a product over the destinations. */
  rateBpFor(product: {
    tax_class_id: string | null;
    tax_exempt: boolean;
  }): number;
}

/** What the creator's dashboard needs to show / check the minimum itself. */
export interface PriceFloorInfo {
  prices_include_vat: boolean;
  vat_rate_bp: number;
  currency: string;
}

export interface PriceFloorVariant {
  variant_id: string;
  price_adjustment: number;
  /** PER_VARIANT only: the creator's price for this variant. */
  custom_price?: number | null;
}

export interface PriceFloorInput {
  pricingType: PricingType;
  finalPrice: number;
  marginAmount: number;
  /** Provider base price (net) of the base product. */
  basePrice: number;
  /** Variants the custom product sells (active, selected); [] = none. */
  variants: PriceFloorVariant[];
}

export interface PriceFloorViolation {
  /** Minimum customer price of the offending variant (or the product). */
  minimum: number;
  /** The customer price that was too low. */
  price: number;
  variant_id?: string;
  /** MARGIN only: the smallest margin that reaches every variant's minimum. */
  minimum_margin?: number;
}

const toMinor = (major: number) => Math.round((Number(major) || 0) * 100);

/** Minimum customer price in minor units for one net provider base. */
export function minimumPriceMinor(
  providerBaseNet: number,
  vatRateBp: number,
  pricesIncludeVat: boolean,
): number {
  const base = Math.max(0, toMinor(providerBaseNet));
  if (!pricesIncludeVat || vatRateBp <= 0) return base;
  // Integer product, so an exact result is never nudged up by float noise.
  return Math.ceil((base * (MAX_RATE_BP + vatRateBp)) / MAX_RATE_BP);
}

/** Minimum customer price (major units) for one net provider base. */
export function minimumCustomerPrice(
  providerBaseNet: number,
  vatRateBp: number,
  pricesIncludeVat: boolean,
): number {
  return minimumPriceMinor(providerBaseNet, vatRateBp, pricesIncludeVat) / 100;
}

/**
 * Checkout guard of a bundle line, consistent with the attach-time check:
 * the gross effective unit price against the gross floor (base + VAT when
 * prices include VAT, rounded up), both in minor units.
 */
export function bundleUnitBelowFloor(
  unitPrice: number,
  providerBaseNet: number,
  vatRateBp: number,
  pricesIncludeVat: boolean,
): boolean {
  if (!(Number(providerBaseNet) > 0)) return false;
  return (
    toMinor(unitPrice) <
    minimumPriceMinor(providerBaseNet, vatRateBp, pricesIncludeVat)
  );
}

/**
 * The first price below its minimum, or null. Mirrors how checkout prices a
 * custom product line (OrdersService): SINGLE sells every variant at
 * final_price, PER_VARIANT at each variant's custom price (else base +
 * adjustment), MARGIN at base + adjustment + margin.
 */
export function findPriceFloorViolation(
  input: PriceFloorInput,
  vatRateBp: number,
  pricesIncludeVat: boolean,
): PriceFloorViolation | null {
  const base = Number(input.basePrice) || 0;
  const units: PriceFloorVariant[] = input.variants.length
    ? input.variants
    : [{ variant_id: '', price_adjustment: 0 }];
  const rows = units.map((v) => {
    const cost = base + (Number(v.price_adjustment) || 0);
    return {
      v,
      cost,
      minMinor: minimumPriceMinor(cost, vatRateBp, pricesIncludeVat),
    };
  });
  const idOf = (v: PriceFloorVariant) =>
    v.variant_id ? { variant_id: v.variant_id } : {};

  switch (input.pricingType) {
    case PricingType.SINGLE: {
      // One price for every variant: it must reach the highest minimum.
      const worst = rows.reduce((a, b) => (b.minMinor > a.minMinor ? b : a));
      const priceMinor = toMinor(input.finalPrice);
      if (priceMinor >= worst.minMinor) return null;
      return {
        minimum: worst.minMinor / 100,
        price: priceMinor / 100,
        ...idOf(worst.v),
      };
    }
    case PricingType.PER_VARIANT: {
      for (const { v, cost, minMinor } of rows) {
        const price = !v.variant_id
          ? Number(input.finalPrice) || base
          : v.custom_price != null && Number(v.custom_price) > 0
            ? Number(v.custom_price)
            : cost;
        const priceMinor = toMinor(price);
        if (priceMinor < minMinor) {
          return {
            minimum: minMinor / 100,
            price: priceMinor / 100,
            ...idOf(v),
          };
        }
      }
      return null;
    }
    case PricingType.MARGIN: {
      // The margin must lift every variant to its own minimum.
      let worst = rows[0];
      let neededMinor = worst.minMinor - toMinor(worst.cost);
      for (const row of rows) {
        const needed = row.minMinor - toMinor(row.cost);
        if (needed > neededMinor) {
          worst = row;
          neededMinor = needed;
        }
      }
      const marginMinor = toMinor(input.marginAmount);
      if (marginMinor >= neededMinor) return null;
      return {
        minimum: worst.minMinor / 100,
        price: (toMinor(worst.cost) + marginMinor) / 100,
        minimum_margin: neededMinor / 100,
        ...idOf(worst.v),
      };
    }
    default:
      return null;
  }
}

/**
 * Where the minimum is computed for: every country the store sells to (the
 * countries of its default and LIVE markets), each resolved by the checkout
 * tax engine (OSS / registration rules), so the highest resulting rate is
 * used and the minimum covers every destination. Without market countries
 * it is the registration country alone (null destination: what checkout
 * uses before an address is known).
 */
export function floorDestinations(
  marketCountries: (string[] | null | undefined)[] | null | undefined,
): (TaxDestination | null)[] {
  const countries = [
    ...new Set(
      (marketCountries ?? [])
        .flatMap((list) => list ?? [])
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (!countries.length) return [null];
  return countries.map((country) => ({ country }));
}

/** Highest combined rate (bp) of a product over the given destinations. */
export function highestRateBp(
  ctx: TaxContext,
  data: TaxData,
  product: { tax_class_id: string | null; tax_exempt: boolean },
  destinations: (TaxDestination | null)[],
): number {
  let max = 0;
  for (const destination of destinations.length ? destinations : [null]) {
    const bp = effectiveRateBp(
      resolveRatesForLine(
        ctx,
        data,
        {
          tax_class_id: product.tax_class_id ?? null,
          tax_exempt: !!product.tax_exempt,
        },
        destination,
      ).rates,
    );
    if (bp > max) max = bp;
  }
  return max;
}

/**
 * Loads the price floor of a creator's store with the checkout tax engine
 * (same context, rates and class resolution as order creation). A creator
 * without a store is priced as a marketplace store (the platform taxes it).
 */
export async function loadPriceFloorSetup(
  prisma: PrismaService,
  taxService: Pick<TaxService, 'contextFor' | 'loadTaxData'>,
  creatorId: string,
): Promise<PriceFloorSetup> {
  const [store, platform] = await Promise.all([
    prisma.store.findUnique({
      where: { creator_id: creatorId },
      select: {
        ...taxStoreSelect,
        currency: true,
        // Every market the store sells through: the default one (always
        // served) and the LIVE ones.
        markets: {
          where: { OR: [{ is_default: true }, { status: MarketStatus.LIVE }] },
          select: { countries: true },
        },
      },
    }),
    prisma.platformConfig.findFirst({
      select: {
        default_currency: true,
        default_tax_pricing_mode: true,
        platform_tax_country: true,
        platform_oss_registered: true,
      },
    }),
  ]);
  const ctx: TaxContext = store
    ? await taxService.contextFor(store)
    : buildTaxContext(
        {
          id: '',
          store_type: StoreType.MARKETPLACE,
          tax_pricing_mode: TaxPricingMode.INCLUSIVE,
          tax_basis: TaxBasis.SHIPPING,
          tax_country: null,
          oss_registered: false,
          use_platform_tax_rates: true,
          shipping_tax_class_id: null,
          display_prices_incl_tax: true,
        },
        platform,
      );
  const data: TaxData = await taxService.loadTaxData(ctx);
  const destinations = floorDestinations(
    (store?.markets ?? []).map((m) => m.countries),
  );
  const pricesIncludeVat = ctx.pricingMode === TaxPricingMode.INCLUSIVE;
  return {
    pricesIncludeVat,
    currency: resolveStoreCurrency(store, platform?.default_currency),
    rateBpFor: (product) =>
      pricesIncludeVat ? highestRateBp(ctx, data, product, destinations) : 0,
  };
}

export function priceFloorInfo(
  setup: PriceFloorSetup,
  product: { tax_class_id: string | null; tax_exempt: boolean },
): PriceFloorInfo {
  return {
    prices_include_vat: setup.pricesIncludeVat,
    vat_rate_bp: setup.rateBpFor(product),
    currency: setup.currency,
  };
}

type FloorMoney = number | { toString(): string };

/** Base product fields the minimum price check reads. */
export interface FloorBaseProduct {
  base_price: FloorMoney;
  provider_id: string | null;
  tax_class_id: string | null;
  tax_exempt: boolean;
  /** Active variants only. */
  variants: { id: string; price_adjustment: FloorMoney }[];
}

/** Custom product fields the below-minimum check reads. */
export interface FloorCustomProductInput {
  pricing_type: PricingType;
  final_price: FloorMoney;
  margin_amount: FloorMoney | null;
  selected_variants?: {
    variant_id: string;
    custom_price: FloorMoney | null;
  }[];
  product: FloorBaseProduct;
}

/**
 * The variants a custom product sells, as the floor check sees them: the
 * selected rows still active on the base product, else every active
 * variant (AS_IS rows mirror them), else none.
 */
export function floorVariantsOf(
  product: Pick<FloorBaseProduct, 'variants'>,
  selected:
    | { variant_id: string; custom_price?: FloorMoney | null }[]
    | undefined,
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
 * The below-minimum check of a stored custom product against its store's
 * floor setup (what the creator's list flags as `below_minimum`). Null when
 * the price is fine or the product has no provider base.
 */
export function customProductFloorViolation(
  cp: FloorCustomProductInput,
  info: PriceFloorInfo,
): PriceFloorViolation | null {
  if (!cp.product?.provider_id) return null;
  return findPriceFloorViolation(
    {
      pricingType: cp.pricing_type,
      finalPrice: Number(cp.final_price) || 0,
      marginAmount: Number(cp.margin_amount) || 0,
      basePrice: Number(cp.product.base_price),
      variants: floorVariantsOf(cp.product, cp.selected_variants),
    },
    info.vat_rate_bp,
    info.prices_include_vat,
  );
}
