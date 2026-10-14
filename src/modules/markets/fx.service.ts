import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveStoreCurrency } from '../../common/money/currency.util';
import type { PriceRule } from './market.types';

/**
 * Base→market exchange rates. The platform table (PlatformFxRate) is
 * admin-maintained; a market may instead carry its own manual rate in its
 * price rule. Rates are never cached here — MarketsContextService caches
 * the resolved context per store.
 */
@Injectable()
export class FxService {
  // Called after every admin rate change (MarketsContextService drops its
  // cache). A callback instead of an injection: the context service
  // already depends on this one.
  private readonly listeners: (() => void)[] = [];

  constructor(private readonly prisma: PrismaService) {}

  onRatesChanged(listener: () => void): void {
    this.listeners.push(listener);
  }

  private ratesChanged(): void {
    for (const l of this.listeners) l();
  }

  /** Platform rate base→quote; the inverse row is used when only it exists. */
  async getRate(base: string, quote: string): Promise<number | null> {
    const b = base.toUpperCase();
    const q = quote.toUpperCase();
    if (b === q) return 1;
    const direct = await this.prisma.platformFxRate.findUnique({
      where: { base_quote: { base: b, quote: q } },
      select: { rate: true },
    });
    if (direct) return Number(direct.rate);
    const inverse = await this.prisma.platformFxRate.findUnique({
      where: { base_quote: { base: q, quote: b } },
      select: { rate: true },
    });
    if (inverse && Number(inverse.rate) > 0) return 1 / Number(inverse.rate);
    return null;
  }

  /**
   * The rate a market converts base prices with. 1 when the market prices in
   * the store currency. `convert` mode requires a rate (manual or platform)
   * and throws MARKET_FX_RATE_MISSING without one; `fixed` mode returns null
   * instead, since products are expected to carry overrides.
   */
  async effectiveRate(
    market: { currency: string; price_rule: unknown },
    storeCurrency: string,
  ): Promise<number | null> {
    const currency = market.currency.toUpperCase();
    if (currency === storeCurrency.toUpperCase()) return 1;
    const rule = priceRuleOf(market.price_rule);
    let rate: number | null = null;
    if (rule.source === 'platform') {
      rate = await this.getRate(storeCurrency, currency);
    } else {
      const manual = Number(rule.rate);
      rate = Number.isFinite(manual) && manual > 0 ? manual : null;
    }
    if (rate == null && rule.mode !== 'fixed') {
      throw new BadRequestException({
        code: 'MARKET_FX_RATE_MISSING',
        message: `No exchange rate from ${storeCurrency} to ${currency} is configured for this market.`,
      });
    }
    return rate;
  }

  /** Every platform rate row (admin view). */
  async listRates() {
    const rows = await this.prisma.platformFxRate.findMany({
      orderBy: [{ base: 'asc' }, { quote: 'asc' }],
    });
    return rows.map((r) => ({
      base: r.base,
      quote: r.quote,
      rate: Number(r.rate),
      updated_at: r.updated_at,
    }));
  }

  /** Upsert platform rates (admin). */
  async upsertRates(rates: { base: string; quote: string; rate: number }[]) {
    for (const r of rates) {
      const base = r.base.toUpperCase();
      const quote = r.quote.toUpperCase();
      await this.prisma.platformFxRate.upsert({
        where: { base_quote: { base, quote } },
        create: { base, quote, rate: r.rate },
        update: { rate: r.rate },
      });
    }
    this.ratesChanged();
    return this.listRates();
  }

  /** Remove one platform rate (admin); 404 FX_RATE_NOT_FOUND when missing. */
  async deleteRate(base: string, quote: string) {
    const b = base.toUpperCase();
    const q = quote.toUpperCase();
    const row = await this.prisma.platformFxRate.findUnique({
      where: { base_quote: { base: b, quote: q } },
      select: { id: true },
    });
    if (!row) {
      throw new NotFoundException({
        code: 'FX_RATE_NOT_FOUND',
        message: `No platform rate from ${b} to ${q}`,
      });
    }
    const users = await this.liveMarketsUsing(b, q);
    if (users.length) {
      throw new ConflictException({
        code: 'FX_RATE_IN_USE',
        message: `Live markets still convert through ${b}/${q}: ${users.join(', ')}. Set them to draft or give them a manual rate first.`,
      });
    }
    await this.prisma.platformFxRate.delete({ where: { id: row.id } });
    this.ratesChanged();
    return this.listRates();
  }

  /**
   * "store slug/market key" of every LIVE market whose platform-sourced
   * rate resolves through the base/quote pair (directly or inversely).
   */
  private async liveMarketsUsing(base: string, quote: string) {
    const [markets, platform] = await Promise.all([
      this.prisma.market.findMany({
        where: { status: 'LIVE', is_default: false },
        select: {
          key: true,
          currency: true,
          price_rule: true,
          store: { select: { slug: true, store_type: true, currency: true } },
        },
      }),
      this.prisma.platformConfig.findFirst({
        select: { default_currency: true },
      }),
    ]);
    const out: string[] = [];
    for (const m of markets) {
      if (priceRuleOf(m.price_rule).source !== 'platform') continue;
      const from = resolveStoreCurrency(m.store, platform?.default_currency);
      const to = m.currency.toUpperCase();
      if ((from === base && to === quote) || (from === quote && to === base)) {
        out.push(`${m.store.slug}/${m.key}`);
      }
    }
    return out;
  }
}

/** Normalised price rule from the Json column (`{}` → convert/manual). */
export function priceRuleOf(raw: unknown): PriceRule {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<PriceRule>;
  return {
    mode: r.mode === 'fixed' ? 'fixed' : 'convert',
    source: r.source === 'platform' ? 'platform' : 'manual',
    ...(r.rate != null ? { rate: Number(r.rate) } : {}),
    ...(r.rounding && typeof r.rounding === 'object'
      ? { rounding: r.rounding }
      : {}),
  };
}
