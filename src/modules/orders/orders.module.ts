import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersQuoteController } from './orders-quote.controller';
import { OrdersGuestController } from './orders-guest.controller';
import { GuestOrderService } from './guest-order.service';
import { AuthModule } from '../auth/auth.module';
import { GuestOrderTokenModule } from '../auth/guest-order-token.module';
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
import { StorefrontGateModule } from '../storefront/storefront-gate.service';
import { MetaCapiModule } from '../meta-capi/meta-capi.module';
import { ReviewsModule } from '../reviews/reviews.module';

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
    // FIXES-1 item 4: X-Storefront-Viewer on quote / order creation
    // (imports JwtModule + EditHintTokenModule only, no cycle).
    StorefrontGateModule,
    // Server-side Meta Purchase event (imports only globals, no cycle).
    MetaCapiModule,
    // Guest checkout (POST /orders/guest): the customer record comes from
    // AuthService (AuthModule imports MagicLinkModule only, no cycle) and
    // the order-bound token from GuestOrderTokenModule.
    AuthModule,
    GuestOrderTokenModule,
    // M171: reviews of a trashed / test-flagged order are hidden (imports
    // only globals + JwtModule, no cycle).
    ReviewsModule,
  ],
  // The guest controller first: its fixed `guest` segment must never be
  // read as an order id by a route of OrdersController.
  controllers: [OrdersGuestController, OrdersController, OrdersQuoteController],
  providers: [OrdersService, GuestOrderService],
  exports: [OrdersService],
})
export class OrdersModule {}
