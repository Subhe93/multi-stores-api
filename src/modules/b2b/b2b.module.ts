import { Module } from '@nestjs/common';
import { B2bService } from './b2b.service';

// Imports nothing: StoreAppsModule is @Global, so StoreAppsService injects
// here directly. Feature modules (orders, cart, storefront, payments) import
// this module for B2bService; it has no controller of its own - the app's
// settings go through PUT /stores/my/apps/b2b.
@Module({
  providers: [B2bService],
  exports: [B2bService],
})
export class B2bModule {}
