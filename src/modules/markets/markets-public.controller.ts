import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketsContextService } from './markets-context.service';
import { toMarketRoute } from './market-context';
import type { MarketContextResponse } from './market.types';

// Public resolution used by the storefront proxy for platform-subdomain
// hosts. Deliberately NOT decorated with @RequireApp: it answers
// `{enabled:false}` itself so the proxy can fail-open to the legacy path.
@Controller('stores')
export class MarketsPublicController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly markets: MarketsContextService,
  ) {}

  @Get(':slug/market-context')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async marketContext(
    @Param('slug') slug: string,
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
    const ctx = await this.markets.resolve(store.id);
    if (!ctx) return { enabled: false };
    const markets = (await this.markets.listLive(store.id)) ?? [];
    return { enabled: true, market: toMarketRoute(ctx), markets };
  }
}
