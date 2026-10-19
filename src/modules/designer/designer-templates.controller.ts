import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import {
  CurrentUser,
  RequireApp,
  Roles,
  type RequestUser,
} from '../../common/decorators';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { DesignerPrintQueueService } from './designer-print-queue.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  RequireAppGuard,
  type RequestWithAppStore,
} from '../../common/guards/require-app.guard';
import { appStoreId } from './designer-assets.controller';
import { DesignerTemplatesService } from './designer-templates.service';
import { DesignerCartService } from './designer-cart.service';
import {
  CreateDesignTemplateDto,
  CreateTemplateVersionDto,
  ListDesignTemplatesQueryDto,
  PublishTemplateDto,
  PutProductAddonsDto,
  PutProductDesignerDto,
  UpdateDesignTemplateDto,
} from './dto/designs.dto';

/** `?format=` of the print download: absent → png; anything else → 400. */
export function printFormatParam(format: unknown): 'png' | 'pdf' {
  if (format === undefined || format === '' || format === 'png') return 'png';
  if (format === 'pdf') return 'pdf';
  throw new BadRequestException('format must be png or pdf');
}

/** `?side=` of the print download (M5.6): absent → front; anything else → 400. */
export function printSideParam(side: unknown): 'front' | 'back' {
  if (side === undefined || side === '' || side === 'front') return 'front';
  if (side === 'back') return 'back';
  throw new BadRequestException('side must be front or back');
}

/**
 * Creator template routes (M4.2 §4.3), mounted at `/api/designer/my/templates`.
 * Store owner only, app enabled (403 STORE_APP_NOT_ENABLED otherwise).
 * The NPP import routes (`templates/import/...`) belong to WP7.
 */
@Controller('designer/my/templates')
@UseGuards(AuthGuard('jwt'), RolesGuard, RequireAppGuard)
@Roles(UserRole.CREATOR)
@RequireApp('designer')
export class DesignerTemplatesController {
  constructor(private readonly templates: DesignerTemplatesService) {}

  @Get()
  list(
    @Req() req: RequestWithAppStore,
    @Query() query: ListDesignTemplatesQueryDto,
  ) {
    return this.templates.list(appStoreId(req), query);
  }

  /** `{name, spec?}`: a blank 500×700 template (DRAFT, version 1) or the given spec. */
  @Post()
  create(
    @Req() req: RequestWithAppStore,
    @Body() dto: CreateDesignTemplateDto,
    @CurrentUser('id') userId?: string,
  ) {
    return this.templates.create(appStoreId(req), dto, userId ?? null);
  }

  @Get(':id')
  detail(@Req() req: RequestWithAppStore, @Param('id') id: string) {
    return this.templates.detail(appStoreId(req), id);
  }

  /** `{name?, status?}` (PUBLISHED needs a published version). */
  @Patch(':id')
  update(
    @Req() req: RequestWithAppStore,
    @Param('id') id: string,
    @Body() dto: UpdateDesignTemplateDto,
  ) {
    return this.templates.update(appStoreId(req), id, dto);
  }

  /** 409 DESIGNER_TEMPLATE_IN_USE while products, designs or orders use it. */
  @Delete(':id')
  remove(@Req() req: RequestWithAppStore, @Param('id') id: string) {
    return this.templates.remove(appStoreId(req), id);
  }

  /** `{spec}` → a new immutable version (400 DESIGNER_TEMPLATE_INVALID `{errors}`). */
  @Post(':id/versions')
  addVersion(
    @Req() req: RequestWithAppStore,
    @Param('id') id: string,
    @Body() dto: CreateTemplateVersionDto,
    @CurrentUser('id') userId?: string,
  ) {
    return this.templates.addVersion(
      appStoreId(req),
      id,
      dto.spec,
      userId ?? null,
    );
  }

  @Get(':id/versions/:versionId')
  version(
    @Req() req: RequestWithAppStore,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    return this.templates.version(appStoreId(req), id, versionId);
  }

  /** `{version_id}` → current version for new designs; template PUBLISHED. */
  @Post(':id/publish')
  publish(
    @Req() req: RequestWithAppStore,
    @Param('id') id: string,
    @Body() dto: PublishTemplateDto,
  ) {
    return this.templates.publish(appStoreId(req), id, dto.version_id);
  }
}

/**
 * Product ↔ template link (M4.2 §4.3), `/api/designer/my/products/:productId`.
 * Enabling deletes the product's `npp_fallback` launch fields (X28).
 */
@Controller('designer/my/products')
@UseGuards(AuthGuard('jwt'), RolesGuard, RequireAppGuard)
@Roles(UserRole.CREATOR)
@RequireApp('designer')
export class DesignerProductsController {
  constructor(private readonly templates: DesignerTemplatesService) {}

  @Get(':productId')
  get(@Req() req: RequestWithAppStore, @Param('productId') productId: string) {
    return this.templates.getProductLink(appStoreId(req), productId);
  }

  /** `{enabled, template_id}`. */
  @Put(':productId')
  put(
    @Req() req: RequestWithAppStore,
    @Param('productId') productId: string,
    @Body() dto: PutProductDesignerDto,
  ) {
    return this.templates.putProductLink(appStoreId(req), productId, dto);
  }

  /**
   * M5.5 add-ons `{addons: {v:2, items}}` of a linked product; 400
   * DESIGNER_ADDONS_INVALID `{params:{errors}}` when the config is invalid.
   */
  @Put(':productId/addons')
  putAddons(
    @Req() req: RequestWithAppStore,
    @Param('productId') productId: string,
    @Body() dto: PutProductAddonsDto,
  ) {
    return this.templates.putProductAddons(
      appStoreId(req),
      productId,
      dto.addons,
      dto.back_template_ids,
    );
  }

  /** Removes the product's link → `{deleted}`. */
  @Delete(':productId')
  remove(
    @Req() req: RequestWithAppStore,
    @Param('productId') productId: string,
  ) {
    return this.templates.deleteProductLink(appStoreId(req), productId);
  }
}

/**
 * Order history of the designer app (§4.3), mounted at
 * `/api/designer/my/orders/...`: the frozen designs of an order, the print
 * PNG and the customer's original photos. Creator only, but readable while
 * the app is OFF (orders keep their designs); every write (regenerate,
 * erase) stays behind `@RequireApp('designer')`. The store is the creator's
 * own store (no RequireAppGuard here).
 */
@Controller('designer/my/orders')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.CREATOR)
export class DesignerOrderDesignsController {
  constructor(
    private readonly designerCart: DesignerCartService,
    private readonly printQueue: DesignerPrintQueueService,
    private readonly storeApps: StoreAppsService,
  ) {}

  private async storeOf(user: RequestUser | undefined): Promise<string> {
    const id = user?.id ? await this.storeApps.storeIdByUser(user.id) : null;
    if (!id) {
      throw new ForbiddenException({
        code: 'STORE_NOT_FOUND',
        message: 'No store for this account.',
      });
    }
    return id;
  }

  @Get(':orderId/designs')
  async list(
    @Param('orderId') orderId: string,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.designerCart.orderDesigns(await this.storeOf(user), orderId);
  }

  /**
   * The print PNG as an attachment `<order_number>-<n>-front.png`, or with
   * `?format=pdf` the print-ready PDF (`…-front.pdf`); `?side=back` (M5.6)
   * the back file of a double-sided line (`…-back.png` / `…-back.pdf`).
   * 409 DESIGNER_PRINT_NOT_READY, 410 DESIGNER_FILES_PURGED.
   */
  @Get(':orderId/items/:itemId/print')
  async print(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Query('format') format?: string,
    @Query('side') side?: string,
    @CurrentUser() user?: RequestUser,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const file = await this.printQueue.printFile(
      await this.storeOf(user),
      orderId,
      itemId,
      printFormatParam(format),
      printSideParam(side),
    );
    res?.setHeader('Cache-Control', 'private, no-store');
    res?.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(file.buffer, {
      type: file.mime,
      length: file.buffer.length,
      disposition: `attachment; filename="${file.filename}"`,
    });
  }

  /**
   * The customer's original photo of a designed line (attachment). 404
   * when the asset is not one of the item's photos, 410
   * DESIGNER_FILES_PURGED after the retention purge / erasure.
   */
  @Get(':orderId/items/:itemId/originals/:assetId')
  async original(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @CurrentUser() user?: RequestUser,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const file = await this.designerCart.orderOriginal(
      await this.storeOf(user),
      orderId,
      itemId,
      assetId,
    );
    res?.setHeader('Cache-Control', 'private, no-store');
    res?.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(file.buffer, {
      type: file.mime,
      length: file.buffer.length,
      disposition: `attachment; filename="${file.filename}"`,
    });
  }
}
