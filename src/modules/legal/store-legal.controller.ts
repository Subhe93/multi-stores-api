import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import { isPreview } from '../markets/preview-query';
import {
  StorefrontViewerGuard,
  Viewer,
  type StorefrontViewer,
} from '../storefront/storefront-gate.service';
import { StoreLegalService } from './store-legal.service';

/**
 * Public store legal pages (plans/store-legal-pages/SPEC.md). Same rules as
 * the other storefront reads: fetched server-side by the Next.js storefront
 * (one IP, so no per-IP throttle), owner preview of a non-LIVE store via
 * StorefrontViewerGuard, `?market=` / `?preview=1` as GET /storefront/:slug.
 */
@SkipThrottle()
@UseGuards(StorefrontViewerGuard)
@Controller('storefront')
export class StoreLegalStorefrontController {
  constructor(private readonly storeLegal: StoreLegalService) {}

  @Get(':storeSlug/legal')
  list(
    @Viewer() viewer: StorefrontViewer | null,
    @Param('storeSlug') storeSlug: string,
    @Query('locale') locale?: string,
    @Query('market') market?: string,
    @Query('preview') preview?: string,
  ) {
    return this.storeLegal.storefrontList(storeSlug, {
      locale,
      market,
      preview: isPreview(preview),
      viewer,
    });
  }

  @Get(':storeSlug/legal/:slug')
  page(
    @Viewer() viewer: StorefrontViewer | null,
    @Param('storeSlug') storeSlug: string,
    @Param('slug') slug: string,
    @Query('locale') locale?: string,
    @Query('market') market?: string,
    @Query('preview') preview?: string,
  ) {
    return this.storeLegal.storefrontPage(storeSlug, slug, {
      locale,
      market,
      preview: isPreview(preview),
      viewer,
    });
  }
}

/** Creator: the legal pages of the own store. */
@Controller('stores/my/legal-pages')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR)
export class StoreLegalCreatorController {
  constructor(private readonly storeLegal: StoreLegalService) {}

  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.storeLegal.creatorList(userId);
  }

  @Post(':slug/from-template')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  fromTemplate(@CurrentUser('id') userId: string, @Param('slug') slug: string) {
    return this.storeLegal.createFromTemplate(userId, slug);
  }
}
