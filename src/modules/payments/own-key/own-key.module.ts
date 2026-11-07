import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NotificationsModule } from '../../notifications/notifications.module';
import { AdminOwnKeyController, OwnKeyController } from './own-key.controller';
import { OwnKeyService } from './own-key.service';
import { OWN_KEY_API } from './own-key.types';

// Global so the payment flow, storefront, store lifecycle and markets
// payment-check can inject OWN_KEY_API (or OwnKeyService) without import
// wiring or module cycles. Prisma, Crypto, Revalidation, StoreApps and
// Security are global already; only Notifications needs importing.
@Global()
@Module({
  imports: [ConfigModule, NotificationsModule],
  controllers: [OwnKeyController, AdminOwnKeyController],
  providers: [
    OwnKeyService,
    { provide: OWN_KEY_API, useExisting: OwnKeyService },
  ],
  exports: [OwnKeyService, OWN_KEY_API],
})
export class OwnKeyModule {}
