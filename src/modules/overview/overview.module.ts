import { Module } from '@nestjs/common';
import { OverviewController } from './overview.controller';
import { OverviewService } from './overview.service';

// StoreAppsService (markets check) comes from the global StoreAppsModule.
@Module({
  controllers: [OverviewController],
  providers: [OverviewService],
})
export class OverviewModule {}
