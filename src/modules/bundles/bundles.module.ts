import { Module } from '@nestjs/common';
import { BundlesController } from './bundles.controller';
import { BundlesService } from './bundles.service';

@Module({
  controllers: [BundlesController],
  providers: [BundlesService],
  exports: [BundlesService],
})
export class BundlesModule {}
