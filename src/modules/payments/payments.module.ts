import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { KustomService } from './kustom/kustom.service';
import { KustomController } from './kustom/kustom.controller';
import { OrdersModule } from '../orders/orders.module';
import { NotificationsModule } from '../notifications/notifications.module';

// PrismaModule, CryptoModule and MailModule are @Global, so PrismaService,
// CryptoService and MailService are injectable here without importing them.
@Module({
  imports: [ConfigModule, OrdersModule, NotificationsModule],
  controllers: [PaymentsController, KustomController],
  providers: [PaymentsService, KustomService],
  exports: [PaymentsService, KustomService],
})
export class PaymentsModule {}
