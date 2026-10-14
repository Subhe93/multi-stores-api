import { Module } from '@nestjs/common';
import { StorefrontController } from './storefront.controller';
import { StorefrontService } from './storefront.service';
import { MarketsModule } from '../markets/markets.module';
import { TaxesModule } from '../taxes/taxes.module';

// TaxesModule has no imports of its own (no cycle); the b2b app needs the
// engine to estimate each product's rate for the company price display.
@Module({
  imports: [MarketsModule, TaxesModule],
  controllers: [StorefrontController],
  providers: [StorefrontService],
})
export class StorefrontModule {}
