import { Global, Module } from '@nestjs/common';
import { StoreAppsController } from './store-apps.controller';
import { StoreAppsService } from './store-apps.service';
import { RequireAppGuard } from '../../common/guards/require-app.guard';

// Global so any feature module can inject StoreAppsService (isEnabled sits
// on storefront and checkout paths) and use @RequireApp without wiring
// imports — mirrors RevalidationModule.
@Global()
@Module({
  controllers: [StoreAppsController],
  providers: [StoreAppsService, RequireAppGuard],
  exports: [StoreAppsService],
})
export class StoreAppsModule {}
