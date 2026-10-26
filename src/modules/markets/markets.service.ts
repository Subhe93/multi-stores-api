import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import {
  isSupportedCurrency,
  resolveStoreCurrency,
} from '../../common/money/currency.util';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { DomainsService } from './domains.service';
import { MARKET_FX_RATE_MISSING } from './market-pricing.service';
import { FxService, priceRuleOf } from './fx.service';
import { MarketsContextService } from './markets-context.service';
import { MarketPricingService } from './market-pricing.service';
import {
  PaymentCheckService,
  paymentCheckPasses,
} from './payment-check.service';
import {
  SUPPORTED_LOCALES,
  type MarketView,
  type PaymentCheck,
  type PriceRule,
  type ProductMarketPricesView,
} from './market.types';
import {
  CreateMarketDto,
  UpdateMarketDto,
  UpsertProductMarketPricesDto,
} from './dto/market.dto';
import { resolveMarketPrice, resolveVariantMarketPrice } from './pricing.util';

const DEFAULT_MARKET_KEY = 'default';

const MARKET_NOT_FOUND = {
  code: 'MARKET_NOT_FOUND',
  message: 'Market not found',
};

interface OwnerStore {
  id: string;
  slug: string;
  name: string;
  creator_id: string;
  store_type: string;
  currency: string | null;
}

const marketInclude = {
  domains: { orderBy: { created_at: 'asc' as const } },
} satisfies Prisma.MarketInclude;
type MarketRow = Prisma.MarketGetPayload<{ include: typeof marketInclude }>;

/**
 * Creator-facing market management: CRUD, validation, the default-market
 * rules, product price overrides. Every mutation drops the context cache
 * and revalidates the storefront.
 */
@Injectable()
export class MarketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly revalidation: RevalidationService,
    private readonly storeApps: StoreAppsService,
    private readonly ctx: MarketsContextService,
    private readonly fx: FxService,
    private readonly domains: DomainsService,
    private readonly pricing: MarketPricingService,
    private readonly paymentCheck: PaymentCheckService,
  ) {}

  // ── Default market ────────────────────────────────────────────────────────

  /**
   * Make sure the store has its default market (L8): created from the
   * language config and resolveStoreCurrency when missing — older rows that
   * predate the migration backfill, or a store created while this code was
   * not yet deployed. Idempotent; returns the row.
   */
  async ensureDefaultMarket(storeId: string) {
    const [store, platform] = await Promise.all([
      this.prisma.store.findUnique({
        where: { id: storeId },
        select: {
          name: true,
          store_type: true,
          currency: true,
          language_config: true,
        },
      }),
      this.prisma.platformConfig.findFirst({
        select: { default_currency: true },
      }),
    ]);
    if (!store) throw new NotFoundException(MARKET_NOT_FOUND);
    const storeCurrency = resolveStoreCurrency(
      store,
      platform?.default_currency,
    );
    const existing = await this.prisma.market.findFirst({
      where: { store_id: storeId, is_default: true },
    });
    if (existing) {
      // The runtime reads the store currency live; the stored column is
      // kept honest here so admin tooling and reports see the same value.
      if (existing.currency !== storeCurrency) {
        const synced = await this.prisma.market.update({
          where: { id: existing.id },
          data: { currency: storeCurrency },
        });
        this.ctx.invalidate(storeId);
        return synced;
      }
      return existing;
    }
    const primary = store.language_config?.primary_locale || 'en';
    const row = await this.prisma.market.upsert({
      where: { store_id_key: { store_id: storeId, key: DEFAULT_MARKET_KEY } },
      create: {
        store_id: storeId,
        key: DEFAULT_MARKET_KEY,
        name: store.name,
        countries: [],
        default_locale: primary,
        locales: (store.language_config?.secondary_locales || []).filter(
          (l) => l !== primary,
        ),
        currency: storeCurrency,
        is_default: true,
        status: MarketStatus.LIVE,
        price_rule: { mode: 'convert', source: 'manual', rate: 1 },
      },
      update: {
        is_default: true,
        status: MarketStatus.LIVE,
        currency: storeCurrency,
      },
    });
    this.ctx.invalidate(storeId);
    return row;
  }

  /**
   * Called by StoresService.updateLanguages while the app is OFF: the
   * languages page still owns the locales, so the default market mirrors
   * them. With the app on, the Markets page owns them instead (L8).
   */
  async mirrorLanguagesIntoDefault(
    storeId: string,
    primary: string,
    secondary: string[],
  ): Promise<void> {
    // ensureDefaultMarket also re-syncs the stored currency column.
    await this.ensureDefaultMarket(storeId);
    await this.prisma.market.updateMany({
      where: { store_id: storeId, is_default: true },
      data: {
        default_locale: primary,
        locales: secondary.filter((l) => l !== primary),
      },
    });
    this.ctx.invalidate(storeId);
  }

  // ── Creator CRUD ──────────────────────────────────────────────────────────

  async list(userId: string): Promise<MarketView[]> {
    const store = await this.storeOf(userId);
    await this.ensureDefaultMarket(store.id);
    const rows = await this.prisma.market.findMany({
      where: { store_id: store.id },
      include: marketInclude,
      orderBy: [{ is_default: 'desc' }, { created_at: 'asc' }],
    });
    const storeCurrency = await this.storeCurrencyOf(store);
    return Promise.all(rows.map((r) => this.toView(r, store, storeCurrency)));
  }

  async get(userId: string, marketId: string): Promise<MarketView> {
    const store = await this.storeOf(userId);
    const row = await this.rowOf(store.id, marketId);
    return this.toView(row, store);
  }

  async create(userId: string, dto: CreateMarketDto): Promise<MarketView> {
    const store = await this.storeOf(userId);
    await this.ensureDefaultMarket(store.id);
    const data = this.normalize(dto);
    if (data.key === DEFAULT_MARKET_KEY) {
      throw new ConflictException({
        code: 'MARKET_KEY_TAKEN',
        message: 'This market key is already used',
      });
    }
    await this.assertKeyFree(store.id, data.key as string);
    const check = await this.paymentCheck.checkMarket(store.id, {
      currency: data.currency as string,
      countries: data.countries as string[],
    });
    const row = await this.prisma.market.create({
      data: {
        store_id: store.id,
        key: data.key as string,
        name: data.name as string,
        countries: data.countries as string[],
        default_locale: data.default_locale as string,
        locales: data.locales as string[],
        currency: data.currency as string,
        price_rule: (data.price_rule ??
          priceRuleOf({})) as unknown as Prisma.InputJsonObject,
        payment_check: check as unknown as Prisma.InputJsonObject,
        status: MarketStatus.DRAFT,
        noindex: data.noindex ?? false,
      },
      include: marketInclude,
    });
    await this.afterMutation(store.id);
    return this.toView(row, store);
  }

  async update(
    userId: string,
    marketId: string,
    dto: UpdateMarketDto,
  ): Promise<MarketView> {
    const store = await this.storeOf(userId);
    const row = await this.rowOf(store.id, marketId);
    const data = this.normalize(dto, row);
    if (data.key && data.key !== row.key) {
      if (row.is_default || data.key === DEFAULT_MARKET_KEY) {
        throw new BadRequestException({
          code: 'MARKET_DEFAULT_LOCKED',
          message: 'The default market keeps its key',
        });
      }
      await this.assertKeyFree(store.id, data.key);
    }
    if (row.status === MarketStatus.LIVE && data.countries) {
      await this.assertNoCountryOverlap(store.id, row.id, data.countries);
    }
    const currencyChanged =
      !!data.currency && data.currency !== row.currency.toUpperCase();
    // A new currency or price rule must still yield a usable rate (a
    // `platform` source needs its PlatformFxRate row) — 400 otherwise.
    if (!row.is_default && (currencyChanged || data.price_rule !== undefined)) {
      await this.fx.effectiveRate(
        {
          currency: data.currency ?? row.currency,
          price_rule: data.price_rule ?? row.price_rule,
        },
        await this.storeCurrencyOf(store),
      );
    }
    const check =
      currencyChanged || data.countries
        ? await this.paymentCheck.checkMarket(store.id, {
            id: row.id,
            currency: (data.currency as string) ?? row.currency,
            countries: (data.countries as string[]) ?? row.countries,
          })
        : undefined;
    // A LIVE market keeps its values when the re-run check fails: the
    // result is stored for the dashboard, the change is refused. A DRAFT
    // market accepts the change (it cannot go live until the check passes).
    if (
      check &&
      row.status === MarketStatus.LIVE &&
      !paymentCheckPasses(check)
    ) {
      await this.prisma.market.update({
        where: { id: row.id },
        data: { payment_check: check as unknown as Prisma.InputJsonObject },
      });
      await this.afterMutation(store.id);
      throw new BadRequestException({
        code: 'MARKET_PAYMENT_CHECK_FAILED',
        message:
          'No payment provider can charge this currency for these countries. The market keeps its current settings.',
      });
    }

    const updated = await this.prisma.market.update({
      where: { id: row.id },
      data: {
        ...(data.key !== undefined ? { key: data.key } : {}),
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.countries !== undefined ? { countries: data.countries } : {}),
        ...(data.default_locale !== undefined
          ? { default_locale: data.default_locale }
          : {}),
        ...(data.locales !== undefined ? { locales: data.locales } : {}),
        ...(data.currency !== undefined ? { currency: data.currency } : {}),
        ...(data.price_rule !== undefined
          ? {
              price_rule: data.price_rule as unknown as Prisma.InputJsonObject,
            }
          : {}),
        ...(data.noindex !== undefined ? { noindex: data.noindex } : {}),
        ...(check
          ? { payment_check: check as unknown as Prisma.InputJsonObject }
          : {}),
      },
      include: marketInclude,
    });

    // The default market IS the store: its currency is Store.currency and
    // its locales are the store's language config, so the legacy readers
    // (orders, mail, non-market storefront paths) keep seeing one truth.
    if (row.is_default) {
      if (currencyChanged) {
        await this.prisma.store.update({
          where: { id: store.id },
          data: { currency: updated.currency },
        });
      }
      if (data.default_locale !== undefined || data.locales !== undefined) {
        await this.prisma.storeLanguageConfig.upsert({
          where: { store_id: store.id },
          update: {
            primary_locale: updated.default_locale,
            secondary_locales: updated.locales,
          },
          create: {
            store_id: store.id,
            primary_locale: updated.default_locale,
            secondary_locales: updated.locales,
          },
        });
      }
    }
    await this.afterMutation(store.id);
    return this.toView(updated, store);
  }

  /**
   * DRAFT ↔ LIVE. The default market is always LIVE. Going LIVE re-runs the
   * payment check and needs at least one provider `ok`, plus no country in
   * another LIVE market.
   */
  async setStatus(
    userId: string,
    marketId: string,
    status: MarketStatus,
  ): Promise<MarketView> {
    const store = await this.storeOf(userId);
    const row = await this.rowOf(store.id, marketId);
    if (row.is_default && status !== MarketStatus.LIVE) {
      throw new BadRequestException({
        code: 'MARKET_DEFAULT_LOCKED',
        message: 'The default market is always live',
      });
    }
    let check: PaymentCheck | undefined;
    if (status === MarketStatus.LIVE && !row.is_default) {
      await this.assertNoCountryOverlap(store.id, row.id, row.countries);
      // A live market is reached through its own hostname: without an
      // ACTIVE, non-redirecting host nothing could serve it, and it must
      // never be advertised in `markets` / hreflang.
      if (!row.domains.some((d) => d.status === 'ACTIVE' && !d.redirect_to)) {
        throw new BadRequestException({
          code: 'MARKET_PRIMARY_DOMAIN_REQUIRED',
          message:
            'Add a hostname to this market and have it activated before setting the market live.',
        });
      }
      // Live prices need a rate: `convert` without one throws here, and a
      // `fixed` rule without a rate cannot convert shipping / coupons.
      const rate = await this.fx.effectiveRate(
        row,
        await this.storeCurrencyOf(store),
      );
      if (rate == null) throw new BadRequestException(MARKET_FX_RATE_MISSING);
      check = await this.paymentCheck.checkMarket(store.id, {
        id: row.id,
        currency: row.currency,
        countries: row.countries,
      });
      if (!paymentCheckPasses(check)) {
        await this.prisma.market.update({
          where: { id: row.id },
          data: { payment_check: check as unknown as Prisma.InputJsonObject },
        });
        throw new BadRequestException({
          code: 'MARKET_PAYMENT_CHECK_FAILED',
          message:
            'No payment provider can charge this currency yet. Fix the payment setup and re-run the check.',
        });
      }
    }
    const updated = await this.prisma.market.update({
      where: { id: row.id },
      data: {
        status,
        ...(check
          ? { payment_check: check as unknown as Prisma.InputJsonObject }
          : {}),
      },
      include: marketInclude,
    });
    await this.afterMutation(store.id);
    return this.toView(updated, store);
  }

  async delete(userId: string, marketId: string) {
    const store = await this.storeOf(userId);
    const row = await this.rowOf(store.id, marketId);
    if (row.is_default) {
      throw new BadRequestException({
        code: 'MARKET_DEFAULT_UNDELETABLE',
        message: 'The default market cannot be deleted',
      });
    }
    // Orders keep their history: Order.market_id is SET NULL by the FK.
    await this.prisma.market.delete({ where: { id: row.id } });
    await this.afterMutation(store.id);
    return { deleted: true };
  }

  async runPaymentCheck(
    userId: string,
    marketId: string,
  ): Promise<PaymentCheck> {
    const store = await this.storeOf(userId);
    const row = await this.rowOf(store.id, marketId);
    const check = await this.paymentCheck.checkMarket(store.id, {
      id: row.id,
      currency: row.currency,
      countries: row.countries,
    });
    await this.prisma.market.update({
      where: { id: row.id },
      data: { payment_check: check as unknown as Prisma.InputJsonObject },
    });
    await this.afterMutation(store.id);
    return check;
  }

  async fxPreview(from: string, to: string) {
    if (!isSupportedCurrency(from) || !isSupportedCurrency(to)) {
      throw new BadRequestException({
        code: 'MARKET_CURRENCY_UNSUPPORTED',
        message: 'Unsupported currency',
      });
    }
    const rate = await this.fx.getRate(from, to);
    return rate == null
      ? { rate: null, source: 'none' as const }
      : { rate, source: 'platform' as const };
  }

  // ── Domains (ownership resolved here, work done by DomainsService) ────────

  async addDomain(
    userId: string,
    marketId: string,
    dto: { hostname: string; redirect_to?: string | null },
  ) {
    const store = await this.storeOf(userId);
    const row = await this.rowOf(store.id, marketId);
    return this.domains.add(store.id, row.id, dto);
  }

  async removeDomain(userId: string, marketId: string, domainId: string) {
    const store = await this.storeOf(userId);
    const row = await this.rowOf(store.id, marketId);
    return this.domains.remove(store.id, row.id, domainId);
  }

  async verifyDomain(userId: string, marketId: string, domainId: string) {
    const store = await this.storeOf(userId);
    const row = await this.rowOf(store.id, marketId);
    return this.domains.verify(store.id, row.id, domainId);
  }

  async setPrimaryDomain(userId: string, marketId: string, domainId: string) {
    const store = await this.storeOf(userId);
    const row = await this.rowOf(store.id, marketId);
    return this.domains.setPrimary(store.id, row.id, domainId);
  }

  // ── Product prices per market ─────────────────────────────────────────────

  async getProductPrices(
    userId: string,
    productId: string,
  ): Promise<ProductMarketPricesView> {
    const store = await this.storeOf(userId);
    const product = await this.ownProduct(store, productId);
    await this.ensureDefaultMarket(store.id);
    const markets = await this.prisma.market.findMany({
      where: { store_id: store.id, is_default: false },
      orderBy: { created_at: 'asc' },
    });
    const baseCurrency = await this.storeCurrencyOf(store);
    const basePrice = Number(product.base_price);
    const out: ProductMarketPricesView = {
      base_currency: baseCurrency,
      markets: [],
    };
    // Every market's override rows for this product in one query.
    const rowsByMarket = await this.pricing.loadPricesForProduct(
      product.id,
      markets.map((m) => m.id),
    );
    for (const m of markets) {
      const rows = rowsByMarket.get(m.id);
      let rate: number | null = null;
      try {
        rate = await this.fx.effectiveRate(m, baseCurrency);
      } catch {
        rate = null;
      }
      const pctx = {
        currency: m.currency.toUpperCase(),
        rate,
        rounding: priceRuleOf(m.price_rule).rounding,
      };
      out.markets.push({
        market_id: m.id,
        key: m.key,
        name: m.name,
        currency: m.currency.toUpperCase(),
        rate,
        available: rows?.product?.available ?? true,
        auto_price: resolveMarketPrice({
          basePrice,
          override: null,
          ctx: pctx,
        }),
        override: rows?.product?.price ?? null,
        compare_at_auto: product.compare_at_price
          ? resolveMarketPrice({
              basePrice: Number(product.compare_at_price),
              override: null,
              ctx: pctx,
            })
          : null,
        compare_at_override: rows?.product?.compare_at_price ?? null,
        variants: product.variants.map((v) => ({
          variant_id: v.id,
          label: variantLabel(v.options),
          auto_price: resolveVariantMarketPrice({
            basePrice,
            adjustment: Number(v.price_adjustment || 0),
            productOverride: rows?.product?.price,
            variantOverride: null,
            ctx: pctx,
          }),
          override: rows?.variants.get(v.id)?.price ?? null,
        })),
      });
    }
    return out;
  }

  async putProductPrices(
    userId: string,
    productId: string,
    dto: UpsertProductMarketPricesDto,
  ): Promise<ProductMarketPricesView> {
    const store = await this.storeOf(userId);
    const product = await this.ownProduct(store, productId);
    const variantIds = new Set(product.variants.map((v) => v.id));
    const marketIds = new Set(
      (
        await this.prisma.market.findMany({
          where: { store_id: store.id, is_default: false },
          select: { id: true },
        })
      ).map((m) => m.id),
    );
    for (const entry of dto.markets) {
      if (!marketIds.has(entry.market_id)) {
        throw new NotFoundException(MARKET_NOT_FOUND);
      }
    }
    // All-or-nothing: a half-written set of overrides would price the
    // product inconsistently across markets.
    await this.prisma.$transaction(async (tx) => {
      for (const entry of dto.markets) {
        await tx.productMarketPrice.deleteMany({
          where: { market_id: entry.market_id, product_id: product.id },
        });
        const noOverride =
          entry.price == null &&
          entry.compare_at_price == null &&
          (entry.available ?? true) === true;
        if (!noOverride) {
          await tx.productMarketPrice.create({
            data: {
              market_id: entry.market_id,
              product_id: product.id,
              variant_id: null,
              price: entry.price ?? null,
              compare_at_price: entry.compare_at_price ?? null,
              available: entry.available ?? true,
            },
          });
        }
        for (const v of entry.variants ?? []) {
          if (!variantIds.has(v.variant_id) || v.price == null) continue;
          await tx.productMarketPrice.create({
            data: {
              market_id: entry.market_id,
              product_id: product.id,
              variant_id: v.variant_id,
              price: v.price,
            },
          });
        }
      }
    });
    await this.afterMutation(store.id);
    return this.getProductPrices(userId, productId);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async storeOf(userId: string): Promise<OwnerStore> {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: {
        store: {
          select: {
            id: true,
            slug: true,
            name: true,
            creator_id: true,
            store_type: true,
            currency: true,
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
    return creator.store;
  }

  private async rowOf(storeId: string, marketId: string): Promise<MarketRow> {
    const row = await this.prisma.market.findFirst({
      where: { id: marketId, store_id: storeId },
      include: marketInclude,
    });
    if (!row) throw new NotFoundException(MARKET_NOT_FOUND);
    return row;
  }

  private async ownProduct(store: OwnerStore, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, creator_id: store.creator_id },
      select: {
        id: true,
        base_price: true,
        compare_at_price: true,
        variants: {
          where: { is_active: true },
          select: { id: true, price_adjustment: true, options: true },
        },
      },
    });
    if (!product) {
      throw new NotFoundException({
        code: 'MARKET_PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });
    }
    return product;
  }

  private async assertKeyFree(storeId: string, key: string): Promise<void> {
    const taken = await this.prisma.market.findUnique({
      where: { store_id_key: { store_id: storeId, key } },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException({
        code: 'MARKET_KEY_TAKEN',
        message: 'This market key is already used',
      });
    }
  }

  /** A country may belong to one LIVE market only. */
  private async assertNoCountryOverlap(
    storeId: string,
    marketId: string,
    countries: string[],
  ): Promise<void> {
    if (!countries.length) return;
    const other = await this.prisma.market.findFirst({
      where: {
        store_id: storeId,
        id: { not: marketId },
        status: MarketStatus.LIVE,
        countries: { hasSome: countries },
      },
      select: { key: true, countries: true },
    });
    if (other) {
      const clash = countries.filter((c) => other.countries.includes(c));
      throw new BadRequestException({
        code: 'MARKET_COUNTRY_OVERLAP',
        message: `${clash.join(', ')} already belongs to the live market "${other.key}".`,
      });
    }
  }

  /**
   * Normalise and validate the writable fields: upper-case countries and
   * currency, lower-case locales, the default locale never in `locales`,
   * every locale supported by the storefront, a supported currency, and a
   * well-formed price rule.
   */
  private normalize(
    dto: CreateMarketDto | UpdateMarketDto,
    current?: MarketRow,
  ): Partial<{
    key: string;
    name: string;
    countries: string[];
    default_locale: string;
    locales: string[];
    currency: string;
    price_rule: PriceRule;
    noindex: boolean;
  }> {
    const out: ReturnType<MarketsService['normalize']> = {};
    if (dto.noindex !== undefined) out.noindex = dto.noindex === true;
    if (dto.key !== undefined) out.key = dto.key.trim().toLowerCase();
    if (dto.name !== undefined) out.name = dto.name.trim();
    if (dto.countries !== undefined) {
      out.countries = Array.from(
        new Set(dto.countries.map((c) => c.trim().toUpperCase())),
      );
    }
    const defaultLocale =
      dto.default_locale !== undefined
        ? dto.default_locale.trim().toLowerCase()
        : current?.default_locale;
    if (dto.default_locale !== undefined) out.default_locale = defaultLocale;
    const locales =
      dto.locales !== undefined
        ? Array.from(new Set(dto.locales.map((l) => l.trim().toLowerCase())))
        : current?.locales;
    if (dto.locales !== undefined) out.locales = locales;
    for (const l of [defaultLocale, ...(locales ?? [])]) {
      if (l && !(SUPPORTED_LOCALES as readonly string[]).includes(l)) {
        throw new BadRequestException({
          code: 'MARKET_LOCALE_UNSUPPORTED',
          message: `Locale "${l}" is not supported by the storefront`,
        });
      }
    }
    if (defaultLocale && locales?.includes(defaultLocale)) {
      throw new BadRequestException({
        code: 'MARKET_DEFAULT_LOCALE_IN_LOCALES',
        message: 'The default locale must not be listed in locales',
      });
    }
    if (dto.currency !== undefined) {
      const c = dto.currency.trim().toUpperCase();
      if (!isSupportedCurrency(c)) {
        throw new BadRequestException({
          code: 'MARKET_CURRENCY_UNSUPPORTED',
          message: `Currency "${c}" is not supported`,
        });
      }
      out.currency = c;
    }
    if (dto.price_rule !== undefined) {
      const rule = priceRuleOf(dto.price_rule);
      if (
        rule.mode === 'convert' &&
        rule.source === 'manual' &&
        !(Number(rule.rate) > 0)
      ) {
        throw new BadRequestException({
          code: 'MARKET_FX_RATE_MISSING',
          message: 'A manual conversion rule needs a rate greater than 0',
        });
      }
      out.price_rule = rule;
    }
    return out;
  }

  /** resolveStoreCurrency(store) with the platform default read once. */
  private async storeCurrencyOf(store: OwnerStore): Promise<string> {
    const platform = await this.prisma.platformConfig.findFirst({
      select: { default_currency: true },
    });
    return resolveStoreCurrency(store, platform?.default_currency);
  }

  private async toView(
    row: MarketRow,
    store: OwnerStore,
    storeCurrency?: string,
  ): Promise<MarketView> {
    storeCurrency ??= await this.storeCurrencyOf(store);
    let effectiveRate: number | null = null;
    try {
      effectiveRate = row.is_default
        ? 1
        : await this.fx.effectiveRate(row, storeCurrency);
    } catch {
      effectiveRate = null;
    }
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      countries: row.countries,
      default_locale: row.default_locale,
      locales: row.locales,
      currency: row.is_default ? storeCurrency : row.currency.toUpperCase(),
      is_default: row.is_default,
      status: row.status,
      noindex: row.noindex,
      price_rule: priceRuleOf(row.price_rule),
      payment_check: (row.payment_check as PaymentCheck | null) ?? null,
      effective_rate: effectiveRate,
      domains: row.domains.map((d) => this.domains.toView(d, null, store.slug)),
      platform_hostname: this.platformHostname(store.slug),
      preview_url: row.is_default ? null : this.previewUrl(store.slug, row.key),
    };
  }

  private platformHostname(slug: string): string {
    const base =
      this.config.get<string>('STOREFRONT_URL') || 'http://localhost:3003';
    try {
      return `${slug}.${new URL(base).host}`;
    } catch {
      return `${slug}.localhost:3003`;
    }
  }

  /**
   * Market-preview URL: `<slug>--<key>` as ONE label under the platform
   * host, so the existing wildcard DNS record and certificate cover it.
   * The storefront proxy resolves it with `market-context?preview=1`.
   */
  private previewUrl(slug: string, key: string): string {
    const base =
      this.config.get<string>('STOREFRONT_URL') || 'http://localhost:3003';
    try {
      const url = new URL(base);
      return `${url.protocol}//${slug}--${key}.${url.host}`;
    } catch {
      return `http://${slug}--${key}.localhost:3003`;
    }
  }

  private async afterMutation(storeId: string): Promise<void> {
    this.ctx.invalidate(storeId);
    await this.revalidation.revalidateStoreById(storeId);
  }
}

function variantLabel(options: unknown): string {
  if (!options || typeof options !== 'object') return '';
  return Object.entries(options as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(' / ');
}
