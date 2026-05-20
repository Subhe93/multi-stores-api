import { Controller, Get, Param, Query } from '@nestjs/common';
import { StorefrontService } from './storefront.service';

@Controller('storefront')
export class StorefrontController {
  constructor(private storefrontService: StorefrontService) {}

  @Get(':slug')
  getStore(@Param('slug') slug: string) {
    return this.storefrontService.getStore(slug);
  }

  // Tiny endpoint the storefront reads to decide whether to cache this store.
  @Get(':slug/cache-config')
  getCacheConfig(@Param('slug') slug: string) {
    return this.storefrontService.getCacheConfig(slug);
  }

  @Get(':slug/products')
  getProducts(
    @Param('slug') slug: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('category_id') category_id?: string,
    @Query('creator_category') creator_category?: string,
    @Query('search') search?: string,
    @Query('locale') locale?: string,
  ) {
    return this.storefrontService.getProducts(slug, {
      page: page ? +page : undefined,
      limit: limit ? +limit : undefined,
      category_id,
      creator_category,
      search,
      locale,
    });
  }

  @Get(':slug/products/:productSlug')
  getProduct(
    @Param('slug') slug: string,
    @Param('productSlug') productSlug: string,
    @Query('locale') locale?: string,
  ) {
    return this.storefrontService.getProduct(slug, productSlug, locale);
  }

  @Get(':slug/categories')
  getCategories(@Param('slug') slug: string) {
    return this.storefrontService.getCategories(slug);
  }

  @Get(':slug/creator-categories')
  getCreatorCategories(@Param('slug') slug: string) {
    return this.storefrontService.getCreatorCategories(slug);
  }

  // All navigation menus for the store, keyed by `key`. Chrome sections
  // (HeaderBar nav, FooterColumns, MobileBottomNav) reference a menu by key
  // and resolve its items from this payload via StoreContext.
  @Get(':slug/menus')
  getMenus(@Param('slug') slug: string) {
    return this.storefrontService.getMenus(slug);
  }

  @Get(':slug/pages/:pageSlug')
  getPage(
    @Param('slug') slug: string,
    @Param('pageSlug') pageSlug: string,
  ) {
    return this.storefrontService.getPage(slug, pageSlug);
  }

  // v2 published page snapshot — HOME or any LANDING/STATIC/PRODUCT_TEMPLATE slug.
  // Returns null when no version is published yet.
  @Get(':slug/v2/home')
  getHome(@Param('slug') slug: string) {
    return this.storefrontService.getPublishedPage(slug, { type: 'HOME' });
  }

  @Get(':slug/v2/product-template')
  getProductTemplate(@Param('slug') slug: string) {
    return this.storefrontService.getPublishedPage(slug, { type: 'PRODUCT_TEMPLATE' });
  }

  // Store-wide chrome — published snapshots of the HEADER and FOOTER pages.
  // Returns null when the creator hasn't published the chrome yet; the
  // storefront falls back to its built-in header/footer in that case.
  @Get(':slug/v2/header')
  getHeader(@Param('slug') slug: string) {
    return this.storefrontService.getPublishedPage(slug, { type: 'HEADER' });
  }

  @Get(':slug/v2/footer')
  getFooter(@Param('slug') slug: string) {
    return this.storefrontService.getPublishedPage(slug, { type: 'FOOTER' });
  }

  @Get(':slug/v2/sample-product')
  getSampleProduct(@Param('slug') slug: string) {
    return this.storefrontService.getSampleProduct(slug);
  }

  @Get(':slug/v2/pages/:pageSlug')
  getPublishedPage(
    @Param('slug') slug: string,
    @Param('pageSlug') pageSlug: string,
    @Query('type') type?: 'STATIC' | 'LANDING',
  ) {
    return this.storefrontService.getPublishedPage(slug, {
      type: type ?? 'STATIC',
      slug: pageSlug,
    });
  }

  // Aggregated data the storefront's sitemap.xml route needs.
  @Get(':slug/sitemap-data')
  getSitemapData(@Param('slug') slug: string) {
    return this.storefrontService.getSitemapData(slug);
  }
}
