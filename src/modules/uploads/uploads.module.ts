import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { UploadsController } from './uploads.controller';
import { UPLOAD_MAX_BYTES, UploadsService } from './uploads.service';

@Module({
  imports: [
    MulterModule.register({
      storage: memoryStorage(),
      // Hard cap before buffering (the route repeats it for clarity).
      limits: { fileSize: UPLOAD_MAX_BYTES },
    }),
  ],
  controllers: [UploadsController],
  providers: [UploadsService],
  exports: [UploadsService],
})
export class UploadsModule {}
