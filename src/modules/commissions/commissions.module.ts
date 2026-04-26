import { Module } from '@nestjs/common';
import { CommissionsController } from './commissions.controller';
import { CommissionsService } from './commissions.service';

@Module({
  controllers: [CommissionsController],
  providers: [CommissionsService],
  exports: [CommissionsService],
})
export class CommissionsModule {}
