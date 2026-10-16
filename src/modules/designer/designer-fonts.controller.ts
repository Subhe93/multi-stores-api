import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { DesignAssetKind, UserRole } from '@prisma/client';
import type { Response } from 'express';
import { RequireApp, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  RequireAppGuard,
  type RequestWithAppStore,
} from '../../common/guards/require-app.guard';
import {
  appStoreId,
  designerUploadLimit,
  parsePublicFileName,
  setPublicFileHeaders,
} from './designer-assets.controller';
import { DesignerAssetsService } from './designer-assets.service';
import { designerErrors } from './designer-errors';
import { DesignerFontsService, FONT_MAX_BYTES } from './designer-fonts.service';
import { UploadFontDto } from './dto/designer-assets.dto';

/**
 * Creator routes of the self-hosted fonts (M4.2 WP3), mounted at
 * `/api/designer/my/fonts`. Store owner only, app enabled.
 */
@Controller('designer/my/fonts')
@UseGuards(AuthGuard('jwt'), RolesGuard, RequireAppGuard)
@Roles(UserRole.CREATOR)
@RequireApp('designer')
export class DesignerFontsCreatorController {
  constructor(
    private readonly fonts: DesignerFontsService,
    private readonly assets: DesignerAssetsService,
  ) {}

  @Get()
  list(@Req() req: RequestWithAppStore) {
    return this.fonts.listFonts(appStoreId(req));
  }

  /**
   * Multipart `file` (woff2/ttf/otf, ≤ 10 MB) + optional `family`, `weight`,
   * `style` (read from a Google-style file name when omitted).
   */
  @Post()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseInterceptors(
    designerUploadLimit(FONT_MAX_BYTES),
    FileInterceptor('file', { limits: { fileSize: FONT_MAX_BYTES, files: 1 } }),
  )
  upload(
    @Req() req: RequestWithAppStore,
    @Body() dto: UploadFontDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.fonts.registerFont(appStoreId(req), file?.buffer as Buffer, {
      family: dto.family,
      weight: dto.weight,
      style: dto.style,
      filename: file?.originalname ?? null,
    });
  }

  /** Deletes a face nothing references (409 DESIGNER_ASSET_IN_USE otherwise). */
  @Delete(':id')
  async remove(@Req() req: RequestWithAppStore, @Param('id') id: string) {
    const storeId = appStoreId(req);
    const asset = await this.assets.getOwnedAsset(storeId, id);
    if (asset.kind !== DesignAssetKind.FONT) {
      throw designerErrors.notFound(
        'DESIGNER_ASSET_NOT_FOUND',
        'Font not found.',
      );
    }
    return this.assets.deleteAsset(storeId, id);
  }
}

/**
 * `GET /api/designer/fonts/<id>.<woff2|ttf|otf>`: public font bytes. Served
 * under the Nest router (not the `/uploads` static) so CORS headers apply —
 * `FontFace` loads are always CORS requests. Immutable (a face's bytes never
 * change; a new upload gets a new id). 404 while the app is off.
 */
@Controller('designer/fonts')
export class DesignerFontsPublicController {
  constructor(private readonly fonts: DesignerFontsService) {}

  @Get(':file')
  @SkipThrottle()
  async font(
    @Param('file') file: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const { id, ext } = parsePublicFileName(file);
    const body = await this.fonts.readPublicFont(id, ext);
    setPublicFileHeaders(res);
    if (body.sha256) res?.setHeader('ETag', `"${body.sha256}"`);
    return new StreamableFile(body.buffer, {
      type: body.mime,
      length: body.buffer.length,
    });
  }
}
