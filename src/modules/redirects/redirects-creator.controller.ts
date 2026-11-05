import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { CurrentUser, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  parseBulkRedirectCsv,
  productPathKey,
  RedirectsService,
  type ProductPathKind,
} from './redirects.service';
import {
  BulkRedirectDto,
  CreateRedirectDto,
  PRODUCT_PATH_KINDS,
  ProductPathsBatchDto,
  RedirectListQueryDto,
  TestRedirectDto,
  UpdateRedirectDto,
} from './dto/redirect.dto';

/**
 * Creator management of the store's redirects (M4.4 §6.3). A core online
 * store feature: every store type (MARKETPLACE and INDEPENDENT) manages its
 * redirects, with or without the importer app. Every call is scoped to the
 * caller's own store (storeIdForCreator). Rows the importer wrote (IMPORT)
 * are listed, edited and deleted like the merchant's own; an edit turns a
 * row MANUAL so a later import run never overwrites it and a run rollback
 * skips it. Static routes are declared before ':id'.
 */
@Controller('redirects/my')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR)
export class RedirectsCreatorController {
  constructor(private readonly redirects: RedirectsService) {}

  @Get()
  async list(
    @CurrentUser('id') userId: string,
    @Query() query: RedirectListQueryDto,
  ) {
    const storeId = await this.redirects.storeIdForCreator(userId);
    return this.redirects.list(storeId, query);
  }

  /**
   * `{ primary_locale, prefixes }`: the `/<locale>/…` prefixes the storefront
   * serves for the store (storeLocalePrefixes), so the dashboard builds the
   * same locale forms as the API's own slug redirects.
   */
  @Get('locale-prefixes')
  async localePrefixes(@CurrentUser('id') userId: string) {
    const storeId = await this.redirects.storeIdForCreator(userId);
    return this.redirects.storeLocales(storeId);
  }

  /**
   * `{ paths }`: every public path of one own product / custom product,
   * read before it is deleted (redirect sources). 404 when the item is not
   * the caller's.
   */
  @Get('product-paths/:kind/:id')
  async productPaths(
    @CurrentUser('id') userId: string,
    @Param('kind') kind: string,
    @Param('id') id: string,
  ) {
    if (!(PRODUCT_PATH_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException({
        code: 'REDIRECT_INVALID_KIND',
        message: 'kind must be product or custom-product.',
      });
    }
    const storeId = await this.redirects.storeIdForCreator(userId);
    const k = kind as ProductPathKind;
    const paths = (
      await this.redirects.productPaths(storeId, [{ kind: k, id }])
    ).get(productPathKey(k, id));
    if (!paths) {
      throw new NotFoundException({
        code: 'REDIRECT_ITEM_NOT_FOUND',
        message: 'Product not found',
      });
    }
    return { paths };
  }

  /**
   * Batch form for bulk deletes: `{ items: [{ kind, id, paths }] }` in the
   * request order; an item that is not the caller's gets `paths: []`.
   */
  @Post('product-paths')
  async productPathsBatch(
    @CurrentUser('id') userId: string,
    @Body() dto: ProductPathsBatchDto,
  ) {
    const storeId = await this.redirects.storeIdForCreator(userId);
    const found = await this.redirects.productPaths(storeId, dto.items);
    return {
      items: dto.items.map((i) => ({
        kind: i.kind,
        id: i.id,
        paths: found.get(productPathKey(i.kind, i.id)) ?? [],
      })),
    };
  }

  @Post('test')
  async test(@CurrentUser('id') userId: string, @Body() dto: TestRedirectDto) {
    const storeId = await this.redirects.storeIdForCreator(userId);
    return this.redirects.test(storeId, dto.path);
  }

  @Post()
  async create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateRedirectDto,
  ) {
    const storeId = await this.redirects.storeIdForCreator(userId);
    return this.redirects.create(storeId, dto);
  }

  /**
   * Bulk CSV create (M5 B17): body `{csv}` with `from_path,to_path[,status]`
   * per line (at most 5000). Answers `{created:[{line,id,from_path,to_path,
   * status_code}], conflicts:[{line,from_path,to_path,code}]}`; rows that
   * fail are reported, the rest are written (MANUAL).
   */
  @Post('bulk')
  async bulk(@CurrentUser('id') userId: string, @Body() dto: BulkRedirectDto) {
    const storeId = await this.redirects.storeIdForCreator(userId);
    return this.redirects.bulkCreate(storeId, parseBulkRedirectCsv(dto.csv));
  }

  @Put(':id')
  async update(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRedirectDto,
  ) {
    const storeId = await this.redirects.storeIdForCreator(userId);
    return this.redirects.update(storeId, id, dto);
  }

  @Delete(':id')
  async remove(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const storeId = await this.redirects.storeIdForCreator(userId);
    return this.redirects.remove(storeId, id);
  }
}
