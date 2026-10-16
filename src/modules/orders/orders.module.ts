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
import { PersonalizationCoreModule } from '../../common/personalization/personalization-core.module';
import { CustomerUploadsModule } from '../customer-uploads/customer-uploads.module';
import { PersonalizationModule } from '../personalization/personalization.module';
import { ProductionCoreModule } from '../production/production-core.module';
import { DesignerCoreModule } from '../designer/designer-core.module';

@Module({
  imports: [
    PromotionsModule,
    ShippingModule,
    TaxesModule,
    MarketsModule,
    B2bModule,
    // Imports only globals, so no cycle (M3 D5).
    InvoicesModule,
    // M4.0 cycle-free core modules (C28).
    PersonalizationCoreModule,
    CustomerUploadsModule,
    // M4.1 / M4.3 (C28): PersonalizationService and the cycle-free
    // ProductionTriggersService are injected optionally into OrdersService.
    PersonalizationModule,
    ProductionCoreModule,
    // M4.2 (C28): cycle-free designer core (cart line service, snapshot,
    // triggers port).
    DesignerCoreModule,
  ],
  controllers: [OrdersController, OrdersQuoteController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
