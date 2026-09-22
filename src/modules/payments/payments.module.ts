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

// PrismaModule, CryptoModule and MailModule are @Global, so PrismaService,
// CryptoService and MailService are injectable here without importing them.
// Shipping and coupons are reached through OrdersService (quoteLines), which
// keeps the session total on exactly the code path that prices the order.
// TaxesModule (no imports of its own, so no cycle) provides TaxService for the
// order-first tax backfill in KustomService.createSession.
@Module({
  imports: [ConfigModule, OrdersModule, NotificationsModule, TaxesModule],
  controllers: [PaymentsController, KustomController, KustomCheckoutController],
  providers: [PaymentsService, KustomService, KustomCheckoutService],
  exports: [PaymentsService, KustomService, KustomCheckoutService],
})
export class PaymentsModule {}
