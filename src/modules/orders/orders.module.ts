import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersQuoteController } from './orders-quote.controller';
import { OrdersService } from './orders.service';
import { PromotionsModule } from '../promotions/promotions.module';
import { ShippingModule } from '../shipping/shipping.module';
import { TaxesModule } from '../taxes/taxes.module';
import { MarketsModule } from '../markets/markets.module';
import { B2bModule } from '../b2b/b2b.module';
import { InvoicesModule } from '../invoices/invoices.module';

@Module({
  imports: [
    PromotionsModule,
    ShippingModule,
    TaxesModule,
    MarketsModule,
    B2bModule,
    // Imports only globals, so no cycle (M3 D5).
    InvoicesModule,
  ],
  controllers: [OrdersController, OrdersQuoteController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
