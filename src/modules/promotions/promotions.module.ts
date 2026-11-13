import { Module } from '@nestjs/common';
import { PromotionsController } from './promotions.controller';
import { PromotionsService } from './promotions.service';
import { MarketsModule } from '../markets/markets.module';
import { TaxesModule } from '../taxes/taxes.module';

// MarketsModule: the public coupon preview converts market-currency carts.
// TaxesModule: the marketplace provider-cost floor compares net revenue.
@Module({
  imports: [MarketsModule, TaxesModule],
  controllers: [PromotionsController],
  providers: [PromotionsService],
  exports: [PromotionsService],
})
export class PromotionsModule {}
