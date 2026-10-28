import { Module } from '@nestjs/common';
import { RedirectsModule } from '../redirects/redirects.module';
import { OccasionConversionController } from './occasion-conversion.controller';
import { OccasionConversionService } from './occasion-conversion.service';

@Module({
  imports: [RedirectsModule],
  controllers: [OccasionConversionController],
  providers: [OccasionConversionService],
  exports: [OccasionConversionService],
})
export class OccasionConversionModule {}
