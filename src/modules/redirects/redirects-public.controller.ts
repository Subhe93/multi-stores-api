import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  RedirectsService,
  type RedirectMapResponse,
  type RedirectResolveResponse,
} from './redirects.service';
import { redirectsThrottleLimit } from './redirect-proxy-key';

/**
 * Public redirect lookups for the storefront proxy (M4.4 §6.3). No auth and
 * no @RequireApp: redirects keep working after the importer app is switched
 * off. Only the global throttler guard runs: 120/min per IP, lifted when
 * the web proxy sends `x-proxy-key` matching REDIRECTS_PROXY_KEY (see
 * redirect-proxy-key.ts). The proxy caches the map per `redirects_version`,
 * so `?v=` is just a cache buster.
 */
@Controller('stores')
export class RedirectsPublicController {
  constructor(private readonly redirects: RedirectsService) {}

  @Get(':slug/redirects')
  @Throttle({ default: { limit: redirectsThrottleLimit, ttl: 60_000 } })
  async map(@Param('slug') slug: string): Promise<RedirectMapResponse> {
    const storeId = await this.redirects.publicStoreId(slug);
    return this.redirects.mapFor(storeId);
  }

  @Get(':slug/redirects/resolve')
  @Throttle({ default: { limit: redirectsThrottleLimit, ttl: 60_000 } })
  async resolve(
    @Param('slug') slug: string,
    @Query('path') path?: string,
  ): Promise<RedirectResolveResponse> {
    const storeId = await this.redirects.publicStoreId(slug);
    const hit = path ? await this.redirects.resolve(storeId, path) : null;
    if (!hit) {
      throw new NotFoundException({
        code: 'REDIRECT_NOT_FOUND',
        message: 'No redirect for this path',
      });
    }
    return hit;
  }
}
