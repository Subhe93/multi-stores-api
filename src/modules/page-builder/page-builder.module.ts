import { Module } from '@nestjs/common';
import { PageBuilderController } from './page-builder.controller';
import { PageBuilderService } from './page-builder.service';

@Module({
  controllers: [PageBuilderController],
  providers: [PageBuilderService],
  exports: [PageBuilderService],
})
export class PageBuilderModule {}
