import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Delete,
  ForbiddenException,
  Param,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Query,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, type RequestUser } from '../../common/decorators';
import { sanitizeFolder } from '../storage/public-storage';
import {
  uploadLimit,
  VideoUploadInterceptor,
} from './upload-limit.interceptor';
import {
  folderAllowedForRole,
  UPLOAD_MAX_BYTES,
  UploadsService,
} from './uploads.service';
import { VideoLinkDto, VideoLinkService } from './video-link.service';
import { videoFolderForbidden } from './video-upload.config';

/** 10 video uploads per 10 minutes (CONTRACT §4.3). */
export const VIDEO_UPLOAD_THROTTLE = { default: { limit: 10, ttl: 600_000 } };
/** 30 video-link lookups per 10 minutes (CONTRACT §4.5). */
export const VIDEO_LINK_THROTTLE = { default: { limit: 30, ttl: 600_000 } };

/**
 * Generic staff uploads (dashboard). The former unauthenticated
 * `POST /uploads/public` is gone (no caller; raw customer files went to the
 * public tree); storefront customer files use `POST /uploads/customer`.
 */
@Controller('uploads')
export class UploadsController {
  constructor(
    private uploadsService: UploadsService,
    private videoLinks: VideoLinkService,
  ) {}

  @Post()
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(
    uploadLimit(UPLOAD_MAX_BYTES),
    FileInterceptor('file', {
      limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 },
    }),
  )
  upload(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: RequestUser,
    @Query('folder') folder?: string,
  ) {
    const safeFolder = sanitizeFolder(folder || 'general');
    if (!folderAllowedForRole(user.role, safeFolder)) {
      throw new ForbiddenException({
        code: 'UPLOAD_FOLDER_FORBIDDEN',
        message: `Uploads to "${safeFolder}" are not allowed for your account`,
      });
    }
    return this.uploadsService.uploadFile(file, safeFolder, user);
  }

  /** Limits and quota for the dashboard's video menu (404 on an older API). */
  @Get('video/config')
  @UseGuards(AuthGuard('jwt'))
  videoConfig(@CurrentUser() user: RequestUser) {
    if (!['ADMIN', 'CREATOR', 'PROVIDER'].includes(user.role)) {
      throw videoFolderForbidden('products');
    }
    return this.uploadsService.videoConfig(user);
  }

  /**
   * Product video upload (MP4 / H.264). The interceptor runs the pre-body
   * checks and writes the file to the temp dir; the service probes and
   * stores it.
   */
  @Post('video')
  @UseGuards(AuthGuard('jwt'))
  @Throttle(VIDEO_UPLOAD_THROTTLE)
  @UseInterceptors(VideoUploadInterceptor)
  uploadVideo(
    @Req() req: { file?: Express.Multer.File },
    @CurrentUser() user: RequestUser,
    @Query('folder') folder?: string,
  ) {
    return this.uploadsService.uploadVideo(
      req.file,
      sanitizeFolder(folder || 'products'),
      user,
    );
  }

  /** YouTube / Vimeo link → canonical URL + stored poster (not behind the upload flag). */
  @Post('video-link')
  @HttpCode(200)
  @UseGuards(AuthGuard('jwt'))
  @Throttle(VIDEO_LINK_THROTTLE)
  videoLink(@Body() body: VideoLinkDto, @CurrentUser() user: RequestUser) {
    if (!['ADMIN', 'CREATOR', 'PROVIDER'].includes(user.role)) {
      throw videoFolderForbidden('products');
    }
    return this.videoLinks.resolve(body.url, user);
  }

  @Delete(':fileUrl')
  @UseGuards(AuthGuard('jwt'))
  delete(@Param('fileUrl') fileUrl: string, @CurrentUser() user: RequestUser) {
    return this.uploadsService.deleteOwnedFile(
      decodeURIComponent(fileUrl),
      user,
    );
  }
}
