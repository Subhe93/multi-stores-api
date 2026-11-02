import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AuthGuard } from '@nestjs/passport';
import { StorefrontService } from './storefront.service';
import { isPreview } from '../markets/preview-query';
import { CurrentUser, type RequestUser } from '../../common/decorators';
import {
  StorefrontViewerGuard,
  Viewer,
  type StorefrontViewer,
} from './storefront-gate.service';

// Read-only public catalogue data, fetched server-side by the Next.js
// storefront — every request arrives from that one server IP, so a per-IP
// rate limit here would throttle the whole shop rather than any one visitor.
// Owner preview (SPEC §3): StorefrontViewerGuard resolves an optional
// bearer token into `@Viewer()` (never rejects); a non-LIVE store is served
// to its owner / an admin and closed to everyone else.
@SkipThrottle()
@UseGuards(StorefrontViewerGuard)
@Controller('storefront')
export class StorefrontController {
  constructor(private storefrontService: StorefrontService) {}

  // Public platform metadata (name, …) — the single source every app inherits
  // the platform name from. Declared BEFORE the :slug route so the literal
  // path wins the match.
  @Get('platform-meta')
  getPlatformMeta() {
    return this.storefrontService.getPlatformMeta();
  }

  // ?market= (markets app): the market key the proxy resolved for the host.
  // ?preview=1 (market-preview host): the market may still be DRAFT.
  @Get(':slug')
  getStore(
    @Viewer() viewer: StorefrontViewer | null,
    @Param('slug') slug: string,
    @Query('market') market?: string,
    @Query('preview') preview?: string,
  ) {
    return this.storefrontService.getStore(
      slug,
      market,
      isPreview(preview),
      viewer,
    );
  }

  // Owner preview (SPEC §3): the full store payload regardless of status,
  // for the store owner's JWT or an admin. Lets the web render a DRAFT
  // store for its owner while the public sees "coming soon".
  @Get(':slug/preview')
  @UseGuards(AuthGuard('jwt'))
  preview(
    @CurrentUser() user: RequestUser,
    @Param('slug') slug: string,
    @Query('market') market?: string,
  ) {
    return this.storefrontService.ownerPreview(slug, user, market);
  }

  // Tiny endpoint the storefront reads to decide whether to cache this store.
  @Get(':slug/cache-config')
  getCacheConfig(@Param('slug') slug: string) {
    return this.storefrontService.getCacheConfig(slug);
  }

  @Get(':slug/products')
  getProducts(
    @Viewer() viewer: StorefrontViewer | null,
    @Param('slug') slug: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('category_id') category_id?: string,
    @Query('creator_category') creator_category?: string,
    @Query('creator_category_id') creator_category_id?: string,
    @Query('search') search?: string,
    @Query('locale') locale?: string,
    @Query('market') market?: string,
    @Query('preview') preview?: string,
  ) {
    return this.storefrontService.getProducts(
      slug,
      {
        page: page ? +page : undefined,
        limit: limit ? +limit : undefined,
        category_id,
        creator_category,
        creator_category_id,
        search,
        locale,
      },
      market,
      isPreview(preview),
      viewer,
    );
  }

  @Get(':slug/products/:productSlug')
  getProduct(
    @Viewer() viewer: StorefrontViewer | null,
    @Param('slug') slug: string,
    @Param('productSlug') productSlug: string,
    @Query('locale') locale?: string,
    @Query('market') market?: string,
    @Query('preview') preview?: string,
  ) {
    return this.storefrontService.getProduct(
      slug,
      productSlug,
      locale,
      market,
      isPreview(preview),
      viewer,
    );
  }

  @Get(':slug/categories')
  getCategories(
    @Viewer() viewer: StorefrontViewer | null,
    @Param('slug') slug: string,
  ) {
    return this.storefrontService.getCategories(slug, viewer);
  }

  @Get(':slug/creator-categories')
  getCreatorCategories(
    @Viewer() viewer: StorefrontViewer | null,
    @Param('slug') slug: string,
  ) {
    return this.storefrontService.getCreatorCategories(slug, viewer);
  }

  // All navigation menus for the store, keyed by `key`. Chrome sections
  // (HeaderBar nav, FooterColumns, MobileBottomNav) reference a menu by key
  // and resolve its items from this payload via StoreContext.
  @Get(':slug/menus')
  getMenus(
    @Viewer() viewer: StorefrontViewer | null,
    @Param('slug') slug: string,
  ) {
    return this.storefrontService.getMenus(slug, viewer);
  }

  @Get(':slug/pages/:pageSlug')
  getPage(
    @Viewer() viewer: StorefrontViewer | null,
    @Param('slug') slug: string,
    @Param('pageSlug') pageSlug: string,
  ) {
    return this.storefrontService.getPage(slug, pageSlug, viewer);
  }

  // v2 published page snapshot — HOME or any LANDING/STATIC/PRODUCT_TEMPLATE slug.
  // Returns null when no version is published yet.
  @Get(':slug/v2/home')
  getHome(@Viewer() viewer: StorefrontViewer | null, @Param('slug') slug: string) {
    return this.storefrontService.getPublishedPage(
      slug,
      { type: 'HOME' },
      viewer,
    );
  }

  @Get(':slug/v2/product-template')
  getProductTemplate(
    @Viewer() viewer: StorefrontViewer | null,
    @Param('slug') slug: string,
  ) {
    return this.storefrontService.getPublishedPage(
      slug,
      { type: 'PRODUCT_TEMPLATE' },
      viewer,
    );
  }

  // Listing templates — published snapshots for the /products catalog and the
  // /collections/[handle] pages. Return null when nothing is published yet;
  // the storefront then renders its built-in listing markup.
  @Get(':slug/v2/catalog-template')
  getCatalogTemplate(
    @Viewer() viewer: StorefrontViewer | null,
    @Param('slug') slug: string,
  ) {
    return this.storefrontService.getPublishedPage(
      slug,
      { type: 'CATALOG_TEMPLATE' },
      viewer,
    );
  }

  @Get(':slug/v2/collection-template')
  getCollectionTemplate(
    @Viewer() viewer: StorefrontViewer | null,
    @Param('slug') slug: string,
  ) {
    return this.storefrontService.getPublishedPage(
      slug,
      { type: 'COLLECTION_TEMPLATE' },
      viewer,
    );
  }

  // Store-wide chrome — published snapshots of the HEADER and FOOTER pages.
  // Returns null when the creator hasn't published the chrome yet; the
  // storefront falls back to its built-in header/footer in that case.
  @Get(':slug/v2/header')
  getHeader(@Viewer() viewer: StorefrontViewer | null, @Param('slug') slug: string) {
    return this.storefrontService.getPublishedPage(
      slug,
      { type: 'HEADER' },
      viewer,
    );
  }

  @Get(':slug/v2/footer')
  getFooter(@Viewer() viewer: StorefrontViewer | null, @Param('slug') slug: string) {
    return this.storefrontService.getPublishedPage(
      slug,
      { type: 'FOOTER' },
      viewer,
    );
  }

  @Get(':slug/v2/sample-product')
  getSampleProduct(
    @Viewer() viewer: StorefrontViewer | null,
    @Param('slug') slug: string,
  ) {
    return this.storefrontService.getSampleProduct(slug, viewer);
  }

  @Get(':slug/v2/pages/:pageSlug')
  getPublishedPage(
    @Viewer() viewer: StorefrontViewer | null,
    @Param('slug') slug: string,
    @Param('pageSlug') pageSlug: string,
    @Query('type') type?: 'STATIC' | 'LANDING',
  ) {
    // M6.6: without `type`, a slug resolves to a STATIC or a LANDING page —
    // both live at the store root now (slugs are unique per store).
    return this.storefrontService.getPublishedPage(
      slug,
      {
        type: type === 'STATIC' || type === 'LANDING' ? type : 'SLUG',
        slug: pageSlug,
      },
      viewer,
    );
  }

  // Aggregated data the storefront's sitemap.xml route needs.
  @Get(':slug/sitemap-data')
  getSitemapData(
    @Viewer() viewer: StorefrontViewer | null,
    @Param('slug') slug: string,
    @Query('market') market?: string,
    @Query('preview') preview?: string,
  ) {
    return this.storefrontService.getSitemapData(
      slug,
      market,
      isPreview(preview),
      viewer,
    );
  }
}
