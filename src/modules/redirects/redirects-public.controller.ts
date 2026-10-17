import {
  Controller,
  Get,
  Headers,
  HttpStatus,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
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

  /**
   * The map is versioned: `ETag: "<version>"` and a 304 on a matching
   * `If-None-Match` spare the proxy the body when nothing changed;
   * `Cache-Control: public, max-age=60` matches the service's version TTL.
   * A store without redirects has no version and is not cached by ETag.
   */
  @Get(':slug/redirects')
  @Throttle({ default: { limit: redirectsThrottleLimit, ttl: 60_000 } })
  async map(
    @Param('slug') slug: string,
    @Headers('if-none-match') ifNoneMatch?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<RedirectMapResponse | undefined> {
    const storeId = await this.redirects.publicStoreId(slug);
    const body = await this.redirects.mapFor(storeId);
    res?.setHeader('Cache-Control', 'public, max-age=60');
    if (body.version) {
      const etag = `"${body.version}"`;
      res?.setHeader('ETag', etag);
      if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) {
        res?.status(HttpStatus.NOT_MODIFIED);
        return undefined;
      }
    }
    return body;
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

/** `If-None-Match` may list several tags, weak (`W/"x"`) or strong, or `*`. */
export function etagMatches(header: string, etag: string): boolean {
  const wanted = etag.replace(/^W\//, '');
  return header
    .split(',')
    .map((t) => t.trim())
    .some((t) => t === '*' || t.replace(/^W\//, '') === wanted);
}
