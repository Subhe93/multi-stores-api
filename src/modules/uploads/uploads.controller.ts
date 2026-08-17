import {
  Controller,
  Post,
  Delete,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Query,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadsService } from './uploads.service';

const PUBLIC_UPLOAD_FOLDERS = ['custom-fields', 'customer-uploads'];

@Controller('uploads')
export class UploadsController {
  constructor(private uploadsService: UploadsService) {}

  @Post()
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Query('folder') folder?: string,
  ) {
    return this.uploadsService.uploadFile(file, folder || 'general');
  }

  // Unauthenticated uploads from the storefront (e.g. customer customization images).
  // Folder is restricted to a whitelist so guests can't write to admin-only buckets.
  // Throttled tightly — it is the only unauthenticated write on the API.
  @Post('public')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseInterceptors(FileInterceptor('file'))
  uploadPublic(
    @UploadedFile() file: Express.Multer.File,
    @Query('folder') folder?: string,
  ) {
    const safeFolder = PUBLIC_UPLOAD_FOLDERS.includes(folder ?? '')
      ? folder!
      : 'customer-uploads';
    return this.uploadsService.uploadFile(file, safeFolder);
  }

  @Delete(':fileUrl')
  @UseGuards(AuthGuard('jwt'))
  delete(@Param('fileUrl') fileUrl: string) {
    return this.uploadsService.deleteFile(decodeURIComponent(fileUrl));
  }
}
