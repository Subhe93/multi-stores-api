import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma, StoreType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { resolveStoreCurrency } from '../../common/money/currency.util';
import {
  bucketSql,
  capWithOther,
  countedOrderSql,
  isoWithOffset,
  parseRange,
  resolveTimeZone,
  resolveWindow,
  round2,
  storeAmountSql,
  tsParam,
  zeroFill,
  type OverviewGranularity,
  type OverviewRange,
  type OverviewWindow,
  type SeriesPoint,
} from './overview-range';

/** Low stock = a tracked stock figure at or below this. */
export const LOW_STOCK_THRESHOLD = 5;
const LOW_STOCK_LIST_LIMIT = 10;
const TOP_PRODUCTS_LIMIT = 5;
const RECENT_ORDERS_LIMIT = 6;
const MARKET_BUCKETS = 8;
// Online payments still `awaiting_payment` past these windows are abandoned
// (mirrors ABANDONED_PAYMENT_TTL_MS / ABANDONED_KUSTOM_TTL_MS in orders).
const AWAITING_CARD_HOURS = 2;
const AWAITING_KUSTOM_HOURS = 6;

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 500;

interface Kpi {
  value: number;
  previous: number;
}

export interface OverviewResponse {
  range: OverviewRange;
  granularity: OverviewGranularity;
  from: string;
  to: string;
  timezone: string;
  currency: string;
  store_type: StoreType;
  kpis: {
    revenue: Kpi;
    orders: Kpi;
    aov: Kpi;
    items_sold: Kpi;
    customers: Kpi;
    returning_customers: Kpi;
    earnings: Kpi | null;
  };
  series: SeriesPoint[];
  previous_series: SeriesPoint[];
  status_breakdown: { status: string; count: number }[];
  sales_by_market: {
    key: string;
    label: string;
    revenue: number;
    orders: number;
  }[];
  payment_methods: { method: string; revenue: number; orders: number }[];
  top_products: {
    id: string;
    kind: 'own' | 'custom';
    title: string;
    image: string | null;
    quantity: number;
    revenue: number;
  }[];
  recent_orders: {
    id: string;
    order_number: string;
    customer_name: string;
    total: number;
    currency: string;
    status: string;
    payment_status: string | null;
    created_at: string;
  }[];
  todo: {
    unfulfilled_orders: number;
    pending_payment_orders: number;
    low_stock_products: number;
    draft_products: number;
    pending_review_products: number;
  };
  low_stock: {
    id: string;
    kind: 'own';
    title: string;
    image: string | null;
    stock: number;
  }[];
  setup: {
    has_products: boolean;
    has_logo: boolean;
    has_payment: boolean;
    has_shipping: boolean;
    has_domain: boolean;
    has_published_theme: boolean;
  };
}

/** What the overview needs about the caller's store. */
interface StoreCtx {
  id: string;
  creatorId: string;
  storeType: StoreType;
  currency: string;
  timezone: string | null;
  primaryLocale: string;
  logoUrl: string | null;
  customDomain: string | null;
  codEnabled: boolean;
  creator: {
    stripe_charges_enabled: boolean;
    stripe_payouts_enabled: boolean;
    kustom_enabled: boolean;
    kustom_merchant_id: string | null;
  };
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));

@Injectable()
export class OverviewService {
  // Short in-memory cache keyed by store + range + tz; Map order = insertion
  // order, so the first key is the oldest when the bound is hit.
  private readonly cache = new Map<
    string,
    { expires: number; value: OverviewResponse }
  >();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly storeApps?: StoreAppsService,
  ) {}

  async getOverview(
    userId: string,
    rawRange?: string,
    rawTz?: string,
  ): Promise<OverviewResponse> {
    const range = parseRange(rawRange);
    const store = await this.loadStore(userId);
    const timezone = resolveTimeZone(rawTz, store.timezone);

    const key = `${store.id}|${range}|${timezone}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) return hit.value;

    const value = await this.compute(store, resolveWindow(range, timezone));
    this.cache.delete(key);
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, { expires: now + CACHE_TTL_MS, value });
    return value;
  }

  private async loadStore(userId: string): Promise<StoreCtx> {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: {
        id: true,
        stripe_charges_enabled: true,
        stripe_payouts_enabled: true,
        kustom_enabled: true,
        kustom_merchant_id: true,
        store: {
          select: {
            id: true,
            store_type: true,
            currency: true,
            logo_url: true,
            custom_domain: true,
            cod_enabled: true,
            language_config: { select: { primary_locale: true } },
            legal_profiles: {
              where: { key: 'default' },
              select: { timezone: true },
              take: 1,
            },
          },
        },
      },
    });
    if (!creator?.store) {
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    }
    const platform = await this.prisma.platformConfig.findFirst({
      select: { default_currency: true },
    });
    const s = creator.store;
    return {
      id: s.id,
      creatorId: creator.id,
      storeType: s.store_type,
      currency: resolveStoreCurrency(s, platform?.default_currency),
      timezone: s.legal_profiles[0]?.timezone ?? null,
      primaryLocale: s.language_config?.primary_locale || 'en',
      logoUrl: s.logo_url,
      customDomain: s.custom_domain,
      codEnabled: s.cod_enabled,
      creator: {
        stripe_charges_enabled: creator.stripe_charges_enabled,
        stripe_payouts_enabled: creator.stripe_payouts_enabled,
        kustom_enabled: creator.kustom_enabled,
        kustom_merchant_id: creator.kustom_merchant_id,
      },
    };
  }

  private async compute(
    store: StoreCtx,
    w: OverviewWindow,
  ): Promise<OverviewResponse> {
    const marketplace = store.storeType !== StoreType.INDEPENDENT;
    const [
      kpis,
      series,
      statusBreakdown,
      salesByMarket,
      paymentMethods,
      topProducts,
      recentOrders,
      todo,
      lowStock,
      setup,
    ] = await Promise.all([
      this.kpis(store, w, marketplace),
      this.series(store, w),
      this.statusBreakdown(store, w),
      this.salesByMarket(store, w),
      this.paymentMethods(store, w),
      this.topProducts(store, w),
      this.recentOrders(store),
      this.todo(store, marketplace),
      this.lowStock(store),
      this.setup(store),
    ]);

    return {
      range: w.range,
      granularity: w.granularity,
      from: isoWithOffset(w.from, w.timezone),
      to: isoWithOffset(new Date(w.to.getTime() - 1), w.timezone),
      timezone: w.timezone,
      currency: store.currency,
      store_type: store.storeType,
      kpis,
      series: series.current,
      previous_series: series.previous,
      status_breakdown: statusBreakdown,
      sales_by_market: salesByMarket,
      payment_methods: paymentMethods,
      top_products: topProducts,
      recent_orders: recentOrders,
      todo: { ...todo, low_stock_products: lowStock.count },
      low_stock: lowStock.items,
      setup,
    };
  }

  /** Counted orders of the store created in [from, to). */
  private countedWhere(storeId: string, from: Date, to: Date): Prisma.Sql {
    return Prisma.sql`o.store_id = ${storeId}
      AND o.created_at >= ${tsParam(from)}
      AND o.created_at < ${tsParam(to)}
      AND ${countedOrderSql('o')}`;
  }

  private async kpis(
    store: StoreCtx,
    w: OverviewWindow,
    marketplace: boolean,
  ): Promise<OverviewResponse['kpis']> {
    const amount = storeAmountSql(Prisma.sql`o.total`, store.currency);
    const earning = storeAmountSql(
      Prisma.sql`COALESCE(c.creator_amount, 0)`,
      store.currency,
    );
    // `cur` splits the two periods in one scan. A returning customer has a
    // counted order before the start of the period the row belongs to.
    const rows = await this.prisma.$queryRaw<
      {
        cur: boolean;
        revenue: number | null;
        orders: number;
        items: number | null;
        customers: number;
        returning: number;
        earnings: number | null;
      }[]
    >(Prisma.sql`
      SELECT (o.created_at >= ${tsParam(w.from)}) AS cur,
             SUM(${amount})::float8 AS revenue,
             COUNT(*)::int AS orders,
             SUM((SELECT COALESCE(SUM(oi.quantity), 0)
                    FROM "OrderItem" oi WHERE oi.order_id = o.id))::float8 AS items,
             COUNT(DISTINCT o.customer_id)::int AS customers,
             COUNT(DISTINCT CASE WHEN EXISTS (
               SELECT 1 FROM "Order" p
                WHERE p.store_id = o.store_id
                  AND p.customer_id = o.customer_id
                  AND p.created_at < CASE WHEN o.created_at >= ${tsParam(w.from)}
                                          THEN ${tsParam(w.from)}
                                          ELSE ${tsParam(w.prevFrom)} END
                  AND ${countedOrderSql('p')}
             ) THEN o.customer_id END)::int AS returning,
             SUM(${earning})::float8 AS earnings
        FROM "Order" o
        LEFT JOIN "OrderCommission" c ON c.order_id = o.id
       WHERE ${this.countedWhere(store.id, w.prevFrom, w.to)}
       GROUP BY 1`);

    const cur = rows.find((r) => r.cur);
    const prev = rows.find((r) => !r.cur);
    const pair = (
      pick: (r: (typeof rows)[number]) => unknown,
      money = false,
    ) => {
      const v = cur ? num(pick(cur)) : 0;
      const p = prev ? num(pick(prev)) : 0;
      return money
        ? { value: round2(v), previous: round2(p) }
        : { value: v, previous: p };
    };
    const revenue = pair((r) => r.revenue, true);
    const orders = pair((r) => r.orders);
    const aov = (rev: number, n: number) => (n > 0 ? round2(rev / n) : 0);
    return {
      revenue,
      orders,
      aov: {
        value: aov(revenue.value, orders.value),
        previous: aov(revenue.previous, orders.previous),
      },
      items_sold: pair((r) => r.items),
      customers: pair((r) => r.customers),
      returning_customers: pair((r) => r.returning),
      earnings: marketplace ? pair((r) => r.earnings, true) : null,
    };
  }

  private async series(
    store: StoreCtx,
    w: OverviewWindow,
  ): Promise<{ current: SeriesPoint[]; previous: SeriesPoint[] }> {
    const { unit, format } = bucketSql(w.granularity);
    const amount = storeAmountSql(Prisma.sql`o.total`, store.currency);
    const rows = await this.prisma.$queryRaw<
      { t: string; revenue: number | null; orders: number }[]
    >(Prisma.sql`
      SELECT to_char(
               date_trunc(${unit}::text,
                 (o.created_at AT TIME ZONE 'UTC') AT TIME ZONE ${w.timezone}::text),
               ${format}::text) AS t,
             SUM(${amount})::float8 AS revenue,
             COUNT(*)::int AS orders
        FROM "Order" o
       WHERE ${this.countedWhere(store.id, w.prevFrom, w.to)}
       GROUP BY 1`);
    const byKey = new Map(
      rows.map((r) => [
        r.t,
        { revenue: num(r.revenue), orders: num(r.orders) },
      ]),
    );
    return {
      current: zeroFill(w.keys, byKey),
      previous: zeroFill(w.prevKeys, byKey),
    };
  }

  /** Every order of the period (counted or not) per status. */
  private async statusBreakdown(store: StoreCtx, w: OverviewWindow) {
    const rows = await this.prisma.order.groupBy({
      by: ['status'],
      where: { store_id: store.id, created_at: { gte: w.from, lt: w.to } },
      _count: { _all: true },
    });
    return rows
      .map((r) => ({ status: r.status as string, count: r._count._all }))
      .sort((a, b) => b.count - a.count);
  }

  private async salesByMarket(store: StoreCtx, w: OverviewWindow) {
    const amount = storeAmountSql(Prisma.sql`o.total`, store.currency);
    const useMarkets =
      (await this.storeApps?.isEnabled(store.id, 'markets')) ?? false;

    if (useMarkets) {
      const [rows, markets] = await Promise.all([
        this.prisma.$queryRaw<
          { market_id: string | null; revenue: number | null; orders: number }[]
        >(Prisma.sql`
          SELECT o.market_id, SUM(${amount})::float8 AS revenue,
                 COUNT(*)::int AS orders
            FROM "Order" o
           WHERE ${this.countedWhere(store.id, w.from, w.to)}
           GROUP BY 1`),
        this.prisma.market.findMany({
          where: { store_id: store.id },
          select: { id: true, key: true, name: true, is_default: true },
        }),
      ]);
      const byId = new Map(markets.map((m) => [m.id, m]));
      const fallback = markets.find((m) => m.is_default);
      // Orders placed without a market (before the app) belong to the
      // default market; a deleted market's orders keep market_id null too.
      const merged = new Map<
        string,
        { key: string; label: string; revenue: number; orders: number }
      >();
      for (const r of rows) {
        const m = (r.market_id && byId.get(r.market_id)) || fallback;
        const key = m?.key ?? 'unknown';
        const entry = merged.get(key) ?? {
          key,
          label: m?.name ?? 'Unknown',
          revenue: 0,
          orders: 0,
        };
        entry.revenue += num(r.revenue);
        entry.orders += num(r.orders);
        merged.set(key, entry);
      }
      return capWithOther([...merged.values()], MARKET_BUCKETS);
    }

    const rows = await this.prisma.$queryRaw<
      { country: string | null; revenue: number | null; orders: number }[]
    >(Prisma.sql`
      SELECT UPPER(a.country_code) AS country,
             SUM(${amount})::float8 AS revenue, COUNT(*)::int AS orders
        FROM "Order" o
        JOIN "Address" a ON a.id = o.address_id
       WHERE ${this.countedWhere(store.id, w.from, w.to)}
       GROUP BY 1`);
    return capWithOther(
      rows.map((r) => {
        const key = r.country || 'unknown';
        return {
          key,
          label: countryLabel(key),
          revenue: num(r.revenue),
          orders: num(r.orders),
        };
      }),
      MARKET_BUCKETS,
    );
  }

  private async paymentMethods(store: StoreCtx, w: OverviewWindow) {
    const amount = storeAmountSql(Prisma.sql`o.total`, store.currency);
    const rows = await this.prisma.$queryRaw<
      { method: string; revenue: number | null; orders: number }[]
    >(Prisma.sql`
      SELECT o.payment_method::text AS method,
             SUM(${amount})::float8 AS revenue, COUNT(*)::int AS orders
        FROM "Order" o
       WHERE ${this.countedWhere(store.id, w.from, w.to)}
       GROUP BY 1
       ORDER BY 2 DESC NULLS LAST`);
    return rows.map((r) => ({
      method: r.method,
      revenue: round2(num(r.revenue)),
      orders: num(r.orders),
    }));
  }

  private async topProducts(
    store: StoreCtx,
    w: OverviewWindow,
  ): Promise<OverviewResponse['top_products']> {
    const lineAmount = storeAmountSql(
      Prisma.sql`oi.total_price`,
      store.currency,
    );
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        kind: 'own' | 'custom';
        quantity: number;
        revenue: number | null;
      }[]
    >(Prisma.sql`
      SELECT COALESCE(oi.custom_product_id, oi.product_id) AS id,
             CASE WHEN oi.custom_product_id IS NOT NULL THEN 'custom' ELSE 'own' END AS kind,
             SUM(oi.quantity)::int AS quantity,
             SUM(${lineAmount})::float8 AS revenue
        FROM "OrderItem" oi
        JOIN "Order" o ON o.id = oi.order_id
       WHERE ${this.countedWhere(store.id, w.from, w.to)}
         AND COALESCE(oi.custom_product_id, oi.product_id) IS NOT NULL
       GROUP BY 1, 2
       ORDER BY 4 DESC NULLS LAST, 3 DESC
       LIMIT ${TOP_PRODUCTS_LIMIT}`);
    if (!rows.length) return [];

    const ownIds = rows.filter((r) => r.kind === 'own').map((r) => r.id);
    const customIds = rows.filter((r) => r.kind === 'custom').map((r) => r.id);
    const [own, custom] = await Promise.all([
      this.ownProductMeta(ownIds, store.primaryLocale),
      this.customProductMeta(customIds, store.primaryLocale),
    ]);
    return rows.map((r) => {
      const meta = (r.kind === 'own' ? own : custom).get(r.id);
      return {
        id: r.id,
        kind: r.kind,
        title: meta?.title ?? '',
        image: meta?.image ?? null,
        quantity: num(r.quantity),
        revenue: round2(num(r.revenue)),
      };
    });
  }

  private async ownProductMeta(ids: string[], locale: string) {
    const out = new Map<string, { title: string; image: string | null }>();
    if (!ids.length) return out;
    const products = await this.prisma.product.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        translations: { select: { locale: true, title: true } },
        images: {
          select: { url: true },
          orderBy: [{ is_featured: 'desc' }, { sort_order: 'asc' }],
          take: 1,
        },
      },
    });
    for (const p of products) {
      out.set(p.id, {
        title: pickTitle(p.translations, locale),
        image: p.images[0]?.url ?? null,
      });
    }
    return out;
  }

  private async customProductMeta(ids: string[], locale: string) {
    const out = new Map<string, { title: string; image: string | null }>();
    if (!ids.length) return out;
    const products = await this.prisma.customProduct.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        translations: { select: { locale: true, title: true } },
        mockup_images: {
          select: { url: true },
          orderBy: { sort_order: 'asc' },
          take: 1,
        },
        product: {
          select: {
            translations: { select: { locale: true, title: true } },
            images: {
              select: { url: true },
              orderBy: [{ is_featured: 'desc' }, { sort_order: 'asc' }],
              take: 1,
            },
          },
        },
      },
    });
    for (const p of products) {
      out.set(p.id, {
        title:
          pickTitle(p.translations, locale) ||
          pickTitle(p.product.translations, locale),
        image: p.mockup_images[0]?.url ?? p.product.images[0]?.url ?? null,
      });
    }
    return out;
  }

  /** The last orders of the store, any status, amounts in the order currency. */
  private async recentOrders(
    store: StoreCtx,
  ): Promise<OverviewResponse['recent_orders']> {
    const orders = await this.prisma.order.findMany({
      where: { store_id: store.id },
      orderBy: { created_at: 'desc' },
      take: RECENT_ORDERS_LIMIT,
      select: {
        id: true,
        order_number: true,
        total: true,
        currency: true,
        status: true,
        payment_status: true,
        created_at: true,
        customer: { select: { first_name: true, last_name: true } },
        address: { select: { full_name: true } },
      },
    });
    return orders.map((o) => ({
      id: o.id,
      order_number: o.order_number,
      customer_name:
        `${o.customer?.first_name ?? ''} ${o.customer?.last_name ?? ''}`.trim() ||
        o.address?.full_name ||
        '',
      total: Number(o.total),
      currency: o.currency,
      status: o.status,
      payment_status: o.payment_status,
      created_at: o.created_at.toISOString(),
    }));
  }

  private async todo(
    store: StoreCtx,
    marketplace: boolean,
  ): Promise<Omit<OverviewResponse['todo'], 'low_stock_products'>> {
    const [orderRows, ownDraft, customDraft, ownReview, customReview] =
      await Promise.all([
        this.prisma.$queryRaw<{ unfulfilled: number; pending: number }[]>(
          Prisma.sql`
          SELECT
            COUNT(*) FILTER (
              WHERE o.status::text IN ('PENDING', 'CONFIRMED', 'PROCESSING',
                                       'MANUFACTURING', 'QUALITY_CHECK')
                AND ${countedOrderSql('o')}
            )::int AS unfulfilled,
            COUNT(*) FILTER (
              WHERE o.payment_status = 'awaiting_payment'
                AND o.status::text NOT IN ('CANCELLED', 'REFUNDED')
                AND o.created_at >= (now() AT TIME ZONE 'UTC') - CASE
                      WHEN o.payment_method::text = 'KUSTOM'
                      THEN make_interval(hours => ${AWAITING_KUSTOM_HOURS}::int)
                      ELSE make_interval(hours => ${AWAITING_CARD_HOURS}::int) END
            )::int AS pending
            FROM "Order" o
           WHERE o.store_id = ${store.id}`,
        ),
        this.prisma.product.count({
          where: { creator_id: store.creatorId, status: 'DRAFT' },
        }),
        this.prisma.customProduct.count({
          where: { creator_id: store.creatorId, status: 'DRAFT' },
        }),
        marketplace
          ? this.prisma.product.count({
              where: { creator_id: store.creatorId, status: 'PENDING_REVIEW' },
            })
          : Promise.resolve(0),
        marketplace
          ? this.prisma.customProduct.count({
              where: { creator_id: store.creatorId, status: 'PENDING_REVIEW' },
            })
          : Promise.resolve(0),
      ]);
    return {
      unfulfilled_orders: num(orderRows[0]?.unfulfilled),
      pending_payment_orders: num(orderRows[0]?.pending),
      draft_products: ownDraft + customDraft,
      pending_review_products: ownReview + customReview,
    };
  }

  /**
   * Published own products whose tracked stock is at or below the threshold.
   * A product with active variants is judged by its lowest variant that has
   * a stock number (checkout enforces a variant's stock whenever it is set);
   * a product without variants by stock_quantity when track_inventory is on.
   * Custom (provider) products carry no creator inventory.
   */
  private async lowStock(
    store: StoreCtx,
  ): Promise<{ count: number; items: OverviewResponse['low_stock'] }> {
    const rows = await this.prisma.$queryRaw<
      { id: string; stock: number; total: number }[]
    >(Prisma.sql`
      WITH s AS (
        SELECT p.id,
               CASE
                 WHEN EXISTS (SELECT 1 FROM "ProductVariant" v
                               WHERE v.product_id = p.id AND v.is_active)
                 THEN (SELECT MIN(v.stock_quantity) FROM "ProductVariant" v
                        WHERE v.product_id = p.id AND v.is_active
                          AND v.stock_quantity IS NOT NULL)
                 WHEN p.track_inventory THEN p.stock_quantity
               END AS stock
          FROM "Product" p
         WHERE p.creator_id = ${store.creatorId}
           AND p.status::text = 'PUBLISHED'
      )
      SELECT id, stock::int AS stock, (COUNT(*) OVER ())::int AS total
        FROM s
       WHERE stock IS NOT NULL AND stock <= ${LOW_STOCK_THRESHOLD}
       ORDER BY stock ASC, id
       LIMIT ${LOW_STOCK_LIST_LIMIT}`);
    if (!rows.length) return { count: 0, items: [] };
    const meta = await this.ownProductMeta(
      rows.map((r) => r.id),
      store.primaryLocale,
    );
    return {
      count: num(rows[0].total),
      items: rows.map((r) => ({
        id: r.id,
        kind: 'own' as const,
        title: meta.get(r.id)?.title ?? '',
        image: meta.get(r.id)?.image ?? null,
        stock: num(r.stock),
      })),
    };
  }

  private async setup(store: StoreCtx): Promise<OverviewResponse['setup']> {
    const notArchived = { not: 'ARCHIVED' as const };
    const [ownProduct, customProduct, zone, activeDomain, home] =
      await Promise.all([
        this.prisma.product.findFirst({
          where: { creator_id: store.creatorId, status: notArchived },
          select: { id: true },
        }),
        this.prisma.customProduct.findFirst({
          where: { creator_id: store.creatorId, status: notArchived },
          select: { id: true },
        }),
        this.prisma.shippingZone.findFirst({
          where: { profile: { creator_id: store.creatorId } },
          select: { id: true },
        }),
        this.prisma.storeDomain.findFirst({
          where: { store_id: store.id, status: 'ACTIVE' },
          select: { id: true },
        }),
        this.prisma.page.findFirst({
          where: {
            store_id: store.id,
            type: 'HOME',
            status: 'PUBLISHED',
            published_version_id: { not: null },
          },
          select: { id: true },
        }),
      ]);
    const c = store.creator;
    const hasPayment =
      store.storeType === StoreType.INDEPENDENT
        ? c.stripe_charges_enabled ||
          (c.kustom_enabled && !!c.kustom_merchant_id) ||
          store.codEnabled
        : // Marketplace: the platform charges; the creator needs a payout account.
          c.stripe_payouts_enabled;
    return {
      has_products: !!(ownProduct || customProduct),
      has_logo: !!store.logoUrl,
      has_payment: hasPayment,
      has_shipping: !!zone,
      has_domain: !!store.customDomain || !!activeDomain,
      has_published_theme: !!home,
    };
  }
}

/** Title in `locale`, else English, else the first translation. */
function pickTitle(
  translations: { locale: string; title: string }[],
  locale: string,
): string {
  return (
    translations.find((t) => t.locale === locale)?.title ??
    translations.find((t) => t.locale === 'en')?.title ??
    translations[0]?.title ??
    ''
  );
}

let regionNames: Intl.DisplayNames | null | undefined;

/** English country name of an ISO-2 code (the dashboard re-localises). */
export function countryLabel(code: string): string {
  if (code === 'unknown') return 'Unknown';
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}
