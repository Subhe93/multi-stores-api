import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import {
  CurrentUser,
  RequireApp,
  type RequestUser,
} from '../../common/decorators';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt.guard';
import {
  RequireAppGuard,
  type RequestWithAppStore,
} from '../../common/guards/require-app.guard';
import { appStoreId, designerUploadLimit } from './designer-assets.controller';
import { PHOTO_MAX_BYTES } from './designer-assets.service';
import { DesignerPhotoAdmissionInterceptor } from './designer-upload-admission';
import { DesignsService, type DesignAccess } from './designs.service';
import {
  CreateDesignDto,
  UpdateDesignDto,
  UploadDesignPhotoDto,
} from './dto/designs.dto';

/** Header carrying the guest design token. */
export const DESIGN_TOKEN_HEADER = 'x-design-token';

/**
 * Public design draft API of the storefront editor (M4.2 §4.1), mounted at
 * `/api/designer/s/:slug/designs`. Guests authenticate with the token
 * returned by create (`X-Design-Token`), logged-in customers by their JWT.
 * 403 STORE_APP_NOT_ENABLED while the app is off for the store.
 */
@Controller('designer/s/:slug/designs')
@UseGuards(OptionalJwtAuthGuard, RequireAppGuard)
@RequireApp('designer')
export class DesignsController {
  constructor(private readonly designs: DesignsService) {}

  private async access(
    user: RequestUser | undefined,
    token: string | undefined,
    locale?: unknown,
  ): Promise<DesignAccess> {
    return {
      customerId:
        user?.role === UserRole.CUSTOMER
          ? await this.designs.customerIdOf(user.id)
          : null,
      token: typeof token === 'string' && token ? token : null,
      locale:
        typeof locale === 'string' &&
        /^[A-Za-z]{2}([-_][A-Za-z]{2})?$/.test(locale)
          ? locale
          : null,
    };
  }

  /** `{product_id, template_version_id, state?}` → the design + its token (once). */
  @Post()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async create(
    @Req() req: RequestWithAppStore,
    @Body() dto: CreateDesignDto,
    @CurrentUser() user?: RequestUser,
    @Query('locale') locale?: string,
  ) {
    const { customerId, locale: loc } = await this.access(
      user,
      undefined,
      locale,
    );
    return this.designs.create(appStoreId(req), dto, customerId, loc);
  }

  @Get(':id')
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  async get(
    @Req() req: RequestWithAppStore,
    @Param('id') id: string,
    @Headers(DESIGN_TOKEN_HEADER) token?: string,
    @CurrentUser() user?: RequestUser,
    @Query('locale') locale?: string,
  ) {
    return this.designs.get(
      appStoreId(req),
      id,
      await this.access(user, token, locale),
    );
  }

  /**
   * A new DRAFT copy (texts, adjustments, copied photo files) of a design
   * the caller may access, ORDERED included → the new design + its token
   * (once). How the storefront edits / re-orders an ordered design.
   */
  @Post(':id/duplicate')
  @HttpCode(201)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async duplicate(
    @Req() req: RequestWithAppStore,
    @Param('id') id: string,
    @Headers(DESIGN_TOKEN_HEADER) token?: string,
    @CurrentUser() user?: RequestUser,
    @Query('locale') locale?: string,
  ) {
    return this.designs.duplicate(
      appStoreId(req),
      id,
      await this.access(user, token, locale),
    );
  }

  /** `{state, state_version}`; 409 DESIGNER_DESIGN_STALE on a stale version. */
  @Patch(':id')
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  async update(
    @Req() req: RequestWithAppStore,
    @Param('id') id: string,
    @Body() dto: UpdateDesignDto,
    @Headers(DESIGN_TOKEN_HEADER) token?: string,
    @CurrentUser() user?: RequestUser,
    @Query('locale') locale?: string,
  ) {
    return this.designs.update(
      appStoreId(req),
      id,
      dto,
      await this.access(user, token, locale),
    );
  }

  /**
   * Renders (or reuses) the proof of the current state → `{proof_url,
   * reused}`; 503 DESIGNER_RENDER_UNAVAILABLE when the engine is off/busy.
   */
  @Post(':id/proof')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async proof(
    @Req() req: RequestWithAppStore,
    @Param('id') id: string,
    @Headers(DESIGN_TOKEN_HEADER) token?: string,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.designs.proof(
      appStoreId(req),
      id,
      await this.access(user, token),
    );
  }

  /** Multipart `file` + `element_id` (an image slot of the template). */
  @Post(':id/photos')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseInterceptors(
    DesignerPhotoAdmissionInterceptor,
    designerUploadLimit(PHOTO_MAX_BYTES),
    FileInterceptor('file', {
      limits: { fileSize: PHOTO_MAX_BYTES, files: 1 },
    }),
  )
  async uploadPhoto(
    @Req() req: RequestWithAppStore,
    @Param('id') id: string,
    @Body() dto: UploadDesignPhotoDto,
    @UploadedFile() file?: Express.Multer.File,
    @Headers(DESIGN_TOKEN_HEADER) token?: string,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.designs.uploadPhoto(
      appStoreId(req),
      id,
      dto.element_id,
      file?.buffer as Buffer,
      await this.access(user, token),
    );
  }

  @Delete(':id/photos/:assetId')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async deletePhoto(
    @Req() req: RequestWithAppStore,
    @Param('id') id: string,
    @Param('assetId') assetId: string,
    @Headers(DESIGN_TOKEN_HEADER) token?: string,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.designs.deletePhoto(
      appStoreId(req),
      id,
      assetId,
      await this.access(user, token),
    );
  }
}
