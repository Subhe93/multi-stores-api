import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PromotionsModule } from '../promotions/promotions.module';
import { ShippingModule } from '../shipping/shipping.module';

@Module({
  imports: [PromotionsModule, ShippingModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
