import { Module } from '@nestjs/common';
import { ProductionChecklistService } from './production-checklist.service';
import { ProductionTriggersService } from './production-triggers.service';

// Production app (M4.3), cycle-free core (invoices D5 pattern): imports
// nothing (Prisma and StoreApps are global), so OrdersModule can import it
// for the optional ProductionTriggersService. The controller and the status
// automation (which needs OrdersService) live in ProductionModule.
@Module({
  providers: [ProductionChecklistService, ProductionTriggersService],
  exports: [ProductionChecklistService, ProductionTriggersService],
})
export class ProductionCoreModule {}
