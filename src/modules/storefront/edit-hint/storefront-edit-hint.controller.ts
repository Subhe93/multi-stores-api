import { Controller, Get, Header, Headers, Param, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { StorefrontEditTargetService } from './storefront-edit-target.service';
import type { EditTargetResponse } from './storefront-path';

/** The bearer value of an Authorization header, or null. */
export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? '');
  return match ? match[1] : null;
}

/**
 * Owner "Edit" button of the storefront. Unlike the catalogue reads in
 * StorefrontController (server-side, one IP, so unthrottled) this one is
 * called by the store owner's BROWSER, so it keeps a per-IP limit. The
 * edit-hint token travels in the Authorization header, never in the URL,
 * so it never reaches the request log.
 */
@Controller('storefront')
export class StorefrontEditHintController {
  constructor(private readonly editTargets: StorefrontEditTargetService) {}

  // GET /storefront/:slug/edit-target?path=/products/x
  // 200 { edit_url, label_kind } | 401 when the token is not the owner's.
  @Get(':slug/edit-target')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Header('Cache-Control', 'private, no-store')
  getEditTarget(
    @Param('slug') slug: string,
    @Query('path') path: string | undefined,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<EditTargetResponse> {
    return this.editTargets.resolve(slug, bearerToken(authorization), path);
  }
}
