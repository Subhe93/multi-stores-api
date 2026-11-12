import { Module } from '@nestjs/common';
import { PromotionsController } from './promotions.controller';
import { PromotionsService } from './promotions.service';
import { MarketsModule } from '../markets/markets.module';

// MarketsModule: the public coupon preview converts market-currency carts.
@Module({
  imports: [MarketsModule],
  controllers: [PromotionsController],
  providers: [PromotionsService],
  exports: [PromotionsService],
})
export class PromotionsModule {}
