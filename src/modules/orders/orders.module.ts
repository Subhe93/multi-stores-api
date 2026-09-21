import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersQuoteController } from './orders-quote.controller';
import { OrdersService } from './orders.service';
import { PromotionsModule } from '../promotions/promotions.module';
import { ShippingModule } from '../shipping/shipping.module';
import { TaxesModule } from '../taxes/taxes.module';

@Module({
  imports: [PromotionsModule, ShippingModule, TaxesModule],
  controllers: [OrdersController, OrdersQuoteController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
