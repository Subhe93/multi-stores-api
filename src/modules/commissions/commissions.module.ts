import { Module } from '@nestjs/common';
import { CommissionsController } from './commissions.controller';
import { CommissionsService } from './commissions.service';
import { ProviderEarningsService } from './provider-earnings.service';

@Module({
  controllers: [CommissionsController],
  providers: [CommissionsService, ProviderEarningsService],
  exports: [CommissionsService],
})
export class CommissionsModule {}
