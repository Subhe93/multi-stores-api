import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { KustomService } from './kustom/kustom.service';
import { KustomController } from './kustom/kustom.controller';
import { KustomCheckoutService } from './kustom/kustom-checkout.service';
import { KustomCheckoutController } from './kustom/kustom-checkout.controller';
import { OrdersModule } from '../orders/orders.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TaxesModule } from '../taxes/taxes.module';
import { MarketsModule } from '../markets/markets.module';
import { B2bModule } from '../b2b/b2b.module';
import { InvoicesModule } from '../invoices/invoices.module';

// PrismaModule, CryptoModule and MailModule are @Global, so PrismaService,
// CryptoService and MailService are injectable here without importing them.
// Shipping and coupons are reached through OrdersService (quoteLines), which
// keeps the session total on exactly the code path that prices the order.
// TaxesModule (no imports of its own, so no cycle) provides TaxService for the
// order-first tax backfill in KustomService.createSession. MarketsModule
// (no imports of its own either) provides MarketsContextService so the
// public config and both Kustom flows can resolve a market. B2bModule
// (imports nothing) provides B2bService for the buyer type / company
// wiring of both Kustom flows. InvoicesModule (imports only globals)
// provides InvoiceTriggersService for the paid / refund call sites.
@Module({
  imports: [
    ConfigModule,
    OrdersModule,
    NotificationsModule,
    TaxesModule,
    MarketsModule,
    B2bModule,
    InvoicesModule,
  ],
  controllers: [PaymentsController, KustomController, KustomCheckoutController],
  providers: [PaymentsService, KustomService, KustomCheckoutService],
  exports: [PaymentsService, KustomService, KustomCheckoutService],
})
export class PaymentsModule {}
