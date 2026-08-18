import { Module } from '@nestjs/common';
import { StoresController } from './stores.controller';
import { StoresService } from './stores.service';
import { OrdersModule } from '../orders/orders.module';

@Module({
  // OrdersModule: an admin store-type switch re-derives the commission split of
  // the store's unpaid orders, and that math lives in OrdersService.
  imports: [OrdersModule],
  controllers: [StoresController],
  providers: [StoresService],
  exports: [StoresService],
})
export class StoresModule {}
