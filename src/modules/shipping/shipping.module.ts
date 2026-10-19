import { Module } from '@nestjs/common';
import { ShippingController } from './shipping.controller';
import { ShippingService } from './shipping.service';
import { MarketsModule } from '../markets/markets.module';

@Module({
  // MarketsModule: POST /shipping/estimate in the storefront's market.
  imports: [MarketsModule],
  controllers: [ShippingController],
  providers: [ShippingService],
  exports: [ShippingService],
})
export class ShippingModule {}
