import { Module } from '@nestjs/common';
import { CorsOriginService } from './cors-origin.service';

// PrismaModule is @Global, so PrismaService is injectable here without an import.
@Module({
  providers: [CorsOriginService],
  exports: [CorsOriginService],
})
export class CorsModule {}
