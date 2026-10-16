import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module';
import { CustomerUploadsController } from './customer-uploads.controller';
import { CustomerUploadsService } from './customer-uploads.service';

/**
 * Cycle-free core module (M4.5 C28): OrdersModule imports it for
 * `CustomerUploadsService`. Private storage (`PRIVATE_STORAGE`) and the
 * retention registry come from global modules; the service registers the
 * `customer-uploads` retention task on init.
 */
@Module({
  imports: [UploadsModule],
  controllers: [CustomerUploadsController],
  providers: [CustomerUploadsService],
  exports: [CustomerUploadsService],
})
export class CustomerUploadsModule {}
