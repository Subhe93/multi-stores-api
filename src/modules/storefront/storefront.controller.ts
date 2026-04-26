import { Controller, Get, Param, Query } from '@nestjs/common';
import { StorefrontService } from './storefront.service';

@Controller('storefront')
export class StorefrontController {
  constructor(private storefrontService: StorefrontService) {}

  @Get(':slug')
  getStore(@Param('slug') slug: string) {
    return this.storefrontService.getStore(slug);
  }

  @Get(':slug/products')
  getProducts(
    @Param('slug') slug: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('category_id') category_id?: string,
    @Query('search') search?: string,
    @Query('locale') locale?: string,
  ) {
    return this.storefrontService.getProducts(slug, {
      page: page ? +page : undefined,
      limit: limit ? +limit : undefined,
      category_id,
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

  @Get(':slug/pages/:pageSlug')
  getPage(
    @Param('slug') slug: string,
    @Param('pageSlug') pageSlug: string,
  ) {
    return this.storefrontService.getPage(slug, pageSlug);
  }
}
