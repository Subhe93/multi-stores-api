import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { ProductionCoreModule } from './production-core.module';
import { ProductionController } from './production.controller';
import { ProductionAutomationService } from './production-automation.service';

// Production app (M4.3) routes and status automation. Imports OrdersModule
// (for OrdersService.updateStatus / findById); OrdersModule only imports the
// core module, so there is no cycle.
@Module({
  imports: [ProductionCoreModule, OrdersModule],
  controllers: [ProductionController],
  providers: [ProductionAutomationService],
})
export class ProductionModule {}
