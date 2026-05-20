import { Module } from '@nestjs/common';
import { CustomProductsController } from './custom-products.controller';
import { CustomProductsService } from './custom-products.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { BundlesModule } from '../bundles/bundles.module';

@Module({
  imports: [NotificationsModule, BundlesModule],
  controllers: [CustomProductsController],
  providers: [CustomProductsService],
  exports: [CustomProductsService],
})
export class CustomProductsModule {}
