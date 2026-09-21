import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { BundlesModule } from '../bundles/bundles.module';
import { TaxesModule } from '../taxes/taxes.module';

@Module({
  imports: [BundlesModule, TaxesModule],
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
