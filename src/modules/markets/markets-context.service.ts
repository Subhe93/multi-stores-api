import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { resolveStoreCurrency } from '../../common/money/currency.util';
import { FxService, priceRuleOf } from './fx.service';
import { MarketContext, toMarketRoute } from './market-context';
import type { MarketRoute } from './market.types';
import { PgNotifyListener } from '../../common/ops/pg-listener';

/**
 * Cross-instance invalidation (same mechanism as StoreAppsService): a market
 * mutation or an FX change runs `pg_notify('markets', storeId | '*')` and
 * every instance's LISTEN connection drops its copy, so a second PM2
 * instance never serves a stale market, price rule or domain for the TTL.
 * `MARKETS_LISTEN=off` disables the listener (TTL fallback only).
 */
export const MARKETS_CHANNEL = 'markets';
const ALL_STORES = '*';

/**
 * The single entry point every market-aware hook calls:
 * `resolve(storeId, key?)` → MarketContext | null. Null means the "markets"
 * app is not in effect for the store, and the hook site then runs the
 * pre-markets code path verbatim. With the app on and no key, the default
 * market answers.
 *
 * Reads are cached per store (same Map+TTL pattern as StoreAppsService):
 * one entry holds the store's markets with their ACTIVE domains, the store
 * currency and the platform default. Every market mutation calls
 * invalidate(storeId).
 */

const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 5000;

const marketSelect = {
  id: true,
  key: true,
  name: true,
  countries: true,
  default_locale: true,
  locales: true,
  currency: true,
  is_default: true,
  status: true,
  price_rule: true,
  // Every status is read; `toContext` serves ACTIVE hosts only, except that
  // a preview context may name a pending primary as its canonical host.
  domains: {
    select: {
      hostname: true,
      is_primary: true,
      redirect_to: true,
      status: true,
    },
    orderBy: { created_at: 'asc' as const },
  },
} satisfies Prisma.MarketSelect;

type MarketRow = Prisma.MarketGetPayload<{ select: typeof marketSelect }>;

interface CacheEntry {
  markets: MarketRow[];
  storeCurrency: string;
  expiresAt: number;
}

export const MARKET_NOT_FOUND = {
  code: 'MARKET_NOT_FOUND',
  message: 'Market not found',
};
export const MARKET_NOT_LIVE = {
  code: 'MARKET_NOT_LIVE',
  message: 'This market is not live',
};

/**
 * Options of `resolve()`. `preview` is the market-preview host
 * (`<slug>--<key>.<platform host>`): a DRAFT market resolves too, so the
 * storefront READ paths can render it before its domain is connected.
 * Money-writing paths (order create, checkout sessions) never pass it.
 */
export interface ResolveMarketOptions {
  preview?: boolean;
}

@Injectable()
export class MarketsContextService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketsContextService.name);
  private readonly cache = new Map<string, CacheEntry>();
  /** Dedicated LISTEN connection; null when disabled. */
  private listener: PgNotifyListener | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storeApps: StoreAppsService,
    private readonly fx: FxService,
  ) {
    // Platform FX rows feed every cached context, so an admin rate change
    // drops the whole cache (FxService cannot inject this service: cycle).
    this.fx.onRatesChanged(() => this.invalidateAll());
  }

  /**
   * The market context for a request. Null when the app is off. With a key:
   * 404 MARKET_NOT_FOUND for an unknown key, 404 MARKET_NOT_LIVE for a
   * DRAFT market — unless `preview` is set, which lets a DRAFT market
   * through (flagged `preview: true`; the app must still be on and an
   * unknown key is still 404). Without a key: the default market.
   */
  async resolve(
    storeId: string,
    marketKey?: string | null,
    options: ResolveMarketOptions = {},
  ): Promise<MarketContext | null> {
    if (!(await this.storeApps.isEnabled(storeId, 'markets'))) return null;
    const entry = await this.entryOf(storeId);
    if (!entry) return null;
    const key = marketKey?.trim().toLowerCase();
    const preview = options.preview === true && Boolean(key);
    let row: MarketRow | undefined;
    if (key) {
      row = entry.markets.find((m) => m.key === key);
      if (!row) throw new NotFoundException(MARKET_NOT_FOUND);
      if (row.status !== 'LIVE' && !preview) {
        throw new NotFoundException(MARKET_NOT_LIVE);
      }
    } else {
      row = entry.markets.find((m) => m.is_default);
      if (!row) return null;
    }
    return this.toContext(row, entry.storeCurrency, undefined, preview);
  }

  /**
   * The context of a market an order or checkout session already references
   * (`market_id`), whatever its status: a placed order must stay payable and
   * manageable after its market goes back to DRAFT. Null when the app is
   * off or the market is gone.
   */
  async byId(
    storeId: string,
    marketId: string | null | undefined,
  ): Promise<MarketContext | null> {
    if (!marketId) return null;
    if (!(await this.storeApps.isEnabled(storeId, 'markets'))) return null;
    const entry = await this.entryOf(storeId);
    const row = entry?.markets.find((m) => m.id === marketId);
    if (!entry || !row) return null;
    return this.toContext(row, entry.storeCurrency);
  }

  /** Every LIVE market as a public route; null when the app is off. */
  async listLive(storeId: string): Promise<MarketRoute[] | null> {
    if (!(await this.storeApps.isEnabled(storeId, 'markets'))) return null;
    const entry = await this.entryOf(storeId);
    if (!entry) return null;
    const routes: MarketRoute[] = [];
    for (const row of entry.markets) {
      if (row.status !== 'LIVE') continue;
      // One misconfigured market (e.g. its platform FX row was deleted)
      // must not take the whole store's routing / hreflang down: it is
      // listed with no rate — the catalog serves its overrides and checkout
      // reports MARKET_FX_RATE_MISSING as usual.
      const ctx = await this.safeContext(row, entry.storeCurrency);
      // Defensive: a non-default market whose host was deactivated after it
      // went live cannot be reached, so it is not advertised either.
      if (!ctx.isDefault && !ctx.primaryHostname) continue;
      routes.push(toMarketRoute(ctx));
    }
    // Default market first, then creation order.
    routes.sort((a, b) => Number(b.is_default) - Number(a.is_default));
    return routes;
  }

  /**
   * The StoreDomain row for a hostname (any status) with its market and the
   * store's slug/legacy domain — what the proxy resolution reads.
   */
  async byHostname(host: string) {
    return this.prisma.storeDomain.findUnique({
      where: { hostname: host },
      select: {
        id: true,
        store_id: true,
        hostname: true,
        status: true,
        redirect_to: true,
        market: { select: { key: true, status: true } },
        store: {
          select: { slug: true, is_active: true, custom_domain: true },
        },
      },
    });
  }

  onModuleInit(): void {
    if ((process.env.MARKETS_LISTEN ?? '').toLowerCase() === 'off') {
      this.logger.log('Markets LISTEN disabled (MARKETS_LISTEN=off)');
      return;
    }
    this.listener = new PgNotifyListener(MARKETS_CHANNEL, (payload) =>
      this.dropLocal(payload),
    );
    this.listener.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.listener?.stop();
    this.listener = null;
  }

  /**
   * Drop the store's cached markets (called after every mutation), here and
   * on every other instance.
   */
  invalidate(storeId: string): void {
    this.dropLocal(storeId);
    void this.notifyInstances(storeId);
  }

  /** Drop every store's cache (platform FX rates changed), on every instance. */
  invalidateAll(): void {
    this.dropLocal(ALL_STORES);
    void this.notifyInstances(ALL_STORES);
  }

  /** Local drop only: also what a notification from another instance does. */
  private dropLocal(payload: string): void {
    if (payload === ALL_STORES) this.cache.clear();
    else this.cache.delete(payload);
  }

  /** Best effort: on failure other instances catch up within the TTL. */
  private async notifyInstances(payload: string): Promise<void> {
    try {
      await this.prisma
        .$executeRaw`SELECT pg_notify(${MARKETS_CHANNEL}, ${payload})`;
    } catch (err) {
      this.logger.warn(
        `pg_notify(${MARKETS_CHANNEL}) failed for ${payload}; other instances fall back to the ${CACHE_TTL_MS / 1000} s TTL: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** toContext that never throws: a failed rate lookup yields rate null. */
  private async safeContext(
    row: MarketRow,
    storeCurrency: string,
  ): Promise<MarketContext> {
    try {
      return await this.toContext(row, storeCurrency);
    } catch (err) {
      this.logger.warn(
        `Market "${row.key}" (${row.id}) has no usable rate: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return this.toContext(row, storeCurrency, null);
    }
  }

  private async toContext(
    row: MarketRow,
    storeCurrency: string,
    /** When given, used instead of resolving the rate (never throws). */
    fixedRate?: number | null,
    /** Preview resolution (see `resolve`): flags the context. */
    preview = false,
  ): Promise<MarketContext> {
    // The default market is bound to the store currency: a later change of
    // the store (or platform default) is honoured without touching the row.
    const currency = row.is_default
      ? storeCurrency
      : row.currency.toUpperCase();
    const rate = row.is_default
      ? 1
      : fixedRate !== undefined
        ? fixedRate
        : await this.fx.effectiveRate(
            { currency, price_rule: row.price_rule },
            storeCurrency,
          );
    // The canonical host: the ACTIVE primary, else the first ACTIVE host
    // that does not itself redirect elsewhere. A preview context without an
    // ACTIVE host names the configured primary (any status) instead, so the
    // preview pages' canonical points at the market's real future hostname.
    const active = row.domains.filter((d) => d.status === 'ACTIVE');
    const canonical = active.filter((d) => !d.redirect_to);
    let primary: (typeof row.domains)[number] | undefined =
      canonical.find((d) => d.is_primary) ?? canonical[0];
    if (!primary && preview) {
      primary = row.domains.find((d) => d.is_primary && !d.redirect_to);
    }
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      countries: row.countries,
      defaultLocale: row.default_locale,
      locales: row.locales.filter((l) => l !== row.default_locale),
      currency,
      storeCurrency,
      rate,
      priceRule: priceRuleOf(row.price_rule),
      isDefault: row.is_default,
      status: row.status,
      primaryHostname: primary?.hostname ?? null,
      hostnames: active.map((d) => d.hostname),
      ...(preview ? { preview: true as const } : {}),
    };
  }

  private async entryOf(storeId: string): Promise<CacheEntry | null> {
    const now = Date.now();
    const cached = this.cache.get(storeId);
    if (cached && cached.expiresAt > now) return cached;
    try {
      const [store, markets, platform] = await Promise.all([
        this.prisma.store.findUnique({
          where: { id: storeId },
          select: { store_type: true, currency: true },
        }),
        this.prisma.market.findMany({
          where: { store_id: storeId },
          select: marketSelect,
          orderBy: { created_at: 'asc' },
        }),
        this.prisma.platformConfig.findFirst({
          select: { default_currency: true },
        }),
      ]);
      if (!store) return null;
      const entry: CacheEntry = {
        markets,
        storeCurrency: resolveStoreCurrency(store, platform?.default_currency),
        expiresAt: now + CACHE_TTL_MS,
      };
      this.remember(storeId, entry);
      return entry;
    } catch (err) {
      // A DB hiccup degrades to "no market" for this call only, never cached.
      this.logger.warn(
        `Market lookup failed for store ${storeId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  private remember(storeId: string, entry: CacheEntry): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const now = Date.now();
      for (const [key, e] of this.cache) {
        if (e.expiresAt <= now) this.cache.delete(key);
      }
      if (this.cache.size >= CACHE_MAX_ENTRIES) {
        for (const key of this.cache.keys()) {
          this.cache.delete(key);
          break;
        }
      }
    }
    this.cache.set(storeId, entry);
  }
}
