import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketsContextService } from './markets-context.service';
import { toMarketRoute } from './market-context';
import type { MarketContextResponse } from './market.types';
import { RedirectsService } from '../redirects/redirects.service';

// Public resolution used by the storefront proxy for platform-subdomain
// hosts. Deliberately NOT decorated with @RequireApp: it answers
// `{enabled:false}` itself so the proxy can fail-open to the legacy path.
@Controller('stores')
export class MarketsPublicController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly markets: MarketsContextService,
    private readonly redirects: RedirectsService,
  ) {}

  // `?market=<key>&preview=1` (market-preview host `<slug>--<key>.<platform
  // host>`): the named market answers even while DRAFT, flagged `preview`.
  // The param pair is only honoured together; a bare `market` is ignored.
  @Get(':slug/market-context')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async marketContext(
    @Param('slug') slug: string,
    @Query('market') market?: string,
    @Query('preview') preview?: string,
  ): Promise<MarketContextResponse> {
    const store = await this.prisma.store.findUnique({
      where: { slug },
      select: { id: true, is_active: true },
    });
    if (!store || !store.is_active) {
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    }
    // M4.4 D17: `redirects_version` only for stores with active redirects
    // (cached lookup), in both forms; other answers are unchanged.
    const version = await this.redirects.versionFor(store.id);
    const extra = version ? { redirects_version: version } : {};
    const previewKey = preview === '1' && market ? market : null;
    const ctx = previewKey
      ? await this.markets.resolve(store.id, previewKey, { preview: true })
      : await this.markets.resolve(store.id);
    if (!ctx) return { enabled: false, ...extra };
    const markets = (await this.markets.listLive(store.id)) ?? [];
    return {
      enabled: true,
      market: toMarketRoute(ctx),
      markets,
      ...extra,
      ...(previewKey ? { preview: true as const } : {}),
    };
  }
}
