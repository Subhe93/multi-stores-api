import { Module } from '@nestjs/common';
import { ProductionChecklistService } from './production-checklist.service';
import { DesignProductionProvider } from './production-design.provider';
import { ProductionNotificationsService } from './production-notifications.service';
import { ProductionTriggersService } from './production-triggers.service';

// Production app (M4.3), cycle-free core (invoices D5 pattern): imports
// nothing (Prisma, StoreApps, Mail and Retention are global), so
// OrdersModule and DesignerRenderModule can import it for the optional
// ProductionTriggersService. The controller and the status automation
// (which needs OrdersService) live in ProductionModule; the automation
// registers its print-ready step in the triggers service on init (M5.4).
@Module({
  providers: [
    ProductionChecklistService,
    ProductionNotificationsService,
    ProductionTriggersService,
    DesignProductionProvider,
  ],
  exports: [
    ProductionChecklistService,
    ProductionNotificationsService,
    ProductionTriggersService,
    DesignProductionProvider,
  ],
})
export class ProductionCoreModule {}
