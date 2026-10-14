import { Module } from '@nestjs/common';
import { StoresController } from './stores.controller';
import { StoresService } from './stores.service';
import { OrdersModule } from '../orders/orders.module';
import { MarketsModule } from '../markets/markets.module';

@Module({
  // OrdersModule: an admin store-type switch re-derives the commission split of
  // the store's unpaid orders, and that math lives in OrdersService.
  // MarketsModule: the default market is created with the store, mirrored by
  // updateLanguages, and consulted by the by-domain proxy lookup.
  imports: [OrdersModule, MarketsModule],
  controllers: [StoresController],
  providers: [StoresService],
  exports: [StoresService],
})
export class StoresModule {}
