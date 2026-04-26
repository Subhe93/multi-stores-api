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
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadsService } from './uploads.service';

@Controller('uploads')
@UseGuards(AuthGuard('jwt'))
export class UploadsController {
  constructor(private uploadsService: UploadsService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Query('folder') folder?: string,
  ) {
    return this.uploadsService.uploadFile(file, folder || 'general');
  }

  @Delete(':fileUrl')
  delete(@Param('fileUrl') fileUrl: string) {
    return this.uploadsService.deleteFile(decodeURIComponent(fileUrl));
  }
}
