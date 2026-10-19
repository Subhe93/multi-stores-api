import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { roundMoney } from '../../common/money/currency.util';
import type { MarketContext } from './market-context';
import {
  resolveMarketPrice,
  resolveVariantMarketPrice,
  type PricingContext,
} from './pricing.util';

/** The override rows of one product in one market. */
export interface ProductMarketRows {
  product: {
    price: number | null;
    compare_at_price: number | null;
    available: boolean;
  } | null;
  variants: Map<string, { price: number | null }>;
}

export type MarketPriceMap = Map<string, ProductMarketRows>;

export const MARKET_FX_RATE_MISSING = {
  code: 'MARKET_FX_RATE_MISSING',
  message: 'No exchange rate is configured for this market.',
};

/** What the storefront list/detail payloads need per product. */
export interface PricedProduct {
  hidden: boolean;
  base_price: number;
  compare_at_price: number | undefined;
  variants: {
    id: string;
    price: number;
    compare_at_price: number | undefined;
  }[];
}

/**
 * Applies a MarketContext to catalogue prices. Override rows are loaded in
 * one query per call (loadPrices) and the math is pricing.util's.
 */
@Injectable()
export class MarketPricingService {
  constructor(private readonly prisma: PrismaService) {}

  /** Override rows of `productIds` in the market, keyed by product id. */
  async loadPrices(
    marketId: string,
    productIds: string[],
  ): Promise<MarketPriceMap> {
    if (productIds.length === 0) return new Map();
    const rows = await this.prisma.productMarketPrice.findMany({
      where: { market_id: marketId, product_id: { in: productIds } },
      select: priceRowSelect,
    });
    return groupRows(rows, (r) => r.product_id);
  }

  /** Override rows of every own-product line of an order, in one query. */
  loadPricesForLines(
    ctx: MarketContext,
    lines: { product_id?: string | null; custom_product_id?: string | null }[],
  ): Promise<MarketPriceMap> {
    const ids = new Set<string>();
    for (const l of lines) {
      if (l.product_id && !l.custom_product_id) ids.add(l.product_id);
    }
    return this.loadPrices(ctx.id, [...ids]);
  }

  /** One product's override rows across markets, keyed by market id. */
  async loadPricesForProduct(
    productId: string,
    marketIds: string[],
  ): Promise<MarketPriceMap> {
    if (marketIds.length === 0) return new Map();
    const rows = await this.prisma.productMarketPrice.findMany({
      where: { product_id: productId, market_id: { in: marketIds } },
      select: priceRowSelect,
    });
    return groupRows(rows, (r) => r.market_id);
  }

  /**
   * A product's list/detail prices in the market. `hidden` when the creator
   * switched it off there, or when it has no override and no rate exists
   * (fixed rule without a rate).
   */
  priceProduct(
    ctx: MarketContext,
    product: {
      id: string;
      base_price: number;
      compare_at_price?: number | null;
      variants: {
        id: string;
        price_adjustment: unknown;
        compare_at_price?: number | null;
      }[];
    },
    rows: ProductMarketRows | undefined,
  ): PricedProduct {
    const pctx = pricingContext(ctx);
    const productRow = rows?.product ?? null;
    if (productRow && !productRow.available) {
      return {
        hidden: true,
        base_price: product.base_price,
        compare_at_price: undefined,
        variants: [],
      };
    }
    const basePrice = resolveMarketPrice({
      basePrice: product.base_price,
      override: productRow?.price,
      ctx: pctx,
    });
    if (basePrice == null) {
      return {
        hidden: true,
        base_price: product.base_price,
        compare_at_price: undefined,
        variants: [],
      };
    }
    const compareAt = resolveMarketPrice({
      basePrice: Number(product.compare_at_price ?? 0),
      override: productRow?.compare_at_price,
      ctx: pctx,
    });
    const variants = product.variants.map((v) => {
      const price = resolveVariantMarketPrice({
        basePrice: product.base_price,
        adjustment: Number(v.price_adjustment || 0),
        productOverride: productRow?.price,
        variantOverride: rows?.variants.get(v.id)?.price,
        ctx: pctx,
      });
      const vCompare = v.compare_at_price
        ? resolveMarketPrice({
            basePrice: Number(v.compare_at_price),
            override: null,
            ctx: pctx,
          })
        : null;
      return {
        id: v.id,
        price: price ?? basePrice,
        compare_at_price: vCompare ?? undefined,
      };
    });
    return {
      hidden: false,
      base_price: basePrice,
      // A manual compare-at override shows even when the base product has
      // none (the creator set it for this market only).
      compare_at_price:
        (productRow?.compare_at_price != null || product.compare_at_price) &&
        compareAt
          ? compareAt
          : undefined,
      variants,
    };
  }

  /**
   * The unit price of one order/cart line in the market, or null when the
   * product is hidden there (the caller rejects the line). One query per
   * call unless the caller passes the rows it loaded for the whole order.
   */
  async priceLine(
    ctx: MarketContext,
    line: {
      product_id: string;
      variant_id: string | null;
      basePrice: number;
      adjustment: number;
    },
    loaded?: MarketPriceMap | null,
  ): Promise<number | null> {
    const rows = (
      loaded ?? (await this.loadPrices(ctx.id, [line.product_id]))
    ).get(line.product_id);
    if (rows?.product && !rows.product.available) return null;
    if (line.variant_id) {
      return resolveVariantMarketPrice({
        basePrice: line.basePrice,
        adjustment: line.adjustment,
        productOverride: rows?.product?.price,
        variantOverride: rows?.variants.get(line.variant_id)?.price,
        ctx: pricingContext(ctx),
      });
    }
    return resolveMarketPrice({
      basePrice: line.basePrice,
      override: rows?.product?.price,
      ctx: pricingContext(ctx),
    });
  }

  /**
   * A base-currency amount (shipping cost, free threshold, fixed coupon) in
   * the market currency. Plain conversion, no price-ending rounding.
   */
  convertMoney(ctx: MarketContext, amount: number): number {
    if (ctx.rate == null) throw new BadRequestException(rateMissing(ctx));
    return roundMoney(Number(amount) * ctx.rate, ctx.currency);
  }

  /** The inverse: a market-currency amount back in the base currency. */
  toBaseMoney(ctx: MarketContext, amount: number): number {
    if (ctx.rate == null || ctx.rate <= 0) {
      throw new BadRequestException(rateMissing(ctx));
    }
    return roundMoney(Number(amount) / ctx.rate, ctx.storeCurrency);
  }
}

const priceRowSelect = {
  product_id: true,
  market_id: true,
  variant_id: true,
  price: true,
  compare_at_price: true,
  available: true,
} as const;

type PriceRow = {
  product_id: string;
  market_id: string;
  variant_id: string | null;
  price: unknown;
  compare_at_price: unknown;
  available: boolean;
};

function groupRows(
  rows: PriceRow[],
  keyOf: (row: PriceRow) => string,
): MarketPriceMap {
  const map: MarketPriceMap = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    let entry = map.get(key);
    if (!entry) {
      entry = { product: null, variants: new Map() };
      map.set(key, entry);
    }
    if (row.variant_id) {
      entry.variants.set(row.variant_id, {
        price: row.price == null ? null : Number(row.price),
      });
    } else {
      entry.product = {
        price: row.price == null ? null : Number(row.price),
        compare_at_price:
          row.compare_at_price == null ? null : Number(row.compare_at_price),
        available: row.available,
      };
    }
  }
  return map;
}

function rateMissing(ctx: MarketContext) {
  return {
    code: MARKET_FX_RATE_MISSING.code,
    message: `No exchange rate from ${ctx.storeCurrency} to ${ctx.currency} is configured for this market.`,
  };
}

export function pricingContext(ctx: MarketContext): PricingContext {
  return {
    currency: ctx.currency,
    rate: ctx.rate,
    rounding: ctx.priceRule.rounding,
  };
}
