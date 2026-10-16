import {
  Body,
  CallHandler,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  Injectable,
  NestInterceptor,
  Param,
  PayloadTooLargeException,
  Post,
  Query,
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
import { UserRole } from '@prisma/client';
import type { Response } from 'express';
import { catchError, Observable, throwError } from 'rxjs';
import { RequireApp, Roles } from '../../common/decorators';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  RequireAppGuard,
  type RequestWithAppStore,
} from '../../common/guards/require-app.guard';
import {
  DesignerAssetsService,
  TEMPLATE_ASSET_MAX_BYTES,
} from './designer-assets.service';
import { designerErrors } from './designer-errors';
import {
  ListTemplateAssetsQueryDto,
  UploadTemplateAssetDto,
} from './dto/designer-assets.dto';

/**
 * Gives multer's size-limit error the designer code
 * (`DESIGNER_UPLOAD_TOO_LARGE`, params.max_mb) instead of Nest's bare 413.
 */
export function designerUploadLimit(maxBytes: number) {
  @Injectable()
  class DesignerUploadLimitInterceptor implements NestInterceptor {
    intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
      return next.handle().pipe(
        catchError((err: unknown) =>
          throwError(() =>
            err instanceof PayloadTooLargeException
              ? designerErrors.tooLarge('The file is too large.', {
                  max_mb: Math.round((maxBytes / (1024 * 1024)) * 10) / 10,
                })
              : err,
          ),
        ),
      );
    }
  }
  return DesignerUploadLimitInterceptor;
}

/** Store id resolved by RequireAppGuard (the creator's own store). */
export function appStoreId(req: RequestWithAppStore | undefined): string {
  const id = req?.appStoreId;
  if (!id) {
    throw designerErrors.forbidden(
      'DESIGNER_NOT_ENABLED',
      'The designer is not enabled for this store.',
    );
  }
  return id;
}

/** Headers of every public designer file (immutable, cross-origin readable). */
export function setPublicFileHeaders(res: Response | undefined): void {
  if (!res) return;
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  // Public, credential-less bytes: any storefront origin (custom domains
  // included) may load them, e.g. through FontFace, which always uses CORS.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.removeHeader('Access-Control-Allow-Credentials');
}

/** Headers of signed (private) designer files. */
export function setSignedFileHeaders(res: Response | undefined): void {
  if (!res) return;
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

const PUBLIC_FILE_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([a-z0-9]{2,5})$/;

/** `<uuid>.<ext>` of a public file route, or a 404. */
export function parsePublicFileName(file: string): { id: string; ext: string } {
  const m = PUBLIC_FILE_RE.exec(String(file ?? ''));
  if (!m) {
    throw designerErrors.notFound('DESIGNER_FILE_NOT_FOUND', 'File not found.');
  }
  return { id: m[1], ext: m[2] };
}

/**
 * Creator routes of the designer template assets (M4.2 §4.3, WP3), mounted
 * at `/api/designer/my/assets`. Store owner only (JWT creator + the app
 * enabled for the creator's store; 403 STORE_APP_NOT_ENABLED when off).
 */
@Controller('designer/my/assets')
@UseGuards(AuthGuard('jwt'), RolesGuard, RequireAppGuard)
@Roles(UserRole.CREATOR)
@RequireApp('designer')
export class DesignerAssetsCreatorController {
  constructor(private readonly assets: DesignerAssetsService) {}

  @Get()
  list(
    @Req() req: RequestWithAppStore,
    @Query() query: ListTemplateAssetsQueryDto,
  ) {
    return this.assets.listTemplateAssets(appStoreId(req), query);
  }

  /**
   * Multipart `file` + `kind` (TEMPLATE_BG_WEB | TEMPLATE_BG_PRINT |
   * TEMPLATE_DECO | TEMPLATE_THUMB), optional `template_id` (resolution
   * checks against its trim size) and `replaces_asset_id` (replace flow).
   */
  @Post()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseInterceptors(
    designerUploadLimit(TEMPLATE_ASSET_MAX_BYTES),
    FileInterceptor('file', {
      limits: { fileSize: TEMPLATE_ASSET_MAX_BYTES, files: 1 },
    }),
  )
  upload(
    @Req() req: RequestWithAppStore,
    @Body() dto: UploadTemplateAssetDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.assets.storeTemplateAsset(appStoreId(req), {
      buffer: file?.buffer as Buffer,
      kind: dto.kind,
      template_id: dto.template_id ?? null,
      replaces_asset_id: dto.replaces_asset_id ?? null,
    });
  }

  @Get(':id')
  async get(@Req() req: RequestWithAppStore, @Param('id') id: string) {
    const storeId = appStoreId(req);
    const asset = await this.assets.getOwnedAsset(storeId, id);
    return {
      ...this.assets.assetView(asset),
      references: await this.assets.assetReferences(storeId, asset.id),
    };
  }

  /** Deletes an unreferenced template asset or font (409 DESIGNER_ASSET_IN_USE). */
  @Delete(':id')
  remove(@Req() req: RequestWithAppStore, @Param('id') id: string) {
    return this.assets.deleteAsset(appStoreId(req), id);
  }
}

/**
 * Public designer files:
 * - `GET /api/designer/assets/<id>.<ext>`: public template assets (web
 *   background, decoration, thumbnail), immutable; 404 while the app is off;
 * - `GET /api/designer/files/<token>`: signed private files (§4.1), private
 *   5-minute cache, noindex; 403 DESIGNER_LINK_EXPIRED, 410 after purge.
 * Bytes are returned as StreamableFile so the envelope interceptor passes them.
 */
@Controller('designer')
export class DesignerFilesPublicController {
  constructor(private readonly assets: DesignerAssetsService) {}

  @Get('assets/:file')
  @SkipThrottle()
  async publicAsset(
    @Param('file') file: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const { id, ext } = parsePublicFileName(file);
    const body = await this.assets.readPublicAsset(id, ext);
    setPublicFileHeaders(res);
    if (body.sha256) res?.setHeader('ETag', `"${body.sha256}"`);
    return new StreamableFile(body.buffer, {
      type: body.mime,
      length: body.buffer.length,
    });
  }

  @Get('files/:token')
  @Throttle({ default: { limit: 300, ttl: 60000 } })
  async signedFile(
    @Param('token') token: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const body = await this.assets.readSignedFile(token);
    setSignedFileHeaders(res);
    return new StreamableFile(body.buffer, {
      type: body.mime,
      length: body.buffer.length,
    });
  }
}
