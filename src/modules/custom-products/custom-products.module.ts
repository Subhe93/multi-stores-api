import { Module } from '@nestjs/common';
import { CustomProductsController } from './custom-products.controller';
import { CustomProductsService } from './custom-products.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [CustomProductsController],
  providers: [CustomProductsService],
  exports: [CustomProductsService],
})
export class CustomProductsModule {}
