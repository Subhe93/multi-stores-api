import {
  Controller,
  Post,
  Delete,
  ForbiddenException,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Query,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser, type RequestUser } from '../../common/decorators';
import { sanitizeFolder } from '../storage/public-storage';
import { uploadLimit } from './upload-limit.interceptor';
import {
  folderAllowedForRole,
  UPLOAD_MAX_BYTES,
  UploadsService,
} from './uploads.service';

/**
 * Generic staff uploads (dashboard). The former unauthenticated
 * `POST /uploads/public` is gone (no caller; raw customer files went to the
 * public tree); storefront customer files use `POST /uploads/customer`.
 */
@Controller('uploads')
export class UploadsController {
  constructor(private uploadsService: UploadsService) {}

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
    return this.uploadsService.uploadFile(file, safeFolder);
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
