import { Module } from '@nestjs/common';
import { CustomerUploadsModule } from '../../modules/customer-uploads/customer-uploads.module';
import { PersonalizationCoreService } from './personalization-core.service';

/**
 * Cycle-free core module (M4.5 C13/C28): CartModule and OrdersModule import
 * it. It depends only on Prisma (global) and CustomerUploadsModule.
 */
@Module({
  imports: [CustomerUploadsModule],
  providers: [PersonalizationCoreService],
  exports: [PersonalizationCoreService],
})
export class PersonalizationCoreModule {}
