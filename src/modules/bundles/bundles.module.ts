import { Module } from '@nestjs/common';
import { BundlesController } from './bundles.controller';
import { BundlesService } from './bundles.service';
import { TaxesModule } from '../taxes/taxes.module';

@Module({
  imports: [TaxesModule],
  controllers: [BundlesController],
  providers: [BundlesService],
  exports: [BundlesService],
})
export class BundlesModule {}
