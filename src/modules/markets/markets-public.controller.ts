import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketsContextService } from './markets-context.service';
import { toMarketRoute } from './market-context';
import type { MarketContextResponse } from './market.types';
import { RedirectsService } from '../redirects/redirects.service';
import { StorefrontGateService } from '../storefront/storefront-gate.service';

// Public resolution used by the storefront proxy for platform-subdomain
// hosts. Deliberately NOT decorated with @RequireApp: it answers
// `{enabled:false}` itself so the proxy can fail-open to the legacy path.
@Controller('stores')
export class MarketsPublicController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly markets: MarketsContextService,
    private readonly redirects: RedirectsService,
    private readonly gate: StorefrontGateService,
  ) {}

  // `?market=<key>&preview=1` (market-preview host `<slug>--<key>.<platform
  // host>`): the named market answers even while DRAFT, flagged `preview`.
  // The param pair is only honoured together; a bare `market` is ignored.
  // No route-level guard here (the global ThrottlerGuard must run once):
  // the optional viewer is resolved inline.
  @Get(':slug/market-context')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async marketContext(
    @Req() req: Request,
    @Param('slug') slug: string,
    @Query('market') market?: string,
    @Query('preview') preview?: string,
  ): Promise<MarketContextResponse> {
    const store = await this.prisma.store.findUnique({
      where: { slug },
      select: { id: true, status: true, custom_domain: true },
    });
    // Non-LIVE: 404 unless the owner / an admin previews (SPEC §3).
    const viewer = await this.gate.viewerFromRequest(req);
    if (!store || !(await this.gate.allows(store, viewer))) {
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
      // M6.1: public host of a default market without a StoreDomain row.
      custom_domain: store.custom_domain ?? null,
      ...extra,
      ...(previewKey ? { preview: true as const } : {}),
    };
  }
}
